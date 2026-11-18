using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace ABridge;

internal sealed class MainWindow : Window, IDisposable
{
    private readonly HostBridge host;
    private readonly ActivityFrames frames = new();
    private readonly DispatcherTimer watchdog;
    private readonly Forms.NotifyIcon tray;
    private readonly Forms.ToolStripMenuItem trayPause;
    private readonly string preferences;
    private readonly TextBlock connection = new() { FontSize = 22, FontWeight = FontWeights.SemiBold };
    private readonly TextBlock identity = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 16) };
    private readonly TextBlock error = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.IndianRed, Margin = new Thickness(0, 12, 0, 0) };
    private readonly TextBlock diagnostics = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
    private readonly TextBox deviceName = new() { MaxLength = 120 };
    private readonly TextBox server = new() { MaxLength = 8192 };
    private readonly PasswordBox token = new() { MaxLength = 4096 };
    private readonly Button pause = new() { Content = "暂停" };
    private readonly Button bind = new() { Content = "连接并授权" };
    private readonly Button unbind = new() { Content = "解绑设备" };
    private readonly Button cancel = new() { Content = "取消授权", Visibility = Visibility.Collapsed };
    private readonly ComboBox theme = new() { ItemsSource = new[] { "跟随系统", "浅色", "深色" }, SelectedIndex = 0, MinWidth = 130 };
    private readonly Expander connectionSection;
    private readonly Dictionary<string, CheckBox> capabilities = new();
    private readonly HashSet<string> capabilityPending = new();
    private JsonElement status;
    private string statusError = "", transportError = "";
    private long lastHeartbeat;
    private bool bound, paused, rendering, binding, quitting, disposed, healthy, active;
    private bool hasStatus;
    private IntPtr handle;
    private HwndSource? source;

    public MainWindow(string stateDir)
    {
        Title = "aBridge"; Width = 540; Height = 640; MinWidth = 440; MinHeight = 440;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        FontFamily = new FontFamily("Microsoft YaHei UI"); FontSize = 14;
        preferences = Path.Combine(stateDir, "windows-ui", "native-preferences.json");
        SetupStyles();
        var content = new StackPanel { Margin = new Thickness(26) };
        content.Children.Add(new TextBlock { Text = "aBridge", FontSize = 30, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(Color.FromRgb(0, 102, 221)), Margin = new Thickness(0, 0, 0, 24) });
        content.Children.Add(connection); content.Children.Add(identity);
        connection.Text = "正在启动…";
        var nameRow = new Grid(); nameRow.ColumnDefinitions.Add(new ColumnDefinition()); nameRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        deviceName.SetValue(AutomationProperties.NameProperty, "设备名称");
        nameRow.Children.Add(deviceName);
        var saveName = Button("保存名称", async () => await Send("rename", new { name = deviceName.Text.Trim() }));
        Grid.SetColumn(saveName, 1); nameRow.Children.Add(saveName); content.Children.Add(nameRow);
        var controls = new WrapPanel { Margin = new Thickness(0, 12, 0, 22) };
        pause.Click += async (_, _) => await TogglePause(); controls.Children.Add(pause);
        controls.Children.Add(Button("停止当前任务", Stop));
        controls.Children.Add(Button("重新连接", async () => await Send("connect")));
        content.Children.Add(controls);

        var bindingPanel = new StackPanel();
        bindingPanel.Children.Add(Label("服务端网址"));
        server.SetValue(AutomationProperties.NameProperty, "服务端网址"); bindingPanel.Children.Add(server);
        var tokenPanel = new StackPanel(); tokenPanel.Children.Add(Label("Device Token")); tokenPanel.Children.Add(token);
        token.SetValue(AutomationProperties.NameProperty, "Device Token");
        bindingPanel.Children.Add(new Expander { Header = "使用 Device Token", Content = tokenPanel, Margin = new Thickness(0, 10, 0, 6) });
        var bindActions = new WrapPanel(); bind.Click += async (_, _) => await Bind(); bindActions.Children.Add(bind);
        cancel.Click += async (_, _) => await Send("cancel"); bindActions.Children.Add(cancel);
        unbind.Click += async (_, _) =>
        {
            if (MessageBox.Show(this, "解绑将停止本机任务，并清除本机设备凭据。是否继续？", "解绑设备", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            frames.Show(false); await Send("unbind");
        };
        bindActions.Children.Add(unbind); bindingPanel.Children.Add(bindActions);
        connectionSection = Section("连接", bindingPanel, true);
        content.Children.Add(connectionSection);
        var capabilityPanel = new WrapPanel();
        foreach (var (key, label) in new[] { ("screen", "屏幕观察"), ("input", "键鼠控制"), ("shell", "终端"), ("files", "文件") })
        {
            var check = new CheckBox { Content = label, IsChecked = true, Margin = new Thickness(0, 8, 20, 8) };
            capabilities[key] = check; capabilityPanel.Children.Add(check);
            check.Checked += async (_, _) => await Capability(key, true);
            check.Unchecked += async (_, _) => await Capability(key, false);
        }
        content.Children.Add(Section("本机能力", capabilityPanel, true));
        var settings = new StackPanel(); settings.Children.Add(Label("外观")); settings.Children.Add(theme);
        settings.Children.Add(new TextBlock { Text = "暂停快捷键  Ctrl + Alt + Shift + P", Margin = new Thickness(0, 12, 0, 0), FontSize = 12 });
        content.Children.Add(Section("偏好设置", settings));
        content.Children.Add(Section("运行诊断", diagnostics)); content.Children.Add(error);
        Content = new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        try
        {
            if (File.Exists(preferences)) { using var doc = JsonDocument.Parse(File.ReadAllText(preferences)); if (doc.RootElement.TryGetProperty("theme", out var saved) && saved.TryGetInt32(out var index)) theme.SelectedIndex = Math.Clamp(index, 0, 2); }
            var iconPath = Path.Combine(AppContext.BaseDirectory, "icon.png");
            if (File.Exists(iconPath)) { var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.UriSource = new Uri(iconPath); bitmap.EndInit(); Icon = bitmap; }
        }
        catch (Exception) { }
        ApplyTheme(); theme.SelectionChanged += (_, _) => { ApplyTheme(); SaveTheme(); };
        SystemEvents.UserPreferenceChanged += PreferencesChanged;
        SystemEvents.DisplaySettingsChanged += DisplaysChanged;
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("打开 aBridge", null, (_, _) => Dispatcher.Invoke(Reveal));
        trayPause = new Forms.ToolStripMenuItem("暂停", null, async (_, _) => await TogglePause()); menu.Items.Add(trayPause);
        menu.Items.Add("停止当前任务", null, async (_, _) => await Stop());
        menu.Items.Add(new Forms.ToolStripSeparator()); menu.Items.Add("退出", null, async (_, _) => await Quit());
        tray = new Forms.NotifyIcon { Text = "aBridge · 正在启动", Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? System.Drawing.SystemIcons.Application, ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => Reveal();
        host = new HostBridge(stateDir);
        host.Event += message => Dispatcher.BeginInvoke(new Action(() => HandleEvent(message)));
        host.Disconnected += () => Dispatcher.BeginInvoke(new Action(() => { if (!disposed) LoseConnection("本机内核已退出，请退出后重新打开 aBridge。"); }));
        watchdog = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
        watchdog.Tick += (_, _) => { if (healthy && Stopwatch.GetElapsedTime(lastHeartbeat).TotalSeconds > 2) LoseConnection("本机状态暂时不可用。"); };
        watchdog.Start();
        Loaded += async (_, _) => await Send("status");
        SourceInitialized += (_, _) =>
        {
            handle = new WindowInteropHelper(this).Handle; source = HwndSource.FromHwnd(handle); source?.AddHook(WindowMessage);
            if (!RegisterHotKey(handle, 1, 0x4007, 0x50)) error.Text = "暂停快捷键已被其他程序占用。";
        };
        Closing += (_, e) => { if (!disposed) { e.Cancel = true; Hide(); } };
    }

    private static TextBlock Label(string text) => new() { Text = text, Margin = new Thickness(0, 6, 0, 6), FontSize = 12 };
    private static Expander Section(string title, UIElement child, bool expanded = false) => new() { Header = title, Content = child, IsExpanded = expanded, Margin = new Thickness(0, 0, 0, 18), Padding = new Thickness(0, 8, 0, 0) };
    private Button Button(string title, Func<Task> action)
    {
        var button = new Button { Content = title }; button.Click += async (_, _) => { button.IsEnabled = false; try { await action(); } finally { if (!disposed) button.IsEnabled = true; } }; return button;
    }
    private void SetupStyles()
    {
        foreach (var type in new[] { typeof(Expander), typeof(CheckBox) })
        {
            var style = new Style(type);
            style.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension("TextBrush")));
            Resources[type] = style;
        }
        foreach (var type in new[] { typeof(Button), typeof(TextBox), typeof(PasswordBox), typeof(ComboBox), typeof(ComboBoxItem) })
        {
            var style = new Style(type);
            style.Setters.Add(new Setter(Control.PaddingProperty, new Thickness(10, 6, 10, 6)));
            style.Setters.Add(new Setter(Control.MarginProperty, new Thickness(0, 0, 8, 0)));
            style.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension("TextBrush")));
            style.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension("InputBrush")));
            style.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension("BorderBrush")));
            Resources[type] = style;
        }
    }
    private void ApplyTheme()
    {
        var dark = theme.SelectedIndex == 2;
        if (theme.SelectedIndex == 0)
        {
            try { using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"); dark = key?.GetValue("AppsUseLightTheme") is int value && value == 0; } catch (Exception) { }
        }
        Background = new SolidColorBrush(dark ? Color.FromRgb(24, 28, 35) : Color.FromRgb(248, 250, 253));
        Foreground = new SolidColorBrush(dark ? Color.FromRgb(232, 237, 245) : Color.FromRgb(30, 40, 55));
        Resources["TextBrush"] = Foreground;
        Resources["InputBrush"] = new SolidColorBrush(dark ? Color.FromRgb(42, 48, 60) : Colors.White);
        Resources["BorderBrush"] = new SolidColorBrush(dark ? Color.FromRgb(78, 88, 104) : Color.FromRgb(206, 216, 229));
    }
    private void PreferencesChanged(object? sender, UserPreferenceChangedEventArgs e) => Dispatcher.BeginInvoke(new Action(ApplyTheme));
    private void DisplaysChanged(object? sender, EventArgs e) => Dispatcher.BeginInvoke(new Action(() => { if (active && healthy) frames.Show(true); }));
    private void SaveTheme()
    {
        try { Directory.CreateDirectory(Path.GetDirectoryName(preferences)!); File.WriteAllText(preferences + ".tmp", JsonSerializer.Serialize(new { theme = theme.SelectedIndex })); File.Move(preferences + ".tmp", preferences, true); } catch (Exception) { error.Text = "外观设置未能保存。"; }
    }
    public void Reveal() { if (disposed) return; Show(); if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Activate(); }
    private async Task Send(string action, object? args = null)
    {
        try
        {
            error.Text = "";
            var result = await host.Request(action, args);
            if (result.TryGetProperty("status", out var fresh)) ApplyStatus(fresh);
            else if (result.TryGetProperty("view", out _)) ApplyStatus(result);
            else if (action != "status") ApplyStatus(await host.Request("status"));
        }
        catch (Exception ex) { if (!disposed) error.Text = ex is TimeoutException ? "操作确认超时，请检查当前状态后再试。" : ex.Message; }
    }
    private async Task TogglePause() { if (!paused) frames.Show(false); await Send(paused ? "resume" : "pause"); }
    private async Task Stop() { frames.Show(false); await Send("stop"); }
    private async Task Capability(string capability, bool enabled)
    {
        if (rendering || !bound || binding || !capabilityPending.Add(capability)) return;
        if (!enabled && capability == "input") frames.Show(false);
        RefreshBinding();
        try { await Send("capability", new { capability, enabled }); var failure = error.Text; await Send("status"); if (failure.Length > 0) error.Text = failure; }
        finally { capabilityPending.Remove(capability); RefreshBinding(); }
    }
    private async Task Bind()
    {
        if (binding || bound) return;
        if (!Uri.TryCreate(server.Text.Trim(), UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https") || !string.IsNullOrEmpty(uri.UserInfo)) { error.Text = "请输入有效的 http 或 https 服务端网址。"; return; }
        string? confirmed = null;
        if (uri.Scheme == "http")
        {
            var origin = uri.GetLeftPart(UriPartial.Authority);
            if (MessageBox.Show(this, $"此连接未使用 HTTPS 加密：\n{origin}\n\n仅在你信任的网络中继续。是否允许连接？", "确认 HTTP 连接", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
            confirmed = origin;
        }
        binding = true; RefreshBinding();
        var args = new Dictionary<string, object> { ["url"] = uri.AbsoluteUri, ["capabilities"] = capabilities.ToDictionary(pair => pair.Key, pair => pair.Value.IsChecked == true) };
        if (!string.IsNullOrWhiteSpace(token.Password)) args["device_key"] = token.Password.Trim();
        if (confirmed is not null) args["http_confirmed_origin"] = confirmed;
        try { await Send("bind", args); }
        finally { token.Clear(); binding = false; RefreshBinding(); }
    }
    private void RefreshBinding()
    {
        server.IsEnabled = !bound && !binding; token.IsEnabled = !bound && !binding;
        bind.IsEnabled = !bound && !binding; unbind.IsEnabled = bound && !binding;
        cancel.Visibility = binding ? Visibility.Visible : Visibility.Collapsed;
        foreach (var item in capabilities) item.Value.IsEnabled = !binding && !capabilityPending.Contains(item.Key);
    }
    private void HandleEvent(JsonElement message)
    {
        if (disposed) return;
        switch (HostBridge.Text(message, "event"))
        {
            case "status": if (message.TryGetProperty("status", out var fresh)) ApplyStatus(fresh); break;
            case "activity":
                var recovered = !healthy;
                lastHeartbeat = Stopwatch.GetTimestamp(); healthy = true;
                if (recovered && error.Text == transportError) error.Text = "";
                transportError = "";
                var nextActive = HostBridge.Flag(message, "active") && !paused && HostBridge.Text(status, "connection") == "online";
                if (nextActive != active) { active = nextActive; frames.Show(active); }
                if (recovered) RenderConnection(); break;
            case "authorization":
                var url = HostBridge.Text(message, "url");
                if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == "https" || uri.Scheme == "http"))
                { try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch (Exception) { error.Text = "无法打开默认浏览器，请检查系统浏览器设置。"; } }
                break;
        }
    }
    private void ApplyStatus(JsonElement fresh)
    {
        status = fresh.Clone();
        var nextBound = HostBridge.Flag(status, "bound");
        if (!hasStatus || bound != nextBound) connectionSection.IsExpanded = !nextBound;
        hasStatus = true; bound = nextBound; paused = HostBridge.Flag(status, "paused");
        rendering = true;
        try
        {
            if (!deviceName.IsKeyboardFocusWithin) deviceName.Text = HostBridge.Text(status, "device_name");
            if (bound && !server.IsKeyboardFocusWithin) server.Text = HostBridge.Text(status, "url");
            identity.Text = bound ? string.Join(" · ", new[] { HostBridge.Text(status, "owner_name"), HostBridge.Text(status, "device_id") }.Where(value => value.Length > 0)) : "连接服务端，授权此电脑";
            pause.Content = paused ? "恢复" : "暂停"; trayPause.Text = paused ? "恢复" : "暂停";
            if (bound && (status.TryGetProperty("requested_capabilities", out var caps) || status.TryGetProperty("capabilities", out caps)) && caps.ValueKind == JsonValueKind.Object)
            {
                foreach (var item in capabilities) item.Value.IsChecked = HostBridge.Flag(caps, item.Key);
            }
            var node = status.TryGetProperty("runtime", out var runtime) ? HostBridge.Text(runtime, "node", "未启动") : "未启动";
            var driver = status.TryGetProperty("driver", out var driverInfo) && HostBridge.Flag(driverInfo, "ready") ? "已就绪" : "按需启动";
            diagnostics.Text = $"版本  {HostBridge.Text(status, "version")}\nNode  {node}\n桌面驱动  {driver}\n连接  {HostBridge.Text(status, "connection")}\n设备  {HostBridge.Text(status, "device_id")}\n{HostBridge.Text(status, "local_error", HostBridge.Text(status, "error"))}".Trim();
            var currentError = HostBridge.Text(status, "local_error", HostBridge.Text(status, "error"));
            if (currentError.Length > 0 || error.Text == statusError) error.Text = currentError;
            statusError = currentError;
            if (paused || HostBridge.Text(status, "connection") != "online") { active = false; frames.Show(false); }
            RefreshBinding(); RenderConnection();
        }
        finally { rendering = false; }
    }
    private void RenderConnection()
    {
        var state = HostBridge.Text(status, "connection");
        connection.Text = !healthy ? "状态暂不可用" : status.ValueKind == JsonValueKind.Object && status.TryGetProperty("view", out var view) ? HostBridge.Text(view, "label", "未连接") : "正在启动…";
        connection.Foreground = healthy && !paused && state == "online" ? new SolidColorBrush(Color.FromRgb(0, 102, 221)) : Foreground;
        tray.Text = "aBridge · " + connection.Text;
    }
    private void LoseConnection(string reason) { healthy = false; active = false; frames.Show(false); RenderConnection(); transportError = reason; error.Text = reason; }
    private IntPtr WindowMessage(IntPtr hwnd, int message, IntPtr wparam, IntPtr lparam, ref bool handled)
    {
        if (message == 0x0312 && wparam.ToInt32() == 1) { frames.Show(false); _ = Send("pause"); handled = true; } return IntPtr.Zero;
    }
    private async Task Quit()
    {
        if (quitting) return; quitting = true; frames.Show(false);
        try { if (host.IsRunning) await host.Request("quit"); }
        catch (Exception)
        {
            if (host.IsRunning) { quitting = false; error.Text = "退出尚未完成，客户端仍在运行。请等待当前操作清理后重试。"; Reveal(); return; }
        }
        Dispose(); Application.Current.Shutdown();
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; watchdog.Stop(); frames.Dispose();
        SystemEvents.UserPreferenceChanged -= PreferencesChanged; UnregisterHotKey(handle, 1); source?.RemoveHook(WindowMessage);
        SystemEvents.DisplaySettingsChanged -= DisplaysChanged;
        tray.Visible = false; tray.ContextMenuStrip?.Dispose(); tray.Dispose(); host.Dispose();
    }
    [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
}

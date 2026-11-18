using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Windows;

namespace ABridge;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "aBridge");
        try
        {
            var deployment = Path.Combine(AppContext.BaseDirectory, "deployment.json");
            if (File.Exists(deployment))
            {
                using var config = JsonDocument.Parse(File.ReadAllText(deployment));
                state = HostBridge.Text(config.RootElement, "state_dir", state);
            }
            for (var i = 0; i < args.Length; i++) if (args[i] == "--state-dir" && i + 1 < args.Length) state = args[++i];
            state = Path.TrimEndingDirectorySeparator(Path.GetFullPath(state));
            var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(state.ToLowerInvariant())));
            using var mutex = new Mutex(true, "Local\\aBridge.Native." + identity, out var first);
            using var activation = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\aBridge.Show." + identity);
            if (!first) { activation.Set(); return; }
            var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var window = new MainWindow(state);
            var registration = ThreadPool.RegisterWaitForSingleObject(activation, (_, _) => application.Dispatcher.BeginInvoke(new Action(window.Reveal)), null, Timeout.Infinite, false);
            application.Exit += (_, _) => { registration.Unregister(null); window.Dispose(); };
            application.Run(window);
        }
        catch (Exception)
        {
            MessageBox.Show("aBridge 无法启动，请检查安装是否完整以及本机状态目录权限。", "aBridge", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
}

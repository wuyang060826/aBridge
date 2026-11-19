use crate::{
    flag,
    frames::Frames,
    host::{Host, Message, Pending},
    text, wide,
};
use naui_winui3::Microsoft::UI::Xaml::{
    self as xaml, Controls::*, ElementTheme, FrameworkElement, Markup::XamlReader,
    RoutedEventHandler, UIElement, Visibility, Window,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows::Foundation::{IPropertyValue, IReference, PropertyValue};
use windows_core::{Interface, HSTRING};
use windows_sys::Win32::{
    Foundation::*,
    System::{LibraryLoader::*, Threading::*},
    UI::{Controls::*, HiDpi::*, Input::KeyboardAndMouse::*, Shell::*, WindowsAndMessaging::*},
};
const HOST_TIMER: usize = 0xAB42;
const CAPS: [&str; 4] = ["screen", "input", "shell", "files"];
struct App {
    exiting: bool,
    hwnd: HWND,
    window: Window,
    root: FrameworkElement,
    controls: HashMap<u16, FrameworkElement>,
    host: Host,
    frames: Frames,
    activation: HANDLE,
    preferences: PathBuf,
    status: Value,
    healthy: bool,
    active: bool,
    bound: bool,
    paused: bool,
    binding: bool,
    quitting: bool,
    has_status: bool,
    heartbeat: Instant,
    theme: i32,
    status_appearance: Option<(bool, ElementTheme)>,
    status_error: String,
    transport_error: String,
    tray: NOTIFYICONDATAW,
    taskbar_created: u32,
    tray_callback: u32,
}
// Status arrives periodically. Do not replace XAML content or invalidate layout
// when its displayed value is unchanged (notably Button.Content recreates content).
fn label(c: FrameworkElement, s: &str) {
    let value = HSTRING::from(s);
    if let Ok(c) = c.cast::<TextBlock>() {
        if c.Text().ok().as_ref() != Some(&value) {
            let _ = c.SetText(&value);
        }
    } else if let Ok(c) = c.cast::<TextBox>() {
        if c.Text().ok().as_ref() != Some(&value) {
            let _ = c.SetText(&value);
        }
    } else if let Ok(c) = c.cast::<PasswordBox>() {
        if c.Password().ok().as_ref() != Some(&value) {
            let _ = c.SetPassword(&value);
        }
    } else if let Ok(c) = c.cast::<Button>() {
        let current = c
            .Content()
            .and_then(|v| v.cast::<IPropertyValue>())
            .and_then(|v| v.GetString());
        if current.ok().as_ref() != Some(&value) {
            if let Ok(v) = PropertyValue::CreateString(&value) {
                let _ = c.SetContent(&v);
            }
        }
    }
}
fn visible(c: FrameworkElement, value: Visibility) {
    if c.Visibility().ok() != Some(value) {
        let _ = c.SetVisibility(value);
    }
}
fn read(c: FrameworkElement) -> String {
    if let Ok(c) = c.cast::<TextBlock>() {
        c.Text().unwrap_or_default().to_string()
    } else if let Ok(c) = c.cast::<TextBox>() {
        c.Text().unwrap_or_default().to_string()
    } else if let Ok(c) = c.cast::<PasswordBox>() {
        c.Password().unwrap_or_default().to_string()
    } else {
        String::new()
    }
}
fn enabled(c: FrameworkElement, enabled: i32) {
    if let Ok(c) = c.cast::<Control>() {
        if c.IsEnabled().ok() != Some(enabled != 0) {
            let _ = c.SetIsEnabled(enabled != 0);
        }
    }
}
fn focused(c: FrameworkElement) -> bool {
    c.cast::<Control>()
        .and_then(|c| c.FocusState())
        .is_ok_and(|s| s != xaml::FocusState::Unfocused)
}
fn send_control(c: FrameworkElement, msg: u32, w: usize, _l: isize) -> isize {
    match msg {
        BM_GETCHECK => c
            .cast::<CheckBox>()
            .and_then(|c| c.IsChecked())
            .and_then(|v| v.Value())
            .unwrap_or(false) as isize,
        BM_SETCHECK => {
            if let Ok(c) = c.cast::<CheckBox>() {
                if c.IsChecked().and_then(|v| v.Value()).ok() == Some(w != 0) {
                    return 0;
                }
                let v: IReference<bool> = PropertyValue::CreateBoolean(w != 0)
                    .unwrap()
                    .cast()
                    .unwrap();
                let _ = c.SetIsChecked(&v);
            }
            0
        }
        CB_GETCURSEL => c
            .cast::<ComboBox>()
            .and_then(|c| c.SelectedIndex())
            .unwrap_or(0) as isize,
        _ => 0,
    }
}
impl App {
    fn h(&self, id: u16) -> FrameworkElement {
        self.controls[&id].clone()
    }
    unsafe fn error(&self, s: &str) {
        label(self.h(9), s);
        visible(
            self.h(9),
            if s.is_empty() {
                Visibility::Collapsed
            } else {
                Visibility::Visible
            },
        );
    }
    unsafe fn reveal(&self) {
        ShowWindow(self.hwnd, SW_RESTORE);
        SetForegroundWindow(self.hwnd);
    }
    unsafe fn layout(&self) {
        visible(
            self.h(25),
            if self.binding {
                Visibility::Visible
            } else {
                Visibility::Collapsed
            },
        );
    }
    unsafe fn apply_theme(&mut self) {
        let _ = self.root.SetRequestedTheme(match self.theme {
            1 => ElementTheme::Light,
            2 => ElementTheme::Dark,
            _ => ElementTheme::Default,
        });
    }
    unsafe fn exit(&mut self) {
        self.exiting = true;
        let _ = self.window.Close();
        if let Ok(app) = xaml::Application::Current() {
            let _ = app.Exit();
        }
    }
    unsafe fn refresh(&self) {
        for id in [21, 23, 24] {
            enabled(self.h(id), (!self.bound && !self.binding) as i32);
        }
        enabled(self.h(26), (self.bound && !self.binding) as i32);
        for i in 0..4 {
            enabled(
                self.h(31 + i),
                (!self.binding && !self.host.pending.values().any(|p| p.control == 31 + i)) as i32,
            );
        }
    }
    unsafe fn send(&mut self, action: &str, args: Value, control: u16) {
        self.error("");
        match self.host.send(action, args, control) {
            Ok(()) => {
                if control != 0 {
                    enabled(self.h(control), 0);
                }
            }
            Err(_) => {
                self.error("本机连接已关闭。");
                if action == "bind" {
                    self.binding = false;
                    self.refresh();
                }
                if action == "quit" {
                    if !self.host.running() {
                        self.exit();
                    } else {
                        self.quitting = false;
                        self.error("退出尚未完成，客户端仍在运行。请等待当前操作清理后重试。");
                        self.reveal();
                    }
                }
            }
        }
    }
    unsafe fn render(&mut self) {
        let s: String = if !self.healthy {
            "状态暂不可用".into()
        } else if self.status["view"].is_object() {
            self.status["view"]["label"]
                .as_str()
                .unwrap_or("未连接")
                .into()
        } else {
            "正在启动…".into()
        };
        label(self.h(2), &s);
        let online = self.healthy && !self.paused && text(&self.status, "connection") == "online";
        // Include ActualTheme so automatic system-theme changes still refresh the
        // theme foreground, without allocating a fresh brush on every heartbeat.
        let appearance = (
            online,
            self.root.ActualTheme().unwrap_or(ElementTheme::Default),
        );
        if self.status_appearance != Some(appearance) {
            if let Ok(status) = self.h(2).cast::<TextBlock>() {
                let brush = if online {
                    xaml::Media::SolidColorBrush::CreateInstanceWithColor(windows::UI::Color {
                        A: 255,
                        R: 0,
                        G: 102,
                        B: 221,
                    })
                    .and_then(|b| b.cast::<xaml::Media::Brush>())
                } else {
                    self.h(52).cast::<TextBlock>().and_then(|c| c.Foreground())
                };
                if brush.and_then(|b| status.SetForeground(&b)).is_ok() {
                    self.status_appearance = Some(appearance);
                }
            }
        }
        let tip = wide(&format!("aBridge · {s}"));
        let mut next_tip = [0u16; 128];
        let n = tip.len().min(127);
        next_tip[..n].copy_from_slice(&tip[..n]);
        if self.tray.szTip != next_tip {
            self.tray.szTip = next_tip;
            Shell_NotifyIconW(NIM_MODIFY, &self.tray);
        }
    }

    unsafe fn apply_status(&mut self, v: Value) {
        self.status = v;
        let bound = flag(&self.status, "bound");
        if !self.has_status || bound != self.bound {
            let _ = self
                .h(20)
                .cast::<Expander>()
                .and_then(|e| e.SetIsExpanded(!bound));
        }
        self.has_status = true;
        self.bound = bound;
        self.paused = flag(&self.status, "paused");
        if !focused(self.h(10)) {
            label(self.h(10), &text(&self.status, "device_name"));
        }
        if self.bound && !focused(self.h(21)) {
            label(self.h(21), &text(&self.status, "url"));
        }
        label(
            self.h(3),
            &if self.bound {
                [
                    text(&self.status, "owner_name"),
                    text(&self.status, "device_id"),
                ]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · ")
            } else {
                "连接服务端，授权此电脑".into()
            },
        );
        label(self.h(12), if self.paused { "恢复" } else { "暂停" });
        if self.bound {
            let caps = if self.status["requested_capabilities"].is_object() {
                &self.status["requested_capabilities"]
            } else {
                &self.status["capabilities"]
            };
            for (i, key) in CAPS.iter().enumerate() {
                send_control(
                    self.h(31 + i as u16),
                    BM_SETCHECK,
                    if flag(caps, key) {
                        BST_CHECKED as usize
                    } else {
                        0
                    },
                    0,
                );
            }
        }
        let error = self.status["local_error"]
            .as_str()
            .or(self.status["error"].as_str())
            .unwrap_or("")
            .to_string();
        label(
            self.h(51),
            &format!(
                "版本  {}\r\nNode  {}\r\n桌面驱动  {}\r\n连接  {}\r\n设备  {}\r\n{}",
                text(&self.status, "version"),
                self.status["runtime"]["node"].as_str().unwrap_or("未启动"),
                if flag(&self.status["driver"], "ready") {
                    "已就绪"
                } else {
                    "按需启动"
                },
                text(&self.status, "connection"),
                text(&self.status, "device_id"),
                error
            ),
        );
        if !error.is_empty() || read(self.h(9)) == self.status_error {
            self.error(&error);
        }
        self.status_error = error;
        if self.paused || text(&self.status, "connection") != "online" {
            self.active = false;
            self.frames.show(false);
        }
        self.refresh();
        self.render();
        self.layout();
    }
    unsafe fn lose(&mut self, s: &str) {
        self.healthy = false;
        self.active = false;
        self.frames.show(false);
        self.render();
        self.transport_error = s.into();
        self.error(s);
    }
    unsafe fn finish(&mut self, p: Pending, v: Option<Value>) {
        if p.control != 0 {
            enabled(self.h(p.control), 1);
        }
        let ok = v.as_ref().is_some_and(|v| flag(v, "ok"));
        if p.action == "quit" {
            if ok || !self.host.running() {
                if ok {
                    self.host.graceful();
                }
                self.exit();
            } else {
                self.quitting = false;
                self.error("退出尚未完成，客户端仍在运行。请等待当前操作清理后重试。");
                self.reveal();
            }
            return;
        }
        if p.action == "bind" {
            label(self.h(23), "");
            self.binding = false;
            self.refresh();
            self.layout();
        }
        if !ok {
            self.error(
                &v.as_ref()
                    .map(|v| v["error"].as_str().unwrap_or("本机操作失败。").to_string())
                    .unwrap_or("操作确认超时，请检查当前状态后再试。".into()),
            );
            if p.action == "capability" {
                let _ = self.host.send("status", json!({}), 0);
            }
            return;
        }
        let v = v.unwrap();
        if v["status"].is_object() {
            self.apply_status(v["status"].clone());
        } else if v["view"].is_object() {
            self.apply_status(v);
        } else if p.action != "status" {
            self.send("status", json!({}), 0);
        }
    }
    unsafe fn tick(&mut self) {
        if WaitForSingleObject(self.activation, 0) == WAIT_OBJECT_0 {
            self.reveal();
        }
        while let Ok(msg) = self.host.messages.try_recv() {
            match msg {
                Message::Closed => {
                    let pending = std::mem::take(&mut self.host.pending);
                    for (_, p) in pending {
                        self.finish(p, Some(json!({"ok":false,"error":"本机连接已关闭。"})));
                    }
                    self.lose("本机内核已退出，请退出后重新打开 aBridge。");
                }
                Message::Data(v) => {
                    if let Some(id) = v["id"].as_u64() {
                        if let Some(p) = self.host.pending.remove(&id) {
                            self.finish(p, Some(v));
                        }
                    } else {
                        match v["event"].as_str().unwrap_or("") {
                            "status" => self.apply_status(v["status"].clone()),
                            "activity" => {
                                let recovered = !self.healthy;
                                self.heartbeat = Instant::now();
                                self.healthy = true;
                                if recovered && read(self.h(9)) == self.transport_error {
                                    self.error("");
                                }
                                self.transport_error.clear();
                                let active = flag(&v, "active")
                                    && !self.paused
                                    && text(&self.status, "connection") == "online";
                                if active != self.active {
                                    self.active = active;
                                    self.frames.show(active);
                                }
                                if recovered {
                                    self.render();
                                }
                            }
                            "authorization" => {
                                if let Ok(url) = url::Url::parse(&text(&v, "url")) {
                                    if matches!(url.scheme(), "http" | "https") {
                                        let result = ShellExecuteW(
                                            self.hwnd,
                                            wide("open").as_ptr(),
                                            wide(url.as_str()).as_ptr(),
                                            null(),
                                            null(),
                                            SW_SHOWNORMAL,
                                        );
                                        if result as isize <= 32 {
                                            self.error(
                                                "无法打开默认浏览器，请检查系统浏览器设置。",
                                            );
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        for p in self.host.expired() {
            self.finish(p, None);
        }
        if self.healthy && self.heartbeat.elapsed() > Duration::from_secs(2) {
            self.lose("本机状态暂时不可用。");
        }
    }
    unsafe fn command(&mut self, id: u16, notification: u16) {
        match id {
            11 => self.send("rename", json!({"name":read(self.h(10)).trim()}), 11),
            12 => {
                if !self.paused {
                    self.frames.show(false);
                }
                self.send(if self.paused { "resume" } else { "pause" }, json!({}), 12);
            }
            13 => {
                self.frames.show(false);
                self.send("stop", json!({}), 13);
            }
            14 => self.send("connect", json!({}), 14),
            24 => {
                if self.binding || self.bound {
                    return;
                }
                let parsed = url::Url::parse(read(self.h(21)).trim());
                let Ok(url) = parsed else {
                    self.error("请输入有效的 http 或 https 服务端网址。");
                    return;
                };
                if !matches!(url.scheme(), "http" | "https")
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    self.error("请输入有效的 http 或 https 服务端网址。");
                    return;
                }
                let mut args = json!({"url":url.as_str(),"capabilities":{}});
                for (i, key) in CAPS.iter().enumerate() {
                    args["capabilities"][key] = json!(
                        send_control(self.h(31 + i as u16), BM_GETCHECK, 0, 0)
                            == BST_CHECKED as isize
                    );
                }
                if url.scheme() == "http" {
                    let origin = url.origin().ascii_serialization();
                    if MessageBoxW(self.hwnd,wide(&format!("此连接未使用 HTTPS 加密：\n{origin}\n\n仅在你信任的网络中继续。是否允许连接？")).as_ptr(),wide("确认 HTTP 连接").as_ptr(),MB_YESNO|MB_ICONWARNING)!=IDYES{return;}
                    args["http_confirmed_origin"] = json!(origin);
                }
                let token = read(self.h(23));
                if !token.trim().is_empty() {
                    args["device_key"] = json!(token.trim());
                }
                self.binding = true;
                self.refresh();
                self.layout();
                self.send("bind", args, 24);
            }
            25 => self.send("cancel", json!({}), 25),
            26 => {
                if MessageBoxW(
                    self.hwnd,
                    wide("解绑将停止本机任务，并清除本机设备凭据。是否继续？").as_ptr(),
                    wide("解绑设备").as_ptr(),
                    MB_YESNO | MB_ICONQUESTION,
                ) == IDYES
                {
                    self.frames.show(false);
                    self.send("unbind", json!({}), 26);
                }
            }
            31..=34 => {
                if self.bound && !self.binding {
                    let enabled =
                        send_control(self.h(id), BM_GETCHECK, 0, 0) == BST_CHECKED as isize;
                    if id == 32 && !enabled {
                        self.frames.show(false);
                    }
                    self.send(
                        "capability",
                        json!({"capability":CAPS[(id-31) as usize],"enabled":enabled}),
                        id,
                    );
                }
            }
            41 if notification == CBN_SELCHANGE as u16 => {
                self.theme = send_control(self.h(41), CB_GETCURSEL, 0, 0) as i32;
                self.apply_theme();
                let result = (|| -> std::io::Result<()> {
                    std::fs::create_dir_all(self.preferences.parent().unwrap())?;
                    let tmp = self.preferences.with_extension("json.tmp");
                    std::fs::write(&tmp, json!({"theme":self.theme}).to_string())?;
                    if windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                        wide(&tmp.to_string_lossy()).as_ptr(),
                        wide(&self.preferences.to_string_lossy()).as_ptr(),
                        windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING,
                    ) == 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                })();
                if result.is_err() {
                    self.error("外观设置未能保存。");
                }
            }
            60 => self.reveal(),
            61 if !self.quitting => {
                self.quitting = true;
                self.frames.show(false);
                if self.host.running() {
                    self.send("quit", json!({}), 0);
                } else {
                    self.exit();
                }
            }
            _ => {}
        }
    }
    unsafe fn menu(&mut self) {
        let menu = CreatePopupMenu();
        for (id, s) in [
            (60, "打开 aBridge"),
            (12, if self.paused { "恢复" } else { "暂停" }),
            (13, "停止当前任务"),
        ] {
            AppendMenuW(menu, MF_STRING, id, wide(s).as_ptr());
        }
        AppendMenuW(menu, MF_SEPARATOR, 0, null());
        AppendMenuW(menu, MF_STRING, 61, wide("退出").as_ptr());
        let mut p = std::mem::zeroed();
        GetCursorPos(&mut p);
        SetForegroundWindow(self.hwnd);
        let id = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            p.x,
            p.y,
            0,
            self.hwnd,
            null(),
        );
        DestroyMenu(menu);
        if id != 0 {
            self.command(id as u16, 0);
        }
        PostMessageW(self.hwnd, WM_NULL, 0, 0);
    }
    unsafe fn initialize_tray(&mut self) {
        if RegisterHotKey(
            self.hwnd,
            1,
            MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
            0x50,
        ) == 0
        {
            self.error("暂停快捷键已被其他程序占用。");
        }
        self.tray = std::mem::zeroed();
        self.tray.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        self.tray.hWnd = self.hwnd;
        self.tray.uID = 1;
        self.tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        self.tray.uCallbackMessage = self.tray_callback;
        self.tray.hIcon = LoadIconW(GetModuleHandleW(null()), std::ptr::without_provenance(1));
        if self.tray.hIcon.is_null() {
            self.tray.hIcon = LoadIconW(null_mut(), IDI_APPLICATION);
        }
        let tip = wide("aBridge · 正在启动");
        self.tray.szTip[..tip.len()].copy_from_slice(&tip);
        Shell_NotifyIconW(NIM_ADD, &self.tray);
        SetTimer(self.hwnd, HOST_TIMER, 100, None);
        self.send("status", json!({}), 0);
    }
}

unsafe extern "system" fn proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    let app = &mut *(data as *mut App);
    if msg == app.taskbar_created {
        Shell_NotifyIconW(NIM_ADD, &app.tray);
        return 0;
    }
    match msg {
        WM_CLOSE if !app.exiting => {
            ShowWindow(hwnd, SW_HIDE);
            return 0;
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(hwnd, Some(proc), 1);
        }
        WM_DESTROY => {
            KillTimer(hwnd, HOST_TIMER);
            UnregisterHotKey(hwnd, 1);
            app.frames.show(false);
            Shell_NotifyIconW(NIM_DELETE, &app.tray);
        }
        WM_TIMER if w == HOST_TIMER => {
            app.tick();
            return 0;
        }
        WM_COMMAND if matches!((w & 65535) as u16, 11..=14 | 24..=26 | 31..=34 | 41 | 60 | 61) => {
            app.command((w & 65535) as u16, (w >> 16) as u16);
            return 0;
        }
        WM_HOTKEY if w == 1 => {
            app.frames.show(false);
            app.send("pause", json!({}), 0);
            return 0;
        }
        message if message == app.tray_callback => {
            match l as u32 {
                WM_LBUTTONDBLCLK => app.reveal(),
                WM_RBUTTONUP | WM_CONTEXTMENU => app.menu(),
                _ => {}
            }
            return 0;
        }
        WM_DISPLAYCHANGE => {
            if app.active && app.healthy {
                app.frames.show(true);
            }
        }
        WM_GETMINMAXINFO => {
            let info = &mut *(l as *mut MINMAXINFO);
            let dpi = GetDpiForWindow(hwnd) as i32;
            info.ptMinTrackSize = POINT {
                x: 440 * dpi / 96,
                y: 440 * dpi / 96,
            };
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, w, l)
}
impl Drop for App {
    fn drop(&mut self) {
        unsafe {
            RemoveWindowSubclass(self.hwnd, Some(proc), 1);
            KillTimer(self.hwnd, HOST_TIMER);
            UnregisterHotKey(self.hwnd, 1);
            Shell_NotifyIconW(NIM_DELETE, &self.tray);
            self.frames.show(false);
            let _ = self.window.Close();
        }
    }
}
unsafe fn build(
    base: PathBuf,
    state: PathBuf,
    activation: HANDLE,
) -> Result<Box<App>, Box<dyn std::error::Error>> {
    let window = Window::new()?;
    window.SetTitle(&HSTRING::from("aBridge"))?;
    let native = window.cast::<naui_winui3::IWindowNative>()?;
    let hwnd = native.WindowHandle()?.0;
    let root = XamlReader::Load(&HSTRING::from(include_str!("settings.xaml")))?
        .cast::<FrameworkElement>()?;
    let mut controls = HashMap::new();
    for id in [
        2, 3, 9, 10, 11, 12, 13, 14, 20, 21, 23, 24, 25, 26, 31, 32, 33, 34, 41, 51, 52,
    ] {
        controls.insert(
            id,
            root.FindName(&HSTRING::from(format!("c{id}")))?
                .cast::<FrameworkElement>()?,
        );
    }
    window.SetContent(&root.cast::<UIElement>()?)?;
    let preferences = state.join("windows-ui/native-preferences.json");
    let theme = std::fs::read(&preferences)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["theme"].as_i64())
        .unwrap_or(0)
        .clamp(0, 2) as i32;
    controls[&41].cast::<ComboBox>()?.SetSelectedIndex(theme)?;
    let mut app = Box::new(App {
        exiting: false,
        hwnd,
        window,
        root,
        controls,
        host: Host::start(&base, &state)?,
        frames: Frames::default(),
        activation,
        preferences,
        status: Value::Null,
        healthy: false,
        active: false,
        bound: false,
        paused: false,
        binding: false,
        quitting: false,
        has_status: false,
        heartbeat: Instant::now(),
        theme,
        status_appearance: None,
        status_error: String::new(),
        transport_error: String::new(),
        tray: std::mem::zeroed(),
        taskbar_created: RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
        tray_callback: RegisterWindowMessageW(wide("aBridge.Native.Tray.Callback").as_ptr()),
    });
    SetWindowSubclass(hwnd, Some(proc), 1, &mut *app as *mut App as usize);
    for id in [11u16, 12, 13, 14, 24, 25, 26] {
        let handle = hwnd as usize;
        app.h(id)
            .cast::<Button>()?
            .Click(&RoutedEventHandler::new(move |_, _| {
                PostMessageW(handle as HWND, WM_COMMAND, id as usize, 0);
                Ok(())
            }))?;
    }
    for id in 31u16..=34 {
        let handle = hwnd as usize;
        app.h(id)
            .cast::<CheckBox>()?
            .Click(&RoutedEventHandler::new(move |_, _| {
                PostMessageW(handle as HWND, WM_COMMAND, id as usize, 0);
                Ok(())
            }))?;
    }
    let handle = hwnd as usize;
    app.h(41)
        .cast::<ComboBox>()?
        .SelectionChanged(&SelectionChangedEventHandler::new(move |_, _| {
            PostMessageW(
                handle as HWND,
                WM_COMMAND,
                41 | ((CBN_SELCHANGE as usize) << 16),
                0,
            );
            Ok(())
        }))?;
    app.apply_theme();
    app.refresh();
    app.layout();
    app.initialize_tray();
    SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, app.tray.hIcon as isize);
    SendMessageW(
        hwnd,
        WM_SETICON,
        ICON_SMALL as usize,
        app.tray.hIcon as isize,
    );
    let dpi = GetDpiForWindow(hwnd) as i32;
    let width = 540 * dpi / 96;
    let height = 640 * dpi / 96;
    SetWindowPos(
        hwnd,
        null_mut(),
        (GetSystemMetrics(SM_CXSCREEN) - width) / 2,
        (GetSystemMetrics(SM_CYSCREEN) - height) / 2,
        width,
        height,
        SWP_NOZORDER,
    );
    app.window.Activate()?;
    Ok(app)
}
pub unsafe fn run(
    base: PathBuf,
    state: PathBuf,
    activation: HANDLE,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::{cell::RefCell, rc::Rc};
    let result = Rc::new(RefCell::new(None::<Box<App>>));
    let result_ui = result.clone();
    let failure = Rc::new(RefCell::new(None::<String>));
    let failure_ui = failure.clone();
    // naui's lifecycle helper supplies WinUI's composed Application and metadata provider.
    // All controls and device UI state below remain owned by aBridge.
    naui_windows::run(naui_core::Settings::new("aBridge"), move |_| {
        match build(base, state, activation as usize as HANDLE) {
            Ok(app) => *result_ui.borrow_mut() = Some(app),
            Err(e) => {
                *failure_ui.borrow_mut() = Some(e.to_string());
                if let Ok(app) = xaml::Application::Current() {
                    let _ = app.Exit();
                }
            }
        }
        Ok(())
    })?;
    result.borrow_mut().take();
    let error = failure.borrow_mut().take();
    if let Some(error) = error {
        Err(error.into())
    } else {
        Ok(())
    }
}

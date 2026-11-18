mod executor;
mod protocol;
mod runtime;
mod service;
mod storage;
mod system;
use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::{self, BufRead, IsTerminal, Read, Write},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use storage::Config;

const HELP:&str="aBridge Linux client — shell and files\n\nUsage: abridge-client <command> [--state-dir PATH]\n\n  setup --url URL [--http-confirmed-origin ORIGIN]  Confirm remote HTTP, then read Device Token\n  setup --stdin                                  Read binding JSON from stdin\n  run                                            Run in foreground\n  status                                         Show device status (JSON)\n  pause | resume | stop                          Control local access/tasks\n  capability <shell|files> <on|off>               Change local capability\n  service install [--linger]                     Install/start user systemd service\n  service uninstall | status | logs              Manage user service\n  logs                                           Show recent service journal\n  --version                                      Product version\n\nState defaults to $XDG_DATA_HOME/abridge/linux-client or ~/.local/share/abridge/linux-client.\nsetup requires a computer Device Token from the management console.\nShell/files use the service user's permissions and are not sandboxed.\n";
fn take_option(args: &mut Vec<String>, name: &str) -> Result<Option<String>> {
    let Some(index) = args.iter().position(|s| s == name) else {
        return Ok(None);
    };
    args.remove(index);
    ensure!(index < args.len(), "Missing value for {name}");
    let value = args.remove(index);
    ensure!(!args.iter().any(|s| s == name), "Duplicate option {name}");
    Ok(Some(value))
}
fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    if let Some(index) = args.iter().position(|s| s == name) {
        args.remove(index);
        true
    } else {
        false
    }
}
fn default_state() -> Result<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/share")))
        .context("HOME must be set, or specify --state-dir")?;
    Ok(base.join("abridge/linux-client"))
}
fn absolute(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}
fn bounded_stdin(max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    io::stdin().take((max + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max, "Input too large");
    Ok(bytes)
}
async fn hidden_token() -> Result<String> {
    eprint!("Device Token: ");
    io::stderr().flush()?;
    if !io::stdin().is_terminal() {
        let bytes = bounded_stdin(4097)?;
        return Ok(String::from_utf8(bytes)?.trim().to_owned());
    }
    let terminal = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open("/dev/stdin")?;
    // AsyncFd owns the nonblocking file and deregisters it before closing it.
    let terminal = unsafe {
        tokio::io::unix::AsyncFd::register_with_interest(terminal, tokio::io::Interest::READABLE)
    }?;
    let fd = terminal.get_ref().as_raw_fd();
    struct Echo(libc::c_int, libc::termios);
    impl Drop for Echo {
        fn drop(&mut self) {
            unsafe {
                libc::tcsetattr(self.0, libc::TCSANOW, &self.1);
            }
        }
    }
    let mut old = std::mem::MaybeUninit::<libc::termios>::uninit();
    ensure!(
        unsafe { libc::tcgetattr(fd, old.as_mut_ptr()) } == 0,
        "Cannot disable terminal echo"
    );
    let old = unsafe { old.assume_init() };
    let _restore = Echo(fd, old);
    let mut settings = old;
    settings.c_lflag &= !libc::ECHO;
    ensure!(
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &settings) } == 0,
        "Cannot disable terminal echo"
    );
    let mut value = [0; 4098];
    let length = loop {
        let mut ready = terminal.readable().await?;
        if let Ok(result) = ready.try_io(|fd| fd.get_ref().read(&mut value)) {
            break result?;
        }
    };
    eprintln!();
    ensure!(length <= 4097, "Device Token too long");
    Ok(std::str::from_utf8(&value[..length])?.trim().to_owned())
}
fn parse_server(value: &str) -> Result<url::Url> {
    let url = url::Url::parse(value.trim()).context("Provide a complete HTTP(S) Server URL")?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Server URL must use HTTP(S), without credentials, query or fragment"
    );
    Ok(url)
}

fn remote_http_origin(url: &url::Url) -> Option<String> {
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    (url.scheme() == "http" && !local).then(|| url.origin().ascii_serialization())
}

fn confirm_remote_http(origin: &str) -> Result<()> {
    eprintln!("HTTP sends the Device Token and operations without encryption.");
    eprint!("Continue connecting to {origin}? [y/N] ");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().lock().take(32).read_line(&mut answer)?;
    let confirmed = answer.trim();
    ensure!(
        answer.ends_with('\n')
            && (confirmed.eq_ignore_ascii_case("y") || confirmed.eq_ignore_ascii_case("yes")),
        "Setup cancelled"
    );
    Ok(())
}

pub fn normalize_server(value: &str, confirmed: Option<&str>) -> Result<String> {
    let url = parse_server(value)?;
    if let Some(origin) = remote_http_origin(&url) {
        ensure!(
            confirmed == Some(origin.as_str()),
            "Unencrypted HTTP requires confirmation for the exact origin; use an interactive terminal, --http-confirmed-origin, or http_confirmed_origin with setup --stdin"
        );
    }
    let normalized = url.to_string();
    Ok(normalized
        .strip_suffix('/')
        .unwrap_or(&normalized)
        .to_owned())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BindingInput {
    url: String,
    device_key: String,
    http_confirmed_origin: Option<String>,
    capabilities: Option<BTreeMap<String, bool>>,
}
async fn setup(dir: &Path, input: BindingInput) -> Result<()> {
    let _lock = storage::lock(dir).context("Stop the running client before rebinding")?;
    let url = normalize_server(&input.url, input.http_confirmed_origin.as_deref())?;
    ensure!(
        input.device_key.starts_with("abr_device_")
            && input.device_key.len() <= 4096
            && !input
                .device_key
                .chars()
                .any(|c| c.is_control() || c.is_whitespace()),
        "Use a valid Device Token"
    );
    if let Some(caps) = &input.capabilities {
        ensure!(
            caps.keys().all(|s| matches!(s.as_str(), "shell" | "files")),
            "Only shell/files are supported"
        );
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?;
    let mut response = client
        .get(format!("{url}/api/device"))
        .bearer_auth(&input.device_key)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Cannot verify Device Token with Server"))?;
    ensure!(
        response.status().is_success(),
        "Server rejected Device Token"
    );
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Invalid device response"))?
    {
        ensure!(
            body.len() + chunk.len() <= 65536,
            "Device response too large"
        );
        body.extend_from_slice(&chunk);
    }
    let identity = protocol::parse(
        "deviceIdentity",
        serde_json::from_slice(&body).context("Invalid device identity")?,
    )?;
    ensure!(
        identity["kind"] == "computer",
        "Device Token must belong to a computer"
    );
    let previous = if dir.join("binding.json").exists() {
        Some(storage::load(dir)?)
    } else {
        None
    };
    let granted = identity["capabilities"]
        .as_array()
        .context("Missing capabilities")?;
    let capabilities = ["shell", "files"]
        .into_iter()
        .map(|cap| {
            (
                cap.to_owned(),
                input
                    .capabilities
                    .as_ref()
                    .and_then(|caps| caps.get(cap))
                    .copied()
                    .unwrap_or(true)
                    && granted.iter().any(|c| c == cap),
            )
        })
        .collect();
    let config = Config {
        url,
        device_key: input.device_key,
        capabilities,
        paused: previous.is_some_and(|c| c.paused),
        revoked: false,
        http_confirmed_origin: input.http_confirmed_origin,
        device_id: identity["id"].as_str().map(str::to_owned),
    };
    storage::save(dir, &config)?;
    println!(
        "{}",
        json!({"ok":true,"device_id":config.device_id,"name":identity["name"],"capabilities":config.capabilities,"paused":config.paused})
    );
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = main_inner().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
async fn main_inner() -> Result<()> {
    for schema in protocol::contract().schemas.values() {
        protocol::check_schema(schema)?;
    }
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        print!("{HELP}");
        return Ok(());
    }
    if args == ["--version"] {
        println!("{}", env!("ABRIDGE_VERSION"));
        return Ok(());
    }
    let dir = absolute(match take_option(&mut args, "--state-dir")? {
        Some(path) => PathBuf::from(path),
        None => default_state()?,
    })?;
    let command = args.first().context("Command required")?.clone();
    args.remove(0);
    match command.as_str() {
        "setup" => {
            if take_flag(&mut args, "--stdin") {
                ensure!(args.is_empty(), "Unexpected setup arguments");
                let input = serde_json::from_slice(&bounded_stdin(65536)?)
                    .context("Invalid setup input")?;
                setup(&dir, input).await?;
            } else {
                let url = take_option(&mut args, "--url")?.context("setup requires --url")?;
                let mut http_confirmed_origin = take_option(&mut args, "--http-confirmed-origin")?;
                ensure!(args.is_empty(), "Unexpected setup arguments");
                if http_confirmed_origin.is_none() && io::stdin().is_terminal() {
                    if let Some(origin) = remote_http_origin(&parse_server(&url)?) {
                        confirm_remote_http(&origin)?;
                        http_confirmed_origin = Some(origin);
                    }
                }
                normalize_server(&url, http_confirmed_origin.as_deref())?;
                let bind = async {
                    let input = BindingInput {
                        url,
                        device_key: hidden_token().await?,
                        http_confirmed_origin,
                        capabilities: None,
                    };
                    setup(&dir, input).await
                };
                if io::stdin().is_terminal() {
                    use tokio::signal::unix::{signal, SignalKind};
                    let mut interrupt = signal(SignalKind::interrupt())?;
                    let mut terminate = signal(SignalKind::terminate())?;
                    let mut hangup = signal(SignalKind::hangup())?;
                    let mut quit = signal(SignalKind::quit())?;
                    let mut suspend = signal(SignalKind::from_raw(libc::SIGTSTP))?;
                    // Dropping the pending read restores the tty before setup exits.
                    let cancelled = tokio::select! {
                        biased;
                        _ = interrupt.recv() => true,
                        _ = terminate.recv() => true,
                        _ = hangup.recv() => true,
                        _ = quit.recv() => true,
                        _ = suspend.recv() => true,
                        result = bind => { result?; false }
                    };
                    if cancelled {
                        eprintln!();
                        bail!("Setup cancelled");
                    }
                } else {
                    bind.await?;
                }
            }
        }
        "run" => {
            ensure!(args.is_empty(), "Unexpected run arguments");
            runtime::run(dir).await?;
        }
        "status" => {
            ensure!(args.is_empty(), "Unexpected status arguments");
            match runtime::local_control(&dir, json!({"command":"status"})).await {
                Ok(status) => println!("{status}"),
                Err(error) => {
                    let Ok(_lock) = storage::lock(&dir) else {
                        return Err(error);
                    };
                    let config = storage::load(&dir)?;
                    println!("{}", runtime::offline_snapshot(&config));
                }
            }
        }
        "pause" | "resume" | "stop" | "capability" => {
            let mut request = json!({"command":command});
            if command == "capability" {
                ensure!(
                    args.len() == 2
                        && matches!(args[0].as_str(), "shell" | "files")
                        && matches!(args[1].as_str(), "on" | "off"),
                    "Use capability <shell|files> <on|off>"
                );
                request["capability"] = json!(args[0]);
                request["enabled"] = json!(args[1] == "on");
            } else {
                ensure!(args.is_empty(), "Unexpected control arguments");
            }
            match runtime::local_control(&dir, request.clone()).await {
                Ok(value) => println!("{value}"),
                Err(error) => {
                    let Ok(_lock) = storage::lock(&dir) else {
                        return Err(error);
                    };
                    let mut config = storage::load(&dir)?;
                    match command.as_str() {
                        "pause" => config.paused = true,
                        "resume" => {
                            ensure!(!config.revoked, "Device revoked; bind again");
                            config.paused = false;
                        }
                        "capability" => {
                            config.capabilities.insert(args[0].clone(), args[1] == "on");
                        }
                        "stop" => {}
                        _ => unreachable!(),
                    }
                    storage::save(&dir, &config)?;
                    println!("{}", runtime::offline_snapshot(&config));
                }
            }
        }
        "service" => {
            let linger = take_flag(&mut args, "--linger");
            ensure!(args.len() == 1, "Use service install|uninstall|status|logs");
            ensure!(
                !linger || args[0] == "install",
                "--linger is only valid for service install"
            );
            service::manage(&args[0], &dir, linger)?;
        }
        "logs" => {
            ensure!(args.is_empty(), "Unexpected logs arguments");
            service::manage("logs", &dir, false)?;
        }
        // Pipe-based diagnostic used by shared contract regression tests; it never executes tools.
        "protocol-check" => {
            ensure!(args == ["--stdin"], "Use protocol-check --stdin");
            let value: Value = serde_json::from_slice(&bounded_stdin(8 * 1024 * 1024)?)?;
            fn check(v: Value) -> Value {
                match v["schema"]
                    .as_str()
                    .context("Schema required")
                    .and_then(|name| protocol::parse(name, v["value"].clone()))
                {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(_) => json!({"ok":false}),
                }
            }
            println!(
                "{}",
                if let Value::Array(values) = value {
                    Value::Array(values.into_iter().map(check).collect())
                } else {
                    check(value)
                }
            );
        }
        _ => bail!("Unknown command; use --help"),
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_binding_consent() {
        assert_eq!(
            normalize_server("http://127.0.0.1:8765/", None).unwrap(),
            "http://127.0.0.1:8765"
        );
        assert!(normalize_server("http://example.test", None).is_err());
        assert!(normalize_server("http://example.test", Some("http://other.test")).is_err());
        assert!(normalize_server("http://example.test", Some("http://example.test")).is_ok());
        for s in [
            "https://a:b@example.test",
            "https://example.test?x=1",
            "https://example.test#x",
            "file:///tmp/a",
        ] {
            assert!(normalize_server(s, None).is_err());
        }
    }
}

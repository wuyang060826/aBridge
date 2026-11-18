//! Shell and UTF-8 file operations. Arguments are normalized by the shared
//! protocol validator before reaching this module.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Component, PathBuf},
    process::Stdio,
    time::{Duration, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

const MAX_OUTPUT_BYTES: usize = 131072;
const MAX_FILE_BYTES: usize = 1048576;

#[derive(Debug)]
pub struct ExecError {
    pub code: String,
    pub message: String,
    pub status: String,
}

impl ExecError {
    fn refused(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: "refused".into(),
        }
    }

    fn unknown(code: &str) -> Self {
        Self {
            code: code.into(),
            message: "Execution result is unknown; the operation will not be replayed".into(),
            status: "outcome_unknown".into(),
        }
    }
}

fn io_error(error: std::io::Error) -> ExecError {
    // Never return OS error strings: they can contain paths or command data.
    let code = match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EEXIST) => "EEXIST",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EPERM) => "EPERM",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::ENXIO) => "ENXIO",
        _ => return ExecError::unknown("outcome_unknown"),
    };
    ExecError {
        code: "execution_failed".into(),
        message: format!("Local file access failed ({code})"),
        status: "failed".into(),
    }
}

fn check_cancel(cancel: &CancellationToken) -> Result<(), ExecError> {
    if cancel.is_cancelled() {
        Err(ExecError::unknown("operation_cancelled"))
    } else {
        Ok(())
    }
}

fn parse<T: for<'a> Deserialize<'a>>(value: Value) -> Result<T, ExecError> {
    serde_json::from_value(value)
        .map_err(|_| ExecError::refused("invalid_arguments", "Invalid tool arguments"))
}

fn home() -> Result<PathBuf, ExecError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| ExecError::refused("invalid_cwd", "HOME must be an absolute directory"))
}

fn expand(path: &str) -> Result<PathBuf, ExecError> {
    let path = if path == "~" {
        home()?
    } else if let Some(rest) = path.strip_prefix("~/") {
        home()?.join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(path)
    };
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    // Match path.resolve in the existing desktop executor, including lexical .. .
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShellArgs {
    command: String,
    cwd: Option<String>,
    env: Option<BTreeMap<String, String>>,
    timeout: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    path: String,
    limit: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    path: String,
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteArgs {
    path: String,
    content: String,
    overwrite: bool,
}

/// Killing a future must not leave a shell running. Normal completion first
/// terminates the entire process group, then disarms this emergency guard.
struct ProcessGroup(i32);

impl ProcessGroup {
    fn signal(&self, signal: i32) {
        if self.0 > 0 {
            // SAFETY: negative PID addresses only the process group created for
            // this command; it never addresses the client's own process group.
            unsafe {
                libc::kill(-self.0, signal);
            }
        }
    }

    async fn stop(&mut self) {
        self.signal(libc::SIGTERM);
        tokio::time::sleep(Duration::from_millis(150)).await;
        self.signal(libc::SIGKILL);
        self.0 = 0;
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.signal(libc::SIGKILL);
    }
}

struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}

/// Decode complete UTF-8 sequences while retaining a partial trailing sequence.
/// Invalid input uses replacement characters, as Node's StringDecoder does.
fn decode_pending(pending: &mut Vec<u8>, final_chunk: bool) -> String {
    let mut result = String::new();
    let mut consumed = 0;
    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(valid) => {
                result.push_str(valid);
                consumed = pending.len();
            }
            Err(error) => {
                let valid_end = consumed + error.valid_up_to();
                // The prefix length is supplied by the UTF-8 validator.
                result.push_str(std::str::from_utf8(&pending[consumed..valid_end]).unwrap_or(""));
                consumed = valid_end;
                if let Some(length) = error.error_len() {
                    result.push('\u{fffd}');
                    consumed += length;
                } else if final_chunk {
                    result.push('\u{fffd}');
                    consumed = pending.len();
                } else {
                    break;
                }
            }
        }
    }
    pending.drain(..consumed);
    result
}

async fn emit(
    output: &mpsc::Sender<(String, String)>,
    stream: &str,
    text: String,
    cancel: &CancellationToken,
) -> Result<(), ExecError> {
    if text.is_empty() || cancel.is_cancelled() {
        return Ok(());
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Ok(()),
        result = output.send((stream.into(), text)) => {
            result.map_err(|_| ExecError::unknown("outcome_unknown"))
        }
    }
}

async fn capture<R: AsyncRead + Unpin>(
    mut pipe: R,
    stream: &'static str,
    output: mpsc::Sender<(String, String)>,
    cancel: CancellationToken,
) -> Result<Captured, ExecError> {
    let mut bytes = Vec::new();
    let mut pending = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        let read = pipe.read(&mut buffer).await.map_err(io_error)?;
        if read == 0 {
            break;
        }
        let accepted = read.min(MAX_OUTPUT_BYTES.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..accepted]);
        pending.extend_from_slice(&buffer[..accepted]);
        truncated |= accepted != read;
        emit(
            &output,
            stream,
            decode_pending(&mut pending, false),
            &cancel,
        )
        .await?;
    }
    emit(&output, stream, decode_pending(&mut pending, true), &cancel).await?;
    Ok(Captured { bytes, truncated })
}

async fn command_execute(
    args: ShellArgs,
    cancel: CancellationToken,
    output: mpsc::Sender<(String, String)>,
) -> Result<Value, ExecError> {
    if !args.timeout.is_finite() || !(1.0..=120.0).contains(&args.timeout) {
        return Err(ExecError::refused("invalid_arguments", "Invalid timeout"));
    }
    let cwd = match args.cwd {
        Some(path) => expand(&path)?,
        None => home()?,
    };
    if !tokio::fs::metadata(&cwd)
        .await
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err(ExecError::refused(
            "invalid_cwd",
            "Working directory does not exist or is inaccessible",
        ));
    }
    check_cancel(&cancel)?;
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(args.command)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    for name in ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if let Some(env) = args.env {
        command.envs(env);
    }
    let mut child = command
        .spawn()
        .map_err(|_| ExecError::unknown("outcome_unknown"))?;
    let mut group = ProcessGroup(
        child
            .id()
            .ok_or_else(|| ExecError::unknown("outcome_unknown"))? as i32,
    );
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ExecError::unknown("outcome_unknown"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ExecError::unknown("outcome_unknown"))?;
    let capture_cancel = cancel.child_token();
    let capture_output = output.clone();
    let mut capture_task = Box::pin(async {
        tokio::try_join!(
            capture(stdout, "stdout", capture_output, capture_cancel.clone()),
            capture(stderr, "stderr", output.clone(), capture_cancel.clone()),
        )
    });
    let mut captured = None;
    let mut timed_out = false;
    let mut capture_error = None;
    let deadline = tokio::time::sleep(Duration::from_secs_f64(args.timeout));
    tokio::pin!(deadline);
    let exit_status = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break None,
            _ = &mut deadline => { timed_out = true; break None; }
            result = &mut capture_task, if captured.is_none() => {
                match result {
                    Ok(value) => captured = Some(value),
                    Err(error) => { capture_error = Some(error); break None; }
                }
            }
            status = child.wait() => break Some(status.map_err(|_| ExecError::unknown("outcome_unknown"))?),
        }
    };
    // A shell can exit before its background children close inherited pipes.
    // Clean its process group on every exit, not just timeout and cancellation.
    if cancel.is_cancelled() || capture_error.is_some() {
        capture_cancel.cancel();
    }
    group.stop().await;
    let status = match exit_status {
        Some(status) => status,
        None => child
            .wait()
            .await
            .map_err(|_| ExecError::unknown("outcome_unknown"))?,
    };
    check_cancel(&cancel)?;
    if let Some(error) = capture_error {
        return Err(error);
    }
    let (stdout, stderr) = match captured {
        Some(value) => value,
        None => tokio::time::timeout(Duration::from_secs(2), &mut capture_task)
            .await
            .map_err(|_| ExecError::unknown("outcome_unknown"))??,
    };
    check_cancel(&cancel)?;
    Ok(json!({
        "exit_code": status.code().unwrap_or(-1),
        "stdout": String::from_utf8_lossy(&stdout.bytes),
        "stderr": String::from_utf8_lossy(&stderr.bytes),
        "truncated": stdout.truncated || stderr.truncated,
        "timed_out": timed_out,
    }))
}

fn regular(file: &File) -> Result<(), ExecError> {
    if file.metadata().map_err(io_error)?.is_file() {
        Ok(())
    } else {
        Err(ExecError::refused(
            "unsupported_file_type",
            "File access requires a regular file",
        ))
    }
}

fn files_list(args: ListArgs, cancel: &CancellationToken) -> Result<Value, ExecError> {
    let path = expand(&args.path)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&path).map_err(io_error)? {
        check_cancel(cancel)?;
        if entries.len() == args.limit {
            truncated = true;
            break;
        }
        let entry = entry.map_err(io_error)?;
        let info = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "is_directory": info.is_dir(),
            "is_symlink": info.file_type().is_symlink(),
            "size": info.len(),
            "modified_at": info.modified().map_err(io_error)?.duration_since(UNIX_EPOCH)
                .map(|time| time.as_secs_f64()).unwrap_or_else(|error| -error.duration().as_secs_f64()),
        }));
    }
    entries.sort_by_cached_key(|entry| entry["name"].as_str().unwrap_or("").to_lowercase());
    Ok(json!({ "path": path, "entries": entries, "truncated": truncated }))
}

fn file_read(args: ReadArgs, cancel: &CancellationToken) -> Result<Value, ExecError> {
    let path = expand(&args.path)?;
    if args.max_bytes > MAX_FILE_BYTES {
        return Err(ExecError::refused(
            "invalid_arguments",
            "Invalid file size limit",
        ));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&path)
        .map_err(io_error)?;
    check_cancel(cancel)?;
    regular(&file)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(args.max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    check_cancel(cancel)?;
    if bytes.len() > args.max_bytes {
        return Err(ExecError::refused(
            "file_too_large",
            "File exceeds the requested size limit",
        ));
    }
    let content = std::str::from_utf8(&bytes)
        .map_err(|_| ExecError::refused("unsupported_encoding", "File must contain UTF-8 text"))?;
    // TextDecoder's default handling removes an initial UTF-8 BOM.
    Ok(
        json!({ "path": path, "content": content.strip_prefix('\u{feff}').unwrap_or(content), "size": bytes.len() }),
    )
}

fn file_write(args: WriteArgs, cancel: &CancellationToken) -> Result<Value, ExecError> {
    let path = expand(&args.path)?;
    if args.content.len() > MAX_FILE_BYTES {
        return Err(ExecError::refused(
            "invalid_arguments",
            "File content exceeds one MiB",
        ));
    }
    check_cancel(cancel)?;
    let mut options = OpenOptions::new();
    options.write(true).custom_flags(libc::O_NONBLOCK);
    if args.overwrite {
        options.create(true);
    } else {
        options.create_new(true);
    }
    // Preserve existing desktop semantics: symlinks are supported, but their
    // opened targets must be regular files before any truncation occurs.
    let mut file = options.open(&path).map_err(io_error)?;
    regular(&file)?;
    check_cancel(cancel)?;
    if args.overwrite {
        file.set_len(0).map_err(io_error)?;
    }
    file.write_all(args.content.as_bytes()).map_err(io_error)?;
    Ok(json!({ "path": path, "size": args.content.len(), "overwritten": args.overwrite }))
}

pub async fn execute(
    tool: &str,
    args: Value,
    cancel: CancellationToken,
    output: mpsc::Sender<(String, String)>,
) -> Result<Value, ExecError> {
    check_cancel(&cancel)?;
    if tool == "command_execute" {
        return command_execute(parse(args)?, cancel, output).await;
    }
    // File operations are bounded but may still block on disk I/O. Keep them
    // off the runtime thread that owns heartbeats, pause and cancellation.
    let operation: Box<dyn FnOnce() -> Result<Value, ExecError> + Send> = match tool {
        "files_list" => {
            let args = parse(args)?;
            Box::new(move || files_list(args, &cancel))
        }
        "file_read" => {
            let args = parse(args)?;
            Box::new(move || file_read(args, &cancel))
        }
        "file_write" => {
            let args = parse(args)?;
            Box::new(move || file_write(args, &cancel))
        }
        _ => {
            return Err(ExecError::refused(
                "unknown_tool",
                "This device provides only shell and files",
            ))
        }
    };
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_| ExecError::unknown("outcome_unknown"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_with_repeated_separator_stays_under_home() {
        if let Ok(home) = home() {
            assert_eq!(
                expand("~//abridge-fixture").unwrap(),
                home.join("abridge-fixture")
            );
        }
    }
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "abridge-executor-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    async fn run(tool: &str, args: Value) -> Result<Value, ExecError> {
        let (tx, mut rx) = mpsc::channel(32);
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let result = execute(tool, args, CancellationToken::new(), tx).await;
        drain.await.unwrap();
        result
    }

    #[test]
    fn utf8_decoder_preserves_split_codepoints_and_replaces_invalid_bytes() {
        let mut pending = vec![0xe4, 0xb8];
        assert_eq!(decode_pending(&mut pending, false), "");
        pending.extend_from_slice(&[0xad, 0xff, b'a', 0xe2]);
        assert_eq!(decode_pending(&mut pending, false), "中�a");
        assert_eq!(decode_pending(&mut pending, true), "�");
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn file_contract_handles_overwrite_utf8_size_and_symlinks() {
        let directory = Directory::new();
        let path = directory.0.join("file");
        let result = run(
            "file_write",
            json!({"path":path,"content":"你好","overwrite":false}),
        )
        .await
        .unwrap();
        assert_eq!(result["size"], 6);
        assert_eq!(
            run(
                "file_write",
                json!({"path":path,"content":"other","overwrite":false})
            )
            .await
            .unwrap_err()
            .status,
            "failed"
        );
        assert_eq!(
            run("file_read", json!({"path":path,"max_bytes":5}))
                .await
                .unwrap_err()
                .code,
            "file_too_large"
        );
        let link = directory.0.join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        run(
            "file_write",
            json!({"path":link,"content":"x","overwrite":true}),
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "x");
        fs::write(&path, [0xff]).unwrap();
        assert_eq!(
            run("file_read", json!({"path":path,"max_bytes":1024}))
                .await
                .unwrap_err()
                .code,
            "unsupported_encoding"
        );
        fs::write(&path, b"\xef\xbb\xbfhello").unwrap();
        let result = run("file_read", json!({"path":path,"max_bytes":1024}))
            .await
            .unwrap();
        assert_eq!(result["content"], "hello");
        assert_eq!(result["size"], 8);
        assert_eq!(
            run("file_read", json!({"path":directory.0,"max_bytes":1024}))
                .await
                .unwrap_err()
                .code,
            "unsupported_file_type"
        );
    }

    #[tokio::test]
    async fn shell_output_is_bounded_and_timeout_stops_execution() {
        let result = run(
            "command_execute",
            json!({"command":"head -c 140000 /dev/zero | tr '\\0' a; printf err >&2", "timeout":5}),
        )
        .await
        .unwrap();
        assert_eq!(result["stdout"].as_str().unwrap().len(), MAX_OUTPUT_BYTES);
        assert_eq!(result["stderr"], "err");
        assert_eq!(result["truncated"], true);
        let result = run(
            "command_execute",
            json!({"command":"sleep 20", "timeout":1}),
        )
        .await
        .unwrap();
        assert_eq!(result["timed_out"], true);
        assert_eq!(result["exit_code"], -1);
    }

    #[tokio::test]
    async fn cancellation_kills_process_group_and_prevents_later_side_effects() {
        let directory = Directory::new();
        let (tx, mut rx) = mpsc::channel(32);
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let args = json!({"command":"(sleep 1; touch late) & printf ready; wait", "cwd":directory.0,"timeout":5});
        let operation =
            tokio::spawn(async move { execute("command_execute", args, token, tx).await });
        assert_eq!(rx.recv().await.unwrap().1, "ready");
        cancel.cancel();
        assert_eq!(
            operation.await.unwrap().unwrap_err().code,
            "operation_cancelled"
        );
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!directory.0.join("late").exists());
    }

    #[tokio::test]
    async fn normal_shell_exit_cleans_background_pipe_holders() {
        let directory = Directory::new();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            run(
                "command_execute",
                json!({
                    "command":"(sleep 1; touch late) & printf done", "cwd":directory.0,"timeout":5
                }),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["stdout"], "done");
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!directory.0.join("late").exists());
    }
}

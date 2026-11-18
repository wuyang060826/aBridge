//! Owner-only, durable device state. Never persist command arguments or results.
use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub url: String,
    pub device_key: String,
    pub capabilities: BTreeMap<String, bool>,
    pub paused: bool,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_confirmed_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

pub fn owned_directory(path: &Path) -> Result<File> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .context("Expected a real directory")?;
    if directory.metadata()?.uid() != unsafe { libc::geteuid() } {
        bail!("Directory must belong to the current user");
    }
    Ok(directory)
}

pub fn private_dir(path: &Path) -> Result<()> {
    owned_directory(path)?.set_permissions(fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn validate_file(file: &File) -> Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.mode() & 0o777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
    {
        bail!("Local state requires an owner-only regular file with mode 0600");
    }
    Ok(())
}

fn open_private(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    validate_file(&file)?;
    Ok(file)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("State file needs a parent directory")?;
    private_dir(parent)?;
    match fs::symlink_metadata(path) {
        Ok(_) => {
            open_private(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let temporary = parent.join(format!(
        ".abridge-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(content)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

pub fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    atomic_write(path, &serde_json::to_vec(value)?)
}

pub fn read_private_json<T: DeserializeOwned>(path: &Path, max_bytes: usize) -> Result<T> {
    let mut bytes = Vec::new();
    open_private(path)?
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        bail!("Stored local state is too large");
    }
    serde_json::from_slice(&bytes).context("Stored local state is invalid")
}

pub fn load(dir: &Path) -> Result<Config> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir)?;
    let metadata = directory.metadata()?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o777 != 0o700 {
        bail!("Local state requires an owner-only directory with mode 0700");
    }
    let config: Config = read_private_json(&dir.join("binding.json"), 16 * 1024)?;
    if !config.device_key.starts_with("abr_device_") || config.device_key.len() > 4096 {
        bail!("Stored credential is invalid; bind this device again");
    }
    if config
        .capabilities
        .keys()
        .any(|key| key != "shell" && key != "files")
    {
        bail!("This client only supports shell and files");
    }
    Ok(config)
}

pub fn save(dir: &Path, config: &Config) -> Result<()> {
    write_private_json(&dir.join("binding.json"), config)
}

/// Hold the returned descriptor for the entire runtime/setup lifetime.
pub fn lock(dir: &Path) -> Result<File> {
    private_dir(dir)?;
    let path = dir.join("client.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    validate_file(&file)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("This client is already running or being configured");
    }
    Ok(file)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JournalEntry {
    pub request_hash: String,
    pub status: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct JournalRecord {
    id: String,
    request_hash: String,
    status: String,
}

pub struct Journal {
    file: File,
    entries: BTreeMap<String, JournalEntry>,
    failed: bool,
}

impl Journal {
    /// The caller must hold `lock(dir)`. IDs are never expired: a stale dispatch
    /// cannot become executable again merely because the device was restarted.
    pub fn open(dir: &Path) -> Result<Self> {
        private_dir(dir)?;
        let path = dir.join("journal.jsonl");
        let mut entries = BTreeMap::new();
        match open_private(&path) {
            Ok(file) => {
                let mut reader = BufReader::new(file);
                loop {
                    let mut line = Vec::new();
                    let count = Read::by_ref(&mut reader)
                        .take(4097)
                        .read_until(b'\n', &mut line)?;
                    if count == 0 {
                        break;
                    }
                    if count > 4096 {
                        bail!("Operation journal record is too large");
                    }
                    if line.last() != Some(&b'\n') {
                        // A partial final append never completed start()+fsync,
                        // so it cannot authorize execution. Earlier starts remain.
                        break;
                    }
                    let record: JournalRecord = serde_json::from_slice(&line)
                        .context("Operation journal is invalid; refusing to replay operations")?;
                    if record.id.is_empty() || record.id.len() > 256 {
                        bail!("Operation journal identity is invalid");
                    }
                    let mut entry = JournalEntry {
                        request_hash: record.request_hash,
                        status: record.status,
                    };
                    if entry.status == "executing" {
                        entry.status = "outcome_unknown".into();
                    }
                    entries.insert(record.id, entry);
                }
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
        // Compaction keeps one metadata record per identity and also removes an
        // interrupted final append. Atomic rename preserves the previous journal.
        let mut compact = Vec::new();
        for (id, entry) in &entries {
            serde_json::to_writer(
                &mut compact,
                &JournalRecord {
                    id: id.clone(),
                    request_hash: entry.request_hash.clone(),
                    status: entry.status.clone(),
                },
            )?;
            compact.push(b'\n');
        }
        atomic_write(&path, &compact)?;
        let file = OpenOptions::new()
            .append(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        validate_file(&file)?;
        Ok(Self {
            file,
            entries,
            failed: false,
        })
    }

    pub fn get(&self, id: &str) -> Option<&JournalEntry> {
        self.entries.get(id)
    }

    fn append(&mut self, id: &str, entry: JournalEntry) -> Result<()> {
        if self.failed {
            bail!("Operation journal could not be persisted; restart after repairing storage");
        }
        let mut bytes = serde_json::to_vec(&JournalRecord {
            id: id.into(),
            request_hash: entry.request_hash.clone(),
            status: entry.status.clone(),
        })?;
        bytes.push(b'\n');
        if bytes.len() > 4096 {
            bail!("Operation journal record is too large");
        }
        // Keep the identity reserved even if persistence fails in this process.
        self.entries.insert(id.into(), entry);
        self.failed = true;
        self.file.write_all(&bytes)?;
        self.file.sync_all()?;
        self.failed = false;
        Ok(())
    }

    pub fn start(&mut self, id: &str, hash: &str) -> Result<()> {
        if self.entries.contains_key(id) {
            bail!("Operation identity already exists");
        }
        self.append(
            id,
            JournalEntry {
                request_hash: hash.into(),
                status: "executing".into(),
            },
        )
    }

    pub fn finish(&mut self, id: &str, status: &str) -> Result<()> {
        let mut entry = self
            .entries
            .get(id)
            .context("Operation identity is missing")?
            .clone();
        entry.status = status.into();
        self.append(id, entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn temporary() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "abridge-storage-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        private_dir(&path).unwrap();
        path
    }

    #[test]
    fn state_is_private_and_rejects_symlinks_and_public_files() {
        let dir = temporary();
        let path = dir.join("state.json");
        write_private_json(&path, &serde_json::json!({"value": 1})).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        let link = dir.join("link.json");
        symlink(&path, &link).unwrap();
        assert!(read_private_json::<serde_json::Value>(&link, 100).is_err());
        assert!(write_private_json(&link, &serde_json::json!(null)).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_private_json::<serde_json::Value>(&path, 100).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lock_has_single_owner() {
        let dir = temporary();
        let first = lock(&dir).unwrap();
        assert!(lock(&dir).is_err());
        drop(first);
        assert!(lock(&dir).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn journal_recovers_unknown_without_replay_and_keeps_terminal_status() {
        let dir = temporary();
        let mut journal = Journal::open(&dir).unwrap();
        journal.start("op_pending", "hash-a").unwrap();
        journal.start("op_complete", "hash-b").unwrap();
        journal.finish("op_complete", "executed").unwrap();
        assert!(journal.start("op_pending", "different").is_err());
        drop(journal);
        OpenOptions::new()
            .append(true)
            .open(dir.join("journal.jsonl"))
            .unwrap()
            .write_all(b"{\"id\":")
            .unwrap();
        let mut recovered = Journal::open(&dir).unwrap();
        assert_eq!(
            recovered.get("op_pending").unwrap().status,
            "outcome_unknown"
        );
        assert_eq!(recovered.get("op_complete").unwrap().status, "executed");
        assert!(recovered.start("op_pending", "hash-a").is_err());
        recovered.start("op_new", "hash-c").unwrap();
        drop(recovered);
        assert!(Journal::open(&dir).unwrap().get("op_new").is_some());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_complete_journal_record_fails_closed() {
        let dir = temporary();
        atomic_write(&dir.join("journal.jsonl"), b"not-json\n").unwrap();
        assert!(Journal::open(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}

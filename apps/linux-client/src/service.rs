//! systemd owns supervision; the same foreground `run` command works elsewhere.
use anyhow::{bail, Context, Result};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

const UNIT: &str = "abridge-client.service";
const MARKER: &str = "# Managed by aBridge Linux client\n";

fn home() -> Result<PathBuf> {
    let value = std::env::var_os("HOME").context("HOME is not set")?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        bail!("HOME must be an absolute path");
    }
    Ok(path)
}

fn paths() -> Result<(PathBuf, PathBuf)> {
    let home = home()?;
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    if !config.is_absolute() {
        bail!("XDG_CONFIG_HOME must be an absolute path");
    }
    Ok((
        home.join(".local/lib/abridge-client/abridge-client"),
        config.join("systemd/user").join(UNIT),
    ))
}

// systemd ExecStart is not shell syntax. Quote whitespace, escape C-style quote
// characters and double specifiers. ExecStart uses the `:` prefix to disable
// environment expansion entirely, including in literal paths containing `$`.
fn quote(value: &str) -> Result<String> {
    if value.chars().any(char::is_control) {
        bail!("Service paths cannot contain control characters");
    }
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '%' => output.push_str("%%"),
            value => output.push(value),
        }
    }
    output.push('"');
    Ok(output)
}

pub fn unit_contents(binary: &Path, state_dir: &Path, user_home: &Path) -> Result<String> {
    if !binary.is_absolute() || !state_dir.is_absolute() || !user_home.is_absolute() {
        bail!("Service paths must be absolute");
    }
    let binary = quote(&format!(
        ":{}",
        binary.to_str().context("Executable path must be UTF-8")?
    ))?;
    let state = quote(state_dir.to_str().context("State path must be UTF-8")?)?;
    let home = user_home.to_str().context("HOME must be UTF-8")?;
    let environment = quote(&format!(
        "PATH={home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    ))?;
    Ok(format!(
        "{MARKER}[Unit]\nDescription=aBridge Linux device client\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=exec\nExecStart={binary} run --state-dir {state}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\nUMask=0077\nEnvironment={environment}\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n"
    ))
}

fn command(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program).args(args).status().with_context(|| {
        format!("Could not run {program}; check that user systemd is available")
    })?;
    if !status.success() {
        bail!("{program} failed; installed files and device binding have been preserved");
    }
    Ok(())
}

fn existing_unit(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path);
    let mut file = match file {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
        bail!("Refusing to replace a service file not owned by this user");
    }
    let mut content = Vec::new();
    (&mut file).take(65537).read_to_end(&mut content)?;
    if content.len() > 65536 || !content.starts_with(MARKER.as_bytes()) {
        bail!("An unmanaged abridge-client.service already exists; refusing to overwrite it");
    }
    Ok(Some(content))
}

fn atomic_install(path: &Path, source: &mut dyn Read, mode: u32) -> Result<()> {
    let directory = path.parent().context("Install path needs a parent")?;
    crate::storage::private_dir(directory)?;
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if !metadata.is_file()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.nlink() != 1 =>
        {
            bail!("Install destination must be a regular file owned by this user");
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let temporary = directory.join(format!(".abridge-install-{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temporary)?;
    let result = (|| {
        std::io::copy(source, &mut file)?;
        file.flush()?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

pub fn manage(action: &str, state_dir: &Path, linger: bool) -> Result<()> {
    if !cfg!(target_os = "linux") {
        bail!("Service management requires Linux with systemd; use run for foreground execution");
    }
    if unsafe { libc::geteuid() } == 0 {
        bail!("Install the user service as a regular user, without sudo");
    }
    if linger && action != "install" {
        bail!("--linger is only supported by service install");
    }
    let (binary, unit) = paths()?;
    match action {
        "install" => {
            crate::storage::load(state_dir)
                .context("Bind this device with setup before installing the service")?;
            let state_dir = fs::canonicalize(state_dir)?;
            let contents = unit_contents(&binary, &state_dir, &home()?)?;
            existing_unit(&unit)?;
            // Probe the user manager without printing its environment, which may
            // contain secrets inherited from the login session.
            command("systemctl", &["--user", "daemon-reload"])?;
            if linger {
                command("loginctl", &["enable-linger"])?;
            }
            let source = std::env::current_exe()?;
            atomic_install(&binary, &mut File::open(source)?, 0o700)?;
            atomic_install(&unit, &mut contents.as_bytes(), 0o600)?;
            command("systemctl", &["--user", "daemon-reload"])?;
            command("systemctl", &["--user", "enable", UNIT])?;
            command("systemctl", &["--user", "restart", UNIT])?;
            println!("Installed user service. Use abridge-client service status to inspect it.");
            if !linger {
                println!("For startup before login and operation after logout, enable lingering with loginctl enable-linger.");
            }
        }
        "uninstall" => {
            if existing_unit(&unit)?.is_none() {
                println!("The aBridge user service is not installed.");
                return Ok(());
            }
            command("systemctl", &["--user", "disable", "--now", UNIT])?;
            fs::remove_file(&unit)?;
            command("systemctl", &["--user", "daemon-reload"])?;
            // Keep the installed CLI usable, and never remove device credentials,
            // operation identities, or account-wide lingering on service removal.
            println!("Removed user service; the CLI and device state are preserved.");
        }
        "status" => command("systemctl", &["--user", "status", "--no-pager", UNIT])?,
        "logs" => command(
            "journalctl",
            &["--user", "--unit", UNIT, "--lines", "100", "--no-pager"],
        )?,
        _ => bail!("Expected service install, uninstall, status, or logs"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_escapes_systemd_expansion_and_paths() {
        let unit = unit_contents(
            Path::new("/home/a b/$USER%/a\"b\\client"),
            Path::new("/home/a b/state %x/$HOME"),
            Path::new("/home/a b/$USER%"),
        )
        .unwrap();
        assert!(unit.contains("ExecStart=\":/home/a b/$USER%%/a\\\"b\\\\client\" run --state-dir \"/home/a b/state %%x/$HOME\""));
        assert!(unit.contains("Environment=\"PATH=/home/a b/$USER%%/.local/bin:"));
        assert!(unit.contains("KillMode=control-group\n"));
        assert!(unit.contains("Restart=on-failure\n"));
        assert!(!unit.contains("User=root"));
    }

    #[test]
    fn unit_rejects_control_characters_and_relative_paths() {
        assert!(unit_contents(
            Path::new("relative"),
            Path::new("/state"),
            Path::new("/home/u")
        )
        .is_err());
        assert!(unit_contents(
            Path::new("/bin/client"),
            Path::new("/state\nExecStart=/evil"),
            Path::new("/home/u")
        )
        .is_err());
    }
}

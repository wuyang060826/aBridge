use serde_json::{Map, Value};
use std::{ffi::CStr, fs::File, io::Read, mem::MaybeUninit};

fn bounded_text(path: &str, limit: u64) -> Option<String> {
    let mut data = String::new();
    File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_string(&mut data)
        .ok()?;
    (data.len() as u64 <= limit).then_some(data)
}

fn os_release_value(source: &str, key: &str) -> Option<String> {
    let value = source
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter_map(|(name, value)| (name == key).then_some(value))
        .next_back()?;
    if let Some(literal) = value
        .strip_prefix('\'')
        .and_then(|text| text.strip_suffix('\''))
    {
        return Some(literal.to_owned());
    }
    let value = value
        .strip_prefix('"')
        .and_then(|text| text.strip_suffix('"'))
        .unwrap_or(value);
    let mut chars = value.chars().peekable();
    let mut decoded = String::new();
    while let Some(character) = chars.next() {
        if character == '\\'
            && chars
                .peek()
                .is_some_and(|c| matches!(c, '\\' | '"' | '$' | '`'))
        {
            decoded.push(chars.next()?);
        } else {
            decoded.push(character);
        }
    }
    Some(decoded)
}

fn runtime_user() -> Option<String> {
    let mut entry = MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    let mut buffer = [0; 16 * 1024];
    // getpwuid_r keeps the name in the caller's buffer until it is copied.
    unsafe {
        if libc::getpwuid_r(
            libc::geteuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut result,
        ) != 0
            || result.is_null()
        {
            return None;
        }
        CStr::from_ptr((*result).pw_name)
            .to_str()
            .ok()
            .map(str::to_owned)
    }
}

pub fn details() -> Value {
    let mut facts = Map::new();
    let mut set = |key, value: &str| {
        let text = value.trim();
        if !text.is_empty()
            && text.encode_utf16().count() <= 128
            && !text.chars().any(char::is_control)
        {
            facts.insert(key, Value::String(text.to_owned()));
        }
    };
    set("os".into(), "linux");
    let mut system = MaybeUninit::<libc::utsname>::uninit();
    if unsafe { libc::uname(system.as_mut_ptr()) } == 0 {
        let system = unsafe { system.assume_init() };
        for (key, field) in [
            ("hostname", &system.nodename),
            ("architecture", &system.machine),
            ("kernel_version", &system.release),
        ] {
            if let Ok(value) = unsafe { CStr::from_ptr(field.as_ptr()) }.to_str() {
                set(
                    key.into(),
                    if value == "aarch64" && key == "architecture" {
                        "arm64"
                    } else {
                        value
                    },
                );
            }
        }
    }
    if let Some(source) = bounded_text("/etc/os-release", 64 * 1024)
        .or_else(|| bounded_text("/usr/lib/os-release", 64 * 1024))
    {
        for (key, field) in [("distribution", "NAME"), ("os_version", "VERSION_ID")] {
            if let Some(value) = os_release_value(&source, field) {
                set(key.into(), &value);
            }
        }
    }
    if let Some(model) = bounded_text("/sys/devices/virtual/dmi/id/product_name", 1024)
        .or_else(|| bounded_text("/sys/firmware/devicetree/base/model", 1024))
    {
        set("model".into(), model.trim_end_matches('\0'));
    }
    if let Some(user) = runtime_user() {
        set("runtime_user".into(), &user);
    }
    Value::Object(facts)
}

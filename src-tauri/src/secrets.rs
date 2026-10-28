//! Secrets: the Todoist token, the Google refresh token and the Google client secret.
//!
//! Release builds keep them in the OS keychain (macOS Keychain, Linux Secret Service).
//! Dev builds keep them in `dev-secrets.json` in the app config dir, readable only by the user:
//! macOS ties keychain permission to the exact binary, and every dev rebuild is a new binary,
//! so the keychain would ask for permission again after each rebuild. A dev build copies a
//! secret over from the keychain the first time it reads one, so nothing has to be re-entered.
//!
//! Either way, each secret is read from storage at most once per launch and then kept in memory.

use keyring::Entry;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, Mutex, OnceLock},
};

const SERVICE: &str = "dev.bosstimer.app";

pub const TODOIST_TOKEN: &str = "todoist-token";
pub const GOOGLE_REFRESH: &str = "google-refresh-token";
pub const GOOGLE_SECRET: &str = "google-client-secret";

/// name → value (None = known to be absent).
static CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> = LazyLock::new(Default::default);
static DEV_FILE: OnceLock<PathBuf> = OnceLock::new();

/// Call once at startup with the app config dir.
pub fn init(config_dir: PathBuf) {
    if cfg!(debug_assertions) {
        let _ = DEV_FILE.set(config_dir.join("dev-secrets.json"));
    }
}

pub fn get(name: &str) -> Option<String> {
    let mut cache = CACHE.lock().unwrap();
    if let Some(v) = cache.get(name) {
        return v.clone();
    }
    let v = load(name);
    cache.insert(name.to_string(), v.clone());
    v
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    store(name, Some(value))?;
    CACHE.lock().unwrap().insert(name.to_string(), Some(value.to_string()));
    Ok(())
}

pub fn delete(name: &str) {
    let _ = store(name, None);
    CACHE.lock().unwrap().insert(name.to_string(), None);
}

fn keychain_get(name: &str) -> Option<String> {
    Entry::new(SERVICE, name).ok()?.get_password().ok().filter(|s| !s.is_empty())
}

fn load(name: &str) -> Option<String> {
    match DEV_FILE.get() {
        None => keychain_get(name),
        Some(path) => {
            if let Some(v) = dev_file::read(path).remove(name) {
                return Some(v).filter(|s| !s.is_empty());
            }
            // First read in a dev build: copy it over from the keychain once.
            let v = keychain_get(name)?;
            let _ = dev_file::write_one(path, name, Some(&v));
            Some(v)
        }
    }
}

fn store(name: &str, value: Option<&str>) -> Result<(), String> {
    match DEV_FILE.get() {
        // An empty value marks it deleted, so it isn't copied back from the keychain later.
        Some(path) => dev_file::write_one(path, name, Some(value.unwrap_or(""))),
        None => {
            let entry = Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
            match value {
                Some(v) => entry.set_password(v).map_err(|e| format!("Couldn't save to the keychain: {e}")),
                None => {
                    let _ = entry.delete_credential();
                    Ok(())
                }
            }
        }
    }
}

mod dev_file {
    use std::{collections::HashMap, fs, io::Write, path::Path};

    pub fn read(path: &Path) -> HashMap<String, String> {
        fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn write_one(path: &Path, name: &str, value: Option<&str>) -> Result<(), String> {
        let mut map = read(path);
        match value {
            Some(v) => map.insert(name.to_string(), v.to_string()),
            None => map.remove(name),
        };
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600); // owner read/write only
        }
        let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?.as_bytes())
            .map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn writes_reads_and_removes_with_private_permissions() {
            let dir = std::env::temp_dir().join(format!("bt-secrets-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            let path = dir.join("dev-secrets.json");
            write_one(&path, "a", Some("1")).unwrap();
            write_one(&path, "b", Some("2")).unwrap();
            write_one(&path, "a", None).unwrap();
            let m = read(&path);
            assert_eq!(m.get("b").map(String::as_str), Some("2"));
            assert!(!m.contains_key("a"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            }
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

//! App settings, stored as JSON in the app config dir.
//! Every change is broadcast to all windows as `settings://changed`.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
};

pub const CHANGED_EVENT: &str = "settings://changed";

/// Saves a partial update, applies it to the running app, and broadcasts it to every window.
pub fn update_and_emit(app: &tauri::AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
    use tauri::{Emitter, Manager};
    let was_floating = app.state::<SettingsStore>().get().floating_timer;
    let next = app.state::<SettingsStore>().update(patch)?;
    app.state::<crate::audio::Audio>().set_volume(next.volume);
    if let Some(w) = app.get_webview_window(crate::timer::WINDOW) {
        let _ = w.set_always_on_top(next.always_on_top);
    }
    let _ = app.emit(CHANGED_EVENT, &next);
    // Switched where the timer shows while one is up: move it now.
    if next.floating_timer != was_floating && app.state::<crate::timer::Timer>().phase() != crate::engine::Phase::Idle {
        crate::timer::show_timer(app);
    }
    Ok(next)
}

const MIN_DURATION_SECS: u32 = 60;
const MAX_DURATION_SECS: u32 = 180 * 60;
const DEFAULT_SPLIT: f32 = 0.64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    // Appearance
    pub theme: String,
    pub body_font: String,

    // Timer
    /// Last duration used to start a timer, in seconds.
    pub last_duration_secs: u32,
    /// "both" | "shake" | "ring"
    pub alarm_mode: String,
    /// "chime" | "bell8" | "beep"
    pub alarm_sound: String,
    pub ask_rating: bool,
    /// Show the timer in its own floating window. Off: inside Today in the main window.
    pub floating_timer: bool,
    /// Keep the floating timer above other windows.
    pub always_on_top: bool,

    /// Alarm volume, 0–100.
    pub volume: u8,

    // Accounts
    /// "today" | "overdue" (= today + overdue)
    pub todoist_scope: String,
    /// 5 | 15 | 30
    pub sync_interval_min: u32,
    /// Google OAuth "Desktop app" client ID. The secret lives in the keychain.
    pub google_client_id: String,
    /// Calendars to show. `None` = Google's own selection, decided on first sync.
    pub google_calendars: Option<Vec<String>>,
    /// Signed-in Google account, for display.
    pub google_account: String,

    // Layout
    /// Today view: the tasks panel's share of the width, 0.25–0.8.
    pub tasks_split: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "tokyo-night".into(),
            body_font: "JetBrains Mono".into(),
            last_duration_secs: 25 * 60,
            alarm_mode: "both".into(),
            alarm_sound: "chime".into(),
            ask_rating: true,
            floating_timer: true,
            always_on_top: true,
            volume: 60,
            todoist_scope: "overdue".into(),
            sync_interval_min: 15,
            google_client_id: String::new(),
            google_calendars: None,
            google_account: String::new(),
            tasks_split: DEFAULT_SPLIT,
        }
    }
}

fn one_of(v: &mut String, allowed: &[&str]) {
    if !allowed.contains(&v.as_str()) {
        *v = allowed[0].to_string();
    }
}

impl Settings {
    fn normalized(mut self) -> Self {
        self.last_duration_secs = self.last_duration_secs.clamp(MIN_DURATION_SECS, MAX_DURATION_SECS);
        self.volume = self.volume.min(100);
        self.tasks_split = if self.tasks_split.is_finite() { self.tasks_split.clamp(0.25, 0.8) } else { DEFAULT_SPLIT };
        one_of(&mut self.alarm_mode, &["both", "shake", "ring"]);
        one_of(&mut self.alarm_sound, &["chime", "bell8", "beep"]);
        one_of(&mut self.todoist_scope, &["overdue", "today"]);
        if ![5, 15, 30].contains(&self.sync_interval_min) {
            self.sync_interval_min = 15;
        }
        self.google_client_id = self.google_client_id.trim().to_string();
        self
    }

    pub fn alarm_rings(&self) -> bool {
        self.alarm_mode != "shake"
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// Loads `settings.json` from `dir`. A missing or unreadable file gives the defaults.
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("settings.json");
        let current = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default()
            .normalized();
        Self { path, current: Mutex::new(current) }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    /// Merges a partial JSON object into the current settings and saves to disk.
    pub fn update(&self, patch: serde_json::Value) -> Result<Settings, String> {
        let serde_json::Value::Object(patch) = patch else {
            return Err("settings patch must be an object".into());
        };
        let mut guard = self.current.lock().unwrap();
        let mut merged = serde_json::to_value(&*guard).map_err(|e| e.to_string())?;
        if let serde_json::Value::Object(map) = &mut merged {
            for (k, v) in patch {
                map.insert(k, v);
            }
        }
        let next: Settings = serde_json::from_value::<Settings>(merged)
            .map_err(|e| format!("invalid settings: {e}"))?
            .normalized();
        self.save(&next)?;
        *guard = next.clone();
        Ok(next)
    }

    fn save(&self, s: &Settings) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Write then rename, so a crash mid-write can't leave a half-written file.
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("boss-timer-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_gives_defaults() {
        let store = SettingsStore::load(temp_dir("missing"));
        assert_eq!(store.get().theme, "tokyo-night");
        assert_eq!(store.get().last_duration_secs, 1500);
    }

    #[test]
    fn update_merges_saves_and_clamps() {
        let dir = temp_dir("update");
        let store = SettingsStore::load(dir.clone());
        let s = store
            .update(serde_json::json!({ "theme": "gruvbox", "last_duration_secs": 5 }))
            .unwrap();
        assert_eq!(s.theme, "gruvbox");
        assert_eq!(s.body_font, "JetBrains Mono");
        assert_eq!(s.last_duration_secs, 60);

        let reloaded = SettingsStore::load(dir.clone());
        assert_eq!(reloaded.get().theme, "gruvbox");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_non_object_and_bad_types() {
        let store = SettingsStore::load(temp_dir("bad"));
        assert!(store.update(serde_json::json!("nope")).is_err());
        assert!(store.update(serde_json::json!({ "ask_rating": "yes" })).is_err());
        assert!(store.get().ask_rating);
    }
}

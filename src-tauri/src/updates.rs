//! Self-update from GitHub Releases (tauri-plugin-updater). The app fetches `latest.json` from
//! the newest release, and installs the new version only if it's signed with the release key.
//! Release builds only: a dev build would otherwise "update" itself to the published app.

use crate::timer::Timer;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, ready to install.
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Looks for a newer release. `None` means this is the latest version.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if cfg!(debug_assertions) {
        return Err("Updates only work in the installed app.".into());
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| {
        log::warn!("update check: {e}");
        "Couldn't check for updates. Try again later.".to_string()
    })?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() });
    *app.state::<Updates>().pending.lock().unwrap() = update;
    Ok(info)
}

/// Downloads and installs the update found by `check_update`, then restarts the app.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if app.state::<Timer>().phase().is_active() {
        return Err("Finish or stop the timer first: updating restarts the app.".into());
    }
    let update = app.state::<Updates>().pending.lock().unwrap().take().ok_or("Check for updates first.")?;
    log::info!("installing update {}", update.version);
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| {
        log::error!("installing update: {e}");
        format!("The update didn't install: {e}")
    })?;
    app.restart()
}

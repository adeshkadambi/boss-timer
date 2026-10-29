mod audio;
mod db;
mod engine;
#[cfg(debug_assertions)]
mod qc;
mod google;
mod secrets;
mod settings;
mod sync;
mod timer;
mod todoist;
mod tray;
mod updates;

use settings::{Settings, SettingsStore};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Prints `log` records (info and up) to stderr, so warnings show in the terminal running the app.
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            eprintln!("[{} {}] {}", r.level(), r.target(), r.args());
        }
    }
    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

#[tauri::command]
fn get_settings(store: State<'_, SettingsStore>) -> Settings {
    store.get()
}

/// Merges `patch` into the settings, saves, applies and broadcasts the result to every window.
#[tauri::command]
fn update_settings(app: AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
    settings::update_and_emit(&app, patch)
}

/// Uncaught front-end errors, printed to the terminal running the app.
#[tauri::command]
fn log_frontend(message: String) {
    log::warn!(target: "ui", "{message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    tauri::Builder::default()
        // Must be first: a second launch focuses the running app instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| timer::show_main(app)))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Not VISIBLE: the timer window decides for itself when to show.
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let config = app.path().app_config_dir()?;
            let data = app.path().app_data_dir()?;

            secrets::init(config.clone());
            let store = SettingsStore::load(config);
            let volume = store.get().volume;
            app.manage(store);

            let db = Arc::new(db::Db::open(&data.join("sessions.sqlite3"))?);
            app.manage(db.clone());
            app.manage(audio::Audio::start(volume));
            app.manage(todoist::Todoist::new());
            app.manage(google::Google::new());
            app.manage(timer::Timer::new(db));

            if let Err(e) = tray::build(&handle) {
                log::warn!("no tray icon (the app works without one): {e}");
            }
            timer::spawn_ticker(handle.clone());
            app.state::<timer::Timer>().recover(&handle);
            #[cfg(debug_assertions)]
            qc::start(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<timer::Timer>().phase().is_active() {
                    // Keep the timer alive: hide Today; bring it back from the tray or a relaunch.
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            log_frontend,
            timer::get_timer_state,
            timer::start_timer,
            timer::pause,
            timer::resume,
            timer::stop,
            timer::extend,
            timer::submit_rating,
            timer::skip_rating,
            timer::again,
            timer::close_timer,
            sync::sync_today,
            sync::accounts_status,
            sync::todoist_connect,
            sync::todoist_disconnect,
            sync::todoist_complete,
            sync::todoist_reopen,
            sync::google_save_client,
            sync::google_clear_client,
            sync::google_connect,
            sync::google_disconnect,
            sync::google_calendars,
            db::get_report,
            audio::preview_alarm,
            updates::check_update,
            updates::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Boss Timer")
        .run(|_app, _event| {
            // macOS: clicking the Dock icon brings Today back if it was hidden during a timer.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                timer::show_main(_app);
            }
        });
}

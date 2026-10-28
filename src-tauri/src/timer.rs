//! The timer at runtime: wraps the engine with the session log, audio, the floating window and
//! the tray. The UI only displays `timer://tick` and `timer://phase` and sends commands.

use crate::{
    audio::Audio,
    db::Db,
    engine::{Engine, Phase, TaskRef, TickOutcome, TimerView},
    settings::{self, SettingsStore},
    tray,
};
use chrono::Local;
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const TICK_EVENT: &str = "timer://tick";
pub const PHASE_EVENT: &str = "timer://phase";
pub const WINDOW: &str = "timer";
const TICK: Duration = Duration::from_millis(250);
/// Save progress to the session row this often while running (crash recovery).
const CHECKPOINT_TICKS: u32 = 40;
const EXTEND_SECS: u64 = 5 * 60;
const MIN_SECS: u64 = 60;
const MAX_SECS: u64 = 180 * 60;

pub struct Timer {
    engine: Mutex<Engine>,
    db: Arc<Db>,
}

#[derive(Serialize)]
pub struct StartResult {
    pub started: bool,
    /// Set when another timer is active and the UI should confirm replacing it.
    pub active_title: Option<String>,
}

impl Timer {
    pub fn new(db: Arc<Db>) -> Self {
        Self { engine: Mutex::new(Engine::new(Instant::now(), SystemTime::now())), db }
    }

    pub fn view(&self) -> TimerView {
        self.engine.lock().unwrap().view(Instant::now())
    }

    pub fn phase(&self) -> Phase {
        self.engine.lock().unwrap().phase()
    }

    /// Restores a session left unfinished by a crash or quit, as "Stopped." with the time spent.
    pub fn recover(&self, app: &AppHandle) {
        match self.db.take_unfinished() {
            Ok(Some(s)) => {
                self.engine.lock().unwrap().recover(
                    TaskRef { id: s.task_id, title: s.task_title, project: s.project },
                    s.planned_secs,
                    s.timed_secs,
                    s.id,
                );
                show_window(app);
                broadcast(app, &self.view());
            }
            Ok(None) => {}
            Err(e) => log::error!("recovering session: {e}"),
        }
    }
}

/// Emits the full state and updates the tray menu.
fn broadcast(app: &AppHandle, view: &TimerView) {
    let _ = app.emit(PHASE_EVENT, view);
    tray::update(app, view.phase);
}

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.show();
        return;
    }
    let on_top = app.state::<SettingsStore>().get().always_on_top;
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("timer.html".into()))
        .title("Boss Timer")
        .inner_size(400.0, 140.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(on_top)
        .background_color(tauri::window::Color(22, 22, 30, 255))
        .build();
    if let Err(e) = built {
        log::error!("creating timer window: {e}");
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Time's up or stopped: ring if it ran out, then ask (or auto-log).
fn enter_report(app: &AppHandle, natural: bool) {
    let s = app.state::<SettingsStore>().get();
    if natural && s.alarm_rings() {
        app.state::<Audio>().alarm(&s.alarm_sound);
    }
    let timer = app.state::<Timer>();
    if !s.ask_rating {
        log_session(app, &timer, Some(5));
    }
    show_window(app);
    broadcast(app, &timer.view());
}

fn log_session(app: &AppHandle, timer: &Timer, rating: Option<u8>) {
    let mut e = timer.engine.lock().unwrap();
    let natural = e.ended_naturally();
    let id = e.session_id();
    if let (Some((timed, rating)), Some(id)) = (e.log(rating, Instant::now()), id) {
        if let Err(err) = timer.db.finish_session(id, timed, rating, natural) {
            log::error!("logging session: {err}");
        }
        let _ = app.emit("reports://changed", ());
    }
}

/// Background ticker: 4 times a second while running.
pub fn spawn_ticker(app: AppHandle) {
    thread::Builder::new()
        .name("timer".into())
        .spawn(move || {
            let mut n: u32 = 0;
            loop {
                thread::sleep(TICK);
                let timer = app.state::<Timer>();
                let (outcome, tick, checkpoint) = {
                    let mut e = timer.engine.lock().unwrap();
                    let now = Instant::now();
                    let o = e.tick(now, SystemTime::now());
                    (o, e.tick_payload(now), e.session_id().map(|id| (id, e.timed_secs(now), e.planned_secs())))
                };
                match outcome {
                    TickOutcome::Idle => {}
                    TickOutcome::Running => {
                        let _ = app.emit(TICK_EVENT, tick);
                        n = n.wrapping_add(1);
                        if n % CHECKPOINT_TICKS == 0 {
                            if let Some((id, timed, planned)) = checkpoint {
                                let _ = timer.db.update_timed(id, timed, planned);
                            }
                        }
                    }
                    TickOutcome::Finished => {
                        let _ = app.emit(TICK_EVENT, tick);
                        enter_report(&app, true);
                    }
                }
            }
        })
        .expect("spawn timer thread");
}

// ---- commands ---------------------------------------------------------------------------------

#[tauri::command]
pub fn get_timer_state(timer: State<'_, Timer>) -> TimerView {
    timer.view()
}

/// Starts a timer. If one is active and `replace` is false, nothing changes and the result
/// names it, so the UI can ask before replacing.
#[tauri::command]
pub async fn start_timer(app: AppHandle, task: TaskRef, secs: u64, replace: bool) -> Result<StartResult, String> {
    let secs = secs.clamp(MIN_SECS, MAX_SECS);
    let timer = app.state::<Timer>();
    {
        let mut e = timer.engine.lock().unwrap();
        let now = Instant::now();
        if e.phase().is_active() {
            if !replace {
                return Ok(StartResult { started: false, active_title: e.task().map(|t| t.title.clone()) });
            }
            // The replaced timer is logged as skipped: its time counts as timed, not focused.
            if let Some(id) = e.session_id() {
                let _ = e.stop(now);
                let natural = e.ended_naturally();
                if let Some((timed, _)) = e.log(None, now) {
                    timer.db.finish_session(id, timed, None, natural).map_err(|err| err.to_string())?;
                }
            }
        }
        let id = timer
            .db
            .insert_session(task.id.as_deref(), &task.title, task.project.as_deref(), Local::now(), secs)
            .map_err(|err| err.to_string())?;
        e.start(task, secs, id, now, SystemTime::now());
    }
    let _ = settings::update_and_emit(&app, serde_json::json!({ "last_duration_secs": secs }));
    show_window(&app);
    broadcast(&app, &timer.view());
    Ok(StartResult { started: true, active_title: None })
}

pub fn toggle_pause(app: &AppHandle) {
    let timer = app.state::<Timer>();
    match timer.phase() {
        Phase::Running => pause_inner(app),
        Phase::Paused => resume_inner(app),
        _ => {}
    }
}

fn pause_inner(app: &AppHandle) {
    let timer = app.state::<Timer>();
    let (ok, ck) = {
        let mut e = timer.engine.lock().unwrap();
        let now = Instant::now();
        let ok = e.pause(now);
        (ok, e.session_id().map(|id| (id, e.timed_secs(now), e.planned_secs())))
    };
    if !ok {
        return;
    }
    if let Some((id, timed, planned)) = ck {
        let _ = timer.db.update_timed(id, timed, planned);
    }
    broadcast(app, &timer.view());
}

fn resume_inner(app: &AppHandle) {
    let timer = app.state::<Timer>();
    let ok = timer.engine.lock().unwrap().resume(Instant::now(), SystemTime::now());
    if !ok {
        return;
    }
    broadcast(app, &timer.view());
}

#[tauri::command]
pub fn pause(app: AppHandle) {
    pause_inner(&app);
}

#[tauri::command]
pub fn resume(app: AppHandle) {
    resume_inner(&app);
}

pub fn stop_inner(app: &AppHandle) {
    let ok = app.state::<Timer>().engine.lock().unwrap().stop(Instant::now());
    if ok {
        enter_report(app, false);
    }
}

#[tauri::command]
pub fn stop(app: AppHandle) {
    stop_inner(&app);
}

/// +5 min from the question: continues the same session.
#[tauri::command]
pub fn extend(app: AppHandle, secs: Option<u64>) {
    let timer = app.state::<Timer>();
    let ok = timer.engine.lock().unwrap().extend(
        secs.unwrap_or(EXTEND_SECS).clamp(MIN_SECS, MAX_SECS),
        Instant::now(),
        SystemTime::now(),
    );
    if !ok {
        return;
    }
    broadcast(&app, &timer.view());
}

#[tauri::command]
pub fn submit_rating(app: AppHandle, rating: u8) -> Result<(), String> {
    if !(1..=5).contains(&rating) {
        return Err("rating must be 1–5".into());
    }
    let timer = app.state::<Timer>();
    log_session(&app, &timer, Some(rating));
    broadcast(&app, &timer.view());
    Ok(())
}

#[tauri::command]
pub fn skip_rating(app: AppHandle) {
    let timer = app.state::<Timer>();
    log_session(&app, &timer, None);
    broadcast(&app, &timer.view());
}

/// Same task and duration again, as a new session.
#[tauri::command]
pub async fn again(app: AppHandle) -> Result<StartResult, String> {
    let (task, secs) = {
        let timer = app.state::<Timer>();
        let e = timer.engine.lock().unwrap();
        if e.phase() != Phase::Logged {
            return Err("nothing to repeat".into());
        }
        (e.task().cloned(), e.planned_secs())
    };
    let task = task.ok_or("nothing to repeat")?;
    start_timer(app, task, secs, true).await
}

/// "Back to today": hide the timer and bring up the main window.
#[tauri::command]
pub fn close_timer(app: AppHandle) {
    let timer = app.state::<Timer>();
    {
        let mut e = timer.engine.lock().unwrap();
        if e.phase().is_active() {
            return; // still running or waiting for an answer
        }
        e.close(Instant::now(), SystemTime::now());
    }
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.hide();
    }
    show_main(&app);
    broadcast(&app, &timer.view());
}

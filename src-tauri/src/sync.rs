//! Today's data (Todoist + Google Calendar) and account setup.

use crate::{
    google::{self, AllDay, Event, GError, Google},
    secrets,
    settings::{self, SettingsStore},
    todoist::{ApiError, Task, Todoist},
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
pub struct TodoistPart {
    connected: bool,
    /// The token was rejected: show "Reconnect" in Accounts.
    unauthorized: bool,
    error: Option<String>,
    tasks: Vec<Task>,
}

#[derive(Serialize)]
pub struct GooglePart {
    /// A client ID and secret are saved.
    configured: bool,
    connected: bool,
    needs_reconnect: bool,
    error: Option<String>,
    all_day: Vec<AllDay>,
    events: Vec<Event>,
}

#[derive(Serialize)]
pub struct TodayData {
    todoist: TodoistPart,
    google: GooglePart,
    /// Unix ms.
    synced_at: i64,
}

/// A client saved in Settings overrides the one built into the app.
fn google_client(app: &AppHandle) -> Option<google::Client> {
    let id = app.state::<SettingsStore>().get().google_client_id;
    if !id.is_empty() {
        if let Some(secret) = secrets::get(secrets::GOOGLE_SECRET) {
            return Some(google::Client { id, secret });
        }
    }
    google::Client::builtin()
}

async fn todoist_part(app: &AppHandle) -> TodoistPart {
    let Some(token) = secrets::get(secrets::TODOIST_TOKEN) else {
        return TodoistPart { connected: false, unauthorized: false, error: None, tasks: vec![] };
    };
    let scope = app.state::<SettingsStore>().get().todoist_scope;
    match app.state::<Todoist>().tasks(&token, &scope).await {
        Ok(tasks) => TodoistPart { connected: true, unauthorized: false, error: None, tasks },
        Err(e) => TodoistPart {
            connected: true,
            unauthorized: matches!(e, ApiError::Unauthorized),
            error: Some(e.message()),
            tasks: vec![],
        },
    }
}

/// Calendars to show: the saved choice, or Google's own selection on first sync (then saved).
async fn selected_calendars(app: &AppHandle, client: &google::Client) -> Result<Vec<String>, GError> {
    if let Some(ids) = app.state::<SettingsStore>().get().google_calendars {
        return Ok(ids);
    }
    let cals = app.state::<Google>().calendars(client).await?;
    let ids: Vec<String> = cals.into_iter().filter(|c| c.selected).map(|c| c.id).collect();
    let _ = settings::update_and_emit(app, serde_json::json!({ "google_calendars": ids }));
    Ok(ids)
}

async fn google_part(app: &AppHandle) -> GooglePart {
    let g = app.state::<Google>();
    let mut part = GooglePart {
        configured: false,
        connected: g.is_connected(),
        needs_reconnect: false,
        error: None,
        all_day: vec![],
        events: vec![],
    };
    let Some(client) = google_client(app) else { return part };
    part.configured = true;
    if !part.connected {
        return part;
    }
    let result = async {
        let ids = selected_calendars(app, &client).await?;
        g.today(&client, &ids).await
    }
    .await;
    match result {
        Ok((events, all_day)) => {
            part.events = events;
            part.all_day = all_day;
        }
        Err(e) => {
            part.needs_reconnect = matches!(e, GError::Reconnect) || g.needs_reconnect();
            part.error = Some(e.message());
        }
    }
    part
}

#[tauri::command]
pub async fn sync_today(app: AppHandle) -> TodayData {
    let (todoist, google) = tokio::join!(todoist_part(&app), google_part(&app));
    TodayData { todoist, google, synced_at: chrono::Utc::now().timestamp_millis() }
}

// ---- accounts ---------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct AccountsStatus {
    todoist_connected: bool,
    /// A Google client was built into the app.
    google_builtin: bool,
    google_configured: bool,
    google_connected: bool,
    google_needs_reconnect: bool,
    google_account: String,
    google_client_id: String,
}

#[tauri::command]
pub fn accounts_status(app: AppHandle) -> AccountsStatus {
    let s = app.state::<SettingsStore>().get();
    let g = app.state::<Google>();
    AccountsStatus {
        todoist_connected: secrets::get(secrets::TODOIST_TOKEN).is_some(),
        google_builtin: google::Client::builtin().is_some(),
        google_configured: google_client(&app).is_some(),
        google_connected: g.is_connected(),
        google_needs_reconnect: g.needs_reconnect(),
        google_account: s.google_account,
        google_client_id: s.google_client_id,
    }
}

#[tauri::command]
pub async fn todoist_connect(app: AppHandle, token: String) -> Result<(), String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Paste your Todoist API token first.".into());
    }
    app.state::<Todoist>().validate(&token).await.map_err(|e| {
        log::warn!("todoist: token check failed: {e:?}");
        match e {
            ApiError::Unauthorized => "Todoist didn't accept that token. Copy it again from Todoist Settings → Integrations → Developer.".into(),
            other => other.message(),
        }
    })?;
    secrets::set(secrets::TODOIST_TOKEN, &token)?;
    log::info!("todoist: connected");
    Ok(())
}

#[tauri::command]
pub fn todoist_disconnect() {
    secrets::delete(secrets::TODOIST_TOKEN);
}

fn todoist_token() -> Result<String, String> {
    secrets::get(secrets::TODOIST_TOKEN).ok_or_else(|| "Todoist isn't connected.".into())
}

#[tauri::command]
pub async fn todoist_complete(todoist: State<'_, Todoist>, id: String) -> Result<(), String> {
    todoist.close(&todoist_token()?, &id).await.map_err(|e| e.message())
}

#[tauri::command]
pub async fn todoist_reopen(todoist: State<'_, Todoist>, id: String) -> Result<(), String> {
    todoist.reopen(&todoist_token()?, &id).await.map_err(|e| e.message())
}

/// Saves a client that overrides the built-in one. A sign-in belongs to the client it was made
/// with, so switching clients signs out of Google.
#[tauri::command]
pub async fn google_save_client(app: AppHandle, client_id: String, client_secret: String) -> Result<(), String> {
    let id = client_id.trim();
    if !id.ends_with(".apps.googleusercontent.com") {
        return Err("That doesn't look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).".into());
    }
    let secret = client_secret.trim();
    if secret.is_empty() && secrets::get(secrets::GOOGLE_SECRET).is_none() {
        return Err("Paste the client secret too.".into());
    }
    let switching = google_client(&app).is_some_and(|c| c.id != id);
    if switching {
        app.state::<Google>().disconnect().await;
    }
    if !secret.is_empty() {
        secrets::set(secrets::GOOGLE_SECRET, secret)?;
    }
    let mut patch = serde_json::json!({ "google_client_id": id });
    if switching {
        patch["google_account"] = "".into();
        patch["google_calendars"] = serde_json::Value::Null;
    }
    settings::update_and_emit(&app, patch).map(|_| ())
}

/// Drops the client saved in Settings, going back to the built-in one. Signs out of Google,
/// since a sign-in belongs to the client it was made with.
#[tauri::command]
pub async fn google_clear_client(app: AppHandle) -> Result<(), String> {
    app.state::<Google>().disconnect().await;
    secrets::delete(secrets::GOOGLE_SECRET);
    settings::update_and_emit(
        &app,
        serde_json::json!({ "google_client_id": "", "google_account": "", "google_calendars": null }),
    )
    .map(|_| ())
}

#[tauri::command]
pub async fn google_connect(app: AppHandle) -> Result<String, String> {
    let client = google_client(&app).ok_or_else(|| GError::NotConfigured.message())?;
    let opener = app.clone();
    let account = app
        .state::<Google>()
        .connect(&client, move |url| opener.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.message())?;
    settings::update_and_emit(&app, serde_json::json!({ "google_account": account, "google_calendars": null }))?;
    Ok(account)
}

#[tauri::command]
pub async fn google_disconnect(app: AppHandle) -> Result<(), String> {
    app.state::<Google>().disconnect().await;
    settings::update_and_emit(&app, serde_json::json!({ "google_account": "", "google_calendars": null })).map(|_| ())
}

#[derive(Serialize)]
pub struct CalendarChoice {
    id: String,
    name: String,
    primary: bool,
    checked: bool,
}

#[tauri::command]
pub async fn google_calendars(app: AppHandle) -> Result<Vec<CalendarChoice>, String> {
    let client = google_client(&app).ok_or_else(|| GError::NotConfigured.message())?;
    let cals = app.state::<Google>().calendars(&client).await.map_err(|e| e.message())?;
    let saved = app.state::<SettingsStore>().get().google_calendars;
    Ok(cals
        .into_iter()
        .map(|c| CalendarChoice {
            checked: saved.as_ref().map_or(c.selected, |ids| ids.contains(&c.id)),
            id: c.id,
            name: c.name,
            primary: c.primary,
        })
        .collect())
}

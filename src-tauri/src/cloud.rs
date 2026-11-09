//! Cloud sync of the session log through Supabase, so Reports match across computers.
//!
//! Sign-in is Supabase Auth with Google (authorization code + PKCE, loopback redirect). Sessions
//! go through PostgREST into one table guarded by row-level security, so the publishable key built into
//! the app (public by design) can only ever reach the signed-in user's own rows.
//!
//! Sync is push-then-pull. Rows are identified by a UUID, merged by id, and only finished
//! sessions are uploaded. The pull cursor is the server's `updated_at` plus id, so clocks don't matter.

use crate::{
    db::{Db, SyncRow},
    google::{self, GError},
    secrets,
    settings::{self, SettingsStore},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::{net::TcpListener, sync::Notify};

/// The sign-in redirect. Fixed so it can be listed in Supabase's redirect allow-list.
const PORT: u16 = 53682;
const PAGE: usize = 500;
/// How far before the saved cursor each pull starts. See `Cloud::pull`.
const OVERLAP_SECS: i64 = 120;
const EVERY: Duration = Duration::from_secs(5 * 60);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

pub struct Config {
    url: String,
    key: String,
}

impl Config {
    /// The project baked in at build time (see build.rs), if any.
    fn builtin() -> Option<Self> {
        match (option_env!("BT_SUPABASE_URL"), option_env!("BT_SUPABASE_KEY")) {
            (Some(url), Some(key)) if !url.is_empty() && !key.is_empty() => {
                Some(Self { url: url.trim_end_matches('/').into(), key: key.into() })
            }
            _ => None,
        }
    }

    /// A project saved in Settings overrides the built-in one.
    fn current(app: &AppHandle) -> Option<Self> {
        let s = app.state::<SettingsStore>().get();
        if !s.supabase_url.is_empty() && !s.supabase_key.is_empty() {
            return Some(Self { url: s.supabase_url, key: s.supabase_key });
        }
        Self::builtin()
    }
}

#[derive(Debug)]
enum CloudError {
    /// Signed out, or Supabase ended the session.
    Reconnect,
    Network(String),
    Other(String),
}

impl CloudError {
    fn message(&self) -> String {
        match self {
            CloudError::Reconnect => "Sign in to cloud sync again.".into(),
            CloudError::Network(e) => {
                log::warn!("cloud: {e}");
                "Couldn't reach Supabase. Will retry.".into()
            }
            CloudError::Other(m) => m.clone(),
        }
    }
}

impl From<GError> for CloudError {
    fn from(e: GError) -> Self {
        CloudError::Other(e.message())
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    user: Option<User>,
}

#[derive(Deserialize)]
struct User {
    email: Option<String>,
}

#[derive(Deserialize)]
struct Remote {
    #[serde(flatten)]
    row: SyncRow,
    updated_at: String,
}

#[derive(Default)]
struct Status {
    last_sync: Option<i64>,
    error: Option<String>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Summary {
    pushed: usize,
    pulled: usize,
}

pub struct Cloud {
    http: reqwest::Client,
    access: Mutex<Option<(String, Instant)>>,
    /// Held while refreshing, so two requests don't both spend (and rotate) the refresh token.
    refresh: tokio::sync::Mutex<()>,
    /// Held for the length of a sync, so they never overlap.
    running: tokio::sync::Mutex<()>,
    syncing: AtomicBool,
    needs_reconnect: AtomicBool,
    nudge: Notify,
    status: Mutex<Status>,
}

impl Cloud {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("http client"),
            access: Mutex::new(None),
            refresh: tokio::sync::Mutex::new(()),
            running: tokio::sync::Mutex::new(()),
            syncing: AtomicBool::new(false),
            needs_reconnect: AtomicBool::new(false),
            nudge: Notify::new(),
            status: Mutex::new(Status::default()),
        }
    }

    fn is_connected(&self) -> bool {
        secrets::get(secrets::SUPABASE_REFRESH).is_some()
    }

    fn remember(&self, tok: &TokenResponse) -> Result<(), CloudError> {
        secrets::set(secrets::SUPABASE_REFRESH, &tok.refresh_token).map_err(CloudError::Other)?;
        *self.access.lock().unwrap() =
            Some((tok.access_token.clone(), Instant::now() + Duration::from_secs(tok.expires_in.saturating_sub(60))));
        self.needs_reconnect.store(false, Ordering::Relaxed);
        Ok(())
    }

    async fn token_request(&self, cfg: &Config, grant: &str, body: serde_json::Value) -> Result<TokenResponse, CloudError> {
        let res = self
            .http
            .post(format!("{}/auth/v1/token", cfg.url))
            .query(&[("grant_type", grant)])
            .header("apikey", &cfg.key)
            .json(&body)
            .send()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            // A dead or reused refresh token is a 400/401: sign in again.
            if grant == "refresh_token" && matches!(status.as_u16(), 400 | 401 | 403) {
                self.needs_reconnect.store(true, Ordering::Relaxed);
                return Err(CloudError::Reconnect);
            }
            return Err(CloudError::Other(format!("Sign-in failed ({status}): {}", text.chars().take(200).collect::<String>())));
        }
        res.json().await.map_err(|e| CloudError::Other(e.to_string()))
    }

    /// Browser sign-in. Returns the account's email.
    async fn sign_in(&self, cfg: &Config, open: impl FnOnce(&str) -> Result<(), String>) -> Result<String, CloudError> {
        let listener = TcpListener::bind(("127.0.0.1", PORT))
            .await
            .map_err(|e| CloudError::Other(format!("Couldn't listen on port {PORT} for the sign-in ({e}). Close whatever uses it and try again.")))?;
        let redirect = format!("http://127.0.0.1:{PORT}");
        let verifier = google::random_b64(48);

        let mut url = url::Url::parse(&format!("{}/auth/v1/authorize", cfg.url)).map_err(|e| CloudError::Other(e.to_string()))?;
        url.query_pairs_mut()
            .append_pair("provider", "google")
            .append_pair("redirect_to", &redirect)
            .append_pair("code_challenge", &google::pkce_challenge(&verifier))
            .append_pair("code_challenge_method", "s256");
        open(url.as_str()).map_err(CloudError::Other)?;

        let code = tokio::time::timeout(LOGIN_TIMEOUT, google::wait_for_code(&listener, None, "cloud sync"))
            .await
            .map_err(|_| CloudError::Other("Sign-in timed out. Try again.".into()))??;
        drop(listener);

        let tok = self.token_request(cfg, "pkce", serde_json::json!({ "auth_code": code, "code_verifier": verifier })).await?;
        self.remember(&tok)?;
        Ok(tok.user.and_then(|u| u.email).unwrap_or_default())
    }

    async fn sign_out(&self, cfg: Option<&Config>) {
        if let (Some(cfg), Some(_)) = (cfg, secrets::get(secrets::SUPABASE_REFRESH)) {
            if let Ok(tok) = self.access_token(cfg).await {
                let _ = self
                    .http
                    .post(format!("{}/auth/v1/logout", cfg.url))
                    .query(&[("scope", "local")])
                    .header("apikey", &cfg.key)
                    .bearer_auth(tok)
                    .send()
                    .await;
            }
        }
        secrets::delete(secrets::SUPABASE_REFRESH);
        *self.access.lock().unwrap() = None;
        self.needs_reconnect.store(false, Ordering::Relaxed);
    }

    async fn access_token(&self, cfg: &Config) -> Result<String, CloudError> {
        let fresh = || self.access.lock().unwrap().clone().filter(|(_, exp)| Instant::now() < *exp).map(|(t, _)| t);
        if let Some(t) = fresh() {
            return Ok(t);
        }
        let _guard = self.refresh.lock().await;
        if let Some(t) = fresh() {
            return Ok(t); // another request refreshed while we waited
        }
        let refresh = secrets::get(secrets::SUPABASE_REFRESH).ok_or(CloudError::Reconnect)?;
        let tok = self.token_request(cfg, "refresh_token", serde_json::json!({ "refresh_token": refresh })).await?;
        self.remember(&tok)?;
        Ok(tok.access_token)
    }

    fn rest(&self, cfg: &Config, method: reqwest::Method, token: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}/rest/v1/sessions", cfg.url))
            .header("apikey", &cfg.key)
            .bearer_auth(token)
    }

    async fn check(res: reqwest::Response) -> Result<reqwest::Response, CloudError> {
        let status = res.status();
        if status.is_success() {
            return Ok(res);
        }
        let body = res.text().await.unwrap_or_default();
        if status.as_u16() == 401 {
            return Err(CloudError::Reconnect);
        }
        let hint = if body.contains("PGRST205") || body.contains("does not exist") {
            " The sessions table is missing: run supabase/schema.sql in your Supabase project."
        } else {
            ""
        };
        Err(CloudError::Other(format!("Supabase {status}: {}{hint}", body.chars().take(200).collect::<String>())))
    }

    async fn push(&self, cfg: &Config, db: &Db) -> Result<usize, CloudError> {
        let mut total = 0;
        loop {
            let rows = db.dirty_rows(PAGE).map_err(|e| CloudError::Other(e.to_string()))?;
            if rows.is_empty() {
                return Ok(total);
            }
            let token = self.access_token(cfg).await?;
            let res = self
                .rest(cfg, reqwest::Method::POST, &token)
                .query(&[("on_conflict", "id")])
                .header("Prefer", "resolution=merge-duplicates,return=minimal")
                .json(&rows)
                .send()
                .await
                .map_err(|e| CloudError::Network(e.to_string()))?;
            Self::check(res).await?;
            let ids: Vec<String> = rows.into_iter().map(|r| r.id).collect();
            db.mark_clean(&ids).map_err(|e| CloudError::Other(e.to_string()))?;
            total += ids.len();
        }
    }

    /// Returns how many rows changed on this computer.
    ///
    /// Each pass starts a little before the saved cursor. A row committed late can carry an
    /// `updated_at` older than rows already pulled (its transaction began earlier), and without
    /// the overlap it would be skipped for good. Re-reading rows is harmless: merging them
    /// again changes nothing.
    async fn pull(&self, cfg: &Config, db: &Db) -> Result<usize, CloudError> {
        let saved = db.meta_get("pull_cursor");
        let saved = saved.as_deref().and_then(|c| c.split_once('|'));
        let from = saved.map(|(ts, _)| overlap_start(ts));
        // Where this pass has got to; paging within a pass uses (updated_at, id) so ties can't be skipped.
        let mut after: Option<(String, String)> = None;
        let mut changed = 0;
        loop {
            let token = self.access_token(cfg).await?;
            let limit = PAGE.to_string();
            let mut req = self
                .rest(cfg, reqwest::Method::GET, &token)
                .query(&[("select", "*"), ("order", "updated_at.asc,id.asc"), ("limit", limit.as_str())]);
            if let Some((ts, id)) = &after {
                req = req.query(&[("or", format!("(updated_at.gt.{ts},and(updated_at.eq.{ts},id.gt.{id}))"))]);
            } else if let Some(from) = &from {
                req = req.query(&[("updated_at", format!("gte.{from}"))]);
            }
            let res = req.send().await.map_err(|e| CloudError::Network(e.to_string()))?;
            let page: Vec<Remote> = Self::check(res).await?.json().await.map_err(|e| CloudError::Other(e.to_string()))?;
            let Some(last) = page.last() else { return Ok(changed) };
            let cursor = (last.updated_at.clone(), last.row.id.clone());
            let full = page.len() >= PAGE;
            let rows: Vec<SyncRow> = page.into_iter().map(|r| r.row).collect();
            changed += db.apply_remote(&rows).map_err(|e| CloudError::Other(e.to_string()))?;
            // Never move the saved cursor backwards (the overlap re-reads older rows).
            let newest = match saved {
                Some((ts, id)) if (ts, id) > (cursor.0.as_str(), cursor.1.as_str()) => format!("{ts}|{id}"),
                _ => format!("{}|{}", cursor.0, cursor.1),
            };
            db.meta_set("pull_cursor", Some(&newest)).map_err(|e| CloudError::Other(e.to_string()))?;
            after = Some(cursor);
            if !full {
                return Ok(changed);
            }
        }
    }
}

/// `ts` minus the overlap, in the `+00:00` form PostgREST filters accept.
/// Falls back to `ts` itself if it can't be parsed.
fn overlap_start(ts: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|t| (t - chrono::Duration::seconds(OVERLAP_SECS)).with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Micros, false))
        .unwrap_or_else(|_| ts.to_string())
}

/// Uploads what's new here, downloads what's new elsewhere. A no-op while another sync runs.
async fn sync(app: &AppHandle) -> Result<Summary, CloudError> {
    let cloud = app.state::<Cloud>();
    let cfg = Config::current(app).ok_or_else(|| CloudError::Other("Cloud sync isn't set up.".into()))?;
    if !cloud.is_connected() {
        return Err(CloudError::Reconnect);
    }
    let Ok(_run) = cloud.running.try_lock() else { return Ok(Summary::default()) };
    cloud.syncing.store(true, Ordering::Relaxed);
    let db: Arc<Db> = app.state::<Arc<Db>>().inner().clone();
    let result = async {
        let pushed = cloud.push(&cfg, &db).await?;
        let pulled = cloud.pull(&cfg, &db).await?;
        Ok::<Summary, CloudError>(Summary { pushed, pulled })
    }
    .await;
    cloud.syncing.store(false, Ordering::Relaxed);
    {
        let mut st = cloud.status.lock().unwrap();
        match &result {
            Ok(_) => {
                st.last_sync = Some(chrono::Utc::now().timestamp_millis());
                st.error = None;
            }
            Err(e) => st.error = Some(e.message()),
        }
    }
    if let Ok(s) = &result {
        if s.pulled > 0 {
            let _ = app.emit("reports://changed", ());
        }
    }
    result
}

/// Ask the background loop to sync soon (something was logged). Cheap; does nothing if signed out.
pub fn nudge(app: &AppHandle) {
    app.state::<Cloud>().nudge.notify_one();
}

/// Syncs shortly after launch, soon after anything is logged, and every few minutes.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            let cloud = app.state::<Cloud>();
            if cloud.is_connected() && !cloud.needs_reconnect.load(Ordering::Relaxed) {
                if let Err(e) = sync(&app).await {
                    log::info!("cloud sync: {}", e.message());
                }
            }
            tokio::select! {
                _ = cloud.nudge.notified() => tokio::time::sleep(Duration::from_secs(2)).await,
                _ = tokio::time::sleep(EVERY) => {}
            }
        }
    });
}

// ---- commands ---------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CloudStatus {
    /// A Supabase project is built in or saved.
    configured: bool,
    builtin: bool,
    connected: bool,
    needs_reconnect: bool,
    account: String,
    syncing: bool,
    /// Unix ms.
    last_sync: Option<i64>,
    error: Option<String>,
    /// Sessions not uploaded yet.
    pending: i64,
    supabase_url: String,
}

#[tauri::command]
pub fn cloud_status(app: AppHandle, cloud: State<'_, Cloud>, db: State<'_, Arc<Db>>) -> CloudStatus {
    let s = app.state::<SettingsStore>().get();
    let st = cloud.status.lock().unwrap();
    CloudStatus {
        configured: Config::current(&app).is_some(),
        builtin: Config::builtin().is_some(),
        connected: cloud.is_connected(),
        needs_reconnect: cloud.needs_reconnect.load(Ordering::Relaxed),
        account: s.cloud_account,
        syncing: cloud.syncing.load(Ordering::Relaxed),
        last_sync: st.last_sync,
        error: st.error.clone(),
        pending: db.pending_count(),
        supabase_url: s.supabase_url,
    }
}

/// A secret (`sb_secret_…`) key, or a legacy JWT key with the `service_role` role. Both bypass
/// row-level security, so the app must never hold one.
fn is_secret_key(key: &str) -> bool {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    if key.starts_with("sb_secret_") {
        return true;
    }
    key.split('.')
        .nth(1)
        .and_then(|p| URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v.get("role").and_then(|r| r.as_str()) == Some("service_role"))
}

/// Saves the project to use instead of the built-in one. Accounts belong to a project, so this signs out.
#[tauri::command]
pub async fn cloud_save_config(app: AppHandle, url: String, key: String) -> Result<(), String> {
    let url = url.trim().trim_end_matches('/').to_string();
    let key = key.trim().to_string();
    let parsed = url::Url::parse(&url).map_err(|_| "That isn't a URL. Use the Project URL from Supabase → Project Settings → API.".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("The project URL should look like https://abcd1234.supabase.co".into());
    }
    if key.len() < 20 || key.contains(char::is_whitespace) {
        return Err("Paste the project's publishable key (starts with sb_publishable_).".into());
    }
    if is_secret_key(&key) {
        return Err("That's a secret key, which must never go in an app. Use the publishable key instead.".into());
    }
    disconnect_inner(&app).await;
    settings::update_and_emit(&app, serde_json::json!({ "supabase_url": url, "supabase_key": key })).map(|_| ())
}

#[tauri::command]
pub async fn cloud_clear_config(app: AppHandle) -> Result<(), String> {
    disconnect_inner(&app).await;
    settings::update_and_emit(&app, serde_json::json!({ "supabase_url": "", "supabase_key": "" })).map(|_| ())
}

async fn disconnect_inner(app: &AppHandle) {
    let cfg = Config::current(app);
    app.state::<Cloud>().sign_out(cfg.as_ref()).await;
    let _ = settings::update_and_emit(app, serde_json::json!({ "cloud_account": "" }));
    app.state::<Cloud>().status.lock().unwrap().error = None;
}

/// Signs in, then uploads this computer's whole history and downloads everyone else's.
#[tauri::command]
pub async fn cloud_connect(app: AppHandle) -> Result<String, String> {
    let cfg = Config::current(&app).ok_or("Add your Supabase project first.")?;
    let opener = app.clone();
    let email = app
        .state::<Cloud>()
        .sign_in(&cfg, move |url| opener.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.message())?;
    settings::update_and_emit(&app, serde_json::json!({ "cloud_account": email }))?;
    // A new sign-in re-sends everything; the cloud merges by session id, so repeats are harmless.
    app.state::<Arc<Db>>().reset_sync().map_err(|e| e.to_string())?;
    sync(&app).await.map_err(|e| e.message())?;
    Ok(email)
}

#[tauri::command]
pub async fn cloud_disconnect(app: AppHandle) {
    disconnect_inner(&app).await;
}

#[tauri::command]
pub async fn cloud_sync_now(app: AppHandle) -> Result<Summary, String> {
    sync(&app).await.map_err(|e| e.message())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_secret_keys_but_accepts_publishable_and_anon() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let jwt = |role: &str| format!("h.{}.s", URL_SAFE_NO_PAD.encode(format!(r#"{{"role":"{role}"}}"#)));
        assert!(is_secret_key("sb_secret_abcdefghijklmnop"));
        assert!(is_secret_key(&jwt("service_role")));
        assert!(!is_secret_key(&jwt("anon")));
        assert!(!is_secret_key("sb_publishable_abcdefghijklmnop"));
    }

    #[test]
    fn overlap_starts_two_minutes_early_in_postgrest_form() {
        assert_eq!(overlap_start("2026-11-09T12:00:30.250000+00:00"), "2026-11-09T11:58:30.250000+00:00");
        assert_eq!(overlap_start("not a time"), "not a time");
    }
}

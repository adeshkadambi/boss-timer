//! Google Calendar, read-only.
//!
//! OAuth 2.0 for desktop apps: authorization code + PKCE with a loopback redirect to a one-shot
//! listener on 127.0.0.1. The refresh token and client secret live in the keychain.

use crate::secrets;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Local, NaiveDate, NaiveTime, TimeZone};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API: &str = "https://www.googleapis.com/calendar/v3";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub enum GError {
    /// Not set up, or the refresh token was revoked/expired (`invalid_grant`).
    Reconnect,
    NotConfigured,
    Network(String),
    Other(String),
}

impl GError {
    pub fn message(&self) -> String {
        match self {
            GError::Reconnect => "Google needs you to sign in again.".into(),
            GError::NotConfigured => "Add your Google client ID in Accounts.".into(),
            GError::Network(e) => {
                log::warn!("google: {e}");
                "Couldn't reach Google. Showing the last synced events.".into()
            }
            GError::Other(m) => format!("Google error: {m}"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Calendar {
    pub id: String,
    pub name: String,
    pub primary: bool,
    /// Google's own "show in list" flag; used as the default selection.
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Event {
    pub title: String,
    /// Minutes since local midnight, clamped to the day.
    pub start: i32,
    pub end: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AllDay {
    pub title: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
}

#[derive(Deserialize)]
struct CalList {
    #[serde(default)]
    items: Vec<CalItem>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalItem {
    id: String,
    summary: Option<String>,
    summary_override: Option<String>,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    selected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventList {
    #[serde(default)]
    items: Vec<ApiEvent>,
    next_page_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiEvent {
    summary: Option<String>,
    status: Option<String>,
    event_type: Option<String>,
    i_cal_u_i_d: Option<String>,
    start: Option<When>,
    end: Option<When>,
    #[serde(default)]
    attendees: Vec<Attendee>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct When {
    date: Option<String>,
    date_time: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attendee {
    #[serde(default, rename = "self")]
    is_self: bool,
    response_status: Option<String>,
}

pub struct Google {
    http: reqwest::Client,
    access: Mutex<Option<(String, Instant)>>,
    needs_reconnect: AtomicBool,
}

pub struct Client {
    pub id: String,
    pub secret: String,
}

impl Client {
    /// The client baked in at build time (see build.rs), if any.
    pub fn builtin() -> Option<Self> {
        match (option_env!("BT_GOOGLE_CLIENT_ID"), option_env!("BT_GOOGLE_CLIENT_SECRET")) {
            (Some(id), Some(secret)) if !id.is_empty() => Some(Self { id: id.into(), secret: secret.into() }),
            _ => None,
        }
    }
}

fn random_b64(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl Google {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder().timeout(Duration::from_secs(20)).build().expect("http client"),
            access: Mutex::new(None),
            needs_reconnect: AtomicBool::new(false),
        }
    }

    pub fn needs_reconnect(&self) -> bool {
        self.needs_reconnect.load(Ordering::Relaxed)
    }

    pub fn is_connected(&self) -> bool {
        secrets::get(secrets::GOOGLE_REFRESH).is_some()
    }

    /// Runs the browser sign-in. `open` opens a URL in the user's browser.
    /// Returns the signed-in account (the primary calendar's id, which is the email address).
    pub async fn connect(&self, client: &Client, open: impl FnOnce(&str) -> Result<(), String>) -> Result<String, GError> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| GError::Other(e.to_string()))?;
        let port = listener.local_addr().map_err(|e| GError::Other(e.to_string()))?.port();
        let redirect = format!("http://127.0.0.1:{port}");
        let verifier = random_b64(48);
        let state = random_b64(16);

        let mut url = url::Url::parse(AUTH_URL).unwrap();
        url.query_pairs_mut()
            .append_pair("client_id", &client.id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", SCOPE)
            .append_pair("code_challenge", &pkce_challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        open(url.as_str()).map_err(GError::Other)?;

        let code = tokio::time::timeout(LOGIN_TIMEOUT, wait_for_code(&listener, &state))
            .await
            .map_err(|_| GError::Other("Sign-in timed out. Try again.".into()))??;

        let res = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("code", code.as_str()),
                ("client_id", &client.id),
                ("client_secret", &client.secret),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|e| GError::Network(e.to_string()))?;
        if !res.status().is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(GError::Other(format!("token exchange failed: {}", body.chars().take(200).collect::<String>())));
        }
        let tok: TokenResponse = res.json().await.map_err(|e| GError::Other(e.to_string()))?;
        let refresh = tok
            .refresh_token
            .ok_or_else(|| GError::Other("Google didn't return a refresh token. Remove the app's access in your Google account and try again.".into()))?;
        secrets::set(secrets::GOOGLE_REFRESH, &refresh).map_err(GError::Other)?;
        *self.access.lock().unwrap() = Some((tok.access_token, Instant::now() + Duration::from_secs(tok.expires_in.saturating_sub(60))));
        self.needs_reconnect.store(false, Ordering::Relaxed);

        let cals = self.calendars(client).await?;
        Ok(cals.iter().find(|c| c.primary).map(|c| c.id.clone()).unwrap_or_default())
    }

    pub async fn disconnect(&self) {
        if let Some(t) = secrets::get(secrets::GOOGLE_REFRESH) {
            let _ = self.http.post(REVOKE_URL).form(&[("token", t.as_str())]).send().await;
        }
        secrets::delete(secrets::GOOGLE_REFRESH);
        *self.access.lock().unwrap() = None;
        self.needs_reconnect.store(false, Ordering::Relaxed);
    }

    async fn access_token(&self, client: &Client) -> Result<String, GError> {
        if let Some((tok, exp)) = self.access.lock().unwrap().clone() {
            if Instant::now() < exp {
                return Ok(tok);
            }
        }
        let refresh = secrets::get(secrets::GOOGLE_REFRESH).ok_or(GError::Reconnect)?;
        let res = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("client_id", client.id.as_str()),
                ("client_secret", &client.secret),
                ("refresh_token", &refresh),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|e| GError::Network(e.to_string()))?;
        if !res.status().is_success() {
            let body = res.text().await.unwrap_or_default();
            // Testing-mode consent screens expire refresh tokens after 7 days.
            if serde_json::from_str::<TokenError>(&body).is_ok_and(|e| e.error == "invalid_grant") {
                self.needs_reconnect.store(true, Ordering::Relaxed);
                return Err(GError::Reconnect);
            }
            return Err(GError::Other(format!("token refresh failed: {}", body.chars().take(200).collect::<String>())));
        }
        let tok: TokenResponse = res.json().await.map_err(|e| GError::Other(e.to_string()))?;
        *self.access.lock().unwrap() =
            Some((tok.access_token.clone(), Instant::now() + Duration::from_secs(tok.expires_in.saturating_sub(60))));
        self.needs_reconnect.store(false, Ordering::Relaxed);
        Ok(tok.access_token)
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, client: &Client, url: url::Url) -> Result<T, GError> {
        let token = self.access_token(client).await?;
        let res = self.http.get(url).bearer_auth(token).send().await.map_err(|e| GError::Network(e.to_string()))?;
        if res.status().as_u16() == 401 {
            *self.access.lock().unwrap() = None;
            return Err(GError::Reconnect);
        }
        if !res.status().is_success() {
            let s = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(GError::Other(format!("{s} {}", body.chars().take(200).collect::<String>())));
        }
        res.json().await.map_err(|e| GError::Other(e.to_string()))
    }

    pub async fn calendars(&self, client: &Client) -> Result<Vec<Calendar>, GError> {
        let url = url::Url::parse(&format!("{API}/users/me/calendarList")).unwrap();
        let list: CalList = self.get(client, url).await?;
        Ok(list
            .items
            .into_iter()
            .map(|c| Calendar {
                name: c.summary_override.or(c.summary).unwrap_or_else(|| c.id.clone()),
                id: c.id,
                primary: c.primary,
                selected: c.selected || c.primary,
            })
            .collect())
    }

    /// Today's events across `calendar_ids`, merged. Timed events and all-day events separately.
    pub async fn today(&self, client: &Client, calendar_ids: &[String]) -> Result<(Vec<Event>, Vec<AllDay>), GError> {
        let today = Local::now().date_naive();
        let day_start = local_midnight(today);
        let day_end = local_midnight(today.succ_opt().unwrap());
        let mut events = vec![];
        let mut all_day = vec![];
        let mut seen = HashSet::new();

        for id in calendar_ids {
            let mut page: Option<String> = None;
            loop {
                let mut url = url::Url::parse(API).unwrap();
                url.path_segments_mut().unwrap().extend(["calendars", id, "events"]);
                url.query_pairs_mut()
                    .append_pair("timeMin", &day_start.to_rfc3339())
                    .append_pair("timeMax", &day_end.to_rfc3339())
                    .append_pair("singleEvents", "true")
                    .append_pair("orderBy", "startTime")
                    .append_pair("maxResults", "250");
                if let Some(p) = &page {
                    url.query_pairs_mut().append_pair("pageToken", p);
                }
                let list: EventList = self.get(client, url).await?;
                for e in list.items {
                    convert(e, day_start, &mut seen, &mut events, &mut all_day);
                }
                match list.next_page_token {
                    Some(p) => page = Some(p),
                    None => break,
                }
            }
        }
        events.sort_by_key(|e| (e.start, e.end));
        Ok((events, all_day))
    }
}

fn local_midnight(d: NaiveDate) -> DateTime<Local> {
    let naive = d.and_time(NaiveTime::MIN);
    Local.from_local_datetime(&naive).earliest().unwrap_or_else(|| Local.from_utc_datetime(&naive))
}

fn convert(
    e: ApiEvent,
    day_start: DateTime<Local>,
    seen: &mut HashSet<(String, String)>,
    events: &mut Vec<Event>,
    all_day: &mut Vec<AllDay>,
) {
    if e.status.as_deref() == Some("cancelled") || e.event_type.as_deref() == Some("workingLocation") {
        return;
    }
    if e.attendees.iter().any(|a| a.is_self && a.response_status.as_deref() == Some("declined")) {
        return;
    }
    let (Some(start), Some(end)) = (e.start, e.end) else { return };
    let title = e.summary.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "(No title)".into());
    let key = (
        e.i_cal_u_i_d.unwrap_or_else(|| title.clone()),
        start.date_time.clone().or(start.date.clone()).unwrap_or_default(),
    );
    if !seen.insert(key) {
        return; // same event on two selected calendars
    }
    if start.date.is_some() && start.date_time.is_none() {
        all_day.push(AllDay { title });
        return;
    }
    let mins = |w: &When| -> Option<i32> {
        let t = DateTime::parse_from_rfc3339(w.date_time.as_deref()?).ok()?.with_timezone(&Local);
        Some(((t - day_start).num_minutes()).clamp(0, 24 * 60) as i32)
    };
    if let (Some(s), Some(en)) = (mins(&start), mins(&end)) {
        if en > s {
            events.push(Event { title, start: s, end: en });
        }
    }
}

/// Accepts connections on the loopback listener until one carries `code` (or `error`).
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, GError> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| GError::Other(e.to_string()))?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
        let url = url::Url::parse(&format!("http://127.0.0.1{path}")).ok();
        let get = |k: &str| url.as_ref().and_then(|u| u.query_pairs().find(|(q, _)| q == k).map(|(_, v)| v.into_owned()));

        let (ok, result) = match (get("code"), get("error"), get("state")) {
            (Some(code), _, Some(s)) if s == state => (true, Ok(code)),
            (_, Some(err), _) => (false, Err(GError::Other(format!("Google sign-in failed: {err}")))),
            (Some(_), _, _) => (false, Err(GError::Other("Sign-in state didn't match. Try again.".into()))),
            _ => {
                // favicon or a stray request: ignore it and keep waiting.
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
        };
        let msg = if ok {
            "Boss Timer is connected to Google Calendar. You can close this tab."
        } else {
            "Boss Timer couldn't connect to Google Calendar. Go back to the app and try again."
        };
        let body = format!(
            "<!doctype html><meta charset=utf-8><title>Boss Timer</title>\
             <body style=\"font:16px system-ui;background:#16161e;color:#c0caf5;display:grid;place-items:center;height:90vh\"><p>{msg}</p>"
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;
        return result;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn converts_events_and_skips_declined_cancelled_and_duplicates() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 27).unwrap();
        let start = local_midnight(today);
        let at = |h: u32, m: u32| local_midnight(today).checked_add_signed(chrono::Duration::minutes((h * 60 + m) as i64)).unwrap().to_rfc3339();
        let json = format!(
            r#"{{"items":[
              {{"summary":"Standup","iCalUID":"a","start":{{"dateTime":"{s1}"}},"end":{{"dateTime":"{e1}"}}}},
              {{"summary":"Standup","iCalUID":"a","start":{{"dateTime":"{s1}"}},"end":{{"dateTime":"{e1}"}}}},
              {{"summary":"Declined","start":{{"dateTime":"{s1}"}},"end":{{"dateTime":"{e1}"}},"attendees":[{{"self":true,"responseStatus":"declined"}}]}},
              {{"summary":"Gone","status":"cancelled","start":{{"dateTime":"{s1}"}},"end":{{"dateTime":"{e1}"}}}},
              {{"summary":"Home","eventType":"workingLocation","start":{{"date":"2026-10-27"}},"end":{{"date":"2026-10-28"}}}},
              {{"summary":"Holiday","start":{{"date":"2026-10-27"}},"end":{{"date":"2026-10-28"}}}}
            ]}}"#,
            s1 = at(9, 30),
            e1 = at(9, 45)
        );
        let list: EventList = serde_json::from_str(&json).unwrap();
        let (mut ev, mut ad, mut seen) = (vec![], vec![], HashSet::new());
        for e in list.items {
            convert(e, start, &mut seen, &mut ev, &mut ad);
        }
        assert_eq!(ev, vec![Event { title: "Standup".into(), start: 570, end: 585 }]);
        assert_eq!(ad, vec![AllDay { title: "Holiday".into() }]);
    }
}

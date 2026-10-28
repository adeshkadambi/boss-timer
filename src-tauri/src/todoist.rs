//! Todoist unified API v1. Auth: a personal API token from the keychain.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::Duration};

const BASE: &str = "https://api.todoist.com/api/v1";

#[derive(Debug)]
pub enum ApiError {
    /// 401/403: the token is wrong or revoked.
    Unauthorized,
    Network(String),
    Other(String),
}

impl ApiError {
    pub fn message(&self) -> String {
        match self {
            ApiError::Unauthorized => "Todoist rejected the token. Paste a new one in Accounts.".into(),
            ApiError::Network(e) => {
                log::warn!("todoist: {e}");
                "Couldn't reach Todoist. Showing the last synced tasks.".into()
            }
            ApiError::Other(m) => format!("Todoist error: {m}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub project: String,
    /// API priority: 4 = highest (p1), 1 = normal.
    pub priority: u8,
    /// Local due date, YYYY-MM-DD.
    pub due_date: Option<String>,
    /// Local due time, HH:MM, when the task has one.
    pub due_time: Option<String>,
    pub overdue: bool,
    #[serde(skip)]
    order: i64,
    #[serde(skip)]
    due_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
struct Page<T> {
    results: Vec<T>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct ApiTask {
    id: String,
    content: String,
    project_id: String,
    #[serde(default = "one")]
    priority: u8,
    #[serde(default)]
    child_order: i64,
    due: Option<ApiDue>,
}
fn one() -> u8 {
    1
}

#[derive(Deserialize)]
struct ApiDue {
    /// "YYYY-MM-DD", floating "YYYY-MM-DDTHH:MM:SS[.ffffff]", or UTC with a trailing "Z".
    date: String,
    /// Older REST-style field, if present.
    datetime: Option<String>,
}

#[derive(Deserialize)]
struct ApiProject {
    id: String,
    name: String,
}

pub struct Todoist {
    http: reqwest::Client,
    projects: Mutex<HashMap<String, String>>,
}

impl Todoist {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("http client"),
            projects: Mutex::new(HashMap::new()),
        }
    }

    async fn get_all<T: DeserializeOwned>(&self, token: &str, path: &str, query: &[(&str, &str)]) -> Result<Vec<T>, ApiError> {
        let mut out = vec![];
        let mut cursor: Option<String> = None;
        loop {
            let mut q: Vec<(&str, &str)> = query.to_vec();
            q.push(("limit", "200"));
            if let Some(c) = &cursor {
                q.push(("cursor", c));
            }
            let res = self
                .http
                .get(format!("{BASE}{path}"))
                .bearer_auth(token)
                .query(&q)
                .send()
                .await
                .map_err(|e| ApiError::Network(e.to_string()))?;
            let page: Page<T> = check(res).await?.json().await.map_err(|e| ApiError::Other(e.to_string()))?;
            out.extend(page.results);
            match page.next_cursor {
                Some(c) if !c.is_empty() => cursor = Some(c),
                _ => return Ok(out),
            }
        }
    }

    async fn refresh_projects(&self, token: &str) -> Result<(), ApiError> {
        let list: Vec<ApiProject> = self.get_all(token, "/projects", &[]).await?;
        *self.projects.lock().unwrap() = list.into_iter().map(|p| (p.id, p.name)).collect();
        Ok(())
    }

    /// Checks a token by listing projects.
    pub async fn validate(&self, token: &str) -> Result<(), ApiError> {
        self.refresh_projects(token).await
    }

    /// `scope`: "today" or "overdue" (today + overdue).
    pub async fn tasks(&self, token: &str, scope: &str) -> Result<Vec<Task>, ApiError> {
        let query = if scope == "today" { "today" } else { "today | overdue" };
        let raw: Vec<ApiTask> = self.get_all(token, "/tasks/filter", &[("query", query)]).await?;

        let unknown = {
            let p = self.projects.lock().unwrap();
            p.is_empty() || raw.iter().any(|t| !p.contains_key(&t.project_id))
        };
        if unknown {
            self.refresh_projects(token).await?;
        }
        let projects = self.projects.lock().unwrap().clone();
        let today = Local::now().date_naive();
        let mut tasks: Vec<Task> = raw.into_iter().map(|t| to_task(t, &projects, today)).collect();
        sort_tasks(&mut tasks);
        Ok(tasks)
    }

    pub async fn close(&self, token: &str, id: &str) -> Result<(), ApiError> {
        check_id(id)?;
        self.post(token, &format!("/tasks/{id}/close")).await
    }

    pub async fn reopen(&self, token: &str, id: &str) -> Result<(), ApiError> {
        check_id(id)?;
        self.post(token, &format!("/tasks/{id}/reopen")).await
    }

    async fn post(&self, token: &str, path: &str) -> Result<(), ApiError> {
        let res = self
            .http
            .post(format!("{BASE}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;
        check(res).await.map(|_| ())
    }
}

/// Task ids are put into the URL path, so only accept what Todoist ids look like.
fn check_id(id: &str) -> Result<(), ApiError> {
    let ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok { Ok(()) } else { Err(ApiError::Other("invalid task id".into())) }
}

async fn check(res: reqwest::Response) -> Result<reqwest::Response, ApiError> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(ApiError::Unauthorized);
    }
    let body = res.text().await.unwrap_or_default();
    Err(ApiError::Other(format!("{status} {}", body.chars().take(200).collect::<String>())))
}

/// Parses a v1 due date to (local date, local date-time if it has a time).
fn parse_due(due: &ApiDue) -> Option<(NaiveDate, Option<NaiveDateTime>)> {
    let s = due.datetime.as_deref().unwrap_or(&due.date);
    if s.len() == 10 {
        return NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| (d, None));
    }
    if s.len() < 16 || !s.is_char_boundary(10) || !s.is_char_boundary(11) {
        return None;
    }
    let local = if s.ends_with('Z') || s[10..].contains('+') || s[11..].contains('-') {
        DateTime::parse_from_rfc3339(s).ok()?.with_timezone(&Local).naive_local()
    } else {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok()?
    };
    Some((local.date(), Some(local)))
}

fn to_task(t: ApiTask, projects: &HashMap<String, String>, today: NaiveDate) -> Task {
    let due = t.due.as_ref().and_then(parse_due);
    Task {
        project: projects.get(&t.project_id).cloned().unwrap_or_else(|| "Inbox".into()),
        title: t.content,
        id: t.id,
        priority: t.priority.clamp(1, 4),
        due_date: due.map(|(d, _)| d.format("%Y-%m-%d").to_string()),
        due_time: due.and_then(|(_, dt)| dt).map(|dt| dt.format("%H:%M").to_string()),
        overdue: due.is_some_and(|(d, _)| d < today),
        order: t.child_order,
        due_at: due.and_then(|(_, dt)| dt),
    }
}

/// Overdue first, then tasks with a time by time, then by priority, then Todoist's order.
fn sort_tasks(tasks: &mut [Task]) {
    tasks.sort_by(|a, b| {
        b.overdue
            .cmp(&a.overdue)
            .then_with(|| match (a.overdue, b.overdue) {
                (true, true) => a.due_date.cmp(&b.due_date),
                _ => std::cmp::Ordering::Equal,
            })
            .then_with(|| b.due_at.is_some().cmp(&a.due_at.is_some()))
            .then_with(|| a.due_at.cmp(&b.due_at))
            .then_with(|| b.priority.cmp(&a.priority))
            .then_with(|| a.order.cmp(&b.order))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(id: &str, prio: u8, order: i64, due: Option<&str>) -> ApiTask {
        ApiTask {
            id: id.into(),
            content: format!("Task {id}"),
            project_id: "p1".into(),
            priority: prio,
            child_order: order,
            due: due.map(|d| ApiDue { date: d.into(), datetime: None }),
        }
    }

    #[test]
    fn parses_v1_task_json() {
        let json = r#"{"results":[{"id":"6X7","content":"Write doc","project_id":"220","priority":4,
            "child_order":3,"day_order":-1,"checked":false,
            "due":{"date":"2026-10-27T15:00:00","timezone":null,"string":"today 3pm","lang":"en","is_recurring":false}}],
            "next_cursor":null}"#;
        let page: Page<ApiTask> = serde_json::from_str(json).unwrap();
        let projects = HashMap::from([("220".to_string(), "Work".to_string())]);
        let t = to_task(page.results.into_iter().next().unwrap(), &projects, NaiveDate::from_ymd_opt(2026, 10, 27).unwrap());
        assert_eq!(t.title, "Write doc");
        assert_eq!(t.project, "Work");
        assert_eq!(t.priority, 4);
        assert_eq!(t.due_date.as_deref(), Some("2026-10-27"));
        assert_eq!(t.due_time.as_deref(), Some("15:00"));
        assert!(!t.overdue);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn rejects_path_like_task_ids() {
        assert!(check_id("6Jf8VQXxpwv56VQ7").is_ok());
        assert!(check_id("../projects").is_err());
        assert!(check_id("1/close").is_err());
        assert!(check_id("").is_err());
    }

    #[test]
    fn parses_due_formats() {
        let d = |s: &str| parse_due(&ApiDue { date: s.into(), datetime: None });
        assert_eq!(d("2026-10-27").unwrap().1, None);
        let (_, t) = d("2026-10-27T09:30:00.000000").unwrap();
        assert_eq!(t.unwrap().format("%H:%M").to_string(), "09:30");
        assert!(d("2026-10-27T09:30:00Z").unwrap().1.is_some());
        assert!(d("garbage").is_none());
    }

    #[test]
    fn sorts_overdue_then_timed_then_priority_then_order() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 27).unwrap();
        let p = HashMap::new();
        let mut v: Vec<Task> = [
            api("plain-low", 1, 1, Some("2026-10-27")),
            api("plain-high", 4, 2, Some("2026-10-27")),
            api("timed-late", 1, 3, Some("2026-10-27T16:00:00")),
            api("timed-early", 1, 4, Some("2026-10-27T09:00:00")),
            api("overdue", 1, 5, Some("2026-10-25")),
            api("plain-low-first", 1, 0, Some("2026-10-27")),
        ]
        .into_iter()
        .map(|t| to_task(t, &p, today))
        .collect();
        sort_tasks(&mut v);
        let ids: Vec<&str> = v.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["overdue", "timed-early", "timed-late", "plain-high", "plain-low-first", "plain-low"]);
        assert_eq!(v[0].project, "Inbox");
    }
}

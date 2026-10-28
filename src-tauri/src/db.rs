//! Session log in SQLite. Reports group by the local date of `started_at`.

use chrono::{DateTime, Datelike, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path, sync::Mutex};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  task_source TEXT NOT NULL,
  task_id TEXT, task_title TEXT NOT NULL, project TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  planned_secs INTEGER NOT NULL,
  timed_secs INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  focused_secs INTEGER NOT NULL DEFAULT 0,
  ended_naturally INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
";

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone)]
pub struct OpenSession {
    pub id: i64,
    pub task_id: Option<String>,
    pub task_title: String,
    pub project: Option<String>,
    pub planned_secs: u64,
    pub timed_secs: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DayRow {
    pub date: String,
    pub focused_secs: i64,
    pub timed_secs: i64,
    pub sessions: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Totals {
    pub focused_secs: i64,
    pub timed_secs: i64,
    pub sessions: i64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Streaks {
    pub current: i64,
    pub longest: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub year: i32,
    /// Years that have any sessions, newest first. Always includes the current year.
    pub years: Vec<i32>,
    /// Days of `year` with at least one finished session.
    pub days: Vec<DayRow>,
    /// All time.
    pub totals: Totals,
    /// All time, over days with focused time > 0.
    pub streaks: Streaks,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Written at timer start, so a crash leaves a row to recover.
    pub fn insert_session(
        &self,
        task_id: Option<&str>,
        title: &str,
        project: Option<&str>,
        started_at: DateTime<Local>,
        planned_secs: u64,
    ) -> rusqlite::Result<i64> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO sessions(task_source, task_id, task_title, project, started_at, planned_secs)
             VALUES ('todoist', ?1, ?2, ?3, ?4, ?5)",
            params![task_id, title, project, started_at.to_rfc3339(), planned_secs as i64],
        )?;
        Ok(c.last_insert_rowid())
    }

    /// Progress checkpoint while running (crash recovery).
    pub fn update_timed(&self, id: i64, timed_secs: u64, planned_secs: u64) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE sessions SET timed_secs = ?2, planned_secs = ?3 WHERE id = ?1 AND ended_at IS NULL",
            params![id, timed_secs as i64, planned_secs as i64],
        )?;
        Ok(())
    }

    /// `rating` None = skipped: focused is 0, but the time still counts as timed.
    pub fn finish_session(
        &self,
        id: i64,
        timed_secs: u64,
        rating: Option<u8>,
        ended_naturally: bool,
    ) -> rusqlite::Result<u64> {
        let focused = focused_secs(timed_secs, rating);
        self.conn.lock().unwrap().execute(
            "UPDATE sessions SET ended_at = ?2, timed_secs = ?3, rating = ?4, focused_secs = ?5, ended_naturally = ?6
             WHERE id = ?1",
            params![
                id,
                Local::now().to_rfc3339(),
                timed_secs as i64,
                rating.map(|r| r as i64),
                focused as i64,
                ended_naturally as i64
            ],
        )?;
        Ok(focused)
    }

    /// The newest session that never finished (the app quit or crashed mid-timer).
    /// Older unfinished rows are closed as skipped.
    pub fn take_unfinished(&self) -> rusqlite::Result<Option<OpenSession>> {
        let latest = {
            let c = self.conn.lock().unwrap();
            c.query_row(
                "SELECT id, task_id, task_title, project, planned_secs, timed_secs FROM sessions
                 WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1",
                [],
                |r| {
                    Ok(OpenSession {
                        id: r.get(0)?,
                        task_id: r.get(1)?,
                        task_title: r.get(2)?,
                        project: r.get(3)?,
                        planned_secs: r.get::<_, i64>(4)? as u64,
                        timed_secs: r.get::<_, i64>(5)? as u64,
                    })
                },
            )
            .optional()?
        };
        if let Some(s) = &latest {
            self.conn.lock().unwrap().execute(
                "UPDATE sessions SET ended_at = started_at WHERE ended_at IS NULL AND id <> ?1",
                params![s.id],
            )?;
        }
        Ok(latest)
    }

    pub fn report(&self, year: i32, today: NaiveDate) -> rusqlite::Result<Report> {
        let c = self.conn.lock().unwrap();

        // Per local day, all time. started_at is RFC 3339 with the local offset, so its first
        // 10 characters are the local date.
        let mut stmt = c.prepare(
            "SELECT substr(started_at, 1, 10) AS d, SUM(focused_secs), SUM(timed_secs), COUNT(*)
             FROM sessions WHERE ended_at IS NOT NULL GROUP BY d ORDER BY d",
        )?;
        let all: Vec<DayRow> = stmt
            .query_map([], |r| {
                Ok(DayRow { date: r.get(0)?, focused_secs: r.get(1)?, timed_secs: r.get(2)?, sessions: r.get(3)? })
            })?
            .collect::<Result<_, _>>()?;

        let mut totals = Totals::default();
        let mut by_date = BTreeMap::new();
        let mut years = vec![today.year()];
        for d in &all {
            totals.focused_secs += d.focused_secs;
            totals.timed_secs += d.timed_secs;
            totals.sessions += d.sessions;
            if let Ok(nd) = NaiveDate::parse_from_str(&d.date, "%Y-%m-%d") {
                if !years.contains(&nd.year()) {
                    years.push(nd.year());
                }
                by_date.insert(nd, d.focused_secs);
            }
        }
        years.sort_unstable_by(|a, b| b.cmp(a));

        Ok(Report {
            year,
            years,
            days: all.into_iter().filter(|d| d.date.starts_with(&format!("{year:04}-"))).collect(),
            totals,
            streaks: streaks(&by_date, today),
        })
    }
}

pub fn focused_secs(timed_secs: u64, rating: Option<u8>) -> u64 {
    rating.map_or(0, |r| timed_secs * r.min(5) as u64 / 5)
}

/// Current streak: consecutive days with focus > 0 ending today or yesterday.
fn streaks(by_date: &BTreeMap<NaiveDate, i64>, today: NaiveDate) -> Streaks {
    let has = |d: NaiveDate| by_date.get(&d).is_some_and(|&f| f > 0);

    let mut longest = 0;
    let mut run = 0;
    let mut prev: Option<NaiveDate> = None;
    for (&d, &f) in by_date {
        if f <= 0 {
            run = 0;
            prev = None;
            continue;
        }
        run = match prev {
            Some(p) if p.succ_opt() == Some(d) => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        prev = Some(d);
    }

    let mut cur = 0;
    let mut day = if has(today) { Some(today) } else { today.pred_opt() };
    while let Some(d) = day {
        if !has(d) {
            break;
        }
        cur += 1;
        day = d.pred_opt();
    }
    Streaks { current: cur, longest }
}

/// Reports for `year` (default: this year), grouped by local day.
#[tauri::command]
pub fn get_report(db: tauri::State<'_, std::sync::Arc<Db>>, year: Option<i32>) -> Result<Report, String> {
    let today = Local::now().date_naive();
    db.report(year.unwrap_or_else(|| today.year()), today).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap()
    }

    fn log(db: &Db, when: DateTime<Local>, timed: u64, rating: Option<u8>) {
        let id = db.insert_session(Some("t"), "Task", Some("P"), when, timed).unwrap();
        db.finish_session(id, timed, rating, true).unwrap();
    }

    #[test]
    fn focused_follows_rating() {
        assert_eq!(focused_secs(1500, Some(4)), 1200);
        assert_eq!(focused_secs(1500, Some(5)), 1500);
        assert_eq!(focused_secs(1500, None), 0);
    }

    #[test]
    fn report_groups_by_local_day_and_counts_streaks() {
        let db = Db::in_memory().unwrap();
        log(&db, at(2026, 10, 24, 9), 1500, Some(5));
        log(&db, at(2026, 10, 25, 9), 1500, Some(4));
        log(&db, at(2026, 10, 25, 14), 600, None); // skipped: timed only
        log(&db, at(2026, 10, 26, 9), 1200, Some(5));
        log(&db, at(2025, 3, 1, 9), 600, Some(5));
        // Unfinished rows don't count.
        db.insert_session(None, "Open", None, at(2026, 10, 26, 10), 1500).unwrap();

        let today = NaiveDate::from_ymd_opt(2026, 10, 27).unwrap();
        let r = db.report(2026, today).unwrap();
        assert_eq!(r.years, vec![2026, 2025]);
        assert_eq!(r.days.len(), 3);
        assert_eq!(r.days[1], DayRow { date: "2026-10-25".into(), focused_secs: 1200, timed_secs: 2100, sessions: 2 });
        assert_eq!(r.totals.focused_secs, 1500 + 1200 + 1200 + 600);
        assert_eq!(r.totals.timed_secs, 1500 + 2100 + 1200 + 600);
        // Oct 24–26, ending yesterday.
        assert_eq!(r.streaks.current, 3);
        assert_eq!(r.streaks.longest, 3);
    }

    #[test]
    fn streak_breaks_on_gap() {
        let mut m = BTreeMap::new();
        let d = |day| NaiveDate::from_ymd_opt(2026, 10, day).unwrap();
        for day in [1, 2, 3, 4, 10, 11] {
            m.insert(d(day), 60);
        }
        assert_eq!(streaks(&m, d(11)), Streaks { current: 2, longest: 4 });
        assert_eq!(streaks(&m, d(13)).current, 0);
    }

    #[test]
    fn recovers_latest_unfinished_and_closes_older() {
        let db = Db::in_memory().unwrap();
        let a = db.insert_session(None, "Old", None, at(2026, 10, 26, 9), 1500).unwrap();
        let b = db.insert_session(Some("x"), "New", Some("P"), at(2026, 10, 27, 9), 1500).unwrap();
        db.update_timed(b, 300, 1500).unwrap();
        let s = db.take_unfinished().unwrap().unwrap();
        assert_eq!((s.id, s.timed_secs, s.task_title.as_str()), (b, 300, "New"));
        let ended: Option<String> = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT ended_at FROM sessions WHERE id = ?1", [a], |r| r.get(0))
            .unwrap();
        assert!(ended.is_some());
    }
}

//! Pure timer state machine. No I/O: callers pass in the clocks.
//!
//! Remaining time is computed from a monotonic `Instant` (never by summing ticks). Monotonic
//! clocks stop during system sleep on macOS and Linux, so each tick also compares wall-clock
//! progress: a forward jump of more than 2 s is treated as sleep and counted as elapsed time.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant, SystemTime};

const SLEEP_SLACK: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Running,
    Paused,
    Report,
    Logged,
}

impl Phase {
    /// A timer is on screen and not yet logged.
    pub fn is_active(self) -> bool {
        matches!(self, Phase::Running | Phase::Paused | Phase::Report)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskRef {
    pub id: Option<String>,
    pub title: String,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimerView {
    pub phase: Phase,
    pub task: Option<TaskRef>,
    /// What the user picked when starting. `again` reuses it.
    pub planned_secs: u64,
    /// Length of the current segment (planned, or 5 min after +5).
    pub total_ms: u64,
    pub remaining_ms: u64,
    pub timed_secs: u64,
    pub ended_naturally: bool,
    pub rating: Option<u8>,
    pub focused_secs: u64,
    pub session_id: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Tick {
    pub remaining_ms: u64,
    pub total_ms: u64,
    pub phase: Phase,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TickOutcome {
    /// Not running: nothing to emit.
    Idle,
    Running,
    /// Reached zero on this tick (possibly after sleep): go to Report and ring.
    Finished,
}

#[derive(Debug)]
pub struct Engine {
    phase: Phase,
    task: Option<TaskRef>,
    planned_secs: u64,
    total_ms: u64,
    /// Remaining when the current run (since start/resume/extend) began.
    run_budget_ms: u64,
    run_started: Option<Instant>,
    /// Sleep time detected during the current run.
    slept_ms: u64,
    /// Time from finished runs (pauses, earlier +5 segments).
    timed_ms: u64,
    ended_naturally: bool,
    rating: Option<u8>,
    focused_secs: u64,
    session_id: Option<i64>,
    last_mono: Instant,
    last_wall: SystemTime,
}

impl Engine {
    pub fn new(now: Instant, wall: SystemTime) -> Self {
        Self {
            phase: Phase::Idle,
            task: None,
            planned_secs: 0,
            total_ms: 0,
            run_budget_ms: 0,
            run_started: None,
            slept_ms: 0,
            timed_ms: 0,
            ended_naturally: false,
            rating: None,
            focused_secs: 0,
            session_id: None,
            last_mono: now,
            last_wall: wall,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn task(&self) -> Option<&TaskRef> {
        self.task.as_ref()
    }
    pub fn session_id(&self) -> Option<i64> {
        self.session_id
    }
    pub fn planned_secs(&self) -> u64 {
        self.planned_secs
    }
    pub fn ended_naturally(&self) -> bool {
        self.ended_naturally
    }

    fn run_elapsed_ms(&self, now: Instant) -> u64 {
        let Some(start) = self.run_started else { return 0 };
        let ms = now.saturating_duration_since(start).as_millis() as u64 + self.slept_ms;
        ms.min(self.run_budget_ms)
    }

    pub fn remaining_ms(&self, now: Instant) -> u64 {
        match self.phase {
            Phase::Running => self.run_budget_ms - self.run_elapsed_ms(now),
            Phase::Paused => self.run_budget_ms,
            _ => 0,
        }
    }

    /// Seconds timed so far, including the current run.
    pub fn timed_secs(&self, now: Instant) -> u64 {
        let ms = self.timed_ms + if self.phase == Phase::Running { self.run_elapsed_ms(now) } else { 0 };
        (ms + 500) / 1000
    }

    fn begin_run(&mut self, budget_ms: u64, now: Instant, wall: SystemTime) {
        self.run_budget_ms = budget_ms;
        self.run_started = Some(now);
        self.slept_ms = 0;
        self.last_mono = now;
        self.last_wall = wall;
        self.phase = Phase::Running;
    }

    /// Bank the current run's elapsed time and stop the clock.
    fn end_run(&mut self, now: Instant) {
        if self.phase == Phase::Running {
            let e = self.run_elapsed_ms(now);
            self.timed_ms += e;
            self.run_budget_ms -= e;
            self.run_started = None;
            self.slept_ms = 0;
        }
    }

    pub fn start(&mut self, task: TaskRef, secs: u64, session_id: i64, now: Instant, wall: SystemTime) {
        *self = Self::new(now, wall);
        self.task = Some(task);
        self.planned_secs = secs;
        self.total_ms = secs * 1000;
        self.session_id = Some(session_id);
        self.begin_run(secs * 1000, now, wall);
    }

    pub fn pause(&mut self, now: Instant) -> bool {
        if self.phase != Phase::Running {
            return false;
        }
        self.end_run(now);
        self.phase = Phase::Paused;
        true
    }

    pub fn resume(&mut self, now: Instant, wall: SystemTime) -> bool {
        if self.phase != Phase::Paused {
            return false;
        }
        let budget = self.run_budget_ms;
        self.begin_run(budget, now, wall);
        true
    }

    /// Stop early: same question as time's up, without the alarm.
    pub fn stop(&mut self, now: Instant) -> bool {
        if !matches!(self.phase, Phase::Running | Phase::Paused) {
            return false;
        }
        self.end_run(now);
        self.phase = Phase::Report;
        self.ended_naturally = false;
        true
    }

    /// +5 min from the question: continues the same session.
    pub fn extend(&mut self, secs: u64, now: Instant, wall: SystemTime) -> bool {
        if self.phase != Phase::Report {
            return false;
        }
        self.total_ms = secs * 1000;
        self.ended_naturally = false;
        self.rating = None;
        self.begin_run(secs * 1000, now, wall);
        true
    }

    /// Records the answer (None = skipped). Returns (timed_secs, rating) for the session row.
    pub fn log(&mut self, rating: Option<u8>, now: Instant) -> Option<(u64, Option<u8>)> {
        if self.phase != Phase::Report {
            return None;
        }
        let timed = self.timed_secs(now);
        self.rating = rating.map(|r| r.clamp(1, 5));
        self.focused_secs = crate::db::focused_secs(timed, self.rating);
        self.phase = Phase::Logged;
        Some((timed, self.rating))
    }

    pub fn close(&mut self, now: Instant, wall: SystemTime) {
        *self = Self::new(now, wall);
    }

    /// A session that never finished (crash or quit mid-timer) comes back as "Stopped." with
    /// the time it had reached.
    pub fn recover(&mut self, task: TaskRef, planned_secs: u64, timed_secs: u64, session_id: i64) {
        self.task = Some(task);
        self.planned_secs = planned_secs;
        self.total_ms = planned_secs * 1000;
        self.timed_ms = timed_secs * 1000;
        self.session_id = Some(session_id);
        self.ended_naturally = false;
        self.phase = Phase::Report;
    }

    pub fn tick(&mut self, now: Instant, wall: SystemTime) -> TickOutcome {
        let mono = now.saturating_duration_since(self.last_mono);
        let walled = wall.duration_since(self.last_wall).unwrap_or_default();
        self.last_mono = now;
        self.last_wall = wall;
        if self.phase != Phase::Running {
            return TickOutcome::Idle;
        }
        if walled > mono + SLEEP_SLACK {
            self.slept_ms += (walled - mono).as_millis() as u64;
        }
        if self.remaining_ms(now) == 0 {
            self.end_run(now);
            self.phase = Phase::Report;
            self.ended_naturally = true;
            return TickOutcome::Finished;
        }
        TickOutcome::Running
    }

    pub fn tick_payload(&self, now: Instant) -> Tick {
        Tick { remaining_ms: self.remaining_ms(now), total_ms: self.total_ms, phase: self.phase }
    }

    pub fn view(&self, now: Instant) -> TimerView {
        TimerView {
            phase: self.phase,
            task: self.task.clone(),
            planned_secs: self.planned_secs,
            total_ms: self.total_ms,
            remaining_ms: self.remaining_ms(now),
            timed_secs: self.timed_secs(now),
            ended_naturally: self.ended_naturally,
            rating: self.rating,
            focused_secs: self.focused_secs,
            session_id: self.session_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Clock {
        mono: Instant,
        wall: SystemTime,
    }
    impl Clock {
        fn new() -> Self {
            Self { mono: Instant::now(), wall: SystemTime::now() }
        }
        /// Awake time passes: both clocks move.
        fn run(&mut self, secs: f64) {
            let d = Duration::from_secs_f64(secs);
            self.mono += d;
            self.wall += d;
        }
        /// System sleep: only the wall clock moves.
        fn sleep(&mut self, secs: u64) {
            self.wall += Duration::from_secs(secs);
        }
    }

    fn task() -> TaskRef {
        TaskRef { id: Some("1".into()), title: "Write".into(), project: Some("Work".into()) }
    }

    fn started(c: &Clock, secs: u64) -> Engine {
        let mut e = Engine::new(c.mono, c.wall);
        e.start(task(), secs, 7, c.mono, c.wall);
        e
    }

    /// Ticks every 250 ms for `secs` of awake time.
    fn run_ticks(e: &mut Engine, c: &mut Clock, secs: f64) -> Vec<TickOutcome> {
        let mut out = vec![];
        for _ in 0..(secs * 4.0).round() as u64 {
            c.run(0.25);
            out.push(e.tick(c.mono, c.wall));
        }
        out
    }

    #[test]
    fn counts_down_and_finishes_once() {
        let mut c = Clock::new();
        let mut e = started(&c, 60);
        run_ticks(&mut e, &mut c, 30.0);
        assert_eq!(e.remaining_ms(c.mono), 30_000);
        let out = run_ticks(&mut e, &mut c, 31.0);
        assert_eq!(out.iter().filter(|o| **o == TickOutcome::Finished).count(), 1);
        assert_eq!(e.phase(), Phase::Report);
        assert!(e.ended_naturally());
        assert_eq!(e.timed_secs(c.mono), 60);
    }

    #[test]
    fn pause_freezes_remaining_and_excludes_paused_time() {
        let mut c = Clock::new();
        let mut e = started(&c, 60);
        run_ticks(&mut e, &mut c, 20.0);
        assert!(e.pause(c.mono));
        run_ticks(&mut e, &mut c, 100.0); // paused for 100 s
        assert_eq!(e.remaining_ms(c.mono), 40_000);
        assert!(e.resume(c.mono, c.wall));
        run_ticks(&mut e, &mut c, 10.0);
        assert_eq!(e.remaining_ms(c.mono), 30_000);
        assert!(e.stop(c.mono));
        assert!(!e.ended_naturally());
        assert_eq!(e.timed_secs(c.mono), 30);
    }

    #[test]
    fn extend_continues_the_same_session() {
        let mut c = Clock::new();
        let mut e = started(&c, 60);
        run_ticks(&mut e, &mut c, 61.0);
        assert!(e.extend(300, c.mono, c.wall));
        assert_eq!(e.session_id(), Some(7));
        run_ticks(&mut e, &mut c, 120.0);
        e.stop(c.mono);
        let (timed, rating) = e.log(Some(4), c.mono).unwrap();
        assert_eq!((timed, rating), (180, Some(4)));
        assert_eq!(e.view(c.mono).focused_secs, 144);
        assert_eq!(e.phase(), Phase::Logged);
    }

    #[test]
    fn sleep_past_deadline_finishes_on_wake() {
        let mut c = Clock::new();
        let mut e = started(&c, 600);
        run_ticks(&mut e, &mut c, 60.0);
        c.sleep(3600);
        c.run(0.25);
        assert_eq!(e.tick(c.mono, c.wall), TickOutcome::Finished);
        assert_eq!(e.timed_secs(c.mono), 600);
    }

    #[test]
    fn short_sleep_counts_as_elapsed() {
        let mut c = Clock::new();
        let mut e = started(&c, 600);
        run_ticks(&mut e, &mut c, 60.0);
        c.sleep(120);
        c.run(0.25);
        assert_eq!(e.tick(c.mono, c.wall), TickOutcome::Running);
        let rem = e.remaining_ms(c.mono);
        assert!((419_000..=420_000).contains(&rem), "remaining {rem}");
    }

    #[test]
    fn sleep_while_paused_is_ignored() {
        let mut c = Clock::new();
        let mut e = started(&c, 600);
        run_ticks(&mut e, &mut c, 60.0);
        e.pause(c.mono);
        c.sleep(3600);
        c.run(0.25);
        e.tick(c.mono, c.wall);
        e.resume(c.mono, c.wall);
        run_ticks(&mut e, &mut c, 1.0);
        assert_eq!(e.remaining_ms(c.mono), 539_000);
    }

    #[test]
    fn skipped_rating_logs_zero_focus() {
        let mut c = Clock::new();
        let mut e = started(&c, 60);
        run_ticks(&mut e, &mut c, 30.0);
        e.stop(c.mono);
        assert_eq!(e.log(None, c.mono), Some((30, None)));
        assert_eq!(e.view(c.mono).focused_secs, 0);
    }

    #[test]
    fn commands_are_ignored_in_the_wrong_phase() {
        let c = Clock::new();
        let mut e = Engine::new(c.mono, c.wall);
        assert!(!e.pause(c.mono));
        assert!(!e.stop(c.mono));
        assert!(e.log(Some(3), c.mono).is_none());
        assert!(!e.extend(300, c.mono, c.wall));
    }
}

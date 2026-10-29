// Typed wrappers around the Rust commands and events.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AlarmSound } from './settings';

// ---- timer ----

export type Phase = 'idle' | 'running' | 'paused' | 'report' | 'logged';

export interface TaskRef {
  id: string | null;
  title: string;
  project: string | null;
}

export interface TimerView {
  phase: Phase;
  task: TaskRef | null;
  planned_secs: number;
  total_ms: number;
  remaining_ms: number;
  timed_secs: number;
  ended_naturally: boolean;
  rating: number | null;
  focused_secs: number;
  session_id: number | null;
}

export interface Tick {
  remaining_ms: number;
  total_ms: number;
  phase: Phase;
}

export interface StartResult {
  started: boolean;
  active_title: string | null;
}

export const timer = {
  state: () => invoke<TimerView>('get_timer_state'),
  start: (task: TaskRef, secs: number, replace = false) =>
    invoke<StartResult>('start_timer', { task, secs, replace }),
  pause: () => invoke<void>('pause'),
  resume: () => invoke<void>('resume'),
  stop: () => invoke<void>('stop'),
  extend: (secs = 300) => invoke<void>('extend', { secs }),
  rate: (rating: number) => invoke<void>('submit_rating', { rating }),
  skip: () => invoke<void>('skip_rating'),
  again: () => invoke<StartResult>('again'),
  close: () => invoke<void>('close_timer'),
  onTick: (fn: (t: Tick) => void): Promise<UnlistenFn> => listen<Tick>('timer://tick', (e) => fn(e.payload)),
  onPhase: (fn: (v: TimerView) => void): Promise<UnlistenFn> => listen<TimerView>('timer://phase', (e) => fn(e.payload)),
};

// ---- today ----

export interface ApiTask {
  id: string;
  title: string;
  project: string;
  priority: 1 | 2 | 3 | 4;
  labels: string[];
  due_date: string | null;
  due_time: string | null;
  overdue: boolean;
}

export interface ApiEvent {
  title: string;
  start: number;
  end: number;
}

export interface TodayData {
  todoist: { connected: boolean; unauthorized: boolean; error: string | null; tasks: ApiTask[] };
  google: {
    configured: boolean;
    connected: boolean;
    needs_reconnect: boolean;
    error: string | null;
    all_day: { title: string }[];
    events: ApiEvent[];
  };
  synced_at: number;
}

export const syncToday = () => invoke<TodayData>('sync_today');

// ---- accounts ----

export interface AccountsStatus {
  todoist_connected: boolean;
  /** A Google client was built into the app. */
  google_builtin: boolean;
  google_configured: boolean;
  google_connected: boolean;
  google_needs_reconnect: boolean;
  google_account: string;
  google_client_id: string;
}

export interface CalendarChoice {
  id: string;
  name: string;
  primary: boolean;
  checked: boolean;
}

export const accounts = {
  status: () => invoke<AccountsStatus>('accounts_status'),
  todoistConnect: (token: string) => invoke<void>('todoist_connect', { token }),
  todoistDisconnect: () => invoke<void>('todoist_disconnect'),
  complete: (id: string) => invoke<void>('todoist_complete', { id }),
  reopen: (id: string) => invoke<void>('todoist_reopen', { id }),
  googleSaveClient: (clientId: string, clientSecret: string) =>
    invoke<void>('google_save_client', { clientId, clientSecret }),
  googleClearClient: () => invoke<void>('google_clear_client'),
  googleConnect: () => invoke<string>('google_connect'),
  googleDisconnect: () => invoke<void>('google_disconnect'),
  googleCalendars: () => invoke<CalendarChoice[]>('google_calendars'),
};

// ---- reports ----

export interface DayRow {
  date: string;
  focused_secs: number;
  timed_secs: number;
  sessions: number;
}

export interface Report {
  year: number;
  years: number[];
  days: DayRow[];
  totals: { focused_secs: number; timed_secs: number; sessions: number };
  streaks: { current: number; longest: number };
}

export const getReport = (year?: number) => invoke<Report>('get_report', { year });

// ---- audio ----

export const audio = {
  preview: (sound: AlarmSound) => invoke<void>('preview_alarm', { sound }),
};

// ---- updates ----

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

export const updates = {
  /** A newer release, or null if this is the latest. */
  check: () => invoke<UpdateInfo | null>('check_update'),
  /** Installs the update from the last check and restarts the app. */
  install: () => invoke<void>('install_update'),
};

/** Error text from a rejected invoke. */
export function errText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : 'Something went wrong.';
}

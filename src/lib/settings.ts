// Settings live in Rust (JSON in the app config dir). Every change is broadcast to all windows
// as `settings://changed`, so a theme picked in one window applies everywhere.
// Outside Tauri (plain `npm run dev` in a browser) it falls back to localStorage for previewing.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DEFAULT_FONT, DEFAULT_THEME, applyLook, type BodyFont, type ThemeId } from './themes';

export type AlarmMode = 'both' | 'shake' | 'ring';
export type AlarmSound = 'chime' | 'bell8' | 'beep';

export interface Settings {
  theme: ThemeId;
  body_font: BodyFont;
  /** Last duration used to start a timer, in seconds. */
  last_duration_secs: number;
  alarm_mode: AlarmMode;
  alarm_sound: AlarmSound;
  ask_rating: boolean;
  always_on_top: boolean;
  /** Alarm volume, 0–100. */
  volume: number;
  todoist_scope: 'today' | 'overdue';
  sync_interval_min: 5 | 15 | 30;
  google_client_id: string;
  google_calendars: string[] | null;
  google_account: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
  body_font: DEFAULT_FONT,
  last_duration_secs: 25 * 60,
  alarm_mode: 'both',
  alarm_sound: 'chime',
  ask_rating: true,
  always_on_top: true,
  volume: 60,
  todoist_scope: 'overdue',
  sync_interval_min: 15,
  google_client_id: '',
  google_calendars: null,
  google_account: '',
};

export const inTauri = '__TAURI_INTERNALS__' in window;
const LOCAL_KEY = 'boss-timer.settings';

function readLocal(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let current: Settings = { ...DEFAULT_SETTINGS };
const subs = new Set<(s: Settings) => void>();

function set(next: Settings): void {
  current = next;
  applyLook(next.theme, next.body_font);
  subs.forEach((fn) => fn(next));
}

export function settings(): Settings {
  return current;
}

export function onSettings(fn: (s: Settings) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export async function loadSettings(): Promise<Settings> {
  if (inTauri) {
    set({ ...DEFAULT_SETTINGS, ...(await invoke<Partial<Settings>>('get_settings')) });
    await listen<Settings>('settings://changed', (e) => set({ ...DEFAULT_SETTINGS, ...e.payload }));
  } else {
    set(readLocal());
  }
  return current;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  if (inTauri) {
    // Rust saves, then broadcasts to every window, including this one.
    set({ ...DEFAULT_SETTINGS, ...(await invoke<Partial<Settings>>('update_settings', { patch })) });
  } else {
    const next = { ...current, ...patch };
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(next)); } catch { /* preview only */ }
    set(next);
  }
}

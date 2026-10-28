// Today's data from Rust (Todoist + Google Calendar). In a plain browser (`npm run dev` without
// Tauri) it uses a dev-only mock, which is left out of production builds.

import { syncToday, type TodayData } from '../lib/api';
import { inTauri } from '../lib/settings';

export async function loadToday(): Promise<TodayData> {
  if (inTauri) return syncToday();
  if (import.meta.env.DEV) {
    const mock = (await import('../dev/mock-today.json')).default;
    const toMin = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    return {
      todoist: {
        connected: true,
        unauthorized: false,
        error: null,
        tasks: mock.todoist.tasks.map((t) => ({ ...t, priority: t.priority as 1 | 2 | 3 | 4, due_date: null, due_time: null, overdue: false })),
      },
      google: {
        configured: true,
        connected: true,
        needs_reconnect: false,
        error: null,
        all_day: mock.google.all_day,
        events: mock.google.events.map((e) => ({ title: e.title, start: toMin(e.start), end: toMin(e.end) })),
      },
      synced_at: Date.now(),
    };
  }
  throw new Error('Boss Timer needs to run as the desktop app.');
}

/** Todoist priority 4/3/2 → p1/p2/p3 flag color. Priority 1 has no flag. */
export function priorityFlag(p: number): { label: string; color: string } | null {
  if (p === 4) return { label: 'Priority 1', color: 'var(--danger)' };
  if (p === 3) return { label: 'Priority 2', color: 'var(--warn)' };
  if (p === 2) return { label: 'Priority 3', color: 'var(--accent2)' };
  return null;
}

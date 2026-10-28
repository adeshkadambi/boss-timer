// Dev-only: fake timer states for previewing timer.html in a browser.
import type { TimerView } from '../lib/api';

export function previewView(state: string): TimerView {
  const base: TimerView = {
    phase: 'running', task: { id: '1', title: 'Write first draft of Q4 planning doc', project: 'Work' },
    planned_secs: 1500, total_ms: 1_500_000, remaining_ms: 1_122_000, timed_secs: 378,
    ended_naturally: false, rating: null, focused_secs: 0, session_id: 1,
  };
  switch (state) {
    case 'paused': return { ...base, phase: 'paused', remaining_ms: 725_000 };
    case 'last': return { ...base, remaining_ms: 42_000 };
    case 'up': return { ...base, phase: 'report', remaining_ms: 0, ended_naturally: true, timed_secs: 1500 };
    case 'stopped': return { ...base, phase: 'report', remaining_ms: 0, timed_secs: 780 };
    case 'logged': return { ...base, phase: 'logged', remaining_ms: 0, timed_secs: 1500, rating: 4, focused_secs: 1200 };
    default: return base;
  }
}

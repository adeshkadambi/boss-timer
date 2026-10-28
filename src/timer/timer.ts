// Floating timer window. Renders only from Rust's timer events; buttons send commands.

import '../lib/report-errors';
import '../styles/base.css';
import './timer.css';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { errText, timer, type Tick, type TimerView } from '../lib/api';
import { esc } from '../lib/dom';
import { mascotSvg, type Mood } from '../lib/mascot';
import { inTauri, loadSettings, onSettings, settings } from '../lib/settings';

const WIDTH = 400;
const BAR = WIDTH - 24; // bar inner width
const ICON18 = (path: string) =>
  `<svg width="18" height="18" viewBox="0 0 8 8" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path d="${path}"></path></svg>`;
const P = {
  grip: 'M2 1h1v1H2z M5 1h1v1H5z M2 3h1v1H2z M5 3h1v1H5z M2 5h1v1H2z M5 5h1v1H5z',
  pause: 'M1 1h2v6H1z M5 1h2v6H5z',
  play: 'M2 1h2v6H2z M4 2h1v4H4z M5 3h1v2H5z',
  stop: 'M1 1h6v6H1z',
  bell: 'M3 0h2v1H3z M2 1h4v1H2z M1 2h6v4H1z M0 6h8v1H0z M3 7h2v1H3z',
};

const win = document.getElementById('win')!;
const content = document.getElementById('content')!;

let view: TimerView | null = null;
let remaining = 0;
let total = 1;
let rating = 0;
let error = '';
let lastHeight = 0;
let lastMascot = '';
/** The alarm effects play once per time's-up, not on every re-render. */
let alarmedSession: number | null = null;

const fmt = (ms: number) => {
  const secs = Math.ceil(ms / 1000);
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
};

// ---- derived state ----

function lastMinute() {
  return view?.phase === 'running' && remaining <= 60_000;
}

function mood(): Mood {
  if (view?.phase === 'report' && view.ended_naturally) return 'alarm';
  return view?.phase === 'running' ? 'run' : 'idle';
}

function status(): { text: string; cls: string } {
  const v = view;
  if (!v) return { text: '', cls: '' };
  switch (v.phase) {
    case 'running':
      if (lastMinute()) return { text: 'Last minute', cls: 'warn' };
      return { text: 'Focusing', cls: '' };
    case 'paused':
      return { text: 'Paused', cls: '' };
    case 'report':
      return { text: v.ended_naturally ? 'Time is up' : 'Stopped early', cls: '' };
    case 'logged':
      return { text: 'Done', cls: '' };
    default:
      return { text: '', cls: '' };
  }
}

// ---- rendering ----

function barHtml(): string {
  const v = view!;
  const phase = v.phase;
  let cls = 'done';
  let fillW = 0;
  if (phase === 'running' || phase === 'paused') {
    cls = phase === 'paused' ? 'paused' : lastMinute() ? 'last' : 'run';
    fillW = Math.round(((remaining / total) * BAR) / 4) * 4;
  } else if (phase === 'report' && v.ended_naturally) {
    cls = 'up';
  }
  const clock = fmt(phase === 'running' || phase === 'paused' ? remaining : 0);
  const blink = phase === 'report' && v.ended_naturally ? ' blink' : '';
  return `<div class="bar pxsm ${cls}" id="bar" role="timer" aria-label="${clock} remaining">
  <div class="digits${blink}" aria-hidden="true">${clock}</div>
  ${fillW > 0 ? `<div class="fill" style="width:${fillW}px" aria-hidden="true"><div class="digits" style="width:${BAR}px">${clock}</div></div>` : ''}
</div>`;
}

function headHtml(): string {
  const v = view!;
  const st = status();
  const live = v.phase === 'running' || v.phase === 'paused';
  const ringing = v.phase === 'report' && v.ended_naturally && settings().alarm_mode !== 'shake';
  const f = total ? remaining / total : 0;
  return `<div class="trow">
  <span class="grip" data-tauri-drag-region aria-hidden="true">${ICON18(P.grip).replace('width="18" height="18"', 'width="16" height="16" data-tauri-drag-region')}</span>
  <span id="mascot" data-tauri-drag-region>${mascotSvg(32, f, mood())}</span>
  <div class="ttitle" data-tauri-drag-region>
    <span class="tname" data-tauri-drag-region title="${esc(v.task?.title)}">${esc(v.task?.title ?? '')}</span>
    <span class="tstatus ${st.cls}" id="status" data-tauri-drag-region>${esc(st.text)}</span>
  </div>
  ${ringing ? `<span class="bell${alarmedSession === v.session_id ? '' : ' ring'}" role="img" aria-label="Alarm ringing">${ICON18(P.bell)}</span>` : ''}
  ${live ? `<button class="ibtn" type="button" data-act="pause" aria-label="${v.phase === 'paused' ? 'Resume' : 'Pause'}">${ICON18(v.phase === 'paused' ? P.play : P.pause)}</button>
  <button class="ibtn" type="button" data-act="stop" aria-label="Stop timer">${ICON18(P.stop)}</button>` : ''}
</div>`;
}

function questionHtml(): string {
  const v = view!;
  const title = v.ended_naturally ? 'Time’s up.' : 'Stopped.';
  const cells = [1, 2, 3, 4, 5]
    .map((n) => `<button class="cell${n <= rating ? ' on' : ''}" type="button" role="radio" aria-checked="${n === rating}" aria-label="${n * 20}% on task" data-rate="${n}"></button>`)
    .join('');
  return `<div class="q">
  <p class="q-title" id="q">${title} How much of it was on task?</p>
  <div class="cells" role="radiogroup" aria-labelledby="q">${cells}</div>
  <div class="scale"><span>Barely</span><span class="now">${rating ? `${rating * 20}% on task` : 'Pick one'}</span><span>All of it</span></div>
  <div class="qbtns">
    <button class="btn" type="button" data-act="extend">+5 min</button>
    <button class="btn primary" type="button" data-act="log"${rating ? '' : ' disabled'}>Log it</button>
  </div>
  ${error ? `<p class="sub" style="color:var(--danger)" role="alert">${esc(error)}</p>` : ''}
</div>`;
}

function loggedHtml(): string {
  const v = view!;
  const timedMin = Math.round(v.timed_secs / 60);
  const head = v.rating == null ? `Logged ${timedMin} min timed` : `Logged ${Math.round(v.focused_secs / 60)} min focused`;
  const sub = v.rating == null ? 'not rated · counts as timed only' : `of ${timedMin} min timed · added to Reports`;
  return `<div class="q">
  <p class="q-title">${head}</p>
  <p class="sub">${sub}</p>
  <div class="qbtns">
    <button class="btn" type="button" data-act="again">Again</button>
    <button class="btn primary" type="button" data-act="today">Back to today</button>
  </div>
  ${error ? `<p class="sub" style="color:var(--danger)" role="alert">${esc(error)}</p>` : ''}
</div>`;
}

function render() {
  if (!view) return;
  const v = view;
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset.act;
  content.innerHTML = headHtml() + barHtml() + (v.phase === 'report' ? questionHtml() : v.phase === 'logged' ? loggedHtml() : '');
  lastMascot = document.getElementById('mascot')!.innerHTML;
  const alarm = v.phase === 'report' && v.ended_naturally;
  win.classList.toggle('alarm', alarm);

  // Shake once per time's up, if the alarm setting includes it.
  if (alarm && alarmedSession !== v.session_id) {
    alarmedSession = v.session_id;
    if (settings().alarm_mode !== 'ring') {
      content.classList.remove('shake');
      void content.offsetWidth; // restart the animation
      content.classList.add('shake');
    }
  }
  if (focusKey) content.querySelector<HTMLElement>(`[data-act="${focusKey}"]`)?.focus();
  else if (v.phase === 'report') content.querySelector<HTMLElement>('.cell')?.focus();
  fitWindow();
}

/** Tick: update only the bar, mascot and status line. */
function renderTick() {
  if (!view) return;
  const bar = document.getElementById('bar');
  if (bar) bar.outerHTML = barHtml();
  const m = document.getElementById('mascot');
  if (m) {
    const next = mascotSvg(32, total ? remaining / total : 0, mood());
    if (next !== lastMascot) { m.innerHTML = next; lastMascot = next; }
  }
  const st = document.getElementById('status');
  if (st) {
    const s = status();
    st.textContent = s.text;
    st.className = `tstatus ${s.cls}`;
  }
}

function fitWindow() {
  if (!inTauri) return;
  const h = Math.ceil(win.getBoundingClientRect().height);
  if (h && h !== lastHeight) {
    lastHeight = h;
    void getCurrentWindow().setSize(new LogicalSize(WIDTH, h));
  }
}

// ---- input ----

async function act(fn: () => Promise<unknown>) {
  error = '';
  try {
    await fn();
  } catch (e) {
    error = errText(e);
    render();
  }
}

content.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act],[data-rate]');
  if (!el || !view) return;
  if (el.dataset.rate) {
    rating = Number(el.dataset.rate);
    render();
    return;
  }
  switch (el.dataset.act) {
    case 'pause': void act(() => (view!.phase === 'paused' ? timer.resume() : timer.pause())); break;
    case 'stop': void act(() => timer.stop()); break;
    case 'extend': void act(() => timer.extend(300)); break;
    case 'log': if (rating) void act(() => timer.rate(rating)); break;
    case 'again': void act(() => timer.again()); break;
    case 'today': void act(() => timer.close()); break;
  }
});

document.addEventListener('keydown', (ev) => {
  if (!view || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const onButton = (ev.target as HTMLElement).closest('button');
  if (ev.key === ' ' && !onButton && (view.phase === 'running' || view.phase === 'paused')) {
    ev.preventDefault();
    void act(() => (view!.phase === 'paused' ? timer.resume() : timer.pause()));
  } else if (view.phase === 'report' && /^[1-5]$/.test(ev.key)) {
    rating = Number(ev.key);
    render();
  } else if (view.phase === 'report' && ev.key === 'Enter' && rating && !onButton) {
    ev.preventDefault();
    void act(() => timer.rate(rating));
  } else if (view.phase === 'report' && ev.key === 'Escape') {
    void act(() => timer.skip());
  }
});

// ---- wiring ----

function setView(v: TimerView) {
  const prevPhase = view?.phase;
  const prevSession = view?.session_id;
  view = v;
  remaining = v.remaining_ms;
  total = v.total_ms || 1;
  // A fresh question starts unanswered.
  if (v.phase !== 'report' || prevPhase !== 'report' || prevSession !== v.session_id) rating = 0;
  if (v.phase !== prevPhase) error = '';
  render();
}

await loadSettings();
onSettings(render);

if (!inTauri && import.meta.env.DEV) {
  // Browser preview of each state for design checks: timer.html?state=running|paused|last|up|stopped|logged
  const { previewView } = await import('../dev/timer-preview');
  setView(previewView(new URLSearchParams(location.search).get('state') ?? 'running'));
  throw new Error('preview only');
}

await timer.onPhase(setView);
await timer.onTick((t: Tick) => {
  if (!view) return;
  const phaseChanged = t.phase !== view.phase;
  remaining = t.remaining_ms;
  total = t.total_ms || 1;
  if (!phaseChanged) renderTick();
});
setView(await timer.state());

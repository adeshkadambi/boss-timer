// Today view: Todoist tasks + Google Calendar day timeline (design/screens/Main.dc.html).

import { getCurrentWindow } from '@tauri-apps/api/window';
import { accounts, errText, timer, type ApiEvent as CalEvent, type ApiTask as Task, type TodayData as Today } from '../lib/api';
import { esc, patch } from '../lib/dom';
import { icon } from '../lib/icons';
import { mascotSvg } from '../lib/mascot';
import { isMac, windowControls } from '../lib/window-controls';
import { inTauri, onSettings, settings, updateSettings, type Settings } from '../lib/settings';
import { TimerWidget } from '../timer/widget';
import { loadToday, priorityFlag } from './data';

const HOUR = 88; // px per hour: tall enough for the title and time on their own lines at 30 min
const DEFAULT_START = 7; // 7 AM
const DEFAULT_END = 22; // 10 PM
const MIN_EVENT = 40; // px: short events still show the time line
const MIN_SECS = 60;
const MAX_SECS = 180 * 60;
const DEFAULT_SECS = 25 * 60;
const FOCUS_RESYNC_MS = 2 * 60_000;
// Tasks panel's share of the width. Must match the clamp in settings.rs.
const SPLIT_MIN = 0.25;
const SPLIT_MAX = 0.8;
const SPLIT_DEFAULT = 0.64;
const SPLIT_STEP = 0.02;

export interface Nav {
  openSettings(tab?: string): void;
}

interface State {
  data: Today | null;
  loading: boolean;
  /** Last sync failed outright (both sources). */
  failed: string;
  openId: string | null;
  done: Record<string, boolean>;
  dur: string;
  durError: boolean;
  note: string;
  /** Another timer is active: ask before replacing it. */
  confirm: { title: string } | null;
  scrolledToNow: boolean;
  day: string;
}

// ---- formatting -------------------------------------------------------------------------------

export function fmtDur(sec: number): string {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** "25", "25:00", "5:30" → seconds. Null if it doesn't parse. */
export function parseDur(str: string): number | null {
  const m = str.trim().match(/^(\d{1,3})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const secs = Number(m[2] ?? 0);
  if (secs > 59) return null;
  return Number(m[1]) * 60 + secs;
}

const clampDur = (s: number) => Math.min(MAX_SECS, Math.max(MIN_SECS, s));

function clock(min: number): { hm: string; ampm: string } {
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min % 60);
  return { hm: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`, ampm: h < 12 ? 'AM' : 'PM' };
}

function timeRange(e: CalEvent): string {
  const a = clock(e.start);
  const b = clock(e.end);
  return a.ampm === b.ampm ? `${a.hm}–${b.hm} ${b.ampm}` : `${a.hm} ${a.ampm}–${b.hm} ${b.ampm}`;
}

function hourLabel(h: number): string {
  return `${((h + 11) % 12) + 1} ${h % 24 < 12 ? 'AM' : 'PM'}`;
}

const nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

const dayKey = () => new Date().toDateString();

function syncedLabel(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'Synced just now';
  if (mins < 60) return `Synced ${mins} min ago`;
  return `Synced ${Math.floor(mins / 60)} h ago`;
}

// ---- calendar layout ----------------------------------------------------------------------------

interface Placed {
  e: CalEvent;
  top: number;
  h: number;
  col: number;
  cols: number;
}

/** Overlapping events (by their drawn extent) sit side by side in equal columns. */
function layoutEvents(events: CalEvent[], startH: number): Placed[] {
  const items: Placed[] = events
    .map((e) => {
      const top = (e.start / 60 - startH) * HOUR + 2;
      const h = Math.max(MIN_EVENT, ((e.end - e.start) / 60) * HOUR - 4);
      return { e, top, h, col: 0, cols: 1 };
    })
    .sort((a, b) => a.top - b.top || b.h - a.h);

  let cluster: Placed[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const ends: number[] = [];
    for (const it of cluster) {
      let c = ends.findIndex((end) => end <= it.top);
      if (c < 0) { c = ends.length; ends.push(0); }
      ends[c] = it.top + it.h + 4;
      it.col = c;
    }
    for (const it of cluster) it.cols = ends.length;
  };
  for (const it of items) {
    if (it.top >= clusterEnd) { flush(); cluster = []; clusterEnd = -Infinity; }
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.top + it.h + 4);
  }
  flush();
  return items;
}

// ---- view ---------------------------------------------------------------------------------------

export function mountToday(root: HTMLElement, nav: Nav): () => void {
  const s: State = {
    data: null,
    loading: true,
    openId: null,
    done: {},
    dur: fmtDur(clampDur(settings().last_duration_secs)),
    durError: false,
    note: '',
    confirm: null,
    failed: '',
    scrolledToNow: false,
    day: dayKey(),
  };

  root.innerHTML = `
<div class="today" data-tauri-drag-region>
  <header class="top" data-tauri-drag-region="deep">
    ${isMac ? windowControls() : ''}
    <div class="top-left">
      ${mascotSvg(40, 0.6, 'idle', 'Boss Timer')}
      <span class="divider" aria-hidden="true"></span>
      <div class="date"><span class="lbl">Today</span><h1 class="page-title" id="today-date"></h1></div>
    </div>
    <div class="top-right">
      <span class="sync meta" id="sync-status" role="status"></span>
      <button class="btn" type="button" data-act="sync">Sync</button>
      <button class="btn sq" type="button" data-act="settings" aria-label="Settings">${icon('gear')}</button>
      ${isMac ? '' : windowControls()}
    </div>
  </header>
  <main class="panels">
    <section class="pxbox panel tasks" aria-labelledby="tasks-h">
      <div class="panel-head">${icon('tasks', 16, 'style="color:var(--accent)"')}<h2 id="tasks-h" class="h2">Tasks</h2><span class="meta" id="tasks-meta"></span></div>
      <div class="scroll panel-body" id="tasks"></div>
    </section>
    <div class="split" id="split" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="tasks" aria-label="Resize tasks and calendar" aria-valuemin="${SPLIT_MIN * 100}" aria-valuemax="${SPLIT_MAX * 100}" title="Drag to resize · double-click to reset"></div>
    <section class="pxbox panel cal" aria-labelledby="cal-h">
      <div class="panel-head">${icon('calendar', 16, 'style="color:var(--accent2)"')}<h2 id="cal-h" class="h2">Calendar</h2><span class="meta" id="cal-meta"></span></div>
      <div id="allday"></div>
      <div class="scroll panel-body" id="cal" aria-label="Today's schedule"></div>
    </section>
  </main>
</div>`;

  const q = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const elDate = q('today-date');
  const elSync = q('sync-status');
  const elTasks = q('tasks');
  const elTasksMeta = q('tasks-meta');
  const elAllDay = q('allday');
  const elCal = q('cal');
  const elCalMeta = q('cal-meta');
  const elToday = root.querySelector<HTMLElement>('.today')!;
  const elPanels = root.querySelector<HTMLElement>('.panels')!;
  const elSplit = q('split');

  // ---- tasks / calendar divider ----
  let split = SPLIT_DEFAULT;
  let dragging = false;
  function applySplit(v: number) {
    split = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number.isFinite(v) ? v : SPLIT_DEFAULT));
    elPanels.style.setProperty('--split', String(split));
    elSplit.setAttribute('aria-valuenow', String(Math.round(split * 100)));
  }
  const saveSplit = () => void updateSettings({ tasks_split: split });
  applySplit(settings().tasks_split);

  elSplit.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    elSplit.setPointerCapture(ev.pointerId);
    dragging = true;
    elSplit.classList.add('dragging');
    elToday.classList.add('resizing');
  });
  elSplit.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const r = elPanels.getBoundingClientRect();
    const gutter = elSplit.offsetWidth;
    applySplit((ev.clientX - r.left - gutter / 2) / (r.width - gutter));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    elSplit.classList.remove('dragging');
    elToday.classList.remove('resizing');
    saveSplit();
  };
  elSplit.addEventListener('pointerup', endDrag);
  elSplit.addEventListener('pointercancel', endDrag);
  elSplit.addEventListener('dblclick', () => { applySplit(SPLIT_DEFAULT); saveSplit(); });
  elSplit.addEventListener('keydown', (ev) => {
    const next = { ArrowLeft: split - SPLIT_STEP, ArrowRight: split + SPLIT_STEP, Home: SPLIT_MIN, End: SPLIT_MAX }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    applySplit(next);
    saveSplit();
  });

  // ---- header ----
  function renderHeader() {
    elDate.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (s.loading) {
      elSync.innerHTML = '<span class="dot off"></span>Syncing…';
    } else if (s.failed) {
      elSync.innerHTML = '<span class="dot err"></span>Sync failed';
    } else if (s.data) {
      const err = s.data.todoist.error || s.data.google.error;
      elSync.innerHTML = `<span class="dot${err ? ' err' : ''}"></span>${esc(err ? 'Sync failed' : syncedLabel(s.data.synced_at))}`;
    }
  }

  // ---- inline timer ----
  // With the floating timer off, the timer shows under its task row, or at the top of the
  // list when that task isn't in it (completed, filtered out, or not from Todoist).
  const tw = new TimerWidget({
    floating: false,
    onRender: (alarm) => (tw.host?.closest('.task') ?? tw.host)?.classList.toggle('alarm', alarm),
  });
  const inlineTimer = () => !settings().floating_timer && tw.active;

  // ---- tasks ----
  function notConnected(msg: string): string {
    return `<div class="empty"><p>${esc(msg)}</p><button class="btn" type="button" data-act="accounts">Open Accounts</button></div>`;
  }

  const errLine = (msg: string | null) => (msg ? `<p class="hint err src-err" role="status">${esc(msg)}</p>` : '');

  function dueLabel(t: Task): string | null {
    if (t.overdue) return 'Overdue';
    if (!t.due_time) return null;
    const [h, m] = t.due_time.split(':').map(Number);
    const c = clock(h * 60 + m);
    return `${c.hm} ${c.ampm}`;
  }

  /** "# Project · @label · @label · 3:00 PM" */
  function metaLine(t: Task): string {
    const parts = [`# ${t.project}`, ...t.labels.map((l) => `@${l}`), dueLabel(t)].filter(Boolean) as string[];
    return parts.map(esc).join(' · ');
  }

  function taskRow(t: Task, timing: boolean): string {
    const done = !!s.done[t.id];
    const open = s.openId === t.id && !done && !timing;
    const flag = done ? null : priorityFlag(t.priority);
    const id = esc(t.id);
    return `<li class="task${open ? ' open' : ''}${timing ? ' timing' : ''}${done ? ' done' : ''}" data-id="${id}">
  <div class="row">
    <button class="ghost check" type="button" data-act="toggle" data-focus-key="toggle-${id}" aria-pressed="${done}" aria-label="${done ? 'Completed' : 'Mark complete'}: ${esc(t.title)}"><span class="pxsm box">${done ? icon('check', 14) : ''}</span></button>
    <button class="ghost pick" type="button" data-act="pick" data-focus-key="pick-${id}" aria-expanded="${open || timing}"${done || timing ? ' disabled' : ''}>
      <span class="rowtitle">${esc(t.title)}</span><span class="proj">${metaLine(t)}</span>
    </button>
    ${flag ? `<svg class="flag" width="16" height="16" viewBox="0 0 8 8" fill="currentColor" shape-rendering="crispEdges" role="img" aria-label="${flag.label}" style="color:${flag.color}"><path d="M1 0h1v8H1z M2 1h5v3H2z"></path></svg>` : ''}
  </div>
  ${open ? timerControls() : ''}${timing ? '<div class="inline-timer"></div>' : ''}
</li>`;
  }

  function timerControls(): string {
    return `<div class="timer-row">
    <label for="dur" class="lbl">Timer</label>
    <div class="dur">
      <button class="btn sq" type="button" data-act="dec" data-focus-key="dec" aria-label="One minute less">${icon('minus', 14)}</button>
      <input id="dur" class="pxsm dur-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="6" data-focus-key="dur" value="${esc(s.dur)}" aria-describedby="dur-hint" aria-invalid="${s.durError}">
      <button class="btn sq" type="button" data-act="inc" data-focus-key="inc" aria-label="One minute more">${icon('plus', 14)}</button>
      <span id="dur-hint" class="hint${s.durError ? ' err' : ''}">${s.durError ? 'Use MM:SS, 1–180 min' : 'MM:SS'}</span>
    </div>
    <button class="btn primary start" type="button" data-act="start" data-focus-key="start">${icon('play', 14)}Start</button>
  </div>
  ${s.confirm ? `<div class="confirm" role="alert"><p>“${esc(s.confirm.title)}” is still on the timer. Replace it?</p>
    <div class="confirm-btns"><button class="btn" type="button" data-act="keep" data-focus-key="keep">Keep it</button><button class="btn primary" type="button" data-act="replace" data-focus-key="replace">Replace</button></div></div>` : ''}
  ${s.note ? `<p class="hint note" role="status">${esc(s.note)}</p>` : ''}`;
  }

  function tasksHtml(timingId: string | null): string {
    const td = s.data?.todoist;
    if (!td) {
      elTasksMeta.textContent = '';
      return s.failed ? `<div class="empty"><p>${esc(s.failed)}</p></div>` : '<p class="empty-line meta">Loading tasks…</p>';
    }
    if (!td.connected) { elTasksMeta.textContent = 'Todoist'; return notConnected("Todoist isn't connected."); }
    if (td.unauthorized) { elTasksMeta.textContent = 'Todoist'; return notConnected('Todoist rejected the token. Paste a new one in Accounts.'); }
    const open = td.tasks.filter((t) => !s.done[t.id]).length;
    elTasksMeta.textContent = `Todoist · ${open} open`;
    if (td.tasks.length === 0) {
      const none = settings().todoist_scope === 'today' ? 'No tasks due today' : 'No tasks due today or overdue';
      return `${errLine(td.error)}<div class="empty"><p>${none}</p></div>`;
    }
    return `${errLine(td.error)}<ul class="task-list">${td.tasks.map((t) => taskRow(t, t.id === timingId)).join('')}</ul>`;
  }

  function renderTasks() {
    const showTimer = inlineTimer();
    const taskId = showTimer ? tw.view?.task?.id ?? null : null;
    const inList = !!taskId && !!s.data?.todoist.tasks.some((t) => t.id === taskId);
    const keep = tw.focusKey();
    patch(elTasks, (showTimer && !inList ? '<div class="inline-timer solo"></div>' : '') + tasksHtml(inList ? taskId : null));
    tw.showTitle = !inList;
    const host = elTasks.querySelector<HTMLElement>('.inline-timer');
    if (host) tw.render(host, keep);
    else tw.host = null;
  }

  // ---- calendar ----
  function renderCalendar() {
    const g = s.data?.google;
    if (!g) {
      elCalMeta.textContent = ''; elAllDay.innerHTML = '';
      elCal.innerHTML = s.failed ? '' : '<p class="empty-line meta">Loading calendar…</p>';
      return;
    }
    if (!g.configured || !g.connected) { elCalMeta.textContent = 'Google'; elAllDay.innerHTML = ''; patch(elCal, notConnected("Google Calendar isn't connected.")); return; }
    if (g.needs_reconnect) { elCalMeta.textContent = 'Google'; elAllDay.innerHTML = ''; patch(elCal, notConnected('Google needs you to sign in again.')); return; }

    elCalMeta.textContent = `Google · ${g.events.length + g.all_day.length} events`;
    elAllDay.innerHTML = errLine(g.error) + (g.all_day.length
      ? `<div class="allday"><span class="hint">All day</span><ul>${g.all_day.map((e) => `<li class="allday-ev">${esc(e.title)}</li>`).join('')}</ul></div>`
      : '');

    if (g.events.length === 0 && g.all_day.length === 0) {
      patch(elCal, '<div class="empty"><p>Nothing on the calendar</p></div>');
      return;
    }

    const startH = Math.max(0, Math.min(DEFAULT_START, ...g.events.map((e) => Math.floor(e.start / 60))));
    const endH = Math.min(24, Math.max(DEFAULT_END, ...g.events.map((e) => Math.ceil(e.end / 60))));
    const gridH = (endH - startH) * HOUR + 2;
    const now = nowMin();

    const hours: string[] = [];
    for (let h = startH; h <= endH; h++) hours.push(`<span class="hour" style="top:${(h - startH) * HOUR}px">${hourLabel(h)}</span>`);

    const events = layoutEvents(g.events, startH).map((p) => {
      const past = p.e.end <= now;
      const w = p.cols > 1 ? `calc((100% - 8px) / ${p.cols} - 4px)` : 'calc(100% - 8px)';
      const left = `calc(4px + (100% - 8px) * ${p.col} / ${p.cols})`;
      return `<div class="ev${past ? ' past' : ''}" style="top:${p.top}px;height:${p.h}px;left:${left};width:${w}">
  <span class="ev-title">${esc(p.e.title)}</span><span class="ev-time">${timeRange(p.e)}</span>
</div>`;
    });

    const inRange = now >= startH * 60 && now <= endH * 60;
    const nowTop = Math.round((now / 60 - startH) * HOUR);
    const c = clock(now);
    const nowLine = inRange ? `<div class="now" role="img" aria-label="Now, ${c.hm} ${c.ampm}" style="top:${nowTop}px"><span></span></div>` : '';

    const keep = elCal.scrollTop;
    elCal.innerHTML = `<div class="timeline">
  <div class="hours" style="height:${gridH}px">${hours.join('')}</div>
  <div class="grid" style="height:${gridH}px">${events.join('')}${nowLine}</div>
</div>`;
    if (!s.scrolledToNow) {
      elCal.scrollTop = Math.max(0, (inRange ? nowTop : (9 - startH) * HOUR) - 160);
      s.scrolledToNow = true;
    } else {
      elCal.scrollTop = keep;
    }
  }

  // ---- data ----
  let syncing: Promise<void> | null = null;
  function sync(): Promise<void> {
    syncing ??= (async () => {
      s.loading = true;
      renderHeader();
      try {
        const next = await loadToday();
        const prev = s.data;
        // Keep the last good data on screen when a source fails.
        if (prev && next.todoist.error && !next.todoist.unauthorized && next.todoist.tasks.length === 0) next.todoist.tasks = prev.todoist.tasks;
        if (prev && next.google.error && !next.google.needs_reconnect && next.google.events.length === 0) {
          next.google.events = prev.google.events;
          next.google.all_day = prev.google.all_day;
        }
        s.data = next;
        s.failed = '';
        // Completed tasks drop out of Todoist's filter; forget their local state.
        const ids = new Set(next.todoist.tasks.map((t) => t.id));
        s.done = Object.fromEntries(Object.entries(s.done).filter(([id]) => ids.has(id)));
      } catch (e) {
        s.failed = errText(e);
      } finally {
        s.loading = false;
        syncing = null;
      }
      renderHeader();
      renderTasks();
      renderCalendar();
    })();
    return syncing;
  }

  async function toggleDone(id: string) {
    const wasDone = !!s.done[id];
    s.done = { ...s.done, [id]: !wasDone };
    if (s.openId === id) s.openId = null;
    renderTasks();
    if (!inTauri) return;
    try {
      await (wasDone ? accounts.reopen(id) : accounts.complete(id));
    } catch (e) {
      // Roll back the optimistic update.
      s.done = { ...s.done, [id]: wasDone };
      if (s.data) s.data.todoist.error = errText(e);
      renderTasks();
    }
  }

  async function start(replace: boolean) {
    const secs = commitDur();
    const t = s.data?.todoist.tasks.find((x) => x.id === s.openId);
    if (secs == null || !t) return;
    if (!inTauri) {
      void updateSettings({ last_duration_secs: secs });
      s.note = 'The timer runs in the desktop app.';
      renderTasks();
      return;
    }
    try {
      const r = await timer.start({ id: t.id, title: t.title, project: t.project }, secs, replace);
      s.confirm = r.started ? null : { title: r.active_title ?? 'Another task' };
      if (r.started && !settings().floating_timer) s.openId = null;
      s.note = '';
    } catch (e) {
      s.note = errText(e);
    }
    renderTasks();
    if (s.confirm) elTasks.querySelector<HTMLElement>('[data-act="replace"]')?.focus();
  }

  // ---- events ----
  function setDur(secs: number) {
    s.dur = fmtDur(clampDur(secs));
    s.durError = false;
    const input = elTasks.querySelector<HTMLInputElement>('#dur');
    if (input) { input.value = s.dur; input.setAttribute('aria-invalid', 'false'); }
    const hint = elTasks.querySelector<HTMLElement>('#dur-hint');
    if (hint) { hint.textContent = 'MM:SS'; hint.classList.remove('err'); }
  }

  function commitDur(): number | null {
    const secs = parseDur(s.dur);
    if (secs == null) {
      s.durError = true;
      renderTasks();
      return null;
    }
    setDur(secs);
    return clampDur(secs);
  }

  const onClick = (ev: MouseEvent) => {
    if (tw.handleClick(ev)) return;
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn || !root.contains(btn)) return;
    const act = btn.dataset.act;
    const id = btn.closest<HTMLElement>('.task')?.dataset.id;
    switch (act) {
      case 'sync': void sync(); break;
      case 'settings': nav.openSettings(); break;
      case 'accounts': nav.openSettings('accounts'); break;
      case 'toggle':
        if (id) void toggleDone(id);
        break;
      case 'pick':
        if (!id) break;
        s.openId = s.openId === id ? null : id;
        s.note = '';
        s.confirm = null;
        renderTasks();
        break;
      case 'keep':
        s.confirm = null;
        renderTasks();
        break;
      case 'replace':
        void start(true);
        break;
      case 'dec': setDur((parseDur(s.dur) ?? DEFAULT_SECS) - 60); break;
      case 'inc': setDur((parseDur(s.dur) ?? DEFAULT_SECS) + 60); break;
      case 'start':
        void start(false);
        break;
    }
  };

  const onInput = (ev: Event) => {
    const el = ev.target as HTMLInputElement;
    if (el.id === 'dur') s.dur = el.value;
  };

  const onChange = (ev: Event) => {
    const el = ev.target as HTMLInputElement;
    if (el.id === 'dur') commitDur();
  };

  const onKey = (ev: KeyboardEvent) => {
    const el = ev.target as HTMLElement;
    // Timer keys work in the inline timer, and anywhere nothing else has focus.
    if (inlineTimer() && (tw.host?.contains(el) || el === document.body) && tw.handleKey(ev)) return;
    if (el.id !== 'dur') return;
    if (ev.key === 'Enter') { ev.preventDefault(); root.querySelector<HTMLElement>('[data-act="start"]')?.click(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); setDur((parseDur(s.dur) ?? DEFAULT_SECS) + 60); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setDur((parseDur(s.dur) ?? DEFAULT_SECS) - 60); }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  document.addEventListener('keydown', onKey);

  // The now line and "Synced N min ago" move every minute; a new day reloads.
  const tick = window.setInterval(() => {
    if (dayKey() !== s.day) { s.day = dayKey(); s.scrolledToNow = false; void sync(); return; }
    renderHeader();
    renderCalendar();
  }, 30_000);

  // Sync on the interval setting, and on focus when the last sync is over 2 minutes old.
  let every: number | undefined;
  const schedule = (mins: number) => {
    window.clearInterval(every);
    every = window.setInterval(() => void sync(), mins * 60_000);
  };
  schedule(settings().sync_interval_min);
  let lastSettings: Settings = settings();
  const offSettings = onSettings((next) => {
    const was = lastSettings;
    lastSettings = next;
    if (next.sync_interval_min !== was.sync_interval_min) schedule(next.sync_interval_min);
    const resync = next.todoist_scope !== was.todoist_scope
      || JSON.stringify(next.google_calendars) !== JSON.stringify(was.google_calendars)
      || next.google_account !== was.google_account;
    if (resync) void sync();
    if (next.floating_timer !== was.floating_timer) renderTasks();
    if (!dragging && Math.abs(next.tasks_split - split) > 0.001) applySplit(next.tasks_split);
  });
  let offFocus: (() => void) | undefined;
  let disposed = false;
  const offTimer: (() => void)[] = [];
  const keepOff = (p: Promise<() => void>) => void p.then((un) => { if (disposed) un(); else offTimer.push(un); });
  if (inTauri) {
    keepOff(timer.onPhase((v) => {
      const startedNow = v.phase === 'running' && v.session_id !== tw.view?.session_id;
      tw.setView(v);
      if (settings().floating_timer) return;
      if (startedNow) { s.openId = null; s.confirm = null; s.note = ''; }
      renderTasks();
      if (startedNow) tw.host?.scrollIntoView({ block: 'nearest' });
    }));
    keepOff(timer.onTick((t) => { if (inlineTimer()) tw.tick(t); }));
    void timer.state().then((v) => { if (disposed) return; tw.setView(v); if (inlineTimer()) renderTasks(); });
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      const last = s.data?.synced_at ?? 0;
      if (focused && !s.loading && Date.now() - last > FOCUS_RESYNC_MS) void sync();
    }).then((un) => { if (disposed) un(); else offFocus = un; });
  } else if (import.meta.env.DEV) {
    // Browser preview of the inline timer: ?timer=running|paused|last|up|stopped|logged[&solo]
    const q = new URLSearchParams(location.search);
    const st = q.get('timer');
    if (st) {
      void import('../dev/timer-preview').then(({ previewView }) => {
        const v = previewView(st);
        if (q.has('solo') && v.task) v.task.id = null;
        tw.setView(v);
        void updateSettings({ floating_timer: false });
        renderTasks();
      });
    }
  }

  renderHeader();
  renderTasks();
  renderCalendar();
  void sync();

  return () => {
    disposed = true;
    window.clearInterval(tick);
    window.clearInterval(every);
    offSettings();
    offFocus?.();
    offTimer.forEach((un) => un());
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    document.removeEventListener('keydown', onKey);
  };
}

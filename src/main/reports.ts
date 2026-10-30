// Reports tab (design/screens/Reports.dc.html): stats, year heatmap, day details, the day's
// sessions, and a form to log time worked without a timer.

import { listen } from '@tauri-apps/api/event';
import { errText, getReport, sessions, type DayRow, type RecentTask, type Report, type SessionRow } from '../lib/api';
import { esc } from '../lib/dom';
import { inTauri } from '../lib/settings';
import { lastTasks } from './data';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY = 86_400_000;
const LEVELS = [
  { label: '0', bg: 'var(--panel2)' },
  { label: 'under 1h', bg: 'color-mix(in srgb, var(--accent) 30%, var(--panel2))' },
  { label: '1–2h', bg: 'color-mix(in srgb, var(--accent) 55%, var(--panel2))' },
  { label: '2–3.5h', bg: 'color-mix(in srgb, var(--accent) 78%, var(--panel2))' },
  { label: '3.5h+', bg: 'var(--accent)' },
];

const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Adds days in local time (DST-safe). */
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function level(secs: number): number {
  const h = secs / 3600;
  if (!secs) return 0;
  if (h < 1) return 1;
  if (h < 2) return 2;
  if (h < 3.5) return 3;
  return 4;
}

export function fmtHM(secs: number): string {
  const m = Math.round(secs / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const hours = (secs: number) => `${Math.round(secs / 3600)}h`;
const MAX_MINUTES = 12 * 60;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** 14:05 → "2:05 PM" */
const clock12 = (d: Date) => `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
const dayName = (k: string) => {
  const d = new Date(`${k}T00:00:00`);
  return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

interface LogForm {
  title: string;
  project: string;
  /** Set when the title matches a known task. */
  taskId: string | null;
  /** The project was filled in from a matching task, so it may be replaced by the next match. */
  autoProject: boolean;
  date: string;
  start: string;
  minutes: string;
  /** '1'–'5', 'none' (not rated), or '' (not picked yet). */
  rating: string;
}
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

export function mountReports(panel: HTMLElement): () => void {
  let report: Report | null = null;
  let year = new Date().getFullYear();
  let sel = key(new Date());
  let err = '';
  // The selected day's sessions.
  let day: { date: string; rows: SessionRow[] } | null = null;
  let confirmDel: number | null = null;
  let dayErr = '';
  // Log-time form.
  let form: LogForm | null = null;
  let formErr = '';
  let saving = false;
  let flash = '';
  let suggestions: RecentTask[] = [];

  async function loadDay() {
    if (!inTauri) return;
    const want = sel;
    try {
      const rows = await sessions.day(want);
      if (want !== sel) return;
      day = { date: want, rows };
      dayErr = '';
    } catch (e) {
      dayErr = errText(e);
    }
    renderDay();
  }

  async function load() {
    if (!inTauri) {
      report = { year, years: [year], days: [], totals: { focused_secs: 0, timed_secs: 0, sessions: 0 }, streaks: { current: 0, longest: 0 } };
    } else {
      try {
        report = await getReport(year);
        err = '';
      } catch (e) {
        err = errText(e);
      }
    }
    render();
    void loadDay();
  }

  function render(focusSel = false) {
    if (!report) {
      panel.innerHTML = `<h2 class="lbl">Reports</h2><p class="meta">${err ? esc(err) : 'Loading…'}</p>`;
      return;
    }
    const r = report;
    const byDate = new Map<string, DayRow>(r.days.map((d) => [d.date, d]));
    const today = midnight(new Date());
    const jan1 = new Date(year, 0, 1);
    const dec31 = new Date(year, 11, 31);
    const gridStart = addDays(jan1, -jan1.getDay());
    const gridEnd = addDays(dec31, 6 - dec31.getDay());
    const weeks = Math.round((gridEnd.getTime() - gridStart.getTime()) / DAY / 7) + 1;
    const activeDays = r.days.filter((d) => d.focused_secs > 0).length;

    const cells: string[] = [];
    for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) {
      const k = key(d);
      if (d.getFullYear() !== year) {
        cells.push('<span class="cell-pad" aria-hidden="true"></span>');
        continue;
      }
      const row = byDate.get(k);
      const future = d > today;
      const label = `${MONTHS[d.getMonth()]} ${d.getDate()}: ${future ? 'upcoming' : row?.focused_secs ? `${fmtHM(row.focused_secs)} focused` : 'no focus logged'}`;
      const on = k === sel;
      cells.push(`<button class="hcell${future ? ' future' : ''}${on ? ' sel' : ''}" type="button" data-day="${k}" tabindex="${on ? 0 : -1}" aria-pressed="${on}" aria-label="${label}" style="background:${future ? 'transparent' : LEVELS[level(row?.focused_secs ?? 0)].bg}"></button>`);
    }
    const months = MONTHS.map((m, i) => {
      // Round to whole days first: a DST change makes one day 23 or 25 hours long.
      const col = Math.floor(Math.round((new Date(year, i, 1).getTime() - gridStart.getTime()) / DAY) / 7) + 1;
      return `<span style="grid-column:${col} / span 4">${m}</span>`;
    }).join('');

    const sd = new Date(`${sel}T00:00:00`);
    const srow = byDate.get(sel);
    const details = srow && srow.timed_secs > 0
      ? `<div class="dd-stats">
          <span><b>${fmtHM(srow.focused_secs)}</b> <span class="dim">focused</span></span>
          <span><b>${fmtHM(srow.timed_secs)}</b> <span class="dim">timed</span></span>
          <span><b>${Math.round((srow.focused_secs / srow.timed_secs) * 100)}%</b> <span class="dim">on task</span></span>
          <span><b>${srow.sessions}</b> <span class="dim">${srow.sessions === 1 ? 'session' : 'sessions'}</span></span>
        </div>`
      : `<span class="dim">${sd > today ? 'Upcoming' : 'No focus logged'}</span>`;

    const prevScroll = panel.querySelector<HTMLElement>('.heat-scroll')?.scrollLeft;
    const t = r.totals;
    const stats = [
      { label: 'Focused', value: hours(t.focused_secs), sub: `of ${hours(t.timed_secs)} timed` },
      { label: 'On task', value: t.timed_secs ? `${Math.round((t.focused_secs / t.timed_secs) * 100)}%` : '—', sub: 'average of your answers' },
      { label: 'Current streak', value: days(r.streaks.current), sub: 'days in a row with focus' },
      { label: 'Longest streak', value: days(r.streaks.longest), sub: 'best run so far' },
    ];

    panel.innerHTML = `
<div class="rep-head"><h2 class="lbl">Reports</h2><span class="meta">All time · focused hours come from your on-task answer after each timer</span></div>
${err ? `<p class="hint err">${esc(err)}</p>` : ''}
<div class="stat-grid">${stats.map((s) => `<div class="stat"><span class="lbl">${s.label}</span><span class="stat-v">${s.value}</span><span class="hint">${s.sub}</span></div>`).join('')}</div>
<div class="stack">
  <div class="year-row">
    ${r.years.length > 1
      ? `<label class="vh" for="year">Year</label><select id="year" class="sel pxsm">${r.years.map((y) => `<option value="${y}"${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select>`
      : `<h3 class="h3">${year}</h3>`}
    <span class="meta">${days(activeDays)} with focus time</span>
  </div>
  <div class="heat-scroll scroll-x">
    <div class="heat">
      <span></span>
      <div class="heat-months" style="grid-template-columns:repeat(${weeks},14px)">${months}</div>
      <div class="heat-dow" aria-hidden="true"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
      <div class="heat-grid" role="group" aria-label="Focused hours per day, ${year}">${cells.join('')}</div>
    </div>
  </div>
  <div class="legend"><span>Hours focused</span>${LEVELS.map((l) => `<span class="lg"><span style="background:${l.bg}"></span>${l.label}</span>`).join('')}</div>
</div>
<div class="day-box">
  <div class="day-detail"><span class="dd-date">${DOW[sd.getDay()]}, ${MONTHS[sd.getMonth()]} ${sd.getDate()}</span>${details}
    ${form ? '' : `<button class="btn dd-log" type="button" data-ract="open-log">+ Log time</button>`}</div>
  ${flash ? `<p class="hint flash" role="status">${esc(flash)}</p>` : ''}
  <div id="log-form"></div>
  <div id="day-list"></div>
</div>`;
    renderForm();
    renderDay();
    // Keep the scroll position across re-renders; on first render, bring the selected day into view.
    const sc = panel.querySelector<HTMLElement>('.heat-scroll');
    const cell = panel.querySelector<HTMLElement>('.hcell.sel');
    if (sc) {
      if (prevScroll != null) sc.scrollLeft = prevScroll;
      else if (cell) sc.scrollLeft = cell.offsetLeft - sc.clientWidth / 2;
    }
    if (focusSel && cell) {
      cell.focus({ preventScroll: true });
      if (sc && (cell.offsetLeft < sc.scrollLeft || cell.offsetLeft > sc.scrollLeft + sc.clientWidth - 20)) {
        sc.scrollLeft = cell.offsetLeft - sc.clientWidth / 2;
      }
    }
  }

  function select(k: string, focus = false) {
    if (k !== sel) {
      confirmDel = null;
      flash = '';
    }
    sel = k;
    render(focus);
    if (day?.date !== sel) void loadDay();
  }

  // ---- the selected day's sessions ----

  function renderDay() {
    const el = panel.querySelector<HTMLElement>('#day-list');
    if (!el) return;
    if (dayErr) {
      el.innerHTML = `<p class="hint err">${esc(dayErr)}</p>`;
      return;
    }
    const rows = day?.date === sel ? day.rows : [];
    if (!rows.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<ul class="day-list" aria-label="Sessions on ${esc(dayName(sel))}">${rows.map((r) => {
      const t = new Date(r.started_at);
      const rated = r.rating == null ? 'not rated' : `${r.rating * 20}% on task`;
      const del = !r.manual
        ? ''
        : confirmDel === r.id
          ? `<span class="ds-confirm"><button class="btn danger sm" type="button" data-del="${r.id}">Delete</button><button class="btn sm" type="button" data-ract="keep">Keep</button></span>`
          : `<button class="btn sm" type="button" data-ask-del="${r.id}" aria-label="Delete ${esc(r.title)} at ${clock12(t)}">Delete</button>`;
      return `<li class="ds">
  <span class="ds-time">${clock12(t)}</span>
  <span class="ds-title">${esc(r.title)}${r.project ? ` <span class="dim">· ${esc(r.project)}</span>` : ''}</span>
  <span class="ds-dur">${fmtHM(r.timed_secs)} <span class="dim">· ${rated}${r.manual ? ' · logged by hand' : ''}</span></span>
  ${del}
</li>`;
    }).join('')}</ul>`;
  }

  async function deleteSession(id: number) {
    try {
      await sessions.deleteManual(id);
      confirmDel = null;
      flash = 'Deleted.';
      // reports://changed reloads the report and the day.
    } catch (e) {
      dayErr = errText(e);
      renderDay();
    }
  }

  // ---- log time ----

  function openForm() {
    const today = key(new Date());
    const date = sel > today ? today : sel;
    const minutes = 60;
    // Today: default to an hour that just ended. Other days: 9 AM.
    let start = '09:00';
    if (date === today) {
      const d = new Date(Date.now() - minutes * 60_000);
      d.setMinutes(d.getMinutes() - (d.getMinutes() % 5));
      start = d.getDate() === new Date().getDate() ? hhmm(d) : '00:00';
    }
    form = { title: '', project: '', taskId: null, autoProject: false, date, start, minutes: String(minutes), rating: '' };
    formErr = '';
    flash = '';
    render();
    panel.querySelector<HTMLInputElement>('#lf-title')?.focus();
    if (inTauri) {
      void sessions.recentTasks().then((r) => {
        suggestions = r;
        renderSuggestions();
      }).catch(() => {});
    }
  }

  /** Today's Todoist tasks first, then tasks logged before. Unique by title and project. */
  function taskChoices(): RecentTask[] {
    const seen = new Set<string>();
    const out: RecentTask[] = [];
    const add = (t: RecentTask) => {
      const k = `${t.title}\u0000${t.project ?? ''}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    };
    for (const t of lastTasks()) add({ task_id: t.id, title: t.title, project: t.project || null });
    suggestions.forEach(add);
    return out;
  }

  function renderSuggestions() {
    const dl = panel.querySelector<HTMLElement>('#lf-tasks');
    if (dl) dl.innerHTML = taskChoices().map((t) => `<option value="${esc(t.title)}">${esc(t.project ?? '')}</option>`).join('');
  }

  function summary(f: LogForm): string {
    const m = Number(f.minutes);
    if (!Number.isInteger(m) || m < 1 || m > MAX_MINUTES) return `Duration is 1 to ${MAX_MINUTES} minutes.`;
    const timed = m * 60;
    const when = /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? ` to ${dayName(f.date)}` : '';
    if (f.rating === 'none') return `Adds ${fmtHM(timed)} timed${when}, not rated, so no focused time.`;
    if (!f.rating) return `Adds ${fmtHM(timed)} timed${when}. Pick how much was on task.`;
    return `Adds ${fmtHM(timed)} timed and ${fmtHM((timed * Number(f.rating)) / 5)} focused${when}.`;
  }

  function renderForm() {
    const el = panel.querySelector<HTMLElement>('#log-form');
    if (!el) return;
    if (!form) {
      el.innerHTML = '';
      return;
    }
    const f = form;
    const opt = (v: string, label: string) => `<option value="${v}"${f.rating === v ? ' selected' : ''}>${label}</option>`;
    el.innerHTML = `<form class="log-form" id="logf" novalidate aria-labelledby="logf-h">
  <h3 class="h3" id="logf-h">Log time without a timer</h3>
  <div class="lf-grid">
    <label class="lf wide"><span class="hint">Task</span>
      <input id="lf-title" class="txt pxsm" name="title" list="lf-tasks" autocomplete="off" spellcheck="false" maxlength="300" placeholder="Pick a task or type one" value="${esc(f.title)}"></label>
    <label class="lf"><span class="hint">Project (optional)</span>
      <input id="lf-project" class="txt pxsm" name="project" autocomplete="off" maxlength="300" value="${esc(f.project)}"></label>
    <label class="lf"><span class="hint">Date</span>
      <input id="lf-date" class="txt pxsm" type="date" name="date" max="${key(new Date())}" placeholder="YYYY-MM-DD" value="${esc(f.date)}"></label>
    <label class="lf"><span class="hint">Start</span>
      <input id="lf-start" class="txt pxsm" type="time" name="start" placeholder="HH:MM" value="${esc(f.start)}"></label>
    <label class="lf"><span class="hint">Minutes</span>
      <input id="lf-minutes" class="txt pxsm" type="number" name="minutes" min="1" max="${MAX_MINUTES}" step="1" inputmode="numeric" value="${esc(f.minutes)}"></label>
    <label class="lf"><span class="hint">On task</span>
      <select id="lf-rating" class="sel pxsm" name="rating">
        ${f.rating ? '' : '<option value="" selected disabled>Pick one</option>'}
        ${opt('5', 'All of it (100%)')}${opt('4', '80%')}${opt('3', '60%')}${opt('2', '40%')}${opt('1', 'Barely (20%)')}${opt('none', 'Not rated (timed only)')}
      </select></label>
  </div>
  <datalist id="lf-tasks"></datalist>
  <p class="hint" id="lf-sum" aria-live="polite">${esc(summary(f))}</p>
  ${formErr ? `<p class="hint err" role="alert">${esc(formErr)}</p>` : ''}
  <div class="btn-row">
    <button class="btn primary" type="submit"${saving ? ' disabled' : ''}>${saving ? 'Logging…' : 'Log it'}</button>
    <button class="btn" type="button" data-ract="cancel-log">Cancel</button>
  </div>
</form>`;
    renderSuggestions();
  }

  function closeForm() {
    form = null;
    formErr = '';
    render();
    panel.querySelector<HTMLElement>('[data-ract="open-log"]')?.focus();
  }

  /** Keeps the form state in step with the fields, so re-renders keep what was typed. */
  function onFormInput(el: HTMLInputElement | HTMLSelectElement) {
    if (!form) return;
    switch (el.name) {
      case 'title': {
        form.title = el.value;
        const match = taskChoices().find((t) => t.title === el.value.trim());
        form.taskId = match?.task_id ?? null;
        if (match && (form.autoProject || !form.project.trim())) {
          form.project = match.project ?? '';
          form.autoProject = true;
          const p = panel.querySelector<HTMLInputElement>('#lf-project');
          if (p) p.value = form.project;
        }
        break;
      }
      case 'project': form.project = el.value; form.autoProject = false; break;
      case 'date': form.date = el.value; break;
      case 'start': form.start = el.value; break;
      case 'minutes': form.minutes = el.value; break;
      case 'rating': form.rating = el.value; break;
      default: return;
    }
    const sum = panel.querySelector('#lf-sum');
    if (sum) sum.textContent = summary(form);
  }

  async function submit() {
    if (!form || saving) return;
    const f = form;
    const fail = (msg: string, field: string) => {
      formErr = msg;
      renderForm();
      panel.querySelector<HTMLElement>(`#lf-${field}`)?.focus();
    };
    if (!f.title.trim()) return fail('Add the task you worked on.', 'title');
    const minutes = Number(f.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return fail(`Duration must be 1 to ${MAX_MINUTES} minutes.`, 'minutes');
    if (!f.rating) return fail('Pick how much was on task.', 'rating');
    saving = true;
    formErr = '';
    renderForm();
    try {
      await sessions.logManual({
        task_id: f.taskId,
        title: f.title.trim(),
        project: f.project.trim() || null,
        date: f.date,
        start: f.start,
        minutes,
        rating: f.rating === 'none' ? null : Number(f.rating),
      });
      saving = false;
      form = null;
      flash = `Logged ${fmtHM(minutes * 60)} on ${dayName(f.date)}.`;
      const y = Number(f.date.slice(0, 4));
      sel = f.date;
      day = null;
      if (y !== year) year = y;
      await load();
      panel.querySelector<HTMLElement>('[data-ract="open-log"]')?.focus();
    } catch (e) {
      saving = false;
      const msg = errText(e);
      fail(msg, /date/i.test(msg) ? 'date' : /time/i.test(msg) ? 'start' : /duration/i.test(msg) ? 'minutes' : /on task/i.test(msg) ? 'rating' : 'title');
    }
  }

  const onClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    const c = t.closest<HTMLElement>('[data-day]');
    if (c) return select(c.dataset.day!);
    const a = t.closest<HTMLElement>('[data-ract],[data-del],[data-ask-del]');
    if (!a) return;
    if (a.dataset.askDel) {
      confirmDel = Number(a.dataset.askDel);
      renderDay();
      panel.querySelector<HTMLElement>(`[data-del="${confirmDel}"]`)?.focus();
    } else if (a.dataset.del) {
      void deleteSession(Number(a.dataset.del));
    } else if (a.dataset.ract === 'keep') {
      const id = confirmDel;
      confirmDel = null;
      renderDay();
      panel.querySelector<HTMLElement>(`[data-ask-del="${id}"]`)?.focus();
    } else if (a.dataset.ract === 'open-log') openForm();
    else if (a.dataset.ract === 'cancel-log') closeForm();
  };
  const onSubmit = (ev: SubmitEvent) => {
    if ((ev.target as HTMLElement).id !== 'logf') return;
    ev.preventDefault();
    void submit();
  };
  const onInput = (ev: Event) => {
    const el = ev.target as HTMLInputElement;
    if (el.closest('#logf')) onFormInput(el);
  };
  const onChange = (ev: Event) => {
    const el = ev.target as HTMLSelectElement;
    if (el.closest('#logf')) return onFormInput(el);
    if (el.id !== 'year') return;
    year = Number(el.value);
    const now = new Date();
    sel = year === now.getFullYear() ? key(now) : `${year}-01-01`;
    void load();
  };
  // Roving focus: arrows move a day (left/right) or a week (up/down).
  const onKey = (ev: KeyboardEvent) => {
    // Esc in the form closes it (and doesn't leave Settings).
    if (ev.key === 'Escape' && form && (ev.target as HTMLElement).closest('#logf')) {
      ev.stopPropagation();
      closeForm();
      return;
    }
    const c = (ev.target as HTMLElement).closest<HTMLElement>('[data-day]');
    if (!c) return;
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[ev.key];
    if (!step) return;
    ev.preventDefault();
    const next = addDays(new Date(`${c.dataset.day}T00:00:00`), step);
    if (next.getFullYear() === year) select(key(next), true);
  };

  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChange);
  panel.addEventListener('keydown', onKey);
  panel.addEventListener('submit', onSubmit);
  panel.addEventListener('input', onInput);
  let off: (() => void) | undefined;
  let disposed = false;
  if (inTauri) {
    void listen('reports://changed', () => void load()).then((un) => { if (disposed) un(); else off = un; });
  }
  render();
  void load();

  return () => {
    disposed = true;
    off?.();
    panel.removeEventListener('click', onClick);
    panel.removeEventListener('change', onChange);
    panel.removeEventListener('keydown', onKey);
    panel.removeEventListener('submit', onSubmit);
    panel.removeEventListener('input', onInput);
  };
}

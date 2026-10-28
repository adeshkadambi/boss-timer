// Reports tab (design/screens/Reports.dc.html): stats, year heatmap, day details.

import { listen } from '@tauri-apps/api/event';
import { errText, getReport, type DayRow, type Report } from '../lib/api';
import { esc } from '../lib/dom';
import { inTauri } from '../lib/settings';

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
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

export function mountReports(panel: HTMLElement): () => void {
  let report: Report | null = null;
  let year = new Date().getFullYear();
  let sel = key(new Date());
  let err = '';

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
<div class="day-detail"><span class="dd-date">${DOW[sd.getDay()]}, ${MONTHS[sd.getMonth()]} ${sd.getDate()}</span>${details}</div>`;
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
    sel = k;
    render(focus);
  }

  const onClick = (ev: MouseEvent) => {
    const c = (ev.target as HTMLElement).closest<HTMLElement>('[data-day]');
    if (c) select(c.dataset.day!);
  };
  const onChange = (ev: Event) => {
    const el = ev.target as HTMLSelectElement;
    if (el.id !== 'year') return;
    year = Number(el.value);
    const now = new Date();
    sel = year === now.getFullYear() ? key(now) : `${year}-01-01`;
    void load();
  };
  // Roving focus: arrows move a day (left/right) or a week (up/down).
  const onKey = (ev: KeyboardEvent) => {
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
  };
}

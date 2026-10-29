// The timer's display and controls: the bar, the mascot, pause/stop, the on-task question and
// the logged summary. Used by the floating window and by the inline timer in Today.
// It renders only from Rust's timer events; buttons send commands.

import './widget.css';
import { errText, timer, type Tick, type TimerView } from '../lib/api';
import { esc } from '../lib/dom';
import { mascotSvg, type Mood } from '../lib/mascot';
import { settings } from '../lib/settings';

const ICON18 = (path: string, attrs = '') =>
  `<svg width="18" height="18" viewBox="0 0 8 8" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" ${attrs}><path d="${path}"></path></svg>`;
const P = {
  grip: 'M2 1h1v1H2z M5 1h1v1H5z M2 3h1v1H2z M5 3h1v1H5z M2 5h1v1H2z M5 5h1v1H5z',
  pause: 'M1 1h2v6H1z M5 1h2v6H5z',
  play: 'M2 1h2v6H2z M4 2h1v4H4z M5 3h1v2H5z',
  stop: 'M1 1h6v6H1z',
  bell: 'M3 0h2v1H3z M2 1h4v1H2z M1 2h6v4H1z M0 6h8v1H0z M3 7h2v1H3z',
};

const fmt = (ms: number) => {
  const secs = Math.ceil(ms / 1000);
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
};

export interface WidgetOptions {
  /** The floating window: adds the grip and window drag regions. */
  floating: boolean;
  /** Called after each full render with whether the alarm is showing. */
  onRender?: (alarm: boolean) => void;
}

export class TimerWidget {
  view: TimerView | null = null;
  /** Where the widget is drawn. `render(host)` moves it. */
  host: HTMLElement | null = null;
  /** Show the task title in the header. The inline timer under its task row doesn't need it. */
  showTitle = true;

  private remaining = 0;
  private total = 1;
  private rating = 0;
  private error = '';
  private lastMascot = '';
  /** The alarm effects play once per time's-up, not on every re-render. */
  private alarmedSession: number | null = null;
  /** Move focus to the rating cells on the next render (a fresh question). */
  private focusQuestion = false;

  constructor(private opts: WidgetOptions) {}

  /** Running, paused, asking or showing the logged summary. */
  get active(): boolean {
    return !!this.view && this.view.phase !== 'idle';
  }

  // ---- state ----

  /** Takes a full state from Rust. Doesn't render: the caller decides where. */
  setView(v: TimerView) {
    const prev = this.view;
    this.view = v;
    this.remaining = v.remaining_ms;
    this.total = v.total_ms || 1;
    const freshQuestion = v.phase === 'report' && (prev?.phase !== 'report' || prev.session_id !== v.session_id);
    if (v.phase !== 'report' || freshQuestion) this.rating = 0;
    if (freshQuestion) this.focusQuestion = true;
    if (v.phase !== prev?.phase) this.error = '';
  }

  /** Takes a tick and updates the bar, mascot and status line in place. */
  tick(t: Tick) {
    if (!this.view) return;
    this.remaining = t.remaining_ms;
    this.total = t.total_ms || 1;
    if (t.phase === this.view.phase) this.renderTick();
  }

  private lastMinute() {
    return this.view?.phase === 'running' && this.remaining <= 60_000;
  }

  private alarm() {
    return this.view?.phase === 'report' && this.view.ended_naturally;
  }

  private mood(): Mood {
    if (this.alarm()) return 'alarm';
    return this.view?.phase === 'running' ? 'run' : 'idle';
  }

  private status(): { text: string; cls: string } {
    const v = this.view;
    switch (v?.phase) {
      case 'running': return this.lastMinute() ? { text: 'Last minute', cls: 'warn' } : { text: 'Focusing', cls: '' };
      case 'paused': return { text: 'Paused', cls: '' };
      case 'report': return { text: v.ended_naturally ? 'Time is up' : 'Stopped early', cls: '' };
      case 'logged': return { text: 'Done', cls: '' };
      default: return { text: '', cls: '' };
    }
  }

  // ---- markup ----

  /** `width` is the bar's drawn width in px, to snap the fill to whole 4px pixels. 0 = not drawn yet. */
  private barHtml(width: number): string {
    const v = this.view!;
    const live = v.phase === 'running' || v.phase === 'paused';
    let cls = 'done';
    let frac = 0;
    if (live) {
      cls = v.phase === 'paused' ? 'paused' : this.lastMinute() ? 'last' : 'run';
      frac = this.remaining / this.total;
      if (width > 0) frac = (Math.round((frac * width) / 4) * 4) / width;
    } else if (this.alarm()) {
      cls = 'up';
    }
    const clock = fmt(live ? this.remaining : 0);
    const blink = this.alarm() ? ' blink' : '';
    const fill = frac > 0
      ? `<div class="fill" style="clip-path:inset(0 ${((1 - frac) * 100).toFixed(3)}% 0 0)" aria-hidden="true"><div class="digits">${clock}</div></div>`
      : '';
    return `<div class="bar pxsm ${cls}" data-w="bar" role="timer" aria-label="${clock} remaining">
  <div class="digits${blink}" aria-hidden="true">${clock}</div>${fill}
</div>`;
  }

  private headHtml(): string {
    const v = this.view!;
    const st = this.status();
    const live = v.phase === 'running' || v.phase === 'paused';
    const ringing = this.alarm() && settings().alarm_mode !== 'shake';
    const drag = this.opts.floating ? ' data-tauri-drag-region' : '';
    const grip = this.opts.floating
      ? `<span class="grip"${drag} aria-hidden="true">${ICON18(P.grip, 'width="16" height="16" data-tauri-drag-region').replace('width="18" height="18" ', '')}</span>`
      : '';
    const name = this.showTitle
      ? `<span class="tname"${drag} title="${esc(v.task?.title)}">${esc(v.task?.title ?? '')}</span>`
      : '';
    return `<div class="trow">
  ${grip}<span data-w="mascot"${drag}>${mascotSvg(32, this.total ? this.remaining / this.total : 0, this.mood())}</span>
  <div class="ttitle"${drag}>${name}<span class="tstatus ${st.cls}" data-w="status"${drag}>${esc(st.text)}</span></div>
  ${ringing ? `<span class="bell${this.alarmedSession === v.session_id ? '' : ' ring'}" role="img" aria-label="Alarm ringing">${ICON18(P.bell)}</span>` : ''}
  ${live ? `<button class="ibtn" type="button" data-tact="pause" aria-label="${v.phase === 'paused' ? 'Resume' : 'Pause'}">${ICON18(v.phase === 'paused' ? P.play : P.pause)}</button>
  <button class="ibtn" type="button" data-tact="stop" aria-label="Stop timer">${ICON18(P.stop)}</button>` : ''}
</div>`;
  }

  private errorHtml(): string {
    return this.error ? `<p class="sub err" role="alert">${esc(this.error)}</p>` : '';
  }

  private questionHtml(): string {
    const v = this.view!;
    const title = v.ended_naturally ? 'Time’s up.' : 'Stopped.';
    const cells = [1, 2, 3, 4, 5]
      .map((n) => `<button class="cell${n <= this.rating ? ' on' : ''}" type="button" role="radio" aria-checked="${n === this.rating}" aria-label="${n * 20}% on task" data-rate="${n}"></button>`)
      .join('');
    return `<div class="q">
  <p class="q-title" id="tw-q">${title} How much of it was on task?</p>
  <div class="cells" role="radiogroup" aria-labelledby="tw-q">${cells}</div>
  <div class="scale"><span>Barely</span><span class="picked">${this.rating ? `${this.rating * 20}% on task` : 'Pick one'}</span><span>All of it</span></div>
  <div class="qbtns">
    <button class="btn" type="button" data-tact="extend">+5 min</button>
    <button class="btn primary" type="button" data-tact="log"${this.rating ? '' : ' disabled'}>Log it</button>
  </div>
  ${this.errorHtml()}
</div>`;
  }

  private loggedHtml(): string {
    const v = this.view!;
    const timedMin = Math.round(v.timed_secs / 60);
    const head = v.rating == null ? `Logged ${timedMin} min timed` : `Logged ${Math.round(v.focused_secs / 60)} min focused`;
    const sub = v.rating == null ? 'not rated · counts as timed only' : `of ${timedMin} min timed · added to Reports`;
    return `<div class="q">
  <p class="q-title">${head}</p>
  <p class="sub">${sub}</p>
  <div class="qbtns">
    <button class="btn" type="button" data-tact="again">Again</button>
    <button class="btn primary" type="button" data-tact="close">${this.opts.floating ? 'Back to today' : 'Done'}</button>
  </div>
  ${this.errorHtml()}
</div>`;
  }

  // ---- rendering ----

  /** Which control has focus, so a re-render can put it back. */
  focusKey(): string | undefined {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !this.host?.contains(a)) return undefined;
    return a.dataset.tact ? `[data-tact="${a.dataset.tact}"]` : a.dataset.rate ? `[data-rate="${a.dataset.rate}"]` : undefined;
  }

  /** Draws the whole widget into `host`. `keepFocus` is a `focusKey()` taken before the host was replaced. */
  render(host: HTMLElement | null = this.host, keepFocus = this.focusKey()) {
    this.host = host;
    const v = this.view;
    if (!host || !v) return;
    host.classList.add('tw');
    host.innerHTML = this.headHtml() + this.barHtml(0)
      + (v.phase === 'report' ? this.questionHtml() : v.phase === 'logged' ? this.loggedHtml() : '');
    this.lastMascot = '';
    this.renderTick();

    const alarm = !!this.alarm();
    host.classList.toggle('alarm', alarm);
    // Shake once per time's up, if the alarm setting includes it.
    if (alarm && this.alarmedSession !== v.session_id) {
      this.alarmedSession = v.session_id;
      if (settings().alarm_mode !== 'ring') {
        host.classList.remove('shake');
        void host.offsetWidth; // restart the animation
        host.classList.add('shake');
      }
    }
    if (keepFocus) host.querySelector<HTMLElement>(keepFocus)?.focus();
    else if (this.focusQuestion && v.phase === 'report') host.querySelector<HTMLElement>('.cell')?.focus();
    this.focusQuestion = false;
    this.opts.onRender?.(alarm);
  }

  /** Updates only the bar, mascot and status line. */
  private renderTick() {
    const host = this.host;
    if (!host || !this.view) return;
    const bar = host.querySelector<HTMLElement>('[data-w="bar"]');
    if (bar) bar.outerHTML = this.barHtml(bar.clientWidth);
    const m = host.querySelector<HTMLElement>('[data-w="mascot"]');
    if (m) {
      const next = mascotSvg(32, this.total ? this.remaining / this.total : 0, this.mood());
      if (next !== this.lastMascot) { m.innerHTML = next; this.lastMascot = next; }
    }
    const st = host.querySelector<HTMLElement>('[data-w="status"]');
    if (st) {
      const s = this.status();
      st.textContent = s.text;
      st.className = `tstatus ${s.cls}`;
    }
  }

  // ---- input ----

  private async act(fn: () => Promise<unknown>) {
    this.error = '';
    try {
      await fn();
    } catch (e) {
      this.error = errText(e);
      this.render();
    }
  }

  private togglePause() {
    void this.act(() => (this.view!.phase === 'paused' ? timer.resume() : timer.pause()));
  }

  private rate(n: number) {
    this.rating = n;
    this.render();
  }

  /** Handles a click inside the widget. Returns true if it was the widget's. */
  handleClick(ev: MouseEvent): boolean {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-tact],[data-rate]');
    if (!el || !this.view || !this.host?.contains(el)) return false;
    if (el.dataset.rate) { this.rate(Number(el.dataset.rate)); return true; }
    switch (el.dataset.tact) {
      case 'pause': this.togglePause(); break;
      case 'stop': void this.act(() => timer.stop()); break;
      case 'extend': void this.act(() => timer.extend(300)); break;
      case 'log': if (this.rating) void this.act(() => timer.rate(this.rating)); break;
      case 'again': void this.act(() => timer.again()); break;
      case 'close': void this.act(() => timer.close()); break;
    }
    return true;
  }

  /** Space pauses, 1–5 rate, Enter logs, Esc skips the question. Returns true if handled. */
  handleKey(ev: KeyboardEvent): boolean {
    const v = this.view;
    if (!v || ev.metaKey || ev.ctrlKey || ev.altKey) return false;
    const onButton = !!(ev.target as HTMLElement).closest('button');
    if (ev.key === ' ' && !onButton && (v.phase === 'running' || v.phase === 'paused')) {
      ev.preventDefault();
      this.togglePause();
    } else if (v.phase === 'report' && /^[1-5]$/.test(ev.key)) {
      this.rate(Number(ev.key));
    } else if (v.phase === 'report' && ev.key === 'Enter' && this.rating && !onButton) {
      ev.preventDefault();
      void this.act(() => timer.rate(this.rating));
    } else if (v.phase === 'report' && ev.key === 'Escape') {
      void this.act(() => timer.skip());
    } else {
      return false;
    }
    return true;
  }
}

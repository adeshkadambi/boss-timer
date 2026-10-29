// Floating timer window: the timer widget in a small borderless window that sizes to fit.

import '../lib/report-errors';
import '../styles/base.css';
import './timer.css';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { timer } from '../lib/api';
import { inTauri, loadSettings, onSettings } from '../lib/settings';
import { TimerWidget } from './widget';

const WIDTH = 400;
const win = document.getElementById('win')!;
const content = document.getElementById('content')!;
let lastHeight = 0;

function fitWindow() {
  if (!inTauri) return;
  const h = Math.ceil(win.getBoundingClientRect().height);
  if (h && h !== lastHeight) {
    lastHeight = h;
    void getCurrentWindow().setSize(new LogicalSize(WIDTH, h));
  }
}

const widget = new TimerWidget({
  floating: true,
  onRender: (alarm) => {
    win.classList.toggle('alarm', alarm);
    fitWindow();
  },
});
widget.host = content;

content.addEventListener('click', (ev) => widget.handleClick(ev));
document.addEventListener('keydown', (ev) => widget.handleKey(ev));

await loadSettings();
onSettings(() => widget.render());

if (!inTauri && import.meta.env.DEV) {
  // Browser preview of each state for design checks: timer.html?state=running|paused|last|up|stopped|logged
  const { previewView } = await import('../dev/timer-preview');
  widget.setView(previewView(new URLSearchParams(location.search).get('state') ?? 'running'));
  widget.render();
  throw new Error('preview only');
}

await timer.onPhase((v) => { widget.setView(v); widget.render(); });
await timer.onTick((t) => widget.tick(t));
widget.setView(await timer.state());
widget.render();

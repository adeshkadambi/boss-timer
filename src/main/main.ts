// Main window: hosts Today and Settings (with Reports) as in-page views by swapping one region.

import '../lib/report-errors';
import '../styles/base.css';
import './main.css';
import { timer } from '../lib/api';
import { inTauri, loadSettings, settings } from '../lib/settings';
import { mountToday } from './today';
import { mountSettings, type SettingsTab } from './settings-view';

const view = document.getElementById('view')!;
let unmount: (() => void) | null = null;
let onToday = false;

function show(mount: (root: HTMLElement) => () => void, today = false) {
  unmount?.();
  view.innerHTML = '';
  onToday = today;
  unmount = mount(view);
}

function showToday() {
  show((root) => mountToday(root, { openSettings: (tab) => showSettings(tab as SettingsTab | undefined) }), true);
}

function showSettings(tab?: SettingsTab) {
  show((root) => mountSettings(root, { back: showToday }, tab));
}

await loadSettings();
// `#settings` or `#settings/<tab>` opens Settings directly (handy for previews and the tray later).
const [route, tab] = location.hash.slice(1).split('/');
if (route === 'settings') showSettings(tab as SettingsTab | undefined);
else showToday();

// The inline timer lives in Today: when it needs an answer, go there.
if (inTauri) {
  void timer.onPhase((v) => {
    if (v.phase === 'report' && !settings().floating_timer && !onToday) showToday();
  });
}

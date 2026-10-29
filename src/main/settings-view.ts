// Settings view (design/screens/Settings.dc.html, Reports.dc.html).

import { getVersion } from '@tauri-apps/api/app';
import { accounts, audio, errText, syncToday, updates, type AccountsStatus, type CalendarChoice } from '../lib/api';
import { esc } from '../lib/dom';
import { icon, type IconName } from '../lib/icons';
import { mascotSvg } from '../lib/mascot';
import { isMac, windowControls } from '../lib/window-controls';
import { inTauri, onSettings, settings, updateSettings, type AlarmMode, type AlarmSound, type Settings } from '../lib/settings';
import { THEME_PAIRS, themeOf, themeStyle, type BodyFont, type Theme, type ThemeId } from '../lib/themes';
import { logUi } from '../lib/report-errors';
import { mountReports } from './reports';

export type SettingsTab = 'accounts' | 'timer' | 'appearance' | 'reports';

const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: 'accounts', label: 'Accounts', icon: 'accounts' },
  { id: 'timer', label: 'Timer & alarm', icon: 'bell' },
  { id: 'appearance', label: 'Appearance', icon: 'appearance' },
  { id: 'reports', label: 'Reports', icon: 'reports' },
];

export interface SettingsNav {
  back(): void;
}

const checked = (on: boolean) => (on ? ' checked' : '');
const statusDot = (text: string, kind: 'ok' | 'off' | 'err') =>
  `<span class="status-line"><span class="dot${kind === 'ok' ? '' : ` ${kind}`}"></span>${esc(text)}</span>`;

export function mountSettings(root: HTMLElement, nav: SettingsNav, initial: SettingsTab = 'appearance'): () => void {
  let tab: SettingsTab = initial;
  let unmountReports: (() => void) | null = null;

  // Accounts tab state
  let acc: AccountsStatus | null = null;
  let cals: CalendarChoice[] | null = null;
  let calsErr = '';
  let busy = '';
  const msg: Record<string, { text: string; err: boolean }> = {};
  let editClient = false;

  root.innerHTML = `
<div class="settings" data-tauri-drag-region>
  <div class="settings-head" data-tauri-drag-region="deep">
    ${isMac ? windowControls() : ''}
    <button class="btn sq" type="button" data-act="back" aria-label="Back to today">${icon('back', 14)}</button>
    ${mascotSvg(32, 0.6, 'idle')}
    <h1 class="page-title">Settings</h1>
    ${isMac ? '' : `<span class="winctl-end">${windowControls()}</span>`}
  </div>
  <div class="settings-body">
    <div class="settings-side">
      <nav class="pxbox settings-nav" aria-label="Settings sections" id="snav"></nav>
      <section class="pxbox update-box" aria-label="Updates" id="supd"></section>
    </div>
    <section class="pxbox settings-panel" id="spanel"></section>
  </div>
</div>`;

  const elNav = root.querySelector<HTMLElement>('#snav')!;
  const elPanel = root.querySelector<HTMLElement>('#spanel')!;
  const elUpd = root.querySelector<HTMLElement>('#supd')!;

  const note = (k: string) => (msg[k] ? `<p class="hint${msg[k].err ? ' err' : ''}" role="status">${esc(msg[k].text)}</p>` : '');

  function renderNav() {
    elNav.innerHTML = TABS.map((t) => `<button class="nav" type="button" data-tab="${t.id}"${t.id === tab ? ' aria-current="page"' : ''}>${icon(t.icon)}${esc(t.label)}</button>`).join('');
  }

  // ---- Updates ----

  let version = '';
  let upd: { state: 'idle' | 'checking' | 'latest' | 'available' | 'installing' | 'error'; version?: string; text?: string } = { state: 'idle' };

  function renderUpdate() {
    const btn = (label: string, primary = false, disabled = false) =>
      `<button class="btn${primary ? ' primary' : ''}" type="button" data-upd${disabled ? ' disabled' : ''}>${label}</button>`;
    let body = '';
    switch (upd.state) {
      case 'idle': body = btn('Check for updates'); break;
      case 'checking': body = btn('Checking…', false, true); break;
      case 'latest': body = `${btn('Check again')}<p class="hint" role="status">You're on the latest version.</p>`; break;
      case 'available': body = `${btn(`Update to v${esc(upd.version)}`, true)}<p class="hint" role="status">Installs and restarts Boss Timer.</p>`; break;
      case 'installing': body = `${btn('Updating…', true, true)}<p class="hint" role="status">Downloading v${esc(upd.version)}. Boss Timer restarts when it's done.</p>`; break;
      case 'error': body = `${btn(upd.version ? `Update to v${esc(upd.version)}` : 'Check for updates')}<p class="hint err" role="status">${esc(upd.text)}</p>`; break;
    }
    const focused = elUpd.contains(document.activeElement);
    elUpd.innerHTML = `<span class="lbl">Boss Timer${version ? ` v${esc(version)}` : ''}</span>${body}`;
    if (focused) elUpd.querySelector<HTMLElement>('[data-upd]')?.focus();
  }

  async function onUpdateClick() {
    if (!inTauri) { upd = { state: 'error', text: 'Updates work in the desktop app.' }; renderUpdate(); return; }
    const installing = upd.state === 'available' || (upd.state === 'error' && !!upd.version);
    const v = upd.version;
    upd = installing ? { state: 'installing', version: v } : { state: 'checking' };
    renderUpdate();
    try {
      if (installing) {
        await updates.install(); // restarts the app on success
      } else {
        const found = await updates.check();
        upd = found ? { state: 'available', version: found.version } : { state: 'latest' };
      }
    } catch (e) {
      logUi(`settings: update failed: ${errText(e)}`);
      upd = { state: 'error', version: installing ? v : undefined, text: errText(e) };
    }
    renderUpdate();
  }

  // ---- Accounts ----

  async function refreshAccounts() {
    if (!inTauri) {
      acc = { todoist_connected: false, google_builtin: false, google_configured: false, google_connected: false, google_needs_reconnect: false, google_account: '', google_client_id: '' };
      if (tab === 'accounts') renderPanel();
      return;
    }
    acc = await accounts.status();
    if (acc.google_connected && !acc.google_needs_reconnect && cals == null) {
      accounts.googleCalendars().then((c) => { cals = c; calsErr = ''; }, (e) => { calsErr = errText(e); })
        .finally(() => { if (tab === 'accounts') renderPanel(); });
    }
    if (tab === 'accounts') renderPanel();
  }

  function googleSection(s: Settings): string {
    const a = acc!;
    let state = statusDot('Not set up', 'off');
    if (a.google_configured && !a.google_connected) state = statusDot('Not connected', 'off');
    if (a.google_connected) state = a.google_needs_reconnect ? statusDot('Sign-in expired', 'err') : statusDot('Connected', 'ok');
    let body: string;
    // A client saved here overrides the one built into the app.
    const override = !!a.google_client_id;
    if (!a.google_configured || editClient) {
      const intro = a.google_builtin
        ? 'This app has a Google client built in. Only fill this in to use a different one.'
        : 'No Google client was built into this app. Put your google-client.json in src-tauri/ and rebuild (see the README), or paste a “Desktop app” OAuth client here. The secret is stored in your keychain.';
      body = `<p class="hint">${intro}</p>
<div class="form-col">
  <label class="hint" for="gid">Client ID</label>
  <input id="gid" class="txt pxsm" type="text" autocomplete="off" spellcheck="false" placeholder="….apps.googleusercontent.com" value="${esc(a.google_client_id)}">
  <label class="hint" for="gsecret">Client secret</label>
  <input id="gsecret" class="txt pxsm" type="password" autocomplete="off" placeholder="${override ? 'Saved. Leave empty to keep it.' : ''}">
</div>
<div class="btn-row"><button class="btn primary" type="button" data-act="g-save"${busy ? ' disabled' : ''}>Save client</button>${editClient ? '<button class="btn" type="button" data-act="g-cancel-edit">Cancel</button>' : ''}${a.google_builtin && override ? '<button class="btn" type="button" data-act="g-builtin">Use built-in client</button>' : ''}</div>`;
    } else if (!a.google_connected) {
      const change = !a.google_builtin
        ? '<button class="btn" type="button" data-act="g-edit">Change client</button>'
        : override ? '<button class="btn" type="button" data-act="g-builtin">Use built-in client</button>' : '';
      body = `<div class="btn-row"><button class="btn primary" type="button" data-act="g-connect"${busy ? ' disabled' : ''}>${busy === 'g-connect' ? 'Waiting for browser…' : 'Connect Google Calendar'}</button>${change}</div>
${busy === 'g-connect' ? '<p class="hint">Finish signing in in your browser, then come back here.</p>' : ''}`;
    } else if (a.google_needs_reconnect) {
      body = `<p class="hint">Google ended the sign-in. While your OAuth consent screen is in “Testing”, this happens every 7 days.</p>
<div class="btn-row"><button class="btn primary" type="button" data-act="g-connect"${busy ? ' disabled' : ''}>${busy === 'g-connect' ? 'Waiting for browser…' : 'Reconnect Google'}</button><button class="btn danger" type="button" data-act="g-disconnect">Disconnect</button></div>`;
    } else {
      const list = cals == null
        ? `<p class="hint">${calsErr ? esc(calsErr) : 'Loading calendars…'}</p>`
        : cals.map((c) => `<label class="field"><input type="checkbox" data-cal="${esc(c.id)}"${checked(c.checked)}>${esc(c.name)}${c.primary ? ' <span class="hint">(primary)</span>' : ''}</label>`).join('');
      body = `<span class="hint">Signed in as ${esc(a.google_account || s.google_account || 'your Google account')}</span>
<fieldset class="plain"><legend class="hint">Calendars to show</legend>${list}</fieldset>
<div class="btn-row"><button class="btn" type="button" data-act="sync"${busy ? ' disabled' : ''}>Sync now</button><button class="btn danger" type="button" data-act="g-disconnect">Disconnect</button></div>`;
    }
    return `<div class="stack">
  <div class="acct-head">${icon('calendar', 18, 'style="color:var(--accent2)"')}<h3 class="h3">Google Calendar</h3>${state}</div>
  ${body}
  ${note('google')}
</div>`;
  }

  function todoistSection(s: Settings): string {
    const a = acc!;
    const body = a.todoist_connected
      ? `<fieldset class="plain"><legend class="hint">Tasks to show</legend>
  <label class="field"><input type="radio" name="scope" value="today"${checked(s.todoist_scope === 'today')}>Due today</label>
  <label class="field"><input type="radio" name="scope" value="overdue"${checked(s.todoist_scope === 'overdue')}>Due today + overdue</label>
</fieldset>
<div class="btn-row"><button class="btn" type="button" data-act="sync"${busy ? ' disabled' : ''}>Sync now</button><button class="btn danger" type="button" data-act="t-disconnect">Disconnect</button></div>`
      : `<p class="hint">Paste your personal API token from Todoist: Settings → Integrations → Developer. It's stored in your keychain.</p>
<div class="form-col"><label class="hint" for="ttoken">API token</label><input id="ttoken" class="txt pxsm" type="password" autocomplete="off" spellcheck="false"></div>
<div class="btn-row"><button class="btn primary" type="button" data-act="t-connect"${busy ? ' disabled' : ''}>${busy === 't-connect' ? 'Checking…' : 'Connect Todoist'}</button></div>`;
    return `<div class="stack">
  <div class="acct-head">${icon('tasks', 18, 'style="color:var(--accent)"')}<h3 class="h3">Todoist</h3>${a.todoist_connected ? statusDot('Connected', 'ok') : statusDot('Not connected', 'off')}</div>
  ${body}
  ${note('todoist')}
</div>`;
  }

  function accountsPanel(s: Settings): string {
    if (!acc) return '<h2 class="lbl">Accounts</h2><p class="meta">Loading…</p>';
    return `<h2 class="lbl">Accounts</h2>
${googleSection(s)}
<div class="rule"></div>
${todoistSection(s)}
<div class="rule"></div>
<div class="inline-field"><label for="sync-every">Sync every</label>
<select id="sync-every" class="sel pxsm">${[5, 15, 30].map((m) => `<option value="${m}"${m === s.sync_interval_min ? ' selected' : ''}>${m} minutes</option>`).join('')}</select></div>
${note('sync')}`;
  }

  // ---- Timer & alarm ----

  function timerPanel(s: Settings): string {
    const radio = (v: AlarmMode, label: string) => `<label class="field"><input type="radio" name="alarm" value="${v}"${checked(s.alarm_mode === v)}>${label}</label>`;
    const opt = (v: AlarmSound, label: string) => `<option value="${v}"${s.alarm_sound === v ? ' selected' : ''}>${label}</option>`;
    const inline = !s.floating_timer;
    return `<h2 class="lbl">Timer &amp; alarm</h2>
<fieldset class="plain"><legend class="h3">Where the timer shows</legend>
<label class="field"><input type="radio" id="place-floating" name="place" value="floating"${checked(!inline)}>In a small floating window</label>
<label class="field"><input type="radio" id="place-inline" name="place" value="inline"${checked(inline)}>Inside Today, under the task</label>
</fieldset>
<fieldset class="plain"><legend class="h3">When time is up</legend>
${radio('both', 'Ring and shake the timer')}${radio('shake', 'Shake only')}${radio('ring', 'Ring only')}
</fieldset>
<div class="inline-field"><label for="snd">Alarm sound</label>
<select id="snd" class="sel pxsm">${opt('chime', 'Chime')}${opt('bell8', '8-bit bell')}${opt('beep', 'Soft beep')}</select>
<button class="btn" type="button" data-act="preview">Preview</button></div>
<div class="form-col narrow"><label for="vol" class="vol-label"><span>Alarm volume</span><span class="dim" id="vol-v">${s.volume}%</span></label>
<input id="vol" type="range" min="0" max="100" value="${s.volume}"></div>
<div class="check-hint"><label class="field"><input type="checkbox" data-key="ask_rating"${checked(s.ask_rating)}>Ask how much was on task when a timer ends</label>
<span class="hint">Your answer is what Reports counts as focused time.</span></div>
<div class="check-hint"><label class="field"><input type="checkbox" data-key="always_on_top"${checked(s.always_on_top)}${inline ? ' disabled' : ''}>Keep the floating timer above other windows</label>
<span class="hint">${inline ? 'Only for the floating window.' : 'Some Linux desktops on Wayland ignore this. On GNOME, press Alt+Space on the timer and pick “Always on Top”.'}</span></div>`;
  }

  // ---- Appearance ----

  function themeCard(th: Theme, current: ThemeId): string {
    const on = th.id === current;
    return `<button class="tcard${on ? ' on' : ''}" type="button" data-pick-theme="${th.id}" aria-pressed="${on}" aria-label="${esc(th.label)}, ${th.mode.toLowerCase()}" style="${themeStyle(th)}">
  <span class="tcard-top"><span class="tcard-name">${esc(th.label)}</span></span>
  <span class="tcard-bar"><span class="tcard-track"><span class="tcard-fill"></span></span><span class="tcard-digits">18:42</span></span>
  <span class="tcard-swatches" aria-hidden="true"><span style="background:var(--accent)"></span><span style="background:var(--accent2)"></span><span style="background:var(--warn)"></span><span style="background:var(--danger)"></span><span style="background:var(--fg)"></span></span>
</button>`;
  }

  function appearancePanel(s: Settings): string {
    const cur = themeOf(s.theme).id;
    const font = (s.body_font ?? 'JetBrains Mono') as BodyFont;
    return `<h2 class="lbl">Appearance</h2>
<div class="stack">
  <h3 class="h3">Theme</h3>
  <div class="theme-grid">
    <span class="lbl theme-col">Dark</span><span class="lbl theme-col">Light</span>
    ${THEME_PAIRS.map(([dark, light]) => themeCard(dark, cur) + themeCard(light, cur)).join('')}
  </div>
</div>
<fieldset class="stack fonts">
  <legend class="h3">Text font</legend>
  <label class="field top"><input type="radio" name="font" value="JetBrains Mono"${checked(font === 'JetBrains Mono')}><span class="col"><span style="font-family:'JetBrains Mono',ui-monospace,monospace">JetBrains Mono</span><span class="hint">Easiest to read. Pixel style stays on headings, borders and the timer.</span></span></label>
  <label class="field top"><input type="radio" name="font" value="Pixelify Sans"${checked(font === 'Pixelify Sans')}><span class="col"><span style="font-family:'Pixelify Sans',ui-monospace,monospace">Pixelify Sans</span><span class="hint">Pixel font everywhere. Harder to read at small sizes.</span></span></label>
</fieldset>`;
  }

  function renderPanel() {
    if (tab === 'reports') {
      if (!unmountReports) unmountReports = mountReports(elPanel);
      return;
    }
    unmountReports?.();
    unmountReports = null;
    const s = settings();
    const focusId = (document.activeElement as HTMLElement | null)?.id;
    const focusAct = (document.activeElement as HTMLElement | null)?.dataset.act;
    const focusTheme = (document.activeElement as HTMLElement | null)?.dataset.pickTheme;
    elPanel.innerHTML =
      tab === 'accounts' ? accountsPanel(s) : tab === 'timer' ? timerPanel(s) : appearancePanel(s);
    const again = (focusId && elPanel.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`))
      || (focusAct && elPanel.querySelector<HTMLElement>(`[data-act="${focusAct}"]`))
      || (focusTheme && elPanel.querySelector<HTMLElement>(`[data-pick-theme="${focusTheme}"]`));
    if (again) again.focus();
  }

  function setTab(next: SettingsTab) {
    tab = next;
    renderNav();
    renderPanel();
    if (tab === 'accounts') void refreshAccounts();
  }

  // ---- actions ----

  async function run(k: string, area: string, fn: () => Promise<string | void>) {
    busy = k;
    delete msg[area];
    renderPanel();
    try {
      const text = await fn();
      if (text) msg[area] = { text, err: false };
    } catch (e) {
      logUi(`settings: ${k} failed: ${errText(e)}`);
      msg[area] = { text: errText(e), err: true };
    } finally {
      busy = '';
    }
    await refreshAccounts();
  }

  const val = (id: string) => (elPanel.querySelector<HTMLInputElement>(`#${id}`)?.value ?? '').trim();

  const onClick = (ev: MouseEvent) => {
    const el = ev.target as HTMLElement;
    if (el.closest('[data-act="back"]')) { nav.back(); return; }
    const navBtn = el.closest<HTMLElement>('[data-tab]');
    if (navBtn) { setTab(navBtn.dataset.tab as SettingsTab); elNav.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus(); return; }
    // Not [data-theme]: <html> carries data-theme for the current theme, so every click would match.
    if (el.closest('[data-upd]')) { void onUpdateClick(); return; }
    const card = el.closest<HTMLElement>('[data-pick-theme]');
    if (card) { void updateSettings({ theme: card.dataset.pickTheme as ThemeId }); return; }
    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    switch (act) {
      case 'preview': void audio.preview(settings().alarm_sound); break;
      // Read form fields before run(): it re-renders the panel, which clears them.
      case 't-connect': {
        const token = val('ttoken');
        void run(act, 'todoist', async () => { await accounts.todoistConnect(token); return 'Connected.'; });
        break;
      }
      case 't-disconnect': void run(act, 'todoist', () => accounts.todoistDisconnect()); break;
      case 'g-edit': editClient = true; renderPanel(); break;
      case 'g-cancel-edit': editClient = false; renderPanel(); break;
      case 'g-builtin': void run(act, 'google', async () => { await accounts.googleClearClient(); editClient = false; cals = null; return 'Using the built-in client. Connect to sign in.'; }); break;
      case 'g-save': {
        const id = val('gid');
        const secret = val('gsecret');
        void run(act, 'google', async () => { await accounts.googleSaveClient(id, secret); editClient = false; return 'Client saved. Now connect.'; });
        break;
      }
      case 'g-connect': void run(act, 'google', async () => { cals = null; const who = await accounts.googleConnect(); return `Connected as ${who}.`; }); break;
      case 'g-disconnect': void run(act, 'google', async () => { await accounts.googleDisconnect(); cals = null; }); break;
      case 'sync': void run(act, 'sync', async () => {
        const d = await syncToday();
        const errs = [d.todoist.error, d.google.error].filter(Boolean);
        if (errs.length) throw new Error(errs.join(' '));
        return `Synced: ${d.todoist.tasks.length} tasks, ${d.google.events.length + d.google.all_day.length} events today.`;
      }); break;
    }
  };

  const onChange = (ev: Event) => {
    const el = ev.target as HTMLInputElement;
    if (el.name === 'font') void updateSettings({ body_font: el.value as BodyFont });
    else if (el.name === 'alarm') void updateSettings({ alarm_mode: el.value as AlarmMode });
    else if (el.name === 'place') void updateSettings({ floating_timer: el.value === 'floating' });
    else if (el.name === 'scope') void updateSettings({ todoist_scope: el.value as 'today' | 'overdue' });
    else if (el.id === 'snd') void updateSettings({ alarm_sound: el.value as AlarmSound });
    else if (el.id === 'sync-every') void updateSettings({ sync_interval_min: Number(el.value) as 5 | 15 | 30 });
    else if (el.id === 'vol') void updateSettings({ volume: Number(el.value) });
    else if (el.dataset.key) void updateSettings({ [el.dataset.key]: el.checked } as Partial<Settings>);
    else if (el.dataset.cal && cals) {
      cals = cals.map((c) => (c.id === el.dataset.cal ? { ...c, checked: el.checked } : c));
      void updateSettings({ google_calendars: cals.filter((c) => c.checked).map((c) => c.id) });
    }
  };

  const onInput = (ev: Event) => {
    const el = ev.target as HTMLInputElement;
    if (el.id === 'vol') {
      const v = elPanel.querySelector('#vol-v');
      if (v) v.textContent = `${el.value}%`;
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    // Esc goes back, except while typing in a field.
    if (ev.key === 'Escape' && !(ev.target as HTMLElement).matches('input, select')) nav.back();
    if (ev.key === 'Enter' && (ev.target as HTMLElement).id === 'ttoken') elPanel.querySelector<HTMLElement>('[data-act="t-connect"]')?.click();
  };

  // Re-render when settings change (from this window or another). Text fields keep their focus
  // and value because renderPanel restores focus by id and values come from settings.
  const off = onSettings(() => {
    if (tab === 'reports' || tab === 'accounts') return;
    if ((document.activeElement as HTMLElement | null)?.id === 'vol') return; // don't fight the slider
    renderPanel();
  });

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);
  setTab(tab);
  renderUpdate();
  if (inTauri) void getVersion().then((v) => { version = v; renderUpdate(); });

  return () => {
    off();
    unmountReports?.();
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('input', onInput);
    root.removeEventListener('keydown', onKey);
  };
}

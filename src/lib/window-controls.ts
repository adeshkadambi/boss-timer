// Window controls drawn in the app, since the main window has no native title bar.
// macOS: three squares on the left, like traffic lights. Linux: minimize, maximize, close on
// the right, like GNOME. Each view's top row has data-tauri-drag-region="deep": dragging
// anywhere on it but its buttons moves the window, and double-clicking toggles maximize.

import { getCurrentWindow } from '@tauri-apps/api/window';

export const isMac = /Mac/.test(navigator.userAgent);

const GLYPH = {
  close: 'M1 1h2v2H1z M5 1h2v2H5z M3 3h2v2H3z M1 5h2v2H1z M5 5h2v2H5z',
  min: 'M1 3h6v2H1z',
  max: 'M1 1h6v6H1z M3 3h2v2H3z',
  // macOS shows + on the green light
  zoom: 'M3 1h2v6H3z M1 3h2v2H1z M5 3h2v2H5z',
};
const svg = (d: string, size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 8 8" fill="currentColor" fill-rule="evenodd" shape-rendering="crispEdges" aria-hidden="true"><path d="${d}"></path></svg>`;

/** The controls' markup, for the start (macOS) or end (Linux) of a view's top row. */
export function windowControls(): string {
  if (isMac) {
    return `<div class="winctl mac" role="group" aria-label="Window">
  <button class="wbtn close" type="button" data-win="close" aria-label="Close">${svg(GLYPH.close, 8)}</button>
  <button class="wbtn min" type="button" data-win="min" aria-label="Minimize">${svg(GLYPH.min, 8)}</button>
  <button class="wbtn max" type="button" data-win="max" aria-label="Maximize">${svg(GLYPH.zoom, 8)}</button>
</div>`;
  }
  return `<div class="winctl gtk" role="group" aria-label="Window">
  <button class="wbtn min" type="button" data-win="min" aria-label="Minimize">${svg(GLYPH.min, 14)}</button>
  <button class="wbtn max" type="button" data-win="max" aria-label="Maximize">${svg(GLYPH.max, 14)}</button>
  <button class="wbtn close" type="button" data-win="close" aria-label="Close">${svg(GLYPH.close, 14)}</button>
</div>`;
}

/** Wires the controls anywhere under `root`. Close goes through the app's close handling. */
export function installWindowControls(root: HTMLElement): void {
  if (!('__TAURI_INTERNALS__' in window)) return;
  const w = getCurrentWindow();
  root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-win]');
    if (!btn) return;
    const act = btn.dataset.win;
    const run = act === 'close' ? w.close() : act === 'min' ? w.minimize() : w.toggleMaximize();
    run.catch((e) => console.error(`window ${act}:`, e));
  });
  // Tauri's own double-click-to-maximize skips macOS windows without a native frame (they
  // report no zoom button), so handle it here. Elsewhere Tauri's handler already does it.
  if (isMac) {
    root.addEventListener('dblclick', (ev) => {
      const t = ev.target as HTMLElement;
      if (!t.closest('[data-tauri-drag-region="deep"]')) return;
      if (t.closest('button, a, input, select, textarea, label, [tabindex], [role="button"]')) return;
      w.toggleMaximize().catch((e) => console.error('window maximize:', e));
    });
  }
}

// Sends front-end errors to the terminal running the app (the webview console isn't visible there).
import { invoke } from '@tauri-apps/api/core';
import { inTauri } from './settings';

export function logUi(message: string) {
  console.warn(message);
  if (inTauri) void invoke('log_frontend', { message }).catch(() => {});
}

window.addEventListener('error', (e) => logUi(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  logUi(`unhandled rejection: ${r instanceof Error ? `${r.message}\n${r.stack}` : String(r)}`);
});

/** Escape text for use inside template-string HTML. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Replace a region's contents, keeping focus on the element with the same `data-focus-key` if it had it. */
export function patch(region: HTMLElement, html: string): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active && region.contains(active) ? active.dataset.focusKey : undefined;
  region.innerHTML = html;
  if (key) region.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
}

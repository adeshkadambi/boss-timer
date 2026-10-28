// The Hourglass Boss: a 16×16 pixel mascot whose sand drains with the timer.

export const MASCOT_ROWS = [
  '....K..KK..K....',
  '....KKKGGKKK....',
  '....KKKKKKKK....',
  '..FFFFFFFFFFFF..',
  '..F.gdggggdg.F..',
  '..F.ggdggdgg.F..',
  '..F..geggeg..F..',
  '..F...gddg...F..',
  '..F....gg....F..',
  '..F...gggg...F..',
  '..F..gggggg..F..',
  '..F.gggggggg.F..',
  '..F.gggggggg.F..',
  '..FFFFFFFFFFFF..',
  '...FF......FF...',
  '................',
];

export type Mood = 'idle' | 'run' | 'alarm';
export type Layer = 'frame' | 'glass' | 'sand' | 'crown' | 'gem' | 'eye' | 'dark';

const KEY: Record<string, Layer> = { F: 'frame', g: 'glass', s: 'sand', K: 'crown', G: 'gem', e: 'eye', d: 'dark' };

/** Paint order, back to front, and each layer's CSS color. */
export const LAYERS: [Layer, string][] = [
  ['glass', 'color-mix(in srgb, var(--fg) 14%, var(--panel2))'],
  ['sand', 'var(--accent)'],
  ['frame', 'var(--fg)'],
  ['crown', 'var(--warn)'],
  ['gem', 'var(--danger)'],
  ['eye', 'var(--danger)'],
  ['dark', 'var(--ink)'],
];

/** The 16×16 grid of layer letters for a fill level `f` (remaining/total, 0..1). */
export function mascotGrid(f: number, mood: Mood): string[][] {
  const rows = MASCOT_ROWS.map((r) => r.split(''));
  if (mood === 'alarm') {
    rows[6] = '..F..eeggee..F..'.split('');
    rows[7] = '..F...dddd...F..'.split('');
  }
  const frac = Math.min(1, Math.max(0, f));
  // Glass cells in a row, center-out.
  const cells = (y: number) => {
    const xs: number[] = [];
    rows[y].forEach((ch, x) => { if (ch === 'g') xs.push(x); });
    return xs.sort((a, b) => Math.abs(a - 7.5) - Math.abs(b - 7.5));
  };
  const fill = (ys: number[], n: number) => {
    for (const y of ys) for (const x of cells(y)) { if (n > 0) { rows[y][x] = 's'; n--; } }
  };
  const up = [7, 6, 5, 4];
  const low = [12, 11, 10, 9];
  const cap = (ys: number[]) => ys.reduce((a, y) => a + cells(y).length, 0);
  const upCap = cap(up);
  const lowCap = cap(low);
  fill(up, Math.round(frac * upCap));
  fill(low, Math.round((1 - frac) * lowCap));
  if (mood === 'run' && frac > 0 && frac < 1) rows[8][7] = 's';
  return rows;
}

/** One SVG path per color layer. */
export function mascotPaths(f: number, mood: Mood): Record<Layer, string> {
  const out: Record<Layer, string> = { frame: '', glass: '', sand: '', crown: '', gem: '', eye: '', dark: '' };
  mascotGrid(f, mood).forEach((r, y) => r.forEach((ch, x) => {
    const k = KEY[ch];
    if (k) out[k] += `M${x} ${y}h1v1h-1z`;
  }));
  return out;
}

/** Inline SVG. `size` should be a whole multiple of 16. */
export function mascotSvg(size: number, f = 0.6, mood: Mood = 'idle', label?: string): string {
  const p = mascotPaths(f, mood);
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  const paths = LAYERS.map(([k, c]) => (p[k] ? `<path style="fill:${c}" d="${p[k]}"></path>` : '')).join('');
  return `<svg class="mascot" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" ${a11y}>${paths}</svg>`;
}

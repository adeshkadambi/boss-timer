// Generates the app icon and tray icons from the Hourglass Boss mascot.
// Every PNG is rendered pixel by pixel with nearest-neighbor sampling, so nothing is smoothed.
//
//   npm run icons
//
// Writes:
//   src-tauri/icons/png/icon-{32,128,256,512,1024}.png   app icon exports
//   src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png  the PNGs tauri.conf.json bundles
//   src-tauri/icons/icon.icns, icon.ico                   via `tauri icon`
//   src-tauri/icons/tray/*.png                            one-color tray icons
//
// Needs Node 22.18+ (it imports the TypeScript mascot and theme modules directly).

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { mascotGrid } from '../src/lib/mascot.ts';
import { THEMES } from '../src/lib/themes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = join(ROOT, 'src-tauri', 'icons');

// ---- PNG encoding ------------------------------------------------------------------------------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** `px(x, y)` returns [r, g, b, a] or null for transparent. */
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const c = px(x, y) ?? [0, 0, 0, 0];
      raw.set(c, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- colors ------------------------------------------------------------------------------------

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** color-mix(in srgb, a p%, b) */
const mix = (a, b, p) => a.map((v, i) => Math.round(v * p + b[i] * (1 - p)));
const rgba = (c, a = 255) => [...c, a];

const t = THEMES['tokyo-night'];
const C = {
  g: mix(hex(t.fg), hex(t.panel2), 0.14), // glass
  s: hex(t.accent), // sand
  F: hex(t.fg), // frame
  K: hex(t.warn), // crown
  G: hex(t.danger), // gem
  e: hex(t.danger), // eyes
  d: hex(t.ink), // face
};
const PANEL = hex(t.panel);
const LINE = hex(t.line);
const SHADOW = hex(t.shadow);

// The app icon uses the "running" mascot at 60% so the sand shows in both bulbs, as in Logo.dc.html.
const GRID = mascotGrid(0.6, 'run');

// ---- app icon ----------------------------------------------------------------------------------
// Logical layout in CSS px, as drawn in Logo.dc.html: a 360px panel tile with the .pxbox border
// (4px line on each side, notched corners, 8px drop shadow), mascot at 18× (288px) centered.

const TILE = 360;
const PAD = 24; // transparent margin around the tile
const LO = -4 - PAD; // logical canvas start
const SPAN = TILE + 8 + 4 + 2 * PAD; // -4 line … +8 shadow, plus margins
const SCALE = 18;
const OFF = (TILE - 16 * SCALE) / 2;

function appIconAt(lx, ly) {
  const inX = lx >= 0 && lx < TILE;
  const inY = ly >= 0 && ly < TILE;
  if (inX && inY) {
    const gx = Math.floor((lx - OFF) / SCALE);
    const gy = Math.floor((ly - OFF) / SCALE);
    if (gx >= 0 && gx < 16 && gy >= 0 && gy < 16) {
      const ch = GRID[gy][gx];
      if (C[ch]) return rgba(C[ch]);
    }
    return rgba(PANEL);
  }
  // Pixel border: line on the four sides only, so the corners stay notched.
  const sideX = inY && ((lx >= -4 && lx < 0) || (lx >= TILE && lx < TILE + 4));
  const sideY = inX && ((ly >= -4 && ly < 0) || (ly >= TILE && ly < TILE + 4));
  if (sideX || sideY) return rgba(LINE);
  // Drop shadow, offset 8px right and down.
  if (lx >= 8 && lx < TILE + 8 && ly >= 8 && ly < TILE + 8) return rgba(SHADOW);
  return null;
}

function appIcon(size) {
  return png(size, (x, y) => appIconAt(LO + ((x + 0.5) * SPAN) / size, LO + ((y + 0.5) * SPAN) / size));
}

// ---- tray icon ---------------------------------------------------------------------------------
// One color: every non-glass pixel, glass transparent. Drawn at whole-number scales of the 16 grid.

function trayIcon(size, color) {
  const k = size / 16;
  return png(size, (x, y) => {
    const ch = GRID[Math.floor(y / k)][Math.floor(x / k)];
    return ch !== '.' && ch !== 'g' ? rgba(color) : null;
  });
}

// ---- write -------------------------------------------------------------------------------------

function write(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log('wrote', path.replace(ROOT + '/', ''));
}

const SIZES = [32, 128, 256, 512, 1024];
for (const s of SIZES) write(join(ICONS, 'png', `icon-${s}.png`), appIcon(s));

// Platform icons (.icns, .ico) from the 1024 source.
const cli = spawnSync('npx', ['tauri', 'icon', join(ICONS, 'png', 'icon-1024.png'), '-o', ICONS], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (cli.status !== 0) {
  console.error('tauri icon failed');
  process.exit(1);
}

// `tauri icon` resizes with smoothing; replace its PNGs with crisp nearest-neighbor renders,
// and drop the mobile and Windows Store outputs (out of scope).
write(join(ICONS, '32x32.png'), appIcon(32));
write(join(ICONS, '64x64.png'), appIcon(64));
write(join(ICONS, '128x128.png'), appIcon(128));
write(join(ICONS, '128x128@2x.png'), appIcon(256));
write(join(ICONS, 'icon.png'), appIcon(512));
for (const d of ['android', 'ios']) rmSync(join(ICONS, d), { recursive: true, force: true });
for (const f of existsSync(ICONS) ? readdirSync(ICONS) : []) {
  if (/^(Square\d+x\d+Logo|StoreLogo)\.png$/.test(f)) rmSync(join(ICONS, f));
}

// Tray: macOS template (black + alpha; the OS tints it), Linux light and dark variants.
const BLACK = [0, 0, 0];
write(join(ICONS, 'tray', 'tray-template.png'), trayIcon(32, BLACK));
write(join(ICONS, 'tray', 'tray-template@2x.png'), trayIcon(64, BLACK));
write(join(ICONS, 'tray', 'tray-light.png'), trayIcon(32, hex('#1b1b1f'))); // for light panels
write(join(ICONS, 'tray', 'tray-dark.png'), trayIcon(32, hex('#f2f2f2'))); // for dark panels

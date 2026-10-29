// Theme tokens. Applied as CSS custom properties on :root.

export type ThemeId =
  | 'everforest' | 'everforest-light'
  | 'catppuccin-mocha' | 'catppuccin-latte'
  | 'nord' | 'nord-light'
  | 'tokyo-night' | 'tokyo-night-day'
  | 'gruvbox' | 'gruvbox-light'
  | 'rose-pine' | 'rose-pine-dawn'
  | 'dracula' | 'dracula-alucard';

export type Mode = 'Dark' | 'Light';

export interface Theme {
  id: ThemeId;
  label: string;
  mode: Mode;
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  fg: string;
  dim: string;
  accent: string;
  accent2: string;
  warn: string;
  danger: string;
  onAccent: string;
  onWarn: string;
  shadow: string;
  /** Mascot face color. Same as shadow on dark themes; a dark ink on light ones. */
  ink: string;
}

type Row = Omit<Theme, 'id' | 'mode' | 'onWarn' | 'ink'> & { onWarn?: string; ink?: string };

// Colors come from each theme's official palette. Light versions: Everforest Light (medium),
// Catppuccin Latte, Tokyo Night Day, Gruvbox Light, Rosé Pine Dawn and Alucard (Dracula's light
// theme). A few roles used for small text or button labels are nudged darker so they stay
// readable on a light background. Nord has no light theme, so Nord Light is derived: Snow Storm
// backgrounds, Polar Night text, Frost/Aurora accents darkened toward nord0.
const DARK: Record<string, [ThemeId, Row]> = {
  'everforest': ['everforest', { label: 'Everforest', bg: '#272e33', panel: '#2d353b', panel2: '#3d484d', line: '#56635f', fg: '#d3c6aa', dim: '#9da9a0', accent: '#a7c080', accent2: '#7fbbb3', warn: '#dbbc7f', danger: '#e67e80', onAccent: '#232a2e', shadow: '#1e2326' }],
  'catppuccin': ['catppuccin-mocha', { label: 'Catppuccin Mocha', bg: '#181825', panel: '#1e1e2e', panel2: '#313244', line: '#585b70', fg: '#cdd6f4', dim: '#a6adc8', accent: '#cba6f7', accent2: '#89b4fa', warn: '#fab387', danger: '#f38ba8', onAccent: '#1e1e2e', shadow: '#11111b' }],
  'nord': ['nord', { label: 'Nord', bg: '#2e3440', panel: '#3b4252', panel2: '#434c5e', line: '#616e88', fg: '#eceff4', dim: '#c2c9d6', accent: '#88c0d0', accent2: '#81a1c1', warn: '#ebcb8b', danger: '#bf616a', onAccent: '#2e3440', shadow: '#242933' }],
  'tokyo-night': ['tokyo-night', { label: 'Tokyo Night', bg: '#16161e', panel: '#1a1b26', panel2: '#292e42', line: '#414868', fg: '#c0caf5', dim: '#a9b1d6', accent: '#7aa2f7', accent2: '#bb9af7', warn: '#e0af68', danger: '#f7768e', onAccent: '#16161e', shadow: '#0c0c10' }],
  'gruvbox': ['gruvbox', { label: 'Gruvbox', bg: '#1d2021', panel: '#282828', panel2: '#3c3836', line: '#665c54', fg: '#ebdbb2', dim: '#bdae93', accent: '#b8bb26', accent2: '#83a598', warn: '#fabd2f', danger: '#fb4934', onAccent: '#1d2021', shadow: '#121414' }],
  'rose-pine': ['rose-pine', { label: 'Rosé Pine', bg: '#191724', panel: '#1f1d2e', panel2: '#26233a', line: '#524f67', fg: '#e0def4', dim: '#908caa', accent: '#c4a7e7', accent2: '#9ccfd8', warn: '#f6c177', danger: '#eb6f92', onAccent: '#191724', shadow: '#100e18' }],
  'dracula': ['dracula', { label: 'Dracula', bg: '#21222c', panel: '#282a36', panel2: '#343746', line: '#6272a4', fg: '#f8f8f2', dim: '#b6bcd6', accent: '#bd93f9', accent2: '#8be9fd', warn: '#ffb86c', danger: '#ff5555', onAccent: '#21222c', shadow: '#191a21' }],
};

const LIGHT: Record<string, [ThemeId, Row]> = {
  // dim: between Everforest's fg and its statusline grey; onAccent/onWarn: dark text reads better on its light accents
  'everforest': ['everforest-light', { label: 'Everforest Light', bg: '#efebd4', panel: '#fdf6e3', panel2: '#e6e2cc', line: '#939f91', fg: '#5c6a72', dim: '#66757e', accent: '#8da101', accent2: '#3a94c5', warn: '#dfa000', danger: '#f85552', onAccent: '#2d353b', onWarn: '#2d353b', shadow: '#bdc3af', ink: '#2d353b' }],
  'catppuccin': ['catppuccin-latte', { label: 'Catppuccin Latte', bg: '#e6e9ef', panel: '#eff1f5', panel2: '#dce0e8', line: '#9ca0b0', fg: '#4c4f69', dim: '#5c5f77', accent: '#8839ef', accent2: '#1e66f5', warn: '#df8e1d', danger: '#d20f39', onAccent: '#eff1f5', onWarn: '#232634', shadow: '#bcc0cc', ink: '#232634' }],
  // derived: nord5/6/4 backgrounds, nord0/3 text, nord10 accent, nord7 and nord13 darkened toward nord0
  'nord': ['nord-light', { label: 'Nord Light', bg: '#e5e9f0', panel: '#eceff4', panel2: '#d8dee9', line: '#a7aebd', fg: '#2e3440', dim: '#4c566a', accent: '#5e81ac', accent2: '#6d8c90', warn: '#b29e74', danger: '#bf616a', onAccent: '#eceff4', onWarn: '#2e3440', shadow: '#c2cad8', ink: '#2e3440' }],
  // danger: Tokyo Night Day's error red (its bright red is hard to read as text)
  'tokyo-night': ['tokyo-night-day', { label: 'Tokyo Night Day', bg: '#d0d5e3', panel: '#e1e2e7', panel2: '#c4c8da', line: '#8990b3', fg: '#3760bf', dim: '#68709a', accent: '#2e7de9', accent2: '#9854f1', warn: '#8c6c3e', danger: '#c64343', onAccent: '#16161e', onWarn: '#e1e2e7', shadow: '#a8aecb', ink: '#1a1b26' }],
  'gruvbox': ['gruvbox-light', { label: 'Gruvbox Light', bg: '#f2e5bc', panel: '#fbf1c7', panel2: '#ebdbb2', line: '#a89984', fg: '#3c3836', dim: '#7c6f64', accent: '#79740e', accent2: '#076678', warn: '#b57614', danger: '#9d0006', onAccent: '#fbf1c7', onWarn: '#282828', shadow: '#d5c4a1', ink: '#1d2021' }],
  'rose-pine': ['rose-pine-dawn', { label: 'Rosé Pine Dawn', bg: '#faf4ed', panel: '#fffaf3', panel2: '#f2e9e1', line: '#9893a5', fg: '#464261', dim: '#797593', accent: '#907aa9', accent2: '#286983', warn: '#ea9d34', danger: '#b4637a', onAccent: '#191724', onWarn: '#191724', shadow: '#dfdad9', ink: '#191724' }],
  'dracula': ['dracula-alucard', { label: 'Alucard', bg: '#ece9df', panel: '#fffbeb', panel2: '#dedccf', line: '#bcbab3', fg: '#1f1f1f', dim: '#6c664b', accent: '#644ac9', accent2: '#036a96', warn: '#a34d14', danger: '#cb3a2a', onAccent: '#fffbeb', onWarn: '#fffbeb', shadow: '#ceccc0', ink: '#1f1f1f' }],
};

const build = (id: ThemeId, r: Row, mode: Mode): Theme => ({ ...r, id, mode, onWarn: r.onWarn ?? r.onAccent, ink: r.ink ?? r.shadow });

/** Each theme family as a [dark, light] pair, in picker order. */
export const THEME_PAIRS: [Theme, Theme][] = Object.keys(DARK).map((f) => [
  build(DARK[f][0], DARK[f][1], 'Dark'),
  build(LIGHT[f][0], LIGHT[f][1], 'Light'),
]);

export const THEMES = Object.fromEntries(THEME_PAIRS.flat().map((th) => [th.id, th])) as Record<ThemeId, Theme>;
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];
export const DEFAULT_THEME: ThemeId = 'everforest';

export function themeOf(id: string | undefined): Theme {
  return THEMES[id as ThemeId] ?? THEMES[DEFAULT_THEME];
}

export type BodyFont = 'JetBrains Mono' | 'Pixelify Sans';
export const DEFAULT_FONT: BodyFont = 'JetBrains Mono';

const FONT_STACKS: Record<BodyFont, string> = {
  'JetBrains Mono': "'JetBrains Mono', ui-monospace, Menlo, monospace",
  'Pixelify Sans': "'Pixelify Sans', ui-monospace, monospace",
};

/** CSS custom properties for a theme, as `--name: value` pairs. */
export function themeVars(t: Theme): Record<string, string> {
  return {
    '--bg': t.bg,
    '--panel': t.panel,
    '--panel2': t.panel2,
    '--line': t.line,
    '--fg': t.fg,
    '--dim': t.dim,
    '--accent': t.accent,
    '--accent2': t.accent2,
    '--warn': t.warn,
    '--danger': t.danger,
    '--onAccent': t.onAccent,
    '--onWarn': t.onWarn,
    '--shadow': t.shadow,
    '--ink': t.ink,
  };
}

/** Inline style string with a theme's variables, for previews drawn in their own theme. */
export function themeStyle(t: Theme): string {
  return Object.entries(themeVars(t)).map(([k, v]) => `${k}:${v}`).join(';');
}

export function applyLook(themeId: string | undefined, font: string | undefined): void {
  const t = themeOf(themeId);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVars(t))) root.style.setProperty(k, v);
  root.style.setProperty('--body', FONT_STACKS[font as BodyFont] ?? FONT_STACKS[DEFAULT_FONT]);
  root.style.colorScheme = t.mode === 'Light' ? 'light' : 'dark';
  root.dataset.theme = t.id;
}

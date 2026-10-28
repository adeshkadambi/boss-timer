// Theme tokens. Applied as CSS custom properties on :root.

export type ThemeId =
  | 'everforest'
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'nord'
  | 'tokyo-night'
  | 'gruvbox'
  | 'rose-pine'
  | 'dracula';

export interface Theme {
  id: ThemeId;
  label: string;
  mode: 'Dark' | 'Light';
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
  /** Mascot face color. Same as shadow, except on the light theme. */
  ink: string;
}

type Row = Omit<Theme, 'id' | 'onWarn' | 'ink'> & { onWarn?: string; ink?: string };

const ROWS: Record<ThemeId, Row> = {
  'everforest': { label: 'Everforest', mode: 'Dark', bg: '#272e33', panel: '#2d353b', panel2: '#3d484d', line: '#56635f', fg: '#d3c6aa', dim: '#9da9a0', accent: '#a7c080', accent2: '#7fbbb3', warn: '#dbbc7f', danger: '#e67e80', onAccent: '#232a2e', shadow: '#1e2326' },
  'catppuccin-mocha': { label: 'Catppuccin Mocha', mode: 'Dark', bg: '#181825', panel: '#1e1e2e', panel2: '#313244', line: '#585b70', fg: '#cdd6f4', dim: '#a6adc8', accent: '#cba6f7', accent2: '#89b4fa', warn: '#fab387', danger: '#f38ba8', onAccent: '#1e1e2e', shadow: '#11111b' },
  'catppuccin-latte': { label: 'Catppuccin Latte', mode: 'Light', bg: '#e6e9ef', panel: '#eff1f5', panel2: '#dce0e8', line: '#9ca0b0', fg: '#4c4f69', dim: '#5c5f77', accent: '#8839ef', accent2: '#1e66f5', warn: '#df8e1d', danger: '#d20f39', onAccent: '#eff1f5', onWarn: '#232634', shadow: '#bcc0cc', ink: '#232634' },
  'nord': { label: 'Nord', mode: 'Dark', bg: '#2e3440', panel: '#3b4252', panel2: '#434c5e', line: '#616e88', fg: '#eceff4', dim: '#c2c9d6', accent: '#88c0d0', accent2: '#81a1c1', warn: '#ebcb8b', danger: '#bf616a', onAccent: '#2e3440', shadow: '#242933' },
  'tokyo-night': { label: 'Tokyo Night', mode: 'Dark', bg: '#16161e', panel: '#1a1b26', panel2: '#292e42', line: '#414868', fg: '#c0caf5', dim: '#a9b1d6', accent: '#7aa2f7', accent2: '#bb9af7', warn: '#e0af68', danger: '#f7768e', onAccent: '#16161e', shadow: '#0c0c10' },
  'gruvbox': { label: 'Gruvbox', mode: 'Dark', bg: '#1d2021', panel: '#282828', panel2: '#3c3836', line: '#665c54', fg: '#ebdbb2', dim: '#bdae93', accent: '#b8bb26', accent2: '#83a598', warn: '#fabd2f', danger: '#fb4934', onAccent: '#1d2021', shadow: '#121414' },
  'rose-pine': { label: 'Rosé Pine', mode: 'Dark', bg: '#191724', panel: '#1f1d2e', panel2: '#26233a', line: '#524f67', fg: '#e0def4', dim: '#908caa', accent: '#c4a7e7', accent2: '#9ccfd8', warn: '#f6c177', danger: '#eb6f92', onAccent: '#191724', shadow: '#100e18' },
  'dracula': { label: 'Dracula', mode: 'Dark', bg: '#21222c', panel: '#282a36', panel2: '#343746', line: '#6272a4', fg: '#f8f8f2', dim: '#b6bcd6', accent: '#bd93f9', accent2: '#8be9fd', warn: '#ffb86c', danger: '#ff5555', onAccent: '#21222c', shadow: '#191a21' },
};

export const THEME_IDS = Object.keys(ROWS) as ThemeId[];
export const DEFAULT_THEME: ThemeId = 'tokyo-night';

export const THEMES: Record<ThemeId, Theme> = Object.fromEntries(
  THEME_IDS.map((id) => {
    const r = ROWS[id];
    return [id, { ...r, id, onWarn: r.onWarn ?? r.onAccent, ink: r.ink ?? r.shadow }];
  }),
) as Record<ThemeId, Theme>;

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

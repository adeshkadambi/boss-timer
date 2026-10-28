// 8×8 pixel icons, path data copied from design/screens.

export const ICON = {
  tasks: 'M0 1h2v2H0z M3 1h5v2H3z M0 5h2v2H0z M3 5h5v2H3z',
  calendar: 'M2 0h1v1H2z M5 0h1v1H5z M0 1h8v2H0z M0 3h1v5H0z M7 3h1v5H7z M1 7h6v1H1z M2 4h1v1H2z',
  gear: 'M3 0h2v1H3z M3 7h2v1H3z M0 3h1v2H0z M7 3h1v2H7z M1 1h1v1H1z M6 1h1v1H6z M1 6h1v1H1z M6 6h1v1H6z M2 1h4v1H2z M1 2h6v1H1z M1 3h2v2H1z M5 3h2v2H5z M1 5h6v1H1z M2 6h4v1H2z',
  check: 'M1 3h1v2H1z M2 4h1v2H2z M3 5h1v2H3z M4 4h1v2H4z M5 3h1v2H5z M6 2h1v2H6z M7 1h1v2H7z',
  minus: 'M1 3h6v2H1z',
  plus: 'M3 1h2v6H3z M1 3h2v2H1z M5 3h2v2H5z',
  play: 'M2 1h2v6H2z M4 2h1v4H4z M5 3h1v2H5z',
  back: 'M4 1h1v6H4z M3 2h1v4H3z M2 3h1v2H2z',
  accounts: 'M3 1h2v3H3z M2 2h1v1H2z M5 2h1v1H5z M1 5h6v2H1z',
  bell: 'M3 0h2v1H3z M2 1h4v1H2z M1 2h6v4H1z M0 6h8v1H0z M3 7h2v1H3z',
  appearance: 'M0 0h3v3H0z M5 0h3v3H5z M0 5h3v3H0z M5 5h3v3H5z',
  reports: 'M1 4h1v3H1z M3 2h1v5H3z M5 3h1v4H5z M0 7h8v1H0z',
} as const;

export type IconName = keyof typeof ICON;

export function icon(name: IconName, size = 16, extra = ''): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 8 8" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" ${extra}><path d="${ICON[name]}"></path></svg>`;
}

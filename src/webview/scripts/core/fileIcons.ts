/**
 * Shared file-type icon mapping for context file chips.
 * Maps file extensions to short abbreviation + color for visual identification.
 */

export interface FileIconInfo {
  char: string;
  color: string;
}

const EXT_ICONS: Record<string, FileIconInfo> = {
  ts:    { char: 'TS', color: '#3178c6' },
  tsx:   { char: 'TX', color: '#3178c6' },
  js:    { char: 'JS', color: '#f1e05a' },
  jsx:   { char: 'JX', color: '#f1e05a' },
  vue:   { char: 'V',  color: '#41b883' },
  svelte:{ char: 'S',  color: '#ff3e00' },
  py:    { char: 'PY', color: '#3572a5' },
  rs:    { char: 'RS', color: '#dea584' },
  go:    { char: 'GO', color: '#00add8' },
  rb:    { char: 'RB', color: '#cc342d' },
  java:  { char: 'J',  color: '#b07219' },
  kt:    { char: 'KT', color: '#a97bff' },
  cs:    { char: 'C#', color: '#178600' },
  cpp:   { char: '++', color: '#f34b7d' },
  c:     { char: 'C',  color: '#555555' },
  h:     { char: 'H',  color: '#555555' },
  html:  { char: '<>', color: '#e34c26' },
  css:   { char: '#',  color: '#563d7c' },
  scss:  { char: 'S',  color: '#c6538c' },
  sass:  { char: 'S',  color: '#c6538c' },
  less:  { char: 'L',  color: '#1d365d' },
  json:  { char: '{}', color: '#a1a100' },
  yaml:  { char: '!',  color: '#cb171e' },
  yml:   { char: '!',  color: '#cb171e' },
  toml:  { char: 'T',  color: '#9c4221' },
  xml:   { char: '<>', color: '#0060ac' },
  md:    { char: 'M',  color: '#083fa1' },
  sh:    { char: '$',  color: '#89e051' },
  bash:  { char: '$',  color: '#89e051' },
  zsh:   { char: '$',  color: '#89e051' },
  sql:   { char: 'Q',  color: '#e38c00' },
  graphql:{ char: 'GQ', color: '#e535ab' },
  docker:{ char: 'D',  color: '#384d54' },
  dockerfile:{ char: 'D', color: '#384d54' },
  svg:   { char: '◇',  color: '#ffb13b' },
  png:   { char: '▣',  color: '#a074c4' },
  jpg:   { char: '▣',  color: '#a074c4' },
  gif:   { char: '▣',  color: '#a074c4' },
};

export function getFileExt(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot + 1) : '';
}

export function fileIconChar(fileName: string): string {
  const ext = getFileExt(fileName);
  return EXT_ICONS[ext]?.char ?? '⬡';
}

export function fileIconColor(fileName: string): string {
  const ext = getFileExt(fileName);
  return EXT_ICONS[ext]?.color ?? 'var(--muted)';
}

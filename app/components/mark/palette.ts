// Mark LIV's `C` palette and its live theming.
//
// Mark re-derives the whole teal family from the chosen accent by shifting
// hue only, so brightness/saturation ratios — and therefore the design — stay
// intact. Status colours (ACC, GREEN, RED…) never move. We do the same and
// hand the result to CSS as --mk-* variables on the HUD root, so every panel
// retints the moment the accent changes, like retheme_all_widgets().

export const DEFAULT_UI_COLOR = '#00d4ff';

/** Accent-linked defaults (Mark's _PALETTE_DEFAULTS). */
const HUE_LINKED: Record<string, string> = {
  BG: '#00060a',
  PANEL: '#010d14',
  PANEL2: '#010f18',
  BORDER: '#0d3347',
  BORDER_B: '#1a5c7a',
  BORDER_A: '#0f4060',
  PRI: '#00d4ff',
  PRI_DIM: '#007a99',
  PRI_GHO: '#001f2e',
  TEXT: '#8ffcff',
  TEXT_DIM: '#3a8a9a',
  TEXT_MED: '#5ab8cc',
  WHITE: '#d8f8ff',
  DARK: '#000d14',
  BAR_BG: '#011520',
};

/** Fixed status colours. */
export const STATUS = {
  ACC: '#ff6b00',
  ACC2: '#ffcc00',
  GREEN: '#00ff88',
  GREEN_D: '#00aa55',
  RED: '#ff3355',
  MUTED_C: '#ff3366',
};

type HSV = [number, number, number];

function hexToHsv(hex: string): HSV {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}

function hsvToHex(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][((i % 6) + 6) % 6];
  const c = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** apply_ui_accent(): the hue-shifted palette for `accent`. */
export function derivePalette(accent: string | undefined | null): Record<string, string> {
  const hex = (accent || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return { ...HUE_LINKED };
  const baseH = hexToHsv(HUE_LINKED.PRI)[0];
  const [accH, accS] = hexToHsv(hex);
  const dh = accH - baseH;
  // A near-grey accent desaturates the whole theme rather than tinting it.
  const grey = accS < 0.08;
  const out: Record<string, string> = {};
  for (const [k, v0] of Object.entries(HUE_LINKED)) {
    const [h, s0, v] = hexToHsv(v0);
    const s = grey ? s0 * 0.15 : s0;
    out[k] = hsvToHex((((h + dh) % 1) + 1) % 1, s, v);
  }
  return out;
}

/** CSS custom properties for the HUD root element. */
export function paletteVars(accent: string | undefined | null): Record<string, string> {
  const pal = derivePalette(accent);
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(pal)) vars[`--mk-${k.toLowerCase().replace(/_/g, '-')}`] = v;
  for (const [k, v] of Object.entries(STATUS)) vars[`--mk-${k.toLowerCase().replace(/_/g, '-')}`] = v;
  return vars;
}

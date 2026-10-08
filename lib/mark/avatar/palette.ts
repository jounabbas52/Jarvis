// The HUD palette, derived from the accent colour exactly as Mark's
// `apply_ui_accent` does it: every accent-linked colour is hue-shifted by the
// accent's distance from the default teal, keeping its own saturation and
// value, so the design survives any accent. Status colours stay fixed.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface HudPalette {
  BG: Rgb;
  PRI: Rgb;
  PRI_DIM: Rgb;
  PRI_GHO: Rgb;
  BORDER_B: Rgb;
  WHITE: Rgb;
  ACC: Rgb;
  ACC2: Rgb;
  GREEN: Rgb;
  MUTED_C: Rgb;
}

// Mark's class C defaults.
const LINKED = {
  BG: '#00060a',
  PRI: '#00d4ff',
  PRI_DIM: '#007a99',
  PRI_GHO: '#001f2e',
  BORDER_B: '#1a5c7a',
  WHITE: '#d8f8ff',
} as const;
const FIXED = {
  ACC: '#ff6b00',
  ACC2: '#ffcc00',
  GREEN: '#00ff88',
  MUTED_C: '#ff3366',
} as const;

export function hexRgb(h: string): Rgb {
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

// colorsys.rgb_to_hsv / hsv_to_rgb
function rgbToHsv(c: Rgb): [number, number, number] {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const v = mx;
  if (mn === mx) return [0, 0, v];
  const s = (mx - mn) / mx;
  const rc = (mx - r) / (mx - mn);
  const gc = (mx - g) / (mx - mn);
  const bc = (mx - b) / (mx - mn);
  let h: number;
  if (r === mx) h = bc - gc;
  else if (g === mx) h = 2 + rc - bc;
  else h = 4 + gc - rc;
  h = ((h / 6) % 1 + 1) % 1;
  return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0) return [v, v, v];
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

let cacheKey = '';
let cachePal: HudPalette | null = null;

/** Palette for an accent hex; cached, so calling it every frame is free. */
export function hudPalette(accentHex: string): HudPalette {
  const hex = (accentHex || '').trim().toLowerCase();
  if (cachePal && cacheKey === hex) return cachePal;
  const ok = /^#[0-9a-f]{6}$/.test(hex);
  const baseH = rgbToHsv(hexRgb(LINKED.PRI))[0];
  const [accH, accS] = ok ? rgbToHsv(hexRgb(hex)) : [baseH, 1];
  const dh = accH - baseH;
  const grey = accS < 0.08; // near-grey accent → the whole theme is desaturated

  const out = {} as HudPalette;
  for (const [key, h0] of Object.entries(LINKED)) {
    const [h, s0, v] = rgbToHsv(hexRgb(h0));
    const s = grey ? s0 * 0.15 : s0;
    const [r, g, b] = hsvToRgb((((h + dh) % 1) + 1) % 1, s, v);
    out[key as keyof typeof LINKED] = {
      r: Math.floor(r * 255 + 0.5),
      g: Math.floor(g * 255 + 0.5),
      b: Math.floor(b * 255 + 0.5),
    };
  }
  for (const [key, h0] of Object.entries(FIXED)) out[key as keyof typeof FIXED] = hexRgb(h0);
  cacheKey = hex;
  cachePal = out;
  return out;
}

/** `col` at alpha `a` (0..255) pre-mixed onto `bg`, returned opaque (Mark's `_blend`). */
export function blend(bg: Rgb, col: Rgb, a: number): Rgb {
  const f = Math.max(0, Math.min(1, a / 255));
  return {
    r: Math.trunc(bg.r + (col.r - bg.r) * f),
    g: Math.trunc(bg.g + (col.g - bg.g) * f),
    b: Math.trunc(bg.b + (col.b - bg.b) * f),
  };
}

export function css(c: Rgb): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

/** `col` at alpha `a` (0..255, clamped and truncated like QColor.setAlpha). */
export function cssA(c: Rgb, a: number): string {
  const al = Math.trunc(Math.max(0, Math.min(255, a)));
  return `rgba(${c.r},${c.g},${c.b},${al / 255})`;
}

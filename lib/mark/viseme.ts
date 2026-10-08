// Text → mouth shape, fused with the audio the avatar is actually speaking.
// Port of Mark LIV's core/viseme.py, plus `_pcm_level` / `_pcm_visemes` from
// its main.py.
//
// Why both sources
// ----------------
// Formant analysis of the audio (`pcmVisemes`) gives excellent *timing* and a
// decent read on vowels, but it is blind to exactly the consonants lip-reading
// depends on. /m/, /b/ and /p/ are made with the lips pressed shut, and nothing
// in the spectrum reliably says "the lips are closed" — a nasal /m/ and a nasal
// /n/ look nearly identical to a filter bank while looking completely different
// on a face.
//
// The transcript knows those consonants for certain. So the text supplies
// *which shape*, the audio supplies *when* and *how strongly*, and the two are
// blended. If the transcript is late or missing the mouth silently falls back
// to the audio-only shape.
//
// Language independence
// ---------------------
// There is no per-language table here. Every character is reduced to one of the
// 26 bare Latin letters — by Unicode decomposition for accents, by
// transliteration for Cyrillic and Greek — and articulation is looked up on
// that. Scripts whose spelling does not reveal pronunciation (CJK, Arabic,
// Devanagari, Hebrew, Thai) are detected by coverage and skipped, and the mouth
// runs on the audio-only shape — which is itself language-independent, being
// physics. The result is never wrong, only less detailed.

import type { VisemeFrame } from './hud';

// ── Audio side (main.py) ─────────────────────────────────────────────────────

// RMS below which 16-bit PCM is treated as room silence; above LEVEL_FULL it
// reads as a full-height waveform. Tuned so ordinary speech lands mid-range and
// the bars still move for a quiet talker — language- and device-independent.
const LEVEL_FLOOR = 60.0;
const LEVEL_FULL = 2600.0;

/** ~43 ms analysis window at 24 kHz: enough for formants. */
export const VIS_WIN = 1024;
/** 20 ms between frames at 24 kHz, i.e. 50 shapes a second. */
export const VIS_HOP = 480;

function rmsLevel(x: ArrayLike<number>, from: number, to: number, scale: number): number {
  const n = to - from;
  if (n <= 0) return 0;
  let acc = 0;
  for (let i = from; i < to; i++) {
    const v = x[i] * scale;
    acc += v * v;
  }
  const rms = Math.sqrt(acc / n);
  if (!Number.isFinite(rms) || rms <= LEVEL_FLOOR) return 0;
  return Math.min(1, (rms - LEVEL_FLOOR) / (LEVEL_FULL - LEVEL_FLOOR));
}

/**
 * Map a block of PCM samples to a 0..1 loudness level for the HUD waveform.
 * Thresholds are in int16 units, as in Mark. An Int16Array is used as is; a
 * Float32Array is taken to be Web Audio's normalised -1..1 PCM and scaled to
 * int16 so the floor and full-scale points mean the same thing on the mic path
 * as on the speaker path. Returns 0 on empty input so it can never throw.
 */
export function pcmLevel(samples: Int16Array | Float32Array): number {
  if (!samples || samples.length === 0) return 0;
  const scale = samples instanceof Float32Array ? 32768 : 1;
  return rmsLevel(samples, 0, samples.length, scale);
}

// Radix-2 FFT, sized for the one window this module ever analyses. Tables are
// built once; the per-frame cost is one 1024-point complex transform.
const FFT_N = VIS_WIN;
const FFT_BITS = Math.log2(FFT_N);
const fftRev = new Uint16Array(FFT_N);
const fftCos = new Float64Array(FFT_N / 2);
const fftSin = new Float64Array(FFT_N / 2);
// np.hanning is the *symmetric* Hann window: 0.5 - 0.5 cos(2πn / (M-1)).
const hann = new Float32Array(FFT_N);
(() => {
  for (let i = 0; i < FFT_N; i++) {
    let r = 0;
    for (let b = 0; b < FFT_BITS; b++) r |= ((i >> b) & 1) << (FFT_BITS - 1 - b);
    fftRev[i] = r;
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  }
  for (let i = 0; i < FFT_N / 2; i++) {
    fftCos[i] = Math.cos((-2 * Math.PI * i) / FFT_N);
    fftSin[i] = Math.sin((-2 * Math.PI * i) / FFT_N);
  }
})();
const fftRe = new Float64Array(FFT_N);
const fftIm = new Float64Array(FFT_N);

/** In-place forward FFT of fftRe/fftIm (numpy sign convention). */
function fft(): void {
  for (let i = 0; i < FFT_N; i++) {
    const j = fftRev[i];
    if (j > i) {
      const tr = fftRe[i];
      fftRe[i] = fftRe[j];
      fftRe[j] = tr;
      const ti = fftIm[i];
      fftIm[i] = fftIm[j];
      fftIm[j] = ti;
    }
  }
  for (let size = 2; size <= FFT_N; size <<= 1) {
    const half = size >> 1;
    const step = FFT_N / size;
    for (let start = 0; start < FFT_N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = fftCos[k * step];
        const wi = fftSin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = fftRe[b] * wr - fftIm[b] * wi;
        const xi = fftRe[b] * wi + fftIm[b] * wr;
        fftRe[b] = fftRe[a] - xr;
        fftIm[b] = fftIm[a] - xi;
        fftRe[a] += xr;
        fftIm[a] += xi;
      }
    }
  }
}

const mag = new Float64Array(FFT_N / 2 + 1);

/**
 * Slice a PCM block into (level, openness, width) frames, one per 20 ms.
 *
 * Openness tracks the first formant — F1 climbs as the jaw drops, so /a/ reads
 * open and /i/ or /u/ read closed. Width tracks the second — F2 is high for
 * spread vowels (/i/, /e/) and low for rounded ones (/u/, /o/). No transcript,
 * no alignment, no language assumption.
 *
 * Returns [] on anything unexpected — the mouth falls back to loudness-only
 * articulation rather than the caller having to handle an error.
 */
export function pcmVisemes(samples: Int16Array, sr = 24000): Array<[number, number, number]> {
  try {
    const x = samples;
    if (!x || x.length < VIS_WIN) return [];
    const binHz = sr / VIS_WIN;
    // Band edges as inclusive-exclusive bin ranges, matching the numpy masks
    // over rfftfreq.
    const band = (lo: number, hi: number): [number, number] => {
      let a = Math.ceil(lo / binHz - 1e-9);
      let b = Math.ceil(hi / binHz - 1e-9);
      a = Math.max(0, Math.min(VIS_WIN / 2 + 1, a));
      b = Math.max(0, Math.min(VIS_WIN / 2 + 1, b));
      return [a, b];
    };
    const bF1lo = band(150, 450); // F1 of close vowels
    const bF1hi = band(450, 1100); // F1 of open vowels
    const bF2bk = band(600, 1300); // F2 of rounded vowels
    const bF2fr = band(1700, 3200); // F2 of spread vowels
    const bHiss = band(3800, 8000); // fricatives
    const sum = ([a, b]: [number, number]): number => {
      let s = 0;
      for (let k = a; k < b; k++) s += mag[k];
      return s;
    };

    // One frame per hop across the *whole* block. Stepping only while a full
    // window fits stopped 1024 - 480 samples short of the end, so a 200 ms
    // batch yielded 160 ms of schedule: the mouth ran out of frames before the
    // audio ran out of sound.
    const out: Array<[number, number, number]> = [];
    for (let start = 0; start < x.length; start += VIS_HOP) {
      // The level gates closures, so it is measured over exactly this 20 ms
      // and never looks ahead. The spectrum needs a longer window to resolve
      // formants and may be zero-filled at the very end.
      const level = rmsLevel(x, start, Math.min(x.length, start + VIS_HOP), 1);
      if (level <= 0) {
        out.push([0, 0, 0]);
        continue;
      }
      const end = Math.min(x.length, start + VIS_WIN);
      let mean = 0;
      for (let i = start; i < end; i++) mean += x[i];
      mean /= VIS_WIN; // the zero padding is part of the segment numpy averages
      for (let i = 0; i < VIS_WIN; i++) {
        const s = start + i < end ? x[start + i] : 0;
        fftRe[i] = (s - mean) * hann[i];
        fftIm[i] = 0;
      }
      fft();
      for (let k = 0; k <= VIS_WIN / 2; k++) mag[k] = Math.hypot(fftRe[k], fftIm[k]);

      const f1l = sum(bF1lo);
      const f1h = sum(bF1hi);
      const f2b = sum(bF2bk);
      const f2f = sum(bF2fr);
      const hiss = sum(bHiss);

      let openness = f1h / (f1l + f1h + 1e-6);
      let width = (f2f - f2b) / (f2f + f2b + 1e-6);
      // A wide-open jaw physically cannot purse, so openness damps width. /a/
      // has a low enough F2 to read as "rounded" on the bands alone; letting
      // openness suppress the width term keeps an open vowel from pursing.
      width *= Math.pow(1 - openness, 0.8);
      // Fricatives are formed with a nearly closed mouth.
      const h = hiss / (f1l + f1h + f2b + f2f + hiss + 1e-6);
      openness *= 1 - 0.65 * Math.min(1, h * 2.5);
      out.push([level, Math.min(1, Math.max(0, openness)), Math.min(1, Math.max(-1, width))]);
    }
    return out;
  } catch {
    return [];
  }
}

// ── Text side (core/viseme.py) ───────────────────────────────────────────────

type Viseme = 'REST' | 'AA' | 'E' | 'I' | 'O' | 'U' | 'MBP' | 'FV' | 'S' | 'L' | 'TD' | 'K' | 'R';

// (openness 0..1, width -1..+1, closure 0..1). Closure forces the lips
// together regardless of loudness — it is the whole reason the transcript is
// worth consulting.
export const VISEMES: Record<Viseme, [number, number, number]> = {
  REST: [0.0, 0.0, 0.0],
  AA: [0.92, -0.05, 0.0], // a
  E: [0.52, 0.42, 0.0], // e
  I: [0.2, 0.62, 0.0], // i, ı
  O: [0.55, -0.52, 0.0], // o, ö
  U: [0.26, -0.74, 0.0], // u, ü, w
  MBP: [0.0, 0.0, 1.0], // m, b, p — lips pressed shut
  FV: [0.1, 0.22, 0.55], // f, v — lower lip to the teeth
  S: [0.16, 0.42, 0.0], // s, ş, z, c, ç, j
  L: [0.36, 0.18, 0.0], // l
  TD: [0.28, 0.12, 0.0], // t, d, n
  K: [0.3, -0.04, 0.0], // k, g, ğ, h
  R: [0.28, -0.16, 0.0], // r
};

// Relative duration of each class. Vowels carry the syllable; plosives are a tap.
const DUR: Record<Viseme, number> = {
  REST: 1.0, AA: 1.15, E: 1.05, I: 1.0, O: 1.1, U: 1.05,
  MBP: 0.5, FV: 0.8, S: 0.9, L: 0.65, TD: 0.5, K: 0.55, R: 0.55,
};

// Articulation is a property of the *sound*, not of a language, so the table
// is keyed on the 26 bare Latin letters and every script reaches it by
// reduction.
const LETTER: Record<string, Viseme> = {
  a: 'AA',
  e: 'E',
  i: 'I', y: 'I',
  o: 'O',
  u: 'U', w: 'U',
  b: 'MBP', p: 'MBP', m: 'MBP',
  f: 'FV', v: 'FV',
  s: 'S', z: 'S', c: 'S', j: 'S', x: 'S',
  l: 'L',
  t: 'TD', d: 'TD', n: 'TD',
  k: 'K', g: 'K', h: 'K', q: 'K',
  r: 'R',
};

// Letters with no Unicode decomposition into a Latin base.
const UNDECOMPOSED: Record<string, string> = {
  'ı': 'i', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ŀ': 'l', 'ŧ': 't',
  'ß': 's', 'æ': 'a', 'œ': 'o', 'þ': 't', 'ð': 'd', 'ŋ': 'n',
  'ł': 'l',
};

const CYRILLIC: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
  'ж': 'j', 'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 's', 'ч': 's', 'ш': 's', 'щ': 's', 'ъ': '',
  'ы': 'i', 'ь': '', 'э': 'e', 'ю': 'u', 'я': 'a',
  'і': 'i', 'ї': 'i', 'є': 'e', 'ґ': 'g', 'ў': 'u',
};

const GREEK: Record<string, string> = {
  'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i',
  'θ': 't', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 's',
  'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'i',
  'φ': 'f', 'χ': 'h', 'ψ': 's', 'ω': 'o',
};

// Below this share of mappable letters the text is in a script we cannot read
// phonetically, and forcing shapes onto it would be worse than not trying.
const MIN_COVERAGE = 0.55;

// English spellings that do not survive letter-by-letter reading.
const DIGRAPH: Record<string, Viseme> = {
  sh: 'S', ch: 'S', ts: 'S',
  th: 'TD', ck: 'K', ng: 'K', gh: 'K',
  ph: 'FV',
  oo: 'U', ou: 'O', ow: 'O', wh: 'U',
  ee: 'I', ea: 'I', ie: 'I',
  qu: 'K',
};

const PAUSE = new Set(['.', ',', ';', ':', '!', '?', '…', '\n']);
const COMBINING = /\p{M}/gu;
const LETTER_RE = /^\p{L}$/u;
const SPACE_RE = /^\s$/u;

/**
 * Reduce any character to a bare Latin letter, or '' if it has none. This is
 * what makes the mouth language-agnostic: one reduction step replaces a
 * per-language spelling table.
 */
export function toLatin(ch: string): string {
  const c = ch.toLowerCase();
  if (c.length === 1 && c >= 'a' && c <= 'z') return c;
  if (c in UNDECOMPOSED) return UNDECOMPOSED[c];
  if (c in CYRILLIC) return CYRILLIC[c];
  if (c in GREEK) return GREEK[c];
  // Strip combining marks: é→e, ü→u, ş→s, ğ→g, ế→e, ñ→n, å→a …
  const base = c.normalize('NFD').replace(COMBINING, '');
  const cps = Array.from(base);
  if (cps.length === 1 && base >= 'a' && base <= 'z') return base;
  if (base && base !== c) return toLatin(cps[0]); // e.g. a ligature: take the first
  return '';
}

/** Fraction of the letters in `text` we can reduce to a Latin sound. */
export function coverage(text: string): number {
  const letters = Array.from(text || '').filter((c) => LETTER_RE.test(c));
  if (!letters.length) return 0;
  return letters.filter((c) => toLatin(c)).length / letters.length;
}

/**
 * Split a line of speech into (viseme, duration-weight) pairs. Returns [] for
 * scripts whose written form does not reveal pronunciation, so the caller falls
 * back to the audio-only mouth instead of miming nonsense.
 */
export function textToVisemes(text: string): Array<[Viseme, number]> {
  const s = Array.from((text || '').toLowerCase());
  if (coverage(s.join('')) < MIN_COVERAGE) return [];

  const out: Array<[Viseme, number]> = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (PAUSE.has(ch)) {
      out.push(['REST', 1.4]);
      i += 1;
      continue;
    }
    if (SPACE_RE.test(ch)) {
      // A word gap is a beat, not a closed mouth — closing between every word
      // makes the avatar look like it is chewing.
      if (out.length && out[out.length - 1][0] !== 'REST') out.push([out[out.length - 1][0], 0.35]);
      i += 1;
      continue;
    }

    // Digraphs are an orthographic quirk of Latin spelling; check them on the
    // reduced letters so "SCH"/"Sch" and accented forms match too.
    const two = toLatin(ch) + (i + 1 < n ? toLatin(s[i + 1]) : '');
    let v: Viseme | undefined;
    if (two.length === 2 && two in DIGRAPH) {
      v = DIGRAPH[two];
      i += 2;
    } else {
      const base = toLatin(ch);
      i += 1;
      if (!base) continue;
      v = LETTER[base];
      if (v === undefined) continue;
    }
    // A doubled letter is one sound in every orthography we handle here.
    if (out.length && out[out.length - 1][0] === v) continue;
    out.push([v, DUR[v]]);
  }
  return out;
}

/**
 * Fuses the transcript's shape sequence onto the audio's timing. `feedText`
 * takes output-transcription chunks as they arrive; `frames` is called with
 * each block's `pcmVisemes` result just before it is scheduled for playback.
 */
export class VisemeStream {
  // Seconds a phoneme occupies at a normal speaking rate. The clock adapts
  // between these when the queue runs long (the model is talking fast) or
  // short (it is trailing off).
  private static readonly MIN_STEP = 0.045;
  private static readonly MAX_STEP = 0.105;

  private q: Array<[Viseme, number]> = [];
  private cur: [Viseme, number] = ['REST', 1.0];
  private carry = 0;

  reset(): void {
    this.q = [];
    this.cur = ['REST', 1.0];
    this.carry = 0;
  }

  feedText(t: string): void {
    for (const item of textToVisemes(t)) this.q.push(item);
    // Never let a stalled turn pile up an unbounded backlog.
    if (this.q.length > 600) this.q.splice(0, this.q.length - 600);
  }

  get pending(): number {
    return this.q.length;
  }

  private stepSeconds(): number {
    // A long backlog means speech is outrunning the clock; shorten the step so
    // the mouth catches up instead of drifting further behind the voice.
    const backlog = Math.min(1, this.q.length / 45);
    const { MIN_STEP, MAX_STEP } = VisemeStream;
    return MAX_STEP - (MAX_STEP - MIN_STEP) * backlog;
  }

  /** Blend audio frames [(level, openness, width)] with the text queue. */
  frames(audio: Array<[number, number, number]>, hopSec: number): VisemeFrame[] {
    const out: VisemeFrame[] = [];
    for (const [level, aOpen, aWide] of audio) {
      if (level <= 0) {
        // Silence: let the queue wait rather than burning through it during a
        // pause, or the mouth ends up ahead of the voice.
        out.push({ level: 0, open: 0, width: 0, close: 0 });
        continue;
      }

      this.carry += hopSec / Math.max(1e-3, this.stepSeconds() * this.cur[1]);
      while (this.carry >= 1 && this.q.length) {
        this.cur = this.q.shift()!;
        this.carry -= 1;
      }
      if (this.carry >= 1) this.carry = 1; // queue empty — hold the last shape

      const [tOpen, tWide, c0] = VISEMES[this.cur[0]] ?? VISEMES.REST;
      let closure = c0;
      let o: number;
      let w: number;
      if (this.q.length || this.cur[0] !== 'REST') {
        // Text leads the shape; the audio keeps it honest so a bad transcript
        // alignment still tracks the real voice.
        o = 0.72 * tOpen + 0.28 * aOpen;
        w = 0.78 * tWide + 0.22 * aWide;
      } else {
        o = aOpen;
        w = aWide;
        closure = 0;
      }
      o *= 1 - closure;
      out.push({
        level,
        open: Math.max(0, Math.min(1, o)),
        width: Math.max(-1, Math.min(1, w)),
        close: closure,
      });
    }
    return out;
  }
}

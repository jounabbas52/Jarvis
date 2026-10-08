// Telling the user's voice apart from our own coming back through the
// speakers — the port of core/echo.py.
//
// Used for the echo tail: for a moment after a reply ends, sound is still in
// the room, and streaming the microphone then is how an assistant answers its
// own last sentence. Rather than muting, both streams are reduced to band
// energies and as much of what was just played as fits is subtracted from the
// microphone block. Pure echo cancels to almost nothing; a second voice
// survives, because its formants sit where ours were weak. The thresholds are
// learned from the room, so nothing needs tuning per machine.

const BAND_EDGES = [200, 400, 700, 1100, 1700, 2600, 3800, 5200, 7000];
const HISTORY_MS = 1500;
const MIN_LEVEL = 0.06;
const MIN_USER = 0.15;
const HEAD_Q = 97;
const HEAD_MULT = 1.15;
const UNRELIABLE_FLOOR = 0.22;
const BLOCKS_NORMAL = 5;
const BLOCKS_NOISY = 12;
const FLOOR_WINDOW = 60;
const FLOOR_Q = 35;
const WARMUP = 16;
const RELEARN_RUN = 28;

/** In-place radix-2 FFT; re/im length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Raw energy per speech band — the fingerprint compared. Left unnormalised on purpose. */
export function bandEnergies(pcm: Int16Array | Float32Array, sr: number): Float64Array {
  const out = new Float64Array(BAND_EDGES.length - 1);
  const size = pcm.length;
  if (size < 64) return out;
  let mean = 0;
  for (let i = 0; i < size; i++) mean += pcm[i];
  mean /= size;
  let n = 1;
  while (n < size) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < size; i++) {
    const w = size > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)) : 1;
    re[i] = (pcm[i] - mean) * w;
  }
  fft(re, im);
  const binHz = sr / n;
  for (let k = 0; k <= n / 2; k++) {
    const f = k * binHz;
    if (f < BAND_EDGES[0] || f >= BAND_EDGES[BAND_EDGES.length - 1]) continue;
    const mag = Math.hypot(re[k], im[k]);
    for (let b = 0; b < out.length; b++) {
      if (f >= BAND_EDGES[b] && f < BAND_EDGES[b + 1]) {
        out[b] += mag;
        break;
      }
    }
  }
  return out;
}

function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const pos = ((s.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export class EchoGuard {
  hist: Array<{ t: number; bands: Float64Array; level: number }> = [];
  private gainEst = 0.6;
  private seen = 0;
  private lastSim = 0;
  private residuals: number[] = [];
  private floorEst = 0.1;
  private run = 0;
  private head = 0.13;

  get gain(): number {
    return this.gainEst;
  }
  get calibrated(): boolean {
    return this.seen >= 8;
  }
  get floor(): number {
    return this.floorEst;
  }
  /** False when the room is too reverberant to judge on content alone. */
  get reliable(): boolean {
    return this.floorEst < UNRELIABLE_FLOOR;
  }
  get threshold(): number {
    return Math.max(MIN_USER, this.head * HEAD_MULT);
  }
  get requiredBlocks(): number {
    return this.reliable ? BLOCKS_NORMAL : BLOCKS_NOISY;
  }
  get lastSimilarity(): number {
    return this.lastSim;
  }

  /** Playback stopped — drop the history, keep what was learned. */
  reset(): void {
    this.hist = [];
    this.lastSim = 0;
  }

  /** Record a slice of what is being played. `when` is performance.now() ms. */
  noteOutput(pcm: Int16Array, sr: number, level: number, when = performance.now()): void {
    try {
      this.hist.push({ t: when, bands: bandEnergies(pcm, sr), level });
      if (this.hist.length > 8) this.hist = this.hist.filter((h) => h.t >= when - HISTORY_MS);
    } catch {
      /* bookkeeping must never disturb playback */
    }
  }

  private learn(residual: number): void {
    this.residuals.push(residual);
    if (this.residuals.length > FLOOR_WINDOW) this.residuals.splice(0, this.residuals.length - FLOOR_WINDOW);
    if (this.residuals.length >= WARMUP) {
      this.floorEst = percentile(this.residuals, FLOOR_Q);
      this.head = percentile(this.residuals, HEAD_Q);
    }
  }

  /** True if this microphone block is a different voice, not our echo. */
  isUserSpeech(pcm: Int16Array, sr: number, level: number, when = performance.now()): boolean {
    try {
      if (level < MIN_LEVEL) {
        if (this.hist.length && Math.max(...this.hist.map((h) => h.level)) > 0.15) this.learn(0);
        this.run = 0;
        return false;
      }
      if (!this.hist.length) return true;
      const bands = bandEnergies(pcm, sr);
      let total = 0;
      for (const v of bands) total += v;
      if (total <= 1e-9) return false;

      let bestRes = 1;
      let bestLevel = 0;
      for (const h of this.hist) {
        if (h.t > when || when - h.t > HISTORY_MS) continue;
        const denom = dot(h.bands, h.bands);
        if (denom < 1e-12) continue;
        const alpha = Math.max(0, dot(bands, h.bands) / denom);
        let resid = 0;
        for (let i = 0; i < bands.length; i++) resid += Math.max(bands[i] - alpha * h.bands[i], 0);
        const ratio = resid / total;
        if (ratio < bestRes) {
          bestRes = ratio;
          bestLevel = h.level;
        }
      }
      this.lastSim = 1 - bestRes;
      if (bestLevel <= 0) return true;

      const warming = this.residuals.length < WARMUP;
      if (!warming && bestRes >= this.threshold) {
        this.run++;
        // A 'voice' this long means the room changed; relearn it.
        if (this.run > RELEARN_RUN) {
          this.residuals = [];
          this.run = 0;
          return false;
        }
        return true;
      }
      this.run = 0;
      this.learn(bestRes);
      if (warming) return false;
      if (bestRes <= this.floorEst * 1.15 && bestLevel > 0.05) {
        const obs = level / Math.max(bestLevel, 1e-6);
        this.gainEst += (Math.min(obs, 3) - this.gainEst) * 0.08;
        this.seen = Math.min(this.seen + 1, 999);
      }
      return false;
    } catch {
      return false; // any doubt: do not interrupt
    }
  }
}

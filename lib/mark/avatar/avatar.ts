// Holographic AI head for the HUD centre. Port of Mark LIV's core/avatar.py.
//
// * The face is real human geometry (./mesh.ts builds the head around
//   MediaPipe's canonical face model). This renderer's whole job is to light
//   it, pose it and animate it.
// * Software rendered, on purpose: plain Canvas 2D, exactly like Mark's
//   QPainter — no WebGL context, no shader compile, no GPU driver to disagree
//   with. It looks the same on every machine.
// * Lip-sync comes from the audio pipeline, not from the avatar. The Live
//   controller computes per-20 ms viseme frames off the PCM that is about to
//   play; the avatar just consumes them. The mouth only tracks the voice while
//   the assistant is *speaking* — during listening the mic level drives the
//   aura, so the head never lip-syncs to the user's voice.
//
// The renderer is theme-agnostic: `paint()` takes its colours as arguments,
// which is what lets the accent picker retint the avatar for free.

import { getHeadMesh, JAW_MAX, JAW_PIVOT, type HeadMesh } from './mesh';
import { blend, css, cssA, type Rgb } from './palette';

// Perspective camera distance in head-half-heights. Large enough that the nose
// does not balloon, small enough to keep a sense of depth.
const CAM_D = 4.6;

// Wireframe opacity buckets, so the whole lattice draws in a handful of batched
// strokes instead of one per line.
const BUCKETS = 4;
const MIN_ALPHA = 0.05;

// Resolution of the surface-shading colour ramp. Banding across a filled facet
// is far more visible than banding in line alpha, so this is fine-grained.
const LUT_N = 192;

// How far the brows travel at full lift, in head-half-heights. The brow-to-eye
// gap is 0.198 and a real raise covers about a third of it, then the drawn
// landmarks only carry half the rig weight.
const BROW_LIFT = 0.14;

// Mouth timing, as time constants in seconds rather than per-frame fractions,
// so the mouth moves the same at any frame rate. Shutting is the fastest: a
// short closure occupies a single 20 ms schedule frame, so the mouth has one
// step to reach it. Only the return to rest, once talking has stopped, is
// leisurely.
const TAU_OPEN = 0.022; // jaw dropping toward a vowel
const TAU_SHUT = 0.012; // lips closing on a consonant, mid-word
const TAU_REST = 0.055; // settling back to rest after speech ends
const TAU_SHAPE = 0.018; // viseme openness following the schedule

// Only the microphone path needs a level floor: it has one coarse RMS and no way
// to tell speech from room tone. The assistant's own voice arrives as a
// per-20 ms schedule whose silences are already silent — a floor there would
// swallow the gaps between words.
const MIC_FLOOR = 0.14;

// How far below this voice's own loud level counts as a closure: -20 dB, which
// is what a stop consonant actually drops to.
const CLOSE_FRAC = 0.1;

/**
 * Fill one triangle into a packed-RGBA buffer, aliased, sampling at pixel
 * centres. Shared edges are inclusive on both sides, so a watertight mesh
 * leaves no gaps; the later triangle simply wins the edge, as in painter's
 * order.
 */
function fillTriangle(
  buf: Uint32Array, stride: number, height: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
  col: number,
): void {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;
  if (area < 0) {
    // Wind counter-clockwise so "inside" is E >= 0 on every edge.
    const tx = bx, ty = by;
    bx = cx;
    by = cy;
    cx = tx;
    cy = ty;
  }
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(stride - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  if (minX > maxX || minY > maxY) return;

  // Edge functions E(p) = (q.x - o.x)(p.y - o.y) - (q.y - o.y)(p.x - o.x),
  // evaluated at the row's first pixel centre. E is linear in x, so each
  // edge bounds the row to a half-line; the three bounds give one span,
  // filled natively. Same pixels as testing each one, far less work.
  const px = minX + 0.5;
  const e0x = -(by - ay), e0y = bx - ax;
  const e1x = -(cy - by), e1y = cx - bx;
  const e2x = -(ay - cy), e2y = ax - cx;
  let r0 = (bx - ax) * (minY + 0.5 - ay) - (by - ay) * (px - ax);
  let r1 = (cx - bx) * (minY + 0.5 - by) - (cy - by) * (px - bx);
  let r2 = (ax - cx) * (minY + 0.5 - cy) - (ay - cy) * (px - cx);
  // Spans average under ten pixels, so the per-row overhead is what costs:
  // reciprocals instead of divisions, and a plain loop instead of a native
  // fill() call per row.
  const i0 = e0x !== 0 ? 1 / e0x : 0;
  const i1 = e1x !== 0 ? 1 / e1x : 0;
  const i2 = e2x !== 0 ? 1 / e2x : 0;
  const span = maxX - minX;
  let row = minY * stride + minX;
  for (let y = minY; y <= maxY; y++, row += stride) {
    let lo = 0, hi = span, t: number;
    if (e0x > 0) { t = Math.ceil(-r0 * i0); if (t > lo) lo = t; }
    else if (e0x < 0) { t = Math.floor(-r0 * i0); if (t < hi) hi = t; }
    else if (r0 < 0) hi = -1;
    if (e1x > 0) { t = Math.ceil(-r1 * i1); if (t > lo) lo = t; }
    else if (e1x < 0) { t = Math.floor(-r1 * i1); if (t < hi) hi = t; }
    else if (r1 < 0) hi = -1;
    if (e2x > 0) { t = Math.ceil(-r2 * i2); if (t > lo) lo = t; }
    else if (e2x < 0) { t = Math.floor(-r2 * i2); if (t < hi) hi = t; }
    else if (r2 < 0) hi = -1;
    for (let o = row + lo, end = row + hi; o <= end; o++) buf[o] = col;
    r0 += e0y;
    r1 += e1y;
    r2 += e2y;
  }
}

/** Per-frame lerp factor for an exponential approach with time constant `tau`. */
function rate(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const uniform = (a: number, b: number) => a + (b - a) * Math.random();

export interface AvatarStepInput {
  speaking?: boolean;
  muted?: boolean;
  state?: string;
  vOpen?: number | null;
  vWide?: number;
  vLevel?: number | null;
  /** Every schedule frame the last tick spanned: [level, open, width]. */
  vSeq?: Array<[number, number, number]> | null;
  vHop?: number;
}

type Pt = [number, number];

export class HoloAvatar {
  /** True paints a lit, solid head with a wireframe over it; false is see-through glass. */
  shaded = true;

  /** Crown (+1.0) down to the bottom of the neck, in head-half-heights. */
  readonly SPAN: number;

  private m: HeadMesh;
  private lipUp: number[];
  private nv: number;
  private pv: Float32Array; // posed vertices
  private pn: Float32Array; // rotated normals
  private xs: Float32Array;
  private ys: Float32Array;


  private t = 0;
  private sway = 0; // integrated sway phase — see step()
  private yaw = 0;
  private pitch = 0;
  private mouth = 0; // 0..1 smoothed jaw opening
  private glow = 0; // 0..1 smoothed overall energy
  private scan = -1.6; // vertical position of the energy sweep
  private blink = 0; // 0 = open, 1 = shut
  private blinkAt = 3.0;

  // ── expression ──────────────────────────────────────────────────────────
  // Speech is not just a moving jaw. Brows ride the loudness envelope and the
  // gaze flicks between fixation points — that is what makes it read as
  // talking rather than as a puppet chewing.
  private ampSlow = 0;
  private expr = 0;
  private exprTgt = 0;
  private exprAt = 0;
  private brow = 0; // smoothed brow lift, -0.4 .. 1.2
  private emph = 0; // syllable emphasis, drives the head nod
  private gaze: Pt = [0, 0];
  private gazeTgt: Pt = [0, 0];
  private gazeAt = 0;

  // ── state expression ────────────────────────────────────────────────────
  // The face is the fastest status indicator in the app: you read a gaze
  // before you read a word. Saccades orbit a bias the assistant's state moves —
  // eyes off to the side while it thinks, back on you while it listens.
  private gazeBias: Pt = [0, 0];
  private biasTgt: Pt = [0, 0];
  private biasAt = 0;
  // Mark computes a lid target per state but never draws it (only the blink
  // closes the eyes); kept so the state machine is the same.
  private lids = 1;
  private browBias = 0; // concentration pulls the brows down
  private glanceReq: [number, number, number] | null = null; // dx, dy, until

  // ── viseme ──────────────────────────────────────────────────────────────
  private vOpen = 1;
  private wide = 0; // smoothed lip spread, -1 round .. +1 spread
  private vPeak = 0.18; // running estimate of this voice's loud level

  constructor() {
    const m = (this.m = getHeadMesh());
    const li = m.landmarks.lips_in;
    // The inner-lip ring runs lower-lip left→right, then upper-lip back. The
    // upper arc anchors a strip of teeth, which keeps an open mouth from
    // reading as a hole punched in the face.
    this.lipUp = [...li.slice(10), li[0]];
    this.SPAN = m.span[0] - m.span[1];
    this.nv = m.verts.length / 3;
    this.pv = new Float32Array(m.verts.length);
    this.pn = new Float32Array(m.verts.length);
    this.xs = new Float32Array(this.nv);
    this.ys = new Float32Array(this.nv);
  }

  // ── animation ─────────────────────────────────────────────────────────────

  /** One increment of the jaw: once per viseme frame while speaking, once per tick otherwise. */
  private mouthStep(dt: number, amp: number, live: boolean, vOpen: number | null, vLevel: number | null): void {
    let shape: number;
    if (vOpen == null) {
      shape = 1;
    } else {
      this.vOpen += (vOpen - this.vOpen) * rate(dt, TAU_SHAPE);
      shape = this.vOpen;
    }

    let drive: number;
    if (vLevel == null) {
      const gated = Math.max(0, (amp - MIC_FLOOR) / (1 - MIC_FLOOR));
      drive = gated ** 0.6 * Math.max(0, shape) ** 0.75;
    } else {
      // Normalise against a running estimate of this voice's own loud level,
      // so it reads the same at any volume. The closure floor is a fraction of
      // that level, so a real stop consonant lands at exactly zero.
      this.vPeak = Math.max(vLevel, this.vPeak - dt * 0.55);
      const ref = Math.max(0.18, this.vPeak);
      const q = (vLevel - CLOSE_FRAC * ref) / (ref * (1 - CLOSE_FRAC));
      drive = clamp(q, 0, 1) ** 0.85 * Math.max(0, shape) ** 0.75;
    }

    const target = live ? Math.min(1, drive) : 0;
    let tau: number;
    if (target > this.mouth) tau = TAU_OPEN;
    else if (live) tau = TAU_SHUT; // mid-word: a consonant, and it must shut now
    else tau = TAU_REST; // speech is over; settle, don't snap
    this.mouth += (target - this.mouth) * rate(dt, tau);
    if (this.mouth < 0.002) this.mouth = 0;
  }

  /**
   * Advance the animation. `amp` is the 0..1 display audio level. vOpen /
   * vWide / vLevel are the viseme schedule's shape and true level for this
   * instant; null falls back to loudness-only articulation (the mic path).
   * `vSeq` is every schedule frame the last tick spanned, so no closure is
   * lost when frames are dropped; an empty array means "a schedule is playing
   * but this tick is inside a frame already spoken" and steps nothing.
   */
  step(dtIn: number, ampIn: number, o: AvatarStepInput = {}): void {
    const dt = clamp(dtIn, 0.001, 0.1);
    this.t += dt;
    const t = this.t;
    const amp = clamp(ampIn, 0, 1);
    const muted = !!o.muted;
    const live = !!o.speaking && !muted;
    const vOpen = o.vOpen ?? null;
    const vWide = o.vWide ?? 0;
    const vLevel = o.vLevel ?? null;

    // Idle sway. The phase is *integrated*: multiplying absolute time by a
    // speed that changes when speech starts or stops would teleport the head.
    const speed = (muted ? 0.55 : 1.0) * (live ? 1.25 : 1.0);
    this.sway += dt * speed;
    const s = this.sway;
    this.yaw = 0.26 * Math.sin(s * 0.31) + 0.09 * Math.sin(s * 0.73 + 1.3);
    this.pitch = 0.06 * Math.sin(s * 0.23 + 0.7) + 0.024 * Math.sin(s * 0.61);

    // Mouth: advance once per *schedule* frame rather than once per tick, so a
    // 40 ms bilabial closure can never fall between two samples.
    if (o.vSeq != null) {
      const hop = o.vHop ?? 0.02;
      for (const [lv, op] of o.vSeq) this.mouthStep(hop, amp, live, op, lv);
    } else {
      this.mouthStep(dt, amp, live, vOpen, vLevel);
    }

    // Syllable emphasis — decays to zero on its own once the mouth closes.
    this.emph += (this.mouth - this.emph) * rate(dt, this.mouth > this.emph ? 0.055 : 0.32);
    this.pitch -= this.emph * 0.028;
    this.yaw += 0.018 * Math.sin(t * 1.7) * this.emph;

    // Loudness envelope, deliberately lazier than the mouth: brows track the
    // shape of a phrase, not individual syllables.
    const env = live ? amp : 0;
    this.ampSlow += (env - this.ampSlow) * rate(dt, env > this.ampSlow ? 0.16 : 0.36);

    if (live) {
      if (t >= this.exprAt) {
        this.exprTgt = uniform(-0.35, 1.0);
        this.exprAt = t + 1.1 + 2.0 * Math.random();
      }
    } else {
      this.exprTgt = 0;
      this.exprAt = t + 0.8;
    }
    this.expr += (this.exprTgt - this.expr) * 0.075;

    const browT = 0.55 * this.ampSlow + 0.6 * this.expr + this.browBias;
    this.brow += (clamp(browT, -0.4, 1.2) - this.brow) * 0.2;

    // ── what the state does to the face ───────────────────────────────────
    const st = (o.state || '').toUpperCase();
    const thinking = st === 'THINKING' || st === 'PROCESSING';
    const asleep = st === 'SLEEPING' || st === 'STANDBY' || st === 'OFFLINE';
    let browBias: number;
    let lidTgt: number;
    if (thinking) {
      // People look away to think, and hold it. The direction re-rolls slowly
      // so it reads as thought rather than as scanning.
      if (t >= this.biasAt) {
        this.biasTgt = [(Math.random() < 0.5 ? -1 : 1) * uniform(0.45, 0.8), uniform(0.25, 0.55)];
        this.biasAt = t + 1.4 + 1.6 * Math.random();
      }
      browBias = -0.28;
      lidTgt = 0.94;
    } else if (asleep) {
      this.biasTgt = [0, -0.25];
      browBias = -0.05;
      lidTgt = 0.22;
    } else {
      // LISTENING / idle / speaking: eyes come back to the user.
      this.biasTgt = [0, 0];
      this.biasAt = 0;
      browBias = st === 'LISTENING' ? 0.1 : 0;
      lidTgt = 1;
    }
    for (const i of [0, 1]) this.gazeBias[i] += (this.biasTgt[i] - this.gazeBias[i]) * 0.06;
    this.lids += (lidTgt - this.lids) * 0.08;
    this.browBias += (browBias - this.browBias) * 0.06;

    // Gaze: saccades are near-instant jumps between fixations, more frequent
    // when there is something to say, slow while thinking — a darting eye
    // reads as nervous, not thoughtful.
    if (t >= this.gazeAt) {
      const reach = live ? 0.9 : thinking ? 0.35 : 0.55;
      this.gazeTgt = [uniform(-1, 1) * reach, uniform(-1, 1) * reach * 0.55];
      if (live) this.gazeAt = t + 0.55 + 1.7 * Math.random();
      else if (thinking) this.gazeAt = t + 1.8 + 2.4 * Math.random();
      else this.gazeAt = t + 1.3 + 2.8 * Math.random();
    }

    // A deliberate glance (something appeared on screen) overrides the
    // wandering for a moment, then hands control back.
    if (this.glanceReq) {
      const [gx, gy, until] = this.glanceReq;
      if (t < until) this.gazeTgt = [gx, gy];
      else this.glanceReq = null;
    }

    for (const i of [0, 1]) {
      const tgt = clamp(this.gazeTgt[i] + this.gazeBias[i], -1, 1);
      this.gaze[i] += (tgt - this.gaze[i]) * 0.3;
    }

    // Lips lead the jaw slightly in real speech, so they track a touch faster;
    // they also relax to neutral the moment the voice stops.
    const wideT = live && vOpen != null ? vWide : 0;
    this.wide += (clamp(wideT, -1, 1) - this.wide) * rate(dt, 0.03);

    const g = muted ? 0 : amp;
    this.glow += (g - this.glow) * (g > this.glow ? 0.35 : 0.1);

    this.scan += dt * (0.55 + 1.5 * this.glow);
    if (this.scan > 1.35) this.scan = -1.75;

    if (this.blink > 0) {
      this.blink = Math.max(0, this.blink - dt * 8.5);
    } else if (t >= this.blinkAt) {
      // Concentration suppresses blinking; a sleeping face has no need of it.
      if (asleep) {
        this.blinkAt = t + 6.0;
      } else {
        this.blink = 1;
        const gap = thinking ? 5.5 : 3.4;
        this.blinkAt = t + gap + 3.1 * Math.random();
      }
    }
  }

  /**
   * Look deliberately somewhere for `hold` seconds, then wander again. Used
   * when something appears on screen: a face that looks at what just showed up
   * tells the user it landed, without a word being spoken.
   */
  glance(dx: number, dy: number, hold = 1.1): void {
    this.glanceReq = [clamp(dx, -1, 1), clamp(dy, -1, 1), this.t + Math.max(0.1, hold)];
  }

  // ── posing ────────────────────────────────────────────────────────────────

  /** Jaw drop, brow lift and head rotation, applied to the real geometry. */
  private pose(): void {
    const { verts: v0, normals: n0, brow: bw, lips: lw, jaw, lipCentre: lc } = this.m;
    const n = this.nv;
    const doBrow = this.brow > 0.004 || this.brow < -0.004;
    const doLips = Math.abs(this.wide) > 0.01 && this.mouth > 0;
    const doJaw = this.mouth > 0.004;
    const browK = this.brow * BROW_LIFT;
    const lipK = this.wide * this.mouth;
    const jawK = this.mouth * JAW_MAX;
    const [, py, pz] = JAW_PIVOT;

    const cyw = Math.cos(this.yaw), syw = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // Rows of Mark's rotation matrix (v' = M v).
    const m00 = cyw, m01 = 0, m02 = syw;
    const m10 = sp * syw, m11 = cp, m12 = -sp * cyw;
    const m20 = -cp * syw, m21 = sp, m22 = cp * cyw;

    const pv = this.pv;
    const pn = this.pn;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let x = v0[o], y = v0[o + 1], z = v0[o + 2];
      if (doBrow) y += bw[i] * browK;
      if (doLips) {
        // Spread pulls the corners out and flattens the lips back; rounding
        // draws them in and pushes them forward into a purse.
        const k = lw[i] * lipK;
        x += k * (x - lc[0]) * 0.55;
        y += k * (y - lc[1]) * 0.3;
        z -= k * 0.055;
      }
      if (doJaw) {
        const a = jaw[i] * jawK;
        if (a !== 0) {
          const ca = Math.cos(a), sa = Math.sin(a);
          const dy = y - py, dz = z - pz;
          y = py + dy * ca - dz * sa;
          z = pz + dy * sa + dz * ca;
        }
      }
      pv[o] = m00 * x + m01 * y + m02 * z;
      pv[o + 1] = m10 * x + m11 * y + m12 * z;
      pv[o + 2] = m20 * x + m21 * y + m22 * z;
      const nx = n0[o], ny = n0[o + 1], nz = n0[o + 2];
      pn[o] = m00 * nx + m01 * ny + m02 * nz;
      pn[o + 1] = m10 * nx + m11 * ny + m12 * nz;
      pn[o + 2] = m20 * nx + m21 * ny + m22 * nz;
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  /**
   * Draw the avatar with its head centre at (cx, cy). `r` is the head's
   * half-height in pixels — the caller owns the layout.
   */
  paint(p: CanvasRenderingContext2D, cx: number, cy: number, r: number, primary: Rgb, accent: Rgb, bg: Rgb = { r: 0, g: 0, b: 0 }): void {
    const amp = this.glow;
    this.pose();

    // ── aura ──────────────────────────────────────────────────────────────
    const ar = r * 1.95;
    const grad = p.createRadialGradient(cx, cy, 0, cx, cy, ar);
    grad.addColorStop(0, cssA(primary, 34 + 66 * amp));
    grad.addColorStop(0.38, cssA(primary, 20 + 40 * amp));
    grad.addColorStop(1, cssA(primary, 0));
    p.fillStyle = grad;
    p.beginPath();
    p.arc(cx, cy, ar, 0, Math.PI * 2);
    p.fill();

    // ── project ───────────────────────────────────────────────────────────
    const { pv, xs, ys } = this;
    for (let i = 0; i < this.nv; i++) {
      const w = Math.max(CAM_D - pv[i * 3 + 2], 0.35);
      const k = (CAM_D / w) * r;
      xs[i] = cx + pv[i * 3] * k;
      ys[i] = cy - pv[i * 3 + 1] * k;
    }

    if (this.shaded) this.paintSurface(p, primary, bg, amp);
    this.paintWire(p, primary, bg, amp);
    this.paintFeatures(p, primary, accent, bg, amp);
  }

  /** Fill the camera-facing triangles so the head reads as a lit volume. */
  private paintSurface(p: CanvasRenderingContext2D, primary: Rgb, bg: Rgb, amp: number): void {
    const { faces: f, faceGroup, fade } = this.m;
    const { pv, pn, xs, ys } = this;
    const nf = f.length / 3;
    // Reused across frames: allocating these ~30 times a second was most of
    // the garbage the HUD produced.
    // Arrays are indexed by face id; shade < 0 marks a facet culled this frame.
    if (this.sKey.length !== nf) {
      this.sKey = new Float64Array(nf);
      this.sShade = new Int32Array(nf);
      this.sOrder = new Int32Array(nf);
      for (let i = 0; i < nf; i++) this.sOrder[i] = i;
    }
    const key = this.sKey, shade = this.sShade;
    let nVis = 0;

    for (let i = 0; i < nf; i++) {
      const a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
      // Far to near, grouped: neck facets all draw before head facets, because
      // the two meshes interpenetrate and a pure depth sort tears the seam.
      // Kept for culled facets too, so the persistent order stays sorted.
      key[i] = faceGroup[i] * 1000 + (pv[a * 3 + 2] + pv[b * 3 + 2] + pv[c * 3 + 2]) / 3;
      shade[i] = -1;
      // Flat normals from each triangle's own posed geometry — NOT the averaged
      // vertex normals, which smear the nose, lips and brow relief into their
      // neighbours and render the face as a blank egg.
      const ux = pv[b * 3] - pv[a * 3], uy = pv[b * 3 + 1] - pv[a * 3 + 1], uz = pv[b * 3 + 2] - pv[a * 3 + 2];
      const vx = pv[c * 3] - pv[a * 3], vy = pv[c * 3 + 1] - pv[a * 3 + 1], vz = pv[c * 3 + 2] - pv[a * 3 + 2];
      let fx = uy * vz - uz * vy;
      let fy = uz * vx - ux * vz;
      let fz = ux * vy - uy * vx;
      const l = Math.max(Math.sqrt(fx * fx + fy * fy + fz * fz), 1e-9);
      fx /= l;
      fy /= l;
      fz /= l;
      // Point them outwards by agreeing with the vertex normals, which were
      // oriented at build time.
      const rx = pn[a * 3] + pn[b * 3] + pn[c * 3];
      const ry = pn[a * 3 + 1] + pn[b * 3 + 1] + pn[c * 3 + 1];
      const rz = pn[a * 3 + 2] + pn[b * 3 + 2] + pn[c * 3 + 2];
      const sg = Math.sign(fx * rx + fy * ry + fz * rz);
      fx *= sg;
      fy *= sg;
      fz *= sg;

      const nz = fz;
      const area = Math.abs((xs[b] - xs[a]) * (ys[c] - ys[a]) - (xs[c] - xs[a]) * (ys[b] - ys[a]));
      if (!(nz > 0.015 && area > 3.0)) continue;

      // A rim term for the glass edge plus a key light high on the left. The
      // light leans off-axis on purpose: weighted towards the camera, every
      // front-facing facet would return the same value — a flat mask.
      const fres = clamp(1 - nz, 0, 2) ** 1.7;
      const lam = clamp(fx * -0.55 + fy * 0.5 + nz * 0.52, 0, 1);
      let bright = 0.26 + 0.2 * fres + 0.66 * lam ** 1.05;
      bright *= (fade[a] + fade[b] + fade[c]) / 3;
      bright *= 0.88 + 0.24 * amp;
      shade[i] = clamp(Math.trunc(bright * LUT_N), 0, LUT_N - 1);
      nVis++;
    }
    if (!nVis) return;

    // Depth order, by (key, face id). The head only sways, so last frame's
    // order is nearly right and an insertion sort settles it in about one
    // pass, instead of a full comparator sort every frame.
    const order = this.sOrder;
    for (let k = 1; k < nf; k++) {
      const id = order[k];
      const kv = key[id];
      let j = k - 1;
      while (j >= 0 && (key[order[j]] > kv || (key[order[j]] === kv && order[j] > id))) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = id;
    }
    const lut = this.surfaceLut32(bg, primary);

    // Rasterised here, into one pixel buffer, and handed to the canvas as a
    // single image. Issued as ~900 fill() + stroke() pairs, the surface was two
    // thousand draw calls a frame and most of the app's GPU time. It is also
    // closer to Mark: Qt filled these facets aliased, which is exactly what a
    // plain rasteriser does, so no seam-closing strokes are needed.
    const s = p.getTransform().a || 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < nf; k++) {
      const i = order[k];
      if (shade[i] < 0) continue;
      for (let v = 0; v < 3; v++) {
        const j = f[i * 3 + v];
        if (xs[j] < minX) minX = xs[j];
        if (xs[j] > maxX) maxX = xs[j];
        if (ys[j] < minY) minY = ys[j];
        if (ys[j] > maxY) maxY = ys[j];
      }
    }
    const x0 = Math.floor(minX * s), y0 = Math.floor(minY * s);
    const w = Math.min(4096, Math.ceil(maxX * s) - x0 + 1);
    const h = Math.min(4096, Math.ceil(maxY * s) - y0 + 1);
    if (w <= 0 || h <= 0) return;

    const img = this.surfaceBuffer(w, h);
    if (!img) return;
    if (!this.sBuf32 || this.sBuf32.buffer !== img.data.buffer) this.sBuf32 = new Uint32Array(img.data.buffer);
    const buf = this.sBuf32;
    const stride = img.width;
    // Clear only the region this frame uses.
    for (let y = 0; y < h; y++) buf.fill(0, y * stride, y * stride + w);
    for (let k = 0; k < nf; k++) {
      const i = order[k];
      if (shade[i] < 0) continue;
      const a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
      fillTriangle(
        buf, stride, img.height,
        xs[a] * s - x0, ys[a] * s - y0,
        xs[b] * s - x0, ys[b] * s - y0,
        xs[c] * s - x0, ys[c] * s - y0,
        lut[shade[i]],
      );
    }
    this.surfCtx!.putImageData(img, 0, 0, 0, 0, w, h);
    p.save();
    p.setTransform(1, 0, 0, 1, 0, 0);
    p.drawImage(this.surf as CanvasImageSource, 0, 0, w, h, x0, y0, w, h);
    p.restore();
  }


  private sKey = new Float64Array(0);
  private sShade = new Int32Array(0);
  private sOrder = new Int32Array(0);
  private sVa = new Float32Array(0);
  private sBuf32: Uint32Array | null = null;
  private surf: OffscreenCanvas | HTMLCanvasElement | null = null;
  private surfCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private surfImg: ImageData | null = null;
  private lut32 = new Uint32Array(LUT_N);
  private lut32Key = '';

  /** The surface ramp as packed RGBA pixels (ImageData is little-endian RGBA). */
  private surfaceLut32(bg: Rgb, primary: Rgb): Uint32Array {
    const key = `${bg.r},${bg.g},${bg.b}|${primary.r},${primary.g},${primary.b}`;
    if (this.lut32Key !== key) {
      for (let i = 0; i < LUT_N; i++) {
        const c = blend(bg, primary, (255 * (i + 0.5)) / LUT_N);
        this.lut32[i] = ((255 << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0;
      }
      this.lut32Key = key;
    }
    return this.lut32;
  }

  /** A reusable pixel buffer at least w×h; grows, never shrinks. */
  private surfaceBuffer(w: number, h: number): ImageData | null {
    if (!this.surf) {
      this.surf =
        typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      this.surfCtx = this.surf.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    }
    if (!this.surfCtx) return null;
    if (!this.surfImg || this.surfImg.width < w || this.surfImg.height < h) {
      const W = Math.max(w, this.surfImg?.width ?? 0);
      const H = Math.max(h, this.surfImg?.height ?? 0);
      this.surf.width = W;
      this.surf.height = H;
      this.surfImg = this.surfCtx.createImageData(W, H);
    }
    return this.surfImg;
  }

  private paintWire(p: CanvasRenderingContext2D, primary: Rgb, bg: Rgb, amp: number): void {
    const { edges, fade } = this.m;
    const { pv, pn, xs, ys } = this;
    const n = this.nv;
    if (this.sVa.length < n) this.sVa = new Float32Array(n);
    const va = this.sVa;
    for (let i = 0; i < n; i++) {
      const nz = pn[i * 3 + 2];
      const fres = Math.abs(1 - Math.abs(nz)) ** 1.5;
      const sweep = Math.exp(-(((pv[i * 3 + 1] - this.scan) / 0.13) ** 2));
      let a: number;
      if (this.shaded) {
        // The lit surface underneath is opaque, so back-facing edges would float
        // on top of the face — cull them and let the wire read as structure
        // lines over skin.
        const front = nz > -0.05 ? 1 : 0;
        a = front ? 0.1 + 0.42 * fres : 0;
        a += 0.3 * sweep * front;
      } else {
        a = nz < 0 ? 0.13 + 0.26 * fres : 0.28 + 0.72 * fres;
        a += 0.42 * sweep;
      }
      va[i] = a * fade[i] * (0.8 + 0.45 * amp);
    }

    const skin = this.shaded ? blend(bg, primary, 132) : bg;
    const paths: Path2D[] = [];
    for (let b = 0; b < BUCKETS; b++) paths.push(new Path2D());
    const used = new Array<boolean>(BUCKETS).fill(false);
    for (let e = 0; e < edges.length; e += 2) {
      const i = edges[e], j = edges[e + 1];
      const ea = 0.5 * (va[i] + va[j]);
      if (!(ea > MIN_ALPHA)) continue;
      const b = clamp(Math.trunc(ea * BUCKETS), 0, BUCKETS - 1);
      paths[b].moveTo(xs[i], ys[i]);
      paths[b].lineTo(xs[j], ys[j]);
      used[b] = true;
    }
    p.lineWidth = 1;
    p.lineCap = 'butt';
    for (let b = 0; b < BUCKETS; b++) {
      if (!used[b]) continue;
      const a = 255 * Math.min(1, (b + 0.5) / BUCKETS);
      // Over lit skin, pre-mix against a representative skin tone rather than
      // the background, so the lines still read as highlights over the face.
      p.strokeStyle = css(this.shaded ? blend(skin, primary, a * 0.75) : blend(bg, primary, a));
      p.stroke(paths[b]);
    }
  }

  // ── face ──────────────────────────────────────────────────────────────────

  private ring(idx: readonly number[]): Pt[] {
    return idx.map((i) => [this.xs[i], this.ys[i]] as Pt);
  }

  private static poly(p: CanvasRenderingContext2D, pts: Pt[], close = true): void {
    p.beginPath();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    if (close) p.closePath();
  }

  private static bounds(pts: Pt[]): { x: number; y: number; w: number; h: number } {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Eyes, brows and the mouth cavity, drawn from the real landmark rings. The
   * canonical model's eyes and lips are closed skin — the geometry gives the
   * *shape* of the lids and mouth but no opening, so the openings are painted
   * here, exactly on the landmarks that bound them.
   */
  private paintFeatures(p: CanvasRenderingContext2D, primary: Rgb, accent: Rgb, bg: Rgb, amp: number): void {
    const face = Math.max(0, Math.cos(this.yaw) * Math.cos(this.pitch)) ** 2;
    if (face < 0.02) return;
    const lm = this.m.landmarks;
    const vis = 1 - this.blink;
    const P = HoloAvatar.poly;

    // ── eyes ──────────────────────────────────────────────────────────────
    for (const key of ['eye_l', 'eye_r'] as const) {
      let pts = this.ring(lm[key]);
      const midY = pts.reduce((s, q) => s + q[1], 0) / pts.length;
      if (vis < 0.999) {
        const k = Math.max(0.04, vis);
        pts = pts.map(([x, y]) => [x, midY + (y - midY) * k] as Pt);
      }
      P(p, pts);
      p.fillStyle = css(blend(bg, primary, 22)); // socket shadow
      p.fill('evenodd');
      p.strokeStyle = cssA(primary, 210 * face); // lid line
      p.lineWidth = 1.3;
      p.stroke();

      if (vis > 0.35) {
        const br = HoloAvatar.bounds(pts);
        const gx = br.x + br.w / 2 + this.gaze[0] * br.w * 0.16;
        const gy = br.y + br.h / 2 + this.gaze[1] * br.h * 0.2;
        const rad = Math.min(br.h * 0.62, br.w * 0.2);
        p.fillStyle = cssA(accent, (70 + 60 * amp) * face * vis);
        p.beginPath();
        p.ellipse(gx, gy, Math.max(0, rad), Math.max(0, rad * vis), 0, 0, Math.PI * 2);
        p.fill(); // iris
        p.fillStyle = cssA(accent, 245 * face * vis);
        p.beginPath();
        p.ellipse(gx, gy, Math.max(0, rad * 0.42), Math.max(0, rad * 0.42 * vis), 0, 0, Math.PI * 2);
        p.fill(); // pupil
      }
    }

    // ── brows ─────────────────────────────────────────────────────────────
    p.strokeStyle = cssA(primary, 150 * face);
    p.lineWidth = 1.7;
    for (const key of ['brow_l', 'brow_r'] as const) {
      P(p, this.ring(lm[key]), false);
      p.stroke();
    }

    // ── mouth ─────────────────────────────────────────────────────────────
    const inner = this.ring(lm.lips_in);
    const openH = HoloAvatar.bounds(inner).h;

    if (this.mouth > 0.02) {
      // The cavity is dark but never pure black — a black oval on a glowing
      // head reads as a hole, not a mouth.
      P(p, inner);
      p.fillStyle = css(blend(bg, primary, 16 + 26 * this.mouth));
      p.fill('evenodd');

      // Upper teeth: a bright strip hanging from the upper lip. The single
      // cheapest thing that makes an open mouth look like speech.
      const up = this.ring(this.lipUp);
      const th = openH * 0.3;
      const teeth: Pt[] = [...up, ...up.slice().reverse().map(([x, y]) => [x, y + th] as Pt)];
      P(p, teeth);
      p.fillStyle = css(blend(bg, primary, 150 + 60 * this.mouth));
      p.fill('evenodd');

      // A warm pool at the back of the throat, strongest when wide open.
      P(p, inner);
      p.fillStyle = cssA(accent, 40 * this.mouth * face);
      p.fill('evenodd');
    }

    P(p, inner);
    p.strokeStyle = cssA(primary, (150 + 70 * this.mouth) * face);
    p.lineWidth = 1.3;
    p.stroke(); // lip edge
    P(p, this.ring(lm.lips_out));
    p.strokeStyle = cssA(primary, 110 * face);
    p.lineWidth = 1.1;
    p.stroke();
  }
}

// The HUD centre panel: animation state and painting. Port of the HudCanvas
// class in Mark LIV's ui.py (`_step`, `_paint_core`, `paintEvent`, the grid,
// `push_visemes` / `set_audio_level` semantics). The React component in
// app/components/mark/HudCanvas.tsx only owns the canvas element and the frame
// loop; everything that decides what is on screen lives here.

import { hud, type ScheduledVisemes } from '../hud';
import { HoloAvatar } from './avatar';
import { blend, css, type HudPalette, type Rgb } from './palette';

/** Mark's QTimer period. Every per-tick constant below assumes it. */
export const TICK_MS = 16;

// Qt font sizes are points; Chromium draws in CSS pixels at 96 dpi.
const PT = 96 / 72;

export interface HudInputs {
  state: string;
  muted: boolean;
  hudStyle: 'face' | 'core';
  /** Already upper-cased, as Mark displays it. */
  name: string;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const uniform = (a: number, b: number) => a + (b - a) * Math.random();
const rad = (deg: number) => (deg * Math.PI) / 180;

export class HudRenderer {
  /** The holographic head. Null only if the mesh could not be built. */
  readonly avatar: HoloAvatar | null;

  private tick = 0;
  private scale = 1.0;
  private tgtScale = 1.0;
  private halo = 55.0;
  private tgtHalo = 55.0;
  private lastT = 0;
  private stepT: number | null = null;
  private blinkOn = true;
  private blinkTick = 0;
  private corePhase = 0;
  private paintTick = 0;

  // Live audio reactivity: liveAmp is the peak-held level pushed by the audio
  // side, ampDisp the smoothed value the paint code reads.
  private liveAmp = 0;
  ampDisp = 0;
  private baseScale = 1.0;
  private baseHalo = 55.0;

  private levelSeenAt = 0;
  private glanceSeenAt = 0;

  private gridCache: HTMLCanvasElement | OffscreenCanvas | null = null;
  private gridKey = '';

  constructor() {
    let av: HoloAvatar | null = null;
    try {
      av = new HoloAvatar();
    } catch (err) {
      // Fall back to the reactor core so the panel is never empty.
      console.warn('[mark] avatar unavailable, using the reactor core:', err);
    }
    this.avatar = av;
  }

  /** Current state as flags, the way Mark's MainWindow sets them on the canvas. */
  private static flags(inp: HudInputs) {
    return { speaking: inp.state === 'SPEAKING', muted: inp.muted, state: inp.state };
  }

  /** Take whatever the hub has for us: new levels (peak-held) and glances. */
  private pull(): void {
    // set_audio_level: keep the louder of the incoming level and the current
    // value, so brief gaps between chunks don't make the waveform stutter.
    if (hud.levelAt !== this.levelSeenAt) {
      this.levelSeenAt = hud.levelAt;
      const lv = clamp(Number.isFinite(hud.level) ? hud.level : 0, 0, 1);
      if (lv > this.liveAmp) this.liveAmp = lv;
    }
    const g = hud.glanceReq;
    if (g && g.at !== this.glanceSeenAt) {
      this.glanceSeenAt = g.at;
      this.avatar?.glance(g.dx, g.dy, g.hold);
    }
  }

  /** The newest schedule covering `t` and the frame index in it, like hud.visemeAt. */
  private static scheduleAt(t: number): [ScheduledVisemes, number] | null {
    for (let k = hud.visemes.length - 1; k >= 0; k--) {
      const s = hud.visemes[k];
      const idx = Math.floor((t - s.at) / s.hopMs);
      if (idx >= 0 && idx < s.frames.length) return [s, idx];
    }
    return null;
  }

  /**
   * One 16 ms animation step at `nowMs` (performance.now() time base). Returns
   * whether this tick should repaint — Mark's throttle: ~30 Hz while active,
   * ~20 Hz idle, plus every status-glyph blink.
   */
  step(nowMs: number, inp: HudInputs): boolean {
    this.tick += 1;
    const now = nowMs / 1000;
    const { speaking, muted, state } = HudRenderer.flags(inp);
    this.pull();

    // ── live audio reactivity ─────────────────────────────────────────────
    // A viseme schedule, if one is playing, gives both the level and the mouth
    // shape for this exact instant; otherwise fall back to the peak level.
    let vOpen: number | null = null;
    let vWide: number | null = null;
    let vLevel: number | null = null;
    let vSeq: Array<[number, number, number]> | null = null;
    let vHop = 0.02;
    const hit = HudRenderer.scheduleAt(nowMs);
    if (hit) {
      const [s, i] = hit;
      vHop = s.hopMs / 1000;
      // Hand over *every* frame since the last tick, not just the one under the
      // cursor: a tick can span two or three 20 ms frames and a consonant
      // closure is only two frames long. Successive batches are separate
      // schedules here, so "since the last tick" is measured in time, which
      // carries straight across a batch boundary like Mark's merged timeline.
      let j = i;
      if (this.stepT != null) j = Math.floor((this.stepT * 1000 - s.at) / s.hopMs) + 1;
      j = clamp(j, Math.max(0, i - 12), i + 1);
      vSeq = [];
      for (let k = j; k <= i; k++) {
        const f = s.frames[k];
        vSeq.push([f.level, f.open, f.width]);
      }
      const f = s.frames[i];
      vLevel = f.level;
      vOpen = f.open;
      vWide = f.width;
      if (vSeq.length) {
        const peak = Math.max(...vSeq.map((q) => q[0]));
        if (peak > this.liveAmp) this.liveAmp = peak;
      }
    }

    // Decay toward silence so gaps between chunks fade out instead of
    // freezing, then smooth it.
    this.liveAmp *= 0.86;
    this.ampDisp += (this.liveAmp - this.ampDisp) * 0.45;
    const amp = this.ampDisp;

    const dt = this.stepT == null ? TICK_MS / 1000 : now - this.stepT;
    this.stepT = now;
    // Integrated, not derived from absolute time: a rate that changes with
    // state would otherwise jump the rings the instant speech starts.
    this.corePhase += Math.min(0.1, Math.max(0, dt));

    if (this.avatar && inp.hudStyle === 'face') {
      this.avatar.step(dt, amp, {
        speaking,
        muted,
        state,
        vOpen,
        vWide: vWide ?? 0,
        vLevel,
        vSeq,
        vHop,
      });
    } else {
      // Reactor core: slow "breathing" base target, lifted by the level.
      if (now - this.lastT > (speaking ? 0.12 : 0.5)) {
        if (speaking) {
          this.baseScale = 1.03;
          this.baseHalo = 122.0;
        } else if (muted) {
          this.baseScale = uniform(0.998, 1.002);
          this.baseHalo = uniform(15, 28);
        } else {
          this.baseScale = uniform(1.001, 1.008);
          this.baseHalo = uniform(48, 68);
        }
        this.lastT = now;
      }
      if (muted) {
        this.tgtScale = this.baseScale;
        this.tgtHalo = this.baseHalo;
      } else if (speaking) {
        this.tgtScale = this.baseScale + amp * 0.13;
        this.tgtHalo = this.baseHalo + amp * 95.0;
      } else {
        this.tgtScale = this.baseScale + amp * 0.06;
        this.tgtHalo = this.baseHalo + amp * 75.0;
      }
      const sp = speaking ? 0.38 : amp > 0.02 ? 0.3 : 0.15;
      this.scale += (this.tgtScale - this.scale) * sp;
      this.halo += (this.tgtHalo - this.halo) * sp;
    }

    this.blinkTick += 1;
    let blinked = false;
    if (this.blinkTick >= 38) {
      this.blinkOn = !this.blinkOn;
      this.blinkTick = 0;
      blinked = true;
    }

    // Repaint throttling: stepping is cheap at 60 Hz, the paint is not. Active
    // runs at ~30 Hz, idle at ~20 Hz; the motion stays smooth either way
    // because the state keeps stepping at the full rate.
    this.paintTick = (this.paintTick + 1) % 6;
    const active = speaking || amp > 0.02 || state === 'THINKING' || state === 'PROCESSING';
    return blinked || (active ? this.paintTick % 2 === 0 : this.paintTick % 3 === 0);
  }

  /** Forget the step clock, e.g. after the window was hidden: resume mid-motion, don't jump. */
  resetClock(): void {
    this.stepT = null;
  }

  // ── grid ──────────────────────────────────────────────────────────────────

  /** Static grid dots, pre-rendered once per size/theme so each frame is one blit. */
  private grid(W: number, H: number, dpr: number, col: Rgb): CanvasImageSource {
    const key = `${W}x${H}@${dpr}|${css(col)}`;
    if (!this.gridCache || this.gridKey !== key) {
      const pw = Math.max(1, Math.round(W * dpr));
      const ph = Math.max(1, Math.round(H * dpr));
      const c: HTMLCanvasElement | OffscreenCanvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(pw, ph)
          : Object.assign(document.createElement('canvas'), { width: pw, height: ph });
      const g = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (g) {
        g.fillStyle = css(col);
        const d = Math.max(1, Math.round(dpr));
        for (let x = 0; x < W; x += 48) {
          for (let y = 0; y < H; y += 48) g.fillRect(Math.round(x * dpr), Math.round(y * dpr), d, d);
        }
      }
      this.gridCache = c;
      this.gridKey = key;
    }
    return this.gridCache;
  }

  // ── reactor core ──────────────────────────────────────────────────────────
  // The centrepiece for anyone who did not want a face looking back at them.
  // Everything on it means something: the rings turn at a rate the state sets,
  // the spectrum ring is the real audio level, and the core brightens with the
  // voice.

  private coreColours(pal: HudPalette, inp: HudInputs): [Rgb, Rgb] {
    const { speaking, muted, state } = HudRenderer.flags(inp);
    if (muted) return [pal.MUTED_C, pal.MUTED_C];
    if (speaking) return [pal.PRI, pal.ACC];
    if (state === 'THINKING' || state === 'PROCESSING') return [pal.PRI, pal.ACC2];
    if (state === 'LISTENING') return [pal.PRI, pal.GREEN];
    return [pal.PRI, pal.PRI_DIM];
  }

  private paintCore(p: CanvasRenderingContext2D, cx: number, cy: number, r: number, W: number, H: number, pal: HudPalette, inp: HudInputs): void {
    const [main, acc] = this.coreColours(pal, inp);
    const { speaking, muted, state } = HudRenderer.flags(inp);
    const bg = pal.BG;
    const amp = this.ampDisp;
    const t = this.corePhase;
    const live = (speaking || amp > 0.04) && !muted;
    // Pre-mixed onto the background, like Mark (its opaque raster path).
    const mix = (col: Rgb, a: number) => css(blend(bg, col, 255 * clamp(a, 0, 1)));
    const line = (x0: number, y0: number, x1: number, y1: number) => {
      p.moveTo(x0, y0);
      p.lineTo(x1, y1);
    };
    const circle = (rr: number) => {
      p.beginPath();
      p.arc(cx, cy, Math.max(0, rr), 0, Math.PI * 2);
    };

    // 1. The atmosphere: a wide, soft body of light that gives the thing
    //    presence before any detail is read. Ending it at two thirds leaves it
    //    somewhere to fall off to, which makes it look lit rather than tinted.
    const lift = 1.0 + 0.55 * amp + (speaking ? 0.18 : 0.0);
    for (const [gr, a0, a1] of [
      [r * 0.7, 0.3, 0.0],
      [r * 0.34, 0.34, 0.0],
    ]) {
      const g = p.createRadialGradient(cx, cy, 0, cx, cy, gr);
      g.addColorStop(0, mix(main, Math.min(0.95, a0 * lift)));
      g.addColorStop(0.45, mix(main, Math.min(0.95, a0 * lift * 0.52)));
      g.addColorStop(0.78, mix(main, Math.min(0.95, a0 * lift * 0.18)));
      g.addColorStop(1, mix(main, a1));
      p.fillStyle = g;
      circle(gr);
      p.fill();
    }

    // 2. Frame marks at the corners of the whole canvas, not of the circle —
    //    they make the reactor read as filling the room.
    if (W > 40 && H > 40) {
      const m = Math.min(W, H) * 0.035;
      const arm = Math.min(W, H) * 0.055;
      p.strokeStyle = mix(main, 0.45);
      p.lineWidth = 1.4;
      p.beginPath();
      for (const [sx, sy] of [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]) {
        const x = cx + sx * (W / 2 - m);
        const y = cy + sy * (H / 2 - m);
        line(x, y, x - sx * arm, y);
        line(x, y, x, y - sy * arm);
      }
      p.stroke();
    }

    // 3. Crosshair across the full canvas, broken around the core.
    p.strokeStyle = mix(main, 0.16);
    p.lineWidth = 1;
    const gap = r * 0.62;
    p.beginPath();
    if (W > 40) {
      line(cx - W / 2, cy, cx - gap, cy);
      line(cx + gap, cy, cx + W / 2, cy);
    }
    if (H > 40) {
      line(cx, cy - H / 2, cx, cy - gap);
      line(cx, cy + gap, cx, cy + H / 2);
    }
    p.stroke();

    // 4. Two thin outer circles. Sparse on purpose.
    for (const [rr, a] of [
      [1.0, 0.34],
      [0.93, 0.16],
    ]) {
      p.strokeStyle = mix(main, a);
      p.lineWidth = 1;
      circle(r * rr);
      p.stroke();
    }

    // 5. Long, sparse graduations: 24 majors, shorter minors between them.
    const major = new Path2D();
    const minor = new Path2D();
    for (let i = 0; i < 72; i++) {
      const a = rad(i * 5.0);
      const ca = Math.cos(a), sa = Math.sin(a);
      if (i % 3 === 0) {
        major.moveTo(cx + ca * r * 0.885, cy + sa * r * 0.885);
        major.lineTo(cx + ca * r * 0.985, cy + sa * r * 0.985);
      } else {
        minor.moveTo(cx + ca * r * 0.945, cy + sa * r * 0.945);
        minor.lineTo(cx + ca * r * 0.985, cy + sa * r * 0.985);
      }
    }
    p.strokeStyle = mix(main, 0.42);
    p.lineWidth = 1.3;
    p.stroke(major);
    p.strokeStyle = mix(main, 0.18);
    p.lineWidth = 1;
    p.stroke(minor);

    // 6. Sweeping arcs. Speed is the state: idle drifts, thinking hurries,
    //    speaking runs.
    const spin = 1.0 + (state === 'THINKING' || state === 'PROCESSING' ? 1.9 : 0.0) + (speaking ? 1.2 : 0.0);
    const arcs: Array<[number, number, number, number, Rgb, number, number]> = [
      [0.955, 118, 2, +1, acc, 0.75, 2.0],
      [0.845, 82, 3, -1, main, 0.38, 1.3],
      [0.76, 150, 1, +1, acc, 0.45, 1.6],
      [0.66, 64, 4, -1, main, 0.26, 1.1],
      [0.545, 128, 2, +1, main, 0.3, 1.2],
    ];
    arcs.forEach(([rr, span, count, dirn, col, a, wid], k) => {
      const radius = r * rr;
      p.strokeStyle = mix(col, a);
      p.lineWidth = wid;
      const base = (((t * spin * (9 + k * 6) * dirn) % 360) + 360) % 360;
      for (let sg = 0; sg < count; sg++) {
        // Qt angles run counter-clockwise from 3 o'clock in 1/16°, truncated.
        const start = Math.trunc((base + sg * (360 / count)) * 16) / 16;
        const len = Math.trunc(span * 16) / 16;
        p.beginPath();
        p.arc(cx, cy, radius, -rad(start), -rad(start + len), true);
        p.stroke();
      }
    });

    // 7. The voice, as a ring of graduations that grow with it.
    const n = 60;
    const ring = r * 0.415;
    const spikes = new Path2D();
    for (let i = 0; i < n; i++) {
      const a = rad(i * (360 / n));
      const ca = Math.cos(a), sa = Math.sin(a);
      const wob = 0.5 + 0.5 * Math.sin(t * 2.3 + i * 0.42);
      const idle = 0.018 + 0.012 * Math.sin(t * 1.2 + i * 0.7);
      const h = r * (idle + (live ? amp * 0.2 * wob : 0));
      spikes.moveTo(cx + ca * ring, cy + sa * ring);
      spikes.lineTo(cx + ca * (ring + h), cy + sa * (ring + h));
    }
    p.strokeStyle = mix(live ? acc : main, 0.25 + 0.5 * amp);
    p.lineWidth = 1.6;
    p.stroke(spikes);

    // 8. The inner ring the name sits in.
    const inner = r * 0.355;
    p.strokeStyle = mix(acc, 0.3 + 0.45 * amp);
    p.lineWidth = 1.5;
    circle(inner);
    p.stroke();

    // 9. The name, sized from the string rather than the radius alone: a long
    //    name and a short one are very different widths.
    const name = inp.name || '';
    if (name) {
      const space = Math.max(1, r * 0.018);
      const len = Array.from(name).length;
      const fsz = Math.max(8, Math.trunc(Math.min(r * 0.105, ((inner * 1.75) / Math.max(1, len)) * 1.6 - space)));
      p.font = `bold ${(fsz * PT).toFixed(2)}px "Courier New", monospace`;
      setLetterSpacing(p, space);
      p.fillStyle = mix(pal.WHITE, 0.6 + 0.4 * Math.min(1, amp * 2));
      p.textAlign = 'center';
      p.textBaseline = 'middle';
      p.fillText(name, cx, cy);
      setLetterSpacing(p, 0);
    }
  }

  // ── the whole panel ───────────────────────────────────────────────────────

  /** Paint one frame. `W`/`H` in CSS pixels; the context is already scaled by dpr. */
  paint(p: CanvasRenderingContext2D, W: number, H: number, dpr: number, pal: HudPalette, inp: HudInputs): void {
    const { speaking, muted, state } = HudRenderer.flags(inp);
    p.fillStyle = css(pal.BG);
    p.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;
    const fw = Math.min(W, H);

    // Grid dots, blitted from a cached layer; rebuilt only when the size or the
    // theme's ghost colour changes, so live re-theming still works.
    p.save();
    p.setTransform(1, 0, 0, 1, 0, 0);
    p.drawImage(this.grid(W, H, dpr, pal.PRI_GHO), 0, 0);
    p.restore();

    // ── holographic head ──────────────────────────────────────────────────
    // Sized to the band between the top of the canvas and the status line,
    // capped by width, so it fills the HUD at any size without colliding with
    // the status text below.
    const syStatus = cy + fw * 0.4;
    const bandT = 12.0;
    const bandH = Math.max(60.0, syStatus - 12.0 - bandT);
    if (this.avatar && inp.hudStyle === 'face') {
      const av = this.avatar;
      const rHead = Math.min(fw * 0.355, bandH / (av.SPAN + 0.08));
      const headCy = bandT + (bandH - av.SPAN * rHead) / 2.0 + rHead;
      let main: Rgb;
      let acc: Rgb;
      if (muted) {
        main = acc = pal.MUTED_C;
      } else {
        main = pal.PRI;
        if (speaking) acc = pal.ACC;
        else if (state === 'THINKING' || state === 'PROCESSING') acc = pal.ACC2;
        else if (state === 'LISTENING') acc = pal.GREEN;
        else acc = pal.PRI;
      }
      av.paint(p, cx, headCy, rHead, main, acc, pal.BG);
    } else {
      // Reactor core — the other centrepiece, and the fallback if the head
      // could not be built.
      const r = Math.min(W * 0.46, bandH / 2.0);
      this.paintCore(p, cx, bandT + bandH / 2.0, r, W, bandH, pal, inp);
    }

    // ── status text ───────────────────────────────────────────────────────
    const sy = syStatus;
    let txt: string;
    let col: Rgb;
    if (muted) {
      txt = '⊘  MUTED';
      col = pal.MUTED_C;
    } else if (speaking) {
      txt = '●  SPEAKING';
      col = pal.ACC;
    } else if (state === 'THINKING') {
      txt = `${this.blinkOn ? '◈' : '◇'}  THINKING`;
      col = pal.ACC2;
    } else if (state === 'PROCESSING') {
      txt = `${this.blinkOn ? '▷' : '▶'}  PROCESSING`;
      col = pal.ACC2;
    } else if (state === 'LISTENING') {
      txt = `${this.blinkOn ? '●' : '○'}  LISTENING`;
      col = pal.GREEN;
    } else {
      txt = `${this.blinkOn ? '●' : '○'}  ${state}`;
      col = pal.PRI;
    }
    p.fillStyle = css(col);
    p.font = `bold ${(11 * PT).toFixed(2)}px "Courier New", monospace`;
    p.textAlign = 'center';
    p.textBaseline = 'middle';
    p.fillText(txt, W / 2, sy + 13);

    // ── waveform ──────────────────────────────────────────────────────────
    // Reacts to the real audio level (mic while listening, the assistant's own
    // voice while speaking), with a gentle idle ripple in silence.
    const wy = sy + 30;
    const N = 36;
    const bw = 8;
    const wx0 = (W - N * bw) / 2;
    const amp = this.ampDisp;
    const mid = (N - 1) / 2.0;
    for (let i = 0; i < N; i++) {
      let hgt: number;
      let cl: Rgb;
      if (muted) {
        hgt = 2;
        cl = pal.MUTED_C;
      } else {
        const env = (1.0 - Math.abs(i - mid) / mid) ** 0.7; // centre-weighted hump
        const shimmer = 0.55 + 0.45 * Math.sin(this.tick * 0.18 + i * 0.7);
        const idle = 3.0 + 2.0 * Math.sin(this.tick * 0.09 + i * 0.6);
        hgt = Math.trunc(Math.max(2, Math.min(24, idle + amp * 22.0 * env * shimmer)));
        if (amp > 0.05) cl = hgt > 12 ? pal.PRI : pal.PRI_DIM;
        else cl = pal.BORDER_B;
      }
      p.fillStyle = css(cl);
      p.fillRect(wx0 + i * bw, wy + 20 - hgt, bw - 1, hgt);
    }
  }
}

/** Qt's absolute letter spacing; Chromium has had ctx.letterSpacing since 99. */
function setLetterSpacing(p: CanvasRenderingContext2D, px: number): void {
  const q = p as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in q) q.letterSpacing = `${px}px`;
}

// The HUD signal hub.
//
// The audio pipeline produces things at 50 Hz — levels, mouth shapes — that
// must never go through React state. They land here instead, and the canvas
// (avatar or reactor core) reads them from its own animation loop. The Live
// controller writes; the canvas reads. Neither imports the other.
//
// Time base: every `at` is performance.now() milliseconds.

import type { HudState } from './types';

/** One mouth frame. level = loudness 0..1, open = jaw 0..1, width = -1 (round) .. 1 (spread). */
export interface VisemeFrame {
  level: number;
  open: number;
  width: number;
  /** Lip closure forced by the transcript (m/b/p), 0..1. */
  close?: number;
  /** Anything else the viseme stream wants the renderer to have. */
  [k: string]: number | undefined;
}

export interface ScheduledVisemes {
  frames: VisemeFrame[];
  hopMs: number;
  at: number;
}

type Listener = () => void;

class HudSignals {
  state: HudState = 'SLEEPING';
  /** Waveform level 0..1: the mic while listening, the assistant while speaking. */
  level = 0;
  levelAt = 0;
  /** Mouth schedule, oldest first. The canvas drops entries it has played. */
  visemes: ScheduledVisemes[] = [];
  /** Latest glance request, consumed by the face. */
  glanceReq: { dx: number; dy: number; hold: number; at: number } | null = null;
  /** Bumped whenever something new lands in the content panel. */
  contentAt = 0;

  private listeners = new Set<Listener>();

  setState(s: HudState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit();
  }

  setAudioLevel(level: number): void {
    this.level = Math.max(0, Math.min(1, level || 0));
    this.levelAt = performance.now();
  }

  /**
   * Hand the canvas a schedule of mouth frames, `hopSec` apart, the first one
   * audible at `at` (performance.now() ms).
   */
  pushVisemes(frames: VisemeFrame[], hopSec: number, at: number): void {
    if (!frames.length) return;
    this.visemes.push({ frames, hopMs: hopSec * 1000, at });
    // Keep a bounded backlog: anything this far behind has already played.
    const now = performance.now();
    this.visemes = this.visemes.filter((s) => s.at + s.frames.length * s.hopMs > now - 500);
  }

  clearVisemes(): void {
    this.visemes = [];
  }

  /** The frame that should be on the lips at time `t`, or null in silence. */
  visemeAt(t: number): VisemeFrame | null {
    for (let i = this.visemes.length - 1; i >= 0; i--) {
      const s = this.visemes[i];
      const idx = Math.floor((t - s.at) / s.hopMs);
      if (idx >= 0 && idx < s.frames.length) return s.frames[idx];
    }
    return null;
  }

  glance(dx: number, dy: number, hold = 1.1): void {
    this.glanceReq = { dx, dy, hold, at: performance.now() };
  }

  contentShown(): void {
    this.contentAt = performance.now();
    // The face glances down at what just landed: a wordless "that arrived".
    this.glance(0, 0.6, 1.1);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}

export const hud = new HudSignals();

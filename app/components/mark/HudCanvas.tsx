'use client';

// The HUD centrepiece: Mark LIV's holographic head (or reactor core), status
// line and waveform. The drawing is in lib/mark/avatar/*; this component owns
// the canvas, its size and the frame loop.
//
// Nothing here goes through React state per frame. The loop reads the 50 Hz
// signals straight from `hud`, the accent from `accentColor()` and the muted
// flag from the store's snapshot, so a retint or a state change shows on the
// very next frame without a re-render.

import { useEffect, useRef } from 'react';
import { hud } from '@/lib/mark/hud';
import { accentColor, useMarkStore } from '@/lib/mark/store';
import { hudPalette } from '@/lib/mark/avatar/palette';
import { HudRenderer, TICK_MS, type HudInputs } from '@/lib/mark/avatar/render';

// After this long without a frame (window hidden, machine asleep) the step
// clock is re-anchored instead of replaying the gap: the face resumes
// mid-motion, like Mark after it is restored from the taskbar.
const MAX_CATCHUP_MS = 250;

export default function HudCanvas({ className, assistantName }: { className?: string; assistantName?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hudStyle = useMarkStore((s) => s.config?.hud_style) ?? 'face';
  const cfgName = useMarkStore((s) => s.config?.assistant_name);

  // The loop reads these through a ref so changing them never restarts it.
  const inputs = useRef<{ hudStyle: 'face' | 'core'; name: string }>({ hudStyle: 'face', name: '' });
  inputs.current.hudStyle = hudStyle === 'core' ? 'core' : 'face';
  inputs.current.name = (assistantName ?? cfgName ?? '').toUpperCase();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const renderer = new HudRenderer();
    let W = 0;
    let H = 0;
    let dpr = 1;
    let raf = 0;
    let stepAt = 0; // performance.now() of the last animation step
    let dirty = true; // size or theme changed: paint on the next frame regardless
    let lastAccent = '';

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const nd = window.devicePixelRatio || 1;
      const nw = Math.max(1, Math.round(rect.width));
      const nh = Math.max(1, Math.round(rect.height));
      if (nw === W && nh === H && nd === dpr) return;
      W = nw;
      H = nh;
      dpr = nd;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      dirty = true;
    };

    const snapshot = (): HudInputs => ({
      state: hud.state,
      muted: useMarkStore.getState().muted,
      hudStyle: inputs.current.hudStyle,
      name: inputs.current.name,
    });

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      // Size changes arrive through the ResizeObserver; measuring the element
      // here forced a layout every frame. Only the display scale (dragging to
      // another monitor) needs checking, and reading it costs nothing.
      if ((window.devicePixelRatio || 1) !== dpr) resize();

      // Fixed 16 ms steps, like Mark's QTimer: every per-tick constant in the
      // port (decays, lerps, blink counter, waveform phase) assumes that rate,
      // and a 144 Hz display must not animate faster than a 60 Hz one.
      if (now - stepAt > MAX_CATCHUP_MS) {
        stepAt = now - TICK_MS;
        renderer.resetClock();
      }
      const inp = snapshot();
      let paint = false;
      while (now - stepAt >= TICK_MS) {
        stepAt += TICK_MS;
        if (renderer.step(stepAt, inp)) paint = true;
      }

      const acc = accentColor();
      if (acc !== lastAccent) {
        lastAccent = acc;
        dirty = true; // retint now, not at the next throttled paint
      }
      if (!paint && !dirty) return;
      dirty = false;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderer.paint(ctx, W, H, dpr, hudPalette(acc), inp);
    };

    const onVisible = () => {
      if (!document.hidden) dirty = true;
    };

    const ro = new ResizeObserver(() => {
      resize();
    });
    ro.observe(canvas);
    document.addEventListener('visibilitychange', onVisible);
    stepAt = performance.now();
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  );
}

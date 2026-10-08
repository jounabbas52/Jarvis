'use client';

// Mark's HueWheel: a ring of every hue with a white handle you drag round it,
// and a filled centre circle previewing the pick. Hue is measured
// counter-clockwise from 3 o'clock (Qt's conical gradient / atan2 with the
// y axis flipped), so a given hue sits in the same place as in Mark.
//
// onPick fires while dragging (Mark: hue_picked — hex box only, no theme),
// onCommit when the handle is released (hue_committed — live preview).

import { useCallback, useEffect, useRef } from 'react';

const SIZE = 148;
const RING = 16;

/** hsv(h, 1, 1) → #rrggbb, like QColor.fromHsvF(h, 1, 1).name(). */
export function hueToHex(h: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const q = 1 - f;
  const [r, g, b] = [
    [1, f, 0],
    [q, 1, 0],
    [0, 1, f],
    [0, q, 1],
    [f, 0, 1],
    [1, 0, q],
  ][((i % 6) + 6) % 6];
  const c = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Hue of a hex colour, or null if invalid or achromatic (Qt: hsvHueF() < 0). */
export function hexToHue(hex: string): number | null {
  const t = (hex || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(t)) return null;
  const r = parseInt(t.slice(1, 3), 16) / 255;
  const g = parseInt(t.slice(3, 5), 16) / 255;
  const b = parseInt(t.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return h < 0 ? h + 1 : h;
}

export default function HueWheel(props: {
  hue: number;
  onPick(hex: string, hue: number): void;
  onCommit(hex: string, hue: number): void;
}) {
  const { hue, onPick, onCommit } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef(false);
  // Last hue under the pointer, so release commits exactly what was picked
  // even if React has not re-rendered since the last move.
  const hueRef = useRef(hue);
  useEffect(() => {
    if (!drag.current) hueRef.current = hue;
  }, [hue]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = SIZE * dpr;
    cv.height = SIZE * dpr;
    const p = cv.getContext('2d');
    if (!p) return;
    p.setTransform(dpr, 0, 0, dpr, 0, 0);
    p.clearRect(0, 0, SIZE, SIZE);

    const c = SIZE / 2;
    const r = SIZE / 2 - (RING / 2 + 3);

    // The ring, in thin wedges. Canvas angles run clockwise (y down), so the
    // math angle a is drawn at -a.
    p.lineWidth = RING;
    const steps = 180;
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2;
      const a1 = ((i + 1.5) / steps) * Math.PI * 2;
      p.strokeStyle = hueToHex(i / steps);
      p.beginPath();
      p.arc(c, c, r, -a1, -a0);
      p.stroke();
    }

    // Centre preview circle (Mark: ring rect shrunk by 30 px each side).
    const style = getComputedStyle(cv);
    p.lineWidth = 1;
    p.strokeStyle = style.getPropertyValue('--o-border-b').trim() || '#1a5c7a';
    p.fillStyle = hueToHex(hue);
    p.beginPath();
    p.arc(c, c, r - 30, 0, Math.PI * 2);
    p.fill();
    p.stroke();

    // Handle.
    const ang = hue * Math.PI * 2;
    const hx = c + r * Math.cos(ang);
    const hy = c - r * Math.sin(ang);
    p.lineWidth = 2;
    p.strokeStyle = '#00060a';
    p.fillStyle = '#ffffff';
    p.beginPath();
    p.arc(hx, hy, 7.5, 0, Math.PI * 2);
    p.fill();
    p.stroke();
  }, [hue]);

  const hueAt = useCallback((e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = rect.top + rect.height / 2 - e.clientY; // flip to math axis
    const a = Math.atan2(dy, dx) / (Math.PI * 2);
    return ((a % 1) + 1) % 1;
  }, []);

  return (
    <canvas
      ref={canvas}
      className="mko-wheel"
      style={{ width: SIZE, height: SIZE }}
      onPointerDown={(e) => {
        drag.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        const h = hueAt(e);
        hueRef.current = h;
        onPick(hueToHex(h), h);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const h = hueAt(e);
        hueRef.current = h;
        onPick(hueToHex(h), h);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onCommit(hueToHex(hueRef.current), hueRef.current);
      }}
      onPointerCancel={() => {
        if (!drag.current) return;
        drag.current = false;
        onCommit(hueToHex(hueRef.current), hueRef.current);
      }}
    />
  );
}

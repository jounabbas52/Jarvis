'use client';

import { useLayoutEffect, useRef } from 'react';

export function hms(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The panel chrome under the HUD: ◈ TITLE ……… 12:00:00 [DISMISS ✕]. */
export function PanelHeader({ title, right, onDismiss }: { title: string; right?: string; onDismiss(): void }) {
  return (
    <div className="mk-panel-hdr">
      <span className="mk-panel-dot">◈</span>
      <span className="mk-panel-title">{title}</span>
      <span className="mk-panel-ts">{right || ''}</span>
      <button className="mk-dismiss" onClick={onDismiss}>
        DISMISS  ✕
      </button>
    </div>
  );
}

/**
 * Search results, news, briefings: whatever a tool hands to show_content().
 * A new arrival scrolls back to the top, like setPlainText + moveCursor(Start).
 */
export default function ContentPanel({
  title,
  text,
  at,
  height,
  onDismiss,
}: {
  title: string;
  text: string;
  at: number;
  height: number;
  onDismiss(): void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [at]);

  return (
    <div className="mk-panel" style={{ height }}>
      <PanelHeader title={(title || '').toUpperCase().slice(0, 48)} right={hms(at)} onDismiss={onDismiss} />
      <div className="mk-rule" />
      <div className="mk-panel-text" ref={bodyRef}>
        {(text || '').slice(0, 4000)}
      </div>
    </div>
  );
}

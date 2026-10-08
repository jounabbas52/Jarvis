'use client';

// Shared bits for the Mark LIV overlays: the floating panel shell and the Qt
// point-size scale. Mark sizes its overlays by hand and centres them over the
// HUD (_centre_overlay); here a flex layer does the centring, and each panel
// keeps Mark's width, margins and spacing.

import type { CSSProperties, ReactNode } from 'react';

/** Mark's Qt point sizes in CSS px (1pt ≈ 1.33px). */
export const PT: Record<number, string> = {
  7: '9.5px',
  8: '10.5px',
  9: '12px',
  10: '13.3px',
  11: '14.5px',
  12: '16px',
  13: '17.3px',
};

export function Panel(props: {
  width: number;
  /** Fixed height (Mark's _OH); clamped to the HUD, like `min(oh, cw.height() - 16)`. */
  height?: number;
  margins: [number, number];
  spacing: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { width, height, margins, spacing, className, style, children } = props;
  return (
    <div
      className={`mko-panel${className ? ` ${className}` : ''}`}
      style={{ width, maxWidth: '100%', height, ...style }}
      role="dialog"
    >
      <div
        className="mko-body"
        style={{ padding: `${margins[1]}px ${margins[0]}px`, gap: spacing, flex: '1 1 auto' }}
      >
        {children}
      </div>
    </div>
  );
}

export function Sep({ margin = 2 }: { margin?: number }) {
  return <hr className="mko-sep" style={{ margin: `${margin}px 0` }} />;
}

/** A spacing item, like QBoxLayout.addSpacing(). */
export function Gap({ h }: { h: number }) {
  return <div style={{ height: h, flex: 'none' }} />;
}

/** Plain Mark label: Courier, colour, size, optional bold. */
export function Lbl(props: {
  children: ReactNode;
  pt?: number;
  bold?: boolean;
  color?: string;
  align?: 'left' | 'center';
  style?: CSSProperties;
  title?: string;
}) {
  const { children, pt = 9, bold, color = 'var(--o-pri)', align = 'left', style, title } = props;
  return (
    <div
      title={title}
      style={{
        fontSize: PT[pt] ?? `${pt * 1.33}px`,
        fontWeight: bold ? 'bold' : 'normal',
        color,
        textAlign: align,
        whiteSpace: 'pre-wrap',
        flex: 'none',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

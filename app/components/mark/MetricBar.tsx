'use client';

import { memo } from 'react';

/**
 * One SYS MONITOR gauge. Past 65% it turns amber and past 85% red, whatever
 * its own colour — the colour is identity, the warning overrides it.
 */
function MetricBar({ label, color, value, text }: { label: string; color: string; value: number; text: string }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const barCol = v > 85 ? 'var(--mk-red)' : v > 65 ? 'var(--mk-acc)' : color;
  return (
    <div className="mk-metric">
      <span className="mk-metric-label">{label}</span>
      <span className="mk-metric-value" style={{ color: text !== '--' ? barCol : 'var(--mk-text-dim)' }}>
        {text}
      </span>
      <div className="mk-metric-track">
        {v > 0 && <div className="mk-metric-fill" style={{ width: `${v}%`, background: barCol }} />}
      </div>
    </div>
  );
}

export default memo(MetricBar);

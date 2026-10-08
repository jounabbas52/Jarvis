'use client';

// Mark's MemoryOverlay: everything the assistant has stored about you, newest
// first, with the date it learned it, and ✕ to forget one. A memory you
// cannot inspect is a memory you cannot trust, and "delete" has to be
// something the person can do.
//
// Mark's _settle/_rebuild dance existed to stop Qt leaving ghost pixels when
// the hand-placed panel shrank. Here the forgotten row collapses out, the list
// is re-read from disk, and the flex layer keeps the panel centred as it
// resizes.

import { useCallback, useEffect, useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import { markBridge, type MemoryRow } from '@/lib/mark/types';
import { Lbl, Panel, Sep, errText } from './common';

const rowId = (r: MemoryRow) => `${r.category}\u0000${r.key}`;

/** all_entries_for_ui order: newest first, undated last. */
function sortRows(rows: MemoryRow[]): MemoryRow[] {
  return [...rows].sort((a, b) =>
    (b.updated || '0000-00-00').localeCompare(a.updated || '0000-00-00'),
  );
}

export default function MemoryOverlay() {
  const name = useMarkStore((s) => s.config?.assistant_name) || 'JARVIS';
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');

  const rebuild = useCallback(async () => {
    const bridge = markBridge();
    if (!bridge) {
      setRows([]);
      return;
    }
    try {
      setRows(sortRows((await bridge.memoryList()) || []));
      setError('');
    } catch (e) {
      setRows((r) => r ?? []);
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    rebuild();
  }, [rebuild]);

  const forget = async (r: MemoryRow) => {
    const bridge = markBridge();
    if (!bridge) return;
    const id = rowId(r);
    if (leaving.has(id)) return;
    setLeaving((s) => new Set(s).add(id));
    try {
      await Promise.all([
        bridge.memoryForget(r.category, r.key),
        // Let the row finish collapsing before the list is replaced.
        new Promise((res) => setTimeout(res, 180)),
      ]);
    } catch (e) {
      setError(errText(e));
    }
    await rebuild();
    setLeaving((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  const count = rows?.length ?? 0;
  const visible = rows ? rows.length - [...leaving].filter((id) => rows.some((r) => rowId(r) === id)).length : 0;

  return (
    <Panel width={520} margins={[20, 16]} spacing={5} style={{ transition: 'height 180ms ease' }}>
      <Lbl pt={12} bold>
        {`🧠  WHAT ${name.toUpperCase()} REMEMBERS`}
      </Lbl>
      <Sep />
      <Lbl pt={7} color="var(--o-text-dim)">
        {rows === null
          ? 'Reading memory…'
          : `${count} stored facts — newest first. Nothing here is sent anywhere; it lives in ` +
            `long_term.json on this machine.`}
      </Lbl>

      {rows !== null && rows.length === 0 && (
        <Lbl pt={9} color="var(--o-text-med)">
          Nothing stored yet.
        </Lbl>
      )}

      {rows !== null && rows.length > 0 && (
        <div
          className="mko-scroll"
          style={{ height: Math.min(420, 34 * Math.max(visible, 1) + 10), flex: 'none' }}
        >
          {rows.map((r) => {
            const id = rowId(r);
            return (
              <div key={id} className={`mko-mem-row${leaving.has(id) ? ' leaving' : ''}`}>
                <div className="mko-mem-txt">
                  <b>{r.key.replace(/_/g, ' ')}</b>{' '}
                  <span style={{ color: 'var(--o-text-med)' }}>— {r.value}</span>
                </div>
                <div className="mko-mem-meta">{`${r.category.slice(0, 4)} · ${r.updated || '—'}`}</div>
                <button className="mko-x" title="Forget this" onClick={() => forget(r)}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <Lbl pt={7} color="#ff6b6b">
          {error}
        </Lbl>
      )}

      <button
        className="mko-btn mko-btn-sec"
        style={{ height: 30, flex: 'none' }}
        onClick={() => useMarkStore.getState().setOverlay(null)}
      >
        CLOSE
      </button>
    </Panel>
  );
}

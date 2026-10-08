'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import type { LogLine } from '@/lib/mark/store';

// Mark's LogWidget types each line out a glyph at a time (a 6 ms timer), then
// pauses 20 ms before the next queued line. Lines queue; nothing is dropped.
const CHAR_MS = 6;
const LINE_GAP_MS = 20;
/** A backlog this deep is not worth typing out; show it and type what follows. */
const MAX_BACKLOG = 60;

type Tag = 'you' | 'ai' | 'file' | 'err' | 'sys';

/** Colour by prefix, exactly in Mark's order: the first match wins. */
function tagOf(text: string, aiName: string): Tag {
  const tl = text.toLowerCase();
  if (tl.startsWith('you:')) return 'you';
  if (tl.startsWith(`${aiName}:`) || tl.startsWith('jarvis:')) return 'ai';
  if (tl.startsWith('file:')) return 'file';
  if (tl.includes('err')) return 'err';
  return 'sys';
}

export default function LogPanel() {
  const logs = useMarkStore((s) => s.logs);
  const aiName = useMarkStore((s) => (s.config?.assistant_name || 'jarvis').trim().toLowerCase());

  // Everything already in the log when the panel mounts is history: show it
  // at once rather than re-typing a whole session on every view switch.
  const [shownId, setShownId] = useState(() => (logs.length ? logs[logs.length - 1].id : 0));
  const [pos, setPos] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const pending = logs.filter((l) => l.id > shownId);
  const typing: LogLine | undefined = pending[0];

  useEffect(() => {
    if (pending.length > MAX_BACKLOG) {
      setShownId(pending[pending.length - MAX_BACKLOG - 1].id);
      setPos(0);
    }
  }, [pending.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!typing) return;
    let raf = 0;
    let gap: ReturnType<typeof setTimeout> | undefined;
    const start = performance.now();
    const len = typing.text.length;
    const step = () => {
      const n = Math.min(len, Math.floor((performance.now() - start) / CHAR_MS) + 1);
      setPos(n);
      if (n < len) {
        raf = requestAnimationFrame(step);
      } else {
        gap = setTimeout(() => {
          setShownId(typing.id);
          setPos(0);
        }, LINE_GAP_MS);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      if (gap) clearTimeout(gap);
    };
  }, [typing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the newest text unless the user scrolled up to read something.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = boxRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const done = logs.filter((l) => l.id <= shownId);
  return (
    <div className="mk-log" ref={boxRef} onScroll={onScroll}>
      {done.map((l) => (
        <div key={l.id} className={`mk-log-${tagOf(l.text, aiName)}`}>
          {l.text || ' '}
        </div>
      ))}
      {typing && pos > 0 && (
        <div key={typing.id} className={`mk-log-${tagOf(typing.text, aiName)}`}>
          {typing.text.slice(0, pos)}
        </div>
      )}
    </div>
  );
}

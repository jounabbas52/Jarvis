'use client';

import { useEffect } from 'react';
import { useMarkStore } from '@/lib/mark/store';

// The four quick actions and the exact command text Mark sends for each.
const ACTIONS: [string, string][] = [
  ['TRANSLATE', 'Translate this text to English: {text}'],
  ['SUMMARISE', 'Summarise this: {text}'],
  ['EXPLAIN', 'Explain this: {text}'],
  ['FIX', 'Fix grammar and spelling: {text}'],
];

/** Mark only offers help for a copy of at least this many characters. */
const MIN_LEN = 10;
const DISMISS_MS = 8000;

/** Floating panel shown when text is copied — offers quick assistant actions. */
export default function ClipboardPanel() {
  const clip = useMarkStore((s) => s.clipboard);
  const dismiss = useMarkStore((s) => s.dismissClipboard);
  const sendText = useMarkStore((s) => s.sendText);

  const text = (clip || '').trim();
  const visible = text.length >= MIN_LEN;

  // A fresh copy restarts the 8 s auto-dismiss.
  useEffect(() => {
    if (!clip) return;
    const t = setTimeout(dismiss, DISMISS_MS);
    return () => clearTimeout(t);
  }, [clip, dismiss]);

  if (!visible) return null;

  let preview = text.slice(0, 58).replace(/\n/g, ' ');
  if (text.length > 58) preview += '…';

  const trigger = (fmt: string) => {
    sendText(fmt.replace('{text}', text.slice(0, 800)));
    dismiss();
  };

  return (
    <div className="mk-clip">
      <div className="mk-clip-hdr">
        <span>◈  CLIPBOARD DETECTED</span>
        <button className="mk-x" onClick={dismiss} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="mk-clip-preview">&quot;{preview}&quot;</div>
      <div className="mk-clip-btns">
        {ACTIONS.map(([label, fmt]) => (
          <button key={label} onClick={() => trigger(fmt)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

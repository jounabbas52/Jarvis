'use client';

// Mark's ConfirmBanner: the gate in front of an action that cannot be taken
// back. The answer goes from a human finger to the main process
// (confirm.js) without the model in the loop. Nothing blocks while it is up;
// the main process withdraws it (confirm-hide) when its 90 s timeout lapses.

import { useMarkStore } from '@/lib/mark/store';
import { Lbl, Panel } from './common';

export default function ConfirmBanner(props: { title: string; detail: string }) {
  const { title, detail } = props;
  const answer = (ok: boolean) => useMarkStore.getState().answerConfirm(ok);
  return (
    <Panel width={430} margins={[20, 16]} spacing={8} className="mko-confirm">
      <Lbl pt={11} bold color="var(--o-acc)">
        ⚠  CONFIRM
      </Lbl>
      <Lbl pt={10} bold color="var(--o-text)" style={{ overflowWrap: 'anywhere' }}>
        {title}
      </Lbl>
      {detail && (
        <Lbl pt={8} color="var(--o-text-med)" style={{ overflowWrap: 'anywhere' }}>
          {detail}
        </Lbl>
      )}
      <div className="mko-row" style={{ flex: 'none' }}>
        <button className="mko-btn mko-btn-acc" onClick={() => answer(true)}>
          ▸  CONFIRM
        </button>
        {/* Default focus on CANCEL: Enter without reading picks the safe answer. */}
        <button
          className="mko-btn mko-btn-sec"
          style={{ height: 32 }}
          autoFocus
          onClick={() => answer(false)}
        >
          CANCEL
        </button>
      </div>
    </Panel>
  );
}

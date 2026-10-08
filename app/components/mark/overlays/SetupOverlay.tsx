'use client';

// First-boot setup (Mark's SetupOverlay): Gemini API key + operating system.
// There is no close button on purpose — nothing works without a key.

import { useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import type { MarkConfig } from '@/lib/mark/types';
import { Gap, Lbl, Panel, Sep } from './common';

type OsKey = MarkConfig['os'];

function detectOs(): OsKey {
  if (typeof navigator === 'undefined') return 'windows';
  const p = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  return 'linux';
}

const OS_BTNS: [OsKey, string][] = [
  ['windows', '⊞  Windows'],
  ['mac', '  macOS'],
  ['linux', '🐧  Linux'],
];
const OS_NAME: Record<OsKey, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
// Selected-button colours per OS, as in Mark's _sel(): (fg, bg).
const OS_PAL: Record<OsKey, [string, string]> = {
  windows: ['var(--o-pri)', '#001a22'],
  mac: ['var(--o-acc2)', '#1a1400'],
  linux: ['var(--o-green)', '#001a0d'],
};

export default function SetupOverlay() {
  const [detected] = useState<OsKey>(detectOs);
  const [os, setOs] = useState<OsKey>(detected);
  const [key, setKey] = useState('');
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const k = key.trim();
    if (!k) {
      setBad(true);
      return;
    }
    setBusy(true);
    const s = useMarkStore.getState();
    const ok = await s.saveApiKey(k, os).catch(() => false);
    setBusy(false);
    if (!ok) {
      setBad(true);
      return;
    }
    const name = useMarkStore.getState().config?.assistant_name || 'JARVIS';
    s.writeLog(`SYS: Initialised. OS=${os.toUpperCase()}. ${name} online.`);
  };

  return (
    <Panel width={460} margins={[30, 22]} spacing={8}>
      <Lbl pt={13} bold align="center">
        ◈  INITIALISATION REQUIRED
      </Lbl>
      <Lbl pt={9} align="center" color="var(--o-pri-dim)">
        Configure J.A.R.V.I.S. before first boot.
      </Lbl>
      <Gap h={6} />
      <Sep />
      <Gap h={4} />

      <Lbl pt={8} color="var(--o-text-dim)">
        GEMINI API KEY
      </Lbl>
      <input
        className={`mko-input${bad ? ' mko-bad' : ''}`}
        type="password"
        placeholder="AIza…"
        value={key}
        autoFocus
        spellCheck={false}
        onChange={(e) => {
          setKey(e.target.value);
          if (bad) setBad(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <Gap h={12} />
      <Sep />
      <Gap h={4} />

      <Lbl pt={8} color="var(--o-text-dim)">
        OPERATING SYSTEM
      </Lbl>
      <Lbl pt={8} color="var(--o-acc2)">
        {`Auto-detected: ${OS_NAME[detected]}`}
      </Lbl>
      <div className="mko-row" style={{ gap: 6 }}>
        {OS_BTNS.map(([k, label]) => {
          const sel = k === os;
          const [fg, bg] = OS_PAL[k];
          return (
            <button
              key={k}
              className={`mko-os-btn${sel ? ' sel' : ''}`}
              style={sel ? { background: fg, color: bg } : undefined}
              onClick={() => setOs(k)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <Gap h={12} />

      <button
        className="mko-btn mko-btn-pri"
        style={{ height: 36, fontSize: '13.3px' }}
        disabled={busy}
        onClick={submit}
      >
        {busy ? '▸  INITIALISING…' : '▸  INITIALISE SYSTEMS'}
      </button>
    </Panel>
  );
}

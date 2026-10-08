'use client';

// Mark's RemoteKeyOverlay: a QR code that logs the phone straight in, plus the
// manual URL and one-time key as a fallback, with a 10-minute countdown. The
// key expiring closes the panel; NEW KEY mints a fresh one and restarts the
// clock. When a phone connects while it is open, the panel says so (Mark's
// mark_connected) and the countdown stops.

import { useEffect, useRef, useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import { Lbl, Panel, Sep } from './common';

const EXPIRY_SECS = 600;

type QrState = { kind: 'img'; src: string } | { kind: 'text'; text: string };

async function makeQr(url: string): Promise<QrState> {
  if (!url) return { kind: 'text', text: '—' };
  try {
    const QR = await import('qrcode');
    const src = await QR.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 5,
      color: { dark: '#000000', light: '#ffffff' },
    });
    return { kind: 'img', src };
  } catch {
    return { kind: 'text', text: url.slice(0, 28) };
  }
}

export default function RemoteKeyOverlay() {
  const remote = useMarkStore((s) => s.remote);
  const phoneConnected = useMarkStore((s) => s.phoneConnected);
  const name = useMarkStore((s) => s.config?.assistant_name) || 'JARVIS';

  const [qr, setQr] = useState<QrState>({ kind: 'text', text: '' });
  const [expiry, setExpiry] = useState(() => Date.now() + EXPIRY_SECS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => useMarkStore.getState().setOverlay(null);

  // Mark logs the manual address when the key is generated.
  const loggedFor = useRef('');
  useEffect(() => {
    if (!remote || loggedFor.current === remote.key) return;
    loggedFor.current = remote.key;
    useMarkStore
      .getState()
      .writeLog(`SYS: Remote key generated — manual: ${remote.manualUrl || remote.url}`);
  }, [remote]);

  useEffect(() => {
    let alive = true;
    const url = remote ? remote.autoLoginUrl || remote.url : '';
    makeQr(url).then((q) => alive && setQr(q));
    return () => {
      alive = false;
    };
  }, [remote]);

  // Only a connection that happens while the panel is up counts, as in Mark:
  // an older phone session should not make a fresh key read CONNECTED.
  const prevPhone = useRef(phoneConnected);
  useEffect(() => {
    if (phoneConnected && !prevPhone.current) setConnected(true);
    prevPhone.current = phoneConnected;
  }, [phoneConnected]);

  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [connected]);

  const remaining = Math.max(0, Math.ceil((expiry - now) / 1000));
  useEffect(() => {
    if (!connected && remaining === 0) close();
  }, [remaining, connected]);

  const refreshKey = async () => {
    if (busy) return;
    setBusy(true);
    const before = useMarkStore.getState().remote;
    await useMarkStore.getState().newRemoteKey().catch(() => {});
    setBusy(false);
    if (useMarkStore.getState().remote === before) return; // nothing new came back
    setConnected(false);
    setExpiry(Date.now() + EXPIRY_SECS * 1000);
    setNow(Date.now());
  };

  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');

  return (
    <Panel width={400} height={465} margins={[24, 16]} spacing={5} style={{ borderRadius: 14, background: 'rgba(0, 4, 12, 0.95)' }}>
      <Lbl pt={12} bold align="center">
        ◈  REMOTE ACCESS
      </Lbl>
      <Sep margin={1} />

      {connected ? (
        <div className="mko-qr connected">✓</div>
      ) : (
        <div className="mko-qr">
          {qr.kind === 'img' ? (
            <img src={qr.src} alt="Pairing QR code" />
          ) : (
            <span style={{ fontSize: qr.text.length > 1 ? '9.5px' : undefined, color: qr.text.length > 1 ? 'var(--o-pri)' : undefined, overflowWrap: 'anywhere' }}>
              {qr.text}
            </span>
          )}
        </div>
      )}

      <Lbl pt={8} align="center" color="var(--o-text-dim)">
        Scan with phone camera to connect instantly
      </Lbl>
      <Sep margin={1} />
      <Lbl pt={7} color="var(--o-text-dim)">
        Or enter manually:
      </Lbl>
      <Lbl
        pt={8}
        align="center"
        color="var(--o-pri-dim)"
        style={{ userSelect: 'text', overflowWrap: 'anywhere' }}
      >
        {remote ? remote.manualUrl || remote.url : ''}
      </Lbl>

      <div className={`mko-key${connected ? ' connected' : ''}`} style={{ flex: 'none' }}>
        {connected ? 'CONNECTED' : remote?.key || '—'}
      </div>

      <Lbl
        pt={8}
        align="center"
        color={connected ? 'var(--o-green)' : 'var(--o-text-med)'}
      >
        {connected ? `Phone connected — ${name} ready` : `Key expires in  ${mm}:${ss}`}
      </Lbl>

      <div style={{ flex: '1 1 auto' }} />
      <div className="mko-row" style={{ flex: 'none' }}>
        <button className="mko-btn mko-btn-remote-pri" disabled={busy} onClick={refreshKey}>
          NEW KEY
        </button>
        <button
          className="mko-btn mko-btn-sec"
          style={{ height: 32, borderRadius: 5, fontWeight: 'bold', fontSize: '10.5px' }}
          onClick={close}
        >
          DISMISS
        </button>
      </div>
    </Panel>
  );
}

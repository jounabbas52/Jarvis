'use client';

import { useEffect, useState } from 'react';
import { APP_VERSION } from './LeftPanel';
import { markBridge } from '@/lib/mark/types';

type WinApi = { minimize?(): void; maximize?(): void; close?(): void };
const win = (): WinApi | null =>
  typeof window === 'undefined' ? null : ((window as unknown as { jarvis?: WinApi }).jarvis ?? null);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** strftime("%H:%M:%S") and strftime("%a %d %b %Y"), locale-free like Mark's. */
function clockText(d: Date): [string, string] {
  return [
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
    `${DAYS[d.getDay()]} ${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  ];
}

export default function Header({
  assistantName,
  drawerOpen,
  onToggleDrawer,
}: {
  assistantName: string;
  drawerOpen: boolean;
  onToggleDrawer(): void;
}) {
  // Rendered empty on the server pass so the static export never bakes in a
  // build-time clock; the first tick fills it in.
  const [now, setNow] = useState<[string, string]>(['00:00:00', '']);
  // Resolved after mount so the pre-rendered HTML and the first client render agree.
  const [inElectron, setInElectron] = useState(false);
  useEffect(() => setInElectron(!!markBridge()), []);
  useEffect(() => {
    const tick = () => setNow(clockText(new Date()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const display = assistantName.toUpperCase();
  const sub = display === 'JARVIS' || display === 'J.A.R.V.I.S' ? 'A Friendly Assistant' : 'Personal AI Assistant';

  return (
    // jarvis-lite's window is frameless and this view hides its TopBar, so
    // Mark's header doubles as the title bar: drag region + window buttons.
    <div className="mk-header app-drag">
      <span className="mk-badge">{APP_VERSION}</span>
      <button
        className={`mk-drawer-btn${drawerOpen ? ' on' : ''}`}
        onClick={onToggleDrawer}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title="Settings & Controls"
        aria-pressed={drawerOpen}
      >
        ⚙
      </button>

      <div className="mk-title-col">
        <span className="mk-title">{display}</span>
        <span className="mk-subtitle">{sub}</span>
      </div>

      <div className="mk-clock-col">
        <span className="mk-clock">{now[0]}</span>
        <span className="mk-date">{now[1]}</span>
      </div>

      {inElectron && (
        <div className="mk-winctl app-no-drag">
          <button onClick={() => win()?.minimize?.()} title="Minimise">
            ─
          </button>
          <button onClick={() => win()?.maximize?.()} title="Maximise">
            □
          </button>
          <button className="close" onClick={() => win()?.close?.()} title="Close">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

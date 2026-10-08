'use client';

import { useEffect, useState } from 'react';
import { markBridge } from '@/lib/mark/types';
import type { Metrics } from '@/lib/mark/types';
import { useMarkStore } from '@/lib/mark/store';
import MetricBar from './MetricBar';

export const APP_VERSION = 'MARK LIV';
const APP_PROTOCOL = APP_VERSION.split(' ').pop() || APP_VERSION;

/** A number from the first of `keys` that holds one, else null. */
function num(m: Metrics | null, ...keys: string[]): number | null {
  if (!m) return null;
  for (const k of keys) {
    const v = m[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** SYS MONITOR column: five gauges, uptime/process/OS box, status tags. */
export default function LeftPanel() {
  const os = useMarkStore((s) => s.config?.os);
  const [m, setM] = useState<Metrics | null>(null);

  useEffect(() => {
    const bridge = markBridge();
    if (!bridge) return;
    let alive = true;
    let busy = false;
    const tick = async () => {
      // A slow sample (WMI on a busy machine) must not stack up behind itself.
      if (busy) return;
      busy = true;
      try {
        const next = await bridge.metrics();
        if (alive) setM(next);
      } catch {
        /* keep the last sample */
      } finally {
        busy = false;
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const cpu = num(m, 'cpu');
  const mem = num(m, 'ram', 'mem');
  const net = num(m, 'net', 'netMBs', 'net_mbs'); // MB/s
  const gpu = num(m, 'gpu');
  const tmp = num(m, 'temp', 'tmp');
  let uptime = num(m, 'uptime', 'uptimeSec');
  const boot = num(m, 'bootTime', 'boot_time');
  if (uptime == null && boot != null) uptime = Date.now() / 1000 - (boot > 1e12 ? boot / 1000 : boot);
  const procs = num(m, 'procs', 'proc', 'processes', 'procCount');

  // Unknown GPU / temperature come back negative or missing: show N/A.
  const netText = net == null ? '--' : net < 1 ? `${(net * 1024).toFixed(0)}KB/s` : `${net.toFixed(1)}MB/s`;
  const osName = os === 'windows' ? 'WIN' : os === 'mac' ? 'macOS' : os === 'linux' ? 'LINUX' : '--';

  return (
    <div className="mk-left">
      <div className="mk-sec-hdr">◈ SYS MONITOR</div>
      <MetricBar label="CPU" color="var(--mk-pri)" value={cpu ?? 0} text={cpu == null ? '--' : `${cpu.toFixed(0)}%`} />
      <MetricBar label="MEM" color="var(--mk-acc2)" value={mem ?? 0} text={mem == null ? '--' : `${mem.toFixed(0)}%`} />
      <MetricBar label="NET" color="var(--mk-green)" value={net == null ? 0 : Math.min(100, net * 10)} text={netText} />
      <MetricBar
        label="GPU"
        color="var(--mk-acc)"
        value={gpu != null && gpu >= 0 ? gpu : 0}
        text={m == null ? '--' : gpu != null && gpu >= 0 ? `${gpu.toFixed(0)}%` : 'N/A'}
      />
      <MetricBar
        label="TMP"
        color="#ff6688"
        value={tmp != null && tmp >= 0 ? Math.min(100, tmp) : 0}
        text={m == null ? '--' : tmp != null && tmp >= 0 ? `${tmp.toFixed(0)}°C` : 'N/A'}
      />

      <div className="mk-info">
        <span style={{ color: 'var(--mk-green)', fontWeight: 'bold' }}>
          {uptime == null ? 'UP  --:--' : `UP  ${pad(Math.floor(uptime / 3600))}:${pad(Math.floor((uptime % 3600) / 60))}`}
        </span>
        <span style={{ color: 'var(--mk-text-med)' }}>{procs == null ? 'PROC  --' : `PROC  ${procs}`}</span>
        <span style={{ color: 'var(--mk-acc2)' }}>OS  {osName}</span>
      </div>

      <div style={{ flex: 1 }} />

      <div className="mk-tag" style={{ color: 'var(--mk-green)' }}>{'AI CORE\nACTIVE'}</div>
      <div className="mk-tag" style={{ color: 'var(--mk-pri)' }}>{'SEC\nCLEARED'}</div>
      <div className="mk-tag" style={{ color: 'var(--mk-text-dim)' }}>{`PROTOCOL\n${APP_PROTOCOL}`}</div>
    </div>
  );
}

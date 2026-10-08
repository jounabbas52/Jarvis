'use client';

// Mark's AudioDeviceOverlay: which microphone the assistant listens to and
// which speakers it talks through. Without a choice both streams follow the
// OS default, which moves by itself when a headset is plugged in — "it can't
// hear me" is usually "it is listening to the webcam".
//
// core/audio_devices.py existed to turn sounddevice's one-entry-per-host-API
// list into what the OS settings panel shows. The browser's list is already
// one entry per endpoint; what is left of that job is here: drop the
// "default"/"communications" aliases (the "System default" entry already
// means that), drop unnamed entries, dedupe by name. Devices are stored by
// NAME, as in Mark, because deviceIds are per-origin and can rotate.

import { useEffect, useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import { Gap, Lbl, Panel, Sep } from './common';

const DEFAULT_LABEL = 'System default';
const PSEUDO_IDS = new Set(['default', 'communications']);

type Lists = { input: string[]; output: string[] };

function collect(devs: MediaDeviceInfo[], kind: MediaDeviceKind): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of devs) {
    if (d.kind !== kind || PSEUDO_IDS.has(d.deviceId)) continue;
    const name = (d.label || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

async function listDevices(): Promise<Lists> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.enumerateDevices) return { input: [], output: [] };
  let devs = await md.enumerateDevices();
  // Labels are blank until the page has been granted the microphone once.
  // A momentary capture unlocks them; it is stopped straight away.
  if (devs.some((d) => d.kind !== 'videoinput' && !d.label)) {
    try {
      const stream = await md.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      devs = await md.enumerateDevices();
    } catch {
      // Permission refused: show what we have (just "System default").
    }
  }
  return { input: collect(devs, 'audioinput'), output: collect(devs, 'audiooutput') };
}

function DeviceRow(props: {
  label: string;
  names: string[] | null;
  value: string;
  saved: string;
  onChange(v: string): void;
}) {
  const { label, names, value, saved, onChange } = props;
  // The saved device is not plugged in right now: show it rather than
  // silently resetting the user's choice to default.
  const missing = !!saved && !!names && !names.includes(saved);
  return (
    <>
      <Lbl pt={8} color="var(--o-text-dim)">
        {label}
      </Lbl>
      <select
        className="mko-input"
        value={value}
        disabled={!names}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{names ? DEFAULT_LABEL : 'Scanning…'}</option>
        {(names || []).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        {missing && <option value={saved}>{`${saved}  (not connected)`}</option>}
      </select>
    </>
  );
}

export default function AudioDeviceOverlay() {
  const cfg = useMarkStore.getState().config;
  const name = useMarkStore((s) => s.config?.assistant_name) || 'JARVIS';
  const savedIn = cfg?.input_device || '';
  const savedOut = cfg?.output_device || '';

  const [lists, setLists] = useState<Lists | null>(null);
  const [inName, setInName] = useState(savedIn);
  const [outName, setOutName] = useState(savedOut);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      listDevices()
        .then((l) => alive && setLists(l))
        .catch(() => alive && setLists({ input: [], output: [] }));
    refresh();
    // Plugging a headset in while the panel is open should show up in it.
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refresh);
    return () => {
      alive = false;
      md?.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  const apply = async () => {
    const st = useMarkStore.getState();
    const changed = inName !== savedIn || outName !== savedOut;
    st.setOverlay(null);
    // Only rebuild the session if something actually moved — a no-op Apply
    // should not cost a reconnect.
    if (!changed) return;
    await st.setAudioDevices(inName, outName);
    st.writeLog('SYS: Audio devices updated.');
  };

  return (
    <Panel width={460} margins={[20, 16]} spacing={6}>
      <Lbl pt={12} bold>
        🎧  AUDIO DEVICES
      </Lbl>
      <Sep />

      <DeviceRow
        label={`MICROPHONE — what ${name} hears you with`}
        names={lists?.input ?? null}
        value={inName}
        saved={savedIn}
        onChange={setInName}
      />
      <Gap h={4} />
      <DeviceRow
        label={`SPEAKERS — what ${name} talks through`}
        names={lists?.output ?? null}
        value={outName}
        saved={savedOut}
        onChange={setOutName}
      />

      <Gap h={6} />
      <Lbl pt={7} color="var(--o-text-dim)">
        Applying reconnects the session. Your conversation is kept.
      </Lbl>

      <div className="mko-row" style={{ flex: 'none' }}>
        <button className="mko-btn mko-btn-pri" style={{ height: 32 }} onClick={apply}>
          ▸  APPLY
        </button>
        <button
          className="mko-btn mko-btn-sec"
          style={{ height: 32 }}
          onClick={() => useMarkStore.getState().setOverlay(null)}
        >
          CLOSE
        </button>
      </div>
    </Panel>
  );
}

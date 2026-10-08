'use client';

// Mark's PluginManagerOverlay: every discovered plugin with an ON/OFF toggle.
// A plugin that failed to load shows its file and a disabled BROKEN button;
// Mark put the load error in a tooltip, which is easy to miss, so it is also
// printed under the row. "Open plugins folder" is jarvis-lite's way in for
// dropping new plugins, since there is no source tree to put them in.

import { useEffect, useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import { markBridge, type PluginInfo } from '@/lib/mark/types';
import { Gap, Lbl, Panel, Sep, errText } from './common';

export default function PluginManagerOverlay() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const bridge = markBridge();
    if (!bridge) {
      setPlugins([]);
      return;
    }
    bridge
      .pluginsList()
      .then((list) => alive && setPlugins(list || []))
      .catch((e) => {
        if (!alive) return;
        setPlugins([]);
        setError(errText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (p: PluginInfo) => {
    const bridge = markBridge();
    if (!bridge || busy) return;
    setBusy(p.name);
    setError('');
    try {
      const list = await bridge.pluginToggle(p.name, !p.enabled);
      setPlugins(list || []);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const openFolder = async () => {
    const bridge = markBridge();
    if (!bridge) return;
    try {
      // shell.openPath resolves to '' on success, else an error string.
      const err = await bridge.openPluginsFolder();
      if (err) setError(err);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <Panel width={420} margins={[20, 16]} spacing={6}>
      <Lbl pt={12} bold>
        🧩  PLUGIN MANAGER
      </Lbl>
      <Sep />

      {plugins === null && (
        <Lbl pt={8} color="var(--o-text-dim)">
          Scanning…
        </Lbl>
      )}
      {plugins !== null && plugins.length === 0 && (
        <Lbl pt={8} color="var(--o-text-dim)">
          No plugins found in /plugins.
        </Lbl>
      )}

      {plugins?.map((p) => (
        <div key={`${p.name}\u0000${p.file}`} style={{ flex: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Lbl
              pt={8}
              color={p.valid ? 'var(--o-text)' : 'var(--o-text-dim)'}
              title={p.valid ? p.description : p.error}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {p.valid ? p.name : `${p.name}  (⚠ ${p.file})`}
            </Lbl>
            {p.valid ? (
              <button
                className={`mko-toggle${p.enabled ? ' on-green' : ''}`}
                style={{ width: 72, height: 24, flex: 'none' }}
                disabled={busy === p.name}
                onClick={() => toggle(p)}
              >
                {p.enabled ? 'ON' : 'OFF'}
              </button>
            ) : (
              <button className="mko-toggle" style={{ width: 72, height: 24, flex: 'none' }} disabled>
                BROKEN
              </button>
            )}
          </div>
          {!p.valid && p.error && (
            <Lbl pt={7} color="#ff6b6b" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>
              {p.error}
            </Lbl>
          )}
        </div>
      ))}

      {error && (
        <Lbl pt={7} color="#ff6b6b" style={{ overflowWrap: 'anywhere' }}>
          {error}
        </Lbl>
      )}

      <Gap h={4} />
      <button
        className="mko-btn mko-btn-sec"
        style={{ height: 30, flex: 'none' }}
        onClick={openFolder}
      >
        OPEN PLUGINS FOLDER
      </button>
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

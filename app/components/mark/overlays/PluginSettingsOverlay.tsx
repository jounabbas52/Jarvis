'use client';

// Mark's PluginSettingsOverlay: one generic form per settings namespace that an
// enabled plugin declared (PLUGIN_SETTINGS). It knows nothing about any
// particular plugin. Field types are Mark's — choice, toggle, text, password —
// plus the aliases the jarvis-lite schema allows (select, bool, number).
//
// SAVE writes every namespace; a section's test button saves that namespace
// first (so the test sees what was typed) and reports in its status line.

import { useEffect, useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import {
  markBridge,
  type PluginSettingsField,
  type PluginSettingsSection,
} from '@/lib/mark/types';
import { Gap, Lbl, Panel, Sep, errText } from './common';

type Kind = 'choice' | 'toggle' | 'password' | 'number' | 'text';
type Status = { text: string; color: string };

function kindOf(f: PluginSettingsField): Kind {
  const t = String(f.type || 'text').toLowerCase();
  if (t === 'choice' || t === 'select') return 'choice';
  if (t === 'toggle' || t === 'bool' || t === 'boolean') return 'toggle';
  if (t === 'password') return 'password';
  if (t === 'number') return 'number';
  return 'text';
}

const nsOf = (s: PluginSettingsSection) => s.namespace || s.plugin || 'plugin';
const fk = (ns: string, key: string) => `${ns}\u0000${key}`;

function initialValue(f: PluginSettingsField, stored: unknown): string | boolean {
  const kind = kindOf(f);
  if (kind === 'toggle') return !!stored;
  if (kind === 'choice') {
    const opts = (f.options || []).map(String);
    // Qt's setCurrentText on a fixed list ignores unknown text → first item.
    const s = stored == null ? '' : String(stored);
    return opts.includes(s) ? s : opts[0] ?? '';
  }
  return stored == null ? '' : String(stored);
}

export default function PluginSettingsOverlay() {
  const [sections, setSections] = useState<PluginSettingsSection[] | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});

  useEffect(() => {
    let alive = true;
    const bridge = markBridge();
    const load = bridge ? bridge.pluginSettings() : Promise.resolve([]);
    load
      .then((secs) => {
        if (!alive) return;
        const list = (secs || []).filter(Boolean);
        const v: Record<string, string | boolean> = {};
        for (const sec of list) {
          const ns = nsOf(sec);
          for (const f of sec.fields || []) {
            if (!f || typeof f !== 'object' || !f.key) continue;
            const stored = sec.values && f.key in sec.values ? sec.values[f.key] : f.default;
            v[fk(ns, f.key)] = initialValue(f, stored);
          }
        }
        setValues(v);
        setSections(list);
      })
      .catch(() => alive && setSections([]));
    return () => {
      alive = false;
    };
  }, []);

  const gather = (ns: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const sec = sections?.find((s) => nsOf(s) === ns);
    for (const f of sec?.fields || []) {
      if (!f || !f.key) continue;
      const v = values[fk(ns, f.key)];
      const kind = kindOf(f);
      if (kind === 'toggle') out[f.key] = !!v;
      else if (kind === 'choice') out[f.key] = String(v ?? '');
      else {
        const t = String(v ?? '').trim();
        // A number field keeps a number when it is one, text otherwise.
        out[f.key] = kind === 'number' && t !== '' && Number.isFinite(Number(t)) ? Number(t) : t;
      }
    }
    return out;
  };

  const saveNs = async (ns: string) => {
    await markBridge()?.pluginSettingsSave(ns, gather(ns));
  };

  const saveAll = async () => {
    for (const sec of sections || []) {
      const ns = sec.namespace || sec.plugin;
      if (!ns) continue;
      try {
        await saveNs(ns);
        setStatus((s) => ({ ...s, [ns]: { text: 'Saved ✓', color: 'var(--o-pri)' } }));
      } catch (e) {
        setStatus((s) => ({ ...s, [ns]: { text: errText(e), color: '#ff6b6b' } }));
      }
    }
  };

  const runAction = async (ns: string) => {
    const bridge = markBridge();
    if (!bridge) return;
    setStatus((s) => ({ ...s, [ns]: { text: 'Testing…', color: 'var(--o-text-dim)' } }));
    let ok = false;
    let msg = '';
    try {
      await saveNs(ns); // persist what the user typed before testing
      const res = await bridge.pluginSettingsAction(ns, gather(ns));
      if (Array.isArray(res) && res.length === 2) {
        ok = !!res[0];
        msg = String(res[1]);
      } else {
        ok = !!res;
        msg = String(res);
      }
    } catch (e) {
      ok = false;
      msg = errText(e);
    }
    setStatus((s) => ({ ...s, [ns]: { text: msg, color: ok ? 'var(--o-pri)' : '#ff6b6b' } }));
  };

  const set = (k: string, v: string | boolean) => setValues((s) => ({ ...s, [k]: v }));

  const renderField = (ns: string, f: PluginSettingsField) => {
    const k = fk(ns, f.key);
    const kind = kindOf(f);
    const v = values[k];
    if (kind === 'choice') {
      return (
        <select className="mko-input" value={String(v ?? '')} onChange={(e) => set(k, e.target.value)}>
          {(f.options || []).map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      );
    }
    if (kind === 'toggle') {
      const on = !!v;
      return (
        <button
          className={`mko-toggle${on ? ' on-pri' : ''}`}
          style={{ height: 28, fontSize: '10.5px', color: on ? undefined : 'var(--o-text-med)' }}
          aria-pressed={on}
          onClick={() => set(k, !on)}
        >
          {on ? 'ON' : 'OFF'}
        </button>
      );
    }
    return (
      <input
        className="mko-input"
        style={{ height: 30 }}
        type={kind === 'password' ? 'password' : 'text'}
        inputMode={kind === 'number' ? 'decimal' : undefined}
        placeholder={f.placeholder ? String(f.placeholder) : undefined}
        value={String(v ?? '')}
        spellCheck={false}
        onChange={(e) => set(k, e.target.value)}
      />
    );
  };

  const has = !!sections && sections.length > 0;

  return (
    <Panel width={460} height={560} margins={[22, 16]} spacing={8}>
      <Lbl pt={12} bold>
        ⚙  PLUGIN SETTINGS
      </Lbl>
      <Sep />

      {sections === null && (
        <Lbl pt={9} color="var(--o-text-dim)">
          Loading…
        </Lbl>
      )}
      {sections !== null && !has && (
        <Lbl pt={9} color="var(--o-text-dim)">
          {'No configurable plugins are installed.\nDrop a plugin that needs settings (like the ' +
            '3D-printer suite) into the plugins folder and it will show up here.'}
        </Lbl>
      )}

      {has && (
        <div
          className="mko-body"
          style={{ flex: '1 1 auto', gap: 6, paddingRight: 6, minHeight: 0 }}
        >
          {sections!.map((sec) => {
            const ns = nsOf(sec);
            const st = status[ns];
            return (
              <div key={ns} style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
                <Gap h={4} />
                <Lbl pt={10} bold>
                  {sec.title || ns}
                </Lbl>
                {(sec.fields || [])
                  .filter((f) => f && typeof f === 'object' && f.key)
                  .map((f) => (
                    <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <Lbl pt={8} color="var(--o-text-dim)">
                        {String(f.label || f.key).toUpperCase()}
                      </Lbl>
                      {renderField(ns, f)}
                      {f.help && (
                        <Lbl pt={7} color="var(--o-text-dim)">
                          {f.help}
                        </Lbl>
                      )}
                    </div>
                  ))}
                {sec.action && (
                  <>
                    <Gap h={2} />
                    <button
                      className="mko-btn mko-btn-pri"
                      style={{ height: 30, fontSize: '10.5px', background: '#00091a' }}
                      onClick={() => runAction(ns)}
                    >
                      {String(sec.action.label || 'TEST')}
                    </button>
                  </>
                )}
                <Lbl pt={8} color={st?.color || 'var(--o-text-dim)'} style={{ minHeight: 14 }}>
                  {st?.text || ''}
                </Lbl>
                <Sep margin={4} />
              </div>
            );
          })}
        </div>
      )}
      {!has && <div style={{ flex: '1 1 auto' }} />}

      <div className="mko-row" style={{ flex: 'none' }}>
        {has && (
          <button className="mko-btn mko-btn-pri" onClick={saveAll}>
            ▸  SAVE
          </button>
        )}
        <button className="mko-btn mko-btn-sec" onClick={() => useMarkStore.getState().setOverlay(null)}>
          CLOSE
        </button>
      </div>
    </Panel>
  );
}

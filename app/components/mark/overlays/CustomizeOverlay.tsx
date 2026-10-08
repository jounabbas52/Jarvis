'use client';

// Mark's CustomizeOverlay: assistant name, your name, voice and UI colour.
//
// Colour flow is Mark's: dragging the wheel only updates the hex box; letting
// go (or typing a valid hex, or DEFAULT) live-previews the whole interface
// without writing config; CANCEL puts the launch colour back; APPLY persists.
// The HUD derives its palette from config.ui_color, so the preview patches
// that in the store (not on disk) as well as calling applyAccent.

import { useEffect, useRef, useState } from 'react';
import { applyAccent, useMarkStore } from '@/lib/mark/store';
import { Gap, Lbl, Panel, Sep, errText } from './common';
import HueWheel, { hexToHue } from './HueWheel';

const DEFAULT_UI_COLOR = '#00d4ff';
const DEFAULT_VOICE = 'Charon';

/** MainWindow._preview_ui_color: repaint everything, write nothing. */
function previewColor(hex: string): void {
  const st = useMarkStore.getState();
  if (st.config && st.config.ui_color !== hex) {
    useMarkStore.setState({ config: { ...st.config, ui_color: hex } });
  }
  applyAccent(hex);
}

export default function CustomizeOverlay() {
  const cfg = useMarkStore.getState().config;
  const voices = useMarkStore((s) => s.config?.voices) || [DEFAULT_VOICE];

  const [name, setName] = useState(cfg?.assistant_name || 'JARVIS');
  const [user, setUser] = useState(cfg?.user_name || '');
  const [voice, setVoiceSel] = useState(() => {
    const v = cfg?.voice_name || DEFAULT_VOICE;
    return voices.includes(v) ? v : DEFAULT_VOICE;
  });

  const initial = useRef((cfg?.ui_color || DEFAULT_UI_COLOR).trim().toLowerCase());
  const [color, setColorState] = useState(initial.current);
  const [hexText, setHexText] = useState(initial.current);
  const [hue, setHue] = useState(() => hexToHue(initial.current) ?? 0.53);
  const selRef = useRef(initial.current);
  const closedRef = useRef(false);

  // Leaving without APPLY or CANCEL (another overlay replaced this one) must
  // not strand a previewed colour that was never saved.
  useEffect(
    () => () => {
      if (!closedRef.current && selRef.current !== initial.current) previewColor(initial.current);
    },
    [],
  );

  /** _set_color: hex box + wheel in sync, theme live-previewed. */
  const setColor = (hx: string, updateWheel = true, preview = true) => {
    const c = hx.trim().toLowerCase();
    selRef.current = c;
    setColorState(c);
    setHexText(c);
    if (updateWheel) {
      const h = hexToHue(c);
      if (h !== null) setHue(h);
    }
    if (preview) previewColor(c);
  };

  const cancel = () => {
    closedRef.current = true;
    if (selRef.current !== initial.current) previewColor(initial.current);
    useMarkStore.getState().setOverlay(null);
  };

  /** CustomizeOverlay._save → MainWindow._apply_name_update. */
  const save = async () => {
    closedRef.current = true;
    const st = useMarkStore.getState();
    st.setOverlay(null);

    const assistant = name.trim() || 'JARVIS';
    const userName = user.trim();
    const uiColor = (color || DEFAULT_UI_COLOR).trim().toLowerCase();
    const display = assistant.toUpperCase();
    const colorChanged = uiColor !== initial.current;
    const prevVoice = cfg?.voice_name || DEFAULT_VOICE;
    const voiceChanged = !!voice && voice !== prevVoice;

    try {
      const saved = await st.saveConfig({
        assistant_name: assistant,
        user_name: userName,
        ui_color: uiColor,
      });
      if (!saved) throw new Error('the settings store is unavailable');
      st.writeLog(`SYS: Identity updated — ${display}`);
      if (colorChanged) st.writeLog(`SYS: UI colour applied — ${uiColor}`);
      if (voiceChanged) st.writeLog(`SYS: Voice set — ${voice}`);
    } catch (e) {
      st.writeLog(`ERR: Config save failed — ${errText(e)}`);
      // The preview is not what is on disk any more; show what is.
      await st.refreshConfig().catch(() => null);
    }
    // Voice is fixed at connect time; setVoice persists it and rebuilds the
    // Live session only when it actually changed.
    if (voiceChanged) {
      try {
        await st.setVoice(voice);
      } catch (e) {
        st.writeLog(`ERR: Config save failed — ${errText(e)}`);
      }
    }
  };

  return (
    <Panel width={400} height={588} margins={[24, 18]} spacing={8}>
      <Lbl pt={12} bold align="center">
        ⚙  CUSTOMISE ASSISTANT
      </Lbl>
      <Sep />

      <Lbl pt={8} color="var(--o-text-dim)">
        ASSISTANT NAME
      </Lbl>
      <input
        className="mko-input"
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        style={{ flex: 'none' }}
      />

      <Gap h={4} />
      <Lbl pt={8} color="var(--o-text-dim)">
        YOUR NAME  (leave blank for default sir / efendim)
      </Lbl>
      <input
        className="mko-input"
        value={user}
        placeholder="e.g.  Tony   (leave blank for auto)"
        spellCheck={false}
        onChange={(e) => setUser(e.target.value)}
        style={{ flex: 'none' }}
      />

      <Gap h={4} />
      <Lbl pt={8} color="var(--o-text-dim)">
        ASSISTANT VOICE
      </Lbl>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 'none' }}>
        {voices.map((v) => (
          <button
            key={v}
            className={`mko-voice${v === voice ? ' sel' : ''}`}
            aria-pressed={v === voice}
            onClick={() => setVoiceSel(v)}
          >
            {v}
          </button>
        ))}
      </div>

      <Gap h={4} />
      <div style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
        <Lbl pt={8} color="var(--o-text-dim)" style={{ flex: '1 1 auto' }}>
          UI COLOUR  —  drag the handle
        </Lbl>
        <button className="mko-mini-btn" onClick={() => setColor(DEFAULT_UI_COLOR)}>
          DEFAULT
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', flex: 'none' }}>
        <HueWheel
          hue={hue}
          onPick={(hx, h) => {
            // While dragging: hex box only, the theme waits for release.
            setHue(h);
            selRef.current = hx;
            setColorState(hx);
            setHexText(hx);
          }}
          onCommit={(hx) => setColor(hx, false)}
        />
      </div>

      <input
        className="mko-input"
        value={hexText}
        placeholder="#00d4ff   (custom hex colour)"
        spellCheck={false}
        style={{ height: 28, flex: 'none' }}
        onChange={(e) => {
          const text = e.target.value;
          setHexText(text);
          const t = text.trim().toLowerCase();
          if (/^#[0-9a-f]{6}$/.test(t)) {
            setColor(t, true, true);
            setHexText(text);
          }
        }}
      />

      <Gap h={6} />
      <div className="mko-row" style={{ flex: 'none' }}>
        <button className="mko-btn mko-btn-pri" onClick={save}>
          ▸  APPLY CHANGES
        </button>
        <button className="mko-btn mko-btn-sec" style={{ fontWeight: 'normal' }} onClick={cancel}>
          CANCEL
        </button>
      </div>
    </Panel>
  );
}

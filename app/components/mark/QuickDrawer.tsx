'use client';

import { useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import { markBridge } from '@/lib/mark/types';

/** The push-to-talk chord (core/hotkey.py DEFAULT_CHORD). */
export const PTT_CHORD_LABEL = 'Ctrl+Space';

export function toggleFullscreen(): void {
  if (typeof document === 'undefined') return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

/** The ⚙ drawer under the header: every setting and switch Mark keeps there. */
export default function QuickDrawer() {
  const s = useMarkStore();
  const log = s.writeLog;
  const [downloading, setDownloading] = useState(false);

  const remote = async () => {
    await s.openRemote();
    const st = useMarkStore.getState();
    if (st.overlay === 'remote' && st.remote) {
      log(`SYS: Remote key generated — manual: ${st.remote.manualUrl || st.remote.url}`);
    }
  };

  const shortcut = async () => {
    const bridge = markBridge();
    if (!bridge) return;
    try {
      const r = await bridge.desktopShortcut();
      log(r.ok ? 'SYS: Desktop shortcut created.' : `ERR: Shortcut failed — ${r.message}`);
    } catch (e) {
      log(`ERR: Shortcut failed — ${(e as Error)?.message || e}`);
    }
  };

  const autostart = async () => {
    const was = s.autostart;
    try {
      await s.toggleAutostart();
      const now = useMarkStore.getState().autostart;
      if (now !== was) log(`SYS: Auto-start ${now ? 'enabled' : 'disabled'}.`);
      else log('ERR: Auto-start failed — the setting did not change.');
    } catch (e) {
      log(`ERR: Auto-start failed — ${(e as Error)?.message || e}`);
    }
  };

  // First use downloads the wake-word model (one time), then switches it on.
  const installWake = async () => {
    setDownloading(true);
    let ok = false;
    let msg = '';
    try {
      [ok, msg] = await s.installWakeWord((m) => log(`SYS: ${m}`));
      if (ok) await useMarkStore.getState().toggleWakeWord();
    } catch (e) {
      ok = false;
      msg = String((e as Error)?.message || e);
    }
    setDownloading(false);
    log(`SYS: ${ok ? 'Wake word ready.' : `Wake word setup failed: ${msg}`}`);
  };

  const wakeToggle = async () => {
    if (!s.wake.ready) return installWake();
    const res = await s.toggleWakeWord();
    if (res === 'need_download') installWake();
  };

  const hudStyle = async () => {
    const want = s.config?.hud_style === 'face' ? 'core' : 'face';
    await s.setHudStyle(want);
    log(want === 'face' ? 'SYS: HUD switched to the animated face.' : 'SYS: HUD switched to the reactor core.');
  };

  const brief = !!s.config?.morning_brief_enabled;
  const face = (s.config?.hud_style || 'face') === 'face';
  const ptt = s.ptt.enabled;

  let wakeLabel: string;
  let wakeCls: string;
  if (downloading) {
    wakeLabel = '⬇  DOWNLOADING… (one-time)';
    wakeCls = 'off';
  } else if (!s.wake.ready) {
    wakeLabel = '⬇  WAKE WORD: DOWNLOAD';
    wakeCls = 'off';
  } else if (s.wake.enabled) {
    wakeLabel = '🎙  WAKE WORD: ON';
    wakeCls = 'on';
  } else {
    wakeLabel = '🎙  WAKE WORD: OFF';
    wakeCls = 'off';
  }

  return (
    <div className="mk-drawer">
      <div className="mk-drawer-hdr">◈ CONTROLS</div>

      <button className="mk-dbtn pri" onClick={remote}>
        ◉  REMOTE CONTROL
      </button>
      <button className="mk-dbtn" onClick={toggleFullscreen}>
        ⛶  FULLSCREEN  [F11]
      </button>
      <button className="mk-dbtn" onClick={shortcut}>
        ⊞  CREATE DESKTOP SHORTCUT
      </button>
      <button className={`mk-dbtn ${s.autostart ? 'on' : 'off'}`} onClick={autostart}>
        {s.autostart ? '◉  AUTO-START: ON' : '◉  AUTO-START: OFF'}
      </button>
      <button className="mk-dbtn" onClick={() => s.setOverlay('customize')}>
        ⚙  CUSTOMISE ASSISTANT
      </button>
      <button className={`mk-dbtn ${brief ? 'on' : 'off'}`} onClick={() => s.toggleBrief()}>
        {brief ? '☀  MORNING BRIEF: ON' : '☀  MORNING BRIEF: OFF'}
      </button>

      <button className={`mk-dbtn ${wakeCls}`} onClick={wakeToggle} disabled={downloading}>
        {wakeLabel}
      </button>
      {!downloading && s.wake.ready && s.wake.enabled && (
        <button className="mk-dbtn off" onClick={() => s.wakeManual()}>
          {s.wake.awake ? '😴  SLEEP NOW' : '👂  WAKE NOW'}
        </button>
      )}

      <button
        className={`mk-dbtn ${ptt ? 'on' : 'off'}`}
        onClick={() => s.togglePushToTalk().catch((e) => log(`ERR: Push-to-talk failed — ${(e as Error)?.message || e}`))}
        title={
          ptt
            ? 'Microphone stays closed until you hold the key — nothing is sent while you are not holding it.'
            : 'Hold a key to talk instead of streaming the mic continuously.'
        }
      >
        {ptt ? `🎚  PUSH-TO-TALK: ${PTT_CHORD_LABEL}` : '🎚  PUSH-TO-TALK: OFF'}
      </button>

      {/* Neither side is "off": this is a choice between two things. */}
      <button
        className="mk-dbtn choice"
        onClick={hudStyle}
        title={
          face
            ? 'An animated head that speaks your words and shows what the assistant is doing. Tap to switch to the reactor core.'
            : 'A reactor core that turns with the state and moves with your voice. Tap to switch to the animated head.'
        }
      >
        {face ? '🧑  HUD: ANIMATED FACE' : '◉  HUD: REACTOR CORE'}
      </button>

      <button className="mk-dbtn" onClick={() => s.setOverlay('audio')}>
        🎧  AUDIO DEVICES
      </button>
      <button className="mk-dbtn" onClick={() => s.setOverlay('memory')}>
        🧠  MEMORY
      </button>
      <button className="mk-dbtn" onClick={() => s.setOverlay('plugins')}>
        🧩  PLUGINS
      </button>
      <button className="mk-dbtn" onClick={() => s.setOverlay('plugin-settings')}>
        ⚙  PLUGIN SETTINGS
      </button>
    </div>
  );
}

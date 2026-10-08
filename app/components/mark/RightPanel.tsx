'use client';

import { useState } from 'react';
import { useMarkStore } from '@/lib/mark/store';
import LogPanel from './LogPanel';
import FileDropZone, { fileIcon, fmtSize, splitPath } from './FileDropZone';

/** F4 and the mute button: flip the mic and say so in the log, as Mark does. */
export function toggleMuteLogged(): void {
  const s = useMarkStore.getState();
  s.toggleMute();
  s.writeLog(useMarkStore.getState().muted ? 'SYS: Microphone muted.' : 'SYS: Microphone active.');
}

/** ACTIVITY LOG · FILE UPLOAD · COMMAND INPUT · interrupt · mute. */
export default function RightPanel() {
  const currentFile = useMarkStore((s) => s.currentFile);
  const muted = useMarkStore((s) => s.muted);
  const assistantName = useMarkStore((s) => (s.config?.assistant_name || 'JARVIS').trim() || 'JARVIS');
  const [size, setSize] = useState<{ path: string; bytes: number | null } | null>(null);
  const [input, setInput] = useState('');

  const onPick = (path: string, bytes: number | null) => {
    const s = useMarkStore.getState();
    setSize({ path, bytes });
    s.setCurrentFile(path);
    const { name, ext } = splitPath(path);
    const sz = bytes != null ? fmtSize(bytes) : '?';
    s.writeLog(`FILE: ${name} (${sz}) loaded`);
    // Straight into the conversation, so the assistant acknowledges the file.
    s.sendText(
      `[FILE_UPLOADED] path=${path} | name=${name} | type=${ext} | size=${sz} | ` +
        `Briefly tell the user you can see the file '${name}' (${sz}) has been uploaded ` +
        `and ask what they'd like to do with it.`,
    );
  };

  const onClear = () => {
    setSize(null);
    useMarkStore.getState().setCurrentFile(null);
  };

  const send = () => {
    const txt = input.trim();
    if (!txt) return;
    setInput('');
    const s = useMarkStore.getState();
    s.writeLog(`You: ${txt}`);
    s.sendText(txt);
  };

  const bytes = size && size.path === currentFile ? size.bytes : null;
  let hint = 'No file loaded — drop or click above to upload';
  if (currentFile) {
    const parts = [`${fileIcon(currentFile)[0]}  ${splitPath(currentFile).name}`];
    if (bytes != null) parts.push(fmtSize(bytes));
    parts.push(`Tell ${assistantName} what to do with it`);
    hint = parts.join('  ·  ');
  }

  return (
    <div className="mk-right">
      <div className="mk-sec">▸ ACTIVITY LOG</div>
      <LogPanel />

      <div className="mk-sep" />
      <div className="mk-sec">▸ FILE UPLOAD</div>
      <FileDropZone file={currentFile} size={bytes} onPick={onPick} onClear={onClear} />
      <div className="mk-file-hint">{hint}</div>

      <div className="mk-sep" />
      <div className="mk-sec">▸ COMMAND INPUT</div>
      <div className="mk-input-row">
        <input
          className="mk-input"
          placeholder="Type a command or question…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
        />
        <button className="mk-send" onClick={send} aria-label="Send">
          ▸
        </button>
      </div>

      <button className="mk-interrupt" onClick={() => useMarkStore.getState().interrupt()}>
        ✋  INTERRUPT  [ESC]
      </button>
      <button className={`mk-mute${muted ? ' muted' : ''}`} onClick={toggleMuteLogged}>
        {muted ? '🔇  MICROPHONE MUTED' : '🎙  MICROPHONE ACTIVE'}
      </button>
    </div>
  );
}

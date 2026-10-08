'use client';

import { useRef, useState } from 'react';

// ── file helpers (Mark's _FILE_ICONS / _EXT_TO_CAT / _fmt_size) ─────────────

const FILE_ICONS: Record<string, [string, string]> = {
  image: ['🖼', '#00d4ff'],
  video: ['🎬', '#ff6b00'],
  audio: ['🎵', '#cc44ff'],
  pdf: ['📄', '#ff4444'],
  word: ['📝', '#4488ff'],
  excel: ['📊', '#44bb44'],
  code: ['💻', '#ffcc00'],
  archive: ['📦', '#ff8844'],
  pptx: ['📊', '#ff6622'],
  text: ['📃', '#aaaaaa'],
  data: ['🔧', '#88ddff'],
  unknown: ['📎', '#888888'],
};

const EXT_TO_CAT: Record<string, string> = {};
const cat = (exts: string, c: string) => exts.split(' ').forEach((e) => (EXT_TO_CAT[e] = c));
cat('jpg jpeg png gif webp bmp tiff svg ico', 'image');
cat('mp4 avi mov mkv wmv flv webm m4v', 'video');
cat('mp3 wav ogg m4a aac flac wma opus', 'audio');
cat('pdf', 'pdf');
cat('doc docx', 'word');
cat('xls xlsx ods', 'excel');
cat('ppt pptx', 'pptx');
cat('py js ts jsx tsx html css java c cpp cs go rs rb php swift kt sh sql lua', 'code');
cat('zip rar tar gz 7z bz2 xz', 'archive');
cat('txt md rst log', 'text');
cat('csv tsv json xml', 'data');

export interface PathParts {
  name: string;
  parent: string;
  /** Extension without the dot, as written ('' if none). */
  ext: string;
}

export function splitPath(p: string): PathParts {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  const name = i >= 0 ? p.slice(i + 1) : p;
  const parent = i > 0 ? p.slice(0, i) : '';
  const dot = name.lastIndexOf('.');
  return { name, parent, ext: dot > 0 ? name.slice(dot + 1) : '' };
}

export function fileIcon(path: string): [string, string] {
  return FILE_ICONS[EXT_TO_CAT[splitPath(path).ext.toLowerCase()] || 'unknown'] || FILE_ICONS.unknown;
}

export function fmtSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

/** Electron gives renderer File objects their absolute path. */
function filePath(f: File | null | undefined): string | null {
  const p = (f as unknown as { path?: string } | null)?.path;
  return p || null;
}

// ── the zone ────────────────────────────────────────────────────────────────

interface Props {
  file: string | null;
  size: number | null;
  onPick(path: string, size: number | null): void;
  onClear(): void;
}

/** FileDropZone + _DropCanvas: drop a file or click to browse. */
export default function FileDropZone({ file, size, onPick, onClear }: Props) {
  const [hover, setHover] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const browse = () => inputRef.current?.click();

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // Only the first item, and only a real file — a dropped folder is refused,
    // as Mark's is_file() check refused it.
    const item = e.dataTransfer.items?.[0];
    const entry = item && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry && !entry.isFile) return;
    const f = e.dataTransfer.files?.[0];
    const p = filePath(f);
    if (f && p) onPick(p, f.size);
  };

  const onClick = (e: React.MouseEvent) => {
    // The ✕ sits in the right-hand 34 px of the zone while a file is loaded.
    const r = boxRef.current?.getBoundingClientRect();
    if (file && r && e.clientX > r.right - 34) {
      onClear();
      return;
    }
    browse();
  };

  const bg = dragOver ? '#001a24' : hover ? '#001218' : 'var(--mk-panel)';
  const border = file
    ? 'rgba(0, 255, 136, 0.78)'
    : dragOver
      ? 'var(--mk-pri)'
      : hover
        ? 'var(--mk-border-b)'
        : 'var(--mk-border)';
  const marching = hover || dragOver;

  return (
    <div
      className="mk-drop"
      ref={boxRef}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="mk-drop-box" style={{ background: bg }}>
        <svg className="mk-drop-svg" aria-hidden>
          <rect
            x="0.75"
            y="0.75"
            rx="6"
            fill="none"
            stroke={border}
            strokeWidth="1.5"
            strokeDasharray="6 3"
            className={marching ? 'mk-ants' : undefined}
            style={{ width: 'calc(100% - 1.5px)', height: 'calc(100% - 1.5px)', opacity: file || dragOver ? 1 : hover ? 0.8 : 0.63 }}
          />
        </svg>
        {file ? <Loaded file={file} size={size} /> : dragOver ? <DragOver /> : <Idle hover={hover} />}
      </div>
      <input
        ref={inputRef}
        type="file"
        hidden
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const f = e.target.files?.[0];
          const p = filePath(f);
          if (f && p) onPick(p, f.size);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function Idle({ hover }: { hover: boolean }) {
  const col = hover ? 'var(--mk-pri)' : 'var(--mk-pri-dim)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width="30" height="20" viewBox="-15 -15 30 20" aria-hidden>
        <g stroke={col} strokeWidth="2" fill="none" strokeLinecap="round">
          <line x1="0" y1="-14" x2="0" y2="4" />
          <line x1="-8" y1="-6" x2="0" y2="-14" />
          <line x1="8" y1="-6" x2="0" y2="-14" />
          <line x1="-14" y1="4" x2="14" y2="4" />
        </g>
      </svg>
      <span style={{ fontSize: 'var(--mk-f8)', color: hover ? 'var(--mk-text)' : 'var(--mk-pri-dim)', whiteSpace: 'pre' }}>
        {'Drop file here  or  Click to Browse'}
      </span>
      <span style={{ fontSize: 'var(--mk-f7)', color: '#1a4a5a' }}>Images · Video · Audio · PDF · Docs · Code · Data</span>
    </div>
  );
}

function DragOver() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, color: 'var(--mk-pri)' }}>
      <span style={{ fontSize: 26, lineHeight: 1 }}>⬇</span>
      <span style={{ fontSize: 'var(--mk-f8)', fontWeight: 'bold' }}>Release to load</span>
    </div>
  );
}

function Loaded({ file, size }: { file: string; size: number | null }) {
  const { name, parent, ext } = splitPath(file);
  const [icon, iconCol] = fileIcon(file);
  const shownName = name.length <= 34 ? name : `${name.slice(0, 31)}...`;
  const shownParent = parent.length > 42 ? `…${parent.slice(-41)}` : parent;
  const meta = [ext.toUpperCase() || 'FILE', size != null ? fmtSize(size) : null].filter(Boolean).join('  ·  ');
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center' }}>
      <span
        style={{
          width: 60,
          marginLeft: 4,
          textAlign: 'center',
          fontSize: 29,
          color: iconCol,
          fontFamily: "'Segoe UI Emoji', 'Apple Color Emoji', sans-serif",
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0, marginLeft: 6, display: 'flex', flexDirection: 'column', gap: 3, overflow: 'hidden' }}>
        <span style={{ fontSize: 'var(--mk-f8)', fontWeight: 'bold', color: 'var(--mk-white)', whiteSpace: 'nowrap' }}>{shownName}</span>
        <span style={{ fontSize: 'var(--mk-f7)', color: 'var(--mk-text-dim)', whiteSpace: 'pre' }}>{meta}</span>
        <span style={{ fontSize: 'var(--mk-f6)', color: '#1e5c6a', whiteSpace: 'nowrap' }}>{shownParent}</span>
      </div>
      <span
        title="Clear"
        style={{ width: 28, marginRight: 0, textAlign: 'center', fontSize: 'var(--mk-f9)', fontWeight: 'bold', color: 'rgba(255, 51, 85, 0.7)' }}
      >
        ✕
      </span>
    </div>
  );
}

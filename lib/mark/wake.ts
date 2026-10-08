// Local "Hey Jarvis" wake word — the port of Mark LIV's core/wake_word.py.
//
// Same engine as Mark: openWakeWord's hey_jarvis model, fully offline once
// installed. Opt-in: nothing is downloaded until the user asks (install()),
// then the three small models (~3.6 MB) are cached in IndexedDB and every
// later start loads from there with the network unplugged. Inference runs in
// its own worker (Mark uses its own thread), so feed() on the mic path is just
// a postMessage.
//
// Importing this module registers the detector with the Live controller.

import { registerWakeDetector, type WakeDetector } from './live';

export type { WakeDetector };

/**
 * Detection threshold and re-trigger cooldown.
 * The threshold is Mark's DEFAULT_THRESHOLD (core/wake_word.py). Mark has no
 * time cooldown: on a detection it drains its queued audio so one utterance
 * cannot fire twice. The worker clears its history the same way; the cooldown
 * is a second guard for the same purpose, and moot once awake, because the
 * detector is only fed while asleep.
 */
export const WAKE_THRESHOLD = 0.5;
export const WAKE_COOLDOWN_MS = 2000;

interface ModelFile {
  name: string;
  size: number;
  sha256: string;
  urls: string[];
}

// The official files are GitHub release assets, but GitHub serves them without
// CORS headers, so a renderer fetch is refused. The Hugging Face mirror serves
// byte-identical copies with CORS; the pinned SHA-256 (taken from the GitHub
// assets) is what makes a third-party mirror safe to use. GitHub stays as the
// fallback for builds where web security is relaxed.
const GH = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/';
const HF = 'https://huggingface.co/harvestsu/openwakeword-onnx/resolve/main/';

const MODELS: Record<'mel' | 'embedding' | 'wakeword', ModelFile> = {
  mel: {
    name: 'melspectrogram.onnx',
    size: 1087958,
    sha256: 'ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f',
    urls: [HF + 'melspectrogram.onnx', GH + 'melspectrogram.onnx'],
  },
  embedding: {
    name: 'embedding_model.onnx',
    size: 1326578,
    sha256: '70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f',
    urls: [HF + 'embedding_model.onnx', GH + 'embedding_model.onnx'],
  },
  wakeword: {
    name: 'hey_jarvis_v0.1.onnx',
    size: 1271370,
    sha256: '94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb',
    urls: [HF + 'hey_jarvis_v0.1.onnx', GH + 'hey_jarvis_v0.1.onnx'],
  },
};

// ── Model cache (IndexedDB) ──────────────────────────────────────────────────
// IndexedDB rather than Cache Storage: the packaged app runs from file://,
// where the Cache API is not reliably available.
const DB_NAME = 'mark-wake';
const STORE = 'models';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function dbPut(key: string, value: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function verify(file: ModelFile, buf: ArrayBuffer): Promise<boolean> {
  if (buf.byteLength !== file.size) return false;
  // crypto.subtle needs a secure context; without it, size is the best we have.
  if (!globalThis.crypto?.subtle) return true;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return hex === file.sha256;
}

async function download(file: ModelFile, onProgress: (pct: number) => void): Promise<ArrayBuffer> {
  let lastError = 'no source';
  for (const url of file.urls) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const out = new Uint8Array(file.size);
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > out.length) throw new Error('file larger than expected');
        out.set(value, got);
        got += value.length;
        onProgress(Math.round((got / file.size) * 100));
      }
      const buf = out.buffer.slice(0, got);
      if (!(await verify(file, buf))) throw new Error('checksum mismatch');
      return buf;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`${file.name}: ${lastError}`);
}

// ── Detector ─────────────────────────────────────────────────────────────────
function workerUrl(): URL {
  // Same resolution as lib/workerUrl.ts, which only types the two older workers.
  const href = window.location.href.split('#')[0].split('?')[0];
  return new URL('workers/wake.js', href.slice(0, href.lastIndexOf('/') + 1));
}

type WorkerMessage = { type: 'ready'; ms: number } | { type: 'error'; message: string } | { type: 'score'; score: number };

class OpenWakeWordDetector implements WakeDetector {
  private worker: Worker | null = null;
  private starting: Promise<boolean> | null = null;
  private ready = false;
  private listeners = new Set<() => void>();
  private lastFire = 0;

  async isReady(): Promise<boolean> {
    try {
      for (const file of Object.values(MODELS)) {
        const buf = await dbGet(file.name);
        if (!buf || buf.byteLength !== file.size) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async install(onProgress?: (msg: string) => void): Promise<[boolean, string]> {
    const say = (m: string) => onProgress?.(m);
    try {
      if (await this.isReady()) return [true, 'Wake word is already installed.'];
      const files = Object.values(MODELS);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const cached = await dbGet(file.name).catch(() => undefined);
        if (cached && cached.byteLength === file.size) continue;
        let shown = -1;
        const buf = await download(file, (pct) => {
          // Every 10% is plenty for a log line and keeps the HUD quiet.
          const step = Math.floor(pct / 10) * 10;
          if (step !== shown) {
            shown = step;
            say(`Downloading wake-word model ${i + 1}/${files.length} (${file.name})… ${step}%`);
          }
        });
        await dbPut(file.name, buf);
      }
      say('Wake-word models installed.');
      return [true, "Wake word installed. Say 'Hey Jarvis' to wake me."];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [false, `Wake-word download failed — ${msg}. Check the internet connection and try again.`];
    }
  }

  start(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = this.load().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async load(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') return false;
    let models: Record<keyof typeof MODELS, ArrayBuffer>;
    try {
      const [mel, embedding, wakeword] = await Promise.all(
        [MODELS.mel, MODELS.embedding, MODELS.wakeword].map((f) => dbGet(f.name)),
      );
      if (!mel || !embedding || !wakeword) return false;
      models = { mel, embedding, wakeword };
    } catch {
      return false;
    }

    const worker = new Worker(workerUrl(), { type: 'module' });
    this.worker = worker;
    const ok = await new Promise<boolean>((resolve) => {
      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        const m = e.data;
        if (m.type === 'ready') resolve(true);
        else if (m.type === 'error') {
          console.warn('[wake] worker error:', m.message);
          resolve(false);
        } else if (m.type === 'score') this.onScore(m.score);
      };
      worker.onerror = (e) => {
        console.warn('[wake] worker failed:', e.message);
        resolve(false);
      };
      worker.postMessage({ type: 'load', models }, [models.mel, models.embedding, models.wakeword]);
    });

    // stop() may have run while we were loading; honour it.
    if (!ok || this.worker !== worker) {
      if (this.worker === worker) this.stop();
      else worker.terminate();
      return false;
    }
    this.ready = true;
    return true;
  }

  feed(pcm: Int16Array): void {
    if (!this.ready || !this.worker) return;
    // Copy: the caller's buffer may be reused or be a view into a larger one.
    const copy = pcm.slice();
    this.worker.postMessage({ type: 'audio', pcm: copy }, [copy.buffer]);
  }

  onDetect(fn: () => void): void {
    this.listeners.add(fn);
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }

  private onScore(score: number): void {
    if (score < WAKE_THRESHOLD) return;
    const now = Date.now();
    if (now - this.lastFire < WAKE_COOLDOWN_MS) return;
    this.lastFire = now;
    this.worker?.postMessage({ type: 'reset' });
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.warn('[wake] listener failed:', err);
      }
    }
  }
}

let detector: OpenWakeWordDetector | null = null;

export function getWakeDetector(): WakeDetector {
  if (!detector) detector = new OpenWakeWordDetector();
  return detector;
}

registerWakeDetector(getWakeDetector());

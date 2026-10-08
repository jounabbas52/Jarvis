// The wake-word worker — Mark LIV runs openWakeWord on its own thread
// (core/wake_word.py); this is that thread. Inference never touches the
// renderer's main thread, so a slow chunk can't stutter the HUD or the mic.
//
// Built by scripts/build-workers.js to public/workers/wake.js.

// onnxruntime-web's package.json "exports" hides its typings; its ambient
// declarations are pulled in directly instead.
/// <reference path="../../node_modules/onnxruntime-web/types.d.ts" />
// The wasm-only build: no WebGPU/JSEP glue for three tiny CPU models.
import * as ort from 'onnxruntime-web/wasm';
import { WakePipeline, type WakeModels } from './wakeModel';

type Incoming =
  | { type: 'load'; models: WakeModels }
  | { type: 'audio'; pcm: Int16Array }
  | { type: 'reset' };

type Outgoing =
  | { type: 'ready'; ms: number }
  | { type: 'error'; message: string }
  | { type: 'score'; score: number };

const post = (m: Outgoing) => self.postMessage(m);

/** See lib/runtime.ts: the worker lives at <root>/workers/wake.js. */
function appRoot(): string {
  const here = self.location.href;
  const dir = here.slice(0, here.lastIndexOf('/'));
  return dir.slice(0, dir.lastIndexOf('/'));
}

// Served from the app's own files (scripts/copy-ort.js) so the wake word works
// with the network unplugged. One thread: the page is not cross-origin
// isolated, and three tiny models don't need more.
ort.env.wasm.wasmPaths = `${appRoot()}/ort/`;
ort.env.wasm.numThreads = 1;

let pipeline: WakePipeline | null = null;

// Audio waits here while a previous batch is still in inference. Capped so a
// stall (tab throttled, machine busy) can't make detection run seconds behind
// the speaker — old audio is worthless for a wake word.
const MAX_BACKLOG = 16000 * 2;
let queue: Int16Array[] = [];
let queued = 0;
let busy = false;

async function drain(): Promise<void> {
  if (busy || !pipeline) return;
  busy = true;
  try {
    while (queue.length) {
      const batch = queue;
      queue = [];
      queued = 0;
      const merged = new Int16Array(batch.reduce((n, b) => n + b.length, 0));
      let o = 0;
      for (const b of batch) {
        merged.set(b, o);
        o += b.length;
      }
      const scores = await pipeline.process(merged);
      if (scores.length) post({ type: 'score', score: Math.max(...scores) });
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    busy = false;
  }
}

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const msg = event.data;
  if (msg.type === 'load') {
    const started = Date.now();
    try {
      pipeline = pipeline ?? (await WakePipeline.create(ort, msg.models));
      post({ type: 'ready', ms: Date.now() - started });
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  } else if (msg.type === 'audio') {
    queue.push(msg.pcm);
    queued += msg.pcm.length;
    while (queued > MAX_BACKLOG && queue.length > 1) queued -= queue.shift()!.length;
    void drain();
  } else if (msg.type === 'reset') {
    // After a detection: forget the utterance that fired so its tail can't
    // fire again once the cooldown lapses.
    queue = [];
    queued = 0;
    pipeline?.resetScores();
  }
};

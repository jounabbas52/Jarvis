// The openWakeWord streaming pipeline, runtime-agnostic.
//
// A straight port of openwakeword.utils.AudioFeatures + Model.predict, which is
// what Mark LIV's core/wake_word.py drives. Kept free of DOM and worker globals
// so the exact same code runs in the wake worker and in a Node test harness.
//
//   16 kHz int16 → melspectrogram.onnx (per 1280-sample chunk, with 480 samples
//   of left context) → x/10 + 2 → rolling mel buffer → embedding_model.onnx on
//   the last 76 frames (one 96-d vector per chunk; 8 new frames per chunk) →
//   hey_jarvis_v0.1.onnx over the last 16 embeddings → score in [0, 1].

// onnxruntime-web's package.json "exports" hides its typings; its ambient
// declarations are pulled in directly instead.
/// <reference path="../../node_modules/onnxruntime-web/types.d.ts" />
import type * as Ort from 'onnxruntime-web';

export const CHUNK = 1280; // 80 ms at 16 kHz — openWakeWord's native frame
const CONTEXT = 160 * 3; // extra left context the mel model needs per chunk
const MEL_BINS = 32;
const MEL_WINDOW = 76;
const MEL_STEP = 8;
const EMB_DIM = 96;
const WW_FRAMES = 16;
const MEL_KEEP = 10 * 97; // openWakeWord keeps ~10 s of mel frames
const FEAT_KEEP = 120; // ~10 s of embeddings
const WARMUP_PREDICTIONS = 5; // Model.predict zeroes the first 5 scores

export interface WakeModels {
  mel: ArrayBuffer | Uint8Array;
  embedding: ArrayBuffer | Uint8Array;
  wakeword: ArrayBuffer | Uint8Array;
}

type OrtModule = typeof Ort;

export class WakePipeline {
  private melBuf: Float32Array[] = [];
  private featBuf: Float32Array[] = [];
  private context = new Float32Array(0);
  private pending: Float32Array = new Float32Array(0);
  private predictions = 0;

  private constructor(
    private ort: OrtModule,
    private mel: Ort.InferenceSession,
    private emb: Ort.InferenceSession,
    private ww: Ort.InferenceSession,
  ) {}

  static async create(ort: OrtModule, models: WakeModels): Promise<WakePipeline> {
    const opts: Ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] };
    const bytes = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(b));
    const [mel, emb, ww] = await Promise.all([
      ort.InferenceSession.create(bytes(models.mel), opts),
      ort.InferenceSession.create(bytes(models.embedding), opts),
      ort.InferenceSession.create(bytes(models.wakeword), opts),
    ]);
    const p = new WakePipeline(ort, mel, emb, ww);
    await p.reset();
    return p;
  }

  /**
   * Back to the state AudioFeatures.__init__ leaves: mel buffer of ones, and
   * the feature buffer primed with embeddings of 4 s of random noise so the
   * classifier has a full 16-frame window from the very first chunk.
   */
  async reset(): Promise<void> {
    this.melBuf = [];
    for (let i = 0; i < MEL_WINDOW; i++) this.melBuf.push(new Float32Array(MEL_BINS).fill(1));
    this.context = new Float32Array(0);
    this.pending = new Float32Array(0);
    this.predictions = 0;

    const noise = new Float32Array(16000 * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 2000) - 1000;
    const frames = await this.melspec(noise);
    const windows: Float32Array[][] = [];
    for (let i = 0; i + MEL_WINDOW <= frames.length; i += MEL_STEP) windows.push(frames.slice(i, i + MEL_WINDOW));
    this.featBuf = await this.embed(windows);
  }

  /** Clears the score history after a detection, as openWakeWord's Model.reset() does. */
  resetScores(): void {
    this.predictions = 0;
  }

  /**
   * Feed raw int16 samples (as numbers); returns one score per completed
   * 1280-sample chunk, in order. Samples beyond the last full chunk are kept.
   */
  async process(pcm: Int16Array | Float32Array): Promise<number[]> {
    const merged = new Float32Array(this.pending.length + pcm.length);
    merged.set(this.pending, 0);
    // openWakeWord feeds int16 values straight in as float32 — no /32768.
    for (let i = 0; i < pcm.length; i++) merged[this.pending.length + i] = pcm[i];

    const scores: number[] = [];
    let offset = 0;
    while (merged.length - offset >= CHUNK) {
      scores.push(await this.step(merged.subarray(offset, offset + CHUNK)));
      offset += CHUNK;
    }
    this.pending = merged.slice(offset);
    return scores;
  }

  private async step(chunk: Float32Array): Promise<number> {
    // Mel over chunk plus up to 480 samples of preceding audio.
    const input = new Float32Array(this.context.length + chunk.length);
    input.set(this.context, 0);
    input.set(chunk, this.context.length);
    this.context = input.slice(Math.max(0, input.length - CONTEXT));

    const frames = await this.melspec(input);
    for (const f of frames) this.melBuf.push(f);
    if (this.melBuf.length > MEL_KEEP) this.melBuf.splice(0, this.melBuf.length - MEL_KEEP);

    const [feat] = await this.embed([this.melBuf.slice(-MEL_WINDOW)]);
    this.featBuf.push(feat);
    if (this.featBuf.length > FEAT_KEEP) this.featBuf.splice(0, this.featBuf.length - FEAT_KEEP);

    const window = new Float32Array(WW_FRAMES * EMB_DIM);
    this.featBuf.slice(-WW_FRAMES).forEach((f, i) => window.set(f, i * EMB_DIM));
    const out = await this.ww.run({
      [this.ww.inputNames[0]]: new this.ort.Tensor('float32', window, [1, WW_FRAMES, EMB_DIM]),
    });
    const score = (out[this.ww.outputNames[0]].data as Float32Array)[0];

    this.predictions++;
    return this.predictions <= WARMUP_PREDICTIONS ? 0 : score;
  }

  /** melspectrogram.onnx → [frames][32], with openWakeWord's x/10 + 2 transform. */
  private async melspec(samples: Float32Array): Promise<Float32Array[]> {
    const out = await this.mel.run({
      [this.mel.inputNames[0]]: new this.ort.Tensor('float32', samples, [1, samples.length]),
    });
    const data = out[this.mel.outputNames[0]].data as Float32Array;
    const n = Math.floor(data.length / MEL_BINS);
    const frames: Float32Array[] = [];
    for (let t = 0; t < n; t++) {
      const row = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) row[b] = data[t * MEL_BINS + b] / 10 + 2;
      frames.push(row);
    }
    return frames;
  }

  /** embedding_model.onnx on a batch of 76×32 windows → one 96-d vector each. */
  private async embed(windows: Float32Array[][]): Promise<Float32Array[]> {
    if (!windows.length) return [];
    const batch = new Float32Array(windows.length * MEL_WINDOW * MEL_BINS);
    windows.forEach((w, i) => w.forEach((row, t) => batch.set(row, (i * MEL_WINDOW + t) * MEL_BINS)));
    const out = await this.emb.run({
      [this.emb.inputNames[0]]: new this.ort.Tensor('float32', batch, [windows.length, MEL_WINDOW, MEL_BINS, 1]),
    });
    const data = out[this.emb.outputNames[0]].data as Float32Array;
    const feats: Float32Array[] = [];
    for (let i = 0; i < windows.length; i++) feats.push(data.slice(i * EMB_DIM, (i + 1) * EMB_DIM));
    return feats;
  }
}

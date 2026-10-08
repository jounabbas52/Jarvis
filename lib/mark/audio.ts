// Microphone and speakers for the Live session.
//
// Mark opened sounddevice streams at 16 kHz in / 24 kHz out, 1024-sample
// blocks, on devices chosen by NAME. This does the same with Web Audio:
//
// - Mic: getUserMedia → an AudioWorklet that resamples to 16 kHz and hands
//   back int16 blocks of exactly 1024 samples.
// - Speakers: every chunk the model sends is scheduled on one continuous
//   AudioContext timeline. That timeline IS the playback clock Mark had to
//   reconstruct by hand ("_play_cursor"), so each chunk's audible start time
//   is known exactly and the mouth can be scheduled against it.
//
// Devices are stored by label, never by id: ids change when something is
// plugged in, and an unknown saved device falls back to the default with a
// log line instead of failing to start.

export const SEND_RATE = 16000;
export const RECEIVE_RATE = 24000;
export const CHUNK = 1024;

const WORKLET = `
class MarkMic extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.ratio = sampleRate / ${SEND_RATE};
    this.pos = 0;
    this.out = new Int16Array(${CHUNK});
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Linear-interpolating resampler with a fractional read position that
    // carries across render quanta, so no sample is lost at block edges.
    while (this.pos < ch.length - 1) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const s = ch[i] * (1 - f) + ch[i + 1] * f;
      this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.n === ${CHUNK}) {
        this.port.postMessage(this.out, [this.out.buffer]);
        this.out = new Int16Array(${CHUNK});
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor('mark-mic', MarkMic);
`;

async function deviceIdByLabel(kind: MediaDeviceKind, label: string): Promise<string | null> {
  if (!label) return null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hit = devices.find((d) => d.kind === kind && d.label === label);
    return hit ? hit.deviceId : null;
  } catch {
    return null;
  }
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  /** Resolves with a note when the saved device could not be used. */
  async start(deviceLabel: string, onChunk: (pcm: Int16Array) => void): Promise<string | null> {
    let note: string | null = null;
    const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const id = await deviceIdByLabel('audioinput', deviceLabel);
    if (deviceLabel && !id) note = `Microphone '${deviceLabel}' unavailable — using system default.`;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: id ? { ...base, deviceId: { exact: id } } : base,
      });
    } catch (e) {
      if (!id) throw e;
      note = `Microphone '${deviceLabel}' unavailable — using system default.`;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    }
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mark-mic');
    this.node.port.onmessage = (e: MessageEvent<Int16Array>) => onChunk(e.data);
    src.connect(this.node);
    // A worklet only runs while connected to the graph; a zero gain keeps it
    // running without routing the mic to the speakers.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    return note;
  }

  stop(): void {
    try {
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}

export class Player {
  private ctx: AudioContext | null = null;
  private cursor = 0; // context time the next chunk starts at
  private sources = new Set<AudioBufferSourceNode>();

  async start(deviceLabel: string): Promise<string | null> {
    this.ctx = new AudioContext({ sampleRate: RECEIVE_RATE, latencyHint: 'interactive' });
    let note: string | null = null;
    if (deviceLabel) {
      const id = await deviceIdByLabel('audiooutput', deviceLabel);
      const sink = (this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
      try {
        if (!id || !sink) throw new Error('not found');
        await sink.call(this.ctx, id);
      } catch {
        note = `Speaker '${deviceLabel}' unavailable — using system default.`;
      }
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    return note;
  }

  /** Seconds between handing the device a sample and it being heard. */
  get latency(): number {
    const c = this.ctx;
    if (!c) return 0.2;
    const l = (c.outputLatency || 0) + (c.baseLatency || 0);
    return l > 0 && l < 1 ? l : 0.2;
  }

  /**
   * Schedule a chunk. Returns when it will be audible, in performance.now()
   * milliseconds, which is what the mouth schedule is anchored to.
   */
  enqueue(pcm: Int16Array): number {
    const c = this.ctx;
    if (!c || !pcm.length) return performance.now();
    const buf = c.createBuffer(1, pcm.length, RECEIVE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    // A drained timeline restarts slightly ahead of "now" so the first chunk
    // of a reply is never scheduled in the past and clipped.
    if (this.cursor < c.currentTime + 0.02) this.cursor = c.currentTime + 0.05;
    const startAt = this.cursor;
    src.start(startAt);
    this.cursor += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    return this.toPerf(startAt);
  }

  /** True while scheduled audio has not finished playing. */
  get playing(): boolean {
    const c = this.ctx;
    return !!c && this.cursor > c.currentTime;
  }

  /** Stop everything scheduled, at once. */
  flush(): void {
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* not started yet */
      }
    });
    this.sources.clear();
    this.cursor = 0;
  }

  stop(): void {
    this.flush();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private toPerf(ctxTime: number): number {
    const c = this.ctx!;
    const ts = c.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined) {
      return ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
    }
    return performance.now() + (ctxTime - c.currentTime + this.latency) * 1000;
  }
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

export function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length & ~1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

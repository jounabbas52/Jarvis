// The webcam, for vision and the live preview.
//
// One stream, shared: screen_process with angle='camera' opens it and grabs a
// frame, the preview panel shows it while it stays open, and close_camera (or
// the preview's close button) releases the device. Mark resized frames to
// 1280x720 JPEG at quality 0.82 before sending; so does this.

const MAX_W = 1280;
const MAX_H = 720;
const JPEG_Q = 0.82;

type Listener = () => void;

class Camera {
  private current: MediaStream | null = null;
  private listeners = new Set<Listener>();

  stream(): MediaStream | null {
    return this.current;
  }

  async start(deviceId?: string): Promise<MediaStream> {
    if (this.current) return this.current;
    this.current = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.emit();
    return this.current;
  }

  stop(): void {
    this.current?.getTracks().forEach((t) => t.stop());
    this.current = null;
    this.emit();
  }

  /**
   * Grab one frame as base64 JPEG. Opens the camera if needed and waits for a
   * frame that is not black — the first frames of a webcam are often dark
   * while its exposure settles, which is why Mark warmed the device up.
   */
  async captureFrame(): Promise<{ data: string; mimeType: string; bytes: number }> {
    const stream = await this.start();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    const w0 = video.videoWidth || 1280;
    const h0 = video.videoHeight || 720;
    const scale = Math.min(MAX_W / w0, MAX_H / h0, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w0 * scale);
    canvas.height = Math.round(h0 * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2D canvas');

    for (let i = 0; i < 20; i++) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (meanLuma(ctx, canvas.width, canvas.height) > 8) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    video.pause();
    video.srcObject = null;

    const url = canvas.toDataURL('image/jpeg', JPEG_Q);
    const data = url.slice(url.indexOf(',') + 1);
    return { data, mimeType: 'image/jpeg', bytes: Math.floor((data.length * 3) / 4) };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}

function meanLuma(ctx: CanvasRenderingContext2D, w: number, h: number): number {
  const { data } = ctx.getImageData(0, 0, w, h);
  let sum = 0;
  let n = 0;
  // Every 16th pixel is plenty to tell a black frame from a real one.
  for (let i = 0; i < data.length; i += 64) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    n++;
  }
  return n ? sum / n : 0;
}

export const camera = new Camera();

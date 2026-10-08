'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { camera } from '@/lib/mark/camera';
import { useMarkStore } from '@/lib/mark/store';

/**
 * The live camera feed. Like Mark's HUD/camera stack it takes over the whole
 * HUD area while the camera is open, and hands it back when it closes.
 */
export default function CameraPreview() {
  const closeCamera = useMarkStore((s) => s.closeCamera);
  const stream = useSyncExternalStore(
    (fn) => camera.subscribe(fn),
    () => camera.stream(),
    () => null,
  );
  const videoRef = useRef<HTMLVideoElement>(null);

  // Mark's feed opened the device itself when the stream was asked for; do the
  // same if the camera was switched on before anything grabbed a frame.
  useEffect(() => {
    if (!camera.stream()) camera.start().catch(() => {});
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
  }, [stream]);

  const close = () => {
    closeCamera();
    // The controller releases the device; this is only belt-and-braces for
    // when no session is running to do it.
    camera.stop();
  };

  return (
    <div className="mk-cam">
      <div className="mk-cam-hdr">
        <span className="mk-cam-title">◈  CAMERA FEED</span>
        <button className="mk-cam-close" onClick={close}>
          ✕  CLOSE
        </button>
      </div>
      <video ref={videoRef} muted playsInline autoPlay />
    </div>
  );
}

// Minimal typing for the `qrcode` package (no @types/qrcode installed). Only
// what RemoteKeyOverlay uses; the browser build is picked via its "browser"
// field.
declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    scale?: number;
    width?: number;
    color?: { dark?: string; light?: string };
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
}

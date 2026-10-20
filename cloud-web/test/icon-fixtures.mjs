import { Buffer } from 'node:buffer';
export const svgIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="ink"><stop offset="0" stop-color="#805232"/><stop offset="1" stop-color="#24594f"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#ink)"/><path d="M16 44 42 18 48 24 22 50H16Z" fill="white"/></svg>';
export const svgBytes = new TextEncoder().encode(svgIcon);
export function icoBytes() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
    'base64',
  );
  const bytes = new Uint8Array(22 + png.length),
    view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  bytes[6] = 1;
  bytes[7] = 1;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.length, true);
  view.setUint32(18, 22, true);
  bytes.set(png, 22);
  return bytes;
}

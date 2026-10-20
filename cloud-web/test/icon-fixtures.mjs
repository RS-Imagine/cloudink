import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';
export const svgIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="ink"><stop offset="0" stop-color="#805232"/><stop offset="1" stop-color="#24594f"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#ink)"/><path d="M16 44 42 18 48 24 22 50H16Z" fill="white"/></svg>';
export const svgBytes = new TextEncoder().encode(svgIcon);
export function pngIcoBytes(options = {}) {
  function chunk(type, content) {
    const bytes = Buffer.alloc(content.length + 12);
    bytes.writeUInt32BE(content.length, 0);
    bytes.write(type, 4, 4, 'ascii');
    bytes.set(content, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, content.length + 8)), content.length + 8);
    return bytes;
  }
  const width = options.width ?? 1,
    height = options.height ?? 1;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = options.depth ?? 8;
  header[9] = options.palette ? 3 : 6;
  header[12] = options.interlaced ? 1 : 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(options.palette ? [chunk('PLTE', Buffer.from(options.palette.flat()))] : []),
    chunk(
      'IDAT',
      options.compressed ??
        deflateSync(Buffer.from(options.palette ? [0, 0] : [0, 128, 82, 50, 255])),
    ),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const bytes = new Uint8Array(22 + png.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  bytes[6] = width === 256 ? 0 : width;
  bytes[7] = height === 256 ? 0 : height;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.length, true);
  view.setUint32(18, 22, true);
  bytes.set(png, 22);
  return bytes;
}
export function icoBytes() {
  const size = 32;
  const pixels = size * size * 4;
  const mask = size * 4;
  const bytes = new Uint8Array(22 + 40 + pixels + mask);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  bytes[6] = size;
  bytes[7] = size;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, bytes.length - 22, true);
  view.setUint32(18, 22, true);
  view.setUint32(22, 40, true);
  view.setInt32(26, size, true);
  view.setInt32(30, size * 2, true);
  view.setUint16(34, 1, true);
  view.setUint16(36, 32, true);
  view.setUint32(42, pixels, true);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = 62 + (y * size + x) * 4;
      const pen = x >= 8 && x <= 24 && Math.abs(x + y - 31) <= 2;
      bytes.set(pen ? [248, 252, 255, 255] : [50, 82, 128, 255], offset);
    }
  }
  return bytes;
}

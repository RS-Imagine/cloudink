/** Bounded header inspection; decoding stays in the browser, never in the edge Worker. */
export function imageInfo(bytes: Uint8Array): {
  width?: number;
  height?: number;
  animated?: boolean;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, size: number) => String.fromCharCode(...bytes.subarray(at, at + size));
  const u24 = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
  let width = 0,
    height = 0,
    animated = false,
    rotate = false;
  try {
    if (text(1, 3) === 'PNG') {
      width = view.getUint32(16);
      height = view.getUint32(20);
      for (let at = 8; at + 12 <= bytes.length;) {
        const length = view.getUint32(at);
        if (text(at + 4, 4) === 'acTL') animated = true;
        if (length > bytes.length - at - 12) break;
        at += length + 12;
      }
    } else if (text(0, 3) === 'GIF') {
      width = view.getUint16(6, true);
      height = view.getUint16(8, true);
      animated = true;
    } else if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
      for (let at = 12; at + 8 <= bytes.length;) {
        const length = view.getUint32(at + 4, true),
          start = at + 8,
          kind = text(at, 4);
        if (length > bytes.length - start) break;
        if (kind === 'VP8X' && length >= 10) {
          width = u24(start + 4) + 1;
          height = u24(start + 7) + 1;
          animated = !!(bytes[start] & 2);
          break;
        }
        if (kind === 'VP8 ' && length >= 10 && text(start + 3, 3) === '\x9d\x01\x2a') {
          width = view.getUint16(start + 6, true) & 16383;
          height = view.getUint16(start + 8, true) & 16383;
        }
        if (kind === 'VP8L' && length >= 5 && bytes[start] === 47) {
          const bits = view.getUint32(start + 1, true);
          width = (bits & 16383) + 1;
          height = ((bits >>> 14) & 16383) + 1;
        }
        at = start + length + (length % 2);
      }
    } else if (bytes[0] === 255 && bytes[1] === 216) {
      for (let at = 2; at + 4 < bytes.length;) {
        if (bytes[at++] !== 255) break;
        while (bytes[at] === 255) at++;
        const marker = bytes[at++];
        if (marker === 218 || marker === 217) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        const length = view.getUint16(at),
          start = at + 2,
          end = at + length;
        if (length < 2 || end > bytes.length) break;
        if (
          [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
          length >= 7
        ) {
          height = view.getUint16(start + 1);
          width = view.getUint16(start + 3);
        }
        if (marker === 225 && text(start, 6) === 'Exif\0\0') {
          const tiff = start + 6,
            little = text(tiff, 2) === 'II';
          if (tiff + 8 <= end) {
            const ifd = tiff + view.getUint32(tiff + 4, little);
            if (ifd >= tiff && ifd + 2 <= end) {
              const count = Math.min(view.getUint16(ifd, little), 256);
              for (let n = 0; n < count; n++) {
                const item = ifd + 2 + n * 12;
                if (item + 12 > end) break;
                if (
                  view.getUint16(item, little) === 274 &&
                  view.getUint16(item + 2, little) === 3 &&
                  view.getUint32(item + 4, little) === 1
                ) {
                  const orientation = view.getUint16(item + 8, little);
                  rotate = orientation >= 5 && orientation <= 8;
                }
              }
            }
          }
        }
        at = end;
      }
    }
  } catch {
    return {};
  }
  if (rotate) [width, height] = [height, width];
  return width > 0 && height > 0 && width <= 65535 && height <= 65535
    ? { width, height, animated }
    : {};
}

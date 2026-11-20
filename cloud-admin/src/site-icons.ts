import { cacheKey, cacheRead, cacheWrite, clientResponse } from '../../cloud-web/src/cache';
import { SaxesParser } from 'saxes';
import { sha256Hex } from './crypto';
import { imageInfo } from './image-info';
import { imageType } from './media';
import {
  HttpError,
  json,
  siteIconDerivedKeys,
  siteIconMime,
  validSiteIconAssetKey,
  validSiteIconKey,
  type SiteConfig,
} from './models';

const encoder = new TextEncoder();
const elements = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'title',
  'desc',
  'use',
  'symbol',
]);
const attributes = new Map(
  [
    'viewBox',
    'width',
    'height',
    'x',
    'y',
    'x1',
    'x2',
    'y1',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'd',
    'points',
    'transform',
    'fill',
    'fill-rule',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'stroke-dasharray',
    'stroke-dashoffset',
    'stroke-opacity',
    'opacity',
    'id',
    'gradientUnits',
    'gradientTransform',
    'offset',
    'stop-color',
    'stop-opacity',
    'clip-path',
    'clip-rule',
    'clipPathUnits',
    'mask',
    'maskUnits',
    'maskContentUnits',
    'preserveAspectRatio',
    'spreadMethod',
    'fx',
    'fy',
    'fr',
  ].map((name) => [name.toLowerCase(), name]),
);
const paints = new Set(['fill', 'stroke', 'stop-color']);
function safeValue(name: string, value: string): boolean {
  if (value.length > 200_000 || /[<>&\\]/.test(value)) return false;
  if (name === 'id') return /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/.test(value);
  if (name === 'clip-path' || name === 'mask')
    return /^(?:none|url\(#[A-Za-z_][A-Za-z0-9_.:-]{0,99}\))$/.test(value);
  if (paints.has(name))
    return /^(?:none|currentColor|transparent|[A-Za-z]+|#[A-Fa-f0-9]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%+\-\s/]+\)|url\(#[A-Za-z_][A-Za-z0-9_.:-]{0,99}\))$/.test(
      value,
    );
  return /^[A-Za-z0-9.,%()+:\-\s]*$/.test(value);
}
function validateSvgDocument(source: string): void {
  let depth = 0,
    nodes = 0;
  try {
    const parser = new SaxesParser({ xmlns: true });
    const unsupported = () => {
      throw new HttpError(400, 'SVG 不支持文档声明或处理指令，请重新导出静态图标。');
    };
    parser.on('doctype', unsupported);
    parser.on('processinginstruction', unsupported);
    parser.on('opentag', (tag) => {
      if (++depth > 128 || ++nodes > 5000)
        throw new HttpError(413, 'SVG 图标过于复杂，请简化后上传。');
      if (depth === 1 && tag.name !== 'svg') throw new HttpError(400, 'SVG 需要一个完整的根元素。');
    });
    parser.on('closetag', () => {
      depth--;
    });
    parser.write(source).close();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'SVG 不是完整有效的 XML 文档，请重新导出。');
  }
}
async function sanitizeSvg(bytes: Uint8Array): Promise<Uint8Array> {
  let input: string;
  try {
    input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new HttpError(400, 'SVG 必须使用 UTF-8 编码。');
  }
  input = input.trim().replace(/^<\?xml[^?]*\?>\s*/i, '');
  validateSvgDocument(input);
  let roots = 0,
    shapes = 0,
    nodes = 0;
  const response = new HTMLRewriter()
    .on('*', {
      element(element) {
        if (++nodes > 5000) throw new HttpError(413, 'SVG 图标过于复杂，请简化后上传。');
        const tag = element.tagName.toLowerCase();
        if (!elements.has(tag)) {
          element.remove();
          return;
        }
        if (tag === 'svg') roots++;
        if (
          ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use'].includes(tag)
        )
          shapes++;
        const original = [...element.attributes];
        for (const [name] of original) element.removeAttribute(name);
        for (const [raw, value] of original) {
          if (raw.toLowerCase() === 'style') {
            for (const declaration of value.split(';')) {
              const colon = declaration.indexOf(':');
              if (colon < 0) continue;
              const property = declaration.slice(0, colon).trim().toLowerCase(),
                content = declaration.slice(colon + 1).trim();
              if (
                [
                  'fill',
                  'stroke',
                  'opacity',
                  'fill-opacity',
                  'stroke-opacity',
                  'stroke-width',
                  'stop-color',
                  'stop-opacity',
                ].includes(property) &&
                safeValue(property, content)
              )
                element.setAttribute(property, content);
            }
            continue;
          }
          const name = raw.toLowerCase();
          if (
            (name === 'href' || name === 'xlink:href') &&
            /^#[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/.test(value)
          ) {
            element.setAttribute('href', value);
          } else {
            const canonical = attributes.get(name);
            if (canonical && safeValue(name, value)) element.setAttribute(canonical, value);
          }
        }
        if (tag === 'svg') element.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      },
      comments(comment) {
        comment.remove();
      },
    })
    .transform(new Response(input, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const sanitized = await response.text();
  validateSvgDocument(sanitized);
  const output = encoder.encode(sanitized);
  if (roots !== 1 || !shapes) throw new HttpError(400, 'SVG 需要一个根元素和可显示的图形。');
  return output;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function pngCrc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
async function validatePngPixels(
  chunks: Uint8Array[],
  width: number,
  height: number,
  depth: number,
  color: number,
  interlace: number,
  remaining: number,
  paletteSize: number,
): Promise<number> {
  const invalid = (): never => {
    throw new HttpError(400, 'ICO 中的 PNG 压缩数据或扫描行无效。');
  };
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bits = channels[color] * depth;
  const rows: number[] = [];
  const rowWidths: number[] = [];
  const firstRows = new Set<number>();
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  for (const [x, y, dx, dy] of passes) {
    const w = width > x ? Math.ceil((width - x) / dx) : 0;
    const h = height > y ? Math.ceil((height - y) / dy) : 0;
    if (w && h) {
      firstRows.add(rows.length);
      for (let row = 0; row < h; row++) {
        rows.push(1 + Math.ceil((w * bits) / 8));
        rowWidths.push(w);
      }
    }
  }
  const expected = rows.reduce((sum, length) => sum + length, 0);
  if (expected > remaining)
    throw new HttpError(413, '图标解码后的内容过大，请减少图标尺寸或数量。');
  const compressed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }
  let position = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === compressed.length) {
        controller.close();
        return;
      }
      const end = Math.min(position + 256, compressed.length);
      controller.enqueue(compressed.subarray(position, end));
      position = end;
    },
    cancel() {
      position = compressed.length;
    },
  });
  const reader = body.pipeThrough(new DecompressionStream('deflate')).getReader();
  let count = 0,
    row = 0,
    column = 0,
    finished = false,
    filter = 0;
  let previous = new Uint8Array(0),
    current = new Uint8Array(0);
  const paeth = (left: number, above: number, corner: number): number => {
    const prediction = left + above - corner;
    const a = Math.abs(prediction - left),
      b = Math.abs(prediction - above),
      c = Math.abs(prediction - corner);
    return a <= b && a <= c ? left : b <= c ? above : corner;
  };
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (item.value.length > expected - count) invalid();
      for (const byte of item.value) {
        if (!column) {
          if (byte > 4) invalid();
          filter = byte;
          if (color === 3 && firstRows.has(row)) {
            previous = new Uint8Array(rows[row] - 1);
            current = new Uint8Array(rows[row] - 1);
          }
        } else if (color === 3) {
          const index = column - 1;
          const left = index ? current[index - 1] : 0;
          const above = previous[index];
          const corner = index ? previous[index - 1] : 0;
          const predictor =
            filter === 1
              ? left
              : filter === 2
                ? above
                : filter === 3
                  ? Math.floor((left + above) / 2)
                  : filter === 4
                    ? paeth(left, above, corner)
                    : 0;
          current[index] = (byte + predictor) & 255;
        }
        if (++column === rows[row]) {
          if (color === 3) {
            for (let pixel = 0; pixel < rowWidths[row]; pixel++) {
              const bit = pixel * depth;
              const sample = (current[bit >>> 3] >>> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
              if (sample >= paletteSize) invalid();
            }
            const swap = previous;
            previous = current;
            current = swap;
          }
          row++;
          column = 0;
        }
      }
      count += item.value.length;
    }
    finished = true;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid();
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (count !== expected || row !== rows.length || column !== 0) invalid();
  return expected;
}
async function validateIconPng(
  payload: Uint8Array,
  width: number,
  height: number,
  remaining: number,
): Promise<number> {
  const invalid = (): never => {
    throw new HttpError(400, 'ICO 中的 PNG 图像不完整或校验失败。');
  };
  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const compressed: Uint8Array[] = [];
  let depth = 0,
    interlace = 0,
    paletteSize = 0;
  let offset = 8,
    chunks = 0,
    imageData = false,
    startedData = false,
    transparency = false,
    endedData = false,
    palette = false,
    color = -1;
  while (offset + 12 <= payload.length) {
    if (++chunks > 4096) invalid();
    const length = data.getUint32(offset),
      next = offset + length + 12;
    if (next > payload.length) invalid();
    const type = String.fromCharCode(...payload.subarray(offset + 4, offset + 8));
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      pngCrc(payload.subarray(offset + 4, next - 4)) !== data.getUint32(next - 4)
    )
      invalid();
    if (chunks === 1) {
      if (
        type !== 'IHDR' ||
        length !== 13 ||
        data.getUint32(offset + 8) !== width ||
        data.getUint32(offset + 12) !== height
      )
        invalid();
      depth = payload[offset + 16];
      interlace = payload[offset + 20];
      color = payload[offset + 17];
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(depth) ||
        payload[offset + 18] !== 0 ||
        payload[offset + 19] !== 0 ||
        payload[offset + 20] > 1
      )
        invalid();
    } else if (type === 'IHDR') invalid();
    else if (type === 'PLTE') {
      if (
        palette ||
        transparency ||
        startedData ||
        !length ||
        length > 768 ||
        length % 3 !== 0 ||
        color === 0 ||
        color === 4
      )
        invalid();
      paletteSize = length / 3;
      if (color === 3 && paletteSize > 2 ** depth) invalid();
      palette = true;
    } else if (type === 'tRNS') {
      if (transparency || startedData) invalid();
      if (color === 3) {
        if (!palette || length < 1 || length > paletteSize) invalid();
      } else if (color === 0 || color === 2) {
        if (length !== (color === 0 ? 2 : 6)) invalid();
        for (let i = 0; i < length; i += 2)
          if (data.getUint16(offset + 8 + i) > 2 ** depth - 1) invalid();
      } else invalid();
      transparency = true;
    } else if (type === 'IDAT') {
      if (endedData || (color === 3 && !palette)) invalid();
      startedData = true;
      if (length) {
        imageData = true;
        compressed.push(payload.subarray(offset + 8, offset + 8 + length));
      }
    } else if (type === 'IEND') {
      if (length !== 0 || !imageData || next !== payload.length) invalid();
      return validatePngPixels(
        compressed,
        width,
        height,
        depth,
        color,
        interlace,
        remaining,
        paletteSize,
      );
    } else {
      if (type[0] === type[0].toUpperCase()) invalid();
      if (startedData) endedData = true;
    }
    offset = next;
  }
  return invalid();
}
async function validateIco(bytes: Uint8Array): Promise<void> {
  let decoded = 0;
  const invalid = (): never => {
    throw new HttpError(400, 'ICO 文件结构无效或图像数据不完整，请重新导出图标。');
  };
  if (bytes.length < 22) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (
    view.getUint16(0, true) !== 0 ||
    view.getUint16(2, true) !== 1 ||
    count < 1 ||
    count > 64 ||
    6 + count * 16 > bytes.length
  )
    invalid();
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16,
      size = view.getUint32(entry + 8, true),
      offset = view.getUint32(entry + 12, true);
    if (
      bytes[entry + 3] !== 0 ||
      offset < 6 + count * 16 ||
      size < 24 ||
      offset + size > bytes.length
    )
      invalid();
    const payload = bytes.subarray(offset, offset + size),
      data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const width = bytes[entry] || 256,
      height = bytes[entry + 1] || 256;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, n) => payload[n] === v);
    if (png) {
      decoded += await validateIconPng(payload, width, height, 4 * 1024 * 1024 - decoded);
    } else {
      if (size < 40) invalid();
      const header = data.getUint32(0, true),
        depth = data.getUint16(14, true),
        compression = data.getUint32(16, true),
        colors = data.getUint32(32, true);
      if (
        ![40, 108, 124].includes(header) ||
        size < header ||
        data.getInt32(4, true) !== width ||
        data.getInt32(8, true) !== height * 2 ||
        data.getUint16(12, true) !== 1 ||
        ![1, 4, 8, 16, 24, 32].includes(depth) ||
        ![0, 3, 6].includes(compression) ||
        (compression !== 0 && ![16, 32].includes(depth))
      )
        invalid();
      if (colors > 256 || (depth <= 8 && colors > 2 ** depth)) invalid();
      const palette = colors || (depth <= 8 ? 2 ** depth : 0);
      const masks = header === 40 && compression !== 0 ? (compression === 6 ? 16 : 12) : 0;
      const pixels = Math.ceil((width * depth) / 32) * 4 * height;
      const mask = Math.ceil(width / 32) * 4 * height;
      const imageSize = data.getUint32(20, true);
      if (
        header + masks + palette * 4 + pixels + mask > size ||
        (imageSize !== 0 && (imageSize < pixels || imageSize > size - header - masks - palette * 4))
      )
        invalid();
      if (compression !== 0) {
        const channels = header === 40 && compression === 3 ? 3 : 4;
        let occupied = 0;
        for (let channel = 0; channel < channels; channel++) {
          const value = data.getUint32(40 + channel * 4, true);
          if (!value) {
            if (channel < 3 || compression === 6) invalid();
            continue;
          }
          if ((depth === 16 && value > 0xffff) || (value & occupied) !== 0) invalid();
          let normalized = value;
          while ((normalized & 1) === 0) normalized >>>= 1;
          if ((normalized & (normalized + 1)) !== 0) invalid();
          occupied = (occupied | value) >>> 0;
        }
      }
      if (depth <= 8) {
        const start = header + masks + palette * 4;
        const stride = pixels / height;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const bit = x * depth;
            const sample =
              (payload[start + y * stride + (bit >>> 3)] >>> (8 - depth - (bit & 7))) &
              ((1 << depth) - 1);
            if (sample >= palette) invalid();
          }
        }
      }
    }
  }
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 24 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

async function validateDerivedPng(bytes: Uint8Array, expectedSize: number): Promise<void> {
  if (!hasPngSignature(bytes))
    throw new HttpError(400, `派生图标 ${expectedSize}×${expectedSize} 不是有效的 PNG 图片。`);
  try {
    await validateIconPng(bytes, expectedSize, expectedSize, 4 * 1024 * 1024);
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) throw error;
    throw new HttpError(
      400,
      `派生图标 ${expectedSize}×${expectedSize} 的尺寸或 PNG 结构校验失败。`,
    );
  }
}

function detectRasterIcon(input: Uint8Array): { ext: string; type: string } | null {
  let detected: { ext: string; type: string };
  try {
    detected = imageType(input);
  } catch {
    return null;
  }
  if (detected.ext !== 'avif') {
    const info = imageInfo(input);
    if (!info.width || !info.height || info.width <= 0 || info.height <= 0)
      throw new HttpError(400, '图片文件已损坏或无法读取尺寸，请重新选择图片。');
  }
  return detected;
}

function looksLikeXmlOrSvg(input: Uint8Array): boolean {
  const sample = new TextDecoder().decode(input.subarray(0, 512)).trimStart();
  return (
    sample.startsWith('<svg') ||
    sample.startsWith('<?xml') ||
    sample.startsWith('<!') ||
    sample.startsWith('<')
  );
}

export async function inspectSiteIcon(input: Uint8Array) {
  if (!input.length) throw new HttpError(400, '请选择有效的网站图标文件。');
  const ico =
    input.length >= 4 && input[0] === 0 && input[1] === 0 && input[2] === 1 && input[3] === 0;
  if (ico) {
    await validateIco(input);
    const hash = await sha256Hex(input);
    return {
      bytes: input,
      hash,
      ext: 'ico',
      key: 'uploads/icons/' + hash + '.ico',
      type: 'image/x-icon',
    };
  }
  const raster = detectRasterIcon(input);
  if (raster) {
    const hash = await sha256Hex(input);
    return {
      bytes: input,
      hash,
      ext: raster.ext,
      key: 'uploads/icons/' + hash + '.' + raster.ext,
      type: raster.type,
    };
  }
  if (!looksLikeXmlOrSvg(input))
    throw new HttpError(
      400,
      '不支持的文件格式，请上传有效的 PNG、JPG、WebP、GIF、AVIF、SVG 或 ICO 图片。',
    );
  const bytes = await sanitizeSvg(input);
  const hash = await sha256Hex(bytes);
  return {
    bytes,
    hash,
    ext: 'svg',
    key: 'uploads/icons/' + hash + '.svg',
    type: 'image/svg+xml',
  };
}

interface PreparedDerived {
  key: string;
  bytes: Uint8Array;
  type: string;
}

async function readFormBlob(form: FormData, field: string, label: string): Promise<Uint8Array> {
  const part = form.get(field);
  if (!part || typeof part === 'string') throw new HttpError(400, `缺少${label}派生图标。`);
  const bytes = new Uint8Array(await part.arrayBuffer());
  if (!bytes.length) throw new HttpError(400, `${label}派生图标为空。`);
  return bytes;
}

async function validateDerivedSet(form: FormData, key: string): Promise<PreparedDerived[]> {
  const derived = siteIconDerivedKeys(key);
  if (!derived) throw new HttpError(400, '网站图标地址不正确。');
  const pngSpecs: [string, string, number, string][] = [
    ['derived_180', derived.apple, 180, 'Apple 主屏 180×180'],
    ['derived_192', derived.icon192, 192, 'PWA 192×192'],
    ['derived_512', derived.icon512, 512, 'PWA 512×512'],
    ['derived_512_maskable', derived.maskable512, 512, 'PWA 512×512 Maskable'],
  ];
  const prepared: PreparedDerived[] = [];
  for (const [field, targetKey, size, label] of pngSpecs) {
    const bytes = await readFormBlob(form, field, label);
    await validateDerivedPng(bytes, size);
    prepared.push({ key: targetKey, bytes, type: 'image/png' });
  }
  if (derived.ext !== 'ico') {
    const icoBytes = await readFormBlob(form, 'derived_ico', 'favicon.ico');
    await validateIco(icoBytes);
    prepared.push({ key: derived.faviconIco, bytes: icoBytes, type: 'image/x-icon' });
  }
  return prepared;
}

async function putIconObjectsAtomic(
  storage: R2Bucket,
  objects: { key: string; bytes: Uint8Array; type: string; metadata?: Record<string, string> }[],
): Promise<{ created: string[]; reusedAll: boolean }> {
  const created: string[] = [];
  let reusedAll = true;
  try {
    for (const item of objects) {
      const existing = await storage.head(item.key);
      if (
        existing &&
        existing.size === item.bytes.byteLength &&
        existing.httpMetadata?.contentType === item.type
      )
        continue;
      reusedAll = false;
      const saved = await storage.put(item.key, item.bytes, {
        httpMetadata: {
          contentType: item.type,
          cacheControl: 'public, max-age=31536000, immutable',
        },
        ...(item.metadata ? { customMetadata: item.metadata } : {}),
      });
      if (!saved) throw new HttpError(500, '保存网站图标失败，请重试。');
      created.push(item.key);
    }
    return { created, reusedAll };
  } catch (error) {
    if (created.length) await storage.delete(created).catch(() => {});
    throw error;
  }
}

export async function hasSiteIconDerivatives(
  storage: R2Bucket,
  siteIcon?: string,
): Promise<boolean> {
  if (!siteIcon) return true;
  const derived = siteIconDerivedKeys(siteIcon);
  if (!derived) return true;
  const results = await Promise.all(
    derived.generated.map(async (key) => {
      const head = await storage.head(key);
      return !!head && head.httpMetadata?.contentType === siteIconMime(key);
    }),
  );
  return results.every(Boolean);
}

export async function ensureSiteIcon(storage: R2Bucket, site: SiteConfig): Promise<void> {
  if (!site.siteIcon) {
    delete site.siteIconSize;
    return;
  }
  const object = await storage.head(site.siteIcon);
  if (!object || object.httpMetadata?.contentType !== siteIconMime(site.siteIcon))
    throw new HttpError(400, '网站图标已被删除或尚未上传，请重新选择后保存。');
  site.siteIconSize = object.size;
}

export async function uploadSiteIcon(request: Request, storage: R2Bucket): Promise<Response> {
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (contentType.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, '无法解析上传的图标表单，请重试。');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, '请选择网站图标文件。');
    const icon = await inspectSiteIcon(new Uint8Array(await file.arrayBuffer()));
    const derived = await validateDerivedSet(form, icon.key);
    const { reusedAll } = await putIconObjectsAtomic(storage, [
      ...derived,
      {
        key: icon.key,
        bytes: icon.bytes,
        type: icon.type,
        metadata: { name: '网站图标.' + icon.ext },
      },
    ]);
    return json(
      {
        key: icon.key,
        url: '/site-icon/' + icon.key.slice('uploads/icons/'.length),
        type: icon.type,
        ext: icon.ext,
        size: icon.bytes.byteLength,
        derived: derived.map((item) => item.key),
        derivativesReady: true,
        ...(reusedAll ? { reused: true } : {}),
      },
      201,
    );
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  const icon = await inspectSiteIcon(raw);
  const existing = await storage.head(icon.key);
  const derivativesReady = await hasSiteIconDerivatives(storage, icon.key);
  if (
    existing &&
    existing.size === icon.bytes.byteLength &&
    existing.httpMetadata?.contentType === icon.type
  )
    return json(
      {
        key: icon.key,
        url: '/site-icon/' + icon.key.slice('uploads/icons/'.length),
        type: icon.type,
        ext: icon.ext,
        size: icon.bytes.byteLength,
        derivativesReady,
        reused: true,
      },
      201,
    );
  await storage.put(icon.key, icon.bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: icon.type, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { name: '网站图标.' + icon.ext },
  });
  return json(
    {
      key: icon.key,
      url: '/site-icon/' + icon.key.slice('uploads/icons/'.length),
      type: icon.type,
      ext: icon.ext,
      size: icon.bytes.byteLength,
      derivativesReady,
    },
    201,
  );
}

export async function backfillSiteIconDerivatives(
  request: Request,
  storage: R2Bucket,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, '无法解析派生图标表单，请重试。');
  }
  const key = form.get('key');
  if (typeof key !== 'string' || !validSiteIconKey(key))
    throw new HttpError(400, '网站图标地址不正确。');
  const original = await storage.head(key);
  if (!original || original.httpMetadata?.contentType !== siteIconMime(key))
    throw new HttpError(404, '原网站图标不存在，请重新上传图标。');
  const derived = await validateDerivedSet(form, key);
  const { created } = await putIconObjectsAtomic(storage, derived);
  return json({
    key,
    derivativesReady: true,
    created,
  });
}

export async function publicSiteIcon(
  request: Request,
  storage: R2Bucket,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const name = new URL(request.url).pathname.slice('/site-icon/'.length);
  const key = 'uploads/icons/' + name;
  if (!validSiteIconAssetKey(key)) return new Response('Not found', { status: 404 });
  const cache = cacheKey(request, 'image');
  const cached = ctx ? await cacheRead(cache) : undefined;
  if (cached) return clientResponse(cached, request, true);
  const body = request.method === 'GET' ? await storage.get(key) : null;
  const object = request.method === 'HEAD' ? await storage.head(key) : body;
  const type = siteIconMime(key);
  if (!object || object.httpMetadata?.contentType !== type) {
    if (body) await body.body.cancel();
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers({
    'Content-Type': type,
    ETag: object.httpEtag,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  if (
    request.headers
      .get('If-None-Match')
      ?.split(',')
      .some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === object.httpEtag)
  ) {
    if (body) await body.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  const response = new Response(body?.body || null, { headers });
  if (ctx && request.method === 'GET') cacheWrite(ctx, cache, response, 604800);
  return response;
}

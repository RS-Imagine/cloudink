import { HttpError, json, limitedBody, validSiteIconKey, type SiteConfig } from './models';

export const MAX_SITE_ICON = 256 * 1024;
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
async function sanitizeSvg(bytes: Uint8Array): Promise<Uint8Array> {
  let input: string;
  try {
    input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'SVG 必须使用 UTF-8 编码。');
  }
  input = input.trim().replace(/^<\?xml[^?]*\?>\s*/i, '');
  if (
    !/^<svg(?:\s|\/?>)/i.test(input) ||
    !/(?:<\/svg\s*>|\/>)$/i.test(input) ||
    /<!|<\?/.test(input)
  )
    throw new HttpError(400, '请上传不含文档声明的静态 SVG 图标。');
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
  const output = encoder.encode(await response.text());
  if (roots !== 1 || !shapes) throw new HttpError(400, 'SVG 需要一个根元素和可显示的图形。');
  if (output.length > MAX_SITE_ICON) throw new HttpError(413, '网站图标最多 256 KB。');
  return output;
}
function validateIco(bytes: Uint8Array): void {
  const invalid = () => {
    throw new HttpError(400, 'ICO 文件结构无效，请重新导出图标。');
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
    if (offset < 6 + count * 16 || size < 24 || offset + size > bytes.length) invalid();
    const payload = bytes.subarray(offset, offset + size),
      data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const width = bytes[entry] || 256,
      height = bytes[entry + 1] || 256;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, n) => payload[n] === v);
    if (png) {
      if (
        data.getUint32(8) !== 13 ||
        data.getUint32(12) !== 0x49484452 ||
        data.getUint32(16) !== width ||
        data.getUint32(20) !== height
      )
        invalid();
    } else {
      if (
        size < 40 ||
        ![40, 108, 124].includes(data.getUint32(0, true)) ||
        data.getInt32(4, true) !== width ||
        data.getInt32(8, true) !== height * 2 ||
        data.getUint16(12, true) !== 1 ||
        ![1, 4, 8, 16, 24, 32].includes(data.getUint16(14, true))
      )
        invalid();
    }
  }
}
export async function inspectSiteIcon(input: Uint8Array) {
  if (!input.length || input.length > MAX_SITE_ICON)
    throw new HttpError(413, '网站图标需为 1 字节至 256 KB。');
  const ico = input[0] === 0 && input[1] === 0 && input[2] === 1 && input[3] === 0;
  const bytes = ico ? input : await sanitizeSvg(input);
  if (ico) validateIco(bytes);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  const ext = ico ? 'ico' : 'svg';
  return {
    bytes,
    key: 'uploads/icons/' + hash + '.' + ext,
    type: ico ? 'image/x-icon' : 'image/svg+xml',
  };
}
export async function ensureSiteIcon(storage: R2Bucket, site: SiteConfig): Promise<void> {
  if (!site.siteIcon) return;
  const object = await storage.head(site.siteIcon);
  if (
    !object ||
    object.size > MAX_SITE_ICON ||
    object.httpMetadata?.contentType !==
      (site.siteIcon.endsWith('.ico') ? 'image/x-icon' : 'image/svg+xml')
  )
    throw new HttpError(400, '网站图标已被删除或尚未上传，请重新选择后保存。');
}
export async function uploadSiteIcon(request: Request, storage: R2Bucket): Promise<Response> {
  const icon = await inspectSiteIcon(new Uint8Array(await limitedBody(request, MAX_SITE_ICON)));
  await storage.put(icon.key, icon.bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: icon.type, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { name: '网站图标.' + (icon.key.endsWith('.ico') ? 'ico' : 'svg') },
  });
  return json({ key: icon.key, url: '/site-icon/' + icon.key.slice('uploads/icons/'.length) }, 201);
}
export async function publicSiteIcon(request: Request, storage: R2Bucket): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const name = new URL(request.url).pathname.slice('/site-icon/'.length);
  const key = 'uploads/icons/' + name;
  if (!validSiteIconKey(key)) return new Response('Not found', { status: 404 });
  const body = request.method === 'GET' ? await storage.get(key) : null;
  const object = request.method === 'HEAD' ? await storage.head(key) : body;
  const type = name.endsWith('.ico') ? 'image/x-icon' : 'image/svg+xml';
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
  return new Response(body?.body || null, { headers });
}

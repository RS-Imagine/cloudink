import { HttpError } from './models';

export const MAX_IMAGE = 10 * 1024 * 1024;
// The single bucket also contains credentials and drafts. Media routes must
// never translate an arbitrary URL into an arbitrary object key.
export function validImageKey(key: string): boolean {
  return (
    key.length <= 1024 &&
    /^uploads\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp|gif|avif)$/.test(key) &&
    !key.split('/').some((part) => !part || part === '.' || part === '..')
  );
}
export function imageType(bytes: Uint8Array): { type: string; ext: string } {
  const text = new TextDecoder().decode(bytes.slice(0, 16));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { type: 'image/jpeg', ext: 'jpg' };
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n))
    return { type: 'image/png', ext: 'png' };
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a'))
    return { type: 'image/gif', ext: 'gif' };
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP')
    return { type: 'image/webp', ext: 'webp' };
  if (text.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(text.slice(8, 12)))
    return { type: 'image/avif', ext: 'avif' };
  throw new HttpError(400, '请上传 JPEG、PNG、GIF、WebP 或 AVIF 图片。');
}

/** The only public image route: uploaded media, never arbitrary bucket objects. */
export async function publicImage(request: Request, storage: R2Bucket): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  let key: string;
  try {
    key = decodeURIComponent(new URL(request.url).pathname.slice('/images/'.length));
  } catch {
    return new Response('Invalid image path', { status: 400 });
  }
  if (!validImageKey(key)) return new Response('Not found', { status: 404 });
  let referrer = '';
  try {
    referrer = new URL(request.headers.get('Referer') || '').origin;
  } catch {
    // Missing or invalid referrers are not eligible for public image hosting.
  }
  if (referrer !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  const body = request.method === 'GET' ? await storage.get(key) : null;
  const object = request.method === 'HEAD' ? await storage.head(key) : body;
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers({
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Referer',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'public, max-age=86400',
  });
  object.writeHttpMetadata(headers);
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(headers.get('Content-Type') || '')) {
    if (body) await body.body.cancel();
    return new Response('Unsupported image', { status: 415 });
  }
  headers.set('ETag', object.httpEtag);
  const validators = request.headers
    .get('If-None-Match')
    ?.split(',')
    .map((x) => x.trim().replace(/^W\//, ''));
  if (validators?.some((x) => x === '*' || x === object.httpEtag)) {
    if (body) await body.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  return new Response(body?.body || null, { headers });
}

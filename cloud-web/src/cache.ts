import { CURRENT_TEMPLATE_VERSION } from '../../cloud-admin/src/template-version.generated';
import { PUBLIC_RESPONSE_VERSION } from '../../cloud-admin/src/assets.generated';

// Only public objects belong here. Authentication, drafts and mutations never
// use this cache. Entries are scoped to origin and deployment template.
export function cacheKey(request: Request, group: string, version = ''): Request {
  const url = new URL(request.url);
  url.pathname =
    '/__cloudink_cache/' +
    (group === 'image' ? 'media-v1' : CURRENT_TEMPLATE_VERSION + '/' + PUBLIC_RESPONSE_VERSION) +
    '/' +
    group +
    '/' +
    encodeURIComponent(version) +
    (group === 'pointer' ? '/' : url.pathname);
  url.search = '';
  return new Request(url, { method: 'GET' });
}
export async function cacheRead(key: Request): Promise<Response | undefined> {
  try {
    return await caches.default.match(key);
  } catch {
    return undefined;
  }
}
export function cacheWrite(
  ctx: ExecutionContext,
  key: Request,
  response: Response,
  seconds: number,
): void {
  if (response.status !== 200) return;
  const copy = response.clone();
  const headers = new Headers(copy.headers);
  headers.set(
    'X-CloudInk-Client-Cache-Control',
    headers.get('Cache-Control') || 'public, max-age=0, must-revalidate',
  );
  headers.set('Cache-Control', 'public, max-age=' + seconds);
  headers.delete('Vary');
  headers.delete('Set-Cookie');
  ctx.waitUntil(caches.default.put(key, new Response(copy.body, { headers })).catch(() => {}));
}
export function clientResponse(response: Response, request: Request, hit = false): Response {
  const headers = new Headers(response.headers);
  const clientPolicy = headers.get('X-CloudInk-Client-Cache-Control');
  if (clientPolicy) headers.set('Cache-Control', clientPolicy);
  headers.delete('X-CloudInk-Client-Cache-Control');
  headers.set('Cache-Status', hit ? 'CloudInk; hit' : 'CloudInk; fwd=uri-miss');
  if (
    request.headers
      .get('If-None-Match')
      ?.split(',')
      .some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === headers.get('ETag'))
  )
    return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    headers,
  });
}
export async function invalidatePointer(request: Request): Promise<void> {
  try {
    await caches.default.delete(cacheKey(request, 'pointer'));
  } catch {
    /* TTL bounds other data centers to 30 seconds. */
  }
}

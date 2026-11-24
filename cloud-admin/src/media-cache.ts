// Scope public media entries to their serving origin and media format.
export function mediaCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = '/__cloudink_cache/media-v1/image/' + url.pathname;
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

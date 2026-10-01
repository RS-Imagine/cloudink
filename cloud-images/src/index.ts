export type ImagesBindings = { [K in keyof ImagesEnv]: ImagesEnv[K] extends string ? string : ImagesEnv[K] };
export default {
  async fetch(request: Request, env: ImagesBindings): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    let allowed: string[];
    try { allowed = JSON.parse(env.ALLOWED_ORIGINS); } catch { return new Response('Image hosting is not configured', { status: 503 }); }
    let referrer = '';
    try { referrer = new URL(request.headers.get('Referer') || '').origin; } catch { /* A missing/invalid referrer is not allowed. */ }
    if (!allowed.includes(referrer)) return new Response('Forbidden', { status: 403 });
    let key: string;
    try { key = decodeURIComponent(new URL(request.url).pathname.slice(1)); } catch { return new Response('Invalid image path', { status: 400 }); }
    if (!key || key.length > 1024 || key.split('/').some(part => !part || part === '..' || part === '.') || key.includes('\\')) return new Response('Invalid image path', { status: 400 });
    const body = request.method === 'GET' ? await env.IMAGES.get(key) : null;
    const object = request.method === 'HEAD' ? await env.IMAGES.head(key) : body;
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'public, max-age=86400', Vary: 'Referer' });
    object.writeHttpMetadata(headers);
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(headers.get('Content-Type') || '')) {
      if (body) await body.body.cancel();
      return new Response('Unsupported image', { status: 415 });
    }
    headers.set('ETag', object.httpEtag);
    const validators = request.headers.get('If-None-Match')?.split(',').map(x => x.trim().replace(/^W\//, ''));
    if (validators?.some(x => x === '*' || x === object.httpEtag)) {
      if (body) await body.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    return new Response(body?.body || null, { headers });
  }
} satisfies ExportedHandler<ImagesBindings>;

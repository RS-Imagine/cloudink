import admin from '../../cloud-admin/src/index';
import { publicImage } from '../../cloud-admin/src/media';
import type { CloudInkEnv } from '../../cloud-admin/src/env';
import { publicType, sanitizePublicHtml } from '../../cloud-admin/src/browser-publishing';

export type WebBindings = CloudInkEnv;
const editorAssets = new Set([
  '/app.js',
  '/style.css',
  '/preview.worker.js',
  '/blog_wasm.js',
  '/blog_wasm_bg.wasm',
]);
const compiledAssets = new Set(['/client.js', '/theme.js', '/styles.css', '/favicon.svg']);
function protect(response: Response, analytics = false): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  // Blog HTML shares an origin with the editor. Only compiled local scripts may
  // execute; uploaded HTML is sanitized and arbitrary assets are never scripts.
  const analyticsScripts = analytics ? ' https://www.clarity.ms https://scripts.clarity.ms' : '';
  const analyticsConnections = analytics ? ' https://*.clarity.ms' : '';
  headers.set(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'${analyticsScripts}; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self'${analyticsConnections}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  return new Response(response.body, { status: response.status, headers });
}
async function staticAsset(
  request: Request,
  env: WebBindings,
  path: string,
  status = 200,
  analytics = false,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = path;
  let response = await env.ASSETS.fetch(new Request(url, request));
  if (request.method !== 'HEAD' && response.headers.get('Content-Type')?.includes('text/html')) {
    response = new Response(await sanitizePublicHtml(await response.text()), {
      status,
      headers: response.headers,
    });
  } else if (status !== 200)
    response = new Response(response.body, { status, headers: response.headers });
  return protect(response, analytics);
}
function publicPath(path: string): string | null {
  if (path === '/' || path === '/index.html') return 'index.html';
  if (['/404.html', '/search_index.json', '/_release.json'].includes(path)) return path.slice(1);
  if (/^\/about(?:\/|\/index.html)?$/.test(path)) return 'about/index.html';
  const post = path.match(/^\/posts\/([A-Za-z0-9_-]{1,100})(?:\/|\/index.html)?$/);
  if (post) return `posts/${post[1]}/index.html`;
  return null;
}
export default {
  async fetch(request: Request, env: WebBindings): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === '/admin' || path === '/admin/') {
        if (!['GET', 'HEAD'].includes(request.method))
          return protect(new Response('Method not allowed', { status: 405 }));
        url.pathname = '/';
        const response = await admin.fetch(
          new Request(url, { method: 'GET', headers: request.headers }),
          env,
        );
        return request.method === 'HEAD' ? new Response(null, response) : response;
      }
      if (path.startsWith('/api/') || editorAssets.has(path)) return admin.fetch(request, env);
      if (path.startsWith('/images/')) return publicImage(request, env.STORAGE);
      if (!['GET', 'HEAD'].includes(request.method))
        return protect(
          new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }),
        );
      if (compiledAssets.has(path)) return staticAsset(request, env, path);
      const key = publicPath(path);
      const pointer = await env.STORAGE.get('state/published.json');
      const published = pointer ? await pointer.json<{ id: string; clarityId?: string }>() : null;
      const id = published?.id || null;
      const clarityId = published?.clarityId || '';
      const analytics = /^[A-Za-z0-9]{1,64}$/.test(clarityId);
      if (path === '/analytics.js') {
        const script = analytics
          ? `window.clarity=window.clarity||function(){(window.clarity.q=window.clarity.q||[]).push(arguments)};const s=document.createElement('script');s.async=true;s.src="https://www.clarity.ms/tag/"+${JSON.stringify(clarityId)};document.head.append(s);`
          : '/* Analytics is disabled. */';
        return protect(
          new Response(request.method === 'HEAD' ? null : script, {
            headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
          }),
          analytics,
        );
      }
      if (key && id) {
        const body =
          request.method === 'HEAD' ? null : await env.STORAGE.get(`public/${id}/${key}`);
        const object =
          request.method === 'HEAD' ? await env.STORAGE.head(`public/${id}/${key}`) : body;
        if (object) {
          const headers = new Headers({ 'Content-Type': publicType(key), ETag: object.httpEtag });
          if (
            request.headers
              .get('If-None-Match')
              ?.split(',')
              .some(
                (tag) => tag.trim().replace(/^W\//, '') === object.httpEtag || tag.trim() === '*',
              )
          ) {
            if (body) await body.body.cancel();
            return protect(new Response(null, { status: 304, headers }), analytics);
          }
          return protect(
            new Response(body?.body || null, { status: key === '404.html' ? 404 : 200, headers }),
            analytics,
          );
        }
        // Initial login seeds private content but doesn't publish any pages.
        // Once a public index exists, absent routes must stay absent.
        if (await env.STORAGE.head(`public/${id}/index.html`)) {
          const missing = await env.STORAGE.get(`public/${id}/404.html`);
          return protect(
            new Response(request.method === 'HEAD' ? null : missing?.body || 'Not found', {
              status: 404,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }),
            analytics,
          );
        }
      }
      if (key === '_release.json')
        return protect(
          new Response(request.method === 'HEAD' ? null : JSON.stringify({ id }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      if (key === 'index.html') return staticAsset(request, env, '/');
      if (key === 'about/index.html') return staticAsset(request, env, '/about/');
      if (key === 'search_index.json') return staticAsset(request, env, '/search_index.json');
      return staticAsset(request, env, '/404.html', 404, analytics);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'web_request_failed',
          type: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return protect(
        new Response('服务暂时不可用，请检查 Cloudflare 配置后重试。', { status: 503 }),
      );
    }
  },
} satisfies ExportedHandler<WebBindings>;

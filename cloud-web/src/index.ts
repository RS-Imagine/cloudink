import admin from '../../cloud-admin/src/index';
import images from '../../cloud-images/src/index';
import type { CloudInkEnv } from '../../cloud-admin/src/env';
import { publicType, sanitizePublicHtml } from '../../cloud-admin/src/browser-publishing';

export type WebBindings = { [K in keyof WebEnv]: WebEnv[K] extends string ? string : WebEnv[K] };
const editorAssets = new Set(['/app.js', '/style.css', '/preview.worker.js', '/blog_wasm.js', '/blog_wasm_bg.wasm']);
const compiledAssets = new Set(['/client.js', '/theme.js', '/styles.css', '/favicon.svg']);
function adminEnv(request: Request, env: WebBindings): CloudInkEnv {
  const site = new URL(request.url).origin;
  return { CONTENT: env.CONTENT, IMAGES: env.IMAGES, LOGIN_LIMITER: env.LOGIN_LIMITER,
    OWNER_EMAIL: env.OWNER_EMAIL.trim().toLowerCase(), SITE_URL: site, IMAGE_ORIGIN: `${site}/images`,
    SITE_WORKER_NAME: new URL(site).hostname.split('.')[0], PRODUCTION_BRANCH: 'master', FOOTER_TEXT: '', CLARITY_ID: '',
    BUILD_TOKEN: '', SETUP_TOKEN: '', WORKERS_BUILD_TOKEN: '', WORKERS_DEPLOY_HOOK: '',
    browserPublishing: true, initialPassword: env.INITIAL_PASSWORD };
}
function protect(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  // Blog HTML shares an origin with the editor. Only compiled local scripts may
  // execute; uploaded HTML is sanitized and arbitrary assets are never scripts.
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  return new Response(response.body, { status: response.status, headers });
}
async function staticAsset(request: Request, env: WebBindings, path: string, status = 200): Promise<Response> {
  const url = new URL(request.url); url.pathname = path;
  let response = await env.ASSETS.fetch(new Request(url, request));
  if (request.method !== 'HEAD' && response.headers.get('Content-Type')?.includes('text/html')) {
    response = new Response(await sanitizePublicHtml(await response.text()), { status, headers: response.headers });
  } else if (status !== 200) response = new Response(response.body, { status, headers: response.headers });
  return protect(response);
}
function publicPath(path: string): string | null {
  if (path === '/' || path === '/index.html') return 'index.html';
  if (['/404.html', '/search_index.json', '/_release.json'].includes(path)) return path.slice(1);
  if (/^\/about(?:\/|\/index.html)?$/.test(path)) return 'about/index.html';
  const post = path.match(/^\/posts\/([A-Za-z0-9_-]{1,100})(?:\/|\/index.html)?$/);
  if (post) return `posts/${post[1]}/index.html`;
  if (/^\/(?:assets|fonts)\/[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').slice(1).some(p => !p || p === '.' || p === '..')) return path.slice(1);
  return null;
}
export default {
  async fetch(request: Request, env: WebBindings): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (path === '/admin' || path === '/admin/') {
        if (!['GET', 'HEAD'].includes(request.method)) return protect(new Response('Method not allowed', { status: 405 }));
        url.pathname = '/';
        const response = await admin.fetch(new Request(url, { method: 'GET', headers: request.headers }), adminEnv(request, env));
        return request.method === 'HEAD' ? new Response(null, response) : response;
      }
      if (path.startsWith('/api/') || editorAssets.has(path)) return admin.fetch(request, adminEnv(request, env));
      if (path.startsWith('/internal/')) return protect(new Response('Not found', { status: 404 }));
      if (path.startsWith('/images/')) {
        url.pathname = path.slice('/images'.length);
        return images.fetch(new Request(url, request), { IMAGES: env.IMAGES, ALLOWED_ORIGINS: JSON.stringify([url.origin]) });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return protect(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }));
      if (compiledAssets.has(path)) return staticAsset(request, env, path);
      const key = publicPath(path);
      const pointer = await env.CONTENT.get('state/published.json');
      const id = pointer ? (await pointer.json<{ id: string }>()).id : null;
      if (key && id) {
        const body = request.method === 'HEAD' ? null : await env.CONTENT.get(`public/${id}/${key}`);
        const object = request.method === 'HEAD' ? await env.CONTENT.head(`public/${id}/${key}`) : body;
        if (object) {
          const headers = new Headers({ 'Content-Type': publicType(key), ETag: object.httpEtag });
          if (request.headers.get('If-None-Match')?.split(',').some(tag => tag.trim().replace(/^W\//, '') === object.httpEtag || tag.trim() === '*')) {
            if (body) await body.body.cancel();
            return protect(new Response(null, { status: 304, headers }));
          }
          return protect(new Response(body?.body || null, { status: key === '404.html' ? 404 : 200, headers }));
        }
        // Initial login seeds private content but doesn't publish any pages.
        // Once a public index exists, absent routes must stay absent.
        if (await env.CONTENT.head(`public/${id}/index.html`)) {
          const missing = await env.CONTENT.get(`public/${id}/404.html`);
          return protect(new Response(request.method === 'HEAD' ? null : missing?.body || 'Not found', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
        }
      }
      if (key === '_release.json') return protect(new Response(request.method === 'HEAD' ? null : JSON.stringify({ id }), { headers: { 'Content-Type': 'application/json' } }));
      if (key === 'index.html') return staticAsset(request, env, '/');
      if (key === 'about/index.html') return staticAsset(request, env, '/about/');
      if (key === 'search_index.json') return staticAsset(request, env, '/search_index.json');
      return staticAsset(request, env, '/404.html', 404);
    } catch (error) {
      console.error(JSON.stringify({ event: 'web_request_failed', type: error instanceof Error ? error.name : 'unknown' }));
      return protect(new Response('服务暂时不可用，请检查 Cloudflare 配置后重试。', { status: 503 }));
    }
  }
} satisfies ExportedHandler<WebBindings>;

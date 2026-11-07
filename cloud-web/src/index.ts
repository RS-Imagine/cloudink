import { storageStats } from '../../cloud-admin/src/request-stats';
import { maintainStorage } from '../../cloud-admin/src/maintenance';
import { cacheKey, cacheRead, cacheWrite, clientResponse, invalidatePointer } from './cache';
import { readerHtml, readerEtag, discovery } from './reader';
import admin from '../../cloud-admin/src/index';
import { publicSiteIcon } from '../../cloud-admin/src/site-icons';
import { publicImage } from '../../cloud-admin/src/media';
import type { CloudInkEnv } from '../../cloud-admin/src/env';
import { publicType, sanitizePublicHtml } from '../../cloud-admin/src/browser-publishing';

export type WebBindings = CloudInkEnv;
const editorAssets = new Set([
  '/publication.js',
  '/home-illustration.js',
  '/post-address.js',
  '/editorial-botanical.svg',
  '/editorial-botanical.webp',
  '/image.worker.js',
  '/image-maintenance.js',
  '/admin-theme.js',
  '/app.js',
  '/style.css',
  '/preview.worker.js',
  '/blog_wasm.js',
  '/blog_wasm_bg.wasm',
]);
const compiledAssets = new Set([
  '/client.js',
  '/theme.js',
  '/styles.css',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/sw.js',
]);
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
  const assetRequest = new Request(url, request);
  if (path === '/' || path.endsWith('/') || path.endsWith('.html'))
    assetRequest.headers.delete('If-None-Match');
  let response = await env.ASSETS.fetch(assetRequest);
  if (request.method !== 'HEAD' && response.headers.get('Content-Type')?.includes('text/html')) {
    response = new Response(await sanitizePublicHtml(await response.text()), {
      status,
      headers: response.headers,
    });
  } else if (status !== 200)
    response = new Response(response.body, { status, headers: response.headers });
  return protect(await readerHtml(response, new URL(request.url)), analytics);
}
function publicPath(path: string): string | null {
  if (path === '/' || path === '/index.html') return 'index.html';
  if (['/404.html', '/search_index.json', '/_release.json'].includes(path)) return path.slice(1);
  if (/^\/about(?:\/|\/index.html)?$/.test(path)) return 'about/index.html';
  if (/^\/archive(?:\/|\/index.html)?$/.test(path)) return 'archive/index.html';
  if (/^\/shorts(?:\/|\/index.html)?$/.test(path)) return 'shorts/index.html';
  const post = path.match(/^\/posts\/([A-Za-z0-9_-]{1,100})(?:\/|\/index.html)?$/);
  if (post) return `posts/${post[1]}/index.html`;
  return null;
}
const web = {
  async fetch(request: Request, env: WebBindings, ctx: ExecutionContext): Promise<Response> {
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
      if (path.startsWith('/api/') || editorAssets.has(path)) {
        const response = await admin.fetch(request, env, ctx);
        if (
          request.method === 'POST' &&
          /\/api\/publish\/[a-f0-9-]{36}\/commit$/.test(path) &&
          response.ok
        )
          await invalidatePointer(request);
        return response;
      }
      if (path.startsWith('/images/')) return publicImage(request, env.STORAGE, ctx);
      if (path.startsWith('/site-icon/')) return publicSiteIcon(request, env.STORAGE, ctx);
      if (!['GET', 'HEAD'].includes(request.method))
        return protect(
          new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }),
        );
      if (
        compiledAssets.has(path) ||
        /^\/reader-assets\/(?:highlight\.js|katex\.css|code\.css|editorial-font\.css|(?:katex|highlight|editorial-font)-LICENSE\.txt|fonts\/(?:KaTeX_[A-Za-z0-9_-]+|noto-serif-sc-[a-z0-9-]+)\.woff2)$/.test(
          path,
        )
      )
        return staticAsset(request, env, path);
      const key = publicPath(path);
      const pointerKey = cacheKey(request, 'pointer');
      const cachedPointer = await cacheRead(pointerKey);
      const pointer = cachedPointer || (await env.STORAGE.get('state/published.json'));
      const published = pointer
        ? await pointer.json<{
            id: string;
            clarityId?: string;
            postRedirects?: Record<string, string>;
            pages?: Record<string, string>;
          }>()
        : null;
      if (!cachedPointer && published) cacheWrite(ctx, pointerKey, Response.json(published), 30);
      const id = published?.id || null;
      const pageVersion =
        key && published?.pages?.[key]
          ? published.pages[key] + ':' + (published.clarityId || '')
          : id || 'initial';
      const pageKey = cacheKey(request, 'page', pageVersion);
      const cached = await cacheRead(pageKey);
      if (cached)
        return protect(
          clientResponse(cached, request, true),
          /^[A-Za-z0-9]{1,64}$/.test(published?.clarityId || ''),
        );
      const clarityId = published?.clarityId || '';
      const analytics = /^[A-Za-z0-9]{1,64}$/.test(clarityId);
      if (path === '/robots.txt' || path === '/sitemap.xml' || path === '/feed.xml') {
        const response = await discovery(
          new Request(request, { method: 'GET', headers: {} }),
          env.STORAGE,
          id,
          published?.pages,
        );
        cacheWrite(ctx, pageKey, response, 300);
        return clientResponse(response, request);
      }
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
        const from = key.match(/^posts\/([A-Za-z0-9_-]{1,100})\/index\.html$/)?.[1];
        const redirects = published?.postRedirects;
        const target = from && redirects && Object.hasOwn(redirects, from) ? redirects[from] : null;
        if (target && target !== from && /^[A-Za-z0-9_-]{1,100}$/.test(target)) {
          url.pathname = '/posts/' + target + '/';
          return protect(Response.redirect(url.toString(), 301), analytics);
        }
        const storageKey = published?.pages
          ? published.pages[key]
            ? 'public/content/' + published.pages[key]
            : null
          : `public/${id}/${key}`;
        const body =
          request.method === 'HEAD' || !storageKey ? null : await env.STORAGE.get(storageKey);
        const object =
          request.method === 'HEAD' && storageKey ? await env.STORAGE.head(storageKey) : body;
        if (object) {
          const etag = key.endsWith('.html')
            ? await readerEtag(object.httpEtag, url)
            : object.httpEtag;
          const headers = new Headers({ 'Content-Type': publicType(key), ETag: etag });
          if (
            request.method === 'HEAD' &&
            request.headers
              .get('If-None-Match')
              ?.split(',')
              .some((tag) => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*')
          ) {
            if (body) await body.body.cancel();
            return protect(new Response(null, { status: 304, headers }), analytics);
          }
          const response = protect(
            await readerHtml(
              new Response(body?.body || null, { status: key === '404.html' ? 404 : 200, headers }),
              url,
              analytics,
            ),
            analytics,
          );
          if (request.method === 'GET') cacheWrite(ctx, pageKey, response, 300);
          return clientResponse(response, request);
        }
        // Initial login seeds private content but doesn't publish any pages.
        // Once a public index exists, absent routes must stay absent.
        if (
          published?.pages?.['index.html'] ||
          (!published?.pages && (await env.STORAGE.head(`public/${id}/index.html`)))
        ) {
          const missingKey = published?.pages
            ? published.pages['404.html']
              ? 'public/content/' + published.pages['404.html']
              : null
            : `public/${id}/404.html`;
          const missing = missingKey ? await env.STORAGE.get(missingKey) : null;
          return protect(
            await readerHtml(
              new Response(request.method === 'HEAD' ? null : missing?.body || 'Not found', {
                status: 404,
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
              }),
              url,
            ),
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
      if (key === 'shorts/index.html') return staticAsset(request, env, '/shorts/');
      if (key === 'search_index.json') return staticAsset(request, env, '/search_index.json');
      if (key?.startsWith('posts/')) return staticAsset(request, env, path);
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
  async scheduled(
    _event: ScheduledController,
    env: WebBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      maintainStorage(env).catch((error) => {
        console.error(
          JSON.stringify({
            event: 'storage_maintenance_failed',
            type: error instanceof Error ? error.name : 'unknown',
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<WebBindings>;

export default {
  async fetch(request: Request, env: WebBindings, ctx: ExecutionContext): Promise<Response> {
    const stats = storageStats(env.STORAGE),
      started = Date.now(),
      id = crypto.randomUUID();
    const response = await web.fetch(request, { ...env, STORAGE: stats.bucket }, ctx);
    const route = new URL(request.url).pathname
      .split('/')
      .slice(0, 3)
      .join('/')
      .replace(/\/[A-Za-z0-9_-]{20,}/g, '/:id');
    stats.report(id, route, request.method, response.status, started);
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', id);
    return new Response(response.body, { status: response.status, headers });
  },
  scheduled: web.scheduled,
} satisfies ExportedHandler<WebBindings>;

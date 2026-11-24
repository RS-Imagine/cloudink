import { storageStats } from '../../cloud-admin/src/request-stats';
import { maintainStorage } from '../../cloud-admin/src/maintenance';
import { cacheKey, cacheRead, cacheWrite, clientResponse, invalidatePointer } from './cache';
import { readerHtml, readerEtag } from './reader';
import admin from '../../cloud-admin/src/index';
import { publicSiteIcon } from '../../cloud-admin/src/site-icons';
import { publicImage } from '../../cloud-admin/src/media';
import type { CloudInkEnv } from '../../cloud-admin/src/env';
import { publicType, sanitizePublicHtml } from '../../cloud-admin/src/browser-publishing';
import { siteIconDerivedKeys } from '../../cloud-admin/src/models';
import { PUBLIC_RESPONSE_VERSION } from '../../cloud-admin/src/assets.generated';
import { CURRENT_TEMPLATE_VERSION } from '../../cloud-admin/src/template-version.generated';
import RustReaderWorker from '../../build-work/reader-worker/index.js';

export type WebBindings = CloudInkEnv;
type RenderDiscovery = (
  path: string,
  origin: string,
  storage: R2Bucket,
  release: string | null,
  pages: Record<string, string> | undefined,
) => Promise<Response>;
const editorAssets = new Set([
  '/writing-illustration.svg',
  '/backup.js',
  '/publication.js',
  '/home-illustration.js',
  '/post-address.js',
  '/editorial-botanical.svg',
  '/editorial-botanical.webp',
  '/image.worker.js',
  '/image-maintenance.js',
  '/admin-theme.js',
  '/app.js',
  '/shorts.js',
  '/images.js',
  '/editor-tools.js',
  '/markdown-import.js',
  '/preview.js',
  '/image-upload.js',
  '/style.css',
  '/preview.worker.js',
  '/preview-highlight.js',
  '/blog_wasm.js',
  '/blog_wasm_bg.wasm',
]);
const READER_BUNDLES = new Set(['/client.js', '/theme.js', '/styles.css']);
const POINTER_TTL = 30;
const PAGE_TTL = 604800;
const DISCOVERY_TTL = 3600;
const REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const HTML_CACHE_CONTROL = REVALIDATE_CACHE_CONTROL;
const ASSET_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
function protect(
  response: Response,
  analytics = false,
  cacheControl = REVALIDATE_CACHE_CONTROL,
): Response {
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
  headers.set('Cache-Control', cacheControl);
  return new Response(response.body, { status: response.status, headers });
}
async function staticAsset(
  request: Request,
  env: WebBindings,
  path: string,
  status = 200,
  analytics = false,
  cacheControl = REVALIDATE_CACHE_CONTROL,
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
  return protect(
    await readerHtml(response, new URL(request.url)),
    analytics,
    status === 200 ? cacheControl : REVALIDATE_CACHE_CONTROL,
  );
}
function publicPath(path: string): string | null {
  if (path === '/' || path === '/index.html') return 'index.html';
  if (['/404.html', '/search_index.json', '/_release.json', '/manifest.webmanifest'].includes(path))
    return path.slice(1);
  if (/^\/about(?:\/|\/index.html)?$/.test(path)) return 'about/index.html';
  if (/^\/post(?:\/|\/index.html)?$/.test(path)) return 'post/index.html';
  const postListPage = path.match(/^\/post\/page\/([1-9]\d*)(?:\/|\/index.html)?$/);
  if (postListPage && Number(postListPage[1]) >= 2)
    return `post/page/${postListPage[1]}/index.html`;
  if (/^\/archive(?:\/|\/index.html)?$/.test(path)) return 'archive/index.html';
  if (/^\/shorts(?:\/|\/index.html)?$/.test(path)) return 'shorts/index.html';
  const shortsListPage = path.match(/^\/shorts\/page\/([1-9]\d*)(?:\/|\/index.html)?$/);
  if (shortsListPage) {
    const pageNum = Number(shortsListPage[1]);
    if (pageNum === 1) return 'shorts/index.html';
    if (pageNum >= 2) return `shorts/page/${pageNum}/index.html`;
  }
  const post = path.match(/^\/posts\/([A-Za-z0-9_-]{1,100})(?:\/|\/index.html)?$/);
  if (post) return `posts/${post[1]}/index.html`;
  return null;
}
const web = {
  async fetch(
    request: Request,
    env: WebBindings,
    ctx: ExecutionContext,
    renderDiscovery: RenderDiscovery,
  ): Promise<Response> {
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
      if (path === '/sw.js' || READER_BUNDLES.has(path))
        return staticAsset(request, env, path, 200, false, REVALIDATE_CACHE_CONTROL);
      if (
        path === '/favicon.svg' ||
        /^\/reader-assets\/(?:highlight\.js|share-card\.js|katex\.css|code\.css|editorial-font\.css|(?:katex|highlight|editorial-font)-LICENSE\.txt|fonts\/(?:KaTeX_[A-Za-z0-9_-]+|noto-serif(?:-sc)?-[a-z0-9-]+)\.woff2)$/.test(
          path,
        )
      ) {
        const policy = /^\/reader-assets\/fonts\/.+\.woff2$/.test(path)
          ? IMMUTABLE_CACHE_CONTROL
          : ASSET_CACHE_CONTROL;
        return staticAsset(request, env, path, 200, false, policy);
      }
      if (/^\/shorts\/page\/1(?:\/|\/index\.html)?$/.test(path)) {
        const canonical = new URL(url);
        canonical.pathname = '/shorts/';
        return protect(Response.redirect(canonical.toString(), 301));
      }
      const key = publicPath(path);
      const pointerKey = cacheKey(request, 'pointer');
      const cachedPointer = await cacheRead(pointerKey);
      const pointer = cachedPointer || (await env.STORAGE.get('state/published.json'));
      const published = pointer
        ? await pointer.json<{
            id: string;
            clarityId?: string;
            siteIcon?: string;
            siteIconSize?: number;
            postRedirects?: Record<string, string>;
            pages?: Record<string, string>;
          }>()
        : null;
      if (published && published.siteIcon === undefined && published.id) {
        const legacy = await env.STORAGE.get(`releases/${published.id}.posts.json`);
        if (legacy) {
          try {
            const data = await legacy.json<{
              site?: { siteIcon?: string; siteIconSize?: number };
            }>();
            published.siteIcon = data.site?.siteIcon || '';
            if (data.site?.siteIconSize) published.siteIconSize = data.site.siteIconSize;
          } catch {
            published.siteIcon = '';
          }
        } else {
          published.siteIcon = '';
        }
      }
      if (!cachedPointer && published)
        cacheWrite(ctx, pointerKey, Response.json(published), POINTER_TTL);
      if (path === '/favicon.ico') {
        const derived = siteIconDerivedKeys(published?.siteIcon || '');
        const target = derived
          ? '/site-icon/' + derived.faviconIco.slice('uploads/icons/'.length)
          : '/favicon.svg';
        const redirect = new URL(target, url.origin);
        return protect(
          new Response(null, {
            status: 302,
            headers: { Location: redirect.pathname },
          }),
          false,
          ASSET_CACHE_CONTROL,
        );
      }
      const id = published?.id || null;
      const siteIcon = published?.siteIcon || '';
      const pageVersion =
        key && published?.pages?.[key]
          ? published.pages[key] + ':' + (published.clarityId || '') + ':' + siteIcon
          : (id || 'initial') + ':' + siteIcon;
      const pageKey = cacheKey(request, 'page', pageVersion);
      const cached = await cacheRead(pageKey);
      if (cached) {
        const client = clientResponse(cached, request, true);
        return protect(
          client,
          /^[A-Za-z0-9]{1,64}$/.test(published?.clarityId || ''),
          client.headers.get('Cache-Control') || HTML_CACHE_CONTROL,
        );
      }
      const clarityId = published?.clarityId || '';
      const analytics = /^[A-Za-z0-9]{1,64}$/.test(clarityId);
      if (path === '/robots.txt' || path === '/sitemap.xml' || path === '/feed.xml') {
        const response = await renderDiscovery(path, url.origin, env.STORAGE, id, published?.pages);
        cacheWrite(ctx, pageKey, response, DISCOVERY_TTL);
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
          ASSET_CACHE_CONTROL,
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
            ? await readerEtag(object.httpEtag, url, siteIcon)
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
              siteIcon,
            ),
            analytics,
            key === '404.html'
              ? REVALIDATE_CACHE_CONTROL
              : key === 'manifest.webmanifest'
                ? ASSET_CACHE_CONTROL
                : HTML_CACHE_CONTROL,
          );
          if (request.method === 'GET') cacheWrite(ctx, pageKey, response, PAGE_TTL);
          return clientResponse(response, request);
        }
        if (key === 'manifest.webmanifest')
          return staticAsset(
            request,
            env,
            '/manifest.webmanifest',
            200,
            false,
            ASSET_CACHE_CONTROL,
          );
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
              analytics,
              siteIcon,
            ),
            analytics,
          );
        }
      }
      if (key === 'manifest.webmanifest')
        return staticAsset(request, env, '/manifest.webmanifest', 200, false, ASSET_CACHE_CONTROL);
      if (key === '_release.json')
        return protect(
          new Response(request.method === 'HEAD' ? null : JSON.stringify({ id }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      if (key === 'index.html')
        return staticAsset(request, env, '/', 200, false, HTML_CACHE_CONTROL);
      if (key === 'about/index.html')
        return staticAsset(request, env, '/about/', 200, false, HTML_CACHE_CONTROL);
      if (key === 'post/index.html')
        return staticAsset(request, env, '/post/', 200, false, HTML_CACHE_CONTROL);
      if (key === 'shorts/index.html')
        return staticAsset(request, env, '/shorts/', 200, false, HTML_CACHE_CONTROL);
      if (key && /^shorts\/page\/[1-9]\d*\/index\.html$/.test(key))
        return staticAsset(
          request,
          env,
          '/' + key.replace(/index\.html$/, ''),
          200,
          false,
          HTML_CACHE_CONTROL,
        );
      if (key === 'search_index.json')
        return staticAsset(request, env, '/search_index.json', 200, false, HTML_CACHE_CONTROL);
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
};

export default class CloudInkWorker extends RustReaderWorker {
  async fetch(request: Request): Promise<Response> {
    const { env, ctx } = this;
    const stats = storageStats(env.STORAGE),
      started = Date.now(),
      id = crypto.randomUUID();
    const response = await web.fetch(
      request,
      { ...env, STORAGE: stats.bucket },
      ctx,
      (path, origin, storage, release, pages) =>
        this.discovery_response(
          path,
          origin,
          storage,
          release,
          pages,
          CURRENT_TEMPLATE_VERSION,
          PUBLIC_RESPONSE_VERSION,
        ),
    );
    const route = new URL(request.url).pathname
      .split('/')
      .slice(0, 3)
      .join('/')
      .replace(/\/[A-Za-z0-9_-]{20,}/g, '/:id');
    stats.report(id, route, request.method, response.status, started);
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', id);
    return new Response(response.body, { status: response.status, headers });
  }

  scheduled(event: ScheduledController): Promise<void> {
    return web.scheduled(event, this.env, this.ctx);
  }
}

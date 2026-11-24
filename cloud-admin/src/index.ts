import type { BrowserPointer } from './browser-publishing';
import { backupJobRoute } from './backup-jobs';
import type { MaintenanceStatus } from './maintenance';
import type { InspectedSiteIcon } from './settings';
import { CURRENT_TEMPLATE_VERSION } from './template-version.generated';
import type { CloudInkEnv } from './env';
import { ASSETS } from './assets.generated';
import { Buffer } from 'node:buffer';
import { authRoute, requireSession, type Session } from './auth';
import { HttpError, json, limitedBody, readJson, type SiteConfig } from './models';

import { backupRoute } from './backup';
import { changesContentReferences, withContentMutation } from './storage-mutations';
type AdminEnv = CloudInkEnv & {
  maintainStorage(storage: R2Bucket): Promise<MaintenanceStatus>;
  siteSettings(request: Request, storage: R2Bucket): Promise<Response>;
  imageRequest(request: Request, storage: R2Bucket): Promise<Response>;
  contentRequest(request: Request, storage: R2Bucket, session: Session): Promise<Response>;
  inspectSiteIcon(bytes: Uint8Array): Promise<InspectedSiteIcon>;
};

async function apiRoute(
  request: Request,
  env: AdminEnv,
  path: string,
  session: Session,
): Promise<Response> {
  if (path === '/api/maintenance' && request.method === 'GET')
    return json(await readJson<MaintenanceStatus>(env.STORAGE, 'state/maintenance.json'));
  if (path === '/api/maintenance' && request.method === 'POST')
    return json({ maintenance: await env.maintainStorage(env.STORAGE) });
  if (
    (path === '/api/site-icon' || path === '/api/site-icon/derivatives') &&
    request.method === 'POST'
  )
    return env.siteSettings(request, env.STORAGE);
  if (
    path === '/api/images' ||
    ((path === '/api/images/optimize' || path === '/api/images/reindex') &&
      request.method === 'POST')
  )
    return env.imageRequest(request, env.STORAGE);
  const task = await backupJobRoute(request, env, path, session);
  if (task) return task;
  const backup = await backupRoute(request, env, path, env.inspectSiteIcon);
  if (backup) return backup;
  const browserPublish = path.match(/^\/api\/publish\/([a-f0-9-]{36})\/(file|plan|commit|cancel)$/);
  if (
    browserPublish ||
    (path === '/api/publish' && request.method === 'POST') ||
    (path === '/api/publish/status' && request.method === 'GET')
  )
    return env.contentRequest(request, env.STORAGE, session);
  const rename = path.match(/^\/api\/posts\/([A-Za-z0-9_-]+)\/rename$/);
  if (rename && request.method === 'POST') return env.contentRequest(request, env.STORAGE, session);
  if (
    ((path === '/api/posts' || path === '/api/shorts') && request.method === 'GET') ||
    /^\/api\/(?:posts|shorts)\/[A-Za-z0-9_-]+$/.test(path)
  )
    return env.contentRequest(request, env.STORAGE, session);
  if (
    (path === '/api/upload' && request.method === 'POST') ||
    (path === '/api/image' && request.method === 'GET')
  )
    return env.imageRequest(request, env.STORAGE);
  if (path === '/api/settings' && (request.method === 'GET' || request.method === 'PUT'))
    return env.siteSettings(request, env.STORAGE);
  if (path === '/api/export' && request.method === 'GET')
    throw new HttpError(410, '此导出接口已停用，请刷新后台并使用分批备份。');
  throw new HttpError(404, '接口不存在。');
}
function protect(response: Response, asset = false): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!asset) headers.set('Cache-Control', 'no-store');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob: https:; font-src 'self' https://cdn.jsdelivr.net; frame-src 'self' blob:; worker-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  return new Response(response.body, { status: response.status, headers });
}
export default {
  async fetch(request: Request, env: AdminEnv, ctx?: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/config' && request.method === 'GET') {
        const [account, draftSite, pointer] = await Promise.all([
          env.STORAGE.head('auth/account.json'),
          readJson<SiteConfig>(env.STORAGE, 'draft-site.json'),
          readJson<BrowserPointer>(env.STORAGE, 'state/published.json'),
        ]);
        const siteIcon = draftSite?.siteIcon ?? pointer?.siteIcon ?? '';
        const siteIconSize = draftSite?.siteIconSize ?? pointer?.siteIconSize ?? 0;
        return protect(
          json({
            siteUrl: new URL(request.url).origin,
            imageOrigin: `${new URL(request.url).origin}/images`,
            initialized: !!account,
            siteIcon,
            siteIconSize,
          }),
        );
      }
      if (request.method === 'GET' && Object.hasOwn(ASSETS, path)) {
        const asset = ASSETS[path];
        if (!asset) throw new HttpError(404, 'Not found');
        const headers = {
          'Content-Type': asset.type,
          ETag: asset.etag,
          'Cache-Control': path === '/' ? 'no-store' : 'public, max-age=0, must-revalidate',
        };
        const validators = request.headers
          .get('If-None-Match')
          ?.split(',')
          .map((tag) => tag.trim().replace(/^W\//, ''));
        if (path !== '/' && validators?.some((tag) => tag === asset.etag || tag === '*'))
          return protect(new Response(null, { status: 304, headers }), true);
        return protect(new Response(Buffer.from(asset.data, 'base64'), { headers }), true);
      }
      const auth = await authRoute(request, env, path);
      if (auth) return protect(auth);
      if (path.startsWith('/api/')) {
        const session = await requireSession(request, env);
        const route = (storage = env.STORAGE) =>
          apiRoute(request, { ...env, STORAGE: storage }, path, session);
        const response = changesContentReferences(path, request.method)
          ? withContentMutation(env.STORAGE, route)
          : route();
        if (changesContentReferences(path, request.method) || path === '/api/upload')
          ctx?.waitUntil(
            response.then(
              () => {},
              () => {},
            ),
          );
        return protect(await response);
      }
      throw new HttpError(404, '页面不存在。');
    } catch (e) {
      if (e instanceof HttpError) return protect(json({ error: e.message }, e.status));
      console.error(
        JSON.stringify({
          event: 'request_failed',
          route: new URL(request.url).pathname.replace(/\/[A-Za-z0-9_-]{20,}/g, '/:id'),
          method: request.method,
          type: e instanceof Error ? e.name : 'unknown',
        }),
      );
      return protect(json({ error: '操作未完成，请稍后重试。' }, 500));
    }
  },
} satisfies ExportedHandler<AdminEnv>;

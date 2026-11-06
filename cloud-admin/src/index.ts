import { buildPostIndex, readPostIndex } from './post-index';
import type { BrowserPointer } from './browser-publishing';
import { backupJobRoute } from './backup-jobs';
import { maintainStorage, type MaintenanceStatus } from './maintenance';
import { CURRENT_TEMPLATE_VERSION } from './template-version.generated';
import { ensureHomeIllustration } from './home-illustration';
import type { CloudInkEnv } from './env';
import {
  stageBrowserPage,
  commitBrowserPublish,
  cancelBrowserPublish,
  planBrowserPublish,
} from './browser-publishing';
import { ASSETS, PAGE_GENERATION_VERSION } from './assets.generated';
import { Buffer } from 'node:buffer';
import { authRoute, digest, requireSession, type Session } from './auth';
import { draftSummary } from './post-metadata';
import { assertWritableAddress, renameDraft } from './post-addresses';
import { currentRelease, publish, publishStatus } from './publishing';
import {
  HttpError,
  json,
  jsonInput,
  limitedBody,
  parseShortSource,
  parseSource,
  readJson,
  ownValue,
  serializeDraft,
  serializeShortDraft,
  validSlug,
  validateDraft,
  validateShortDraft,
  validateSite,
  type Draft,
  type ShortDraft,
  type SiteConfig,
} from './models';

import { ensureSiteIcon, uploadSiteIcon } from './site-icons';
import { backupRoute } from './backup';
import { validImageKey } from './media';
import { uploadImage, optimizeImage } from './image-variants';
import { imageLibraryRoute, ensureManagedImages, imageReferenceMetadata } from './image-library';
import { changesContentReferences, withContentMutation } from './storage-mutations';
async function listDrafts(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: 'drafts/',
      limit: 1000,
      include: ['customMetadata'],
      cursor,
    });
    objects.push(...page.objects);
    if (objects.length > 2000) throw new HttpError(413, '原稿超过 2000 篇，暂时无法完整读取列表。');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
async function saveDraft(request: Request, env: CloudInkEnv, slug: string): Promise<Response> {
  await assertWritableAddress(env.STORAGE, slug);
  const input = await jsonInput(request);
  let draft: Draft, source: string;
  if (typeof input.source === 'string') {
    source = input.source;
    draft = parseSource(source);
  } else {
    draft = validateDraft(input.draft);
    draft.front_matter.draft = true;
    source = serializeDraft(draft);
  }
  if (draft.front_matter.slug !== slug) throw new HttpError(400, '文章地址与保存地址不一致。');
  await ensureManagedImages(env.STORAGE, source, new URL(request.url).origin);
  const existing = await env.STORAGE.head(`drafts/${slug}.md`);
  if (existing && !existing.customMetadata?.deleted && input.etag !== existing.etag)
    throw new HttpError(409, '这篇文章在另一个窗口中发生了修改。请导出当前内容，再重新打开文章。');
  if ((!existing || existing.customMetadata?.deleted) && input.etag)
    throw new HttpError(409, '文章已删除或改址，请重新打开。');
  const saved = await env.STORAGE.put(`drafts/${slug}.md`, source, {
    onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' },
    customMetadata: await draftSummary(draft, env.STORAGE, existing?.customMetadata),
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  });
  if (!saved) throw new HttpError(409, '这篇文章刚刚发生了修改，请重新打开。');
  return json({
    draft,
    source,
    etag: saved.etag,
    saved_at: new Date().toISOString(),
    created: !existing || !!existing.customMetadata?.deleted,
  });
}
async function apiRoute(
  request: Request,
  env: CloudInkEnv,
  path: string,
  session: Session,
): Promise<Response> {
  if (path === '/api/maintenance' && request.method === 'GET')
    return json(await readJson<MaintenanceStatus>(env.STORAGE, 'state/maintenance.json'));
  if (path === '/api/maintenance' && request.method === 'POST')
    return json({ maintenance: await maintainStorage(env) });
  if (path === '/api/site-icon' && request.method === 'POST')
    return uploadSiteIcon(request, env.STORAGE);
  if (path === '/api/images/optimize' && request.method === 'POST')
    return optimizeImage(request, env.STORAGE);
  const images = await imageLibraryRoute(request, env, path);
  if (images) return images;
  const task = await backupJobRoute(request, env, path, session);
  if (task) return task;
  const backup = await backupRoute(request, env, path);
  if (backup) return backup;
  const browserPublish = path.match(/^\/api\/publish\/([a-f0-9-]{36})\/(file|plan|commit|cancel)$/);
  if (browserPublish) {
    const [, id, action] = browserPublish;
    if (action === 'plan' && request.method === 'POST') return planBrowserPublish(request, env, id);
    if (action === 'file' && request.method === 'PUT') return stageBrowserPage(request, env, id);
    if (action === 'commit' && request.method === 'POST')
      return commitBrowserPublish(env, id, request);
    if (action === 'cancel' && request.method === 'POST') return cancelBrowserPublish(env, id);
    throw new HttpError(405, '请求方式不正确。');
  }
  if (path === '/api/posts' && request.method === 'GET') {
    const pointer = await readJson<BrowserPointer>(env.STORAGE, 'state/published.json');
    if (!pointer) throw new HttpError(503, '网站内容尚未初始化。');
    const [publishing, drafts, savedSite, storedIndex] = await Promise.all([
      publishStatus(env, false, pointer),
      listDrafts(env.STORAGE),
      readJson<SiteConfig>(env.STORAGE, 'draft-site.json'),
      readPostIndex(env.STORAGE, pointer.id),
    ]);
    const index = storedIndex || (await buildPostIndex(await currentRelease(env, pointer)));
    const published = new Map(Object.entries(index.posts));
    const release = { id: pointer.id, site: index.site };
    const redirects = pointer?.postRedirects || {};
    const publicInitialized =
      !!pointer?.pages?.['index.html'] ||
      (!pointer?.pages && !!(await env.STORAGE.head(`public/${release.id}/index.html`)));
    const templateStatus = !publicInitialized
      ? 'unpublished'
      : pointer?.id === release.id &&
          pointer.templateVersion === CURRENT_TEMPLATE_VERSION &&
          pointer.generationVersion === PAGE_GENERATION_VERSION
        ? 'current'
        : 'outdated';
    const posts = new Map<
      string,
      {
        slug: string;
        title: string;
        date: string;
        description: string;
        aliases?: string[];
        draft?: boolean;
        published: boolean;
        has_draft: boolean;
        changed: boolean;
        updated?: string;
        etag?: string;
      }
    >();
    for (const [slug, p] of published)
      posts.set(slug, {
        title: p.title,
        slug,
        date: p.date,
        description: p.description,
        ...(p.updated ? { updated: p.updated } : {}),
        ...(p.aliases?.length ? { aliases: p.aliases } : {}),
        draft: p.draft,
        published: true,
        has_draft: false,
        changed: false,
      });
    for (const object of drafts) {
      if (object.customMetadata?.deleted) continue;
      const slug = object.key.slice(7, -3);
      if (Object.hasOwn(redirects, slug)) continue;
      const meta = object.customMetadata || {};
      posts.set(slug, {
        slug,
        title: meta.title || slug,
        date: meta.date || '',
        description: meta.description || '',
        published: published.has(slug),
        has_draft: true,
        changed: published.get(slug)?.digest !== meta.digest,
        etag: object.etag,
      });
    }
    const all = [...posts.values()].sort(
      (a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug),
    );
    const counts = {
      total: all.length,
      published: all.filter((p) => p.published).length,
      draft: all.filter((p) => !p.published).length,
    };
    const url = new URL(request.url),
      rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? all.length || 1 : Number(rawLimit);
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const filter = url.searchParams.get('filter') || 'all';
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      (rawLimit !== null && limit > 100) ||
      query.length > 300 ||
      !['all', 'published', 'draft'].includes(filter)
    )
      throw new HttpError(400, '文章列表分页参数不正确。');
    const selected = all.filter(
      (p) =>
        (!query || (p.title + ' ' + p.description + ' ' + p.slug).toLowerCase().includes(query)) &&
        (filter === 'all' || (filter === 'published' ? p.published : !p.published)),
    );
    const snapshot = await digest(
      JSON.stringify([pointer.id, drafts.map((d) => [d.key, d.etag]), query, filter]),
    );
    let offset = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor) {
      let decoded;
      try {
        decoded = JSON.parse(cursor);
      } catch {
        throw new HttpError(400, '分页位置不正确。');
      }
      if (!decoded || decoded.snapshot !== snapshot)
        throw new HttpError(409, '文章列表已变化，请重新读取。');
      if (
        !Number.isInteger(decoded.offset) ||
        decoded.offset < 0 ||
        decoded.offset > selected.length
      )
        throw new HttpError(400, '分页位置不正确。');
      offset = decoded.offset;
    }
    return json({
      posts: selected.slice(offset, offset + limit),
      counts,
      matching: selected.length,
      cursor:
        offset + limit < selected.length
          ? JSON.stringify({ snapshot, offset: offset + limit })
          : null,
      site: release.site,
      appearance: {
        themePalette: (savedSite || release.site).themePalette || 'ink',
        siteIcon: (savedSite || release.site).siteIcon || '',
        homeIllustration: (savedSite || release.site).homeIllustration || '',
      },
      publishing,
      email: session.email,
      csrf: session.csrf,
      publicInitialized,
      templateStatus,
    });
  }
  const rename = path.match(/^\/api\/posts\/([A-Za-z0-9_-]+)\/rename$/);
  if (rename && request.method === 'POST')
    return renameDraft(request, env, validSlug(rename[1]), await currentRelease(env));
  const match = path.match(/^\/api\/posts\/([A-Za-z0-9_-]+)$/);
  if (match) {
    const slug = validSlug(match[1]);
    if (request.method === 'PUT') return saveDraft(request, env, slug);
    if (request.method === 'GET') {
      const object = await env.STORAGE.get(`drafts/${slug}.md`);
      if (object && !object.customMetadata?.deleted) {
        const source = await object.text();
        return json({ draft: parseSource(source), source, etag: object.etag });
      }
      const release = await currentRelease(env),
        source = ownValue(release.markdown_posts, slug);
      if (source) return json({ draft: parseSource(source), source, etag: null });
      throw new HttpError(404, '文章不存在。');
    }
    if (request.method === 'DELETE') {
      const release = await currentRelease(env);
      if (ownValue(release.markdown_posts, slug))
        throw new HttpError(409, '请先取消发布，再删除草稿。');
      const input = await jsonInput(request, 4096),
        object = await env.STORAGE.head(`drafts/${slug}.md`);
      if (object && input.etag !== object.etag)
        throw new HttpError(409, '文章已修改，请重新打开。');
      // R2 delete has no conditional variant; serialize deletion with an ETag
      // guarded tombstone so an editor cannot silently overwrite the deletion.
      if (object) {
        const locked = await env.STORAGE.put(
          `drafts/${slug}.md`,
          serializeDraft({
            front_matter: {
              title: '已删除',
              slug,
              date: '2000-01-01',
              description: '',
              draft: true,
            },
            body_markdown: '',
          }),
          {
            onlyIf: { etagMatches: object.etag },
            customMetadata: { title: '已删除', deleted: 'true' },
          },
        );
        if (!locked) throw new HttpError(409, '文章已修改，请重新打开。');
      }
      return json({ ok: true });
    }
  }
  // ---- Shorts ("短记") ------------------------------------------------------
  if (path === '/api/shorts' && request.method === 'GET') {
    const release = await currentRelease(env);
    const published = new Map<string, ShortDraft>();
    for (const [slug, source] of Object.entries(release.markdown_shorts || {})) {
      try {
        published.set(slug, parseShortSource(source));
      } catch {
        // Skip malformed entries; they will surface on publish validation.
      }
    }
    const shorts = new Map<string, unknown>();
    for (const [slug, draft] of published)
      shorts.set(slug, {
        slug,
        date: draft.front_matter.date,
        published: true,
        has_draft: false,
        snippet: draft.body_markdown.slice(0, 300),
      });
    let cursor: string | undefined;
    do {
      const page = await env.STORAGE.list({
        prefix: 'shorts/',
        cursor,
        limit: 1000,
        include: ['customMetadata'],
      });
      for (const object of page.objects) {
        if (object.customMetadata?.deleted) continue;
        const slug = object.key.slice(7, -3);
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(slug)) continue;
        const meta = object.customMetadata || {};
        shorts.set(slug, {
          slug,
          date: meta.date || published.get(slug)?.front_matter.date || '',
          published: published.has(slug),
          has_draft: true,
          etag: object.etag,
          snippet: meta.snippet || published.get(slug)?.body_markdown.slice(0, 300) || '',
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const list = [...shorts.values()].sort((a: any, b: any) =>
      String(b.date).localeCompare(String(a.date)),
    );
    return json({ shorts: list });
  }
  const shortMatch = path.match(/^\/api\/shorts\/([A-Za-z0-9_-]+)$/);
  if (shortMatch) {
    const slug = validSlug(shortMatch[1]);
    if (request.method === 'PUT') {
      const input = await jsonInput(request, 1_000_000);
      const draft = validateShortDraft(input);
      if (draft.front_matter.slug !== slug) throw new HttpError(400, '短记地址与请求地址不一致。');
      draft.front_matter.draft = true;
      const source = serializeShortDraft(draft);
      await ensureManagedImages(env.STORAGE, source, new URL(request.url).origin);
      const existing = await env.STORAGE.head(`shorts/${slug}.md`);
      if (existing && !existing.customMetadata?.deleted && input.etag !== existing.etag)
        throw new HttpError(409, '这条短记在另一个窗口中发生了修改，请重新打开。');
      if ((!existing || existing.customMetadata?.deleted) && input.etag)
        throw new HttpError(409, '短记已删除，请重新打开。');
      const object = await env.STORAGE.put(`shorts/${slug}.md`, source, {
        onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' },
        customMetadata: {
          date: draft.front_matter.date,
          snippet: draft.body_markdown.slice(0, 300).replace(/\r?\n/g, ' '),
          ...(await imageReferenceMetadata(
            source,
            env.STORAGE,
            existing?.customMetadata?.image_refs_hash,
          )),
        },
        httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      });
      if (!object) throw new HttpError(409, '这条短记刚刚发生了修改，请重新打开。');
      return json({ ok: true, etag: object.etag });
    }
    if (request.method === 'GET') {
      const object = await env.STORAGE.get(`shorts/${slug}.md`);
      if (object && !object.customMetadata?.deleted) {
        const source = await object.text();
        return json({ draft: parseShortSource(source), source, etag: object.etag });
      }
      const release = await currentRelease(env);
      const source = ownValue(release.markdown_shorts, slug);
      if (source) return json({ draft: parseShortSource(source), source, etag: null });
      throw new HttpError(404, '短记不存在。');
    }
    if (request.method === 'DELETE') {
      const release = await currentRelease(env);
      if (ownValue(release.markdown_shorts, slug))
        throw new HttpError(409, '请先取消发布，再删除草稿。');
      const input = await jsonInput(request, 4096),
        object = await env.STORAGE.head(`shorts/${slug}.md`);
      if (object && input.etag !== object.etag)
        throw new HttpError(409, '短记已修改，请重新打开。');
      if (object) {
        const locked = await env.STORAGE.put(
          `shorts/${slug}.md`,
          serializeShortDraft({
            front_matter: { date: '2000-01-01 00:00', slug, draft: true },
            body_markdown: '',
          }),
          {
            onlyIf: { etagMatches: object.etag },
            customMetadata: { date: '2000-01-01 00:00', deleted: 'true' },
          },
        );
        if (!locked) throw new HttpError(409, '短记已修改，请重新打开。');
      }
      return json({ ok: true });
    }
  }
  if (path === '/api/upload' && request.method === 'POST') return uploadImage(request, env.STORAGE);
  if (path === '/api/image' && request.method === 'GET') {
    const key = new URL(request.url).searchParams.get('key');
    if (
      !key ||
      key.length > 1024 ||
      key.includes('..') ||
      key.startsWith('/') ||
      !validImageKey(key)
    )
      throw new HttpError(400, '图片地址不正确。');
    const image = await env.STORAGE.get(key);
    if (!image) throw new HttpError(404, '图片不存在。');
    const headers = new Headers({
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    image.writeHttpMetadata(headers);
    headers.set('ETag', image.httpEtag);
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
    return new Response(image.body, { headers });
  }
  if (path === '/api/publish' && request.method === 'POST') return publish(request, env);
  if (path === '/api/publish/status' && request.method === 'GET')
    return json(await publishStatus(env));
  if (path === '/api/settings' && request.method === 'GET') {
    const site = await env.STORAGE.get('draft-site.json'),
      release = await currentRelease(env);
    return json({
      site: site ? await site.json() : release.site,
      etag: site?.etag || null,
    });
  }
  if (path === '/api/settings' && request.method === 'PUT') {
    const data = await jsonInput(request, 500_000),
      site = validateSite(data.site),
      old = await env.STORAGE.head('draft-site.json');
    await ensureManagedImages(env.STORAGE, site.about || '', new URL(request.url).origin);
    await ensureHomeIllustration(env.STORAGE, site);
    await ensureSiteIcon(env.STORAGE, site);
    if (old && data.etag !== old.etag)
      throw new HttpError(409, '网站信息刚刚被修改，请重新打开设置。');
    const saved = await env.STORAGE.put('draft-site.json', JSON.stringify(site), {
      onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: '*' },
    });
    if (!saved) throw new HttpError(409, '网站信息刚刚被修改，请重新打开设置。');
    return json({ site, etag: saved.etag });
  }
  if (path === '/api/export' && request.method === 'GET') {
    const release = await currentRelease(env),
      drafts = await listDrafts(env.STORAGE),
      files: Record<string, string> = {};
    for (const [slug, source] of Object.entries(release.markdown_posts))
      files[`published/${slug}.md`] = source;
    for (const obj of drafts) {
      const source = await env.STORAGE.get(obj.key);
      if (source && !obj.customMetadata?.deleted) files[obj.key] = await source.text();
    }
    files['site.json'] = JSON.stringify(release.site); // UI writes this as site.json.
    return json({ files, release_id: release.id });
  }
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
  async fetch(request: Request, env: CloudInkEnv, ctx?: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/config' && request.method === 'GET')
        return protect(
          json({
            siteUrl: new URL(request.url).origin,
            imageOrigin: `${new URL(request.url).origin}/images`,
            initialized: !!(await env.STORAGE.head('auth/account.json')),
          }),
        );
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
} satisfies ExportedHandler<CloudInkEnv>;

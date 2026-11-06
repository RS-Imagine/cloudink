export { sanitizePublicHtml } from './page-rendering';
import { sanitizePublicHtml } from './page-rendering';
import { responsiveImages } from './image-variants';
import { assertRenameUnchanged, finishRename, postRedirects } from './post-addresses';
import type { CloudInkEnv } from './env';
import {
  HttpError,
  json,
  limitedBody,
  jsonInput,
  parseShortSource,
  parseSource,
  readJson,
  type Publishing,
  type Release,
  type SiteConfig,
} from './models';

const coreFiles = [
  'index.html',
  'archive/index.html',
  'shorts/index.html',
  '404.html',
  'styles.css',
  'client.js',
  'favicon.svg',
  'manifest.webmanifest',
  'sw.js',
  'search_index.json',
  'site.json',
  '_release.json',
];
export interface BrowserPointer {
  id: string;
  published_at?: string;
  pages?: Record<string, string>;
  previous_ids?: string[];
  publishing?: string;
  templateVersion?: string;
  responseVersion?: string;
  generationVersion?: string;
  clarityId?: string;
  postRedirects?: Record<string, string>;
}
export async function claimBrowserPublication(env: CloudInkEnv, state: Publishing): Promise<void> {
  const pointer = await env.STORAGE.get('state/published.json');
  const current = pointer ? await pointer.json<BrowserPointer>() : null;
  if (!pointer || current?.id !== state.previous_id)
    throw new HttpError(409, '线上版本已经变化，请重新发布。');
  const claimed = await env.STORAGE.put(
    'state/published.json',
    JSON.stringify({ ...current, publishing: state.release_id }),
    { onlyIf: { etagMatches: pointer.etag } },
  );
  if (!claimed) throw new HttpError(409, '线上版本已经变化，请重新发布。');
}
export function requiredPages(release: Release): string[] {
  const slugs = new Set<string>();
  for (const [slug, source] of Object.entries(release.markdown_posts)) {
    const post = parseSource(source);
    if (post.front_matter.slug !== slug) throw new HttpError(400, '文章地址与原稿不一致。');
    if (!post.front_matter.draft) slugs.add(slug);
  }
  for (const [slug, source] of Object.entries(release.markdown_shorts || {})) {
    const short = parseShortSource(source);
    if (short.front_matter.slug !== slug) throw new HttpError(400, '短记地址与原稿不一致。');
  }
  return [
    ...coreFiles,
    ...(release.about_markdown ? ['about/index.html'] : []),
    ...[...slugs].sort().map((slug) => `posts/${slug}/index.html`),
  ];
}
export async function initializeBrowserContent(env: CloudInkEnv, site: SiteConfig): Promise<void> {
  if (await env.STORAGE.head('state/published.json')) return;
  const release: Release = {
    schema_version: 1,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    site,
    markdown_posts: {},
  };
  if (site?.about) release.about_markdown = aboutSource(site.about);
  await env.STORAGE.put(
    `releases/${release.id}.posts.json`,
    JSON.stringify({ schema_version: 1, id: release.id, site, posts: {} }),
  );
  await env.STORAGE.put(`releases/${release.id}.json`, JSON.stringify(release));
  await env.STORAGE.put(
    'state/published.json',
    JSON.stringify({ id: release.id, clarityId: release.site.clarityId || '' }),
    { onlyIf: { etagDoesNotMatch: '*' } },
  );
}
export function aboutSource(markdown: string): string {
  return '+++\ntitle = "About"\ndescription = ""\n+++\n\n' + markdown;
}
export function publicType(path: string): string {
  if (path === 'archive/index.html' || path === 'shorts/index.html')
    return 'text/html; charset=utf-8';
  if (/^(?:index|404|about\/index|posts\/[A-Za-z0-9_-]{1,100}\/index)\.html$/.test(path))
    return 'text/html; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path === 'client.js') return 'text/javascript; charset=utf-8';
  if (path === 'styles.css') return 'text/css; charset=utf-8';
  if (path === 'favicon.svg') return 'image/svg+xml';
  if (path === 'manifest.webmanifest') return 'application/manifest+json; charset=utf-8';
  if (path === 'sw.js') return 'text/javascript; charset=utf-8';
  const ext = path.split('.').pop()?.toLowerCase();
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        avif: 'image/avif',
        woff: 'font/woff',
        woff2: 'font/woff2',
        txt: 'text/plain; charset=utf-8',
        pdf: 'application/pdf',
      } as Record<string, string>
    )[ext || ''] || 'application/octet-stream'
  );
}
export async function contentDigest(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export interface PageManifest {
  sources: Record<string, string>;
  pages: Record<string, string>;
  sizes?: Record<string, number>;
}
const generatedFiles = (state: Publishing) =>
  (state.files || []).filter(
    (path) =>
      !['styles.css', 'client.js', 'favicon.svg', 'manifest.webmanifest', 'sw.js'].includes(path),
  );
function compatible(pointer: BrowserPointer | null, state: Publishing): boolean {
  return (
    pointer?.id === state.previous_id &&
    pointer.templateVersion === state.template_version &&
    (state.generation_version
      ? pointer.generationVersion === state.generation_version
      : pointer.responseVersion === state.response_version) &&
    !state.force_rebuild
  );
}
export async function selectRenderFiles(
  env: CloudInkEnv,
  state: Publishing,
  base: Release,
  release: Release,
): Promise<void> {
  const pointer = await readJson<BrowserPointer>(env.STORAGE, 'state/published.json');
  if (
    !compatible(pointer, state) ||
    JSON.stringify(base.site) !== JSON.stringify(release.site) ||
    base.about_markdown !== release.about_markdown
  )
    return;
  const prior = await readJson<PageManifest>(env.STORAGE, 'releases/' + base.id + '.manifest.json');
  if (!prior?.sizes) return;
  const changed = new Set<string>(['_release.json']);
  const changedPosts = new Set(
    [...Object.keys(base.markdown_posts), ...Object.keys(release.markdown_posts)].filter(
      (slug) => base.markdown_posts[slug] !== release.markdown_posts[slug],
    ),
  );
  if (changedPosts.size) {
    for (const path of ['index.html', 'archive/index.html', 'search_index.json']) changed.add(path);
    for (const slug of changedPosts) changed.add('posts/' + slug + '/index.html');
  }
  if (JSON.stringify(base.markdown_shorts || {}) !== JSON.stringify(release.markdown_shorts || {}))
    changed.add('shorts/index.html');
  for (const path of generatedFiles(state))
    if (
      !/^[a-f0-9]{64}$/.test(prior.pages[path] || '') ||
      !Number.isInteger(prior.sizes[path]) ||
      prior.sizes[path] < 0
    )
      changed.add(path);
  state.render_files = generatedFiles(state).filter((path) => changed.has(path));
}
async function receipt(
  env: CloudInkEnv,
  state: Publishing,
  path: string,
  size: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SETUP_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(JSON.stringify([state.release_id, path, state.plan!.pages[path], size])),
  );
  return [...new Uint8Array(signed)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
export async function planBrowserPublish(
  request: Request,
  env: CloudInkEnv,
  id: string,
): Promise<Response> {
  const { object, state } = await pendingVersion(env, id);
  const input = await jsonInput(request, 150_000);
  const supplied = input.sources as Record<string, string>;
  const files = generatedFiles(state);
  if (
    !supplied ||
    typeof supplied !== 'object' ||
    Array.isArray(supplied) ||
    Object.keys(supplied).some(
      (path) =>
        !files.includes(path) ||
        typeof supplied[path] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(supplied[path]),
    )
  )
    throw new HttpError(400, '发布页面指纹不完整或无效。');
  const pointer = await readJson<BrowserPointer>(env.STORAGE, 'state/published.json');
  const prior = compatible(pointer, state)
    ? await readJson<PageManifest>(env.STORAGE, 'releases/' + state.previous_id + '.manifest.json')
    : null;
  const sources: Record<string, string> = {};
  for (const path of files) {
    const provided = Object.hasOwn(supplied, path) ? supplied[path] : undefined;
    if (
      !provided &&
      (!state.render_files || state.render_files.includes(path) || !prior?.sources[path])
    )
      throw new HttpError(400, '发布页面指纹不完整或无效。');
    sources[path] = provided || prior!.sources[path];
  }
  if (state.plan) {
    if (files.some((path) => state.plan!.sources[path] !== sources[path]))
      throw new HttpError(409, '这次发布的页面已确定，请重新发布。');
    return json({ files: await missingPages(env.STORAGE, state.plan.pages, state.plan.sizes) });
  }
  const pages: Record<string, string> = {};
  const changed: string[] = [];
  const sizes: Record<string, number> = {};
  for (const path of files) {
    if (
      path !== '_release.json' &&
      prior?.sources[path] === sources[path] &&
      /^[a-f0-9]{64}$/.test(prior.pages[path] || '')
    ) {
      pages[path] = prior.pages[path];
      const size = prior.sizes?.[path];
      if (Number.isInteger(size) && size! >= 0) sizes[path] = size!;
    } else {
      pages[path] = await contentDigest(
        (state.generation_version || state.response_version) +
          ':' +
          state.template_version +
          ':' +
          path +
          ':' +
          (state.force_rebuild || path === '_release.json' ? id : '') +
          ':' +
          sources[path],
      );
      changed.push(path);
    }
  }
  const plan = { sources, pages, sizes };
  const saved = await env.STORAGE.put(
    'state/pending.json',
    JSON.stringify({ ...state, files, plan }),
    { onlyIf: { etagMatches: object.etag } },
  );
  if (!saved) throw new HttpError(409, '发布状态已经变化，请重试。');
  return json({ files: changed });
}
async function missingPages(
  storage: R2Bucket,
  pages: Record<string, string>,
  sizes?: Record<string, number>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const [path, hash] of Object.entries(pages))
    if (sizes?.[path] === undefined && !(await storage.head('public/content/' + hash)))
      missing.push(path);
  return missing;
}
async function pendingVersion(
  env: CloudInkEnv,
  id: string,
): Promise<{ object: R2ObjectBody; state: Publishing }> {
  const object = await env.STORAGE.get('state/pending.json');
  if (!object) throw new HttpError(409, '没有待完成的发布，请重新发布。');
  const state = await object.json<Publishing>();
  if (
    state.release_id !== id ||
    !['queued', 'building'].includes(state.status) ||
    Date.now() - Date.parse(state.started_at) > 30 * 60_000
  )
    throw new HttpError(409, '这次发布已结束或失效，请重新发布。');
  return { object, state };
}
function validateMarker(body: string, state: Publishing): void {
  let marker;
  try {
    marker = JSON.parse(body);
  } catch {
    throw new HttpError(400, '发布标记无效。');
  }
  if (marker?.id !== state.release_id) throw new HttpError(400, '发布标记与当前版本不一致。');
  if (state.template_version && marker.template_version !== state.template_version)
    throw new HttpError(409, '后台版本已更新，请刷新页面后重试；草稿和线上内容仍保留。');
}
export async function stageBrowserPage(
  request: Request,
  env: CloudInkEnv,
  id: string,
): Promise<Response> {
  const { state } = await pendingVersion(env, id);
  const path = new URL(request.url).searchParams.get('path') || '';
  if (!state.files?.includes(path)) throw new HttpError(400, '这不是当前发布中的页面。');
  let body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    await limitedBody(request, path === '_release.json' ? 4096 : 8_000_000),
  );
  if (state.plan && (await contentDigest(body)) !== state.plan.sources[path])
    throw new HttpError(409, '网页内容与本次发布指纹不一致，请重新生成。');
  if (path === '_release.json') validateMarker(body, state);
  if (state.plan) {
    const existing = await env.STORAGE.head('public/content/' + state.plan.pages[path]);
    if (existing)
      return json({
        ok: true,
        reused: true,
        receipt: [existing.size, await receipt(env, state, path, existing.size)],
      });
  }

  if (path.endsWith('.html'))
    body = await responsiveImages(
      await sanitizePublicHtml(body),
      env.STORAGE,
      new URL(request.url).origin,
    );
  // An already staged page stays immutable, including after commit begins.
  const stored = await env.STORAGE.put(
    state.plan ? 'public/content/' + state.plan.pages[path] : `public/${id}/${path}`,
    body,
    {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: publicType(path) },
    },
  );
  const size =
    stored?.size ??
    (
      await env.STORAGE.head(
        state.plan ? 'public/content/' + state.plan.pages[path] : `public/${id}/${path}`,
      )
    )?.size;
  if (size === undefined) throw new HttpError(409, '页面未能保存，请重试。');
  return json({
    ok: true,
    ...(state.plan ? { receipt: [size, await receipt(env, state, path, size)] } : {}),
  });
}
export async function cancelBrowserPublish(env: CloudInkEnv, id: string): Promise<Response> {
  const object = await env.STORAGE.get('state/pending.json');
  if (!object) throw new HttpError(409, '这次发布已经结束。');
  const state = await object.json<Publishing>();
  if (state.release_id !== id) throw new HttpError(409, '发布版本已经变化。');
  const pointer = await env.STORAGE.get('state/published.json');
  const value = pointer ? await pointer.json<BrowserPointer>() : null;
  if (value?.id === id) return json({ ...state, status: 'deployed' });
  if (pointer && value?.publishing === id) {
    const cleared = await env.STORAGE.put(
      'state/published.json',
      JSON.stringify({ ...value, publishing: undefined }),
      { onlyIf: { etagMatches: pointer.etag } },
    );
    if (!cleared) {
      const current = await readJson<BrowserPointer>(env.STORAGE, 'state/published.json');
      if (current?.id === id) return json({ ...state, status: 'deployed' });
      throw new HttpError(409, '发布状态已经变化，请刷新后重试。');
    }
  }
  const failed: Publishing = {
    ...state,
    status: 'failed',
    error: '发布未完成；草稿和上次上线版本已保留，可以重新发布。',
  };
  await env.STORAGE.put('state/pending.json', JSON.stringify(failed), {
    onlyIf: { etagMatches: object.etag },
  });
  return json(failed);
}
export async function commitBrowserPublish(
  env: CloudInkEnv,
  id: string,
  request?: Request,
): Promise<Response> {
  const input = request ? await jsonInput(request, 250_000) : {};
  const receipts = input.receipts as Record<string, unknown> | undefined;
  if (
    receipts !== undefined &&
    (!receipts || typeof receipts !== 'object' || Array.isArray(receipts))
  )
    throw new HttpError(400, '页面保存凭据格式不正确。');
  const { object, state } = await pendingVersion(env, id);
  const locked = await env.STORAGE.put(
    'state/pending.json',
    JSON.stringify({ ...state, status: 'built' }),
    { onlyIf: { etagMatches: object.etag } },
  );
  if (!locked) throw new HttpError(409, '另一个窗口正在完成发布。');
  let committed = false;
  try {
    let size = 0;
    const verification = { reused: 0, receipts: 0, heads: 0 };
    const sizes: Record<string, number> = {};
    for (const path of state.files || []) {
      const key = state.plan ? 'public/content/' + state.plan.pages[path] : `public/${id}/${path}`;
      if (path === '_release.json') {
        const marker = await env.STORAGE.get(key);
        if (!marker) throw new HttpError(409, '发布标记尚未上传，请重新发布。');
        if (marker.size > 4096) {
          await marker.body.cancel();
          throw new HttpError(413, '发布标记过大。');
        }
        validateMarker(await marker.text(), state);
        sizes[path] = marker.size;
      } else if (state.plan?.sizes?.[path] !== undefined) {
        sizes[path] = state.plan.sizes[path];
        verification.reused++;
      } else if (receipts && Object.hasOwn(receipts, path)) {
        const value = receipts[path];
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          !Number.isInteger(value[0]) ||
          value[0] < 0 ||
          value[0] > 8_000_000 ||
          typeof value[1] !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value[1]) ||
          !state.plan ||
          !crypto.subtle.timingSafeEqual(
            new TextEncoder().encode(value[1]),
            new TextEncoder().encode(await receipt(env, state, path, value[0])),
          )
        )
          throw new HttpError(409, '页面保存凭据无效，请重新发布。');
        sizes[path] = value[0];
        verification.receipts++;
      } else {
        verification.heads++;
        const file = await env.STORAGE.head(key);
        if (!file) throw new HttpError(409, '页面尚未上传完整，请重新发布。');
        sizes[path] = file.size;
      }
      size += sizes[path];
    }
    const release = await readJson<Release>(env.STORAGE, `releases/${id}.json`);
    if (!release) throw new HttpError(503, '发布版本缺失。');
    if (size > 16_000_000) throw new HttpError(413, '生成后的网页超过 16 MB，请减少内容后重试。');
    const latest = await env.STORAGE.head('state/pending.json');
    if (latest?.etag !== locked.etag) throw new HttpError(409, '这次发布已取消，请重新发布。');
    const pointer = await env.STORAGE.get('state/published.json');
    const current = pointer ? await pointer.json<BrowserPointer>() : null;
    if (!pointer || current?.id !== state.previous_id || current.publishing !== id)
      throw new HttpError(409, '这次发布已取消或线上版本已经变化，请重新发布。');
    await assertRenameUnchanged(env.STORAGE, state);
    if (state.plan)
      await env.STORAGE.put(
        `releases/${id}.manifest.json`,
        JSON.stringify({ ...state.plan, sizes }),
        {
          onlyIf: { etagDoesNotMatch: '*' },
        },
      );
    const saved = await env.STORAGE.put(
      'state/published.json',
      JSON.stringify({
        id,
        published_at: new Date().toISOString(),
        ...(state.plan ? { pages: state.plan.pages } : {}),
        previous_ids: [current.id, ...(current.previous_ids || [])].slice(0, 2),
        clarityId: release.site.clarityId || '',
        postRedirects: postRedirects(release),
        templateVersion: state.template_version,
        responseVersion: state.response_version,
        generationVersion: state.generation_version,
      }),
      { onlyIf: { etagMatches: pointer.etag } },
    );
    if (!saved) throw new HttpError(409, '线上版本已经变化，请重新发布。');
    committed = true;
    await finishRename(env.STORAGE, state, release);
    const done: Publishing = { ...state, status: 'deployed' };
    await env.STORAGE.put('state/pending.json', JSON.stringify(done), {
      onlyIf: { etagMatches: locked.etag },
    });
    return json({ ...done, verification });
  } catch (error) {
    if (!committed)
      await env.STORAGE.put(
        'state/pending.json',
        JSON.stringify({
          ...state,
          status: 'failed',
          error: '发布未完成；草稿和上次上线版本已保留。',
        }),
        { onlyIf: { etagMatches: locked.etag } },
      );
    throw error;
  }
}

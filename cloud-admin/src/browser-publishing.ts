import type { CloudInkEnv } from './env';
import { Buffer } from 'node:buffer';
import {
  HttpError,
  json,
  limitedBody,
  parseSource,
  readJson,
  type Publishing,
  type Release,
  type SiteConfig,
} from './models';

const coreFiles = [
  'index.html',
  '404.html',
  'styles.css',
  'client.js',
  'favicon.svg',
  'search_index.json',
  '_release.json',
];
interface BrowserPointer {
  id: string;
  publishing?: string;
  clarityId?: string;
}
export async function claimBrowserPublication(env: CloudInkEnv, state: Publishing): Promise<void> {
  const pointer = await env.CONTENT.get('state/published.json');
  const current = pointer ? await pointer.json<BrowserPointer>() : null;
  if (!pointer || current?.id !== state.previous_id)
    throw new HttpError(409, '线上版本已经变化，请重新发布。');
  const claimed = await env.CONTENT.put(
    'state/published.json',
    JSON.stringify({ ...current, publishing: state.release_id }),
    { onlyIf: { etagMatches: pointer.etag } },
  );
  if (!claimed) throw new HttpError(409, '线上版本已经变化，请重新发布。');
}
export function requiredPages(release: Release): string[] {
  const slugs = new Set(
    release.legacy_posts.filter((p) => !p.front_matter.draft).map((p) => p.front_matter.slug),
  );
  for (const [slug, source] of Object.entries(release.markdown_posts)) {
    const post = parseSource(source);
    if (post.front_matter.slug !== slug) throw new HttpError(400, '文章地址与原稿不一致。');
    slugs.delete(slug);
    if (!post.front_matter.draft) slugs.add(slug);
  }
  return [
    ...coreFiles,
    ...(release.about_html || release.about_markdown ? ['about/index.html'] : []),
    ...[...slugs].sort().map((slug) => `posts/${slug}/index.html`),
  ];
}
export async function initializeBrowserContent(env: CloudInkEnv, site?: SiteConfig): Promise<void> {
  if (await env.CONTENT.head('state/published.json')) return;
  const author = env.OWNER_EMAIL.split('@')[0];
  const release: Release = {
    schema_version: 1,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    site: site || {
      title: 'CloudInk',
      subtitle: 'Notes and ideas',
      author,
      description: 'A personal blog powered by CloudInk.',
    },
    markdown_posts: {},
    legacy_posts: [],
    assets: {},
  };
  if (site?.about) release.about_markdown = aboutSource(site.about);
  await env.CONTENT.put(`releases/${release.id}.json`, JSON.stringify(release));
  await env.CONTENT.put(
    'state/published.json',
    JSON.stringify({ id: release.id, clarityId: release.site.clarityId || '' }),
    { onlyIf: { etagDoesNotMatch: '*' } },
  );
}
export function aboutSource(markdown: string): string {
  return '+++\ntitle = "About"\ndescription = ""\n+++\n\n' + markdown;
}
export function publicType(path: string): string {
  if (/^(?:index|404|about\/index|posts\/[A-Za-z0-9_-]{1,100}\/index)\.html$/.test(path))
    return 'text/html; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path === 'client.js') return 'text/javascript; charset=utf-8';
  if (path === 'styles.css') return 'text/css; charset=utf-8';
  if (path === 'favicon.svg') return 'image/svg+xml';
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
export async function sanitizePublicHtml(html: string): Promise<string> {
  return new HTMLRewriter()
    .on('script,base,iframe,object,embed,form,meta[http-equiv]', {
      element(element) {
        element.remove();
      },
    })
    .on('*', {
      element(element) {
        for (const [name] of [...element.attributes])
          if (name.toLowerCase().startsWith('on')) element.removeAttribute(name);
      },
    })
    .on('head', {
      element(element) {
        element.append('<script src="/theme.js"></script>', { html: true });
      },
    })
    .on('body', {
      element(element) {
        element.append('<script src="/client.js"></script>', { html: true });
      },
    })
    .on('body', {
      element(element) {
        element.append('<script src="/analytics.js" defer></script>', { html: true });
      },
    })
    .transform(new Response(html))
    .text();
}
async function pendingVersion(
  env: CloudInkEnv,
  id: string,
): Promise<{ object: R2ObjectBody; state: Publishing }> {
  const object = await env.CONTENT.get('state/pending.json');
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
export async function stageBrowserPage(
  request: Request,
  env: CloudInkEnv,
  id: string,
): Promise<Response> {
  const { state } = await pendingVersion(env, id);
  const path = new URL(request.url).searchParams.get('path') || '';
  if (!state.files?.includes(path)) throw new HttpError(400, '这不是当前发布中的页面。');
  let body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    await limitedBody(request, 8_000_000),
  );
  if (path === '_release.json') {
    let marker;
    try {
      marker = JSON.parse(body);
    } catch {
      throw new HttpError(400, '发布标记无效。');
    }
    if (marker.id !== id) throw new HttpError(400, '发布标记与当前版本不一致。');
  }
  if (path.endsWith('.html')) body = await sanitizePublicHtml(body);
  // An already staged page stays immutable, including after commit begins.
  await env.CONTENT.put(`public/${id}/${path}`, body, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: publicType(path) },
  });
  return json({ ok: true });
}
export async function cancelBrowserPublish(env: CloudInkEnv, id: string): Promise<Response> {
  const object = await env.CONTENT.get('state/pending.json');
  if (!object) throw new HttpError(409, '这次发布已经结束。');
  const state = await object.json<Publishing>();
  if (state.release_id !== id) throw new HttpError(409, '发布版本已经变化。');
  const pointer = await env.CONTENT.get('state/published.json');
  const value = pointer ? await pointer.json<BrowserPointer>() : null;
  if (value?.id === id) return json({ ...state, status: 'deployed' });
  if (pointer && value?.publishing === id) {
    const cleared = await env.CONTENT.put(
      'state/published.json',
      JSON.stringify({ id: value.id, clarityId: value.clarityId || '' }),
      { onlyIf: { etagMatches: pointer.etag } },
    );
    if (!cleared) {
      const current = await readJson<BrowserPointer>(env.CONTENT, 'state/published.json');
      if (current?.id === id) return json({ ...state, status: 'deployed' });
      throw new HttpError(409, '发布状态已经变化，请刷新后重试。');
    }
  }
  const failed: Publishing = {
    ...state,
    status: 'failed',
    error: '发布未完成；草稿和上次上线版本已保留，可以重新发布。',
  };
  await env.CONTENT.put('state/pending.json', JSON.stringify(failed), {
    onlyIf: { etagMatches: object.etag },
  });
  return json(failed);
}
export async function commitBrowserPublish(env: CloudInkEnv, id: string): Promise<Response> {
  const { object, state } = await pendingVersion(env, id);
  const locked = await env.CONTENT.put(
    'state/pending.json',
    JSON.stringify({ ...state, status: 'built' }),
    { onlyIf: { etagMatches: object.etag } },
  );
  if (!locked) throw new HttpError(409, '另一个窗口正在完成发布。');
  let committed = false;
  try {
    let size = 0;
    for (const path of state.files || []) {
      const file = await env.CONTENT.head(`public/${id}/${path}`);
      if (!file) throw new HttpError(409, '页面尚未上传完整，请重新发布。');
      size += file.size;
    }
    const release = await readJson<Release>(env.CONTENT, `releases/${id}.json`);
    if (!release) throw new HttpError(503, '发布版本缺失。');
    for (const [path, encoded] of Object.entries(release.assets)) {
      if (
        !/^(?:images|assets|fonts)\/[A-Za-z0-9_./-]+$/.test(path) ||
        path.split('/').some((p) => !p || p === '.' || p === '..')
      )
        throw new HttpError(400, '静态资源路径无效。');
      const bytes = Buffer.from(encoded, 'base64');
      size += bytes.byteLength;
      if (size > 16_000_000) throw new HttpError(413, '生成后的网页超过 16 MB，请减少内容后重试。');
      await env.CONTENT.put(`public/${id}/${path}`, bytes, {
        httpMetadata: { contentType: publicType(path) },
      });
    }
    if (size > 16_000_000) throw new HttpError(413, '生成后的网页超过 16 MB，请减少内容后重试。');
    const latest = await env.CONTENT.head('state/pending.json');
    if (latest?.etag !== locked.etag) throw new HttpError(409, '这次发布已取消，请重新发布。');
    const pointer = await env.CONTENT.get('state/published.json');
    const current = pointer ? await pointer.json<BrowserPointer>() : null;
    if (!pointer || current?.id !== state.previous_id || current.publishing !== id)
      throw new HttpError(409, '这次发布已取消或线上版本已经变化，请重新发布。');
    const saved = await env.CONTENT.put(
      'state/published.json',
      JSON.stringify({ id, clarityId: release.site.clarityId || '' }),
      { onlyIf: { etagMatches: pointer.etag } },
    );
    if (!saved) throw new HttpError(409, '线上版本已经变化，请重新发布。');
    committed = true;
    const done: Publishing = { ...state, status: 'deployed' };
    await env.CONTENT.put('state/pending.json', JSON.stringify(done), {
      onlyIf: { etagMatches: locked.etag },
    });
    return json(done);
  } catch (error) {
    if (!committed)
      await env.CONTENT.put(
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

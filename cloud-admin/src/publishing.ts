import type { CloudInkEnv } from './env';
import {
  requiredPages,
  claimBrowserPublication,
  cancelBrowserPublish,
  aboutSource,
} from './browser-publishing';
import {
  HttpError,
  json,
  jsonInput,
  parseSource,
  readJson,
  serializeDraft,
  validSlug,
  validateDraft,
  validateSite,
  type Publishing,
  type Release,
} from './models';
import { randomToken, sameSecret } from './auth';

interface StoredHook {
  iv: number[];
  ciphertext: number[];
}
async function encryptionKey(env: CloudInkEnv): Promise<CryptoKey> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.BUILD_TOKEN));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function saveHook(env: CloudInkEnv, value: unknown): Promise<void> {
  if (env.browserPublishing) throw new HttpError(409, '发布已自动配置，无需部署链接。');
  if (env.WORKERS_DEPLOY_HOOK) throw new HttpError(409, '发布服务已由部署配置管理，无需重新设置。');
  if (typeof value !== 'string' || value.length > 1000)
    throw new HttpError(400, '部署链接格式不正确。');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, '部署链接格式不正确。');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.cloudflare.com' ||
    !/^\/client\/v4\/(?:pages\/webhooks|workers\/builds\/deploy_hooks)\/[A-Za-z0-9-]+$/.test(
      url.pathname,
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HttpError(400, '请使用当前博客的 Cloudflare Deploy Hook 链接。');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(env),
    new TextEncoder().encode(url.href),
  );
  await env.CONTENT.put(
    'private/deploy-hook.json',
    JSON.stringify({ iv: [...iv], ciphertext: [...new Uint8Array(encrypted)] }),
  );
}
async function getHook(env: CloudInkEnv): Promise<string | null> {
  if (env.WORKERS_DEPLOY_HOOK) return env.WORKERS_DEPLOY_HOOK;
  const record = await readJson<StoredHook>(env.CONTENT, 'private/deploy-hook.json');
  if (!record) return null;
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
    await encryptionKey(env),
    new Uint8Array(record.ciphertext),
  );
  return new TextDecoder().decode(data);
}
export async function currentRelease(env: CloudInkEnv): Promise<Release> {
  const pointer = await readJson<{ id: string }>(env.CONTENT, 'state/published.json');
  if (!pointer) throw new HttpError(503, '网站内容尚未初始化，请完成部署教程中的内容初始化。');
  const release = await readJson<Release>(env.CONTENT, `releases/${pointer.id}.json`);
  if (!release) throw new HttpError(503, '网站内容版本缺失，请联系维护者。');
  return release;
}
function busy(state: Publishing): boolean {
  return ['queued', 'building', 'built'].includes(state.status);
}
export async function publishStatus(env: CloudInkEnv): Promise<Publishing | null> {
  const obj = await env.CONTENT.get('state/pending.json');
  if (!obj) return null;
  const state = await obj.json<Publishing>();
  if (!busy(state)) return state;
  if (env.browserPublishing) {
    const pointer = await readJson<{ id: string }>(env.CONTENT, 'state/published.json');
    if (pointer?.id === state.release_id) state.status = 'deployed';
  }
  // The marker is uploaded with the static site. A build finishing is not proof
  // that Cloudflare has deployed it, so only this live marker commits the release.
  if (!env.browserPublishing)
    try {
      const response = await fetch(`${env.SITE_URL}/_release.json?version=${state.release_id}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok && Number(response.headers.get('content-length') || 0) < 2048) {
        const marker = await response.json<{ id?: string }>();
        if (marker.id === state.release_id) {
          const pointer = await env.CONTENT.get('state/published.json');
          const prior = pointer ? await pointer.json<{ id: string }>() : null;
          if (prior?.id !== state.release_id && prior?.id !== state.previous_id)
            throw new Error('published pointer conflict');
          if (prior?.id !== state.release_id) {
            const saved = await env.CONTENT.put(
              'state/published.json',
              JSON.stringify({ id: state.release_id }),
              { onlyIf: pointer ? { etagMatches: pointer.etag } : { etagDoesNotMatch: '*' } },
            );
            if (!saved) throw new Error('published pointer conflict');
          }
          state.status = 'deployed';
        }
      }
    } catch {
      /* Transient network failures must not change the published version. */
    }
  if (busy(state) && Date.now() - Date.parse(state.started_at) > 30 * 60_000) {
    if (env.browserPublishing)
      return (await cancelBrowserPublish(env, state.release_id)).json<Publishing>();
    state.status = 'failed';
    state.error = '构建或部署超过 30 分钟，请检查 Cloudflare 的部署记录后重试。';
  }
  if (state.status === 'deployed' || state.status === 'failed')
    await env.CONTENT.put('state/pending.json', JSON.stringify(state), {
      onlyIf: { etagMatches: obj.etag },
    });
  return state;
}
export async function publish(request: Request, env: CloudInkEnv): Promise<Response> {
  const data = await jsonInput(request, 4096);
  const hook = env.browserPublishing ? null : await getHook(env);
  if (!env.browserPublishing && !hook)
    throw new HttpError(503, '请先在“设置 → 发布连接”中配置 Cloudflare Deploy Hook。');
  await publishStatus(env);
  const previous = await env.CONTENT.get('state/pending.json');
  if (previous && busy(await previous.json<Publishing>()))
    throw new HttpError(409, '上一次发布还在进行中，请等待完成。');
  const base = await currentRelease(env);
  const release: Release = structuredClone(base);
  release.id = crypto.randomUUID();
  release.created_at = new Date().toISOString();
  if (typeof data.slug === 'string') {
    const slug = validSlug(data.slug),
      draft = await env.CONTENT.get(`drafts/${slug}.md`);
    if (!draft) throw new HttpError(404, '请先保存这篇文章的草稿。');
    if (data.etag !== draft.etag)
      throw new HttpError(409, '文章刚刚发生了修改，请保存最新版本后再发布。');
    const parsed = parseSource(await draft.text());
    parsed.front_matter.draft = false;
    if (base.markdown_posts[slug] || base.legacy_posts.some((p) => p.front_matter.slug === slug))
      parsed.front_matter.updated = new Date().toISOString().slice(0, 10);
    release.markdown_posts[slug] = serializeDraft(parsed);
    release.legacy_posts = release.legacy_posts.filter((p) => p.front_matter.slug !== slug);
  } else if (typeof data.unpublish === 'string') {
    const slug = validSlug(data.unpublish);
    delete release.markdown_posts[slug];
    release.legacy_posts = release.legacy_posts.filter((p) => p.front_matter.slug !== slug);
  } else if (data.settings === true) {
    const site = await readJson<unknown>(env.CONTENT, 'draft-site.json');
    if (!site) throw new HttpError(400, '请先保存网站信息。');
    release.site = validateSite(site);
    if (release.site.about !== undefined) {
      delete release.about_html;
      delete release.about_markdown;
      if (release.site.about.trim()) release.about_markdown = aboutSource(release.site.about);
    }
  } else if (data.rebuild !== true) throw new HttpError(400, '请选择要发布的文章或网站信息。');
  if (new TextEncoder().encode(JSON.stringify(release)).byteLength > 16_000_000)
    throw new HttpError(413, '网站内容超过当前版本的发布大小限制。');
  const pending: Publishing = {
    release_id: release.id,
    previous_id: base.id,
    status: 'queued',
    started_at: new Date().toISOString(),
  };
  if (env.browserPublishing) {
    pending.files = requiredPages(release);
    if (pending.files.length > 750) throw new HttpError(413, '当前网页数量超过发布限制。');
  }
  const locked = await env.CONTENT.put('state/pending.json', JSON.stringify(pending), {
    onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
  });
  if (!locked) throw new HttpError(409, '另一个发布正在启动，请刷新后重试。');
  try {
    await env.CONTENT.put(`releases/${release.id}.json`, JSON.stringify(release));
    if (env.browserPublishing) {
      await claimBrowserPublication(env, pending);
      return json({ ...pending, browser_release: release }, 202);
    }
    const response = await fetch(hook!, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    if (!response.ok) throw new Error('hook rejected');
    // Validate Cloudflare's response instead of accepting an HTML error page.
    const result = await response.json<{ success?: boolean }>();
    if (result.success !== true) throw new Error('hook rejected');
    return json(pending, 202);
  } catch {
    if (env.browserPublishing) {
      await cancelBrowserPublish(env, release.id);
      throw new HttpError(503, '发布暂时未能准备好；草稿和线上版本已保留，请重试。');
    }
    const record = await env.CONTENT.get('state/pending.json');
    if (record && (await record.json<Publishing>()).release_id === release.id)
      await env.CONTENT.put(
        'state/pending.json',
        JSON.stringify({
          ...pending,
          status: 'failed',
          error: '无法触发 Cloudflare 部署，请检查发布连接后重试。',
        }),
        { onlyIf: { etagMatches: record.etag } },
      );
    throw new HttpError(502, '无法触发 Cloudflare 部署；草稿已保留，线上版本未更新。');
  }
}
export async function internalRoute(
  request: Request,
  env: CloudInkEnv,
  path: string,
): Promise<Response | null> {
  if (!path.startsWith('/internal/')) return null;
  const authorization = request.headers.get('Authorization') || '';
  const primary =
    !!env.BUILD_TOKEN && (await sameSecret(authorization, `Bearer ${env.BUILD_TOKEN}`));
  const workers =
    !!env.WORKERS_BUILD_TOKEN &&
    (await sameSecret(authorization, `Bearer ${env.WORKERS_BUILD_TOKEN}`));
  if (!primary && !workers) throw new HttpError(401, 'Unauthorized');
  if (path === '/internal/bundle' && request.method === 'GET') {
    const pending = await readJson<Publishing>(env.CONTENT, 'state/pending.json');
    const id = pending && busy(pending) ? pending.release_id : (await currentRelease(env)).id;
    const object = await env.CONTENT.get(`releases/${id}.json`);
    if (!object) throw new HttpError(503, 'Release not available');
    return new Response(object.body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  if (path === '/internal/status' && request.method === 'POST') {
    const data = await jsonInput(request, 4096),
      obj = await env.CONTENT.get('state/pending.json');
    if (!obj) return json({ ok: true });
    const state = await obj.json<Publishing>();
    if (
      state.release_id === data.id &&
      busy(state) &&
      ['building', 'built', 'failed'].includes(String(data.status))
    ) {
      state.status = data.status as Publishing['status'];
      if (state.status === 'failed')
        state.error = 'Cloudflare 构建失败，请查看 Cloudflare 构建日志后重试。';
      await env.CONTENT.put('state/pending.json', JSON.stringify(state), {
        onlyIf: { etagMatches: obj.etag },
      });
    }
    return json({ ok: true });
  }
  if (path === '/internal/bootstrap' && request.method === 'POST') {
    if (await env.CONTENT.head('state/published.json'))
      throw new HttpError(409, '网站已迁移，不接受重复初始化。');
    const data = await jsonInput(request, 16_000_000);
    if (
      data.schema_version !== 1 ||
      typeof data.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(data.id) ||
      typeof data.created_at !== 'string' ||
      Number.isNaN(Date.parse(data.created_at)) ||
      !Array.isArray(data.legacy_posts) ||
      typeof data.assets !== 'object' ||
      !data.assets ||
      Array.isArray(data.assets)
    )
      throw new HttpError(400, '迁移数据格式不正确。');
    const legacy_posts = data.legacy_posts.map((value: unknown) => {
      const draft = validateDraft(value);
      if (
        draft.front_matter.draft ||
        !value ||
        typeof value !== 'object' ||
        !('body_html' in value) ||
        typeof value.body_html !== 'string' ||
        !('body_plain_text' in value) ||
        typeof value.body_plain_text !== 'string'
      )
        throw new HttpError(400, '迁移包文章格式不正确。');
      return { ...draft, body_html: value.body_html, body_plain_text: value.body_plain_text };
    });
    const assets: Record<string, string> = {};
    for (const [path, encoded] of Object.entries(data.assets)) {
      if (
        !/^[A-Za-z0-9_./-]+$/.test(path) ||
        path.startsWith('/') ||
        path.split('/').some((p) => p === '..' || !p) ||
        typeof encoded !== 'string' ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      )
        throw new HttpError(400, '迁移包图片格式不正确。');
      assets[path] = encoded;
    }
    const release: Release = {
      schema_version: 1,
      id: data.id,
      created_at: data.created_at,
      site: validateSite(data.site),
      legacy_posts,
      assets,
      markdown_posts: {},
    };
    if (typeof data.about_html === 'string') release.about_html = data.about_html;
    if (typeof data.about_markdown === 'string' && data.about_markdown.length <= 1_000_000)
      release.about_markdown = data.about_markdown;
    await env.CONTENT.put(`releases/${release.id}.json`, JSON.stringify(release));
    const saved = await env.CONTENT.put(
      'state/published.json',
      JSON.stringify({ id: release.id }),
      { onlyIf: { etagDoesNotMatch: '*' } },
    );
    if (!saved) throw new HttpError(409, '网站已迁移。');
    return json({ ok: true, articles: release.legacy_posts.length });
  }
  throw new HttpError(404, 'Not found');
}
export async function deploymentSettings(
  env: CloudInkEnv,
): Promise<{ configured: boolean; managed: boolean }> {
  if (env.browserPublishing) return { configured: true, managed: true };
  return {
    configured: !!env.WORKERS_DEPLOY_HOOK || !!(await env.CONTENT.head('private/deploy-hook.json')),
    managed: !!env.WORKERS_DEPLOY_HOOK,
  };
}

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
  validateSite,
  type Publishing,
  type Release,
} from './models';
export async function currentRelease(env: CloudInkEnv): Promise<Release> {
  const pointer = await readJson<{ id: string }>(env.STORAGE, 'state/published.json');
  if (!pointer) throw new HttpError(503, '网站内容尚未初始化，请完成后台首次设置。');
  const release = await readJson<Release>(env.STORAGE, `releases/${pointer.id}.json`);
  if (!release) throw new HttpError(503, '网站内容版本缺失，请联系维护者。');
  return release;
}
function busy(state: Publishing): boolean {
  return ['queued', 'building', 'built'].includes(state.status);
}
export async function publishStatus(env: CloudInkEnv): Promise<Publishing | null> {
  const obj = await env.STORAGE.get('state/pending.json');
  if (!obj) return null;
  const state = await obj.json<Publishing>();
  if (!busy(state)) return state;
  const pointer = await readJson<{ id: string }>(env.STORAGE, 'state/published.json');
  if (pointer?.id === state.release_id) state.status = 'deployed';
  if (busy(state) && Date.now() - Date.parse(state.started_at) > 30 * 60_000)
    return (await cancelBrowserPublish(env, state.release_id)).json<Publishing>();
  if (state.status === 'deployed' || state.status === 'failed')
    await env.STORAGE.put('state/pending.json', JSON.stringify(state), {
      onlyIf: { etagMatches: obj.etag },
    });
  return state;
}
export async function publish(request: Request, env: CloudInkEnv): Promise<Response> {
  const data = await jsonInput(request, 4096);
  await publishStatus(env);
  const previous = await env.STORAGE.get('state/pending.json');
  if (previous && busy(await previous.json<Publishing>()))
    throw new HttpError(409, '上一次发布还在进行中，请等待完成。');
  const base = await currentRelease(env);
  const release: Release = structuredClone(base);
  release.id = crypto.randomUUID();
  release.created_at = new Date().toISOString();
  if (typeof data.slug === 'string') {
    const slug = validSlug(data.slug),
      draft = await env.STORAGE.get(`drafts/${slug}.md`);
    if (!draft) throw new HttpError(404, '请先保存这篇文章的草稿。');
    if (data.etag !== draft.etag)
      throw new HttpError(409, '文章刚刚发生了修改，请保存最新版本后再发布。');
    const parsed = parseSource(await draft.text());
    parsed.front_matter.draft = false;
    if (base.markdown_posts[slug])
      parsed.front_matter.updated = new Date().toISOString().slice(0, 10);
    release.markdown_posts[slug] = serializeDraft(parsed);
  } else if (typeof data.unpublish === 'string') {
    const slug = validSlug(data.unpublish);
    delete release.markdown_posts[slug];
  } else if (data.settings === true) {
    const site = await readJson<unknown>(env.STORAGE, 'draft-site.json');
    if (!site) throw new HttpError(400, '请先保存网站信息。');
    release.site = validateSite(site);
    if (release.site.about !== undefined) {
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
  pending.files = requiredPages(release);
  if (pending.files.length > 750) throw new HttpError(413, '当前网页数量超过发布限制。');
  const locked = await env.STORAGE.put('state/pending.json', JSON.stringify(pending), {
    onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
  });
  if (!locked) throw new HttpError(409, '另一个发布正在启动，请刷新后重试。');
  try {
    await env.STORAGE.put(`releases/${release.id}.json`, JSON.stringify(release));
    await claimBrowserPublication(env, pending);
    return json({ ...pending, browser_release: release }, 202);
  } catch {
    await cancelBrowserPublish(env, release.id);
    throw new HttpError(503, '发布暂时未能准备好；草稿和线上版本已保留，请重试。');
  }
}

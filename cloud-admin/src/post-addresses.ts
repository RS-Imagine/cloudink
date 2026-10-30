import type { CloudInkEnv } from './env';
import { draftSummary } from './post-metadata';
import {
  HttpError,
  json,
  jsonInput,
  parseSource,
  readJson,
  serializeDraft,
  validSlug,
  type Draft,
  type Publishing,
  type Release,
} from './models';

export function postRedirects(release: Release): Record<string, string> {
  const redirects: Record<string, string> = Object.create(null);
  for (const [slug, source] of Object.entries(release.markdown_posts)) {
    const draft = parseSource(source);
    if (draft.front_matter.draft) continue;
    for (const alias of draft.front_matter.aliases || []) {
      if (alias === slug) continue;
      if (Object.hasOwn(release.markdown_posts, alias) || (redirects[alias] && redirects[alias] !== slug))
        throw new HttpError(409, '文章地址或旧链接已被其他文章占用：' + alias);
      redirects[alias] = slug;
    }
  }
  if (Object.keys(redirects).length > 2000) throw new HttpError(413, '旧文章地址超过 2000 个。');
  return redirects;
}
export function withAddress(draft: Draft, slug: string): Draft {
  const aliases = [...new Set([...(draft.front_matter.aliases || []), draft.front_matter.slug])]
    .filter((alias) => alias !== slug);
  if (aliases.length > 100) throw new HttpError(400, '这篇文章已保留 100 个旧地址，不能继续改址。');
  return {
    ...draft,
    front_matter: { ...draft.front_matter, slug, aliases, draft: true },
  };
}
export async function addressTarget(
  storage: R2Bucket,
  release: Release,
  from: string,
  to: string,
): Promise<R2Object | null> {
  validSlug(to);
  if (from === to) throw new HttpError(400, '新地址与当前地址相同。');
  const redirect = postRedirects(release)[to];
  if (Object.hasOwn(release.markdown_posts, to) || (redirect && redirect !== from))
    throw new HttpError(409, '这个文章地址已被占用，请换一个。');
  const target = await storage.head(`drafts/${to}.md`);
  if (target && !target.customMetadata?.deleted)
    throw new HttpError(409, '这个文章地址已被其他草稿占用，请换一个。');
  return target;
}
export async function assertWritableAddress(storage: R2Bucket, slug: string): Promise<void> {
  const pointer = await readJson<{ postRedirects?: Record<string, string> }>(
    storage,
    'state/published.json',
  );
  if (pointer?.postRedirects && Object.hasOwn(pointer.postRedirects, slug))
    throw new HttpError(409, '这篇文章已修改地址，请重新打开文章，旧链接会自动跳转。');
  const state = await readJson<Publishing>(storage, 'state/pending.json');
  if (state?.rename?.to === slug && ['queued', 'building', 'built'].includes(state.status))
    throw new HttpError(409, '这个地址正在用于文章改址，请等待发布完成。');
}
export async function retiredDraft(
  storage: R2Bucket,
  slug: string,
  etag: string,
  to: string,
): Promise<void> {
  const saved = await storage.put(
    `drafts/${slug}.md`,
    serializeDraft({
      front_matter: { title: '已改址', slug, date: '2000-01-01', description: '', draft: true },
      body_markdown: '',
    }),
    {
      onlyIf: { etagMatches: etag },
      customMetadata: { title: '已改址', deleted: 'true', renamedTo: to, renameSourceEtag: etag },
    },
  );
  if (!saved) throw new HttpError(409, '原稿已变化，新的原稿仍保留，请重新打开。');
}
export async function assertRenameUnchanged(storage: R2Bucket, state: Publishing): Promise<void> {
  if (!state.rename) return;
  const { from, to, etag, targetEtag } = state.rename;
  const source = await storage.head(`drafts/${from}.md`);
  const target = await storage.head(`drafts/${to}.md`);
  if (
    !source || source.etag !== etag ||
    source.customMetadata?.deleted ||
    (target?.etag || null) !== targetEtag
  )
    throw new HttpError(409, '文章或目标地址在改址期间发生了变化，请重新打开文章后重试。');
}
export async function finishRename(
  storage: R2Bucket,
  state: Publishing,
  knownRelease?: Release,
): Promise<void> {
  if (!state.rename) return;
  const { from, to, etag, targetEtag } = state.rename;
  const target = await storage.head(`drafts/${to}.md`);
  if (target?.customMetadata?.renameRelease !== state.release_id) {
    const release = knownRelease || await readJson<Release>(storage, `releases/${state.release_id}.json`);
    const published = release?.markdown_posts[to];
    if (!published) throw new HttpError(503, '改址后的原稿尚未就绪，请稍后重试。');
    const draft = parseSource(published);
    draft.front_matter.draft = true;
    const saved = await storage.put(`drafts/${to}.md`, serializeDraft(draft), {
      onlyIf: targetEtag ? { etagMatches: targetEtag } : { etagDoesNotMatch: '*' },
      customMetadata: { ...(await draftSummary(draft)), renameRelease: state.release_id },
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    });
    if (!saved) throw new HttpError(503, '新地址原稿正在恢复，请稍后重试；已发布正文仍保留。');
  }
  const source = await storage.head(`drafts/${from}.md`);
  if (source && !source.customMetadata?.deleted && source.etag === etag)
    await retiredDraft(storage, from, etag, to);
}
export async function renameDraft(
  request: Request,
  env: CloudInkEnv,
  slug: string,
  release: Release,
): Promise<Response> {
  const input = await jsonInput(request, 4096);
  if (typeof input.slug !== 'string') throw new HttpError(400, '请填写新的文章地址。');
  const to = validSlug(input.slug);
  const state = await readJson<Publishing>(env.STORAGE, 'state/pending.json');
  if (state && ['queued', 'building', 'built'].includes(state.status))
    throw new HttpError(409, '发布正在进行，请等待完成后再修改地址。');
  if (Object.hasOwn(release.markdown_posts, slug))
    throw new HttpError(409, '已发布文章请使用“修改地址并发布”。');
  const source = await env.STORAGE.get(`drafts/${slug}.md`);
  // Recover a lost success response without creating a second article.
  if (
    source?.customMetadata?.deleted &&
    source.customMetadata.renamedTo === to &&
    source.customMetadata.renameSourceEtag === input.etag
  ) {
    const moved = await env.STORAGE.get(`drafts/${to}.md`);
    if (moved && !moved.customMetadata?.deleted &&
      moved.customMetadata?.renameFrom === slug && moved.customMetadata?.renameSourceEtag === input.etag) {
      const body = await moved.text();
      return json({ draft: parseSource(body), source: body, etag: moved.etag });
    }
  }
  await assertWritableAddress(env.STORAGE, slug);
  if (!source || source.customMetadata?.deleted) throw new HttpError(404, '草稿不存在。');
  if (typeof input.etag !== 'string' || source.etag !== input.etag)
    throw new HttpError(409, '文章已修改，请重新打开后再修改地址。');
  if (source.size > 2_000_000) throw new HttpError(413, '原稿超过地址修改的大小限制。');
  const draft = withAddress(parseSource(await source.text()), to);
  const body = serializeDraft(draft);
  const prior = await env.STORAGE.get(`drafts/${to}.md`);
  if (
    prior &&
    !prior.customMetadata?.deleted &&
    prior.customMetadata?.renameFrom === slug &&
    prior.customMetadata?.renameSourceEtag === source.etag &&
    (await prior.text()) === body
  ) {
    await retiredDraft(env.STORAGE, slug, source.etag, to);
    return json({ draft, source: body, etag: prior.etag });
  }
  const target = await addressTarget(env.STORAGE, release, slug, to);
  const saved = await env.STORAGE.put(`drafts/${to}.md`, body, {
    onlyIf: target ? { etagMatches: target.etag } : { etagDoesNotMatch: '*' },
    customMetadata: {
      ...(await draftSummary(draft)),
      renameFrom: slug,
      renameSourceEtag: source.etag,
    },
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  });
  if (!saved) throw new HttpError(409, '目标地址刚刚被使用，请换一个。');
  await retiredDraft(env.STORAGE, slug, source.etag, to);
  return json({ draft, source: body, etag: saved.etag });
}

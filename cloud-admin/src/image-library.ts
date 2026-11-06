import { managedImageKeys, localImageKeys, IMAGE_REFERENCE_VERSION } from './image-references';
export { managedImageKeys } from './image-references';
import { parentImageKey, imagePresentation, IMAGE_WIDTHS } from './image-variants';
import type { CloudInkEnv } from './env';
import { HttpError, json, jsonInput, readJson, type Publishing, type Release } from './models';
import { validImageKey } from './media';

const MAX_SOURCES = 2000;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_UNINDEXED = 30;
export interface ImageReference {
  kind: 'published' | 'draft' | 'settings' | 'pending';
  title: string;
  slug?: string;
}
export function imageReferenceMetadata(source: string): Record<string, string> {
  const value = JSON.stringify(managedImageKeys(source));
  return {
    image_refs_version: IMAGE_REFERENCE_VERSION,
    ...(new TextEncoder().encode(value).byteLength <= 600 ? { image_refs: value } : {}),
  };
}
export async function ensureManagedImages(
  storage: R2Bucket,
  source: string | Iterable<string>,
  origin: string,
): Promise<void> {
  const needed = new Set<string>();
  for (const text of typeof source === 'string' ? [source] : source)
    for (const key of await localImageKeys(text, origin)) needed.add(key);
  if (!needed.size) return;
  // Small reference sets use cheaper Class B HEADs instead of a Class A
  // bucket scan. Large sets keep the bounded LIST path.
  if (needed.size <= 12) {
    const found = await Promise.all([...needed].map((key) => storage.head(key)));
    if (found.some((object) => !object))
      throw new HttpError(
        400,
        '内容引用了已经删除或尚未上传的图片，请移除该链接或重新上传后保存。',
      );
    return;
  }
  let cursor: string | undefined;
  do {
    const page = await storage.list({ prefix: 'uploads/', cursor, limit: 1000 });
    for (const object of page.objects) needed.delete(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && needed.size);
  if (needed.size)
    throw new HttpError(400, '内容引用了已经删除或尚未上传的图片，请移除该链接或重新上传后保存。');
}
async function references(
  storage: R2Bucket,
  keys: string[],
  check?: { reindexRequired: boolean },
): Promise<Map<string, ImageReference[]>> {
  const result = new Map(keys.map((key) => [key, [] as ImageReference[]]));
  if (!keys.length) return result;
  let bytes = 0,
    count = 0,
    unindexed = 0;
  function add(imageKeys: string[], reference: ImageReference): void {
    for (const key of imageKeys) {
      const refs = result.get(parentImageKey(key));
      if (
        refs &&
        !refs.some(
          (r) =>
            r.kind === reference.kind && r.slug === reference.slug && r.title === reference.title,
        )
      )
        refs.push(reference);
    }
  }
  function source(text: string, reference: ImageReference): void {
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_TEXT_BYTES)
      throw new HttpError(413, '引用内容超过图片管理检查上限，无法安全判断图片是否可删除。');
    add(managedImageKeys(text), reference);
  }
  async function release(id: string, kind: 'published' | 'pending'): Promise<void> {
    const object = await storage.get(`releases/${id}.json`);
    if (!object || object.size > 16_000_000)
      throw new HttpError(503, '发布版本无法完整读取，暂时不能安全检查图片引用。');
    const data = await object.json<Release>();
    for (const [slug, text] of Object.entries(data.markdown_posts))
      source(text, { kind, slug, title: slug });
    for (const [slug, text] of Object.entries(data.markdown_shorts || {}))
      source(text, { kind, slug, title: slug });
    source(JSON.stringify(data.site), {
      kind: 'settings',
      title: kind === 'published' ? '线上网站设置' : '待发布网站设置',
    });
    if (data.about_markdown) source(data.about_markdown, { kind: 'settings', title: '关于页面' });
  }
  const pointer = await readJson<{ id: string }>(storage, 'state/published.json');
  if (pointer) await release(pointer.id, 'published');
  const pending = await readJson<Publishing>(storage, 'state/pending.json');
  if (
    pending &&
    ['queued', 'building', 'built'].includes(pending.status) &&
    pending.release_id !== pointer?.id
  )
    await release(pending.release_id, 'pending');
  const settings = await storage.get('draft-site.json');
  if (settings) {
    if (settings.size > 500_000) throw new HttpError(413, '网站设置过大，无法安全检查图片引用。');
    source(await settings.text(), { kind: 'settings', title: '待发布网站设置' });
  }
  let cursor: string | undefined;
  do {
    const page = await storage.list({
      prefix: 'drafts/',
      cursor,
      limit: 1000,
      include: ['customMetadata'],
    });
    for (const object of page.objects) {
      if (++count > MAX_SOURCES)
        throw new HttpError(413, '原稿超过 2000 篇，无法完整检查引用；图片不会被删除。');
      if (object.customMetadata?.deleted) continue;
      const slug = object.key.match(/^drafts\/([A-Za-z0-9_-]{1,100})\.md$/)?.[1];
      if (!slug) throw new HttpError(503, '原稿目录包含无法识别的对象，无法安全检查图片引用。');
      const ref: ImageReference = {
        kind: 'draft',
        title: object.customMetadata?.title || slug,
        slug,
      };
      const currentIndex = object.customMetadata?.image_refs_version === IMAGE_REFERENCE_VERSION;
      if (!currentIndex && check) check.reindexRequired = true;
      const indexed = currentIndex ? object.customMetadata?.image_refs : undefined;
      if (indexed !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(indexed);
        } catch {
          throw new HttpError(503, '图片引用索引无效，请重新保存原稿。');
        }
        if (
          !Array.isArray(parsed) ||
          !parsed.every((key) => typeof key === 'string' && validImageKey(key))
        )
          throw new HttpError(503, '图片引用索引无效，请重新保存原稿。');
        add(parsed, ref);
      } else {
        if (++unindexed > MAX_UNINDEXED)
          throw new HttpError(413, '旧原稿较多，暂时无法完成引用检查；为避免误删，图片会保留。');
        if (bytes + object.size > MAX_TEXT_BYTES)
          throw new HttpError(413, '原稿超过图片管理检查上限，图片不会被删除。');
        const body = await storage.get(object.key);
        if (!body) throw new HttpError(409, '原稿正在变化，请刷新图片库后重试。');
        source(await body.text(), ref);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Short drafts ("短记") live under shorts/ and can also embed images.
  cursor = undefined;
  do {
    const page = await storage.list({
      prefix: 'shorts/',
      cursor,
      limit: 1000,
      include: ['customMetadata'],
    });
    for (const object of page.objects) {
      if (++count > MAX_SOURCES)
        throw new HttpError(413, '原稿超过 2000 篇，无法完整检查引用；图片不会被删除。');
      if (object.customMetadata?.deleted) continue;
      const slug = object.key.match(/^shorts\/([A-Za-z0-9_-]{1,100})\.md$/)?.[1];
      if (!slug) throw new HttpError(503, '短记目录包含无法识别的对象，无法安全检查图片引用。');
      const ref: ImageReference = { kind: 'draft', title: slug, slug };
      const currentIndex = object.customMetadata?.image_refs_version === IMAGE_REFERENCE_VERSION;
      if (!currentIndex && check) check.reindexRequired = true;
      const indexed = currentIndex ? object.customMetadata?.image_refs : undefined;
      if (indexed !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(indexed);
        } catch {
          throw new HttpError(503, '图片引用索引无效，请重新保存原稿。');
        }
        if (
          !Array.isArray(parsed) ||
          !parsed.every((key) => typeof key === 'string' && validImageKey(key))
        )
          throw new HttpError(503, '图片引用索引无效，请重新保存原稿。');
        add(parsed, ref);
      } else {
        if (++unindexed > MAX_UNINDEXED * 3)
          throw new HttpError(413, '旧原稿较多，暂时无法完成引用检查；为避免误删，图片会保留。');
        if (bytes + object.size > MAX_TEXT_BYTES)
          throw new HttpError(413, '原稿超过图片管理检查上限，图片不会被删除。');
        const body = await storage.get(object.key);
        if (!body) throw new HttpError(409, '原稿正在变化，请刷新图片库后重试。');
        source(await body.text(), ref);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return result;
}
async function reindexImages(request: Request, storage: R2Bucket): Promise<Response> {
  const input = await jsonInput(request, 4096);
  const prefix =
    input.prefix === 'shorts/'
      ? 'shorts/'
      : input.prefix === undefined || input.prefix === 'drafts/'
        ? 'drafts/'
        : '';
  if (
    !prefix ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 2048))
  )
    throw new HttpError(400, '引用索引分页参数不正确。');
  const page = await storage.list({
    prefix,
    cursor: input.cursor as string | undefined,
    limit: 8,
    include: ['customMetadata'],
  });
  let updated = 0;
  for (const object of page.objects) {
    if (
      object.customMetadata?.deleted ||
      object.customMetadata?.image_refs_version === IMAGE_REFERENCE_VERSION
    )
      continue;
    if (
      !/^(?:drafts|shorts)\/[A-Za-z0-9_-]{1,100}\.md$/.test(object.key) ||
      object.size > 2_100_000
    )
      throw new HttpError(413, '原稿格式或大小超出引用索引更新范围；图片仍受保护。');
    const body = await storage.get(object.key);
    if (!body || body.etag !== object.etag)
      throw new HttpError(409, '原稿已变化，请重新更新索引。');
    const text = await body.text();
    const saved = await storage.put(object.key, text, {
      onlyIf: { etagMatches: body.etag },
      customMetadata: { ...body.customMetadata, ...imageReferenceMetadata(text) },
      httpMetadata: body.httpMetadata,
    });
    if (!saved) throw new HttpError(409, '原稿已变化，请重新更新索引。');
    updated++;
  }
  return json({
    updated,
    next: page.truncated
      ? { prefix, cursor: page.cursor }
      : prefix === 'drafts/'
        ? { prefix: 'shorts/' }
        : null,
  });
}
export async function imageLibraryRoute(
  request: Request,
  env: CloudInkEnv,
  path: string,
): Promise<Response | null> {
  if (path === '/api/images/reindex' && request.method === 'POST')
    return reindexImages(request, env.STORAGE);
  if (path !== '/api/images') return null;
  if (request.method === 'GET') {
    const cursor = new URL(request.url).searchParams.get('cursor');
    let after: [number, string] | null = null;
    if (cursor) {
      try {
        const value: unknown = JSON.parse(cursor);
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          typeof value[0] !== 'number' ||
          !Number.isFinite(value[0]) ||
          typeof value[1] !== 'string' ||
          !validImageKey(value[1])
        )
          throw new Error('invalid cursor');
        after = [value[0], value[1]];
      } catch {
        throw new HttpError(400, '分页位置不正确。');
      }
    }
    const catalog: R2Object[] = [];
    let storageCursor: string | undefined;
    do {
      const page = await env.STORAGE.list({
        prefix: 'uploads/',
        cursor: storageCursor,
        limit: 1000,
        include: ['httpMetadata', 'customMetadata'],
      });
      catalog.push(...page.objects);
      if (
        catalog.length > 8000 ||
        catalog.filter((item) => parentImageKey(item.key) === item.key).length > 2000
      )
        throw new HttpError(413, '当前图片超过 2000 张，暂时无法在网页图片库完整管理。');
      storageCursor = page.truncated ? page.cursor : undefined;
    } while (storageCursor);
    const remaining = catalog.filter(
      (object) =>
        validImageKey(object.key) &&
        parentImageKey(object.key) === object.key &&
        /^image\/(?:jpeg|png|webp|gif|avif|svg\+xml|x-icon)$/.test(
          object.httpMetadata?.contentType || '',
        ) &&
        (!after ||
          object.uploaded.getTime() < after[0] ||
          (object.uploaded.getTime() === after[0] && object.key > after[1])),
    );
    remaining.sort(
      (a, b) =>
        b.uploaded.getTime() - a.uploaded.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    const completeCatalog = new URL(request.url).searchParams.get('catalog') === '1';
    const images = completeCatalog ? remaining : remaining.slice(0, 24),
      last = images.at(-1);
    const nextCursor =
      remaining.length > images.length && last
        ? JSON.stringify([last.uploaded.getTime(), last.key])
        : null;
    const families = new Map<string, R2Object[]>();
    for (const item of catalog) {
      const parent = parentImageKey(item.key);
      if (parent === item.key) continue;
      const family = families.get(parent) || [];
      family.push(item);
      families.set(parent, family);
    }
    const check = { reindexRequired: false };
    let refs = new Map<string, ImageReference[]>(),
      referenceError = '';
    try {
      refs = await references(
        env.STORAGE,
        images.map((object) => object.key),
        check,
      );
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      referenceError = error.message;
    }
    return json({
      images: images.map((object) => ({
        key: object.key,
        name: object.customMetadata?.name || object.key.split('/').pop(),
        url: `/images/${object.key}`,
        size: object.size,
        canOptimize:
          object.size >= 80_000 &&
          /^image\/(?:jpeg|png|webp)$/.test(object.httpMetadata?.contentType || '') &&
          object.customMetadata?.optimization !== 'skipped' &&
          (object.customMetadata?.optimization === 'processing' || !families.has(object.key)),
        optimization: object.customMetadata?.optimization || '',
        ...imagePresentation(object, families.get(object.key) || []),
        uploaded: object.uploaded.toISOString(),
        etag: object.etag,
        references: refs.get(object.key) || [],
      })),
      reindexRequired: check.reindexRequired,
      referencesChecked: !referenceError,
      referenceError,
      cursor: nextCursor,
      catalog: completeCatalog,
    });
  }
  if (request.method === 'DELETE') {
    const input = await jsonInput(request, 4096);
    if (typeof input.key !== 'string' || !validImageKey(input.key))
      throw new HttpError(400, '图片路径不正确。');
    if (parentImageKey(input.key) !== input.key)
      throw new HttpError(400, '请从图片库删除整张图片。');
    const object = await env.STORAGE.head(input.key);
    if (!object) throw new HttpError(404, '图片已经不存在，请刷新图片库。');
    if (input.etag !== object.etag) throw new HttpError(409, '图片已变化，请刷新图片库后重试。');
    const pending = await readJson<Publishing>(env.STORAGE, 'state/pending.json');
    if (pending && ['queued', 'building', 'built'].includes(pending.status))
      throw new HttpError(409, '网站正在发布，请等待完成或取消发布后再删除图片。');
    const refs = (await references(env.STORAGE, [input.key])).get(input.key) || [];
    if (refs.length)
      return json({ error: '图片仍被文章或网站设置引用，请先处理引用。', references: refs }, 409);
    await env.STORAGE.delete([
      ...IMAGE_WIDTHS.map((width) => input.key + '.w' + width + '.webp'),
      input.key,
    ]);
    return json({ deleted: true, key: input.key });
  }
  throw new HttpError(405, '请求方式不正确。');
}

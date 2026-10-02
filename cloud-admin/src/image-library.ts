import type { CloudInkEnv } from './env';
import { HttpError, json, jsonInput, readJson, type Publishing, type Release } from './models';
import { validImageKey } from './media';

const MAX_SOURCES = 2000;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_UNINDEXED = 30;
export interface ImageReference {
  kind: 'published' | 'draft' | 'history' | 'settings' | 'pending';
  title: string;
  slug?: string;
}
export function managedImageKeys(source: string): string[] {
  // Conservative matching also protects raw HTML and reference-style Markdown,
  // absolute site URLs, encoded paths, and literal mentions of a stored key.
  const normalized = source
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code: string) => {
      const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return value > 0 && value < 128 ? String.fromCharCode(value) : '';
    })
    .replace(/&sol;/g, '/');
  const matches =
    normalized.match(/uploads\/[A-Za-z0-9_./-]+\.(?:jpeg|jpg|png|webp|gif|avif)\b/g) || [];
  return [...new Set(matches.filter(validImageKey))];
}
export function imageReferenceMetadata(source: string): Record<string, string> {
  const value = JSON.stringify(managedImageKeys(source));
  // Metadata is bounded; oversized reference sets are checked from the source.
  return new TextEncoder().encode(value).byteLength <= 600 ? { image_refs: value } : {};
}
export async function ensureManagedImages(
  storage: R2Bucket,
  source: string | Iterable<string>,
): Promise<void> {
  const needed = new Set<string>();
  for (const text of typeof source === 'string' ? [source] : source)
    for (const key of managedImageKeys(text)) needed.add(key);
  if (!needed.size) return;
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
): Promise<Map<string, ImageReference[]>> {
  const result = new Map(keys.map((key) => [key, [] as ImageReference[]]));
  if (!keys.length) return result;
  let bytes = 0,
    count = 0,
    unindexed = 0;
  function add(imageKeys: string[], reference: ImageReference): void {
    for (const key of imageKeys) {
      const refs = result.get(key);
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
  for (const prefix of ['drafts/', 'history/']) {
    let cursor: string | undefined;
    do {
      const page = await storage.list({ prefix, cursor, limit: 1000, include: ['customMetadata'] });
      for (const object of page.objects) {
        if (++count > MAX_SOURCES)
          throw new HttpError(413, '原稿与历史超过 2000 个，无法完整检查引用；图片不会被删除。');
        if (object.customMetadata?.deleted) continue;
        const slug = object.key.match(
          /^(?:drafts|history)\/([A-Za-z0-9_-]{1,100})(?:\.md|\/)/,
        )?.[1];
        if (!slug) throw new HttpError(503, '原稿目录包含无法识别的对象，无法安全检查图片引用。');
        const ref: ImageReference = {
          kind: prefix === 'drafts/' ? 'draft' : 'history',
          title: prefix === 'drafts/' ? object.customMetadata?.title || slug : slug,
          slug,
        };
        const indexed = object.customMetadata?.image_refs;
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
            throw new HttpError(
              413,
              '旧原稿与历史较多，暂时无法完成引用检查；为避免误删，图片会保留。',
            );
          if (bytes + object.size > MAX_TEXT_BYTES)
            throw new HttpError(413, '原稿超过图片管理检查上限，图片不会被删除。');
          const body = await storage.get(object.key);
          if (!body) throw new HttpError(409, '原稿正在变化，请刷新图片库后重试。');
          source(await body.text(), ref);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return result;
}
export async function imageLibraryRoute(
  request: Request,
  env: CloudInkEnv,
  path: string,
): Promise<Response | null> {
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
      if (catalog.length > 2000)
        throw new HttpError(413, '当前图片超过 2000 张，暂时无法在网页图片库完整管理。');
      storageCursor = page.truncated ? page.cursor : undefined;
    } while (storageCursor);
    const remaining = catalog.filter(
      (object) =>
        validImageKey(object.key) &&
        /^image\/(?:jpeg|png|webp|gif|avif)$/.test(object.httpMetadata?.contentType || '') &&
        (!after ||
          object.uploaded.getTime() < after[0] ||
          (object.uploaded.getTime() === after[0] && object.key > after[1])),
    );
    remaining.sort(
      (a, b) =>
        b.uploaded.getTime() - a.uploaded.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    const images = remaining.slice(0, 24),
      last = images.at(-1);
    const nextCursor =
      remaining.length > images.length && last
        ? JSON.stringify([last.uploaded.getTime(), last.key])
        : null;
    let refs = new Map<string, ImageReference[]>(),
      referenceError = '';
    try {
      refs = await references(
        env.STORAGE,
        images.map((object) => object.key),
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
        uploaded: object.uploaded.toISOString(),
        etag: object.etag,
        references: refs.get(object.key) || [],
      })),
      referencesChecked: !referenceError,
      referenceError,
      cursor: nextCursor,
    });
  }
  if (request.method === 'DELETE') {
    const input = await jsonInput(request, 4096);
    if (typeof input.key !== 'string' || !validImageKey(input.key))
      throw new HttpError(400, '图片路径不正确。');
    const object = await env.STORAGE.head(input.key);
    if (!object) throw new HttpError(404, '图片已经不存在，请刷新图片库。');
    if (input.etag !== object.etag) throw new HttpError(409, '图片已变化，请刷新图片库后重试。');
    const pending = await readJson<Publishing>(env.STORAGE, 'state/pending.json');
    if (pending && ['queued', 'building', 'built'].includes(pending.status))
      throw new HttpError(409, '网站正在发布，请等待完成或取消发布后再删除图片。');
    const refs = (await references(env.STORAGE, [input.key])).get(input.key) || [];
    if (refs.length)
      return json(
        { error: '图片仍被文章、历史版本或网站设置引用，请先处理引用。', references: refs },
        409,
      );
    await env.STORAGE.delete(input.key);
    return json({ deleted: true, key: input.key });
  }
  throw new HttpError(405, '请求方式不正确。');
}

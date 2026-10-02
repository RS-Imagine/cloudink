import type { CloudInkEnv } from './env';
import { digest } from './auth';
import { currentRelease } from './publishing';
import {
  HttpError,
  json,
  jsonInput,
  limitedBody,
  parseSource,
  serializeDraft,
  validateSite,
  type SiteConfig,
} from './models';
import { MAX_IMAGE, imageType, validImageKey } from './media';
import { imageReferenceMetadata, ensureManagedImages } from './image-library';

const MAX_TEXT = 8_000_000;
const MAX_MANIFEST = 18_000_000;
const MAX_BACKUP = 100 * 1024 * 1024;
const MAX_FILES = 2000;
interface BackupImage {
  key: string;
  size: number;
  etag: string;
}
interface Backup {
  format: 'cloudink-backup';
  schema_version: 1;
  created_at: string;
  site: SiteConfig;
  files: Record<string, string>;
  images: BackupImage[];
}
async function objects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const result: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ['customMetadata'], limit: 1000 });
    result.push(...page.objects);
    if (result.length > MAX_FILES)
      throw new HttpError(413, '当前数据超过网页备份的数量限制，请通过 Cloudflare R2 备份。');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return result;
}
function historyKey(key: string): boolean {
  return /^history\/[A-Za-z0-9_-]{1,100}\/[a-f0-9-]+\.md$/.test(key);
}
function sourceSlug(key: string): string | null {
  return (
    key.match(/^(?:published|drafts)\/([A-Za-z0-9_-]{1,100})\.md$/)?.[1] ||
    (historyKey(key) ? key.split('/')[1] : null)
  );
}
async function createBackup(env: CloudInkEnv): Promise<Backup> {
  const release = await currentRelease(env);
  const settings = await env.STORAGE.get('draft-site.json');
  const site = settings ? validateSite(await settings.json()) : release.site;
  const files: Record<string, string> = {};
  let textBytes = 0;
  function add(key: string, source: string): void {
    textBytes += new TextEncoder().encode(source).byteLength;
    if (textBytes > MAX_TEXT || Object.keys(files).length >= MAX_FILES)
      throw new HttpError(413, '文字与历史超过网页备份限制，请通过 Cloudflare R2 备份。');
    files[key] = source;
  }
  for (const [slug, source] of Object.entries(release.markdown_posts))
    add(`published/${slug}.md`, source);
  for (const prefix of ['drafts/', 'history/']) {
    for (const object of await objects(env.STORAGE, prefix)) {
      if (object.customMetadata?.deleted) continue;
      if (textBytes + object.size > MAX_TEXT)
        throw new HttpError(413, '文字与历史超过网页备份限制，请通过 Cloudflare R2 备份。');
      const value = await env.STORAGE.get(object.key);
      if (value) add(object.key, await value.text());
    }
  }
  const images: BackupImage[] = [];
  let imageBytes = 0;
  for (const object of await objects(env.STORAGE, 'uploads/')) {
    if (!validImageKey(object.key)) continue;
    imageBytes += object.size;
    if (object.size > MAX_IMAGE || textBytes + imageBytes > MAX_BACKUP)
      throw new HttpError(413, '图片与文字超过 100 MB 网页备份限制，请通过 Cloudflare R2 备份。');
    images.push({ key: object.key, size: object.size, etag: object.httpEtag });
  }
  return {
    format: 'cloudink-backup',
    schema_version: 1,
    created_at: new Date().toISOString(),
    site,
    files,
    images,
  };
}
async function restoreBackup(request: Request, env: CloudInkEnv): Promise<Response> {
  const input = await jsonInput(request, MAX_MANIFEST);
  const backup = input.backup;
  if (!backup || typeof backup !== 'object' || Array.isArray(backup))
    throw new HttpError(400, '备份格式不正确。');
  const value = backup as Record<string, unknown>;
  if (
    value.format !== 'cloudink-backup' ||
    value.schema_version !== 1 ||
    !value.files ||
    typeof value.files !== 'object' ||
    Array.isArray(value.files) ||
    !Array.isArray(value.images)
  )
    throw new HttpError(400, '不支持这份备份，请使用 CloudInk 的“下载网站备份”。');
  const site = validateSite(value.site);
  const files = Object.entries(value.files);
  if (files.length > MAX_FILES || value.images.length > MAX_FILES)
    throw new HttpError(413, '备份文件数量过多。');
  const drafts = new Map<string, string>(),
    histories = new Map<string, string>();
  // Validate the whole manifest before writing. Drafts take precedence over
  // published copies; restored articles never become public automatically.
  for (const [key, source] of files.sort(([a], [b]) => b.localeCompare(a))) {
    const slug = sourceSlug(key);
    if (!slug || typeof source !== 'string') throw new HttpError(400, '备份包含不支持的文件路径。');
    const draft = parseSource(source);
    if (draft.front_matter.slug !== slug)
      throw new HttpError(400, '备份文章地址与文件路径不一致。');
    if (historyKey(key)) histories.set(key, source);
    else {
      draft.front_matter.draft = true;
      drafts.set(slug, serializeDraft(draft));
    }
  }
  let total = 0;
  for (const raw of value.images) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('key' in raw) ||
      typeof raw.key !== 'string' ||
      !validImageKey(raw.key) ||
      !('size' in raw) ||
      typeof raw.size !== 'number' ||
      !Number.isInteger(raw.size) ||
      raw.size < 0 ||
      raw.size > MAX_IMAGE
    )
      throw new HttpError(400, '备份图片信息不正确。');
    total += raw.size;
    if (total > MAX_BACKUP) throw new HttpError(413, '备份图片超过 100 MB。');
    const object = await env.STORAGE.head(raw.key);
    if (!object || object.size !== raw.size)
      throw new HttpError(409, '备份图片尚未恢复完整，请重新选择备份重试。');
  }
  await ensureManagedImages(
    env.STORAGE,
    [site.about || '', ...drafts.values(), ...histories.values()],
    new URL(request.url).origin,
  );
  const oldSettings = await env.STORAGE.get('draft-site.json');
  if (oldSettings && input.settings_etag !== oldSettings.etag)
    throw new HttpError(409, '网站设置已变化，请重新打开设置后恢复。');
  const writes = new Map<string, string>(histories);
  for (const [slug, source] of drafts) writes.set(`drafts/${slug}.md`, source);
  for (const [key, source] of writes) {
    const existing = await env.STORAGE.get(key);
    if (existing && (await existing.text()) !== source)
      throw new HttpError(409, `已有不同内容：${key}。请先导出或处理现有原稿，恢复不会覆盖它。`);
  }
  let restored = 0;
  for (const [key, source] of writes) {
    const draft = parseSource(source),
      matter = draft.front_matter;
    const saved = await env.STORAGE.put(key, source, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      ...(key.startsWith('drafts/')
        ? {
            customMetadata: {
              title: matter.title.slice(0, 120),
              date: matter.date,
              description: matter.description.slice(0, 240),
              ...imageReferenceMetadata(source),
              digest: await digest(
                JSON.stringify([
                  matter.title,
                  matter.slug,
                  matter.date,
                  matter.description,
                  draft.body_markdown,
                ]),
              ),
            },
          }
        : { customMetadata: imageReferenceMetadata(source) }),
    });
    if (saved) restored++;
    else {
      const current = await env.STORAGE.get(key);
      if (!current || (await current.text()) !== source)
        throw new HttpError(409, '另一窗口修改了原稿。已恢复的内容保留，请检查后重试。');
    }
  }
  const settings = await env.STORAGE.put('draft-site.json', JSON.stringify(site), {
    onlyIf: oldSettings ? { etagMatches: oldSettings.etag } : { etagDoesNotMatch: '*' },
  });
  if (!settings) throw new HttpError(409, '原稿已恢复，但网站设置发生了修改，请检查后重试。');
  return json({
    restored,
    drafts: drafts.size,
    history: histories.size,
    site,
    etag: settings.etag,
  });
}
export async function backupRoute(
  request: Request,
  env: CloudInkEnv,
  path: string,
): Promise<Response | null> {
  if (path === '/api/backup' && request.method === 'GET') return json(await createBackup(env));
  if (path === '/api/backup/restore' && request.method === 'POST')
    return restoreBackup(request, env);
  if (path === '/api/backup/image' && request.method === 'PUT') {
    const key = new URL(request.url).searchParams.get('key') || '';
    if (!validImageKey(key)) throw new HttpError(400, '图片路径不正确。');
    const bytes = new Uint8Array(await limitedBody(request, MAX_IMAGE)),
      type = imageType(bytes);
    const saved = await env.STORAGE.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: type.type, cacheControl: 'public, max-age=31536000, immutable' },
    });
    if (!saved) {
      const old = await env.STORAGE.get(key);
      if (
        !old ||
        old.size !== bytes.byteLength ||
        !crypto.subtle.timingSafeEqual(
          await crypto.subtle.digest('SHA-256', bytes),
          await crypto.subtle.digest('SHA-256', await old.arrayBuffer()),
        )
      )
        throw new HttpError(409, '已有同名的不同图片，恢复不会覆盖它。');
    }
    return json({ ok: true });
  }
  return null;
}

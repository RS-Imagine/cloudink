import type { CloudInkEnv } from './env';
import type { Session } from './auth';
import { digest } from './auth';
import { backupSource } from './backup-contract';
import { currentRelease } from './publishing';
import { draftSummary, shortSummary } from './post-metadata';
import { listActiveDrafts } from './draft-catalog';
import { ensureManagedImages } from './image-library';
import { ensureSiteIcon } from './site-icons';
import { ensureHomeIllustration } from './home-illustration';
import { validImageKey } from './media';
import { parentImageKey } from './image-variants';
import { addressSnapshot, assertWritableInSnapshot } from './post-addresses';
import {
  HttpError,
  json,
  jsonInput,
  ownValue,
  readJson,
  parseSource,
  parseShortSource,
  serializeDraft,
  serializeShortDraft,
  validateSite,
  type SiteConfig,
  type Release,
} from './models';

const ROOT = 'backup-tasks/';
const ACTIVE = 'state/backup-task.json';
const MAX_FILES = 2000;
const MAX_TEXT = 8_000_000;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SOURCE = 2_100_000;
const BATCH_BYTES = 1_000_000;
const BATCH_FILES = 32;
const TTL = 24 * 60 * 60_000;
const encoder = new TextEncoder();
interface Entry {
  path: string;
  target?: string;
  size: number;
  hash?: string;
  etag?: string;
}
interface Image {
  key: string;
  size: number;
  etag?: string;
  sha256?: string;
}
interface Item {
  key: string;
  source: string;
  etag: string | null;
  version: string | null;
  unchanged: boolean;
}
interface Chunk {
  items: Item[];
}
interface Task {
  id: string;
  mode: 'export' | 'restore';
  owner: string;
  expires: number;
  phase: 'preflight' | 'applying' | 'complete' | 'cancelled';
  entries: Entry[];
  images: Image[];
  site: SiteConfig;
  fingerprint?: string;
  releaseId?: string;
  createdAt: string;
  preflight: number;
  batches: number;
  applied: number;
  restored: number;
  verifiedImages: number;
  settingsEtag?: string | null;
  settingsVersion?: string | null;
  result?: {
    restored: number;
    drafts: number;
    shorts: number;
    site: SiteConfig;
    etag: string | null;
  };
}
const taskKey = (id: string) => ROOT + id + '/state.json';
const chunkKey = (id: string, batch: number) => ROOT + id + '/chunks/' + batch + '.json';
export interface ActiveBackup {
  id: string;
  expires: number;
}
export async function activeBackup(storage: R2Bucket): Promise<Task | null> {
  const active = await readJson<ActiveBackup>(storage, ACTIVE);
  if (!active || active.expires <= Date.now() || !/^[a-f0-9-]{36}$/.test(active.id)) return null;
  const task = await readJson<Task>(storage, taskKey(active.id));
  return task && task.expires > Date.now() && !['complete', 'cancelled'].includes(task.phase)
    ? task
    : null;
}
function publicTask(task: Task, includeEntries = false) {
  return {
    id: task.id,
    mode: task.mode,
    phase: task.phase,
    expires: task.expires,
    preflight: task.preflight,
    batches: task.batches,
    applied: task.applied,
    verifiedImages: task.verifiedImages,
    imageCount: task.images.length,
    restored: task.restored,
    total: task.entries.length,
    entries: includeEntries ? task.entries.map((entry) => entry.path) : undefined,
    result: task.result,
    manifest:
      includeEntries && task.mode === 'export'
        ? {
            format: 'cloudink-backup',
            schema_version: 1,
            created_at: task.createdAt,
            site: task.site,
            images: task.images,
          }
        : undefined,
  };
}
async function readTask(storage: R2Bucket, id: string, session: Session) {
  const object = await storage.get(taskKey(id));
  if (!object) throw new HttpError(404, '备份任务不存在，请重新选择备份。');
  const task = await object.json<Task>();
  if (task.owner !== session.version)
    throw new HttpError(403, '备份任务属于其他登录版本，请重新开始。');
  if (task.expires <= Date.now())
    throw new HttpError(410, '备份任务已过期，已恢复内容仍保留，请重新开始。');
  return { task, object };
}
async function clearActive(storage: R2Bucket, id: string): Promise<void> {
  const active = await readJson<ActiveBackup>(storage, ACTIVE);
  if (active?.id === id) await storage.delete(ACTIVE);
}
async function checkpoint(storage: R2Bucket, task: Task, etag?: string): Promise<void> {
  const saved = await storage.put(taskKey(task.id), JSON.stringify(task), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
  });
  if (!saved) throw new HttpError(409, '备份任务已变化，请读取最新进度。');
}
async function list(storage: R2Bucket, prefix: string, limit: number): Promise<R2Object[]> {
  const result: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list({ prefix, cursor, limit: 1000, include: ['customMetadata'] });
    result.push(...page.objects);
    if (result.length > limit) throw new HttpError(413, '文件数量超过网页备份限制。');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return result;
}
function textBudget(entries: Entry[]) {
  if (entries.length > MAX_FILES || entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_TEXT)
    throw new HttpError(413, '备份原稿超过 2000 份或 8 MB 限制。');
}
function imageBudget(images: Image[], textBytes: number) {
  const families = new Set<string>();
  let bytes = textBytes;
  if (images.length > 8000) throw new HttpError(413, '备份图片文件数量过多。');
  const keys = new Set<string>();
  for (const image of images) {
    if (
      !image ||
      typeof image.key !== 'string' ||
      !validImageKey(image.key) ||
      !Number.isInteger(image.size) ||
      image.size < 0 ||
      image.size > 10 * 1024 * 1024 ||
      keys.has(image.key)
    )
      throw new HttpError(400, '备份图片清单无效或存在重复路径。');
    keys.add(image.key);
    families.add(parentImageKey(image.key));
    bytes += image.size;
  }
  if (families.size > 2000 || bytes > MAX_BYTES)
    throw new HttpError(413, '备份超过 2000 张图片或 100 MB 限制。');
}
async function start(request: Request, env: CloudInkEnv, session: Session): Promise<Response> {
  const input = await jsonInput(request, 2_500_000);
  if (input.mode !== 'restore' && input.mode !== 'export')
    throw new HttpError(400, '请选择备份或恢复。');
  const prior = await activeBackup(env.STORAGE);
  const active = prior?.owner === session.version ? prior : null;
  const task: Task = {
    id: crypto.randomUUID(),
    owner: session.version,
    expires: Date.now() + TTL,
    mode: input.mode as Task['mode'],
    phase: input.mode === 'restore' ? 'preflight' : 'applying',
    entries: [],
    images: [],
    site: {} as SiteConfig,
    createdAt: new Date().toISOString(),
    preflight: 0,
    batches: 0,
    applied: 0,
    restored: 0,
    verifiedImages: 0,
  };
  if (task.mode === 'restore') {
    const manifest = input.manifest as Record<string, unknown> | undefined;
    if (
      !manifest ||
      manifest.format !== 'cloudink-backup' ||
      manifest.schema_version !== 1 ||
      !Array.isArray(manifest.entries) ||
      !Array.isArray(manifest.images)
    )
      throw new HttpError(400, '备份清单格式无效。');
    task.site = validateSite(manifest.site);
    const entries = manifest.entries as Entry[];
    if (entries.length > MAX_FILES) throw new HttpError(413, '备份原稿数量过多。');
    const chosen = new Map<string, Entry>();
    const seen = new Set<string>();
    for (const entry of entries) {
      const parsed = typeof entry?.path === 'string' ? backupSource(entry.path) : null;
      if (
        !parsed ||
        seen.has(entry.path) ||
        !Number.isInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_SOURCE ||
        typeof entry.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.hash)
      )
        throw new HttpError(400, '备份原稿路径、大小或摘要无效。');
      seen.add(entry.path);
      const target = (parsed.short ? 'shorts/' : 'drafts/') + parsed.slug + '.md';
      if (!chosen.has(target) || /^(?:drafts|shorts)\//.test(entry.path))
        chosen.set(target, { path: entry.path, target, hash: entry.hash, size: entry.size });
    }
    textBudget(entries);
    task.entries = [...chosen.values()].sort((a, b) => a.target!.localeCompare(b.target!));
    task.images = manifest.images as Image[];
    imageBudget(
      task.images,
      entries.reduce((sum, entry) => sum + entry.size, 0),
    );
    task.fingerprint = await digest(
      JSON.stringify({
        entries: task.entries,
        site: task.site,
        images: [...task.images].sort((a, b) => a.key.localeCompare(b.key)),
        settings: input.settings_etag || null,
      }),
    );
    if (active) {
      if (
        active.owner === session.version &&
        active.mode === 'restore' &&
        active.fingerprint === task.fingerprint
      )
        return json(publicTask(active, true));
      throw new HttpError(409, '已有未完成备份任务，请继续原任务或先取消。');
    }
    const settings = await env.STORAGE.get('draft-site.json');
    if (settings && input.settings_etag !== settings.etag)
      throw new HttpError(409, '网站设置已变化，请重新打开设置。');
    task.settingsEtag = settings?.etag || null;
    task.settingsVersion = settings?.version || null;
    if (settings) await settings.body.cancel();
    if (!task.entries.length) task.phase = 'applying';
  } else {
    if (active) {
      if (active.owner === session.version && active.mode === 'export')
        return json(publicTask(active, true));
      throw new HttpError(409, '请先完成或取消当前恢复任务。');
    }
    const release = await currentRelease(env);
    task.releaseId = release.id;
    const settings = await env.STORAGE.get('draft-site.json');
    task.site = settings ? validateSite(await settings.json()) : release.site;
    for (const [slug, source] of Object.entries(release.markdown_posts))
      task.entries.push({
        path: 'published/' + slug + '.md',
        size: encoder.encode(source).byteLength,
      });
    for (const [slug, source] of Object.entries(release.markdown_shorts || {}))
      task.entries.push({
        path: 'published-shorts/' + slug + '.md',
        size: encoder.encode(source).byteLength,
      });
    for (const prefix of ['drafts/', 'shorts/'] as const) {
      for (const object of await listActiveDrafts(env.STORAGE, prefix)) {
        if (!backupSource(object.key) || object.size > MAX_SOURCE)
          throw new HttpError(413, '原稿路径或大小超出网页备份范围。');
        task.entries.push({ path: object.key, size: object.size, etag: object.etag });
      }
    }
    textBudget(task.entries);
    task.images = (await list(env.STORAGE, 'uploads/', 8000))
      .filter((object) => validImageKey(object.key))
      .map((object) => ({ key: object.key, size: object.size, etag: object.httpEtag }));
    imageBudget(
      task.images,
      task.entries.reduce((sum, entry) => sum + entry.size, 0),
    );
  }
  await checkpoint(env.STORAGE, task);
  await env.STORAGE.put(ACTIVE, JSON.stringify({ id: task.id, expires: task.expires }));
  return json(publicTask(task, true), 201);
}
async function readExport(request: Request, env: CloudInkEnv, task: Task): Promise<Response> {
  const input = await jsonInput(request, 4096);
  if (task.mode !== 'export' || task.phase !== 'applying')
    throw new HttpError(409, '这不是可读取的导出任务。');
  const index = input.index;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > task.entries.length)
    throw new HttpError(400, '备份分页位置无效。');
  let next = index as number,
    bytes = 0;
  const files: Record<string, string> = {};
  const selected = task.entries.slice(next, next + BATCH_FILES);
  const release = selected.some((entry) => entry.path.startsWith('published'))
    ? await readJson<Release>(env.STORAGE, 'releases/' + task.releaseId + '.json')
    : null;
  for (const entry of selected) {
    if (Object.keys(files).length && bytes + entry.size > BATCH_BYTES) break;
    let source: string | undefined;
    if (entry.etag) {
      const object = await env.STORAGE.get(entry.path);
      if (!object || object.etag !== entry.etag || object.customMetadata?.deleted) {
        if (object) await object.body.cancel();
        throw new HttpError(409, '原稿在备份期间发生变化，请取消后重新备份。');
      }
      source = await object.text();
    } else {
      const parsed = backupSource(entry.path)!;
      source = ownValue(
        parsed.short ? release?.markdown_shorts : release?.markdown_posts,
        parsed.slug,
      );
    }
    if (typeof source !== 'string' || encoder.encode(source).byteLength !== entry.size)
      throw new HttpError(409, '备份快照缺失或发生变化，请重新备份。');
    files[entry.path] = source;
    bytes += entry.size;
    next++;
  }
  return json({ files, next: next < task.entries.length ? next : null });
}
async function preflight(
  request: Request,
  env: CloudInkEnv,
  task: Task,
  etag: string,
): Promise<Response> {
  const input = await jsonInput(request, 4_500_000);
  if (task.mode !== 'restore') throw new HttpError(409, '这不是恢复任务。');
  if (!Number.isInteger(input.index) || (input.index as number) < 0)
    throw new HttpError(400, '恢复批次位置无效。');
  if ((input.index as number) < task.preflight) return json(publicTask(task));
  if (task.phase !== 'preflight' || input.index !== task.preflight)
    throw new HttpError(409, '请按顺序预检恢复内容。');
  if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files))
    throw new HttpError(400, '请提供当前批次原稿。');
  const files = input.files as Record<string, unknown>,
    names = Object.keys(files);
  if (!names.length || names.length > BATCH_FILES)
    throw new HttpError(413, '每批最多处理 32 份原稿。');
  const entries = task.entries.slice(task.preflight, task.preflight + names.length);
  if (entries.length !== names.length || entries.some((entry) => !Object.hasOwn(files, entry.path)))
    throw new HttpError(400, '当前批次与备份清单不一致。');
  const size = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (size > BATCH_BYTES && entries.length > 1) throw new HttpError(413, '请缩小当前恢复批次。');
  if (task.verifiedImages !== task.images.length)
    throw new HttpError(409, '请先恢复并核对全部图片。');
  const snapshot = await addressSnapshot(env.STORAGE);
  const chunk: Chunk = { items: [] };
  for (const entry of entries) {
    const raw = files[entry.path];
    if (
      typeof raw !== 'string' ||
      encoder.encode(raw).byteLength !== entry.size ||
      (await digest(raw)) !== entry.hash
    )
      throw new HttpError(400, '原稿与备份摘要不一致。');
    const parsed = backupSource(entry.path)!;
    const draft = parsed.short ? parseShortSource(raw) : parseSource(raw);
    if (draft.front_matter.slug !== parsed.slug)
      throw new HttpError(400, '原稿地址与备份路径不一致。');
    draft.front_matter.draft = true;
    const source = parsed.short
      ? serializeShortDraft(draft as ReturnType<typeof parseShortSource>)
      : serializeDraft(draft as ReturnType<typeof parseSource>);
    if (!parsed.short) assertWritableInSnapshot(snapshot, parsed.slug);
    const existing = await env.STORAGE.get(entry.target!);
    let unchanged = false;
    if (existing?.customMetadata?.renamedTo)
      throw new HttpError(409, '原地址已改址，恢复不会覆盖它。');
    if (existing && !existing.customMetadata?.deleted) {
      unchanged = (await existing.text()) === source;
      if (!unchanged) throw new HttpError(409, '已有不同原稿：' + entry.target);
    }
    if (existing?.customMetadata?.deleted) await existing.body.cancel();
    chunk.items.push({
      key: entry.target!,
      source,
      etag: existing?.etag || null,
      version: existing?.version || null,
      unchanged,
    });
  }
  await ensureManagedImages(
    env.STORAGE,
    chunk.items.map((item) => item.source),
    new URL(request.url).origin,
  );
  await env.STORAGE.put(chunkKey(task.id, task.batches), JSON.stringify(chunk));
  task.batches++;
  task.preflight += entries.length;
  if (task.preflight === task.entries.length) task.phase = 'applying';
  await checkpoint(env.STORAGE, task, etag);
  return json(publicTask(task));
}
async function apply(
  request: Request,
  env: CloudInkEnv,
  task: Task,
  etag: string,
): Promise<Response> {
  const input = await jsonInput(request, 4096);
  if (task.mode !== 'restore' || !Number.isInteger(input.batch) || (input.batch as number) < 0)
    throw new HttpError(400, '恢复批次无效。');
  if ((input.batch as number) < task.applied) return json(publicTask(task));
  if (task.phase !== 'applying' || input.batch !== task.applied || task.applied >= task.batches)
    throw new HttpError(409, '请先完成预检并按顺序恢复。');
  const chunk = await readJson<Chunk>(env.STORAGE, chunkKey(task.id, task.applied));
  if (!chunk) throw new HttpError(409, '恢复预检数据缺失，请重新开始。');
  const snapshot = await addressSnapshot(env.STORAGE);
  await ensureManagedImages(
    env.STORAGE,
    chunk.items.map((item) => item.source),
    new URL(request.url).origin,
  );
  let restored = 0;
  for (const item of chunk.items) {
    const short = item.key.startsWith('shorts/');
    if (!short) assertWritableInSnapshot(snapshot, item.key.slice(7, -3));
    const existing = await env.STORAGE.get(item.key);
    if (existing?.customMetadata?.renamedTo)
      throw new HttpError(409, '原地址已改址，请检查后重新恢复。');
    if (existing && !existing.customMetadata?.deleted && (await existing.text()) === item.source) {
      if (!item.unchanged) restored++;
      continue;
    }
    if (existing?.customMetadata?.deleted) await existing.body.cancel();
    if ((existing?.version || null) !== item.version || (existing?.etag || null) !== item.etag)
      throw new HttpError(409, '原稿在恢复期间发生变化；已完成内容保留，请检查后重试。');
    const draft = short ? parseShortSource(item.source) : parseSource(item.source);
    const saved = await env.STORAGE.put(item.key, item.source, {
      onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' },
      customMetadata: short
        ? await shortSummary(draft as ReturnType<typeof parseShortSource>, item.source, env.STORAGE)
        : await draftSummary(draft as ReturnType<typeof parseSource>, env.STORAGE),
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    });
    if (!saved) throw new HttpError(409, '原稿刚刚发生变化，请重新读取任务进度。');
    restored++;
  }
  task.applied++;
  task.restored += restored;
  await checkpoint(env.STORAGE, task, etag);
  return json(publicTask(task));
}
async function removeChunks(storage: R2Bucket, task: Task): Promise<void> {
  for (let offset = 0; offset < task.batches; offset += 1000) {
    const keys = Array.from({ length: Math.min(1000, task.batches - offset) }, (_, i) =>
      chunkKey(task.id, offset + i),
    );
    await storage.delete(keys);
  }
}
async function finish(
  env: CloudInkEnv,
  task: Task,
  etag: string,
  origin: string,
): Promise<Response> {
  if (task.phase === 'complete') return json(publicTask(task));
  if (
    task.phase !== 'applying' ||
    (task.mode === 'restore' &&
      (task.applied !== task.batches || task.verifiedImages !== task.images.length))
  )
    throw new HttpError(409, '请先完成全部恢复批次。');
  if (task.mode === 'restore') {
    await ensureManagedImages(env.STORAGE, task.site.about || '', origin);
    await ensureSiteIcon(env.STORAGE, task.site);
    await ensureHomeIllustration(env.STORAGE, task.site);
    const old = await env.STORAGE.get('draft-site.json'),
      text = JSON.stringify(task.site);
    let settingsEtag = old?.etag || null;
    if (!old || (await old.text()) !== text) {
      if (
        (old?.version || null) !== task.settingsVersion ||
        (old?.etag || null) !== task.settingsEtag
      )
        throw new HttpError(409, '原稿已恢复，网站设置发生变化；现有设置保留，请检查后重试。');
      const saved = await env.STORAGE.put('draft-site.json', text, {
        onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: '*' },
      });
      if (!saved) throw new HttpError(409, '网站设置刚刚发生变化，请重新读取任务。');
      settingsEtag = saved.etag;
    }
    task.result = {
      restored: task.restored,
      drafts: task.entries.filter((entry) => entry.target?.startsWith('drafts/')).length,
      shorts: task.entries.filter((entry) => entry.target?.startsWith('shorts/')).length,
      site: task.site,
      etag: settingsEtag,
    };
  }
  task.phase = 'complete';
  task.entries = [];
  task.images = [];
  await checkpoint(env.STORAGE, task, etag);
  await removeChunks(env.STORAGE, task);
  await clearActive(env.STORAGE, task.id);
  return json(publicTask(task));
}
async function verifyImages(
  request: Request,
  env: CloudInkEnv,
  task: Task,
  etag: string,
): Promise<Response> {
  const input = await jsonInput(request, 4096);
  if (task.mode !== 'restore' || !Number.isInteger(input.index) || (input.index as number) < 0)
    throw new HttpError(400, '图片核对批次无效。');
  if ((input.index as number) < task.verifiedImages) return json(publicTask(task));
  if (input.index !== task.verifiedImages || !['preflight', 'applying'].includes(task.phase))
    throw new HttpError(409, '请按顺序核对图片。');
  const images = task.images.slice(task.verifiedImages, task.verifiedImages + BATCH_FILES);
  for (const image of images) {
    const object = await env.STORAGE.head(image.key);
    if (!object || object.size !== image.size)
      throw new HttpError(409, '备份图片尚未恢复完整，请重新选择同一份备份继续。');
  }
  task.verifiedImages += images.length;
  await checkpoint(env.STORAGE, task, etag);
  return json(publicTask(task));
}
async function route(
  request: Request,
  env: CloudInkEnv,
  path: string,
  session: Session,
): Promise<Response> {
  if (path === '/api/backup/jobs' && request.method === 'GET') {
    const task = await activeBackup(env.STORAGE);
    return json(task && task.owner === session.version ? publicTask(task) : null);
  }
  if (path === '/api/backup/jobs' && request.method === 'POST') return start(request, env, session);
  const match = path.match(
    /^\/api\/backup\/jobs\/([a-f0-9-]{36})(?:\/(read|preflight|verify-images|apply|finish|cancel))?$/,
  );
  if (!match) throw new HttpError(404, '备份任务接口不存在。');
  const { task, object } = await readTask(env.STORAGE, match[1], session);
  if (!match[2] && request.method === 'GET') return json(publicTask(task));
  if (request.method !== 'POST') throw new HttpError(405, '请求方式不正确。');
  if (match[2] === 'cancel') {
    if (task.phase !== 'cancelled' && task.phase !== 'complete') {
      task.phase = 'cancelled';
      task.entries = [];
      task.images = [];
      await checkpoint(env.STORAGE, task, object.etag);
      await removeChunks(env.STORAGE, task);
    }
    await clearActive(env.STORAGE, task.id);
    return json(publicTask(task));
  }
  if (task.phase === 'cancelled') throw new HttpError(409, '任务已取消，已恢复内容仍保留。');
  if (match[2] === 'read') return readExport(request, env, task);
  if (match[2] === 'preflight') return preflight(request, env, task, object.etag);
  if (match[2] === 'verify-images') return verifyImages(request, env, task, object.etag);
  if (match[2] === 'apply') return apply(request, env, task, object.etag);
  if (match[2] === 'finish') return finish(env, task, object.etag, new URL(request.url).origin);
  throw new HttpError(404, '备份任务接口不存在。');
}
export async function backupJobRoute(
  request: Request,
  env: CloudInkEnv,
  path: string,
  session: Session,
): Promise<Response | null> {
  if (path !== '/api/backup/jobs' && !path.startsWith('/api/backup/jobs/')) return null;
  let calls = 0;
  const storage = new Proxy(env.STORAGE, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (['get', 'head', 'put', 'delete', 'list'].includes(String(property)) && ++calls > 180)
          throw new HttpError(413, '当前批次超出存储操作预算，请缩小批次后重试。');
        return Reflect.apply(value, target, args);
      };
    },
  });
  const response = await route(request, { ...env, STORAGE: storage }, path, session);
  const headers = new Headers(response.headers);
  headers.set('X-CloudInk-Storage-Calls', String(calls));
  return new Response(response.body, { status: response.status, headers });
}

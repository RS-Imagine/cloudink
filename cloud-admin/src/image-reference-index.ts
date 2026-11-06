import { digest } from './auth';
import { managedImageKeys, IMAGE_REFERENCE_VERSION } from './image-references';
import { validImageKey } from './media';
import { HttpError } from './models';
export const REFERENCE_ROOT = 'image-reference-index/';
export type ReferenceShard = Record<string, string[]>;
export const referenceShardKey = (hash: string) => REFERENCE_ROOT + hash.slice(0, 2) + '.json';
export async function readReferenceShard(storage: R2Bucket, key: string): Promise<ReferenceShard> {
  const object = await storage.get(key);
  if (!object) return {};
  if (object.size > 1_000_000) {
    await object.body.cancel();
    throw new HttpError(413, '图片引用索引过大，无法安全核对。');
  }
  const value = await object.json<ReferenceShard>();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(503, '图片引用索引无效，请更新引用索引。');
  return value;
}
export async function imageReferenceMetadata(
  source: string,
  storage: R2Bucket,
  knownHash?: string,
): Promise<Record<string, string>> {
  const keys = managedImageKeys(source).sort(),
    text = JSON.stringify(keys);
  const metadata = { image_refs_version: IMAGE_REFERENCE_VERSION };
  if (new TextEncoder().encode(text).byteLength <= 600) return { ...metadata, image_refs: text };
  const hash = await digest(text),
    key = referenceShardKey(hash);
  if (hash === knownHash) return { ...metadata, image_refs_hash: hash };
  const shard = await readReferenceShard(storage, key);
  if (JSON.stringify(shard[hash]) !== text) {
    shard[hash] = keys;
    let serialized = JSON.stringify(shard);
    if (new TextEncoder().encode(serialized).byteLength > 1_000_000) {
      await pruneReferenceShard(storage, key);
      const compact = await readReferenceShard(storage, key);
      compact[hash] = keys;
      serialized = JSON.stringify(compact);
    }
    if (new TextEncoder().encode(serialized).byteLength > 1_000_000)
      throw new HttpError(413, '图片引用索引需要先完成自动维护，请稍后重试。');
    await storage.put(key, serialized);
  }
  return { ...metadata, image_refs_hash: hash };
}
export async function checkedReferenceKeys(shard: ReferenceShard, hash: string): Promise<string[]> {
  const keys = Object.hasOwn(shard, hash) ? shard[hash] : null;
  if (
    !Array.isArray(keys) ||
    !keys.every((key) => typeof key === 'string' && validImageKey(key)) ||
    (await digest(JSON.stringify(keys))) !== hash
  )
    throw new HttpError(503, '图片引用索引缺失或损坏，请重新更新引用索引；图片仍受保护。');
  return keys;
}
/** One small shard per daily maintenance; live draft pointers are authoritative. */
export async function pruneReferenceShard(storage: R2Bucket, key: string): Promise<number> {
  const live = new Set<string>();
  let count = 0, scanned = 0;
  for (const prefix of ['drafts/', 'shorts/']) {
    let cursor: string | undefined;
    do {
      const page = await storage.list({ prefix, cursor, limit: 1000, include: ['customMetadata'] });
      for (const object of page.objects) {
        if (++scanned > 10000) throw new HttpError(413, '原稿目录超过安全扫描上限。');
        if (object.customMetadata?.deleted) continue;
        if (++count > 2000) throw new HttpError(413, '原稿数量超过引用索引维护上限。');
        if (!object.customMetadata?.deleted && object.customMetadata?.image_refs_hash)
          live.add(object.customMetadata.image_refs_hash);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  const shard = await readReferenceShard(storage, key);
  const obsolete = Object.keys(shard).filter((hash) => !live.has(hash));
  if (!obsolete.length) return 0;
  for (const hash of obsolete) delete shard[hash];
  if (Object.keys(shard).length) await storage.put(key, JSON.stringify(shard));
  else await storage.delete(key);
  return obsolete.length;
}

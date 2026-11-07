import { HttpError } from './models';
// Tombstones remain for stale-editor protection; scan and live-item budgets differ.
export async function listActiveDrafts(
  storage: R2Bucket,
  prefix: 'drafts/' | 'shorts/',
): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined,
    scanned = 0;
  do {
    const page = await storage.list({ prefix, cursor, limit: 1000, include: ['customMetadata'] });
    scanned += page.objects.length;
    if (scanned > 10000)
      throw new HttpError(413, '原稿目录超过安全扫描上限，请联系维护者整理删除标记。');
    for (const object of page.objects) if (!object.customMetadata?.deleted) objects.push(object);
    if (objects.length > 2000) throw new HttpError(413, '有效原稿超过 2000 篇，暂时无法完整读取。');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

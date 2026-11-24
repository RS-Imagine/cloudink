export { imageReferenceMetadata } from './image-reference-index';
export { managedImageKeys } from './image-references';
import { localImageKeys } from './image-references';
import { HttpError } from './models';

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

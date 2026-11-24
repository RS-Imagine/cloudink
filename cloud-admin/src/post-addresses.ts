import { HttpError, readJson, type Publishing } from './models';

export async function addressSnapshot(storage: R2Bucket) {
  const [pointer, state] = await Promise.all([
    readJson<{ postRedirects?: Record<string, string> }>(storage, 'state/published.json'),
    readJson<Publishing>(storage, 'state/pending.json'),
  ]);
  return { pointer, state };
}
export function assertWritableInSnapshot(
  snapshot: Awaited<ReturnType<typeof addressSnapshot>>,
  slug: string,
): void {
  if (snapshot.pointer?.postRedirects && Object.hasOwn(snapshot.pointer.postRedirects, slug))
    throw new HttpError(409, '这篇文章已修改地址，请重新打开文章，旧链接会自动跳转。');
  if (
    snapshot.state?.rename?.to === slug &&
    ['queued', 'building', 'built'].includes(snapshot.state.status)
  )
    throw new HttpError(409, '这个地址正在用于文章改址，请等待发布完成。');
}
export async function assertWritableAddress(storage: R2Bucket, slug: string): Promise<void> {
  assertWritableInSnapshot(await addressSnapshot(storage), slug);
}

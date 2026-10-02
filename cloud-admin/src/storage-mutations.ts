import { HttpError } from './models';

// R2 deletion is unconditional. Coordinate changes to reference-bearing content
// with media deletion across Worker instances, using R2 conditional writes.
const KEY = 'state/content-mutation.json';
const LEASE_MS = 10 * 60_000;
interface Lease {
  expires: number;
  owner: string;
}
export async function withContentMutation<T>(
  storage: R2Bucket,
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await storage.get(KEY);
    const prior = object ? await object.json<Lease>() : null;
    if (!prior || prior.expires < Date.now()) {
      const lease: Lease = { expires: Date.now() + LEASE_MS, owner: crypto.randomUUID() };
      const locked = await storage.put(KEY, JSON.stringify(lease), {
        onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
      });
      if (locked) {
        try {
          return await work();
        } finally {
          // Never release a successor's lease after a timed-out invocation.
          await storage.put(KEY, JSON.stringify({ expires: 0, owner: '' }), {
            onlyIf: { etagMatches: locked.etag },
          });
        }
      }
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new HttpError(503, '另一项保存或图片清理正在进行，请稍后重试；当前内容仍保留。');
}
export function changesContentReferences(path: string, method: string): boolean {
  if (['GET', 'HEAD'].includes(method)) return false;
  return (
    /^\/api\/posts\//.test(path) ||
    path === '/api/settings' ||
    path === '/api/publish' ||
    /^\/api\/publish\/[a-f0-9-]{36}\/(?:commit|cancel)$/.test(path) ||
    path === '/api/backup/restore' ||
    path === '/api/backup/image' ||
    path === '/api/images'
  );
}

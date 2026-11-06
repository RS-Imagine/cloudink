import { HttpError } from './models';

// R2 deletion is unconditional. Coordinate changes to reference-bearing content
// with media deletion across Worker instances, using R2 conditional writes.
const KEY = 'state/content-mutation.json';
export const CONTENT_LEASE_MS = 3 * 60_000;
const WORK_MS = 60_000;
const MAX_CALLS = 900;
interface Lease {
  expires: number;
  owner: string;
}
export async function withContentMutation<T>(
  storage: R2Bucket,
  work: (storage: R2Bucket) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await storage.get(KEY);
    const prior = object ? await object.json<Lease>() : null;
    if (!prior || prior.expires < Date.now()) {
      const lease: Lease = { expires: Date.now() + CONTENT_LEASE_MS, owner: crypto.randomUUID() };
      const locked = await storage.put(KEY, JSON.stringify(lease), {
        onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
      });
      if (locked) {
        try {
          const deadline = Date.now() + WORK_MS;
          let calls = 0;
          const guarded = new Proxy(storage, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                if (Date.now() >= deadline || ++calls > MAX_CALLS)
                  throw new HttpError(503, '本批操作已暂停，请重试；已保存内容保留。');
                return Reflect.apply(value, target, args);
              };
            },
          });
          return await work(guarded);
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
    /^\/api\/shorts\//.test(path) ||
    path === '/api/settings' ||
    path === '/api/publish' ||
    /^\/api\/publish\/[a-f0-9-]{36}\/(?:plan|commit|cancel)$/.test(path) ||
    path === '/api/backup/restore' ||
    path === '/api/backup/jobs' ||
    /^\/api\/backup\/jobs\/[a-f0-9-]{36}\/(?:preflight|verify-images|apply|finish|cancel)$/.test(
      path,
    ) ||
    path === '/api/backup/image' ||
    path === '/api/images' ||
    path === '/api/images/optimize' ||
    path === '/api/images/reindex'
  );
}

import { HttpError } from './models';

export async function withBackupBudget(
  bucket: R2Bucket,
  work: (storage: R2Bucket) => Promise<Response>,
): Promise<Response> {
  let calls = 0;
  const storage = new Proxy(bucket, {
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
  const response = await work(storage);
  const headers = new Headers(response.headers);
  headers.set('X-CloudInk-Storage-Calls', String(calls));
  return new Response(response.body, { status: response.status, headers });
}

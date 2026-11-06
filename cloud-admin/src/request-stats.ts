// Request-local diagnostics; never store counters in R2 or retain bindings globally.
export function storageStats(storage: R2Bucket) {
  const counts = { get: 0, head: 0, list: 0, put: 0, delete: 0, objects: 0, errors: 0 };
  let stage = 'routing';
  const bucket = new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (['get', 'head', 'list', 'put', 'delete'].includes(String(property))) {
          counts[property as 'get' | 'head' | 'list' | 'put' | 'delete']++;
          const key = typeof args[0] === 'string' ? args[0] : '';
          stage = String(property) + ':' + (key.split('/')[0] || 'catalog');
        }
        try {
          const result = await Reflect.apply(value, target, args);
          if (
            property === 'list' &&
            result &&
            typeof result === 'object' &&
            'objects' in result &&
            Array.isArray(result.objects)
          )
            counts.objects += result.objects.length;
          return result;
        } catch (error) {
          counts.errors++;
          throw error;
        }
      };
    },
  });
  return {
    bucket,
    report(requestId: string, route: string, method: string, status: number, started: number) {
      const total = counts.get + counts.head + counts.list + counts.put + counts.delete;
      if (status < 500 && total < 150 && crypto.getRandomValues(new Uint32Array(1))[0] % 100 !== 0)
        return;
      console.log(
        JSON.stringify({
          event: 'storage_request',
          request_id: requestId,
          route,
          method,
          status,
          code:
            status >= 500 ? 'request_failed' : total >= 150 ? 'storage_budget_warning' : 'sample',
          stage,
          elapsed_ms: Date.now() - started,
          ...counts,
        }),
      );
    },
  };
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const origin = 'https://example.net';
const token = '1'.repeat(64);
const csrf = 'test-csrf';
const sessionKey = 'auth/sessions/' + createHash('sha256').update(token).digest('hex');
class R2Bucket {}

export async function loadReaderWorker(storage, waitUntil = () => {}) {
  const directory = new URL('../../build-work/reader-worker/', import.meta.url);
  const workerSource = await readFile(new URL('index.js', directory), 'utf8');
  const workerShim =
    'data:text/javascript,' +
    encodeURIComponent(
      'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' +
        'export const tracing = { getActiveSpan() {} };',
    );
  const source =
    'const addEventListener = () => {};\n' +
    workerSource
      .replaceAll('"cloudflare:workers"', JSON.stringify(workerShim))
      .replace('"./index_bg.wasm"', JSON.stringify(new URL('index_bg.wasm', directory).href));
  const { default: Worker } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  Object.setPrototypeOf(storage, R2Bucket.prototype);
  return new Worker({ waitUntil }, { STORAGE: storage });
}

export async function authenticatedWorker(storage) {
  const get = storage.get;
  storage.get = function (key, ...args) {
    if (key === sessionKey)
      return Promise.resolve({
        json: async () => ({ csrf, expires: Date.now() + 86400000, version: 'v1' }),
      });
    if (key === 'auth/account.json')
      return Promise.resolve({
        json: async () => ({ email: 'reader@example.net', version: 'v1' }),
      });
    return get.call(this, key, ...args);
  };
  // Workerd exposes timingSafeEqual on SubtleCrypto.
  globalThis.crypto.subtle.timingSafeEqual ??= (a, b) =>
    timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
  const worker = await loadReaderWorker(storage);
  return (path, method = 'GET', input) =>
    worker.fetch(
      new Request(origin + path, {
        method,
        headers: {
          Cookie: '__Host-cloudink_session=' + token,
          Origin: origin,
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      }),
    );
}

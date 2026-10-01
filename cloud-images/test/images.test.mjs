import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from '../../cloud-admin/node_modules/esbuild/lib/main.js';
import { Miniflare, convertV4MiniflareOptions } from '../../cloud-admin/node_modules/miniflare/dist/src/index.js';

test('private images stream only to configured blog references and support conditional retrieval', async () => {
  const result = await build({ entryPoints: [resolve('cloud-images/src/index.ts')], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'images-test', script: result.outputFiles[0].text, modules: true, compatibilityDate: '2026-10-01', r2Buckets: ['IMAGES'], bindings: { ALLOWED_ORIGINS: '["https://notes.reader.workers.dev"]' } }));
  try {
    const bucket = await mf.getR2Bucket('IMAGES');
    await bucket.put('uploads/photo.png', new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: 'image/png' } });
    const url = 'https://notes-images.reader.workers.dev/uploads/photo.png';
    assert.equal((await mf.dispatchFetch(url)).status, 403);
    assert.equal((await mf.dispatchFetch(url, { headers: { Referer: 'https://other.example.com/' } })).status, 403);
    const headers = { Referer: 'https://notes.reader.workers.dev/posts/one/' };
    const response = await mf.dispatchFetch(url, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [137, 80, 78, 71]);
    assert.equal((await mf.dispatchFetch(url, { headers: { ...headers, 'If-None-Match': response.headers.get('ETag') } })).status, 304);
    assert.equal((await mf.dispatchFetch(url, { method: 'HEAD', headers })).status, 200);
    assert.equal((await mf.dispatchFetch(url.replace('photo.png', 'missing.png'), { headers })).status, 404);
    assert.equal((await mf.dispatchFetch(url, { method: 'PUT', headers })).status, 405);
  } finally { await mf.dispose(); }
});

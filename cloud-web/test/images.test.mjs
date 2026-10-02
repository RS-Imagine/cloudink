import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft } from './fixture.mjs';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
  'base64',
);
async function seed(bucket, key = 'uploads/unused.png', name = 'unused.png') {
  return bucket.put(key, png, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: { name },
  });
}
async function catalog(f, cursor = '') {
  const r = await f.request(
    '/api/images' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
  );
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}

test('image library is private, paginates without duplicating keys, preserves filenames and never lists private objects', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/images')).status, 401);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  for (let i = 0; i < 26; i++)
    await seed(bucket, `uploads/photo-${String(i).padStart(2, '0')}.png`, `照片 ${i}.png`);
  await seed(bucket, 'auth/private.png');
  await bucket.put('uploads/active.png', '<script>bad()</script>', {
    httpMetadata: { contentType: 'text/html' },
  });
  const first = await catalog(f);
  assert.equal(first.images.length, 24);
  assert.ok(first.cursor);
  assert.equal(first.referencesChecked, true);
  const second = await catalog(f, first.cursor);
  assert.equal(second.images.length, 2);
  assert.equal(second.cursor, null);
  const images = [...first.images, ...second.images];
  assert.equal(new Set(images.map((i) => i.key)).size, 26);
  assert.ok(images.every((i) => i.name.startsWith('照片 ') && i.references.length === 0));
  assert.equal((await f.request('/api/images?cursor=invalid')).status, 400);
  assert.equal((await f.request('/api/images', 'DELETE', { key: 'auth/private.png' })).status, 400);
});

test('unused image deletion physically removes the object and rejects stale metadata and missing CSRF', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await seed(bucket);
  const image = (await catalog(f)).images[0];
  assert.equal(
    (await f.request('/api/images', 'DELETE', image, { 'X-CSRF-Token': 'wrong' })).status,
    403,
  );
  assert.equal((await f.request('/api/images', 'DELETE', { ...image, etag: 'stale' })).status, 409);
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 200);
  assert.equal(await bucket.head(image.key), null);
  assert.equal((await catalog(f)).images.length, 0);
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 404);
});

test('published posts, drafts, history, About and pending settings protect shared images; removing a draft retains history protection', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await seed(bucket, 'uploads/shared.png');
  const source = draft(
    'referenced',
    '![相片](https://notes.reader.workers.dev/images/uploads%2Fshared.png)',
  );
  const saved = await f.request('/api/posts/referenced', 'PUT', { draft: source, etag: null });
  assert.equal(saved.status, 200, await saved.clone().text());
  const { etag } = await saved.json();
  const pending = await f.prepare({ slug: 'referenced', etag });
  let image = (await catalog(f)).images[0];
  assert.ok(image.references.some((r) => r.kind === 'pending'));
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 409);
  await f.stage(pending);
  assert.equal((await f.commit(pending)).status, 200);
  image = (await catalog(f)).images[0];
  assert.deepEqual(
    new Set(image.references.map((r) => r.kind)),
    new Set(['published', 'draft', 'history']),
  );
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 409);
  const offline = await f.prepare({ unpublish: 'referenced' });
  await f.stage(offline);
  assert.equal((await f.commit(offline)).status, 200);
  assert.equal((await f.request('/api/posts/referenced', 'DELETE', { etag })).status, 200);
  image = (await catalog(f)).images[0];
  assert.deepEqual(
    image.references.map((r) => r.kind),
    ['history'],
  );
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 409);
  await seed(bucket, 'uploads/about.png');
  const settings = await f.request('/api/settings', 'PUT', {
    site: {
      title: 'Blog',
      author: 'Reader',
      subtitle: '',
      description: '',
      about: '<img src="/images/uploads&#47;about.png">',
    },
    etag: null,
  });
  assert.equal(settings.status, 200);
  const about = (await catalog(f)).images.find((i) => i.key === 'uploads/about.png');
  assert.ok(about.references.some((r) => r.kind === 'settings'));
  assert.equal((await f.request('/api/images', 'DELETE', about)).status, 409);
});

test('deletion cannot race content mutation; later draft/settings writes cannot reference a deleted image', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await seed(bucket);
  const image = (await catalog(f)).images[0];
  await bucket.put(
    'state/content-mutation.json',
    JSON.stringify({ owner: 'another-request', expires: Date.now() + 60_000 }),
  );
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 503);
  assert.ok(await bucket.head(image.key));
  await bucket.put('state/content-mutation.json', JSON.stringify({ owner: '', expires: 0 }));
  // Both operations contend for the same R2 lease: either the save protects the
  // image, or deletion wins and the new reference is rejected before storage.
  const results = await Promise.all([
    f.request('/api/images', 'DELETE', image),
    f.request('/api/posts/race', 'PUT', {
      draft: draft('race', '![image](/images/uploads/unused.png)'),
      etag: null,
    }),
  ]);
  assert.ok(results[0].status === 200 || results[0].status === 409);
  assert.ok(results[1].status === 200 || results[1].status === 400);
  const stored = await bucket.head('drafts/race.md');
  if (stored) assert.ok(await bucket.head(image.key));
  else assert.equal(await bucket.head(image.key), null);
  await seed(bucket, 'uploads/other.png');
  const other = (await catalog(f)).images.find((i) => i.key === 'uploads/other.png');
  assert.equal((await f.request('/api/images', 'DELETE', other)).status, 200);
  assert.equal(
    (
      await f.request('/api/posts/missing', 'PUT', {
        draft: draft('missing', '![removed](/images/uploads/other.png)'),
        etag: null,
      })
    ).status,
    400,
  );
  assert.equal(await bucket.head('drafts/missing.md'), null);
});

test('incomplete reference checks allow browsing but never allow deletion', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await seed(bucket);
  for (let i = 0; i < 31; i++) await bucket.put(`history/old/${i}.md`, 'old source');
  const page = await catalog(f);
  assert.equal(page.images.length, 1);
  assert.equal(page.referencesChecked, false);
  assert.match(page.referenceError, /暂时无法完成引用检查/);
  assert.equal((await f.request('/api/images', 'DELETE', page.images[0])).status, 413);
  assert.ok(await bucket.head('uploads/unused.png'));
});

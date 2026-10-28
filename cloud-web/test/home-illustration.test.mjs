import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { svgBytes } from './icon-fixtures.mjs';

async function save(f, value) {
  const current = await (await f.request('/api/settings')).json();
  return f.request('/api/settings', 'PUT', {
    site: { ...current.site, homeIllustration: value },
    etag: current.etag,
  });
}
test('home illustration validates sources and protects saved and published references', async (t) => {
  const f = await fixture(t);
  await f.login();
  for (const key of [
    'https://example.com/test.svg',
    'uploads/../private.png',
    'auth/account.json',
    'uploads/x.svg',
  ]) {
    assert.equal((await save(f, key)).status, 400);
  }
  assert.equal((await save(f, 'uploads/missing.webp')).status, 400);
  assert.equal((await save(f, 'default')).status, 200);
  assert.equal((await save(f, '')).status, 200);
  const upload = await f.request('/api/site-icon', 'POST', svgBytes);
  assert.equal(upload.status, 201);
  const { key } = await upload.json();
  assert.equal((await save(f, key)).status, 200);
  let library = await (await f.request('/api/images')).json();
  let item = library.images.find((image) => image.key === key);
  assert.ok(item.references.some((ref) => ref.kind === 'settings'));
  assert.equal((await f.request('/api/images', 'DELETE', { key, etag: item.etag })).status, 409);
  const publication = await f.prepare({ settings: true });
  assert.equal(publication.browser_release.site.homeIllustration, key);
  await f.stage(publication);
  assert.equal((await f.commit(publication)).status, 200);
  assert.equal((await save(f, '')).status, 200);
  library = await (await f.request('/api/images')).json();
  item = library.images.find((image) => image.key === key);
  assert.equal((await f.request('/api/images', 'DELETE', { key, etag: item.etag })).status, 409);
  const reset = await f.prepare({ settings: true });
  await f.stage(reset);
  assert.equal((await f.commit(reset)).status, 200);
  assert.equal((await f.request('/api/images', 'DELETE', { key, etag: item.etag })).status, 200);
});

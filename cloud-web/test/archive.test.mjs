import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, origin } from './fixture.mjs';

test('archive is required, staged privately and served as canonical HTML after commit', async (t) => {
  const f = await fixture(t);
  await f.login();
  const state = await f.prepare();
  assert.ok(state.files.includes('archive/index.html'));
  await f.stage(state, ['archive/index.html']);
  assert.equal((await f.request('/archive/')).status, 404);
  assert.equal((await f.commit(state)).status, 409);
  const next = await f.prepare();
  await f.stage(next);
  assert.equal((await f.commit(next)).status, 200);
  for (const path of ['/archive/', '/archive', '/archive/index.html']) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('rel="canonical" href="' + origin + '/archive/"'));
  }
  const head = await f.request('/archive/', 'HEAD');
  assert.equal(head.status, 200);
  assert.match(head.headers.get('Content-Type'), /text\/html/);
  assert.equal(await head.text(), '');
  const sitemap = await (await f.request('/sitemap.xml')).text();
  assert.ok(sitemap.includes('<loc>' + origin + '/archive/</loc>'));
});

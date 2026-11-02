import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft } from './fixture.mjs';

test('legacy pages prompt one safe rebuild; unpublished drafts and settings stay private', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const status = async () => (await (await f.request('/api/posts')).json()).templateStatus;
  assert.equal(await status(), 'unpublished');
  const initial = await (await bucket.get('state/published.json')).json();
  await bucket.put('public/' + initial.id + '/index.html', '<h1>Legacy page</h1>');
  assert.equal(await status(), 'outdated');
  const privateDraft = draft('private', 'Do not publish these words');
  assert.equal((await f.request('/api/posts/private', 'PUT', { draft: privateDraft, etag: null })).status, 200);
  const savedSite = { ...JSON.parse(await (await bucket.get('releases/' + initial.id + '.json')).text()).site, title: 'Unpublished title' };
  await bucket.put('draft-site.json', JSON.stringify(savedSite));
  const state = await f.prepare();
  assert.match(state.template_version, /^[a-f0-9]{64}$/);
  assert.equal(state.browser_release.site.title, 'Reader blog');
  assert.equal(state.browser_release.markdown_posts.private, undefined);
  await f.stage(state);
  assert.equal((await f.commit(state)).status, 200);
  assert.equal(await status(), 'current');
  const pointer = await (await bucket.get('state/published.json')).json();
  assert.equal(pointer.templateVersion, state.template_version);
  assert.ok(await bucket.head('drafts/private.md'));
  assert.deepEqual(await (await bucket.get('draft-site.json')).json(), savedSite);

  const cancelled = await f.prepare();
  await f.request('/api/publish/' + cancelled.release_id + '/cancel', 'POST', {});
  assert.equal((await (await bucket.get('state/published.json')).json()).templateVersion, state.template_version);
  assert.equal(await status(), 'current');
  const incomplete = await f.prepare();
  await f.stage(incomplete, ['404.html']);
  assert.equal((await f.commit(incomplete)).status, 409);
  assert.equal(await status(), 'current');
});

test('an older renderer is rejected before commit without losing the live version', async (t) => {
  const f = await fixture(t);
  await f.login();
  const first = await f.prepare();
  await f.stage(first);
  assert.equal((await f.commit(first)).status, 200);
  const next = await f.prepare();
  for (const template_version of [undefined, '0'.repeat(64)]) {
    const response = await f.request('/api/publish/' + next.release_id + '/file?path=_release.json', 'PUT',
      JSON.stringify({ id: next.release_id, template_version }));
    assert.equal(response.status, 409);
    assert.match(await response.text(), /刷新/);
  }
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal(await bucket.head('public/' + next.release_id + '/_release.json'), null);
  await f.request('/api/publish/' + next.release_id + '/cancel', 'POST', {});
  const pointer = await (await bucket.get('state/published.json')).json();
  assert.equal(pointer.id, first.release_id);
  assert.equal(pointer.templateVersion, first.template_version);
});

test('an in-flight publication finishes with its starting template version and then prompts to update', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const prepared = await f.prepare();
  // Simulate a pending publication created by the deployment before this one.
  const old = { ...prepared, template_version: '1'.repeat(64) };
  delete old.browser_release;
  await bucket.put('state/pending.json', JSON.stringify(old));
  await f.stage(old);
  assert.equal((await f.commit(old)).status, 200);
  assert.equal((await (await bucket.get('state/published.json')).json()).templateVersion, old.template_version);
  assert.equal((await (await f.request('/api/posts')).json()).templateStatus, 'outdated');
  const latest = await f.prepare();
  await f.stage(latest);
  assert.equal((await f.commit(latest)).status, 200);
  assert.equal((await (await f.request('/api/posts')).json()).templateStatus, 'current');
});

test('a pre-version publication can recover but cannot falsely mark itself up to date', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const state = await f.prepare();
  delete state.template_version;
  const pending = { ...state };
  delete pending.browser_release;
  await bucket.put('state/pending.json', JSON.stringify(pending));
  await f.stage(state);
  assert.equal((await f.commit(state)).status, 200);
  assert.equal((await (await f.request('/api/posts')).json()).templateStatus, 'outdated');
});

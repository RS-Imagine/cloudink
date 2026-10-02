import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, password, draft, setupToken } from './fixture.mjs';

test('authorized setup initializes one account and empty private content; existing passwords survive a changed setup token', async (t) => {
  const f = await fixture(t);
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/admin')).status, 200);
  assert.equal((await f.request('/api/posts')).status, 401);
  assert.equal(
    (await f.request('/api/login', 'POST', { email: owner, password: 'wrong' })).status,
    401,
  );
  assert.equal(await bucket.head('auth/account.json'), null);
  await f.login();
  const account = await (await bucket.get('auth/account.json')).json();
  assert.notEqual(account.hash, password);
  assert.equal((await f.request('/api/posts')).status, 200);
  const fresh = await (await f.request('/api/posts')).json();
  assert.equal(fresh.posts.length, 0);
  assert.deepEqual(fresh.deployment, { configured: true, managed: true });
  assert.equal(
    (
      await f.request('/api/password', 'POST', {
        current_password: password,
        password: 'replacement-password-private',
      })
    ).status,
    200,
  );
  await f.setSetupToken('new-secret-does-not-reset-account');
  await f.login('replacement-password-private');
  assert.equal((await f.request('/api/login', 'POST', { email: owner, password })).status, 401);
  assert.equal(
    (
      await f.request('/api/login', 'POST', {
        email: owner,
        password: 'new-secret-does-not-reset-account',
      })
    ).status,
    401,
  );
  assert.equal((await f.request('/api/setup', 'POST', { password })).status, 409);
  assert.equal((await f.request('/internal/bundle')).status, 404);
  for (const path of [
    '/auth/account.json',
    '/drafts/a.md',
    '/state/published.json',
    '/releases/test.json',
  ])
    assert.equal((await f.request(path)).status, 404);
});

test('all pages must be present before commit; staging stays private; failed publication and cancellation retain the previous release', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const initial = (await (await bucket.get('state/published.json')).json()).id;
  const first = await f.prepare();
  await f.stage(first, ['404.html']);
  assert.equal((await f.request(`/public/${first.release_id}/index.html`)).status, 404);
  assert.equal((await f.commit(first)).status, 409);
  assert.equal((await (await bucket.get('state/published.json')).json()).id, initial);
  const second = await f.prepare();
  await f.stage(second);
  assert.equal((await f.commit(second)).status, 200);
  assert.equal(
    (await (await f.request(`/api/publish/${second.release_id}/cancel`, 'POST', {})).json()).status,
    'deployed',
    'a lost commit response is recovered through the live pointer',
  );
  assert.match(await (await f.request('/')).text(), /Published version/);
  const marker = await (await f.request('/_release.json')).json();
  assert.equal(marker.id, second.release_id);
  const third = await f.prepare();
  await f.stage(third);
  assert.equal(
    (await f.request(`/api/publish/${third.release_id}/cancel`, 'POST', {})).status,
    200,
  );
  assert.equal((await f.commit(third)).status, 409);
  assert.equal((await (await f.request('/_release.json')).json()).id, second.release_id);
  assert.equal(
    (await f.request(`/api/publish/${second.release_id}/file?path=index.html`, 'PUT', 'overwrite'))
      .status,
    409,
  );
});

test('publish includes only the chosen saved draft; CSRF, immutable pages and HTML sanitization protect the same-origin editor', async (t) => {
  const f = await fixture(t);
  await f.login();
  const save = await f.request('/api/posts/public', 'PUT', { draft: draft(), etag: null });
  const { etag } = await save.json();
  assert.equal(
    (
      await f.request('/api/posts/private', 'PUT', {
        draft: draft('private', 'Secret words'),
        etag: null,
      })
    ).status,
    200,
  );
  const state = await f.prepare({ slug: 'public', etag });
  assert.ok(state.browser_release.markdown_posts.public);
  assert.equal(state.browser_release.markdown_posts.private, undefined);
  assert.equal(
    (
      await f.request(
        `/api/publish/${state.release_id}/file?path=index.html`,
        'PUT',
        '<html>bad</html>',
        { 'X-CSRF-Token': 'wrong' },
      )
    ).status,
    403,
  );
  const unsafe =
    '<!doctype html><html><head><script>fetch("/api/export")</script><meta http-equiv="refresh" content="0;url=/admin"></head><body><h1 onclick="steal()">Safe title</h1><iframe src="/admin"></iframe><script src="/app.js"></script></body></html>';
  await f.stage(state, [], unsafe);
  assert.equal(
    (
      await f.request(
        `/api/publish/${state.release_id}/file?path=index.html`,
        'PUT',
        '<html>OVERWRITE</html>',
      )
    ).status,
    200,
  );
  assert.equal((await f.commit(state)).status, 200);
  const response = await f.request('/posts/public/'),
    html = await response.text();
  assert.ok(html.includes('Safe title'));
  assert.ok(!html.includes('OVERWRITE'));
  assert.ok(!html.includes('onclick'));
  assert.ok(!html.includes('/api/export'));
  assert.ok(!html.includes('iframe'));
  assert.ok(!html.includes('/app.js'));
  assert.ok(!html.includes('http-equiv'));
  assert.match(html, /src="\/theme.js"/);
  assert.match(html, /src="\/client.js"/);
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'self';/);
  assert.equal((await f.request('/posts/private/')).status, 404);
  const client = await f.request('/client.js');
  assert.match(await client.text(), /DOMContentLoaded/);
  assert.notEqual(client.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal((await f.request('/posts/public/', 'HEAD')).status, 200);
  assert.equal(
    (
      await f.request('/posts/public/', 'GET', undefined, {
        'If-None-Match': response.headers.get('ETag'),
      })
    ).status,
    304,
  );
});

test('concurrent commit/cancel cannot revive an aborted release or corrupt the next release', async (t) => {
  const f = await fixture(t);
  await f.login();
  const state = await f.prepare();
  await f.stage(state);
  const [commit, cancel] = await Promise.all([
    f.commit(state),
    f.request(`/api/publish/${state.release_id}/cancel`, 'POST', {}),
  ]);
  const current = await (await f.request('/_release.json')).json();
  if (commit.status === 200) assert.equal(current.id, state.release_id);
  else assert.notEqual(current.id, state.release_id);
  const cancellation = await cancel.json();
  assert.equal(cancellation.status, current.id === state.release_id ? 'deployed' : 'failed');
  const next = await f.prepare();
  await f.stage(next);
  assert.equal((await f.commit(next)).status, 200);
  assert.equal((await (await f.request('/_release.json')).json()).id, next.release_id);
});

test('image paths support same-origin referencing without exposing private bucket keys or accepting active files', async (t) => {
  const f = await fixture(t);
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await bucket.put('uploads/image.png', new Uint8Array([137, 80, 78, 71]), {
    httpMetadata: { contentType: 'image/png' },
  });
  assert.equal((await f.request('/images/uploads/image.png')).status, 403);
  const response = await f.request('/images/uploads/image.png', 'GET', undefined, {
    Referer: 'https://notes.reader.workers.dev/posts/public/',
  });
  assert.equal(response.status, 200);
  assert.equal(
    (
      await f.request('/images/uploads/image.png', 'GET', undefined, {
        Referer: 'https://unrelated.example/',
      })
    ).status,
    403,
  );
  await bucket.put('uploads/danger.png', '<script>bad()</script>', {
    httpMetadata: { contentType: 'text/html' },
  });
  assert.equal(
    (
      await f.request('/images/uploads/danger.png', 'GET', undefined, {
        Referer: 'https://notes.reader.workers.dev/',
      })
    ).status,
    415,
  );
});

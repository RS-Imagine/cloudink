import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, setupToken, owner, password, draft } from './fixture.mjs';

const site = { title: 'My notes', author: 'Reader', subtitle: 'Thoughts', description: '' };
const input = { email: owner, password, site };
const authorization = { Authorization: `Bearer ${setupToken}` };

test('setup requires a private token and valid account/site; concurrent setup creates exactly one account', async (t) => {
  const f = await fixture(t),
    bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await f.request('/api/setup', 'POST', input)).status, 403);
  assert.equal(
    (
      await f.request('/api/setup', 'POST', input, {
        ...authorization,
        Origin: 'https://unrelated.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request('/api/setup', 'POST', { ...input, email: 'invalid' }, authorization)).status,
    400,
  );
  assert.equal(
    (await f.request('/api/setup', 'POST', { ...input, password: 'short' }, authorization)).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/api/setup',
        'POST',
        { ...input, site: { ...site, author: '' } },
        authorization,
      )
    ).status,
    400,
  );
  assert.equal(await bucket.head('auth/account.json'), null);
  const results = await Promise.all([
    f.request('/api/setup', 'POST', input, authorization),
    f.request('/api/setup', 'POST', { ...input, email: 'second@example.net' }, authorization),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const account = await (await bucket.get('auth/account.json')).json();
  assert.ok([owner, 'second@example.net'].includes(account.email));
  assert.equal(JSON.stringify(account).includes(setupToken), false);
  assert.equal(JSON.stringify(account).includes(password), false);
  assert.equal((await (await f.request('/api/config')).json()).initialized, true);
  await f.setSetupToken('changed-token-cannot-reopen-setup');
  assert.equal(
    (
      await f.request('/api/setup', 'POST', input, {
        Authorization: 'Bearer changed-token-cannot-reopen-setup',
      })
    ).status,
    409,
  );
});

test('invalid deployment token cannot initialize an account; login resumes an interrupted content initialization', async (t) => {
  const broken = await fixture(t, { SETUP_TOKEN: 'short' });
  assert.equal(
    (await broken.request('/api/setup', 'POST', input, { Authorization: 'Bearer short' })).status,
    503,
  );
  const f = await fixture(t),
    bucket = await f.mf.getR2Bucket('STORAGE');
  await f.login();
  await bucket.delete('state/published.json');
  await f.login();
  const pointer = await (await bucket.get('state/published.json')).json();
  const release = await (await bucket.get(`releases/${pointer.id}.json`)).json();
  assert.equal(release.site.title, 'Reader blog');
});

test('account changes validate the current password, invalidate old sessions and persist independently of Cloudflare secrets', async (t) => {
  const f = await fixture(t);
  await f.login();
  assert.equal(
    (
      await f.request('/api/account', 'PUT', {
        email: 'next@example.net',
        current_password: 'wrong',
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/api/account', 'PUT', { email: 'invalid', current_password: password }))
      .status,
    400,
  );
  const response = await f.request('/api/account', 'PUT', {
    email: 'NEXT@example.net',
    current_password: password,
    password: 'new-private-password-27',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email, 'next@example.net');
  assert.equal((await f.request('/api/posts')).status, 401, 'the old cookie is revoked');
  assert.equal((await f.request('/api/login', 'POST', { email: owner, password })).status, 401);
  await f.setSetupToken('another-private-setup-token');
  await f.login('new-private-password-27', 'next@example.net');
  assert.equal((await (await f.request('/api/session')).json()).email, 'next@example.net');
});

test('same-bucket media routes cannot expose credentials, drafts or published objects, even with image metadata', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  for (const key of ['auth/private.png', 'drafts/private.png', 'public/private.png']) {
    await bucket.put(key, new Uint8Array([137, 80, 78, 71]), {
      httpMetadata: { contentType: 'image/png' },
    });
    assert.equal(
      (
        await f.request('/images/' + key, 'GET', undefined, {
          Referer: 'https://notes.reader.workers.dev/',
        })
      ).status,
      404,
    );
    assert.equal((await f.request('/api/image?key=' + encodeURIComponent(key))).status, 400);
  }
  for (const key of [
    'uploads/%2e%2e/auth/account.json',
    'uploads/a%2F..%2Fsecret.png',
    'uploads/a%5csecret.png',
    'uploads/%ZZ.png',
  ]) {
    assert.ok(
      [400, 404].includes(
        (
          await f.request('/images/' + key, 'GET', undefined, {
            Referer: 'https://notes.reader.workers.dev/',
          })
        ).status,
      ),
    );
  }
});

test('site settings, About page and analytics take effect on publication; invalid analytics IDs never become scripts', async (t) => {
  const f = await fixture(t);
  await f.login();
  const settings = await f.request('/api/settings', 'PUT', {
    site: { ...site, footer: 'Reader footer', about: '## About me\n\nHello.', clarityId: 'abc123' },
    etag: null,
  });
  assert.equal(settings.status, 200);
  assert.match(await (await f.request('/analytics.js')).text(), /disabled/);
  const publication = await f.prepare({ settings: true });
  assert.ok(publication.files.includes('about/index.html'));
  assert.match(publication.browser_release.about_markdown, /About me/);
  await f.stage(publication);
  assert.equal((await f.commit(publication)).status, 200);
  assert.match(await (await f.request('/analytics.js')).text(), /abc123/);
  assert.match(
    (await f.request('/')).headers.get('Content-Security-Policy'),
    /https:\/\/www.clarity.ms/,
  );
  const settingsEtag = (await settings.json()).etag;
  assert.equal(
    (
      await f.request('/api/settings', 'PUT', {
        site: { ...site, clarityId: 'bad";alert(1)' },
        etag: settingsEtag,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/api/settings', 'PUT', {
        site: { ...site, about: '', clarityId: '' },
        etag: settingsEtag,
      })
    ).status,
    200,
  );
  const disabled = await f.prepare({ settings: true });
  assert.equal(disabled.files.includes('about/index.html'), false);
  await f.stage(disabled);
  assert.equal((await f.commit(disabled)).status, 200);
  assert.match(await (await f.request('/analytics.js')).text(), /disabled/);
  assert.equal(
    (await f.request('/')).headers.get('Content-Security-Policy').includes('clarity.ms'),
    false,
  );
  const other = await f.request('/api/posts/private', 'PUT', {
    draft: draft('private'),
    etag: null,
  });
  assert.equal(other.status, 200);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft } from './fixture.mjs';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test('portable backup restores drafts, history, images and settings while preserving the target account and live release', async (t) => {
  const source = await fixture(t);
  await source.login();
  const sourceBucket = await source.mf.getR2Bucket('STORAGE');
  await source.request('/api/posts/article', 'PUT', {
    draft: draft('article', 'Original Markdown'),
    etag: null,
  });
  const state = await source.prepare({
    slug: 'article',
    etag: (await (await source.request('/api/posts/article')).json()).etag,
  });
  await source.stage(state);
  await source.commit(state);
  const record = await (await source.request('/api/posts/article')).json();
  await source.request('/api/posts/article', 'PUT', {
    draft: draft('article', 'Unpublished edits'),
    etag: record.etag,
  });
  await source.request('/api/settings', 'PUT', {
    site: {
      title: 'Backed up site',
      author: 'Reader',
      subtitle: '',
      description: '',
      footer: 'My footer',
      about: 'About me',
    },
    etag: null,
  });
  await sourceBucket.put('uploads/photo.png', png, { httpMetadata: { contentType: 'image/png' } });
  const exported = await source.request('/api/backup');
  assert.equal(exported.status, 200);
  const backup = await exported.json();
  assert.equal(backup.images.length, 1);
  assert.equal(backup.site.title, 'Backed up site');
  assert.equal(
    Object.keys(backup.files).some((key) => key.startsWith('auth/')),
    false,
  );
  const target = await fixture(t);
  await target.login();
  const bucket = await target.mf.getR2Bucket('STORAGE');
  const beforeAccount = await (await bucket.get('auth/account.json')).text(),
    beforePointer = await (await bucket.get('state/published.json')).text();
  assert.equal(
    (await target.request('/api/backup/restore', 'POST', { backup, settings_etag: null })).status,
    409,
    'missing images must not restore text',
  );
  assert.equal(await bucket.head('drafts/article.md'), null);
  assert.equal(
    (await target.request('/api/backup/image?key=uploads%2Fphoto.png', 'PUT', png)).status,
    200,
  );
  const restored = await target.request('/api/backup/restore', 'POST', {
    backup,
    settings_etag: null,
  });
  assert.equal(restored.status, 200, await restored.clone().text());
  const result = await restored.json();
  assert.equal(result.drafts, 1);
  assert.equal(result.history, 2);
  assert.equal(await (await bucket.get('auth/account.json')).text(), beforeAccount);
  assert.equal(await (await bucket.get('state/published.json')).text(), beforePointer);
  const imported = await (await target.request('/api/posts/article')).json();
  assert.equal(imported.draft.body_markdown, 'Unpublished edits');
  assert.equal(imported.draft.front_matter.draft, true);
  assert.equal((await (await target.request('/api/posts')).json()).posts[0].published, false);
  assert.equal(
    (await target.request('/api/backup/restore', 'POST', { backup, settings_etag: result.etag }))
      .status,
    200,
    'retry skips identical objects',
  );
});

test('backup restore rejects arbitrary private paths, conflicting originals, changed settings and active image files', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const backup = await (await f.request('/api/backup')).json();
  assert.equal(
    (
      await f.request('/api/backup/restore', 'POST', {
        backup: { ...backup, files: { 'auth/account.json': '{}' } },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/api/backup/image?key=auth%2Faccount.png', 'PUT', png)).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/api/backup/image?key=uploads%2Factive.png',
        'PUT',
        new TextEncoder().encode('<script>bad()</script>'),
      )
    ).status,
    400,
  );
  await bucket.put('uploads/same.png', png, { httpMetadata: { contentType: 'image/png' } });
  assert.equal(
    (
      await f.request(
        '/api/backup/image?key=uploads%2Fsame.png',
        'PUT',
        new Uint8Array([...png, 1]),
      )
    ).status,
    409,
  );
  const saved = await f.request('/api/posts/article', 'PUT', {
    draft: draft('article', 'Existing original'),
    etag: null,
  });
  assert.equal(saved.status, 200);
  const raw = await (await bucket.get('drafts/article.md')).text();
  const different = {
    ...backup,
    files: { 'drafts/article.md': raw.replace('Existing original', 'A different original') },
  };
  assert.equal(
    (await f.request('/api/backup/restore', 'POST', { backup: different, settings_etag: null }))
      .status,
    409,
  );
  assert.equal(await (await bucket.get('drafts/article.md')).text(), raw);
  await f.request('/api/settings', 'PUT', { site: backup.site, etag: null });
  assert.equal(
    (await f.request('/api/backup/restore', 'POST', { backup, settings_etag: 'outdated' })).status,
    409,
  );
  assert.equal(
    (
      await f.request(
        '/api/backup/restore',
        'POST',
        { backup, settings_etag: null },
        { 'X-CSRF-Token': 'wrong' },
      )
    ).status,
    403,
  );
});

import { backupEntry } from '../../cloud-admin/src/backup-contract.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft } from './fixture.mjs';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test('portable backup restores drafts, images and settings while preserving the target account and live release; legacy history entries are skipped', async (t) => {
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
  assert.equal(
    Object.keys(backup.files).some((key) => key.startsWith('history/')),
    false,
  );
  backup.files['history/article/1700000000000-abc.md'] = backup.files['drafts/article.md'];
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
  assert.equal(result.history, undefined);
  assert.equal((await bucket.list({ prefix: 'history/' })).objects.length, 0);
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

const shortDraft = (slug, body_markdown) => ({
  front_matter: { slug, date: '2026-11-06 10:30', draft: true },
  body_markdown,
});
const shortSource = (slug, body, isDraft = true) =>
  `+++\ndate = "2026-11-06 10:30"\nslug = "${slug}"\ndraft = ${isDraft}\n+++\n\n${body}`;

test('restore prefers article and short drafts regardless of manifest order', async (t) => {
  for (const reverse of [false, true]) {
    const f = await fixture(t);
    await f.login();
    const bucket = await f.mf.getR2Bucket('STORAGE');
    await f.request('/api/posts/note', 'PUT', {
      draft: draft('note', 'New article draft'),
      etag: null,
    });
    const article = await (await f.request('/api/posts/note')).json();
    const original = article.source;
    await f.request('/api/posts/note', 'DELETE', { etag: article.etag });
    const backup = await (await f.request('/api/backup')).json();
    const entries = [
      [
        'published/note.md',
        original
          .replace('New article draft', 'Old published article')
          .replace('draft = true', 'draft = false'),
      ],
      ['drafts/note.md', original],
      ['published-shorts/note.md', shortSource('note', 'Old published short', false)],
      ['shorts/note.md', shortSource('note', 'New short draft')],
    ];
    backup.files = Object.fromEntries(reverse ? entries.reverse() : entries);
    const beforePointer = await (await bucket.get('state/published.json')).text();
    const response = await f.request('/api/backup/restore', 'POST', {
      backup,
      settings_etag: null,
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      (await (await f.request('/api/posts/note')).json()).draft.body_markdown,
      'New article draft',
    );
    const short = await (await f.request('/api/shorts/note')).json();
    assert.equal(short.draft.body_markdown, 'New short draft');
    assert.equal(short.draft.front_matter.draft, true);
    assert.equal(await (await bucket.get('state/published.json')).text(), beforePointer);
  }
});

test('backup restores deleted articles and shorts as drafts and retries without rewriting them', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await f.request('/api/posts/article', 'PUT', {
    draft: draft('article', 'Backed up article'),
    etag: null,
  });
  await f.request('/api/shorts/note', 'PUT', {
    ...shortDraft('note', 'Backed up short'),
    etag: null,
  });
  const article = await (await f.request('/api/posts/article')).json();
  const short = await (await f.request('/api/shorts/note')).json();
  const backup = await (await f.request('/api/backup')).json();
  assert.equal(
    (await f.request('/api/posts/article', 'DELETE', { etag: article.etag })).status,
    200,
  );
  assert.equal((await f.request('/api/shorts/note', 'DELETE', { etag: short.etag })).status, 200);
  for (const key of ['drafts/article.md', 'shorts/note.md'])
    assert.equal((await bucket.head(key)).customMetadata.deleted, 'true');
  const account = await (await bucket.get('auth/account.json')).text();
  const pointer = await (await bucket.get('state/published.json')).text();
  const response = await f.request('/api/backup/restore', 'POST', { backup, settings_etag: null });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.restored, 2);
  assert.equal(
    (await (await f.request('/api/posts/article')).json()).draft.body_markdown,
    'Backed up article',
  );
  assert.equal(
    (await (await f.request('/api/shorts/note')).json()).draft.body_markdown,
    'Backed up short',
  );
  for (const key of ['drafts/article.md', 'shorts/note.md'])
    assert.equal((await bucket.head(key)).customMetadata.deleted, undefined);
  assert.equal(await (await bucket.get('auth/account.json')).text(), account);
  assert.equal(await (await bucket.get('state/published.json')).text(), pointer);
  const versions = await Promise.all(
    ['drafts/article.md', 'shorts/note.md', 'draft-site.json'].map((key) => bucket.head(key)),
  );
  const retry = await f.request('/api/backup/restore', 'POST', {
    backup,
    settings_etag: result.etag,
  });
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal((await retry.json()).restored, 0);
  for (const before of versions)
    assert.equal((await bucket.head(before.key)).version, before.version);
});

test('restore does not overwrite originals recreated after deletion', async (t) => {
  for (const short of [false, true]) {
    const f = await fixture(t);
    await f.login();
    const path = short ? '/api/shorts/item' : '/api/posts/item';
    const data = (body) =>
      short
        ? { ...shortDraft('item', body), etag: null }
        : { draft: draft('item', body), etag: null };
    assert.equal((await f.request(path, 'PUT', data('Backup original'))).status, 200);
    const backup = await (await f.request('/api/backup')).json();
    const saved = await (await f.request(path)).json();
    assert.equal((await f.request(path, 'DELETE', { etag: saved.etag })).status, 200);
    assert.equal((await f.request(path, 'PUT', data('New original'))).status, 200);
    const response = await f.request('/api/backup/restore', 'POST', {
      backup,
      settings_etag: null,
    });
    assert.equal(response.status, 409);
    assert.equal((await (await f.request(path)).json()).draft.body_markdown, 'New original');
  }
});

test('restore keeps a renamed source retired', async (t) => {
  const f = await fixture(t);
  await f.login();
  await f.request('/api/posts/old', 'PUT', { draft: draft('old', 'Moved article'), etag: null });
  const backup = await (await f.request('/api/backup')).json();
  const saved = await (await f.request('/api/posts/old')).json();
  const renamed = await f.request('/api/posts/old/rename', 'POST', {
    slug: 'new',
    etag: saved.etag,
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  const response = await f.request('/api/backup/restore', 'POST', { backup, settings_etag: null });
  assert.equal(response.status, 409);
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await bucket.head('drafts/old.md')).customMetadata.renamedTo, 'new');
  assert.equal(
    (await (await f.request('/api/posts/new')).json()).draft.body_markdown,
    'Moved article',
  );
});

test('ZIP path contract accepts all source kinds and rejects private or traversing entries', () => {
  for (const kind of ['published', 'drafts', 'published-shorts', 'shorts'])
    assert.equal(backupEntry('content/' + kind + '/valid-slug.md'), true);
  for (const name of [
    'content/auth/account.json',
    'content/shorts/../private.md',
    'media/uploads/../auth/account.json',
    'media/uploads/icons/arbitrary.svg',
    'content/shorts/nested/note.md',
  ])
    assert.equal(backupEntry(name), false, name);
});

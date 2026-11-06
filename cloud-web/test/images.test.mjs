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

test('published posts, drafts, About and pending settings protect shared images; saving creates no history and legacy history is ignored', async (t) => {
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
  assert.equal((await bucket.list({ prefix: 'history/' })).objects.length, 0);
  const pending = await f.prepare({ slug: 'referenced', etag });
  let image = (await catalog(f)).images[0];
  assert.ok(image.references.some((r) => r.kind === 'pending'));
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 409);
  await f.stage(pending);
  assert.equal((await f.commit(pending)).status, 200);
  image = (await catalog(f)).images[0];
  assert.deepEqual(new Set(image.references.map((r) => r.kind)), new Set(['published', 'draft']));
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 409);
  const offline = await f.prepare({ unpublish: 'referenced' });
  await f.stage(offline);
  assert.equal((await f.commit(offline)).status, 200);
  assert.equal((await f.request('/api/posts/referenced', 'DELETE', { etag })).status, 200);
  await bucket.put('history/referenced/1700000000000-abc.md', source.body_markdown);
  image = (await catalog(f)).images[0];
  assert.deepEqual(image.references, []);
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
  for (let i = 0; i < 31; i++) await bucket.put(`drafts/old-${i}.md`, 'old source');
  const page = await catalog(f);
  assert.equal(page.images.length, 1);
  assert.equal(page.referencesChecked, false);
  assert.match(page.referenceError, /暂时无法完成引用检查/);
  assert.equal((await f.request('/api/images', 'DELETE', page.images[0])).status, 413);
  assert.ok(await bucket.head('uploads/unused.png'));
});

test('external image links and code examples remain writable while missing local image URLs are rejected', async (t) => {
  const f = await fixture(t);
  await f.login();
  const body =
    '![External](https://photos.example.org/images/uploads/example.png)\n\nCode: `uploads/not-stored.png` and `/images/uploads/example.png`';
  const saved = await f.request('/api/posts/external', 'PUT', {
    draft: draft('external', body),
    etag: null,
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(
    (
      await f.request('/api/posts/html', 'PUT', {
        draft: draft('html', '<img src="/images/uploads/missing.png">'),
        etag: null,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/api/posts/reference', 'PUT', {
        draft: draft('reference', '![photo][picture]\n\n[picture]: /images/uploads/missing.png'),
        etag: null,
      })
    ).status,
    400,
  );
});

const shortDraft = (slug, body_markdown) => ({
  front_matter: { slug, date: '2026-11-06 12:00', draft: true },
  body_markdown,
});

test('short drafts validate local images and retain the last saved content on failure', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await seed(bucket, 'uploads/short.png');
  const body = '![Photo](/images/uploads/short.png)';
  const saved = await f.request('/api/shorts/note', 'PUT', {
    ...shortDraft('note', body),
    etag: null,
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const { etag } = await saved.json();
  const image = (await catalog(f)).images[0];
  assert.ok(image.references.some((ref) => ref.kind === 'draft' && ref.slug === 'note'));
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 409);
  const rejected = await f.request('/api/shorts/note', 'PUT', {
    ...shortDraft('note', '![Removed](/images/uploads/missing.png)'),
    etag,
  });
  assert.equal(rejected.status, 400);
  const retained = await (await f.request('/api/shorts/note')).json();
  assert.equal(retained.draft.body_markdown, body);
  assert.equal(retained.etag, etag);
  const invalidBodies = [
    '<img src="/images/uploads/missing.png">',
    '![Photo][ref]\n\n[ref]: /images/uploads/missing.png',
    '![Photo](https://notes.reader.workers.dev/images/uploads%2Fmissing.png)',
    '<img src="/images/uploads/short.png" srcset="/images/uploads/missing.png 640w">',
  ];
  for (const [index, body] of invalidBodies.entries()) {
    const slug = 'invalid-' + index;
    assert.equal(
      (
        await f.request('/api/shorts/' + slug, 'PUT', {
          ...shortDraft(slug, body),
          etag: null,
        })
      ).status,
      400,
    );
    assert.equal(await bucket.head('shorts/' + slug + '.md'), null);
  }
  const external = await f.request('/api/shorts/external', 'PUT', {
    ...shortDraft(
      'external',
      '![External](https://photos.example.org/image.png)\n\nExample: `/images/uploads/missing.png`',
    ),
    etag: null,
  });
  assert.equal(external.status, 200, await external.clone().text());
});

test('short publication validates legacy image references before starting a release', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const source =
    '+++\nslug = "legacy"\ndate = "2026-11-06 12:00"\ndraft = true\n+++\n\n![Photo](/images/uploads/legacy.png)';
  const original = await bucket.put('shorts/legacy.md', source, {
    customMetadata: { date: '2026-11-06 12:00' },
  });
  const pointer = await (await bucket.get('state/published.json')).text();
  const rejected = await f.request('/api/publish', 'POST', {
    shortSlug: 'legacy',
    etag: original.etag,
  });
  assert.equal(rejected.status, 400);
  assert.equal(await bucket.head('state/pending.json'), null);
  assert.equal(await (await bucket.get('state/published.json')).text(), pointer);
  assert.equal(await (await bucket.get('shorts/legacy.md')).text(), source);
  await seed(bucket, 'uploads/legacy.png');
  const release = await f.prepare({ shortSlug: 'legacy', etag: original.etag });
  let image = (await catalog(f)).images[0];
  assert.ok(image.references.some((ref) => ref.kind === 'pending'));
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 409);
  await f.stage(release);
  assert.equal((await f.commit(release)).status, 200);
  const updated = await f.request('/api/shorts/legacy', 'PUT', {
    ...shortDraft('legacy', 'Photo removed from draft'),
    etag: original.etag,
  });
  assert.equal(updated.status, 200, await updated.clone().text());
  image = (await catalog(f)).images[0];
  assert.ok(image.references.some((ref) => ref.kind === 'published'));
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 409);
  const offline = await f.prepare({ unpublishShort: 'legacy' });
  await f.stage(offline);
  assert.equal((await f.commit(offline)).status, 200);
  image = (await catalog(f)).images[0];
  assert.equal((await f.request('/api/images', 'DELETE', image)).status, 200);
});

test('a short save and image deletion cannot leave a stored dangling reference', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await seed(bucket);
  const image = (await catalog(f)).images[0];
  const [removed, saved] = await Promise.all([
    f.request('/api/images', 'DELETE', image),
    f.request('/api/shorts/race', 'PUT', {
      ...shortDraft('race', '![Photo](/images/uploads/unused.png)'),
      etag: null,
    }),
  ]);
  assert.ok([200, 409].includes(removed.status));
  assert.ok([200, 400].includes(saved.status));
  if (await bucket.head('shorts/race.md')) assert.ok(await bucket.head(image.key));
  else assert.equal(await bucket.head(image.key), null);
});

test('encoded image references protect legacy indexes and reject missing local images', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const object = await seed(bucket, 'uploads/encoded.png');
  const bodies = [
    '![Photo](/images/uploads/encoded&period;png)',
    '![Photo](/images/uploads/encoded\\.png)',
    '![Photo][ref]\n\n[ref]: /images/uploads/encoded%2Epng',
    '<img src="/images/up\nloads/encoded&period;png">',
    '<img src="/images/uploads/folder/../encoded.png">',
  ];
  for (const [index, body] of bodies.entries()) {
    const slug = 'encoded-' + index;
    const saved = await f.request('/api/posts/' + slug, 'PUT', {
      draft: draft(slug, body),
      etag: null,
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const key = 'drafts/' + slug + '.md';
    const stored = await bucket.get(key);
    const text = await stored.text();
    assert.equal(stored.customMetadata.image_refs_version, '2');
    // Simulate an existing, incorrectly empty index from the old extractor.
    await bucket.put(key, text, {
      customMetadata: { ...stored.customMetadata, image_refs: '[]', image_refs_version: '1' },
    });
    const image = (await catalog(f)).images[0];
    assert.ok(image.references.some((ref) => ref.slug === slug));
    const indexed = await f.request('/api/images/reindex', 'POST', {});
    assert.equal(indexed.status, 200, await indexed.clone().text());
    const reindexed = await bucket.get(key);
    assert.equal(await reindexed.text(), text);
    assert.equal(reindexed.customMetadata.image_refs_version, '2');
    assert.equal(
      (await f.request('/api/images', 'DELETE', { key: object.key, etag: object.etag })).status,
      409,
    );
    assert.equal(
      (await f.request('/api/posts/' + slug, 'DELETE', { etag: (await bucket.head(key)).etag }))
        .status,
      200,
    );
  }
  assert.equal(
    (
      await f.request('/api/posts/missing-encoded', 'PUT', {
        draft: draft('missing-encoded', '![Missing](/images/uploads/missing&period;png)'),
        etag: null,
      })
    ).status,
    400,
  );
  let next = {},
    updated = 0;
  do {
    const response = await f.request('/api/images/reindex', 'POST', next);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    updated += result.updated;
    next = result.next;
  } while (next);
  assert.equal(updated, 0, 'deleted drafts are not rewritten by reindexing');
});

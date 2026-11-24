import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, draft } from './fixture.mjs';
import { authenticatedWorker } from './wasm-worker.mjs';
const sha = (text) => createHash('sha256').update(text).digest('hex');
test('article batch manifests use ten published posts per page and route extra batches as canonical HTML', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const current = await (await bucket.get('state/published.json')).json();
  const releaseKey = `releases/${current.id}.json`;
  const release = await (await bucket.get(releaseKey)).json();
  const source = (slug, hidden = false) =>
    '+++\ntitle = "Article"\nslug = "' +
    slug +
    '"\ndate = "2026-11-09"\ndraft = ' +
    hidden +
    '\n+++\n\nBody';
  for (let i = 0; i < 21; i++) release.markdown_posts['item-' + i] = source('item-' + i);
  release.markdown_posts.private = source('private', true);
  await bucket.put(releaseKey, JSON.stringify(release));
  const many = await f.prepare();
  assert.deepEqual(
    many.files.filter((p) => p.startsWith('post/')),
    ['post/index.html', 'post/page/2/index.html', 'post/page/3/index.html'],
  );
  assert.equal((await f.request(`/api/publish/${many.release_id}/cancel`, 'POST', {})).status, 200);
  delete release.markdown_posts['item-20'];
  await bucket.put(releaseKey, JSON.stringify(release));
  const fewer = await f.prepare();
  assert(!fewer.files.includes('post/page/3/index.html'));
  const page = 'post/page/2/index.html';
  const staged = await f.request(
    `/api/publish/${fewer.release_id}/file?path=${encodeURIComponent(page)}`,
    'PUT',
    '<html><head><title>Batch</title></head><body>Public batch</body></html>',
  );
  assert.equal(staged.status, 200, await staged.text());
  const uploaded = await bucket.head(`public/${fewer.release_id}/${page}`);
  assert.match(uploaded.httpMetadata.contentType, /text\/html/);
  assert.equal(
    (await f.request(`/api/publish/${fewer.release_id}/cancel`, 'POST', {})).status,
    200,
  );
  const key = 'a'.repeat(64);
  await bucket.put(
    'public/content/' + key,
    '<html><head><title>Batch</title></head><body>Public batch</body></html>',
  );
  await bucket.put(
    'state/published.json',
    JSON.stringify({
      id: 'batch-release',
      pages: { 'index.html': key, 'post/page/2/index.html': key },
    }),
  );
  for (const path of ['/post/page/2/', '/post/page/2', '/post/page/2/index.html']) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.match(
      await response.text(),
      /rel="canonical" href="https:\/\/notes.reader.workers.dev\/post\/page\/2\/"/,
    );
  }
  assert.equal((await f.request('/post/page/3/')).status, 404);
});
async function planned(f, state, receipts = true) {
  const paths = (state.render_files || state.files).filter(
    (path) => !['styles.css', 'client.js', 'favicon.svg', 'sw.js'].includes(path),
  );
  const values = Object.fromEntries(
    paths.map((path) => [
      path,
      path === '_release.json'
        ? JSON.stringify({ id: state.release_id, template_version: state.template_version })
        : path === 'manifest.webmanifest'
          ? JSON.stringify({ name: 'Test Blog', icons: [] })
          : path.endsWith('.html')
            ? '<html><head></head><body>Stable page</body></html>'
            : '[]',
    ]),
  );
  const planResponse = await f.request('/api/publish/' + state.release_id + '/plan', 'POST', {
    sources: Object.fromEntries(Object.entries(values).map(([path, text]) => [path, sha(text)])),
  });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json(),
    uploaded = {};
  for (const path of plan.files) {
    const response = await f.request(
      '/api/publish/' + state.release_id + '/file?path=' + encodeURIComponent(path),
      'PUT',
      values[path],
    );
    assert.equal(response.status, 200, await response.clone().text());
    uploaded[path] = (await response.json()).receipt;
  }
  return { files: plan.files, receipts: receipts ? uploaded : {} };
}
test('selective publication reuses validated sizes across HTTP versions and verifies signed upload receipts', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const first = await f.prepare();
  const initial = await planned(f, first);
  const commit = await f.request('/api/publish/' + first.release_id + '/commit', 'POST', {
    receipts: initial.receipts,
  });
  assert.equal(commit.status, 200, await commit.clone().text());
  assert.equal((await commit.json()).verification.heads, 0);
  const originalPage = await (await f.request('/')).text();
  await f.request('/');
  // Save unchanged site settings: only the version marker needs rendering.
  const settings = await (await f.request('/api/settings')).json();
  await f.request('/api/settings', 'PUT', settings);
  const second = await f.prepare({ settings: true });
  assert.deepEqual(second.render_files, ['_release.json']);
  const pending = await (await bucket.get('state/pending.json')).json();
  await bucket.put(
    'state/pending.json',
    JSON.stringify({ ...pending, response_version: 'changed-http-policy' }),
  );
  const plan = await planned(f, second);
  assert.deepEqual(plan.files, ['_release.json']);
  const result = await f.request('/api/publish/' + second.release_id + '/commit', 'POST', {
    receipts: plan.receipts,
  });
  assert.equal(result.status, 200, await result.clone().text());
  const verified = (await result.json()).verification;
  assert.equal(verified.heads, 0);
  assert.ok(verified.reused >= 5);
  const pointer = await (await bucket.get('state/published.json')).json();
  await bucket.delete('public/content/' + pointer.pages['index.html']);
  const sharedPage = await f.request('/');
  assert.equal(sharedPage.headers.get('Cache-Status'), 'CloudInk; hit');
  assert.equal(await sharedPage.text(), originalPage);
  const rebuilt = await f.prepare();
  const fresh = await planned(f, rebuilt);
  const path = Object.keys(fresh.receipts).find((path) => path !== '_release.json');
  fresh.receipts[path][0]++;
  assert.equal(
    (
      await f.request('/api/publish/' + rebuilt.release_id + '/commit', 'POST', {
        receipts: fresh.receipts,
      })
    ).status,
    409,
  );
  assert.equal((await (await bucket.get('state/published.json')).json()).id, second.release_id);
});
test('short publication refreshes the home and short feed while preserving unrelated pages and private drafts', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const article = await (
    await f.request('/api/posts/live', 'PUT', { draft: draft('live'), etag: null })
  ).json();
  const initial = await f.prepare({ slug: 'live', etag: article.etag });
  const first = await planned(f, initial);
  assert.equal(
    (
      await f.request('/api/publish/' + initial.release_id + '/commit', 'POST', {
        receipts: first.receipts,
      })
    ).status,
    200,
  );
  const original = await (await bucket.get('state/published.json')).json();
  await f.request('/api/posts/private', 'PUT', { draft: draft('private'), etag: null });
  const note = (slug, body) => ({
    front_matter: { slug, date: '2026-11-08 12:00', draft: true },
    body_markdown: body,
  });
  await f.request('/api/shorts/private-note', 'PUT', note('private-note', 'Private note'));
  let etag = null;
  for (const operation of ['create', 'edit', 'unpublish']) {
    let input = { unpublishShort: 'live-note' };
    if (operation !== 'unpublish') {
      const saved = await (
        await f.request('/api/shorts/live-note', 'PUT', {
          ...note('live-note', 'Published note ' + operation),
          etag,
        })
      ).json();
      etag = saved.etag;
      input = { shortSlug: 'live-note', etag };
    }
    const state = await f.prepare(input);
    assert.deepEqual(
      [...state.render_files].sort(),
      ['index.html', 'shorts/index.html', '_release.json'].sort(),
      operation + ' must refresh both public views of short notes',
    );
    assert.equal(Object.hasOwn(state.browser_release.markdown_posts, 'private'), false);
    assert.equal(Object.hasOwn(state.browser_release.markdown_shorts, 'private-note'), false);
    const pages = await planned(f, state);
    assert.equal(
      (
        await f.request('/api/publish/' + state.release_id + '/commit', 'POST', {
          receipts: pages.receipts,
        })
      ).status,
      200,
    );
    const current = await (await bucket.get('state/published.json')).json();
    for (const path of [
      'posts/live/index.html',
      'post/index.html',
      'archive/index.html',
      'search_index.json',
    ])
      assert.equal(current.pages[path], original.pages[path], operation + ': ' + path);
  }
});
test('article creation, edits and withdrawal refresh the public article list without publishing other drafts', async (t) => {
  const f = await fixture(t);
  await f.login();
  const first = await f.prepare();
  let pages = await planned(f, first);
  assert.equal(
    (
      await f.request('/api/publish/' + first.release_id + '/commit', 'POST', {
        receipts: pages.receipts,
      })
    ).status,
    200,
  );
  await f.request('/api/posts/private', 'PUT', { draft: draft('private'), etag: null });
  let etag = null;
  for (const operation of ['create', 'edit', 'unpublish']) {
    let input = { unpublish: 'listed' };
    if (operation !== 'unpublish') {
      const saved = await (
        await f.request('/api/posts/listed', 'PUT', { draft: draft('listed', operation), etag })
      ).json();
      etag = saved.etag;
      input = { slug: 'listed', etag };
    }
    const state = await f.prepare(input);
    assert(
      state.render_files.includes('post/index.html'),
      operation + ' must refresh the article list',
    );
    assert.equal(Object.hasOwn(state.browser_release.markdown_posts, 'private'), false);
    assert.equal(
      Object.hasOwn(state.browser_release.markdown_posts, 'listed'),
      operation !== 'unpublish',
    );
    pages = await planned(f, state);
    assert.equal(
      (
        await f.request('/api/publish/' + state.release_id + '/commit', 'POST', {
          receipts: pages.receipts,
        })
      ).status,
      200,
    );
  }
});
test('article summaries avoid source reads and paginated private lists reject stale cursors', async (t) => {
  const f = await fixture(t);
  await f.login();
  const saved = await (
    await f.request('/api/posts/live', 'PUT', { draft: draft('live'), etag: null })
  ).json();
  const state = await f.prepare({ slug: 'live', etag: saved.etag });
  await f.stage(state);
  assert.equal((await f.commit(state)).status, 200);
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const index = await (await bucket.get('releases/' + state.release_id + '.posts.json')).json();
  assert.equal(index.posts.live.title, 'A blog post');
  assert.equal(
    (
      await f.request(
        '/api/backup/image?key=' + encodeURIComponent('uploads/sha256/' + 'a'.repeat(64) + '.png'),
        'PUT',
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      )
    ).status,
    400,
  );
  const release = await (await bucket.get('releases/' + state.release_id + '.json')).text();
  await bucket.delete('releases/' + state.release_id + '.json');
  assert.equal(
    (await f.request('/api/posts')).status,
    200,
    'a valid summary index does not reopen the source snapshot',
  );
  await bucket.put('releases/' + state.release_id + '.json', release);
  for (let i = 0; i < 70; i++) {
    const slug = 'page-' + String(i).padStart(3, '0');
    await bucket.put('drafts/' + slug + '.md', 'source not needed by listing', {
      customMetadata: { title: 'Page ' + i, date: '2026-11-06', description: '' },
    });
  }
  const page = await (await f.request('/api/posts?limit=50')).json();
  assert.equal(page.posts.length, 50);
  assert.equal(page.counts.total, 71);
  const more = await (
    await f.request('/api/posts?limit=50&cursor=' + encodeURIComponent(page.cursor))
  ).json();
  assert.equal(more.posts.length, 21);
  assert.equal(new Set([...page.posts, ...more.posts].map((p) => p.slug)).size, 71);
  const found = await (await f.request('/api/posts?limit=50&q=page-069')).json();
  assert.equal(found.posts.length, 1);
  await bucket.put('drafts/page-new.md', 'new', {
    customMetadata: { title: 'New', date: '2026-11-06' },
  });
  assert.equal(
    (await f.request('/api/posts?limit=50&cursor=' + encodeURIComponent(page.cursor))).status,
    409,
  );
});
test('more than thirty multi-image drafts retain complete deletion protection and repair a missing large index', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE'),
    keys = [];
  for (let i = 0; i < 12; i++) {
    const key = 'uploads/' + 'long-image-name-'.repeat(5) + i + '.png';
    keys.push(key);
    await bucket.put(key, new Uint8Array([137, 80, 78, 71]), {
      httpMetadata: { contentType: 'image/png' },
    });
  }
  const body = keys.map((key) => '![](/images/' + key + ')').join('\n');
  for (let i = 0; i < 40; i++) {
    const response = await f.request('/api/posts/multi-' + i, 'PUT', {
      draft: draft('multi-' + i, body),
      etag: null,
    });
    assert.equal(response.status, 200, await response.clone().text());
  }
  const object = await bucket.head('drafts/multi-0.md');
  assert.match(object.customMetadata.image_refs_hash, /^[a-f0-9]{64}$/);
  assert.equal(object.customMetadata.image_refs, undefined);
  let catalog = await (await f.request('/api/images?catalog=1')).json();
  assert.equal(catalog.referencesChecked, true);
  assert.equal(catalog.images[0].references.length, 40);
  const unused = await bucket.put('uploads/unreferenced.png', new Uint8Array([137, 80, 78, 71]), {
    httpMetadata: { contentType: 'image/png' },
  });
  assert.equal(
    (await f.request('/api/images', 'DELETE', { key: unused.key, etag: unused.etag })).status,
    200,
  );
  const hash = object.customMetadata.image_refs_hash;
  await bucket.delete('image-reference-index/' + hash.slice(0, 2) + '.json');
  catalog = await (await f.request('/api/images?catalog=1')).json();
  assert.equal(catalog.referencesChecked, false);
  assert.equal(catalog.reindexRequired, true);
  let next = {};
  do {
    const result = await (await f.request('/api/images/reindex', 'POST', next)).json();
    next = result.next;
  } while (next);
  assert.equal((await bucket.head(object.key)).etag, object.etag);
  catalog = await (await f.request('/api/images?catalog=1')).json();
  assert.equal(catalog.referencesChecked, true);
});
test('bounded mutation work stops before lease expiry and keeps normal saves available after failure', async () => {
  let now = Date.now(),
    version = 0,
    expire = true;
  const originalNow = Date.now;
  Date.now = () => now;
  const objects = new Map();
  const storage = {
    async get(key) {
      if (key === 'draft-site.json' && expire) {
        assert.equal(
          JSON.parse(objects.get('state/content-mutation.json').body).expires,
          now + 3 * 60_000,
        );
        now += 60_001;
        expire = false;
      }
      const o = objects.get(key);
      return o ? { ...o, json: async () => JSON.parse(o.body) } : null;
    },
    async put(key, body, options = {}) {
      const old = objects.get(key),
        condition = options.onlyIf;
      if (condition && (condition.etagMatches ? old?.etag !== condition.etagMatches : !!old))
        return null;
      const object = { key, body, etag: String(++version) };
      objects.set(key, object);
      return object;
    },
  };
  try {
    const request = await authenticatedWorker(storage);
    const save = () =>
      request('/api/settings', 'PUT', {
        site: { title: 'Reader blog', subtitle: '', description: '', author: 'Reader' },
      });
    const blocked = await save();
    assert.equal(blocked.status, 503);
    assert.match((await blocked.json()).error, /本批操作已暂停/);
    assert.equal(objects.has('draft-site.json'), false);
    assert.equal((await save()).status, 200);
    assert.ok(objects.has('draft-site.json'));
  } finally {
    Date.now = originalNow;
  }
});

test('ordinary saves skip identical persisted writes while stale editors and legacy export remain rejected', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await f.request('/api/export')).status, 410);
  const input = { draft: draft('same'), etag: null };
  let response = await f.request('/api/posts/same', 'PUT', input);
  assert.equal(response.status, 200);
  const saved = await response.json();
  const before = await bucket.head('drafts/same.md');
  response = await f.request('/api/posts/same', 'PUT', { ...input, etag: saved.etag });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).unchanged, true);
  assert.equal((await bucket.head(before.key)).version, before.version);
  assert.equal(
    (await f.request('/api/posts/same', 'PUT', { ...input, etag: 'stale' })).status,
    409,
  );
  const changed = await f.request('/api/posts/same', 'PUT', {
    draft: draft('same', 'Changed'),
    etag: saved.etag,
  });
  assert.equal(changed.status, 200);
  assert.notEqual((await bucket.head(before.key)).version, before.version);
  const settings = await (await f.request('/api/settings')).json();
  const firstSettings = await (await f.request('/api/settings', 'PUT', settings)).json();
  const site = await bucket.head('draft-site.json');
  assert.equal((await f.request('/api/settings', 'PUT', firstSettings)).status, 200);
  assert.equal((await bucket.head(site.key)).version, site.version);
  const short = {
    front_matter: { slug: 'same-short', date: '2026-11-06 18:00', draft: true },
    body_markdown: 'Short',
  };
  const firstShort = await (await f.request('/api/shorts/same-short', 'PUT', short)).json();
  const shortObject = await bucket.head('shorts/same-short.md');
  assert.equal(
    (await f.request('/api/shorts/same-short', 'PUT', { ...short, etag: firstShort.etag })).status,
    200,
  );
  assert.equal((await bucket.head(shortObject.key)).version, shortObject.version);
});

test('published short and media summaries support lists without reopening the source snapshot and preserve deletion protection', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const key = 'uploads/summary.png';
  const image = await bucket.put(key, new Uint8Array([137, 80, 78, 71]), {
    httpMetadata: { contentType: 'image/png' },
  });
  const short = {
    front_matter: { slug: 'indexed-short', date: '2026-11-06 18:00', draft: true },
    body_markdown: '![](/images/' + key + ')',
  };
  const saved = await (await f.request('/api/shorts/indexed-short', 'PUT', short)).json();
  const state = await f.prepare({ shortSlug: 'indexed-short', etag: saved.etag });
  await f.stage(state);
  assert.equal((await f.commit(state)).status, 200);
  await bucket.delete(['releases/' + state.release_id + '.json', 'shorts/indexed-short.md']);
  const page = await (await f.request('/api/shorts?limit=1')).json();
  assert.equal(page.shorts[0].slug, 'indexed-short');
  assert.match(page.shorts[0].snippet, /summary.png/);
  const catalog = await (await f.request('/api/images?catalog=1')).json();
  assert.equal(catalog.referencesChecked, true);
  assert.ok(catalog.images[0].references.some((r) => r.kind === 'published'));
  assert.equal((await f.request('/api/images', 'DELETE', { key, etag: image.etag })).status, 409);
  const indexKey = 'releases/' + state.release_id + '.posts.json';
  const index = await (await bucket.get(indexKey)).json();
  index.images.entries[0].keys = ['auth/account.json'];
  await bucket.put(indexKey, JSON.stringify(index));
  assert.equal((await (await f.request('/api/images?catalog=1')).json()).referencesChecked, false);
  assert.equal((await f.request('/api/images', 'DELETE', { key, etag: image.etag })).status, 503);
});

test('short pagination rejects changed snapshots and tombstones do not consume live-item budgets', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  for (const slug of ['a', 'b', 'c'])
    await bucket.put('shorts/' + slug + '.md', 'not opened by list', {
      customMetadata: { date: '2026-11-06 18:00', snippet: slug },
    });
  const first = await (await f.request('/api/shorts?limit=2')).json();
  assert.equal(first.shorts.length, 2);
  assert.ok(first.cursor);
  const second = await (
    await f.request('/api/shorts?limit=2&cursor=' + encodeURIComponent(first.cursor))
  ).json();
  assert.equal(second.shorts.length, 1);
  await bucket.put('shorts/new.md', 'new', { customMetadata: { date: '2026-11-07 18:00' } });
  assert.equal(
    (await f.request('/api/shorts?limit=2&cursor=' + encodeURIComponent(first.cursor))).status,
    409,
  );
  const listDrafts = async (path, objects) => {
    const request = await authenticatedWorker(catalog(objects));
    return request(path);
  };
  const removed = Array.from({ length: 2100 }, (_, i) => ({
    key: 'drafts/deleted-' + i + '.md',
    customMetadata: { deleted: 'true' },
  }));
  const live = { key: 'drafts/live.md', customMetadata: {} };
  const catalog = (objects) => ({
    async get(key) {
      if (key === 'state/published.json')
        return { json: async () => ({ id: 'release', pages: { 'index.html': 'exists' } }) };
      if (key === 'releases/release.posts.json')
        return {
          json: async () => ({ schema_version: 1, id: 'release', site: {}, posts: {}, shorts: {} }),
        };
      return null;
    },
    list: async ({ cursor, limit }) => {
      const offset = Number(cursor || 0),
        next = offset + limit;
      return {
        objects: objects.slice(offset, next),
        truncated: next < objects.length,
        cursor: String(next),
      };
    },
  });
  const listed = await listDrafts('/api/posts', [...removed, live]);
  assert.deepEqual(
    (await listed.json()).posts.map(({ slug }) => slug),
    ['live'],
  );
  const tooManyDrafts = await listDrafts(
    '/api/posts',
    Array.from({ length: 2001 }, (_, index) => ({ ...live, key: 'drafts/live-' + index + '.md' })),
  );
  assert.equal(tooManyDrafts.status, 413);
  const tooManyTombstones = await listDrafts(
    '/api/shorts',
    Array.from({ length: 10001 }, (_, index) => ({
      key: 'shorts/deleted-' + index + '.md',
      customMetadata: { deleted: 'true' },
    })),
  );
  assert.equal(tooManyTombstones.status, 413);
});

test('request diagnostics keep bindings bound, isolate counters and exclude object keys and payloads', async () => {
  const listed = Promise.withResolvers();
  const storage = {
    async get(key) {
      assert.equal(this, storage);
      if (key === 'state/published.json')
        return { json: async () => ({ id: 'fixture', pages: { 'index.html': 'exists' } }) };
      if (key === 'releases/fixture.posts.json') {
        await listed.promise;
        throw new Error('private payload');
      }
      return null;
    },
    async list() {
      assert.equal(this, storage);
      listed.resolve();
      return { objects: [{}, {}] };
    },
    async put() {
      assert.equal(this, storage);
      throw new Error('private payload');
    },
  };
  const request = await authenticatedWorker(storage);
  const original = console.log;
  const logs = [];
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    const first = await request('/api/posts');
    const second = await request('/api/settings', 'PUT', { site: 'secret-body' });
    assert.equal(first.status, 500);
    assert.equal(second.status, 500);
    const byId = (response) =>
      logs.find((row) => row.request_id === response.headers.get('X-Request-ID'));
    const read = byId(first);
    assert.equal(read.get, 6);
    assert.equal(read.list, 1);
    assert.equal(read.objects, 2);
    assert.equal(read.put, 0);
    assert.equal(read.errors, 1);
    const write = byId(second);
    assert.equal(write.get, 3);
    assert.equal(write.list, 0);
    assert.equal(write.objects, 0);
    assert.equal(write.put, 1);
    assert.equal(write.errors, 1);
  } finally {
    console.log = original;
  }
  assert.doesNotMatch(
    JSON.stringify(logs),
    /private-token|secret-body|private payload|auth\/sessions/,
  );
});

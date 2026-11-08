import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from '../../cloud-admin/node_modules/esbuild/lib/main.js';
import { fixture, draft } from './fixture.mjs';
const sha = (text) => createHash('sha256').update(text).digest('hex');
async function planned(f, state, receipts = true) {
  const paths = (state.render_files || state.files).filter(
    (path) =>
      !['styles.css', 'client.js', 'favicon.svg', 'manifest.webmanifest', 'sw.js'].includes(path),
  );
  const values = Object.fromEntries(
    paths.map((path) => [
      path,
      path === '_release.json'
        ? JSON.stringify({ id: state.release_id, template_version: state.template_version })
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
    for (const path of ['posts/live/index.html', 'archive/index.html', 'search_index.json'])
      assert.equal(current.pages[path], original.pages[path], operation + ': ' + path);
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
  const bundle = await build({
    entryPoints: ['cloud-admin/src/storage-mutations.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const { withContentMutation, CONTENT_LEASE_MS } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );
  let now = Date.now(),
    version = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const objects = new Map();
  const storage = {
    async get(key) {
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
    await assert.rejects(
      withContentMutation(storage, async (guarded) => {
        assert.equal(
          JSON.parse(objects.get('state/content-mutation.json').body).expires,
          now + CONTENT_LEASE_MS,
        );
        now += 60001;
        await guarded.put('drafts/late.md', 'unsafe');
      }),
      /本批操作已暂停/,
    );
    assert.equal(objects.has('drafts/late.md'), false);
    await withContentMutation(storage, (guarded) => guarded.put('drafts/safe.md', 'saved'));
    assert.ok(objects.has('drafts/safe.md'));
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
  const bundle = await build({
    entryPoints: ['cloud-admin/src/draft-catalog.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const { listActiveDrafts } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );
  const removed = Array.from({ length: 2100 }, (_, i) => ({
    key: 'drafts/deleted-' + i + '.md',
    customMetadata: { deleted: 'true' },
  }));
  const live = { key: 'drafts/live.md', customMetadata: {} };
  const storage = { list: async () => ({ objects: [...removed, live], truncated: false }) };
  assert.deepEqual(await listActiveDrafts(storage, 'drafts/'), [live]);
});

test('request diagnostics keep bindings bound, isolate counters and exclude object keys and payloads', async () => {
  const bundle = await build({
    entryPoints: ['cloud-admin/src/request-stats.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const { storageStats } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );
  const storage = {
    async get() {
      assert.equal(this, storage);
      return null;
    },
    async list() {
      assert.equal(this, storage);
      return { objects: [{}, {}] };
    },
    async put() {
      throw new Error('private payload');
    },
  };
  const first = storageStats(storage),
    second = storageStats(storage);
  await first.bucket.get('auth/sessions/private-token');
  await first.bucket.list({ prefix: 'drafts/' });
  await assert.rejects(first.bucket.put('private', 'secret-body'));
  const original = console.log,
    logs = [];
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    first.report('request-a', '/api/posts', 'GET', 500, Date.now());
    second.report('request-b', '/api/posts', 'GET', 500, Date.now());
  } finally {
    console.log = original;
  }
  assert.equal(logs[0].get, 1);
  assert.equal(logs[0].list, 1);
  assert.equal(logs[0].objects, 2);
  assert.equal(logs[0].put, 1);
  assert.equal(logs[0].errors, 1);
  assert.equal(logs[1].get, 0);
  assert.equal(logs[1].errors, 0);
  assert.doesNotMatch(JSON.stringify(logs), /private-token|secret-body|private payload/);
});

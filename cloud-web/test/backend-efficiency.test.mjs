import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from '../../cloud-admin/node_modules/esbuild/lib/main.js';
import { fixture, draft } from './fixture.mjs';
const sha = (text) => createHash('sha256').update(text).digest('hex');
async function planned(f, state, receipts = true) {
  const paths = (state.render_files || state.files).filter(
    (path) => !['styles.css', 'client.js', 'favicon.svg'].includes(path),
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

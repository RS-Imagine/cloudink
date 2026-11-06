import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from '../../cloud-admin/node_modules/esbuild/lib/main.js';
import { fixture } from './fixture.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
async function rendered(f, state, overrides = {}) {
  const values = Object.fromEntries(
    state.files
      .filter(
        (path) =>
          !['styles.css', 'client.js', 'favicon.svg', 'manifest.webmanifest', 'sw.js'].includes(
            path,
          ),
      )
      .map((path) => [
        path,
        path === '_release.json'
          ? JSON.stringify({ id: state.release_id, template_version: state.template_version })
          : path.endsWith('.html')
            ? '<html><head><title>Quota</title></head><body><h1>Stable page</h1></body></html>'
            : path === 'site.json'
              ? JSON.stringify({ title: 'Quota blog' })
              : '[]',
      ]),
  );
  Object.assign(values, overrides);
  const response = await f.request(`/api/publish/${state.release_id}/plan`, 'POST', {
    sources: Object.fromEntries(Object.entries(values).map(([path, text]) => [path, sha(text)])),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return { values, files: (await response.json()).files };
}
async function upload(f, state, plan, skip = []) {
  for (const path of plan.files) {
    if (skip.includes(path)) continue;
    const response = await f.request(
      `/api/publish/${state.release_id}/file?path=${encodeURIComponent(path)}`,
      'PUT',
      plan.values[path],
    );
    assert.equal(response.status, 200, await response.clone().text());
  }
}

test('incremental publication reuses unchanged pages, skips compiled assets and keeps atomic cancellation and missing-file protection', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const settings = await (await f.request('/api/settings')).json();
  assert.equal((await f.request('/api/settings', 'PUT', settings)).status, 200);
  const first = await f.prepare({ settings: true });
  const plan = await rendered(f, first);
  assert.ok(!plan.files.includes('styles.css'));
  assert.equal(
    (
      await f.request(
        `/api/publish/${first.release_id}/file?path=index.html`,
        'PUT',
        'wrong fingerprint',
      )
    ).status,
    409,
  );
  await upload(f, first, plan);
  assert.equal((await f.commit(first)).status, 200);
  const live = await (await bucket.get('state/published.json')).json();
  assert.ok(live.pages['index.html']);
  const count = (await bucket.list({ prefix: 'public/content/' })).objects.length;
  const second = await f.prepare({ settings: true });
  const next = await rendered(f, second);
  assert.deepEqual(next.files, ['_release.json']);
  await upload(f, second, next);
  assert.equal((await f.commit(second)).status, 200);
  const after = await (await bucket.get('state/published.json')).json();
  assert.equal(after.pages['index.html'], live.pages['index.html']);
  assert.equal((await bucket.list({ prefix: 'public/content/' })).objects.length, count + 1);
  assert.equal((await f.request('/api/posts')).status, 200);
  assert.match(await (await f.request('/feed.xml')).text(), /Quota blog/);
  assert.match(await (await f.request('/sitemap.xml')).text(), /\/archive\//);
  const third = await f.prepare({ settings: true });
  await rendered(f, third);
  assert.equal(
    (await f.request(`/api/publish/${third.release_id}/cancel`, 'POST', {})).status,
    200,
  );
  assert.deepEqual((await (await bucket.get('state/published.json')).json()).pages, after.pages);
  const missing = await f.prepare({ settings: true });
  const incomplete = await rendered(f, missing, { '404.html': '<html>new missing page</html>' });
  await upload(f, missing, incomplete, ['404.html']);
  assert.equal((await f.commit(missing)).status, 409);
  assert.equal((await (await bucket.get('state/published.json')).json()).id, second.release_id);
  const rebuild = await f.prepare({ rebuild: true });
  const complete = await rendered(f, rebuild);
  assert.equal(
    complete.files.length,
    Object.keys(complete.values).length,
    'explicit rebuild refreshes image attributes even when source HTML is unchanged',
  );
});

test('warm public caches serve body, HEAD and validators without reopening deleted origin objects; media checks still run before cache', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const state = await f.prepare();
  await f.stage(state);
  assert.equal((await f.commit(state)).status, 200);
  const first = await f.request('/');
  const body = await first.text();
  assert.doesNotMatch(body, /src="\/analytics.js"/);
  // Let waitUntil finish through the next request; no timeout or extra fixture deployment.
  await f.request('/');
  await bucket.delete(`public/${state.release_id}/index.html`);
  const cached = await f.request('/');
  assert.equal(cached.headers.get('Cache-Status'), 'CloudInk; hit');
  assert.equal(await cached.text(), body);
  assert.equal((await f.request('/', 'HEAD')).status, 200);
  assert.equal(
    (await f.request('/', 'GET', undefined, { 'If-None-Match': first.headers.get('ETag') })).status,
    304,
  );
  await bucket.put('uploads/cache.png', new Uint8Array([137, 80, 78, 71]), {
    httpMetadata: { contentType: 'image/png' },
  });
  await (await f.request('/images/uploads/cache.png')).arrayBuffer();
  await f.request('/images/uploads/cache.png');
  await bucket.delete('uploads/cache.png');
  assert.equal((await f.request('/images/uploads/cache.png')).status, 200);
  assert.equal((await f.request('/images/uploads/cache.png', 'HEAD')).status, 200);
  assert.equal(
    (
      await f.request('/images/uploads/cache.png', 'GET', undefined, {
        Referer: 'https://unrelated.example/',
      })
    ).status,
    403,
  );
  assert.equal((await f.request('/images/state/published.json')).status, 404);
  const iconResponse = await f.request('/api/site-icon', 'POST', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>'));
  assert.equal(iconResponse.status, 201);
  const icon = await iconResponse.json(), original = await bucket.head(icon.key);
  const repeated = await f.request('/api/site-icon', 'POST', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>'));
  assert.equal(repeated.status, 201);
  assert.equal((await bucket.head(icon.key)).version, original.version);
  await (await f.request(icon.url)).arrayBuffer();
  await f.request(icon.url);
  await bucket.delete(icon.key);
  const cachedIcon = await f.request(icon.url);
  assert.equal(cachedIcon.status, 200);
  assert.equal(cachedIcon.headers.get('Cache-Status'), 'CloudInk; hit');
  assert.equal((await f.request(icon.url, 'HEAD')).status, 200);
  assert.equal((await f.request(icon.url, 'GET', undefined, {'If-None-Match':original.httpEtag})).status, 304);
  const privateResponse = await f.request('/api/posts');
  assert.equal(privateResponse.headers.get('Cache-Control'), 'no-store');
});

test('bounded retention removes only expired generated objects and protects shared pages, recent versions, user data and active publications', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const bundle = await build({
    entryPoints: ['cloud-admin/src/maintenance.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const { maintainStorage } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );
  const initialized = await (await bucket.get('state/published.json')).json();
  await bucket.delete([
    'releases/' + initialized.id + '.json',
    'releases/' + initialized.id + '.posts.json',
  ]);
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const [current, previous, old, fresh] = ids;
  const shared = 'a'.repeat(64),
    orphan = 'b'.repeat(64);
  await bucket.put(
    'state/published.json',
    JSON.stringify({ id: current, previous_ids: [previous], pages: { 'index.html': shared } }),
  );
  await bucket.put(
    `releases/${current}.manifest.json`,
    JSON.stringify({ sources: {}, pages: { 'index.html': shared } }),
  );
  await bucket.put(
    `releases/${previous}.manifest.json`,
    JSON.stringify({ sources: {}, pages: { 'index.html': shared } }),
  );
  for (const key of [
    `public/${previous}/index.html`,
    `public/${old}/index.html`,
    `public/${fresh}/index.html`,
    `releases/${old}.json`,
    'public/content/' + shared,
    'public/content/' + orphan,
    'drafts/kept.md',
    'uploads/kept.png',
    'auth/kept.json',
    'public/unrecognized/file',
  ])
    await bucket.put(key, 'kept or expired');
  const storage = {
    get: (...args) => bucket.get(...args),
    put: (...args) => bucket.put(...args),
    delete: (...args) => bucket.delete(...args),
    list: async (options) => {
      const page = await bucket.list(options);
      return {
        ...page,
        objects: page.objects.map((object) => ({
          ...object,
          uploaded: object.key.includes(fresh) ? new Date() : new Date('2020-01-01'),
        })),
      };
    },
  };
  await bucket.put(
    'state/pending.json',
    JSON.stringify({ release_id: old, status: 'building', started_at: new Date().toISOString() }),
  );
  assert.equal((await maintainStorage({ STORAGE: storage })).reason, 'publication_busy');
  assert.ok(await bucket.head('public/content/' + orphan));
  await bucket.delete('state/pending.json');
  const expiredSession = 'auth/sessions/' + 'e'.repeat(64);
  const liveSession = 'auth/sessions/' + 'f'.repeat(64);
  const legacySession = 'auth/sessions/' + 'd'.repeat(64);
  await bucket.put(expiredSession, JSON.stringify({expires: Date.now()-10000}), {customMetadata:{expires:String(Date.now()-10000)}});
  await bucket.put(liveSession, JSON.stringify({expires: Date.now()+86400000}), {customMetadata:{expires:String(Date.now()+86400000)}});
  await bucket.put(legacySession, JSON.stringify({expires: Date.now()-10000}));
  const result = await maintainStorage({ STORAGE: storage });
  assert.equal(result.expired_sessions, 2);
  assert.equal(await bucket.head(expiredSession), null);
  assert.equal(await bucket.head(legacySession), null);
  assert.ok(await bucket.head(liveSession));
  assert.equal(result.deleted_objects, 3);
  assert.equal(result.status, 'success');
  assert.ok(result.last_attempt_at);
  assert.ok(result.last_success_at);
  for (const key of [
    `public/${old}/index.html`,
    `releases/${old}.json`,
    'public/content/' + orphan,
  ])
    assert.equal(await bucket.head(key), null);
  for (const key of [
    `public/${previous}/index.html`,
    `public/${fresh}/index.html`,
    'public/content/' + shared,
    'drafts/kept.md',
    'uploads/kept.png',
    'auth/kept.json',
    'public/unrecognized/file',
  ])
    assert.ok(await bucket.head(key), key);
  assert.equal((await f.request('/api/maintenance')).status, 200);
  await bucket.put(
    `releases/${current}.manifest.json`,
    JSON.stringify({ pages: { bad: 'invalid' } }),
  );
  const failed = await maintainStorage({ STORAGE: storage });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'retained_manifests');
  assert.equal(failed.last_success_at, result.last_success_at);
  assert.equal((await (await bucket.get('state/maintenance.json')).json()).status, 'failed');
});

test('legacy short-note references remain protected before indexing', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await bucket.put('uploads/legacy-note.png', new Uint8Array([137, 80, 78, 71]), {
    httpMetadata: { contentType: 'image/png' },
  });
  for (let index = 0; index < 31; index++)
    await bucket.put(
      'shorts/legacy-' + index + '.md',
      index ? 'Old short note' : '![](/images/uploads/legacy-note.png)',
    );
  const response = await f.request('/api/images?catalog=1');
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.referencesChecked, true);
  assert.ok(
    catalog.images[0].references.some((ref) => ref.kind === 'draft' && ref.slug === 'legacy-0'),
  );
});

test('publication markers cannot reuse a prior release or bypass commit validation', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const settings = await (await f.request('/api/settings')).json();
  await f.request('/api/settings', 'PUT', settings);
  const first = await f.prepare({ settings: true });
  const original = await rendered(f, first);
  await upload(f, first, original);
  assert.equal((await f.commit(first)).status, 200);
  const next = await f.prepare({ settings: true });
  const oldMarker = original.values['_release.json'];
  const stale = await rendered(f, next, { '_release.json': oldMarker });
  assert.ok(stale.files.includes('_release.json'));
  assert.equal(
    (
      await f.request(
        '/api/publish/' + next.release_id + '/file?path=_release.json',
        'PUT',
        oldMarker,
      )
    ).status,
    400,
  );
  await f.request('/api/publish/' + next.release_id + '/cancel', 'POST', {});
  const correct = await f.prepare({ settings: true });
  const plan = await rendered(f, correct);
  await upload(f, correct, plan);
  const pending = await (await bucket.get('state/pending.json')).json();
  await bucket.put('public/content/' + pending.plan.pages['_release.json'], oldMarker);
  assert.equal((await f.commit(correct)).status, 400);
  assert.equal((await (await bucket.get('state/published.json')).json()).id, first.release_id);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, draft } from './fixture.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const source = (slug, body = 'Restored content') =>
  '+++\ntitle = "Backup"\nslug = "' +
  slug +
  '"\ndate = "2026-11-06"\ndraft = true\ndescription = ""\n+++\n\n' +
  body;
async function post(f, path, body = {}) {
  const response = await f.request(path, 'POST', body);
  assert.ok(Number(response.headers.get('X-CloudInk-Storage-Calls') || 0) <= 180);
  assert.ok(response.status < 300, await response.clone().text());
  return response.json();
}
async function startRestore(f, files, site = null, images = []) {
  const settings = await (await f.request('/api/settings')).json();
  return post(f, '/api/backup/jobs', {
    mode: 'restore',
    settings_etag: settings.etag,
    manifest: {
      format: 'cloudink-backup',
      schema_version: 1,
      site: site || settings.site,
      images,
      entries: Object.entries(files).map(([path, text]) => ({
        path,
        size: Buffer.byteLength(text),
        hash: hash(text),
      })),
    },
  });
}
async function preflightAll(f, task, files) {
  const paths = task.entries;
  while (task.phase === 'preflight') {
    const batch = Object.fromEntries(
      paths.slice(task.preflight, task.preflight + 32).map((path) => [path, files[path]]),
    );
    task = await post(f, '/api/backup/jobs/' + task.id + '/preflight', {
      index: task.preflight,
      files: batch,
    });
  }
  return task;
}

test('500 drafts export and restore within per-request budgets; checkpoint retries do not rewrite originals', async (t) => {
  const f = await fixture(t),
    target = await fixture(t);
  await f.login();
  await target.login();
  const bucket = await f.mf.getR2Bucket('STORAGE'),
    to = await target.mf.getR2Bucket('STORAGE');
  for (let i = 0; i < 500; i++)
    await bucket.put('drafts/post-' + i + '.md', source('post-' + i, 'Body ' + i));
  assert.equal((await f.request('/api/backup')).status, 409, 'old unbounded API asks to refresh');
  const exported = await post(f, '/api/backup/jobs', { mode: 'export' });
  assert.equal(exported.total, 500);
  const exportResume = await post(f, '/api/backup/jobs', { mode: 'export' });
  assert.equal(exportResume.id, exported.id);
  assert.equal(exportResume.entries.length, 500);
  assert.equal(exportResume.manifest.format, 'cloudink-backup');
  const files = {};
  let index = 0;
  do {
    const batch = await post(f, '/api/backup/jobs/' + exported.id + '/read', { index });
    Object.assign(files, batch.files);
    index = batch.next;
  } while (index !== null);
  assert.equal(Object.keys(files).length, 500);
  await post(f, '/api/backup/jobs/' + exported.id + '/finish');
  const account = await (await to.get('auth/account.json')).text();
  const pointer = await (await to.get('state/published.json')).text();
  let task = await startRestore(target, files);
  const initialId = task.id;
  task = await preflightAll(target, task, files);
  assert.equal(await to.head('drafts/post-0.md'), null, 'preflight writes only temporary chunks');
  task = await post(target, '/api/backup/jobs/' + task.id + '/apply', { batch: 0 });
  const firstKey = 'drafts/post-0.md',
    firstVersion = (await to.head(firstKey)).version;
  await post(target, '/api/backup/jobs/' + task.id + '/apply', { batch: 0 });
  assert.equal((await to.head(firstKey)).version, firstVersion);
  // The first chunk's originals survived but its checkpoint response/write was lost.
  const key = 'backup-tasks/' + task.id + '/state.json';
  const state = await (await to.get(key)).json();
  await to.put(key, JSON.stringify({ ...state, applied: 0, restored: 0 }));
  task = await post(target, '/api/backup/jobs/' + task.id + '/apply', { batch: 0 });
  assert.equal((await to.head(firstKey)).version, firstVersion);
  const resumed = await startRestore(target, files);
  assert.equal(resumed.id, initialId);
  assert.equal(resumed.applied, 1);
  task = resumed;
  while (task.applied < task.batches)
    task = await post(target, '/api/backup/jobs/' + task.id + '/apply', { batch: task.applied });
  const done = await post(target, '/api/backup/jobs/' + task.id + '/finish');
  assert.equal(done.result.restored, 500);
  assert.equal(done.result.drafts, 500);
  assert.equal(
    (await (await target.request('/api/posts/post-499')).json()).draft.body_markdown,
    'Body 499',
  );
  assert.equal(await (await to.get('auth/account.json')).text(), account);
  assert.equal(await (await to.get('state/published.json')).text(), pointer);
  assert.equal(
    (await to.list({ prefix: 'backup-tasks/' + task.id + '/chunks/' })).objects.length,
    0,
  );
  assert.equal((await post(target, '/api/backup/jobs/' + task.id + '/finish')).phase, 'complete');
});

test('batch conflicts, cancellation, expiration and metadata bounds preserve existing data', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const files = { 'drafts/item.md': source('item') };
  let task = await startRestore(f, files);
  task = await preflightAll(f, task, files);
  const changed = await f.request('/api/posts/item', 'PUT', {
    draft: draft('item', 'Concurrent content'),
    etag: null,
  });
  assert.equal(changed.status, 200);
  const rejected = await f.request('/api/backup/jobs/' + task.id + '/apply', 'POST', { batch: 0 });
  assert.equal(rejected.status, 409);
  assert.equal(
    (await (await f.request('/api/posts/item')).json()).draft.body_markdown,
    'Concurrent content',
  );
  await post(f, '/api/backup/jobs/' + task.id + '/cancel');
  const next = await startRestore(f, {});
  await post(f, '/api/backup/jobs/' + task.id + '/cancel');
  assert.equal(
    (await (await f.request('/api/backup/jobs')).json()).id,
    next.id,
    'old cancellation cannot clear a successor',
  );
  const key = 'backup-tasks/' + next.id + '/state.json';
  const expired = await (await bucket.get(key)).json();
  await bucket.put(key, JSON.stringify({ ...expired, expires: Date.now() - 1 }));
  assert.equal((await f.request('/api/backup/jobs/' + next.id)).status, 410);
  await bucket.put('state/backup-task.json', JSON.stringify({ id: next.id, expires: 0 }));
  const settings = await (await f.request('/api/settings')).json();
  const entries = Array.from({ length: 2000 }, (_, i) => ({
    path: 'drafts/bound-' + i + '.md',
    hash: hash(''),
    size: 0,
  }));
  const manifest = {
    format: 'cloudink-backup',
    schema_version: 1,
    site: settings.site,
    entries,
    images: [],
  };
  const maximum = await post(f, '/api/backup/jobs', {
    mode: 'restore',
    manifest,
    settings_etag: settings.etag,
  });
  assert.equal(maximum.total, 2000);
  await post(f, '/api/backup/jobs/' + maximum.id + '/cancel');
  entries.push({ path: 'drafts/overflow.md', hash: hash(''), size: 0 });
  assert.equal(
    (await f.request('/api/backup/jobs', 'POST', { mode: 'restore', manifest })).status,
    413,
  );
});

test('active backups protect media and changed settings pause finalization', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const image = await bucket.put('uploads/job.png', new Uint8Array([137, 80, 78, 71]), {
    httpMetadata: { contentType: 'image/png' },
  });
  const task = await startRestore(f, {}, null, [{ key: image.key, size: image.size }]);
  assert.equal(
    (await f.request('/api/images', 'DELETE', { key: image.key, etag: image.etag })).status,
    409,
  );
  await post(f, '/api/backup/jobs/' + task.id + '/verify-images', { index: 0 });
  const settings = await (await f.request('/api/settings')).json();
  await f.request('/api/settings', 'PUT', {
    site: { ...settings.site, title: 'Concurrent settings' },
    etag: settings.etag,
  });
  assert.equal(
    (await f.request('/api/backup/jobs/' + task.id + '/finish', 'POST', {})).status,
    409,
  );
  assert.equal((await (await f.request('/api/settings')).json()).site.title, 'Concurrent settings');
  await post(f, '/api/backup/jobs/' + task.id + '/cancel');
  assert.ok(await bucket.head(image.key));
  assert.equal(
    (await f.request('/api/images', 'DELETE', { key: image.key, etag: image.etag })).status,
    200,
  );
});

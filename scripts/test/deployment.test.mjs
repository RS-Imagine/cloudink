import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateConfig, workerConfigs, root } from '../deployment-config.mjs';

const example = () => ({ workersSubdomain: 'reader', workers: { site: 'notes', admin: 'notes-admin', images: 'notes-images' }, buckets: { content: 'notes-content', images: 'notes-images' }, ownerEmail: 'reader@example.net', productionBranch: 'release', site: { title: 'Notes', author: 'Reader', subtitle: '', description: '' } });
test('a fork generates isolated workers.dev resources; custom domain aliases remain explicit', () => {
  const config = validateConfig(example());
  const generated = workerConfigs(config);
  assert.equal(config.urls.site, 'https://notes.reader.workers.dev');
  assert.equal(generated.admin.vars.OWNER_EMAIL, 'reader@example.net');
  assert.equal(generated.admin.vars.PRODUCTION_BRANCH, 'release');
  assert.equal(generated.admin.r2_buckets[0].bucket_name, 'notes-content');
  assert.equal(generated.admin.workers_dev, true);
  assert.equal(generated.site.routes, undefined);
  assert.equal(generated.images.vars.ALLOWED_ORIGINS, '["https://notes.reader.workers.dev"]');
  assert.equal(generated.admin.vars.CLARITY_ID, '');
  const custom = workerConfigs(validateConfig({ ...example(), urls: { site: 'https://notes.example.net', admin: 'https://write.example.net', images: 'https://images.example.net' }, siteAliases: ['https://www.notes.example.net'] }));
  assert.equal(custom.site.workers_dev, false);
  assert.deepEqual(custom.site.routes.map(x => x.pattern), ['notes.example.net', 'www.notes.example.net']);
  assert.throws(() => validateConfig({ ...example(), buckets: { content: 'shared-bucket', images: 'shared-bucket' } }), /different/);
  assert.throws(() => validateConfig({ ...example(), urls: { admin: 'https://someone-else.reader.workers.dev' } }), /Worker name/);
  assert.throws(() => validateConfig({ ...example(), urls: { site: 'https://example.net/private' } }), /without a path/);
  assert.throws(() => validateConfig({ ...example(), site: { title: ' ', author: 'Reader' } }), /title/);
  assert.throws(() => validateConfig({ ...example(), site: { title: 'x'.repeat(301), author: 'Reader' } }), /title/);
});

test('custom production branch reports status while preview builds cannot alter it', async () => {
  const work = await mkdtemp(resolve(tmpdir(), 'blog-branch-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.end('{"ok":true}');
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  try {
    await writeFile(resolve(work, 'deployment.json'), JSON.stringify(example()));
    await import('node:fs/promises').then(({ mkdir }) => mkdir(resolve(work, 'build-work')));
    await writeFile(resolve(work, 'build-work/release-id.json'), '{"id":"test-release"}');
    const env = { ...process.env, BLOG_DEPLOY_CONFIG_JSON: '', BLOG_DEPLOY_CONFIG: resolve(work, 'deployment.json'), BLOG_ADMIN_URL: `http://127.0.0.1:${server.address().port}`, BLOG_BUILD_TOKEN: 'local-test-credential', BLOG_PRODUCTION_BRANCH: '', WORKERS_CI_BRANCH: 'release' };
    await promisify(execFile)(process.execPath, [resolve(root, 'scripts/report-build.mjs'), 'built'], { cwd: work, env });
    assert.deepEqual(requests, [{ authorization: 'Bearer local-test-credential', body: { id: 'test-release', status: 'built' } }]);
    await promisify(execFile)(process.execPath, [resolve(root, 'scripts/report-build.mjs'), 'failed'], { cwd: work, env: { ...env, WORKERS_CI_BRANCH: 'preview' } });
    assert.equal(requests.length, 1);
  } finally { await new Promise(accept => server.close(accept)); await rm(work, { recursive: true }); }
});

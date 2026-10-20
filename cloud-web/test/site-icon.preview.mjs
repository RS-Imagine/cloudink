// Run only in an authenticated cloud CI build, using a dedicated disposable test bucket.
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const bucket = process.env.CLOUDINK_PREVIEW_STORAGE;
assert.ok(
  bucket && /^[a-z0-9-]+-test$/.test(bucket),
  'A dedicated bucket ending in -test is required',
);
const worker = process.env.CLOUDINK_PREVIEW_WORKER || 'cloudink';
const token = randomBytes(24).toString('hex');
const path = resolve('build-work/icon-preview.wrangler.json');
const config = {
  name: worker,
  main: resolve('cloud-web/src/index.ts'),
  compatibility_date: '2026-10-01',
  compatibility_flags: ['nodejs_compat'],
  assets: {
    directory: resolve('build-work/web-public'),
    binding: 'ASSETS',
    run_worker_first: true,
    html_handling: 'auto-trailing-slash',
    not_found_handling: '404-page',
  },
  previews: {
    vars: { SETUP_TOKEN: token },
    r2_buckets: [{ binding: 'STORAGE', bucket_name: bucket }],
    ratelimits: [
      { name: 'LOGIN_LIMITER', namespace_id: '2021', simple: { limit: 50, period: 60 } },
    ],
    observability: { enabled: true },
  },
};
await writeFile(path, JSON.stringify(config), { mode: 0o600 });
try {
  const result = spawnSync(
    'npx',
    [
      'wrangler',
      'preview',
      '--config',
      path,
      '--name',
      'feat/custom-site-icon',
      '--ignore-base-config',
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 8_000_000 },
  );
  if (result.status !== 0) {
    console.error((result.stdout + '\n' + result.stderr).replaceAll(token, '[hidden]'));
    process.exitCode = result.status || 1;
  } else {
    const urls = [...new Set(result.stdout.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/g) || [])];
    const url = urls.find((value) => new URL(value).hostname.startsWith('feat-custom-site-icon-'));
    assert.ok(url, 'Preview URL missing from Wrangler JSON');
    console.log(JSON.stringify({ deployedPreview: url, isolatedStorage: true }));
    const smoke = spawnSync('node', ['cloud-web/test/site-icon.remote.mjs'], {
      env: {
        ...process.env,
        CLOUDINK_ICON_PREVIEW_TEST: '1',
        CLOUDINK_ICON_PREVIEW_URL: url,
        CLOUDINK_ICON_PREVIEW_SETUP: token,
      },
      encoding: 'utf8',
      maxBuffer: 2_000_000,
    });
    console.log(smoke.stdout.replaceAll(token, '[hidden]'));
    if (smoke.status !== 0) {
      console.error(smoke.stderr.replaceAll(token, '[hidden]'));
      process.exitCode = smoke.status || 1;
    }
  }
} finally {
  await unlink(path);
}

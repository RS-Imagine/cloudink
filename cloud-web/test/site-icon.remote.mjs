// Opt-in smoke test against an isolated Cloudflare Worker Preview, never production.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { svgBytes, icoBytes } from './icon-fixtures.mjs';

const target = new URL(process.env.CLOUDINK_ICON_PREVIEW_URL || 'https://invalid.invalid');
assert.equal(
  process.env.CLOUDINK_ICON_PREVIEW_TEST,
  '1',
  'Explicit isolated-preview opt-in required',
);
assert.ok(
  target.protocol === 'https:' &&
    target.hostname.endsWith('.workers.dev') &&
    target.hostname.startsWith('feat-custom-site-icon-'),
  'This smoke test only accepts the feature Preview hostname',
);
const token = process.env.CLOUDINK_ICON_PREVIEW_SETUP;
assert.ok(token && token.length >= 16, 'Dedicated Preview setup token required');
const email = 'icon-preview@example.invalid';
const password = 'CloudInk-icon-preview-only-2026';
let cookie = '',
  csrf = '';
async function request(path, method = 'GET', body) {
  const headers = new Headers({ Origin: target.origin });
  if (cookie) headers.set('Cookie', cookie);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (body !== undefined)
    headers.set(
      'Content-Type',
      body instanceof Uint8Array
        ? 'application/octet-stream'
        : typeof body === 'string'
          ? 'text/plain'
          : 'application/json',
    );
  const response = await fetch(new URL(path, target), {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === 'string' || body instanceof Uint8Array
          ? body
          : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  assert.ok(
    response.ok,
    method + ' ' + path + ': ' + response.status + ' ' + (response.ok ? '' : await response.text()),
  );
  return response;
}
const config = await (await request('/api/config')).json();
let session;
if (!config.initialized) {
  session = await fetch(new URL('/api/setup', target), {
    method: 'POST',
    headers: {
      Origin: target.origin,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      site: {
        title: 'CloudInk 图标预览',
        subtitle: 'SVG / ICO',
        author: 'CloudInk',
        description: 'Isolated preview smoke test',
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  assert.ok(session.ok, 'Preview setup: ' + session.status);
} else session = await request('/api/login', 'POST', { email, password });
cookie = session.headers.get('Set-Cookie').split(';')[0];
csrf = (await session.json()).csrf;
const wasm = await import(new URL('../../cloud-admin/ui/wasm/blog_wasm.js', import.meta.url));
await wasm.default({
  module_or_path: await readFile(
    new URL('../../cloud-admin/ui/wasm/blog_wasm_bg.wasm', import.meta.url),
  ),
});
let settings = await (await request('/api/settings')).json();
async function save(key) {
  settings = await (
    await request('/api/settings', 'PUT', {
      site: { ...settings.site, siteIcon: key, themePalette: 'brown' },
      etag: settings.etag,
    })
  ).json();
}
async function publish() {
  const state = await (await request('/api/publish', 'POST', { settings: true })).json();
  const files = JSON.parse(wasm.render_release(JSON.stringify(state.browser_release)));
  for (const path of state.files) {
    assert.equal(typeof files[path], 'string');
    await request(
      '/api/publish/' + state.release_id + '/file?path=' + encodeURIComponent(path),
      'PUT',
      files[path],
    );
  }
  await request('/api/publish/' + state.release_id + '/commit', 'POST', {});
}
await save('');
await publish();
const icons = [];
for (const bytes of [svgBytes, icoBytes()]) {
  const icon = await (await request('/api/site-icon', 'POST', bytes)).json();
  icons.push(icon);
  await save(icon.key);
  const before = await (await request('/api/posts')).json();
  assert.notEqual(before.site.siteIcon, icon.key, 'Save must not publish the icon');
  const file = await request(icon.url);
  assert.match(file.headers.get('Content-Type'), /^image\/(?:svg\+xml|x-icon)$/);
  assert.match(file.headers.get('Content-Security-Policy'), /sandbox/);
  assert.match(file.headers.get('Cache-Control'), /immutable/);
  await publish();
  const html = await (await request('/')).text();
  assert.ok(html.includes('href="' + icon.url + '"'));
  assert.ok(html.includes('src="' + icon.url + '"'));
  assert.equal((await request(icon.url, 'HEAD')).status, 200);
}
const backup = await (await request('/api/backup')).json();
assert.ok(backup.images.some((image) => image.key === icons[1].key));
await save('');
await publish();
assert.ok((await (await request('/')).text()).includes('href="/favicon.svg"'));
const restored = await (
  await request('/api/backup/restore', 'POST', { backup, settings_etag: settings.etag })
).json();
assert.equal(restored.site.siteIcon, icons[1].key);
settings = restored;
assert.ok(
  (await (await request('/')).text()).includes('href="/favicon.svg"'),
  'Restore must not publish',
);
await save(icons[0].key);
await publish();
console.log(
  JSON.stringify({
    cloudflarePreview: target.origin,
    svg: true,
    ico: true,
    savePublishIsolation: true,
    wasmPublication: true,
    resetDefault: true,
    backupRestore: true,
  }),
);

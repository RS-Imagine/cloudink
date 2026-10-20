import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { svgBytes, svgIcon, icoBytes, pngIcoBytes } from './icon-fixtures.mjs';

async function upload(f, bytes = svgBytes) {
  const response = await f.request('/api/site-icon', 'POST', bytes);
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function save(f, icon) {
  const current = await (await f.request('/api/settings')).json();
  const response = await f.request('/api/settings', 'PUT', {
    site: { ...current.site, siteIcon: icon },
    etag: current.etag,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
test('site icons require authentication/CSRF and validate actual SVG/ICO bytes and size', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/site-icon', 'POST', svgBytes)).status, 401);
  await f.login();
  assert.equal(
    (await f.request('/api/site-icon', 'POST', svgBytes, { 'X-CSRF-Token': 'wrong' })).status,
    403,
  );
  assert.equal(
    (await f.request('/api/site-icon', 'POST', new Uint8Array(256 * 1024 + 1))).status,
    413,
  );
  for (const source of [
    '<html><script>alert(1)</script></html>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg><path d="M0 0"/></svg>',
    '<svg/>',
  ]) {
    assert.equal(
      (await f.request('/api/site-icon', 'POST', new TextEncoder().encode(source))).status,
      400,
    );
  }
  const ico = icoBytes(),
    broken = ico.slice();
  new DataView(broken.buffer).setUint32(18, 0xffffffff, true);
  assert.equal((await f.request('/api/site-icon', 'POST', broken)).status, 400);
  await upload(f, pngIcoBytes());
  await upload(f, pngIcoBytes({ interlaced: true }));
  const icon = await upload(f, ico);
  assert.match(icon.key, /^uploads\/icons\/[a-f0-9]{64}\.ico$/);
  assert.equal((await f.request(icon.url)).headers.get('Content-Type'), 'image/x-icon');
});
test('SVG icons are sanitized and immutable, with GET/HEAD/304 and no arbitrary bucket access', async (t) => {
  const f = await fixture(t);
  await f.login();
  const raw =
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 24 24"><script>alert(1)</script><foreignObject><iframe src="https://evil.test"></iframe></foreignObject><style>path{fill:url(https://evil.test)}</style><path d="M0 0h24v24H0Z" fill="url(https://evil.test)" style="background:url(https://evil.test)"/><use href="https://evil.test/x.svg#x"/><rect id="safe" width="2" height="2" fill="#805232"/></svg>';
  const icon = await upload(f, new TextEncoder().encode(raw));
  const response = await f.request(icon.url),
    text = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(text, /script|foreignObject|iframe|onload|evil\.test|<style|style=/i);
  assert.match(text, /fill="#805232"/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
  assert.match(response.headers.get('Cache-Control'), /immutable/);
  const again = await upload(f, new TextEncoder().encode(text));
  assert.equal(again.key, icon.key, 'sanitization must be stable for backups');
  assert.equal((await f.request(icon.url, 'HEAD')).status, 200);
  assert.equal(await (await f.request(icon.url, 'HEAD')).text(), '');
  assert.equal(
    (await f.request(icon.url, 'GET', undefined, { 'If-None-Match': response.headers.get('ETag') }))
      .status,
    304,
  );
  assert.equal((await f.request('/site-icon/auth/account.json')).status, 404);
  assert.equal((await f.request('/site-icon/' + 'a'.repeat(64) + '.svg')).status, 404);
  assert.equal((await f.request(icon.url, 'POST', {})).status, 405);
});
test('icon settings preserve publication isolation and image-library reference protection', async (t) => {
  const f = await fixture(t);
  await f.login();
  const icon = await upload(f);
  await save(f, icon.key);
  assert.equal((await (await f.request('/api/posts')).json()).appearance.siteIcon, icon.key);
  assert.equal((await (await f.request('/api/posts')).json()).site.siteIcon, undefined);
  assert.match(await (await f.request('/')).text(), /href="\/favicon\.svg"/);
  let library = await (await f.request('/api/images')).json();
  let item = library.images.find((image) => image.key === icon.key);
  assert.ok(item.references.some((ref) => ref.kind === 'settings'));
  assert.equal(
    (await f.request('/api/images', 'DELETE', { key: item.key, etag: item.etag })).status,
    409,
  );
  const published = await f.prepare({ settings: true });
  assert.equal(published.browser_release.site.siteIcon, icon.key);
  await f.stage(published);
  assert.equal((await f.commit(published)).status, 200);
  await save(f, '');
  library = await (await f.request('/api/images')).json();
  item = library.images.find((image) => image.key === icon.key);
  assert.equal(
    (await f.request('/api/images', 'DELETE', { key: item.key, etag: item.etag })).status,
    409,
    'live icon is still in use after resetting draft settings',
  );
  const reset = await f.prepare({ settings: true });
  await f.stage(reset);
  assert.equal((await f.commit(reset)).status, 200);
  assert.equal(
    (await f.request('/api/images', 'DELETE', { key: item.key, etag: item.etag })).status,
    200,
  );
  assert.equal((await f.request(icon.url)).status, 404);
  const current = await (await f.request('/api/settings')).json();
  for (const siteIcon of [
    'auth/account.json',
    'https://example.com/icon.svg',
    'uploads/icons/' + 'a'.repeat(64) + '.svg',
  ]) {
    assert.equal(
      (
        await f.request('/api/settings', 'PUT', {
          site: { ...current.site, siteIcon },
          etag: current.etag,
        })
      ).status,
      400,
    );
  }
});
test('SVG and ICO backups restore across buckets without changing live settings or accepting forged content keys', async (t) => {
  for (const bytes of [svgBytes, icoBytes()]) {
    const source = await fixture(t);
    await source.login();
    const icon = await upload(source, bytes);
    await save(source, icon.key);
    const backup = await (await source.request('/api/backup')).json();
    assert.ok(backup.images.some((image) => image.key === icon.key));
    const original = new Uint8Array(
      await (await source.request('/api/image?key=' + encodeURIComponent(icon.key))).arrayBuffer(),
    );
    const target = await fixture(t);
    await target.login();
    assert.equal(
      (await target.request('/api/backup/restore', 'POST', { backup, settings_etag: null })).status,
      409,
    );
    const wrong = 'uploads/icons/' + '0'.repeat(64) + (icon.key.endsWith('.ico') ? '.ico' : '.svg');
    assert.equal(
      (await target.request('/api/backup/image?key=' + encodeURIComponent(wrong), 'PUT', original))
        .status,
      400,
    );
    assert.equal(
      (
        await target.request(
          '/api/backup/image?key=' + encodeURIComponent(icon.key),
          'PUT',
          original,
        )
      ).status,
      200,
    );
    const result = await target.request('/api/backup/restore', 'POST', {
      backup,
      settings_etag: null,
    });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).site.siteIcon, icon.key);
    assert.equal((await (await target.request('/api/posts')).json()).site.siteIcon, undefined);
  }
});

test('backup icon restore stores canonical sanitized bytes even for an active SVG payload', async (t) => {
  const source = await fixture(t);
  await source.login();
  const icon = await upload(source);
  const clean = await (await source.request(icon.url)).text();
  const active = clean.replace('</svg>', '<script>alert(1)</script></svg>');
  const target = await fixture(t);
  await target.login();
  const path = '/api/backup/image?key=' + encodeURIComponent(icon.key);
  for (let attempt = 0; attempt < 2; attempt++) {
    const restored = await target.request(path, 'PUT', new TextEncoder().encode(active));
    assert.equal(restored.status, 200, await restored.clone().text());
    const stored = await (await target.request(icon.url)).text();
    assert.equal(stored, clean);
    assert.doesNotMatch(stored, /<script/i);
  }
});

test('ICO validation rejects header-only payloads, missing bitmap masks and incomplete or corrupted PNG chunks', async (t) => {
  const f = await fixture(t);
  await f.login();
  const truncatedDib = icoBytes().slice(0, 62);
  const truncatedPng = pngIcoBytes().slice(0, 46);
  const missingMask = icoBytes().slice(0, -1);
  const missingEnd = pngIcoBytes().slice(0, -12);
  for (const bytes of [truncatedDib, truncatedPng, missingMask, missingEnd])
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(14, bytes.length - 22, true);
  const badCrc = pngIcoBytes();
  badCrc[badCrc.length - 1] ^= 1;
  for (const bytes of [truncatedDib, truncatedPng, missingMask, missingEnd, badCrc]) {
    const response = await f.request('/api/site-icon', 'POST', bytes);
    assert.equal(response.status, 400, await response.clone().text());
  }
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await bucket.list({ prefix: 'uploads/icons/' })).objects.length, 0);
});

test('SVG upload rejects trailing content, mismatched tags and undefined XML entities', async (t) => {
  const f = await fixture(t);
  await f.login();
  for (const source of [
    '<svg><path d="M0 0"/></svg>junk</svg>',
    '<svg><path d="M0 0"/></svg><path/></svg>',
    '<svg><path d="M0 0"></svg>',
    '<svg><path d="M0 0"/>&unknown;</svg>',
  ]) {
    const response = await f.request('/api/site-icon', 'POST', new TextEncoder().encode(source));
    assert.equal(response.status, 400, await response.clone().text());
  }
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await bucket.list({ prefix: 'uploads/icons/' })).objects.length, 0);
  const commented = '<!-- exported icon -->' + svgIcon.replace('<defs>', '<!-- gradient --><defs>');
  await upload(f, new TextEncoder().encode(commented));
});
test('ICO PNG validation rejects invalid deflate streams, filters, row sizes and decompression bombs', async (t) => {
  const f = await fixture(t);
  await f.login();
  for (const compressed of [
    new Uint8Array([1]),
    deflateSync(new Uint8Array([5, 128, 82, 50, 255])),
    deflateSync(new Uint8Array([0, 128])),
    deflateSync(new Uint8Array([0, 128, 82, 50, 255, 0])),
    deflateSync(new Uint8Array(4 * 1024 * 1024)),
  ]) {
    const response = await f.request('/api/site-icon', 'POST', pngIcoBytes({ compressed }));
    assert.equal(response.status, 400, await response.clone().text());
  }
  const bucket = await f.mf.getR2Bucket('STORAGE');
  assert.equal((await bucket.list({ prefix: 'uploads/icons/' })).objects.length, 0);
});

test('indexed ICO PNGs validate reconstructed palette samples for packed pixels, filters and Adam7 passes', async (t) => {
  const f = await fixture(t);
  await f.login();
  const palette = [[128, 82, 50], [255, 255, 255]];
  const valid = [
    { width: 2, raw: [1, 1, 255] },
    { height: 2, raw: [0, 1, 2, 255] },
    { width: 2, height: 2, raw: [0, 1, 0, 4, 255, 1] },
    { depth: 1, raw: [0, 128] },
    { depth: 4, raw: [0, 16] },
    { width: 2, height: 2, interlaced: true, raw: [0, 1, 2, 0, 0, 0, 1] },
  ];
  for (const { raw, ...options } of valid)
    await upload(f, pngIcoBytes({ palette, ...options, compressed: deflateSync(new Uint8Array(raw)) }));
  const invalid = [
    { palette: palette.slice(0, 1), raw: [0, 255] },
    { width: 2, raw: [1, 1, 254] },
    { height: 2, raw: [0, 1, 2, 254] },
    { depth: 1, palette: palette.slice(0, 1), raw: [0, 128] },
    { depth: 2, raw: [0, 192] },
    { depth: 4, raw: [0, 240] },
    { depth: 1, palette: [...palette, [0, 0, 0]], raw: [0, 0] },
    { width: 2, height: 2, interlaced: true, raw: [0, 1, 2, 255, 0, 0, 1] },
  ];
  for (const { raw, ...options } of invalid) {
    const response = await f.request('/api/site-icon', 'POST', pngIcoBytes({ palette, ...options, compressed: deflateSync(new Uint8Array(raw)) }));
    assert.equal(response.status, 400, await response.clone().text());
  }
});

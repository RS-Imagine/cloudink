import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { svgBytes, icoBytes } from './icon-fixtures.mjs';

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
  const icon = await upload(f, ico);
  assert.match(icon.key, /^uploads\/icons\/[a-f0-9]{64}\.ico$/);
  assert.equal((await f.request(icon.url)).headers.get('Content-Type'), 'image/x-icon');
});
test('SVG icons are sanitized and immutable, with GET/HEAD/304 and no arbitrary bucket access', async (t) => {
  const f = await fixture(t);
  await f.login();
  const raw =
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 24 24"><script>alert(1)</script><foreignObject><iframe src="https://evil.test"/></foreignObject><style>path{fill:url(https://evil.test)}</style><path d="M0 0h24v24H0Z" fill="url(https://evil.test)" style="background:url(https://evil.test)"/><use href="https://evil.test/x.svg#x"/><rect id="safe" width="2" height="2" fill="#805232"/></svg>';
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';

test('author palette is validated, concurrency guarded and published independently of saved appearance', async (t) => {
  const f = await fixture(t);
  await f.login();
  const settings = await (await f.request('/api/settings')).json();
  assert.equal(settings.site.themePalette, undefined);
  const save = await f.request('/api/settings', 'PUT', {
    site: { ...settings.site, themePalette: 'neutral' },
    etag: settings.etag,
  });
  assert.equal(save.status, 200);
  const neutral = await save.json();
  const list = await (await f.request('/api/posts')).json();
  assert.equal(list.appearance.themePalette, 'neutral');
  assert.equal(list.site.themePalette, undefined, 'Saved palette must not change published settings');
  for (const value of ['bad', '"><style>body{display:none}</style>', null, 1, {}]) {
    const response = await f.request('/api/settings', 'PUT', {
      site: { ...neutral.site, themePalette: value }, etag: neutral.etag,
    });
    assert.equal(response.status, 400);
  }
  const stale = await f.request('/api/settings', 'PUT', {
    site: { ...neutral.site, themePalette: 'ink' }, etag: settings.etag,
  });
  assert.equal(stale.status, 409);
  const prepared = await f.prepare({ settings: true });
  assert.equal(prepared.browser_release.site.themePalette, 'neutral');
  await f.stage(prepared, [], '<!doctype html><html data-palette="neutral"><head><title>Theme</title></head><body>Published</body></html>');
  assert.equal((await f.commit(prepared)).status, 200);
  const live = await (await f.request('/')).text();
  assert.match(live, /data-palette="neutral"/);
  const ink = await f.request('/api/settings', 'PUT', {
    site: { ...neutral.site, themePalette: 'ink' }, etag: neutral.etag,
  });
  assert.equal(ink.status, 200);
  assert.equal((await (await f.request('/api/posts')).json()).appearance.themePalette, 'ink');
  assert.match(await (await f.request('/')).text(), /data-palette="neutral"/);
});

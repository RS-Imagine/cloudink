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
  assert.equal(
    list.site.themePalette,
    undefined,
    'Saved palette must not change published settings',
  );
  for (const value of ['bad', '"><style>body{display:none}</style>', null, 1, {}]) {
    const response = await f.request('/api/settings', 'PUT', {
      site: { ...neutral.site, themePalette: value },
      etag: neutral.etag,
    });
    assert.equal(response.status, 400);
  }
  const stale = await f.request('/api/settings', 'PUT', {
    site: { ...neutral.site, themePalette: 'ink' },
    etag: settings.etag,
  });
  assert.equal(stale.status, 409);
  const prepared = await f.prepare({ settings: true });
  assert.equal(prepared.browser_release.site.themePalette, 'neutral');
  await f.stage(
    prepared,
    [],
    '<!doctype html><html data-palette="neutral"><head><title>Theme</title></head><body>Published</body></html>',
  );
  assert.equal((await f.commit(prepared)).status, 200);
  const live = await (await f.request('/')).text();
  assert.match(live, /data-palette="neutral"/);
  const ink = await f.request('/api/settings', 'PUT', {
    site: { ...neutral.site, themePalette: 'ink' },
    etag: neutral.etag,
  });
  assert.equal(ink.status, 200);
  const savedInk = await ink.json();
  const legacy = { ...savedInk.site };
  delete legacy.themePalette;
  const restoredLegacy = await f.request('/api/settings', 'PUT', {
    site: legacy,
    etag: savedInk.etag,
  });
  assert.equal(restoredLegacy.status, 200);
  assert.equal((await (await f.request('/api/posts')).json()).appearance.themePalette, 'ink');
  assert.match(await (await f.request('/')).text(), /data-palette="neutral"/);
});

test('all six author palettes persist without changing published settings', async (t) => {
  const f = await fixture(t);
  await f.login();
  let current = await (await f.request('/api/settings')).json();
  for (const themePalette of ['ink', 'neutral', 'blue', 'violet', 'rose', 'brown']) {
    const response = await f.request('/api/settings', 'PUT', {
      site: { ...current.site, themePalette },
      etag: current.etag,
    });
    assert.equal(response.status, 200);
    current = await response.json();
    assert.equal(current.site.themePalette, themePalette);
    const posts = await (await f.request('/api/posts')).json();
    assert.equal(posts.appearance.themePalette, themePalette);
    assert.equal(posts.site.themePalette, undefined);
  }
  const release = await f.prepare({ settings: true });
  assert.equal(release.browser_release.site.themePalette, 'brown');
});

test('reading fonts are validated, saved privately, published and backward compatible', async (t) => {
  const f = await fixture(t);
  await f.login();
  const original = await (await f.request('/api/settings')).json();
  assert.equal(original.site.readingFont, undefined);
  assert.equal((await (await f.request('/api/posts')).json()).appearance.readingFont, 'serif');
  const response = await f.request('/api/settings', 'PUT', {
    site: { ...original.site, readingFont: 'sans' },
    etag: original.etag,
  });
  assert.equal(response.status, 200);
  const sans = await response.json();
  const list = await (await f.request('/api/posts')).json();
  assert.equal(list.appearance.readingFont, 'sans');
  assert.equal(list.site.readingFont, undefined, 'Saving the preference must not publish it');
  for (const readingFont of ['custom-font', null, 1, {}, '"><style>bad</style>'])
    assert.equal(
      (
        await f.request('/api/settings', 'PUT', {
          site: { ...sans.site, readingFont },
          etag: sans.etag,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.request('/api/settings', 'PUT', {
        site: { ...sans.site, readingFont: 'serif' },
        etag: original.etag,
      })
    ).status,
    409,
  );
  const publication = await f.prepare({ settings: true });
  assert.equal(publication.browser_release.site.readingFont, 'sans');
  await f.stage(
    publication,
    [],
    '<!doctype html><html data-reading-font="sans"><head><title>Font</title></head><body>Published</body></html>',
  );
  assert.equal((await f.commit(publication)).status, 200);
  assert.match(await (await f.request('/')).text(), /data-reading-font="sans"/);
  const legacy = { ...sans.site };
  delete legacy.readingFont;
  assert.equal(
    (await f.request('/api/settings', 'PUT', { site: legacy, etag: sans.etag })).status,
    200,
  );
  assert.equal((await (await f.request('/api/posts')).json()).appearance.readingFont, 'serif');
  assert.equal(
    (await (await f.request('/api/posts')).json()).site.readingFont,
    'sans',
    'Restoring legacy settings remains private until publication',
  );
});

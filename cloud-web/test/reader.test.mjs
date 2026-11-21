import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft, origin } from './fixture.mjs';

test('legacy published image URLs use public media without changing stored snapshots or API authentication', async (t) => {
  const f = await fixture(t);
  await f.login();
  const key = 'uploads/2026/11/legacy-route.png';
  const legacy = '/api/image?key=' + encodeURIComponent(key);
  const foreign = 'https://other.example' + legacy;
  const invalid = [
    '/api/image?key=auth%2Faccount.json',
    '/api/image?key=uploads%2F..%2Fsecret.png',
    '/api/image?key=uploads%252Fphoto.png',
    '/api/image?key=uploads%2Fbad%ZZ.png',
    '/api/image?key=uploads%2Fa.png&key=uploads%2Fb.png',
    foreign,
  ];
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await bucket.put(key, new Uint8Array([1, 2, 3]), {
    httpMetadata: { contentType: 'image/png' },
  });
  const state = await f.prepare();
  const html =
    '<!doctype html><html><head><title>Legacy media</title></head><body>' +
    '<div class="short-body"><img id="relative" src="' +
    legacy +
    '">' +
    '<img id="absolute" src="' +
    origin +
    legacy +
    '">' +
    '<picture><source srcset="' +
    legacy +
    ' 1x, ' +
    origin +
    legacy +
    ' 2x">' +
    '<img src="' +
    legacy +
    '" data-full-src="' +
    legacy +
    '"></picture>' +
    invalid.map((src, i) => '<img id="invalid-' + i + '" src="' + src + '">').join('') +
    '</div></body></html>';
  await f.stage(state, [], html);
  assert.equal((await f.commit(state)).status, 200);
  const pointer = await (await bucket.get('state/published.json')).json();
  const storageKey = pointer.pages
    ? 'public/content/' + pointer.pages['index.html']
    : 'public/' + state.release_id + '/index.html';
  const stored = await (await bucket.get(storageKey)).text();
  assert.ok(stored.includes(legacy), 'compatibility must not rewrite stored author content');
  const response = await f.mf.dispatchFetch(origin + '/');
  const result = await response.text();
  assert.match(result, /id="relative" src="\/images\/uploads\/2026\/11\/legacy-route.png"/);
  assert.match(result, /id="absolute" src="\/images\/uploads\/2026\/11\/legacy-route.png"/);
  assert.match(
    result,
    /srcset="\/images\/uploads\/2026\/11\/legacy-route.png 1x,\/images\/uploads\/2026\/11\/legacy-route.png 2x"/,
  );
  assert.match(result, /data-full-src="\/images\/uploads\/2026\/11\/legacy-route.png"/);
  for (const [i, src] of invalid.entries()) {
    assert.ok(
      result.includes('id="invalid-' + i + '" src="' + src.replaceAll('&', '&amp;') + '"') ||
        result.includes('id="invalid-' + i + '" src="' + src + '"'),
    );
  }
  assert.equal((await f.mf.dispatchFetch(origin + legacy)).status, 401);
  assert.equal((await f.mf.dispatchFetch(origin + '/images/' + key)).status, 200);
  assert.equal((await f.mf.dispatchFetch(origin + '/images/auth/account.json')).status, 404);
  assert.equal(
    (
      await f.mf.dispatchFetch(origin + '/', {
        headers: { 'If-None-Match': response.headers.get('ETag') },
      })
    ).status,
    304,
  );
  assert.equal(await (await bucket.get(storageKey)).text(), stored);
});

test('public metadata, lazy images and discovery follow the live release without private content', async (t) => {
  const f = await fixture(t);
  await f.login();
  const saved = await (
    await f.request('/api/posts/public', 'PUT', {
      draft: draft(),
      etag: null,
    })
  ).json();
  await f.request('/api/posts/private', 'PUT', { draft: draft('private'), etag: null });
  const state = await f.prepare({ slug: 'public', etag: saved.etag });
  const html =
    '<!doctype html><html><head><title>Writer&#39;s &amp; &#x1f333; &#128512;</title>' +
    '<meta name="description" content="A &quot;small&quot; story">' +
    '<meta name="author" content="Writer&#39;s name">' +
    '<link rel="canonical" href="https://wrong.example/">' +
    '<meta property="og:title" content="obsolete"></head><body>' +
    '<header class="site-brand"><h1>Blog</h1></header>' +
    '<article><div class="article-body">' +
    '<img src="first.png" alt="First" width="800" height="600">' +
    '<img src="/images/uploads/second.png" alt="Second"></div></article></body></html>';
  await f.stage(state, [], html);
  assert.equal((await f.commit(state)).status, 200);
  const response = await f.request('/posts/public/?tracking=1');
  const result = await response.text();
  assert.equal((result.match(/rel="canonical"/g) || []).length, 1);
  assert.match(result, new RegExp('href="' + origin + '/posts/public/"'));
  assert.ok(!result.includes('wrong.example'));
  assert.equal((result.match(/property="og:title"/g) || []).length, 1);
  assert.match(result, /name="twitter:card" content="summary_large_image"/);
  assert.match(result, /src="[^"]*first.png"[^>]*loading="eager"[^>]*fetchpriority="high"/);
  assert.match(result, /src="[^"]*second.png"[^>]*loading="lazy"/);
  assert.match(result, /width="800" height="600"/);
  const json = JSON.parse(
    result.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
  );
  assert.equal(json['@type'], 'BlogPosting');
  assert.equal(json.name, "Writer's & 🌳 😀");
  assert.match(result, /property="og:title" content="Writer&#39;s &amp; 🌳 😀"/);
  assert.match(result, /name="twitter:title" content="Writer&#39;s &amp; 🌳 😀"/);
  assert.ok(!result.includes('&amp;#39;'));
  assert.equal(json.description, 'A "small" story');
  assert.equal(json.url, origin + '/posts/public/');
  assert.equal(json.author.name, "Writer's name");
  assert.equal(json.image[0], origin + '/posts/public/first.png');
  const sitemap = await (await f.request('/sitemap.xml')).text();
  assert.match(sitemap, /\/posts\/public\//);
  assert.ok(!sitemap.includes('private'));
  assert.ok(!sitemap.includes('/admin'));
  assert.match(await (await f.request('/robots.txt')).text(), /Disallow: \/admin/);
  assert.equal(await (await f.request('/sitemap.xml', 'HEAD')).text(), '');
  assert.equal((await f.request('/posts/missing/')).headers.get('X-Robots-Tag'), 'noindex');
  const custom = await f.mf.dispatchFetch('https://blog.example/posts/public/');
  const customHtml = await custom.text();
  assert.match(customHtml, /rel="canonical" href="https:\/\/blog.example\/posts\/public\/"/);
  assert.notEqual(custom.headers.get('ETag'), response.headers.get('ETag'));
  assert.equal(
    (
      await f.request('/posts/public/?tracking=1', 'GET', undefined, {
        'If-None-Match': response.headers.get('ETag'),
      })
    ).status,
    304,
  );
  const removed = await f.prepare({ unpublish: 'public' });
  // The existing publication remains discoverable until the new commit completes.
  assert.match(await (await f.request('/sitemap.xml')).text(), /\/posts\/public\//);
  await f.stage(removed);
  assert.equal((await f.commit(removed)).status, 200);
  assert.ok(!(await (await f.request('/sitemap.xml')).text()).includes('/posts/public/'));
});

test('feed.xml serves an RSS 2.0 feed from the published release', async (t) => {
  const f = await fixture(t);
  await f.login();
  const release = await f.prepare();
  // Staged pages are immutable, so skip the two JSON files and stage real feed data.
  await f.stage(release, ['site.json', 'search_index.json']);
  const put = (path, value) =>
    f.request(
      `/api/publish/${release.release_id}/file?path=${encodeURIComponent(path)}`,
      'PUT',
      value,
    );
  assert.equal(
    (
      await put(
        'site.json',
        JSON.stringify({ title: 'Test & Blog', description: 'A "feed" test', author: 'Writer' }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await put(
        'search_index.json',
        JSON.stringify([
          {
            title: 'Hello <world>\u0000',
            slug: 'hello',
            description: 'First post',
            date: '2026-10-01',
            updated: null,
            body: 'x',
          },
          {
            title: 'Second',
            slug: 'second',
            description: '',
            date: '2026-09-01',
            updated: '2026-09-15',
            body: 'y',
          },
          { title: 'Invalid calendar', slug: 'calendar', date: '2026-02-30' },
          { title: 'Bad metadata', slug: 'invalid', description: { invalid: true } },
        ]),
      )
    ).status,
    200,
  );
  assert.equal((await f.commit(release)).status, 200);
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const response = await f.request('/feed.xml');
  assert.match(response.headers.get('content-type'), /application\/rss\+xml/);
  const feed = await response.text();
  assert.match(feed, /<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(feed, /<rss version="2.0">/);
  assert.match(feed, /<title>Test &amp; Blog<\/title>/);
  assert.match(feed, new RegExp(`<link>${escapedOrigin}/<\\/link>`));
  assert.match(feed, /<title>Hello &lt;world&gt;<\/title>/);
  assert.match(feed, new RegExp(`${escapedOrigin}/posts/hello/`));
  assert.match(feed, /<pubDate>Thu, 01 Oct 2026 00:00:00 GMT<\/pubDate>/);
  assert.match(feed, /<pubDate>Tue, 01 Sep 2026 00:00:00 GMT<\/pubDate>/);
  assert.doesNotMatch(feed, /\u0000|Bad metadata|Mon, 02 Mar 2026/);
  assert.match(feed, /<lastBuildDate>Thu, 01 Oct 2026 00:00:00 GMT<\/lastBuildDate>/);
  const etag = response.headers.get('ETag');
  assert.ok(etag);
  assert.equal(await (await f.request('/feed.xml')).text(), feed);
  assert.equal(
    (await f.request('/feed.xml', 'GET', undefined, { 'If-None-Match': etag })).status,
    304,
  );
  const head = await f.request('/feed.xml', 'HEAD');
  assert.equal(head.headers.get('ETag'), etag);
  assert.equal(await head.text(), '');
  const bucket = await f.mf.getR2Bucket('STORAGE');
  await bucket.put('public/' + release.release_id + '/search_index.json', '{invalid');
  assert.equal(
    await (await f.request('/feed.xml')).text(),
    feed,
    'a valid cached feed remains available',
  );
  assert.equal(
    (await f.mf.dispatchFetch('https://uncached-reader.example/feed.xml')).status,
    503,
    'an uncached storage error must not become an empty successful feed',
  );
});

test('new reader masthead preserves the full site name in response metadata', async (t) => {
  const f = await fixture(t);
  await f.login();
  const release = await f.prepare();
  const html =
    '<!doctype html><html><head><title>Article</title><meta name="description" content="Notes"></head><body>' +
    '<a class="site-brand"><span class="site-mark"></span><span class="site-title">Notes &amp; Ideas</span></a>' +
    '<main id="swup"><h1>Article</h1></main></body></html>';
  await f.stage(release, [], html);
  assert.equal((await f.commit(release)).status, 200);
  const response = await (await f.request('/')).text();
  assert.match(response, /property="og:site_name" content="Notes &amp; Ideas"/);
});

test('reader resources are conditional, same-origin and available to native navigation', async (t) => {
  const f = await fixture(t);
  await f.login();
  for (const [body, math, code] of [
    ['<p>Ordinary prose</p>', false, false],
    ['<pre><code class="language-js">const n = 1;</code></pre>', false, true],
    ['<span class="katex">x</span>', true, false],
    ['<span class="katex">x</span><pre><code>test</code></pre>', true, true],
  ]) {
    const release = await f.prepare();
    await f.stage(
      release,
      [],
      '<html><head><title>Reader</title>' +
        '<link rel="preconnect" href="https://cdn.jsdelivr.net">' +
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">' +
        '<link rel="stylesheet" id="hljs-light" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css">' +
        '<link rel="stylesheet" id="hljs-dark" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css">' +
        '</head><body><div class="article-body">' +
        body +
        '</div></body></html>',
    );
    assert.equal((await f.commit(release)).status, 200);
    const html = await (await f.request('/')).text();
    assert.equal(html.includes('data-reader-style="math"'), math);
    assert.equal(html.includes('data-reader-style="code"'), code);
    assert.ok(!html.includes('cdn.jsdelivr.net'));
  }
  const css = await f.request('/reader-assets/katex.css');
  assert.equal(css.status, 200);
  const text = await css.text();
  assert.ok(!text.includes('.ttf') && !text.includes('.woff)'));
  const font = text.match(/url\(fonts\/([^)]*\.woff2)\)/)[1];
  const response = await f.request('/reader-assets/fonts/' + font);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /font\/woff2/);
  assert.equal((await f.request('/reader-assets/highlight.js')).status, 200);
  assert.equal((await f.request('/reader-assets/katex-LICENSE.txt')).status, 200);
  assert.equal((await f.request('/reader-assets/fonts/account.json')).status, 404);
});

test('editorial fonts are sliced, same-origin WOFF2 with their license', async (t) => {
  const f = await fixture(t);
  const css = await f.request('/reader-assets/editorial-font.css');
  assert.equal(css.status, 200);
  const source = await css.text();
  assert.match(source, /unicode-range:/);
  assert.match(source, /font-display: swap/);
  assert.doesNotMatch(source, /https?:|\.woff\)/);
  const font = source.match(/url\((\/reader-assets\/fonts\/noto-serif-sc-[^)]+\.woff2)\)/)[1];
  const response = await f.request(font);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /font\/woff2/);

  const faces = source.match(/@font-face\s*\{[^}]+\}/g) || [];
  const latinFaces = faces.filter((face) => /font-family:\s*['"]?Noto Serif['"]?\s*;/.test(face));
  assert.equal(latinFaces.length, 8);
  for (const weight of ['400', '600']) {
    assert.ok(
      latinFaces.some(
        (face) =>
          new RegExp(`font-weight:\\s*${weight}\\b`).test(face) &&
          /font-style:\s*italic\b/.test(face),
      ),
      `expected Noto Serif ${weight} italic @font-face`,
    );
    assert.ok(
      latinFaces.some(
        (face) =>
          new RegExp(`font-weight:\\s*${weight}\\b`).test(face) &&
          /font-style:\s*normal\b/.test(face),
      ),
      `expected Noto Serif ${weight} normal @font-face`,
    );
  }
  assert.ok(
    latinFaces.some((face) => /unicode-range:[^;]*U\+0000-00FF/i.test(face)),
    'expected basic Latin unicode-range U+0000-00FF on Noto Serif',
  );
  const latinNormalFont = source.match(
    /url\((\/reader-assets\/fonts\/noto-serif-latin-[a-z0-9-]+-normal\.woff2)\)/,
  )?.[1];
  const latinItalicFont = source.match(
    /url\((\/reader-assets\/fonts\/noto-serif-latin-[a-z0-9-]+-italic\.woff2)\)/,
  )?.[1];
  assert.ok(latinNormalFont, 'expected Noto Serif latin normal woff2 url');
  assert.ok(latinItalicFont, 'expected Noto Serif latin italic woff2 url');
  for (const url of [latinNormalFont, latinItalicFont]) {
    const res = await f.request(url);
    assert.equal(res.status, 200, `expected 200 for ${url}`);
    assert.match(res.headers.get('Content-Type'), /font\/woff2/);
  }

  const license = await (await f.request('/reader-assets/editorial-font-LICENSE.txt')).text();
  assert.match(license, /SIL OPEN FONT LICENSE/);
  assert.match(license, /Noto Serif SC/);
  assert.match(license, /Noto Serif \(@fontsource\/noto-serif\)/);
});

test('the generated social cover can be fetched anonymously without Referer', async (t) => {
  const f = await fixture(t);
  await f.login();
  const bucket = await f.mf.getR2Bucket('STORAGE');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
    'base64',
  );
  await bucket.put('uploads/cover.png', png, { httpMetadata: { contentType: 'image/png' } });
  const saved = await f.request('/api/posts/cover', 'PUT', {
    draft: draft('cover', '![Cover](/images/uploads/cover.png)'),
    etag: null,
  });
  const { etag } = await saved.json();
  const release = await f.prepare({ slug: 'cover', etag });
  await f.stage(
    release,
    [],
    '<!doctype html><html><head><title>Cover</title></head><body><div class="article-body"><img src="/images/uploads/cover.png" alt="Cover"></div></body></html>',
  );
  assert.equal((await f.commit(release)).status, 200);
  const html = await (await f.request('/posts/cover/')).text();
  const url = html.match(/property="og:image" content="([^"]+)"/)?.[1];
  assert.equal(url, origin + '/images/uploads/cover.png');
  const image = await f.mf.dispatchFetch(url, { headers: { 'User-Agent': 'social-preview-test' } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const head = await f.mf.dispatchFetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('ETag'), image.headers.get('ETag'));
  const cached = await f.mf.dispatchFetch(url, {
    headers: { 'If-None-Match': image.headers.get('ETag') },
  });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
});

test('prepared navigation delegates DOM replacement and preserves page loader failures', async () => {
  const source = await readFile('assets/reader-runtime.js', 'utf8');
  const hooks = new Map();
  const window = { addEventListener() {} };
  const document = {
    startViewTransition() {
      assert.fail('Navigation must not layer a browser snapshot over its spring transition');
    },
  };
  runInNewContext(source, { window, document });
  window.CloudInkReader.attach({
    performNavigation() {},
    hooks: {
      replace(name, callback) {
        hooks.set(name, callback);
      },
      on() {},
    },
  });
  assert.equal(hooks.has('content:replace'), false);
  const load = hooks.get('page:load');
  const page = { url: '/shorts/', html: '<main>Prepared</main>' };
  assert.equal(
    await load({ meta: { readerPage: page } }, {}, () => assert.fail('Do not fetch twice')),
    page,
  );
  await assert.rejects(
    load({ meta: {} }, {}, async () => {
      throw new Error('Page loader failed');
    }),
    /Page loader failed/,
  );
});

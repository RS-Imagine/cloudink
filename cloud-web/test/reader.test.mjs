import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft, origin } from './fixture.mjs';

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
  assert.equal((await f.request('/feed.xml')).status, 503);
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
  const font = source.match(/url\((\/reader-assets\/fonts\/[^)]+\.woff2)\)/)[1];
  const response = await f.request(font);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /font\/woff2/);
  assert.match(
    await (await f.request('/reader-assets/editorial-font-LICENSE.txt')).text(),
    /SIL OPEN FONT LICENSE/,
  );
});

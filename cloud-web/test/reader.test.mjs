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

import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packPngIco } from '../../cloud-admin/ui/home-illustration.js';

const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
    'base64',
  ),
);

test('reader-runtime prefetchUrl filters routes safely and respects network constraints', async () => {
  const source = await readFile('assets/reader-runtime.js', 'utf8');
  const load = (navigator) => {
    const window = { addEventListener() {} };
    const document = {};
    runInNewContext(source, {
      window,
      document,
      navigator,
      location: { href: 'https://forimagine.eu.org/', origin: 'https://forimagine.eu.org' },
      URL,
    });
    return window.CloudInkReader;
  };

  const reader = load({ onLine: true, connection: { saveData: false, effectiveType: '4g' } });
  assert.equal(reader.canPrefetch(), true);
  assert.equal(reader.prefetchUrl('/shorts/', 'https://forimagine.eu.org/'), '/shorts/');
  assert.equal(
    reader.prefetchUrl('/posts/hesse-in-winter/', 'https://forimagine.eu.org/'),
    '/posts/hesse-in-winter/',
  );
  assert.equal(reader.prefetchUrl('/', 'https://forimagine.eu.org/'), null);
  assert.equal(reader.prefetchUrl('#section-1', 'https://forimagine.eu.org/'), null);
  assert.equal(
    reader.prefetchUrl('https://other.example/posts/a/', 'https://forimagine.eu.org/'),
    null,
  );
  for (const blocked of [
    '/admin',
    '/admin/',
    '/api/posts',
    '/images/uploads/a.webp',
    '/site-icon/abc.ico',
    '/reader-assets/code.css',
    '/feed.xml',
    '/sitemap.xml',
    '/robots.txt',
    '/_release.json',
    '/sw.js',
    '/files/notes.pdf',
  ]) {
    assert.equal(reader.prefetchUrl(blocked, 'https://forimagine.eu.org/'), null, blocked);
  }
  assert.equal(
    reader.prefetchUrl(
      {
        getAttribute: (name) => (name === 'href' ? '/posts/a/' : null),
        hasAttribute: (name) => name === 'data-no-swup',
      },
      'https://forimagine.eu.org/',
    ),
    null,
  );
  assert.equal(
    reader.prefetchUrl(
      {
        getAttribute: (name) => (name === 'href' ? '/posts/a/' : null),
        hasAttribute: () => false,
        target: '_blank',
      },
      'https://forimagine.eu.org/',
    ),
    null,
  );

  assert.equal(load({ onLine: false }).canPrefetch(), false);
  assert.equal(load({ onLine: true, connection: { saveData: true } }).canPrefetch(), false);
  assert.equal(
    load({ onLine: true, connection: { saveData: false, effectiveType: '2g' } }).canPrefetch(),
    false,
  );
  assert.equal(
    load({ onLine: true, connection: { saveData: false, effectiveType: 'slow-2g' } }).canPrefetch(),
    false,
  );
});

test('reader-runtime shares in-flight touchstart prefetch with performNavigation without duplicate fetches', async () => {
  const source = await readFile('assets/reader-runtime.js', 'utf8');
  const listeners = new Map();
  let fetchCalls = 0;
  let resolveFetch;
  const cache = new Map();
  const performed = [];
  const window = { addEventListener() {} };
  const document = {
    hidden: false,
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    getElementById() {
      return { setAttribute() {}, removeAttribute() {} };
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return { tagName: tag.toUpperCase(), setAttribute() {} };
    },
  };
  class FakeDOMParser {
    parseFromString(html) {
      return {
        title: 'Shorts',
        head: { querySelectorAll: () => [] },
        documentElement: { dataset: {} },
        getElementById: (id) => (id === 'swup' && html.includes('id="swup"') ? {} : null),
        querySelector: (selector) => (selector === '#swup' ? {} : null),
      };
    }
  }
  runInNewContext(source, {
    window,
    document,
    navigator: { onLine: true, connection: { saveData: false, effectiveType: '4g' } },
    location: { href: 'https://forimagine.eu.org/', origin: 'https://forimagine.eu.org' },
    DOMParser: FakeDOMParser,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    fetch: () => {
      fetchCalls++;
      const promise = new Promise((resolve) => {
        resolveFetch = () =>
          resolve({
            ok: true,
            url: 'https://forimagine.eu.org/shorts/',
            headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' }),
            text: async () => '<html><body><main id="swup"><h1>短记</h1></main></body></html>',
          });
      });
      return promise;
    },
  });

  const swup = {
    options: { containers: ['#swup'], requestHeaders: { 'X-Requested-With': 'swup' } },
    cache: {
      get: (url) => cache.get(url),
      set: (url, page) => cache.set(url, page),
    },
    hooks: { replace() {}, on() {} },
    performNavigation(visit, options) {
      performed.push({ visit, options });
      return Promise.resolve();
    },
  };
  window.CloudInkReader.attach(swup);

  const anchor = {
    getAttribute: (name) => (name === 'href' ? '/shorts/' : null),
    hasAttribute: () => false,
    closest: () => anchor,
  };
  listeners.get('touchstart')({ target: anchor });
  assert.equal(fetchCalls, 1, 'touchstart initiates a single prefetch request');

  const visit = {
    to: { url: '/shorts/', hash: '' },
    cache: { read: true, write: true },
    history: { popstate: false },
    trigger: {},
    abort() {
      assert.fail('navigation should not abort');
    },
  };
  const navPromise = swup.performNavigation(visit);
  assert.equal(
    fetchCalls,
    1,
    'performNavigation reuses in-flight prefetch instead of fetching twice',
  );
  resolveFetch();
  await navPromise;
  assert.equal(performed.length, 1);
  assert.equal(performed[0].options.meta.readerPage.url, '/shorts/');
  assert.ok(cache.has('/shorts/'));

  // Explicit retry (cache: { read: false }) must bypass cache and trigger a fresh fetch
  const retryVisit = {
    to: { url: '/shorts/', hash: '' },
    cache: { read: true, write: true },
    history: { popstate: false },
    trigger: {},
    abort() {
      assert.fail('retry navigation should not abort');
    },
  };
  const retryPromise = swup.performNavigation(retryVisit, { cache: { read: false, write: true } });
  assert.equal(fetchCalls, 2, 'explicit retry bypasses cached page');
  resolveFetch();
  await retryPromise;
});

test('service worker uses stale-while-revalidate for reading pages, cacheFirst for fonts, and networkFirst on reload', async () => {
  const source = await readFile('assets/sw.js', 'utf8');
  const handlers = new Map();
  const store = new Map();
  const fetchCalls = [];
  const waitUntilPromises = [];
  const caches = {
    async open() {
      return {
        async match(key) {
          return store.get(key);
        },
        async put(key, response) {
          store.set(key, response);
        },
        async addAll() {},
      };
    },
    async keys() {
      return [];
    },
    async delete() {},
  };
  const self = {
    location: { origin: 'https://forimagine.eu.org' },
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
    skipWaiting() {},
    clients: { claim() {} },
  };
  runInNewContext(source, {
    self,
    caches,
    URL,
    Response,
    Headers,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      fetchCalls.push({ url, cache: init?.cache });
      return new Response('fresh:' + url, { status: 200 });
    },
  });

  const dispatch = async (
    url,
    { method = 'GET', mode = 'cors', cache = 'default', accept = 'text/html' } = {},
  ) => {
    let responsePromise;
    handlers.get('fetch')({
      request: {
        url,
        method,
        mode,
        cache,
        headers: new Headers({ accept }),
      },
      respondWith(promise) {
        responsePromise = promise;
      },
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });
    return responsePromise ? await responsePromise : null;
  };

  // Bypass private/control routes
  assert.equal(await dispatch('https://forimagine.eu.org/admin'), null);
  assert.equal(await dispatch('https://forimagine.eu.org/api/posts'), null);
  assert.equal(await dispatch('https://forimagine.eu.org/sw.js'), null);
  assert.equal(await dispatch('https://forimagine.eu.org/_release.json'), null);

  // Reading HTML: cold miss populates cache, second hit returns cached immediately + revalidates in background
  store.set('https://forimagine.eu.org/shorts/', new Response('cached:/shorts/', { status: 200 }));
  const hit = await dispatch('https://forimagine.eu.org/shorts/', { mode: 'navigate' });
  assert.equal(await hit.text(), 'cached:/shorts/');
  await Promise.all(waitUntilPromises.splice(0));
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].cache, 'no-cache');
  assert.equal(
    await store.get('https://forimagine.eu.org/shorts/').clone().text(),
    'fresh:https://forimagine.eu.org/shorts/',
  );

  // Explicit reload bypasses stale cache via networkFirst
  fetchCalls.length = 0;
  store.set('https://forimagine.eu.org/shorts/', new Response('stale', { status: 200 }));
  const reloaded = await dispatch('https://forimagine.eu.org/shorts/', {
    mode: 'navigate',
    cache: 'reload',
  });
  assert.equal(await reloaded.text(), 'fresh:https://forimagine.eu.org/shorts/');
  assert.equal(fetchCalls[0].cache, 'no-cache');

  // Immutable font uses cacheFirst (zero network fetch on hit)
  fetchCalls.length = 0;
  const fontUrl = 'https://forimagine.eu.org/reader-assets/fonts/noto-serif-sc-0.woff2';
  store.set(fontUrl, new Response('font-bytes', { status: 200 }));
  const fontRes = await dispatch(fontUrl, { accept: '*/*' });
  assert.equal(await fontRes.text(), 'font-bytes');
  assert.equal(fetchCalls.length, 0);
});

test('packPngIco builds a valid multi-frame PNG-in-ICO container', () => {
  const packed = packPngIco([
    { size: 32, png: TINY_PNG },
    { size: 64, png: TINY_PNG },
  ]);
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  assert.equal(view.getUint16(0, true), 0);
  assert.equal(view.getUint16(2, true), 1);
  assert.equal(view.getUint16(4, true), 2);
  assert.equal(packed[6], 32);
  assert.equal(packed[7], 32);
  assert.equal(view.getUint32(14, true), TINY_PNG.byteLength);
  assert.equal(view.getUint32(18, true), 6 + 32);
  assert.equal(packed[22], 64);
  assert.equal(packed[23], 64);
  assert.equal(view.getUint32(30, true), TINY_PNG.byteLength);
  assert.equal(view.getUint32(34, true), 6 + 32 + TINY_PNG.byteLength);
  const firstPayload = packed.subarray(38, 38 + TINY_PNG.byteLength);
  assert.deepEqual(firstPayload, TINY_PNG);
});

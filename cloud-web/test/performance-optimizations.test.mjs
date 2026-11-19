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

test('reader-runtime skeletonKind and skeletonMarkup match all public reading layouts', async () => {
  const source = await readFile('assets/reader-runtime.js', 'utf8');
  const window = { addEventListener() {} };
  runInNewContext(source, {
    window,
    document: {},
    navigator: { onLine: true },
    location: { href: 'https://forimagine.eu.org/', origin: 'https://forimagine.eu.org' },
    URL,
  });
  const { skeletonKind, skeletonMarkup } = window.CloudInkReader;
  assert.equal(skeletonKind('/'), 'home');
  assert.equal(skeletonKind('/post/'), 'posts');
  assert.equal(skeletonKind('/post/page/2/'), 'posts');
  assert.equal(skeletonKind('/shorts/'), 'shorts');
  assert.equal(skeletonKind('/shorts/#note:1'), 'shorts');
  assert.equal(skeletonKind('/archive/'), 'archive');
  assert.equal(skeletonKind('/about/'), 'page');
  assert.equal(skeletonKind('/posts/niri-editorial-workflow/'), 'article');

  for (const kind of ['article', 'shorts', 'posts', 'archive', 'home', 'page']) {
    const markup = skeletonMarkup(kind);
    assert.ok(markup.center.includes('aria-hidden="true"'), `${kind} center is decorative`);
    assert.ok(markup.context.includes('aria-hidden="true"'), `${kind} context is decorative`);
  }
  const article = skeletonMarkup('article');
  assert.ok(article.center.includes('article-reading'), 'article skeleton mirrors article-reading');
  assert.ok(article.center.includes('article-headline'), 'article skeleton mirrors headline');
  assert.ok(article.context.includes('article-toc-panel'), 'article context mirrors TOC panel');
  assert.ok(article.context.includes('article-info-panel'), 'article context mirrors info panel');
});

test('reader-runtime mounts layout skeleton after debounce on slow navigation and clears cleanly on view or error', async () => {
  const source = await readFile('assets/reader-runtime.js', 'utf8');
  const createNode = (id = '') => {
    const classes = new Set();
    const children = [];
    const node = {
      id,
      dataset: {},
      className: '',
      innerHTML: '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      setAttribute() {},
      removeAttribute() {},
      append(child) {
        child.parent = node;
        children.push(child);
      },
      remove() {
        if (!this.parent) return;
        const idx = this.parent._children.indexOf(this);
        if (idx >= 0) this.parent._children.splice(idx, 1);
      },
      querySelector(selector) {
        if (selector.includes('reader-skeleton-layer'))
          return children.find((c) => c.className === 'reader-skeleton-layer') || null;
        return null;
      },
      _children: children,
    };
    return node;
  };
  const nodes = {
    swup: createNode('swup'),
    'reader-center': createNode('reader-center'),
    'reader-context': createNode('reader-context'),
    'reader-center-content': createNode('reader-center-content'),
    'reader-context-content': createNode('reader-context-content'),
  };
  let resolveFetch;
  const hooks = new Map();
  const cache = new Map();
  const window = { addEventListener() {} };
  const document = {
    hidden: false,
    title: 'Home',
    head: { querySelectorAll: () => [], append() {} },
    body: { append() {} },
    addEventListener() {},
    getElementById: (id) => nodes[id] || null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = createNode();
      el.tagName = tag.toUpperCase();
      return el;
    },
  };
  class FakeDOMParser {
    parseFromString() {
      return {
        title: 'Slow Article',
        head: { querySelectorAll: () => [] },
        documentElement: { dataset: {} },
        getElementById: (id) => (id === 'swup' ? {} : null),
        querySelector: (selector) => (selector.startsWith('#reader-') ? {} : null),
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
    fetch: () =>
      new Promise((resolve) => {
        resolveFetch = () =>
          resolve({
            ok: true,
            url: 'https://forimagine.eu.org/posts/slow-article/',
            headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' }),
            text: async () => '<html><body><main id="swup"></main></body></html>',
          });
      }),
  });

  const swup = {
    visit: { id: 'v1' },
    options: {
      containers: ['#reader-center-content', '#reader-context-content'],
      requestHeaders: {},
    },
    cache: {
      get: (url) => cache.get(url),
      set: (url, page) => cache.set(url, page),
    },
    hooks: {
      replace() {},
      on(name, cb) {
        hooks.set(name, cb);
      },
    },
    async performNavigation(visit, options) {
      visit.meta = options.meta;
      hooks.get('page:view')?.(visit);
    },
  };
  window.CloudInkReader.attach(swup);

  const visit = {
    id: 'v1',
    to: { url: '/posts/slow-article/', hash: '' },
    cache: { read: true, write: true },
    history: { popstate: false },
    trigger: {},
    abort() {
      assert.fail('should not abort');
    },
  };
  const nav = swup.performNavigation(visit);
  // Immediately after click (before 120ms debounce): no skeleton flash
  assert.equal(nodes['reader-center'].classList.contains('is-skeleton'), false);

  await new Promise((r) => setTimeout(r, 170));
  assert.equal(nodes['reader-center'].classList.contains('is-skeleton'), true);
  assert.equal(nodes['reader-context'].classList.contains('is-skeleton'), true);
  assert.equal(nodes.swup.dataset.skeletonKind, 'article');
  assert.ok(nodes['reader-center'].querySelector(':scope > .reader-skeleton-layer'));

  resolveFetch();
  await nav;
  assert.equal(nodes['reader-center'].classList.contains('is-skeleton'), false);
  assert.equal(nodes['reader-context'].classList.contains('is-skeleton'), false);
  assert.equal(nodes['reader-center'].querySelector(':scope > .reader-skeleton-layer'), null);
  assert.equal(nodes['reader-center-content'].classList.contains('is-skeleton-reveal'), true);

  // Cached second navigation never mounts skeleton
  await new Promise((r) => setTimeout(r, 280));
  assert.equal(nodes['reader-center-content'].classList.contains('is-skeleton-reveal'), false);
  const cachedVisit = {
    id: 'v2',
    to: { url: '/posts/slow-article/', hash: '' },
    cache: { read: true, write: true },
    history: { popstate: false },
    trigger: {},
    abort() {},
  };
  await swup.performNavigation(cachedVisit);
  assert.equal(nodes['reader-center'].classList.contains('is-skeleton'), false);
  assert.equal(cachedVisit.meta.hadSkeleton, false);
});

test('reader-runtime loads Highlight.js asynchronously only when code blocks exist and supports parallel load + retry', async () => {
  const source = await readFile('assets/reader-runtime.js', 'utf8');
  const appendedHead = [];
  const makeEl = (tag) => {
    const classes = new Set();
    const listeners = new Map();
    return {
      tagName: tag.toUpperCase(),
      dataset: {},
      className: '',
      isConnected: true,
      async: false,
      src: '',
      href: '',
      rel: '',
      hidden: false,
      childElementCount: 0,
      children: [],
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
      dispatch(type) {
        listeners.get(type)?.();
      },
      setAttribute() {},
      remove() {
        this.removed = true;
      },
      append(...items) {
        this.children.push(...items);
        this.childElementCount = this.children.length;
        this.firstChild = this.children[0];
        this.lastChild = this.children[this.children.length - 1];
      },
    };
  };

  let codeBlocks = [];
  const swupNode = {
    querySelector(sel) {
      if (sel.includes('pre code')) return codeBlocks[0] || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('pre code'))
        return codeBlocks.filter((c) => !c.classList.contains('hljs') && !c.dataset.highlighted);
      return [];
    },
  };

  const elementsById = new Map([['swup', swupNode]]);
  const window = {};
  const document = {
    documentElement: { dataset: { readingFont: 'sans' } },
    body: {
      append(node) {
        if (node.id) elementsById.set(node.id, node);
      },
    },
    head: {
      append(node) {
        appendedHead.push(node);
        // Auto-complete CSS links asynchronously
        if (node.tagName === 'LINK') {
          setTimeout(() => {
            node.sheet = {};
            node.dispatch('load');
          }, 5);
        }
      },
    },
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    querySelector(sel) {
      if (sel.includes('pre code')) return codeBlocks[0] || null;
      if (sel.includes('data-reader-style="code"')) {
        return (
          appendedHead.find((n) => n.tagName === 'LINK' && n.dataset.readerStyle === 'code') || null
        );
      }
      return null;
    },
    createElement(tag) {
      return makeEl(tag);
    },
  };
  runInNewContext(source, {
    window,
    document,
    globalThis: { requestAnimationFrame: (cb) => setTimeout(cb, 0) },
    setTimeout,
    clearTimeout,
    URL,
    Promise,
    Map,
    Set,
  });

  // 1. Page without code blocks: zero Highlight.js script and zero code.css requests
  assert.equal(window.CloudInkReader.hasCodeBlocks(swupNode), false);
  await window.CloudInkReader.activate();
  assert.equal(appendedHead.length, 0, 'non-code page must not append highlight.js or code.css');

  // 2. Page with code blocks: first attempt fails, cleans up script, shows retry status
  const rustCode = makeEl('code');
  rustCode.className = 'language-rust';
  const kdlCode = makeEl('code');
  kdlCode.className = 'language-kdl';
  codeBlocks = [rustCode, kdlCode];
  assert.equal(window.CloudInkReader.hasCodeBlocks(swupNode), true);

  const firstRun = window.CloudInkReader.activate();
  // Both code.css and async highlight.js must be initiated in parallel immediately
  const linkNode = appendedHead.find((n) => n.tagName === 'LINK');
  const script1 = appendedHead.find((n) => n.tagName === 'SCRIPT');
  assert.ok(linkNode && linkNode.href === '/reader-assets/code.css', 'code.css must be requested');
  assert.ok(script1, 'highlight.js script must start in parallel without waiting for code.css');
  assert.equal(script1.async, true, 'highlight.js script must be async');
  assert.equal(script1.src, '/reader-assets/highlight.js');
  // Simulate script load error
  script1.onerror();
  await firstRun;
  assert.equal(script1.removed, true, 'failed highlight.js script must be removed for retry');

  // 3. Retry succeeds: deduplicates concurrent activate() calls and highlights blocks
  const highlighted = [];
  const retryA = window.CloudInkReader.activate();
  const retryB = window.CloudInkReader.activate();
  const scripts = appendedHead.filter((n) => n.tagName === 'SCRIPT');
  assert.equal(scripts.length, 2, 'concurrent retry must share one in-flight highlight.js load');
  const script2 = scripts[1];
  assert.equal(script2.async, true);
  window.CloudInkHighlighter = {
    getLanguage: (lang) => (lang === 'rust' ? {} : undefined),
    highlightElement(el) {
      highlighted.push(el);
      el.classList.add('hljs');
      el.dataset.highlighted = 'yes';
    },
  };
  script2.onload();
  await Promise.all([retryA, retryB]);
  assert.equal(highlighted.length, 1, 'only registered language block calls highlightElement');
  assert.equal(highlighted[0], rustCode);
  assert.equal(rustCode.classList.contains('hljs'), true);
  assert.equal(kdlCode.classList.contains('hljs'), true, 'unregistered language still marked hljs');
  assert.equal(kdlCode.dataset.highlighted, 'yes');
});

test('render.rs, reader.ts, and admin preview.worker.js keep Highlight.js strictly async and conditional', async () => {
  const renderRs = await readFile('crates/blog-core/src/render.rs', 'utf8');
  assert.equal(
    renderRs.includes('highlight.min.js'),
    false,
    'render.rs must not emit unconditional synchronous highlight.min.js',
  );
  assert.match(renderRs, /let has_code = body\.contains\("<pre><code"\);/);

  const readerTs = await readFile('cloud-web/src/reader.ts', 'utf8');
  assert.match(readerTs, /highlight\(\?:\\\.min\)\?\\\.js/);

  const previewWorker = await readFile('cloud-admin/ui/preview.worker.js', 'utf8');
  assert.doesNotMatch(
    previewWorker,
    /^\s*import\s+hljs\s+from\s+['"]highlight\.js/m,
    'preview.worker.js must not statically import highlight.js',
  );
  assert.match(previewWorker, /import\(['"]\/preview-highlight\.js['"]\)/);
  assert.match(
    previewWorker,
    /if \(!\/<pre><code class="language-\[\^"\]\+">\/\.test\(html\)\) return html;/,
  );
});

test('shared admin UI dom.js helpers format bytes and compute SHA-256 hex consistently', async () => {
  const { createHash } = await import('node:crypto');
  const { formatBytes, sha256Hex } = await import('../../cloud-admin/ui/dom.js');
  const expected = createHash('sha256').update('cloudink').digest('hex');
  assert.equal(formatBytes(512), '0.5 KB');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(2.5 * 1024 * 1024), '2.5 MB');
  assert.equal(await sha256Hex('cloudink'), expected);
  assert.equal(await sha256Hex(new TextEncoder().encode('cloudink')), expected);
});

test('frontend code splitting defers non-core admin modules and reader share card via dynamic imports', async () => {
  const appJs = await readFile('cloud-admin/ui/app.js', 'utf8');
  const buildUi = await readFile('cloud-admin/build-ui.mjs', 'utf8');
  const workerIndex = await readFile('cloud-web/src/index.ts', 'utf8');
  const devServer = await readFile('scripts/dev-server.mjs', 'utf8');
  const clientJs = await readFile('crates/blog-core/src/assets/client.js', 'utf8');
  const webAssets = await readFile('scripts/web-assets.mjs', 'utf8');

  const lazyAdminChunks = [
    '/shorts.js',
    '/images.js',
    '/editor-tools.js',
    '/markdown-import.js',
    '/preview.js',
    '/image-upload.js',
  ];
  for (const chunk of lazyAdminChunks) {
    assert.ok(appJs.includes(`import('${chunk}')`), `app.js must dynamically import ${chunk}`);
    assert.ok(buildUi.includes(`'${chunk}'`), `build-ui.mjs must bundle and register ${chunk}`);
    assert.ok(workerIndex.includes(`'${chunk}'`), `cloud-web/src/index.ts must route ${chunk}`);
    assert.ok(devServer.includes(`'${chunk}'`), `dev-server.mjs must serve ${chunk}`);
  }
  for (const eagerModule of [
    './images.js',
    './shorts.js',
    './markdown-import.js',
    './editor-enhancements.js',
    './draft-history.js',
    './preview.js',
    './image-upload.js',
  ]) {
    assert.equal(
      appJs.includes(`from '${eagerModule}'`),
      false,
      `app.js must not statically import ${eagerModule}`,
    );
  }

  assert.ok(
    clientJs.includes("import('/reader-assets/share-card.js')"),
    'client.js must dynamically import /reader-assets/share-card.js on demand',
  );
  assert.equal(
    clientJs.includes("canvas.toDataURL('image/png')"),
    false,
    'client.js must not inline share card canvas rendering',
  );
  assert.ok(
    webAssets.includes('assets/reader-share-card.js'),
    'web-assets.mjs must build share-card.js',
  );
  assert.ok(
    workerIndex.includes('share-card\\.js'),
    'cloud-web/src/index.ts must serve /reader-assets/share-card.js',
  );
  assert.ok(
    devServer.includes("'/reader-assets/share-card.js'"),
    'dev-server.mjs must serve /reader-assets/share-card.js',
  );

  const shareCardModule = await import('../../assets/reader-share-card.js');
  assert.equal(typeof shareCardModule.openShareCard, 'function');
});

test('reader-runtime promotes async stylesheets via CSP-safe listeners and does not block SPA swap on code.css or unrelated fonts', async () => {
  const source = await readFile('assets/reader-runtime.js', 'utf8');
  const appendedHead = [];
  const makeLink = (attrs = {}) => {
    const listeners = new Map();
    return {
      tagName: 'LINK',
      rel: 'stylesheet',
      media: attrs.media || 'all',
      href: attrs.href || '',
      dataset: { ...(attrs.dataset || {}) },
      sheet: attrs.sheet || null,
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
      dispatch(type) {
        listeners.get(type)?.();
      },
      setAttribute(name, value) {
        this[name] = value;
      },
    };
  };

  const pendingEditorialLink = makeLink({
    media: 'print',
    href: '/reader-assets/editorial-font.css',
    dataset: { readerAsync: 'style' },
  });
  const loadedCodeLink = makeLink({
    media: 'print',
    href: '/reader-assets/code.css',
    dataset: { readerAsync: 'style', readerStyle: 'code' },
    sheet: {},
  });

  // Track an unrelated slow Chinese font that never resolves in document.fonts.ready,
  // alongside a fast KaTeX font that resolves immediately.
  let katexFontResolved = false;
  const katexFont = {
    family: 'KaTeX_Main',
    status: 'loading',
    loaded: Promise.resolve().then(() => {
      katexFontResolved = true;
    }),
  };
  const slowEditorialFont = {
    family: 'Noto Serif SC',
    status: 'loading',
    loaded: new Promise(() => {}),
  };

  const window = { addEventListener() {} };
  const document = {
    documentElement: { dataset: {} },
    body: { append() {} },
    head: {
      append(node) {
        appendedHead.push(node);
      },
    },
    fonts: {
      ready: new Promise(() => {}), // Never resolves to prove math prepare doesn't wait on slow CJK fonts
      [Symbol.iterator]: function* () {
        yield slowEditorialFont;
        yield katexFont;
      },
    },
    querySelector(sel) {
      if (sel.includes('data-reader-style="code"')) {
        return (
          appendedHead.find((n) => n.tagName === 'LINK' && n.dataset.readerStyle === 'code') || null
        );
      }
      if (sel.includes('data-reader-style="math"')) {
        return (
          appendedHead.find((n) => n.tagName === 'LINK' && n.dataset.readerStyle === 'math') || null
        );
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('data-reader-async="style"')) {
        return [pendingEditorialLink, loadedCodeLink].filter(
          (link) => link.media === 'print' && link.dataset.readerAsync === 'style',
        );
      }
      return [];
    },
    createElement(tag) {
      if (tag === 'link') return makeLink();
      return {
        tagName: tag.toUpperCase(),
        dataset: {},
        async: false,
        style: { cssText: '' },
        setAttribute() {},
        append() {},
        getBoundingClientRect() {},
        remove() {},
      };
    },
  };

  runInNewContext(source, {
    window,
    document,
    navigator: { onLine: true, connection: { saveData: false, effectiveType: '4g' } },
    location: { href: 'https://forimagine.eu.org/', origin: 'https://forimagine.eu.org' },
    setTimeout,
    clearTimeout,
    URL,
    Promise,
    Map,
    Set,
  });

  // On boot, already-loaded async link is promoted immediately; pending link flips on load.
  assert.equal(loadedCodeLink.media, 'all');
  assert.equal(pendingEditorialLink.media, 'print');
  pendingEditorialLink.dispatch('load');
  assert.equal(pendingEditorialLink.media, 'all');

  // SPA navigation to a code-only article must NOT block on code.css or highlight.js
  const codeDoc = {
    documentElement: { dataset: {} },
    querySelector(sel) {
      if (sel.includes('pre code')) return {};
      return null;
    },
  };
  await window.CloudInkReader.prepare(codeDoc, true);
  const codeLink = appendedHead.find(
    (n) => n.tagName === 'LINK' && n.dataset.readerStyle === 'code',
  );
  assert.ok(codeLink, 'SPA prepare still kicks off code.css asynchronously');
  assert.ok(
    appendedHead.some((n) => n.tagName === 'SCRIPT' && n.src === '/reader-assets/highlight.js'),
    'SPA prepare still kicks off highlight.js asynchronously',
  );
  codeLink.sheet = {};
  codeLink.dispatch('load');

  // SPA navigation to a math article awaits katex.css + KaTeX fonts, NOT slow unrelated CJK fonts
  const mathDoc = {
    documentElement: { dataset: {} },
    querySelector(sel) {
      if (sel.includes('.katex')) return { cloneNode: () => ({}) };
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('.katex')) return [{ cloneNode: () => ({}) }];
      return [];
    },
  };
  const mathPrepare = window.CloudInkReader.prepare(mathDoc, true);
  const mathLink = appendedHead.find(
    (n) => n.tagName === 'LINK' && n.dataset.readerStyle === 'math',
  );
  assert.ok(mathLink, 'math article requests katex.css');
  mathLink.sheet = {};
  mathLink.dispatch('load');
  await mathPrepare;
  assert.equal(katexFontResolved, true);
});

test('public rendering pipeline uses non-blocking async styles, deferred scripts, and rAF/idle hydration', async () => {
  const [pageRendering, renderRs, readerTs, devServer, clientJs, readerRuntime] = await Promise.all(
    [
      readFile('cloud-admin/src/page-rendering.ts', 'utf8'),
      readFile('crates/blog-core/src/render.rs', 'utf8'),
      readFile('cloud-web/src/reader.ts', 'utf8'),
      readFile('scripts/dev-server.mjs', 'utf8'),
      readFile('crates/blog-core/src/assets/client.js', 'utf8'),
      readFile('assets/reader-runtime.js', 'utf8'),
    ],
  );

  assert.match(pageRendering, /<script src="\/client\.js" defer><\/script>/);
  assert.match(renderRs, /<script src="https:\/\/unpkg\.com\/swup@4" defer><\/script>/);
  assert.match(renderRs, /<script src="\/client\.js\?v=\{client_hash\}" defer><\/script>/);
  assert.match(renderRs, /media="print" data-reader-async="style"/);
  assert.match(readerTs, /el\.setAttribute\('media', 'print'\)/);
  assert.match(readerTs, /el\.setAttribute\('data-reader-async', 'style'\)/);
  assert.match(readerTs, /media="print" data-reader-style="code" data-reader-async="style"/);
  assert.equal(
    readerTs.includes('onload='),
    false,
    'reader.ts must never inject inline onload handlers under strict CSP',
  );
  assert.match(devServer, /<script src="\/client\.js" defer><\/script>/);
  assert.match(devServer, /media="print" data-reader-async="style"/);

  // client.js defer-safe boot, rAF scroll cue measurement, idle related-stories fetch
  assert.match(clientJs, /if \(document\.readyState === 'loading'\)/);
  assert.match(clientJs, /const initialRefreshFrame = requestAnimationFrame\(refresh\);/);
  assert.match(clientJs, /requestIdleCallback\(loadStories, \{ timeout: 1200 \}\)/);

  // reader-runtime parallel idle warmup includes homepage shorts links
  assert.match(readerRuntime, /\.blog-note a\[href\^="\/shorts\/"\]/);
  assert.match(readerRuntime, /Promise\.all\(batch\.map/);
});

test('admin articles and shorts loading eliminates waterfalls with parallel fetches, SWR, and intent prefetching', async () => {
  const [shortsJs, appJs] = await Promise.all([
    readFile('cloud-admin/ui/shorts.js', 'utf8'),
    readFile('cloud-admin/ui/app.js', 'utf8'),
  ]);

  // Shorts: parallel load + SWR + editor loading feedback + pointerdown/touchstart prefetch
  assert.match(shortsJs, /const hadData = hasLoaded && shorts\.length > 0;/);
  assert.match(shortsJs, /const fetchPromise = load\(\);/);
  assert.match(shortsJs, /正在读取短记…/);
  assert.match(shortsJs, /if \(waiting\) status\('正在加载短记正文…'\);/);
  assert.match(shortsJs, /card\.addEventListener\('pointerdown', warm, \{ passive: true \}\);/);
  assert.match(shortsJs, /card\.addEventListener\('touchstart', warm, \{ passive: true \}\);/);

  // Articles & Admin nav: parallel editor-tools, parallel settings, pointerdown/touchstart prefetch
  assert.match(
    appJs,
    /void loadEditorTools\(\)\.catch\(\(\) => \{\}\);\s*try \{\s*[\s\S]*?Promise\.all\(\[flush\(\), request\]\)/,
  );
  assert.match(appJs, /card\.addEventListener\('pointerdown', warmArticle, \{ passive: true \}\);/);
  assert.match(appJs, /card\.addEventListener\('touchstart', warmArticle, \{ passive: true \}\);/);
  assert.match(appJs, /\$\('shorts'\)\.addEventListener\('pointerdown', warmShortTools/);
  assert.match(
    appJs,
    /Promise\.all\(\[\s*flush\(\),\s*api\('\/api\/settings'\),\s*loadIllustrationPicker\(\),\s*loadBackup\(\)/,
  );
});

test('reader-runtime shorts peek and batch planning helpers handle boundaries accurately', async () => {
  const source = await readFile('assets/reader-runtime.js', 'utf8');
  const window = { addEventListener() {} };
  runInNewContext(source, {
    window,
    document: {},
    navigator: { onLine: true },
    location: { href: 'https://forimagine.eu.org/shorts/', origin: 'https://forimagine.eu.org' },
    URL,
  });
  const {
    SHORTS_BATCH_SIZE,
    SHORTS_PEEK_MAX_HEIGHT,
    computeShortPeek,
    planShortsPage,
    planShortsExpand,
  } = window.CloudInkReader;

  assert.equal(SHORTS_BATCH_SIZE, 3);
  assert.equal(SHORTS_PEEK_MAX_HEIGHT, 120);

  const plain = (value) => ({ ...value });

  // computeShortPeek: min(50% naturalHeight, 120px) and short-card promotion
  assert.deepEqual(plain(computeShortPeek(0)), { shouldPeek: false, height: 0 });
  assert.deepEqual(plain(computeShortPeek(-20)), { shouldPeek: false, height: 0 });
  assert.deepEqual(plain(computeShortPeek(84)), { shouldPeek: false, height: 84 });
  assert.deepEqual(plain(computeShortPeek(110)), { shouldPeek: false, height: 110 });
  assert.deepEqual(plain(computeShortPeek(112)), { shouldPeek: true, height: 56 });
  assert.deepEqual(plain(computeShortPeek(194)), { shouldPeek: true, height: 97 });
  assert.deepEqual(plain(computeShortPeek(240)), { shouldPeek: true, height: 120 });
  assert.deepEqual(plain(computeShortPeek(420)), { shouldPeek: true, height: 120 });

  // planShortsPage: initial HTML contains 3 full + 1 peek when N > 3, and <= 3 when N <= 3
  assert.deepEqual(plain(planShortsPage(0, 1)), {
    pageNumber: 1,
    total: 0,
    totalPages: 1,
    start: 0,
    fullEnd: 0,
    hasPeek: false,
    renderEnd: 0,
    prevPage: null,
    nextPage: null,
  });
  assert.deepEqual(plain(planShortsPage(3, 1)), {
    pageNumber: 1,
    total: 3,
    totalPages: 1,
    start: 0,
    fullEnd: 3,
    hasPeek: false,
    renderEnd: 3,
    prevPage: null,
    nextPage: null,
  });
  assert.deepEqual(plain(planShortsPage(4, 1)), {
    pageNumber: 1,
    total: 4,
    totalPages: 2,
    start: 0,
    fullEnd: 3,
    hasPeek: true,
    renderEnd: 4,
    prevPage: null,
    nextPage: 2,
  });
  assert.deepEqual(plain(planShortsPage(4, 2)), {
    pageNumber: 2,
    total: 4,
    totalPages: 2,
    start: 3,
    fullEnd: 4,
    hasPeek: false,
    renderEnd: 4,
    prevPage: 1,
    nextPage: null,
  });
  assert.deepEqual(plain(planShortsPage(12, 1)), {
    pageNumber: 1,
    total: 12,
    totalPages: 4,
    start: 0,
    fullEnd: 3,
    hasPeek: true,
    renderEnd: 4,
    prevPage: null,
    nextPage: 2,
  });
  assert.deepEqual(plain(planShortsPage(12, 4)), {
    pageNumber: 4,
    total: 12,
    totalPages: 4,
    start: 9,
    fullEnd: 12,
    hasPeek: false,
    renderEnd: 12,
    prevPage: 3,
    nextPage: null,
  });

  // planShortsExpand: N=4 needs 0 new cards; N=12 steps 3 -> 6 -> 9 -> 12
  assert.deepEqual(plain(planShortsExpand({ fullCount: 3, renderedCount: 4, total: 4 })), {
    targetFull: 4,
    targetRendered: 4,
    hasNextPeek: false,
    neededNewCards: 0,
    needsFetch: false,
    complete: true,
  });
  assert.deepEqual(plain(planShortsExpand({ fullCount: 3, renderedCount: 4, total: 12 })), {
    targetFull: 6,
    targetRendered: 7,
    hasNextPeek: true,
    neededNewCards: 3,
    needsFetch: true,
    complete: false,
  });
  assert.deepEqual(plain(planShortsExpand({ fullCount: 6, renderedCount: 7, total: 12 })), {
    targetFull: 9,
    targetRendered: 10,
    hasNextPeek: true,
    neededNewCards: 3,
    needsFetch: true,
    complete: false,
  });
  assert.deepEqual(plain(planShortsExpand({ fullCount: 9, renderedCount: 10, total: 12 })), {
    targetFull: 12,
    targetRendered: 12,
    hasNextPeek: false,
    neededNewCards: 2,
    needsFetch: true,
    complete: true,
  });
  // After short-height promotion (fullCount=4, renderedCount=5), next expand advances by +3 to 7 + peek 8
  assert.deepEqual(plain(planShortsExpand({ fullCount: 4, renderedCount: 5, total: 12 })), {
    targetFull: 7,
    targetRendered: 8,
    hasNextPeek: true,
    neededNewCards: 3,
    needsFetch: true,
    complete: false,
  });
});

test('shorts incremental pagination contracts stay aligned across Rust, Worker, Admin, CSS, and Client', async () => {
  const [renderRs, libRs, bundleRs, publishingTs, workerIndex, workerReader, homeCss, clientJs] =
    await Promise.all([
      readFile('crates/blog-core/src/render.rs', 'utf8'),
      readFile('crates/blog-core/src/lib.rs', 'utf8'),
      readFile('crates/blog-core/src/bundle.rs', 'utf8'),
      readFile('cloud-admin/src/browser-publishing.ts', 'utf8'),
      readFile('cloud-web/src/index.ts', 'utf8'),
      readFile('cloud-web/src/reader.ts', 'utf8'),
      readFile('crates/blog-core/src/assets/home.css', 'utf8'),
      readFile('crates/blog-core/src/assets/client.js', 'utf8'),
    ]);

  // Rust rendering & static page generation
  assert.match(renderRs, /pub const SHORTS_PER_PAGE: usize = 3;/);
  assert.match(renderRs, /pub fn render_shorts_page\(/);
  assert.match(renderRs, /class="short-card shorts-peek"/);
  assert.match(renderRs, /<div class="short-body" inert>/);
  assert.match(
    renderRs,
    /id="shorts-expand-btn" aria-expanded="false" aria-controls="shorts-feed"/,
  );
  assert.match(
    renderRs,
    /id="shorts-list-next" href="\/shorts\/page\/\{\}\/" data-shorts-next-link="true" data-no-swup/,
  );
  assert.match(libRs, /render::SHORTS_PER_PAGE/);
  assert.match(libRs, /shorts_dir\.join\("page"\)/);
  assert.match(bundleRs, /render::SHORTS_PER_PAGE/);
  assert.match(bundleRs, /shorts\/page\/\{page\}\/index\.html/);

  // Browser publishing & Worker routing/sitemap
  assert.match(publishingTs, /shorts\/page\/\$\{i \+ 2\}\/index\.html/);
  assert.match(workerIndex, /shorts\/page\/\(\[1-9\]\\d\*\)/);
  assert.match(workerReader, /\(\?:post\|shorts\)\\\/page\\\/\[1-9\]\\d\*\\\/index\\\.html/);

  // Scoped shorts- CSS & reduced-motion support
  assert.match(homeCss, /\.short-card\.shorts-peek\s*\{/);
  assert.match(homeCss, /max-height:\s*var\(--shorts-peek-height,\s*120px\)/);
  assert.match(homeCss, /pointer-events:\s*none/);
  assert.match(homeCss, /var\(--surface\)/);
  assert.match(homeCss, /prefers-reduced-motion:\s*reduce/);

  // Client unified expand, deep link auto-expansion, and /shorts/ scroll restoration
  assert.match(clientJs, /function mountShortsFeed\(visit\)/);
  assert.match(clientJs, /mountShortsFeed\(visit\);/);
  assert.match(clientJs, /rootMargin:\s*'200px 0px'/);
  assert.match(clientJs, /resolveShortDeepLink/);
  assert.match(clientJs, /\^\\\/shorts\\\/\(\?:page\\\/\[1-9\]\\d\*\\\/\)\?\$/);
});

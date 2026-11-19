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

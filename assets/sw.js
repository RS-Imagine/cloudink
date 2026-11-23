// Refresh previously visited sections when opening the site. Serve in-site reads from cache.
const CACHE_PREFIX = 'cloudink-reader-';
const CACHE_NAME = CACHE_PREFIX + 'v4';
const READER_BUNDLES = ['/client.js', '/theme.js', '/styles.css'];
const READER_ASSETS = [...READER_BUNDLES, '/search_index.json'];
const READER_SECTIONS = new Set(['/', '/post/', '/shorts/', '/archive/', '/about/']);
const LIST_PAGE = /^\/(post|shorts)\/page\/[1-9]\d*\/$/;
const STATIC_ASSETS = ['/', ...READER_BUNDLES, '/favicon.svg', '/manifest.webmanifest'];
const openingRefreshes = new Map();

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                (key.startsWith(CACHE_PREFIX) || key === 'cloudink-v1') && key !== CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
function cacheKeyFor(request) {
  const url = new URL(request.url);
  url.hash = '';
  // Published HTML includes ?v= even though the Worker serves the current bundle at every version.
  if (READER_BUNDLES.includes(url.pathname)) url.search = '';
  return url.href;
}
async function storeResponse(key, response) {
  if (!response || !response.ok) return;
  if (response.type && response.type !== 'basic' && response.type !== 'default') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, response.clone());
  } catch {
    // Cache quota or unavailable storage must not break an online response.
  }
}
async function cachedResponse(key) {
  try {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(key);
  } catch {
    return undefined;
  }
}
async function networkFirst(request, key, forceRevalidate = true, onSuccess) {
  try {
    const response = forceRevalidate
      ? await fetch(request, { cache: 'no-cache' })
      : await fetch(request);
    if (response.ok) onSuccess?.();
    await storeResponse(key, response);
    return response;
  } catch {
    return (await cachedResponse(key)) || Response.error();
  }
}
async function cacheFirst(request, key) {
  const cached = await cachedResponse(key);
  return cached || networkFirst(request, key, false);
}

async function readReaderPage(request, key, pathname) {
  const pending = openingRefreshes.get(key);
  if (!pending) return cacheFirst(request, key);
  const cached = await cachedResponse(key);
  if (!cached) return networkFirst(request, key, false);

  const revision = request.headers.get('X-CloudInk-List-Revision');
  const list = pathname.match(LIST_PAGE)?.[1];
  if (revision && list) {
    // A batch from another list revision cannot extend the list already on screen.
    if ((await cached.clone().text()).includes(`data-${list}-revision="${revision}"`))
      return cached;
    await pending;
    const refreshed = await cachedResponse(key);
    if (refreshed) void cached.body?.cancel();
    return refreshed || cached;
  }

  // Let the reader use this copy immediately without pinning it in Swup for the whole visit.
  const headers = new Headers(cached.headers);
  headers.set('X-CloudInk-Opening-Refresh', 'pending');
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

function refreshOnOpen(navigationKey) {
  const snapshot = caches.open(CACHE_NAME).then(async (cache) => ({
    cache,
    keys: new Set((await cache.keys()).map(({ url }) => url)),
  }));
  const refresh = (key, priority, after) => {
    if (key === navigationKey) return;
    const existing = openingRefreshes.get(key);
    if (existing) return existing;
    const pending = Promise.all([snapshot, after])
      .then(async ([{ cache, keys }]) => {
        if (!keys.has(key)) return;
        const response = await fetch(key, { cache: 'no-cache', priority });
        if (response.ok && ['basic', 'default'].includes(response.type)) {
          await cache.put(key, response);
        } else {
          await response.body?.cancel();
          // Remove a section or page if the origin confirms it no longer exists.
          if (response.status === 404 || response.status === 410) await cache.delete(key);
        }
      })
      .catch(() => {}) // Keep the last usable copy when an update fails.
      .finally(() => openingRefreshes.delete(key));
    openingRefreshes.set(key, pending);
    return pending;
  };

  // Start these before handing the document to the browser so it can use the same bundle requests.
  const assets = READER_ASSETS.map((path) =>
    refresh(
      new URL(path, self.location.origin).href,
      path === '/search_index.json' ? 'low' : 'auto',
    ),
  );
  const pages = snapshot.then(({ keys }) => {
    const sections = [];
    const batches = { '/post/': [], '/shorts/': [] };
    for (const key of keys) {
      const url = new URL(key);
      if (url.origin !== self.location.origin) continue;
      const path = url.pathname.replace(/\/index\.html$/, '/').replace(/\/?$/, '/');
      const list = path.match(LIST_PAGE)?.[1];
      if (list) batches[`/${list}/`].push(refresh(key, 'low'));
      else if (READER_SECTIONS.has(path)) sections.push({ key, path });
    }
    // Refresh visited pagination before making the corresponding updated lists available.
    return Promise.all([
      ...batches['/post/'],
      ...batches['/shorts/'],
      ...sections.map(({ key, path }) => refresh(key, 'low', Promise.all(batches[path] || []))),
    ]);
  });
  return Promise.allSettled([...assets, pages]);
}

async function staleWhileRevalidate(event, request, key) {
  if (request.cache === 'reload') return networkFirst(request, key, true);
  const cached = await cachedResponse(key);
  const refresh = (cached ? fetch(key, { cache: 'no-cache' }) : fetch(request))
    .then(async (response) => {
      await storeResponse(key, response);
      return response;
    })
    .catch(() => cached || Response.error());
  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/admin') ||
    url.pathname === '/sw.js' ||
    url.pathname === '/_release.json'
  )
    return;

  const key = cacheKeyFor(request);
  const media =
    url.pathname.startsWith('/reader-assets/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname.startsWith('/site-icon/');
  if (media) {
    const immutable = /\.(?:woff2?|png|jpe?g|webp|gif|avif|svg|ico)$/.test(url.pathname);
    event.respondWith(
      immutable ? cacheFirst(request, key) : staleWhileRevalidate(event, request, key),
    );
    return;
  }
  if (request.mode === 'navigate') {
    let refresh;
    const response = networkFirst(request, key, true, () => {
      refresh = refreshOnOpen(key);
    });
    event.respondWith(response);
    event.waitUntil(response.then(() => refresh));
  } else if (READER_ASSETS.includes(url.pathname)) {
    // An early stylesheet or search request can share work already started on this opening.
    const pending = openingRefreshes.get(key);
    event.respondWith(
      pending ? pending.then(() => cacheFirst(request, key)) : cacheFirst(request, key),
    );
  } else if (
    request.headers.get('accept')?.includes('text/html') ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html')
  ) {
    event.respondWith(readReaderPage(request, key, url.pathname));
  } else if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request, key));
  }
});

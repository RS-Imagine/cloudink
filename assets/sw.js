// Public reading cache: instant repeat reads via stale-while-revalidate, fresh on reload, offline-ready.
const CACHE_PREFIX = 'cloudink-reader-';
const CACHE_NAME = CACHE_PREFIX + 'v3';
const STATIC_ASSETS = [
  '/',
  '/client.js',
  '/theme.js',
  '/styles.css',
  '/favicon.svg',
  '/manifest.webmanifest',
];

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
async function networkFirst(request, key, forceRevalidate = true) {
  try {
    const response = forceRevalidate
      ? await fetch(request, { cache: 'no-cache' })
      : await fetch(request);
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
  const publicAsset =
    STATIC_ASSETS.includes(url.pathname) ||
    url.pathname === '/search_index.json' ||
    url.pathname.startsWith('/reader-assets/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname.startsWith('/site-icon/');
  if (publicAsset) {
    // Fonts and content-addressed media are immutable; compiled styles/scripts refresh in background.
    const immutable =
      /\.(?:woff2?|png|jpe?g|webp|gif|avif|svg|ico)$/.test(url.pathname) &&
      (url.pathname.startsWith('/reader-assets/') ||
        url.pathname.startsWith('/images/') ||
        url.pathname.startsWith('/site-icon/'));
    event.respondWith(
      immutable ? cacheFirst(request, key) : staleWhileRevalidate(event, request, key),
    );
    return;
  }
  if (
    request.mode === 'navigate' ||
    request.headers.get('accept')?.includes('text/html') ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html')
  )
    event.respondWith(staleWhileRevalidate(event, request, key));
});

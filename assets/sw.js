// Public reading cache: current content online, previously read content offline.
const CACHE_PREFIX = 'cloudink-reader-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
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
async function storeResponse(request, response) {
  if (!response.ok) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch {
    // Cache quota or unavailable storage must not break an online response.
  }
}
async function cachedResponse(request) {
  try {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(request);
  } catch {
    return undefined;
  }
}
async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    await storeResponse(request, response);
    return response;
  } catch {
    return (await cachedResponse(request)) || Response.error();
  }
}
async function cacheFirst(request) {
  const cached = await cachedResponse(request);
  return cached || networkFirst(request);
}
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/admin') ||
    url.pathname === '/sw.js'
  )
    return;

  const publicAsset =
    STATIC_ASSETS.includes(url.pathname) ||
    url.pathname === '/search_index.json' ||
    url.pathname.startsWith('/reader-assets/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname.startsWith('/site-icon/');
  if (publicAsset) {
    // Fonts and content-addressed media are immutable; scripts/styles must update.
    const immutable =
      /\.(?:woff2?|png|jpe?g|webp|gif|avif|svg|ico)$/.test(url.pathname) &&
      (url.pathname.startsWith('/reader-assets/') ||
        url.pathname.startsWith('/images/') ||
        url.pathname.startsWith('/site-icon/'));
    event.respondWith(immutable ? cacheFirst(request) : networkFirst(request));
    return;
  }
  if (
    request.mode === 'navigate' ||
    request.headers.get('accept')?.includes('text/html') ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html')
  )
    event.respondWith(networkFirst(request));
});

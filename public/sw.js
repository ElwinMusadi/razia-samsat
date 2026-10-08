// Public advisory assets only. Bump this version whenever an allowlisted asset changes.
const CACHE_PREFIX = 'razia-samsat-public-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const PUBLIC_ASSETS = new Map([
  ['/offline', 'text/html'],
  ['/offline.css', 'text/css'],
  ['/manifest.webmanifest', 'application/manifest+json'],
  ['/icons/icon-192.png', 'image/png'],
  ['/icons/icon-512.png', 'image/png'],
]);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Never send cookies or accept redirects when populating the public cache.
    const responses = await Promise.all([...PUBLIC_ASSETS].map(async ([path, type]) => {
      const response = await fetch(new URL(path, self.location.origin).href, { credentials: 'omit', cache: 'reload', redirect: 'error' });
      if (response.status !== 200 || response.redirected || response.headers.get('Content-Type')?.split(';')[0].trim() !== type) throw new Error('Public asset unavailable');
      return [path, response];
    }));
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(responses.map(([path, response]) => cache.put(path, response)));
    // No skipWaiting: an update must not interrupt an active operation.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    // No clients.claim: already-open pages keep their controller until the user reopens them.
  })());
});

function isAppNavigation(path) {
  if (['/', '/login', '/razia/setup', '/razia/scanner', '/history', '/admin/users'].includes(path)) return true;
  return /^\/(?:history|admin\/users)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Exact allowlists, not an API denylist: encoded paths, queries and unknown routes are untouched.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search !== '') return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (PUBLIC_ASSETS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(url.pathname) ?? fetch(url.href, { credentials: 'omit', redirect: 'error' });
      // No runtime writes, even for public assets.
    })());
    return;
  }
  if (request.mode !== 'navigate' || !isAppNavigation(url.pathname)) return;
  event.respondWith((async () => {
    try { return await fetch(request); }
    catch (error) {
      const cache = await caches.open(CACHE_NAME);
      const advisory = await cache.match('/offline');
      if (!advisory) throw error;
      const headers = new Headers(advisory.headers);
      headers.set('Cache-Control', 'no-store');
      // Never store network HTML or return a successful response for an unavailable page.
      return new Response(advisory.body, { status: 503, statusText: 'Service Unavailable', headers });
    }
  })());
});

const CACHE_NAME = 'taskforce-v1';
const ASSETS = [
  '/volunteer/',
  '/volunteer/index.html',
  '/socket.io/socket.io.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) {
    return; // Don't cache dynamic API requests
  }
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});

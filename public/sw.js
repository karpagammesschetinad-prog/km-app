/* BizTracker Service Worker — caches static assets for offline shell */
const CACHE = 'biztracker-v1';

const STATIC_ASSETS = [
  '/login.html',
  '/index.html',
  '/expenses.html',
  '/categories.html',
  '/employees.html',
  '/salaries.html',
  '/users.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/main.js',
  '/js/dashboard.js',
  '/js/expenses.js',
  '/js/categories.js',
  '/js/employees.js',
  '/js/salaries.js',
  '/js/users.js',
  '/icons/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(() => { /* ignore partial failures */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never cache API calls — always go to network
  if (url.includes('/api/')) return;

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});

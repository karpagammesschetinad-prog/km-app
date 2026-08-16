const CACHE = 'biztracker-mobile-v1';

const SHELL = [
  'login.html',
  'index.html',
  'expenses.html',
  'categories.html',
  'employees.html',
  'salaries.html',
  'users.html',
  'manifest.json',
  'css/styles.css',
  'js/api.js',
  'js/main.js',
  'js/dashboard.js',
  'js/expenses.js',
  'js/categories.js',
  'js/employees.js',
  'js/salaries.js',
  'js/users.js',
  'icons/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Never cache Google Apps Script calls
  if (e.request.url.includes('script.google.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

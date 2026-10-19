// Service worker : l'app s'ouvre hors ligne. Les appels à Strava ne sont jamais interceptés.
const CACHE = 'strava-coach-v3';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'app.js', 'engine.js', 'db.js', 'strava.js', 'coach.js', 'importer.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request.url.split('?')[0], r.clone()); return r; }).catch(() => hit);
    return hit || net; // cache d'abord, mise à jour en arrière-plan
  }));
});

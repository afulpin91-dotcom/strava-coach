// Service worker : l'app s'ouvre hors ligne. Les appels à Strava ne sont jamais interceptés.
// Réseau d'abord (revalidé à chaque fois) : une mise à jour du site est visible dès le rechargement ;
// le cache ne sert que sans connexion.
const CACHE = 'strava-coach-v11';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'app.js', 'engine.js', 'db.js', 'strava.js', 'coach.js', 'importer.js', 'inbox.js', 'racepace.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) c.put(e.request.url.split('?')[0], r.clone());
      return r;
    } catch {
      return (await c.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});

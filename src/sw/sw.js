// Service worker, from the pwa-cloudflare skill's sw.js template. Not served as-is:
// the build (vite.config.ts) stamps VERSION and fills SHELL with the hashed bundle
// files, so every deploy changes this script's bytes and busts the cache.
const VERSION = 'dev';
const CACHE = 'bitebook-' + VERSION;
const SHELL = [/* SHELL */];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // Cache each file independently: with addAll() a single 404 rejects the
      // whole install and the app silently loses offline support.
      .then(c => Promise.all(
        SHELL.map(url => c.add(url).catch(err => {
          console.warn('[sw] failed to precache', url, err);
        }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Never touch the cache for non-GET or cross-origin requests (this includes
  // Google's sign-in script, which can't work offline anyway).
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  // Sign-in routes always go to the network.
  if (url.pathname.startsWith('/auth/')) return;

  // Network-only for API calls, with a JSON error the client can parse offline.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    return;
  }

  // Network-first for navigations so a deploy is picked up on the next launch;
  // falls back to the cached shell when offline. '/' only, never '/index.html':
  // Workers Static Assets 307-redirects it, and the Cache API refuses redirects.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok && !res.redirected) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put('/', clone));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Version probes (?_v=) must reach the network — otherwise the app compares
  // the cache against itself and can never notice it's running an old build.
  if (url.searchParams.has('_v')) {
    e.respondWith(fetch(request));
    return;
  }

  // Cache-first for static assets, refreshing the cache in the background.
  // ignoreVary: Vite tags its bundles `crossorigin`, so the page's request carries
  // an Origin header the precache request didn't. Any `Vary: Origin` on the
  // response (vite preview sends one) would then make the lookup miss offline.
  e.respondWith(
    caches.match(request, { ignoreVary: true }).then(cached => {
      const network = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      }).catch(err => {
        if (cached) return cached;
        throw err;
      });
      return cached || network;
    })
  );
});

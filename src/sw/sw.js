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

// ── Reminders (D25) ─────────────────────────────────────────────────────────
// Inlined from webpush-edge's sw.js (createPushHandler): this worker is a classic
// script, and module service workers aren't worth the risk on iOS (pwa-cloudflare skill).
// A push handler is required: iOS doesn't display Declarative Web Push on its own.
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }
  const n = data.notification || data;
  e.waitUntil(self.registration.showNotification(n.title || 'Bitebook', {
    body: n.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: n.tag || 'bitebook',
    data: { url: new URL(n.navigate || '/', self.location.origin).href },
  }));
});

// Opens the app on the screen the reminder points at (the timeline, for the nightly one).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || new URL('/', self.location.origin).href;
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) {
        if ('navigate' in w && w.url !== url) await w.navigate(url).catch(() => {});
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});

// Push services rotate endpoints; without this, reminders silently stop. The page also
// re-sends its subscription on every open, which covers a failure here.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const { key } = await (await fetch('/api/push/key')).json();
      const padded = (key + '='.repeat((4 - key.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(atob(padded), c => c.charCodeAt(0)),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch { /* the page re-subscribes on its next open */ }
  })());
});

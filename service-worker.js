/* AIhub Shop Desk — service worker
   - Caches ONLY the static shell (landing page, app page, manifest, icons). It never reads or writes IndexedDB/localStorage,
     backups, licenses or any user data, and it never caches anything outside SHELL.
   - Page loads are network-first (so a new version is picked up on the next open when online) and fall back to the
     cached page when offline or when the network is slow.
   - A new worker activates immediately but never reloads open pages and only deletes OUR OLD shell caches.
   All URLs are resolved against the worker's own scope, so it works under any sub-path (e.g. /my-repo/). */
const VERSION = 'v2';
const PREFIX = 'aihub-shop-desk-shell-';
const CACHE = PREFIX + VERSION;
const PAGES = ['', 'app/'];  /* landing page + app page */
const SHELL = ['manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
const NAV_TIMEOUT_MS = 3500;
const abs = p => new URL(p, self.registration.scope).href;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* the page itself MUST be cacheable, otherwise offline use would be broken: fail the install instead of half-working */
    await Promise.all(PAGES.map(p => cache.add(new Request(abs(p), { cache: 'reload' }))));
    await Promise.all(SHELL.map(async p => { try { const r = await fetch(new Request(abs(p), { cache: 'reload' })); if (r.ok) await cache.put(abs(p), r); } catch (err) { /* optional asset */ } }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* one cache key per page: ignore ?query/#hash, map /x/index.html and /x -> /x/ */
function pageKey(u) {
  const x = new URL(u); let p = x.pathname;
  if (p.endsWith('/index.html')) p = p.slice(0, -10);
  else if (!p.endsWith('/') && !/\.[a-z0-9]+$/i.test(p.split('/').pop())) p += '/';
  return x.origin + p;
}
async function navigate(req) {
  const cache = await caches.open(CACHE), key = pageKey(req.url);
  /* 'no-cache' = always revalidate with the server (cheap 304), so host-side HTTP caching (e.g. GitHub Pages max-age) can never pin an old version */
  const net = fetch(req.url, { cache: 'no-cache' }).then(async res => { if (res.ok && res.type === 'basic' && PAGES.some(p => abs(p) === key)) await cache.put(key, res.clone()); return res; });
  net.catch(() => {}); /* a late failure after the timeout is fine */
  try {
    return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), NAV_TIMEOUT_MS))]);
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    return net; /* nothing cached yet: wait for the network */
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (req.mode === 'navigate') { e.respondWith(navigate(req)); return; }
  const href = url.origin + url.pathname;
  if (SHELL.some(p => abs(p) === href)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE), hit = await cache.match(abs(href.slice(self.registration.scope.length)), { ignoreSearch: true });
      const refresh = fetch(req.url, { cache: 'no-cache' }).then(async res => { if (res.ok && res.type === 'basic') await cache.put(href, res.clone()); return res; });
      if (hit) { refresh.catch(() => {}); return hit; }
      return refresh;
    })());
  }
  /* everything else (anything not in SHELL) is left to the network — never cached */
});

/* Shop Desk — service worker (update-aware)
   Update model
   - BUILD is stamped by tools/stamp.py (content hash). Any content change => this file's bytes change => the browser
     installs a new worker. Without stamping, pages still update (network-first), only the in-app notice is less precise.
   - A NEW worker WAITS (no automatic skipWaiting) so a running app is never swapped under the user's hands. The page shows
     "new version ready"; the user (or the idle auto-apply rule in the page) sends SKIP_WAITING, then the page reloads once.
   - Navigations are network-first with a timeout. If the network was too slow and we answered from cache, the late response
     is compared with the cached copy and, when different, the clients are told (UPDATE_READY) — so a slow network no longer
     means "silently one visit behind".
   - Only the static shell is cached. User data (IndexedDB/localStorage), backups and licenses are never touched.
   All URLs are resolved against the worker's scope, so it works under any sub-path (GitHub Pages /repo/). */
const BUILD = '20261122.7f18d1';
const PREFIX = 'aihub-shop-desk-shell-';
const CACHE = PREFIX + BUILD;
const PAGES = ['', 'app/'];  /* landing page + app page */
const SHELL = ['manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
const NAV_TIMEOUT_MS = 3500;
const abs = p => new URL(p, self.registration.scope).href;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* the pages MUST be cacheable, otherwise offline use would be broken: fail the install instead of half-working */
    await Promise.all(PAGES.map(p => cache.add(new Request(abs(p), { cache: 'reload' }))));
    await Promise.all(SHELL.map(async p => { try { const r = await fetch(new Request(abs(p), { cache: 'reload' })); if (r.ok) await cache.put(abs(p), r); } catch (err) { /* optional asset */ } }));
    /* no skipWaiting here: the page decides when to switch (see SKIP_WAITING below) */
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  else if (d.type === 'GET_BUILD' && e.source) e.source.postMessage({ type: 'BUILD', build: BUILD });
});

async function tell(msg) { const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }); cs.forEach(c => c.postMessage(msg)); }

/* one cache key per page: ignore ?query/#hash, map /x/index.html and /x -> /x/ */
function pageKey(u) {
  const x = new URL(u); let p = x.pathname;
  if (p.endsWith('/index.html')) p = p.slice(0, -10);
  else if (!p.endsWith('/') && !/\.[a-z0-9]+$/i.test(p.split('/').pop())) p += '/';
  return x.origin + p;
}
async function digest(res) { const b = await res.arrayBuffer(); const h = new Uint8Array(await crypto.subtle.digest('SHA-1', b)); let s = ''; h.forEach(x => { s += x.toString(16).padStart(2, '0'); }); return s; }
async function differs(oldRes, newRes) {
  const a = oldRes.headers.get('etag'), b = newRes.headers.get('etag');
  if (a && b) return a !== b;
  try { return (await digest(oldRes.clone())) !== (await digest(newRes.clone())); } catch (err) { return false; }
}
async function navigate(req) {
  const cache = await caches.open(CACHE), key = pageKey(req.url), isPage = PAGES.some(p => abs(p) === key);
  let fellBack = false;
  /* 'no-cache' = always revalidate with the server (cheap 304), so host-side HTTP caching (GitHub Pages max-age=600) can never pin an old version.
     redirect:'manual' = a 301 (/app -> /app/) goes back to the browser as an opaque redirect (a followed redirect is rejected for navigations). */
  const net = fetch(req.url, { cache: 'no-cache', redirect: 'manual' }).then(async res => {
    if (res.ok && res.type === 'basic' && isPage) {
      const old = await cache.match(key);
      await cache.put(key, res.clone());
      if (fellBack && old && await differs(old, res.clone())) tell({ type: 'UPDATE_READY', reason: 'page-changed', build: BUILD });
    }
    return res;
  });
  net.catch(() => {}); /* a late failure after the timeout is fine */
  try {
    return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), NAV_TIMEOUT_MS))]);
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) { fellBack = true; return hit; }
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
  /* everything else (version.json included) is left to the network — never cached */
});

/* BAT offline support: the app, and anything you've already looked at, keep working with no signal. */
const VERSION = '11525c129f';
const SHELL_CACHE = 'bat-shell-' + VERSION, DATA_CACHE = 'bat-data-v1', DATA_MAX = 300;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png',
  './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];

self.addEventListener('install', e => {
  // cache:'reload' skips the HTTP cache, so a fresh deploy never installs a stale page
  e.waitUntil(caches.open(SHELL_CACHE).then(c =>
    c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys())
      if (k.startsWith('bat-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'activate-now') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'statsapi.mlb.com') e.respondWith(data(req));
  else if (url.origin === location.origin) e.respondWith(shell(req));
});

// The app itself comes from the cache, so it opens instantly, signal or not.
async function shell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const nav = req.mode === 'navigate';
  const hit = await cache.match(nav ? './index.html' : req, { ignoreSearch: nav });
  if (hit) return hit;
  try { return await fetch(req); }
  catch (err) { if (nav) return cache.match('./index.html'); throw err; }
}

// MLB data: fresh when online, the last copy when not. Copies served offline are
// marked with when they were fetched, so the app can say how old the scores are.
async function data(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const net = fetch(req); net.catch(() => {});   // a late failure after the timeout is expected
    const res = await within(net, 9000);
    if (res.ok) {
      const h = new Headers(res.headers); h.set('x-bat-fetched', String(Date.now()));
      await cache.put(req.url, new Response(await res.clone().arrayBuffer(), { status: 200, headers: h }));
      trim(cache);
    }
    return res;
  } catch (err) {
    // The schedule URL carries a date window, so it changes every day. Offline on a
    // later day, fall back to the newest schedule saved on any day.
    const hit = await cache.match(req.url) || await newest(cache, url => url.pathname.endsWith('/schedule'), req);
    if (!hit) throw err;
    const h = new Headers(hit.headers); h.set('x-bat-offline', hit.headers.get('x-bat-fetched') || '1');
    return new Response(await hit.arrayBuffer(), { status: 200, headers: h });
  }
}
async function newest(cache, test, req) {
  if (!test(new URL(req.url))) return null;
  let best = null, at = -1;
  for (const k of await cache.keys()) {
    if (!test(new URL(k.url))) continue;
    const r = await cache.match(k), t = +(r.headers.get('x-bat-fetched') || 0);
    if (t > at) { at = t; best = r; }
  }
  return best;
}
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - DATA_MAX))) await cache.delete(k);
}

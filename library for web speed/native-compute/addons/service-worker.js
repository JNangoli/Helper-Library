/* native-compute service worker: instant repeat visits and offline start for single-page apps.
   Copy this file to your PUBLIC folder (it must be served from the site root, e.g. /service-worker.js),
   then call registerServiceWorker() from the app. Plain script: it is not bundled.

   Strategy (deliberately conservative, so users never get stuck on an old version):
   - Pages: network first. If the network is slower than 3 s or offline, the last saved app shell is used.
   - Built files with a content hash in their name (/static/... in Create React App, /assets/... in Vite):
     cache first. Their name changes whenever their content does, so caching them forever is safe.
   - Everything else (APIs, other sites, unhashed files): not touched, straight to the network.
   - A new version waits until the app asks it to take over (registerServiceWorker's onUpdate). */

const VERSION = 'v1'; // change only when you change THIS file
const SHELL = `nc-shell-${VERSION}`;
const ASSETS = `nc-assets-${VERSION}`;
const SHELL_URL = '/index.html';
const NETWORK_TIMEOUT_MS = 3000;

const isHashedAsset = (url) =>
  /^\/(static|assets)\//.test(url.pathname) && /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(url.pathname);

self.addEventListener('install', () => {
  // Nothing to precache: the shell is saved on the first successful page load.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL, ASSETS];
      for (const key of await caches.keys()) if (key.startsWith('nc-') && !keep.includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'NC_SKIP_WAITING') self.skipWaiting();
});

async function page(request) {
  const cache = await caches.open(SHELL);
  const network = fetch(request).then((response) => {
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      cache.put(SHELL_URL, response.clone());
    }
    return response;
  });
  network.catch(() => {}); // if the saved shell answered first, a later network failure is fine
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const fast = await Promise.race([network, timeout]);
    if (fast) return fast;
    const saved = await cache.match(SHELL_URL);
    return saved ?? (await network); // slow network and nothing saved yet: keep waiting
  } catch {
    const saved = await cache.match(SHELL_URL);
    return saved ?? new Response('<h1>You are offline</h1>', { status: 503, headers: { 'content-type': 'text/html' } });
  }
}

async function asset(request) {
  const cache = await caches.open(ASSETS);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') event.respondWith(page(request));
  else if (isHashedAsset(url)) event.respondWith(asset(request));
});

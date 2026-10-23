// Register the service worker (addons/service-worker.js, copied to your public folder).
//
//   registerServiceWorker({
//     onUpdate: ({ apply }) => showToast('New version available', { action: 'Refresh', onClick: apply }),
//   });
//
// Only runs on HTTPS or localhost, and you should only call it in production builds.

export function registerServiceWorker({ url = '/service-worker.js', onUpdate } = {}) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  if (window.location.protocol !== 'https:' && !local) return;

  const register = async () => {
    const registration = await navigator.serviceWorker.register(url);
    const announce = (worker) =>
      onUpdate?.({
        // Take over now and reload once, so the page and its files are from the same version.
        apply: () => worker.postMessage('NC_SKIP_WAITING'),
      });
    if (registration.waiting && navigator.serviceWorker.controller) announce(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
      });
    });
    // Check for a new version when the user comes back to the tab.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  };

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/** Emergency off switch: removes the service worker and its caches (e.g. ship this if something goes wrong). */
export async function unregisterServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  for (const key of await caches.keys()) if (key.startsWith('nc-')) await caches.delete(key);
}

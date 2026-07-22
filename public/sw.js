const CACHE_PREFIX = "usage-monitor-";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Intentionally no fetch handler: authenticated pages, API responses, usage,
// billing, and receipt state must never be cached or served stale.

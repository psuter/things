const CACHE_NAME = "magellan-terrain-offline-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add("./isometric.html")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith("magellan-terrain-offline-") && name !== CACHE_NAME).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-terrain-editor" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((value) => typeof value === "string" && new URL(value, self.location.origin).origin === self.location.origin);
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(urls.map((url) => cache.add(url).catch(() => undefined)))));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") return (await caches.match("./isometric.html")) ?? Response.error();
    return Response.error();
  }));
});

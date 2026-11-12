// Service worker: keeps the app playable offline.
//
// - Files under assets/ have content hashes in their names, so they never
//   change: served from the cache first.
// - Everything else (the page, the manifest, the model) may change at the
//   same URL: fetched from the network first, falling back to the cache
//   when offline, and the cache is refreshed on every successful fetch.
//
// At install, the page, the scripts and styles it references, the engine's
// WebAssembly file (named inside the main script) and the model are
// fetched, so one visit online is enough to play offline afterwards.

const CACHE = "backgammon-v1";
const BASE = new URL("./", self.location).href;

self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const page = await fetch(BASE, { cache: "reload" });
      const html = await page.clone().text();
      const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
        .map((m) => new URL(m[1], BASE).href)
        .filter((url) => url.startsWith(BASE));

      // The WebAssembly file is loaded by the main script, not the page.
      const wasm = [];
      for (const script of assets.filter((url) => url.endsWith(".js"))) {
        const code = await (await fetch(script)).text();
        // Quoted with ', " or ` (Vite emits template strings).
        for (const m of code.matchAll(/["'`]([\w./-]+\.wasm)["'`]/g)) wasm.push(new URL(m[1], script).href);
        // Workers (the match analysis) are separate scripts named in the
        // main one, with their own copy of the engine's loader.
        for (const m of code.matchAll(/["'`]([\w.-]+-worker-[\w-]+\.js)["'`]/g)) {
          const worker = new URL(m[1], script).href;
          wasm.push(worker);
          const workerCode = await (await fetch(worker)).text();
          for (const w of workerCode.matchAll(/["'`]([\w./-]+\.wasm)["'`]/g)) wasm.push(new URL(w[1], worker).href);
        }
      }

      await cache.put(BASE, page);
      await cache.addAll([...new Set([...assets, ...wasm, new URL("models/network.onnx", BASE).href])]);
      await self.skipWaiting();
    })(),
  ),
);

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  ),
);

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch {
    return (await cache.match(key, { ignoreVary: true })) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  // Ignore Vary: scripts are requested with an Origin header (modules,
  // workers) but were cached at install without one.
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith(BASE)) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, BASE));
  } else if (new URL(request.url).pathname.includes("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request, request));
  }
});

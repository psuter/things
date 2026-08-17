const CACHE = 'flagwise-v15'
const BASE = new URL('./', self.location).pathname
const asset = path => `${BASE}${path}`
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE)
  const [htmlResponse, flagAssets] = await Promise.all([
    fetch(BASE),
    fetch(asset('flag-assets.json')).then(response => response.json())
  ])
  const html = await htmlResponse.clone().text()
  const shellAssets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
    .map(match => match[1])
    .filter(url => url.startsWith('/'))
  await cache.put(BASE, htmlResponse)
  await cache.addAll([...new Set([asset('manifest.webmanifest'), asset('favicon.svg'), asset('flag-assets.json'), asset('countries.geojson'), ...shellAssets, ...flagAssets.map(asset)])])
  self.skipWaiting()
})()))
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys()
  await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))
  self.clients.claim()
})()))
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => {
    const copy = response.clone()
    caches.open(CACHE).then(cache => cache.put(event.request, copy))
    return response
  }).catch(() => caches.match(BASE))))
})

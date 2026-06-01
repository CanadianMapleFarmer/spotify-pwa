const CACHE_NAME = "spotify-tv-v36";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js?v=42",
  "/manifest.webmanifest",
  "/public/icons/spotify-logo.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  // Never intercept media: passing ranged video/audio requests through the SW
  // breaks Chromium's demuxer (DEMUXER_ERROR_COULD_NOT_OPEN). Let the browser
  // handle range requests natively.
  if (request.headers.has("range") || request.destination === "video" || request.destination === "audio") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  // App shell (HTML + JS/CSS) is network-first so a broken cached bundle can
  // never strand the app: while online we always pull fresh code and only fall
  // back to cache when offline. Other same-origin assets stay cache-first.
  const isShell =
    request.mode === "navigate" ||
    (sameOrigin && /\.(?:js|css|webmanifest)$/.test(url.pathname));

  if (isShell) {
    event.respondWith(
      // `no-store` makes network-first actually hit the network instead of a
      // possibly-stale HTTP-cached shell, so fresh code always wins online.
      fetch(request, { cache: "no-store" })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html")))
    );
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});

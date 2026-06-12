const CACHE_NAME = "spotify-tv-v46";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css?v=45",
  // The entry module is referenced from index.html with a cache-busting query,
  // so precache it under that exact URL. Its sub-module imports are plain
  // unversioned paths (import statements carry no query string), so they are
  // precached without one — the network-first shell strategy below keeps them
  // fresh while online and these entries serve as the offline fallback.
  "/js/main.js?v=50",
  "/js/api.js",
  "/js/auth.js",
  "/js/cards.js",
  "/js/config.js",
  "/js/diagnostics.js",
  "/js/dom.js",
  "/js/focus.js",
  "/js/player.js",
  "/js/queue.js",
  "/js/shell.js",
  "/js/state.js",
  "/js/track-menu.js",
  "/js/utils.js",
  "/js/ambient/index.js",
  "/js/ambient/palette.js",
  "/js/ambient/room.js",
  "/js/ambient/scene.js",
  "/js/ambient/visualizer.js",
  "/js/views/artist.js",
  "/js/views/collection.js",
  "/js/views/home.js",
  "/js/views/library.js",
  "/js/views/now.js",
  "/js/views/search.js",
  "/js/views/settings.js",
  "/manifest.webmanifest",
  "/public/icons/spotify-logo.png",
  "/public/icons/icon-192.png",
  "/public/icons/icon-512.png",
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
  // Never intercept cross-origin requests (artwork CDN, fonts, Spotify SDK):
  // we don't cache them, and a pass-through respondWith turns any fetch hiccup
  // into a hard failure ("ServiceWorker encountered an unexpected error" →
  // corrupt images, notably on Firefox). Let the browser handle them natively.
  if (!sameOrigin) return;
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

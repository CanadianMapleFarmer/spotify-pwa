const CACHE_NAME = "spotify-tv-v34";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js?v=41",
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
  if (event.request.method !== "GET") return;
  // Never intercept media: passing ranged video/audio requests through the SW
  // breaks Chromium's demuxer (DEMUXER_ERROR_COULD_NOT_OPEN). Let the browser
  // handle range requests natively.
  const { request } = event;
  if (request.headers.has("range") || request.destination === "video" || request.destination === "audio") return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});

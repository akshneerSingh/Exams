/* Offline-Cache für die App-Hülle.
   Bei jeder Änderung an index.html oder quiz.html die VERSION erhöhen,
   sonst liefert das iPhone weiter die alte Fassung aus dem Cache. */
const VERSION = "v6";
const CACHE = "pruefungen-" + VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./quiz.html",
  "./sync.js",
  "./config.js",
  "./content/index.json",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  /* Prüfungslisten und -dateien immer frisch holen, sonst kommt beim
     Synchronisieren ewig die alte Liste zurück. Ohne Netz aus dem Cache. */
  if (url.pathname.includes("/exams/") || url.pathname.includes("/content/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  /* App-Hülle: erst Cache, dann Netz. */
  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((response) => {
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match("./index.html")))
  );
});

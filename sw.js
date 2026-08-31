/* ============================================================================
   Offline-Betrieb.

   Wichtige Änderung gegenüber früher: die App-Dateien werden zuerst aus dem
   Netz geholt und nur als Rückfallebene aus dem Zwischenspeicher. Vorher war
   es umgekehrt, und das hatte eine unangenehme Folge — nach dem Hochladen
   einer neuen Fassung sah man beim Neuladen weiterhin die alte, weil die
   neue erst im Hintergrund installiert wurde und frühestens beim übernächsten
   Öffnen zum Zug kam.

   Ohne Netz ändert sich nichts: dann greift der Zwischenspeicher wie bisher.
   ========================================================================== */

const VERSION = "v47";
const CACHE = "pruefungen-" + VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./quiz.html",
  "./sync.js",
  "./config.js",
  "./admin.js",
  "./404.html",
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
      /* Offene Seiten sofort auf die neue Fassung heben, statt sie bis zum
         nächsten Öffnen auf dem alten Stand stehen zu lassen. */
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => clients.forEach((client) => client.navigate(client.url)))
      .catch(() => {})
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  /* Alles aus dem Netz, mit dem Zwischenspeicher als Netz-Ersatz. Was
     ankommt, wird für den nächsten Ausfall abgelegt. */
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)
        .then((hit) => hit || caches.match("./index.html")))
  );
});

// App files are fetched network-first and pictures have content-hashed names, so updates
// show without a bump. Bump VERSION to clear out old cached files after big changes.
const VERSION = "v2";
const CACHE = `word-finder-${VERSION}`;

const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "data/words.json",
  "data/credits.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })));
      // Also store every word picture so the whole dictionary works offline.
      // A missing picture shouldn't stop the install: the app falls back to emoji.
      try {
        const words = await (await cache.match("data/words.json")).json();
        const images = words.map((w) => w.image).filter(Boolean);
        await Promise.allSettled(images.map((src) => cache.add(src)));
      } catch {}
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("word-finder-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;

  // Pictures rarely change: cache first, filling the cache as we go.
  if (req.destination === "image") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  // Pages, code and the word list: network first so updates show up straight away,
  // the cached copy when offline.
  event.respondWith(
    (async () => {
      try {
        // no-cache: always check with the server rather than the browser's HTTP cache.
        const res = await fetch(req, { cache: "no-cache" });
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (
          (await caches.match(req, { ignoreSearch: true })) ||
          (req.mode === "navigate" ? caches.match("index.html") : Response.error())
        );
      }
    })(),
  );
});

// App shell offline. Music files are cached by the app itself (Cache API), not here.
const VERSION = "tarab-shell-v14";
const SHELL = [
  "./",
  "index.html",
  "styles.css?v=14",
  "js/main.js?v=14",
  "js/data.js",
  "js/media.js",
  "js/player.js",
  "js/lyrics.js",
  "js/config.js",
  "vendor/supabase.js",
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/avatar.jpg",
  "img/auth.jpg",
  "fonts/urbanist-latin-wght-normal.woff2",
  "fonts/urbanist-latin-ext-wght-normal.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("tarab-shell-") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin !== location.origin) return;

  // pages: network first so updates arrive, cache when offline
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(VERSION).then((c) => c.put("index.html", res.clone()));
          return res;
        })
        .catch(() => caches.match("index.html"))
    );
    return;
  }

  // static files: cache, refresh in background
  e.respondWith(
    caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res.ok) c.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});

/* Vigilfall service worker: the game shell is served network-first (so a new build is picked up on the next load)
   with the cached copy as an offline fallback; fonts and icons are cached on first use. */
const VERSION = "vf-1.28.3";
const SHELL = ["./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin && (url.pathname.endsWith("/") || url.pathname.endsWith("index.html") || url.pathname.endsWith(".webmanifest") || url.pathname.endsWith(".png"));
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (isShell) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("./index.html"))),
    );
  } else if (isFont) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => (caches.open(VERSION).then((c) => c.put(req, res.clone())), res))));
  }
});
self.addEventListener("message", (e) => e.data === "skip" && self.skipWaiting());

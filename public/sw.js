// Service worker: lets Grimoire open offline. Network-first for the app shell (so edits always
// show up when online), cache fallback when offline. API calls are never cached — the app's own
// offline queue handles data.
const CACHE = "grimoire-shell-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/quickadd.js", "/theme-boot.js", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Same-origin only: cross-origin requests (Google Fonts) go straight to the browser, since the
  // page's CSP (connect-src 'self') would block the worker from fetching them itself.
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // live data only

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("/index.html") : Response.error()))),
  );
});

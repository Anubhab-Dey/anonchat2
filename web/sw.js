const CACHE_NAME = "anonchat-static-v9";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/config.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/modules/state.js",
  "/modules/dom.js",
  "/modules/toast.js",
  "/modules/local-db.js",
  "/modules/device-session.js",
  "/modules/wire.js",
  "/modules/auth.js",
  "/modules/backup.js",
  "/modules/crypto-box.js",
  "/modules/conversations.js",
  "/modules/rooms.js",
  "/modules/direct.js",
  "/modules/calls.js",
  "/modules/call-p2p.js",
  "/modules/call-relay.js",
  "/modules/call-backend-relay.js",
  "/modules/files.js",
  "/modules/notifications.js",
  "/modules/ui.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/ws")) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) {
          client.focus();
          return;
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

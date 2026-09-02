importScripts("/flamelearning/controller/controller.sw.js");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
  try {
    if ($scramjetController.shouldRoute(event)) {
      event.respondWith($scramjetController.route(event));
    }
  } catch (error) {
    console.error("[FlameBrowser SW] routing error", error);
  }
});

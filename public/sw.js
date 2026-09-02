const BASE = "/flamelearning/";

self.addEventListener("install", event => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });

try { importScripts(BASE + "controller-public/controller.sw.js"); } catch (e) {
  console.error("[FlameBrowser SW] controller load failed", e);
}

importScripts("/flamelearning/controller-public/controller.sw.js");

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(self.clients.claim());
});

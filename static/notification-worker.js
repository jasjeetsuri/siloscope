"use strict";

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch {}
  const destination = payload.url === "/?view=playing" ? payload.url : "/?view=system";
  event.waitUntil(self.registration.showNotification(payload.title || "Siloscope", {
    body: payload.body || "A new Siloscope alert is available.",
    icon: "/icon-192.png?v=icon16-20260908-r1",
    tag: payload.tag || "siloscope",
    data: { url: destination },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url === "/?view=playing" ? "/?view=playing" : "/?view=system", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      const navigated = await client.navigate(destination);
      if (navigated) { await navigated.focus(); return; }
    }
    await self.clients.openWindow(destination);
  })());
});
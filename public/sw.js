// Service worker: SOLO recibe notificaciones push y abre el panel al tocarlas.
//
// No tiene manejador `fetch` a propósito: no cachea nada. Un service worker
// que cachea sirve versiones viejas del panel después de un despliegue, y
// este panel cambia seguido. La entrega y el diseño están en
// sql/2026-10-14_34_notificaciones_push.sql y en brain/04-features/notifications.md.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { cuerpo: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.titulo || "Seguimiento", {
    body: d.cuerpo || "",
    // Mismo tag = reemplaza en vez de apilar (un reintento no duplica).
    tag: d.tag || undefined,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const ws = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const abierta = ws.find(w => new URL(w.url).origin === self.location.origin);
    if (abierta) return abierta.focus();
    return self.clients.openWindow(url);
  })());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Tournament Control", body: "มีข้อมูลการแข่งขันเผยแพร่ใหม่" };
  }
  const title = payload.title || "Tournament Control";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || "มีข้อมูลการแข่งขันเผยแพร่ใหม่",
    tag: payload.tag || "ctwe-publication",
    data: {
      url: payload.url || "/cards",
      eventType: payload.eventType,
    },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/cards";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if ("navigate" in client) await client.navigate(target);
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    if (!event.oldSubscription) return;
    const applicationServerKey = event.oldSubscription.options.applicationServerKey;
    if (!applicationServerKey) return;
    const subscription = event.newSubscription || await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    const authResponse = await fetch("/api/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!authResponse.ok) return;
    const auth = await authResponse.json();
    await fetch("/api/public/push/subscriptions/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": auth.csrfToken,
      },
      body: JSON.stringify({
        oldEndpoint: event.oldSubscription.endpoint,
        subscription: subscription.toJSON(),
      }),
    });
  })());
});

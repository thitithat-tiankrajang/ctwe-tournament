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

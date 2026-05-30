const DASHBOARD_URL = "/dashboard.html";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const dashboardClient = clients.find((client) => {
        return client.url.includes(DASHBOARD_URL);
      });

      if (dashboardClient) {
        return dashboardClient.focus();
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(DASHBOARD_URL);
      }

      return undefined;
    })
  );
});

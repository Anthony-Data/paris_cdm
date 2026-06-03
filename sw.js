const CACHE = 'cdm2026-v3';
const ASSETS = ['./index.html', './logo.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ===== PUSH depuis le serveur Vercel =====
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}

  const title = data.title || '⚽ CdM 2026';
  const options = {
    body: data.body || 'Rappel de match — donne ton prono !',
    icon: './logo.png',
    badge: './logo.png',
    tag: data.tag || 'cdm-match',
    vibrate: [300, 150, 300],
    requireInteraction: true,
    data: { url: self.registration.scope },
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ===== Clic sur la notification → ouvre l'app =====
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url === url);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

// ===== Notification locale (depuis la page principale) =====
self.addEventListener('message', e => {
  if (e.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = e.data;
    self.registration.showNotification(title, {
      body,
      icon: './logo.png',
      tag: tag || 'cdm',
      vibrate: [300, 150, 300],
      requireInteraction: true,
    });
  }
});

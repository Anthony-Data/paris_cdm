const CACHE = 'cdm2026-v1';
const ASSETS = ['./index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// Receive scheduled notification from main thread
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SCHEDULE_NOTIF') {
    const { matchId, team1, team2, flag1, flag2, delayMs, playerName, rank, pts } = e.data;
    if (delayMs <= 0) return;
    setTimeout(() => {
      self.registration.showNotification(
        `⚽ ${flag1} ${team1} vs ${team2} ${flag2}`,
        {
          body: `${playerName ? playerName + ', donne' : 'Donne'} ton prono avant le coup d\'envoi ! Classement : #${rank} (${pts}pts)`,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚽</text></svg>',
          tag: matchId,
          vibrate: [300, 150, 300],
          requireInteraction: true,
          data: { matchId }
        }
      );
    }, delayMs);
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    if (list.length) return list[0].focus();
    return clients.openWindow('./');
  }));
});

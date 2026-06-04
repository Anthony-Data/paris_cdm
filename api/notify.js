const webpush = require('web-push');
const admin = require('firebase-admin');

// ── Firebase Admin (singleton, compatible warm restart Vercel) ──────────────
function getDB() {
  if (!admin.apps.length) {
    let serviceAccount;
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    } catch {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      serviceAccount = JSON.parse(raw);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

// ── Config VAPID ────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@paris-cdm.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Handler principal ───────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // 1. Auth : Vercel cron → Authorization: Bearer, fallback x-cron-secret ou ?secret=
  // 1. Variables d'environnement requises
  const missing = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_DATABASE_URL']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: `Variables manquantes : ${missing.join(', ')}` });
  }

  try {
    const db = getDB();
    const now = new Date();

    // 3. Lecture Firebase (matches + subscriptions + notifs déjà envoyées)
    const [sharedSnap, subsSnap, sentSnap] = await Promise.all([
      db.ref('cdm2026/shared').once('value'),
      db.ref('cdm2026/subscriptions').once('value'),
      db.ref('cdm2026/notifsSent').once('value'),
    ]);

    const shared = sharedSnap.val() || {};
    const subscriptions = subsSnap.val() || {};
    const notifsSent = sentSnap.val() || {};

    // Firebase peut retourner un objet à clés numériques au lieu d'un tableau
    const rawMatches = shared.matches;
    const matches = Array.isArray(rawMatches) ? rawMatches : Object.values(rawMatches || {});
    const pronos = shared.pronos || {};

    // 4. Sélection des matchs : ceux dont la marque "1h avant" vient de passer
    //    (entre 0 et 7 min après l'heure de notif) et pas encore notifiés.
    //    → La notif arrive toujours à ~1h avant le match, indépendamment du cron.
    //    Le cron tourne toutes les 5 min ; fenêtre 7 min couvre le pire cas.
    const WINDOW_MS = 7 * 60 * 1000;  // jusqu'à 7 min après la marque 1h
    const EARLY_MS  = 2 * 60 * 1000;  // tolère 2 min d'avance (appel client ou drift horloge)
    const targetMatches = matches.filter(m => {
      if (m.status !== 'upcoming') return false;
      if (notifsSent[m.id]) return false; // déjà envoyé
      const notifAt = new Date(m.date).getTime() - 60 * 60 * 1000; // pile 1h avant
      const msSince = now - notifAt;
      return msSince >= -EARLY_MS && msSince < WINDOW_MS;
    });

    const subCount = Object.keys(subscriptions).length;

    if (!targetMatches.length) {
      return res.json({
        sent: 0,
        subscribers: subCount,
        message: 'Aucun match à notifier maintenant',
        checked: now.toISOString(),
      });
    }

    // 5. Dédupliquer : 1 seul abonnement par joueur (le plus récent)
    const bestSubPerPlayer = {};
    for (const [subKey, subData] of Object.entries(subscriptions)) {
      const pid = subData.playerId || subKey;
      const existing = bestSubPerPlayer[pid];
      if (!existing || (subData.updatedAt || 0) > (existing.updatedAt || 0)) {
        bestSubPerPlayer[pid] = { ...subData, playerId: pid, _subKey: subKey };
      }
    }

    // 6. Envoi
    let sent = 0;
    let skipped = 0;
    let removed = 0;

    for (const match of targetMatches) {
      // Transaction atomique : seul le premier appelant concurrent gagne le lock
      const sentRef = db.ref(`cdm2026/notifsSent/${match.id}`);
      const txResult = await sentRef.transaction(current => current ? undefined : now.toISOString());
      if (!txResult.committed) { skipped++; continue; } // déjà envoyé par un autre appel concurrent

      for (const subData of Object.values(bestSubPerPlayer)) {
        if (pronos[match.id]?.[subData.playerId]) { skipped++; continue; }

        const payload = JSON.stringify({
          title: `⚽ ${match.flag1 || ''} ${match.team1} vs ${match.team2} ${match.flag2 || ''}`,
          body: `${subData.playerName ? subData.playerName + ', n' : 'N'}'oublie pas ton prono pour le match ${match.team1} vs ${match.team2} !`,
          tag: match.id,
        });

        try {
          await webpush.sendNotification(subData.subscription, payload);
          sent++;
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await db.ref(`cdm2026/subscriptions/${subData._subKey}`).remove();
            removed++;
          }
        }
      }
    }

    return res.json({
      sent,
      skipped,
      removed,
      subscribers: subCount,
      matches: targetMatches.map(m => `${m.team1} vs ${m.team2} @ ${new Date(m.date).toISOString()}`),
    });

  } catch (e) {
    console.error('ERREUR notify:', e);
    return res.status(500).json({
      error: e.message,
      hint: e.message.includes('private_key')
        ? 'Problème avec FIREBASE_SERVICE_ACCOUNT — essaie la méthode base64'
        : 'Vérifie les logs Vercel',
    });
  }
};

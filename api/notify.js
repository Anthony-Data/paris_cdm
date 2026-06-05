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

// urgency:high = APNS priority 10 → livraison immédiate même écran verrouillé
const PUSH_OPTS = { urgency: 'high', TTL: 3600 };

// ── Config VAPID ────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@paris-cdm.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Handler principal ───────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const missing = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_DATABASE_URL']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: `Variables manquantes : ${missing.join(', ')}` });
  }

  try {
    const db = getDB();
    const subsSnap = await db.ref('cdm2026/subscriptions').once('value');
    const subscriptions = subsSnap.val() || {};
    const subCount = Object.keys(subscriptions).length;

    // ── Mode test forcé (?force=1) : push immédiat vers tous les abonnés ──────
    if (req.query.force === '1') {
      const payload = JSON.stringify({
        title: '⚽ CdM 2026 — Test push serveur',
        body: 'Si tu vois cette notification, le push serveur fonctionne !',
        tag: 'server_test',
      });
      let sent = 0, removed = 0, failed = 0;
      const removals = [];
      for (const [subKey, subData] of Object.entries(subscriptions)) {
        if (!subData.subscription) continue;
        try {
          await webpush.sendNotification(subData.subscription, payload, PUSH_OPTS);
          sent++;
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            removals.push(db.ref(`cdm2026/subscriptions/${subKey}`).remove());
            removed++;
          } else { failed++; }
        }
      }
      if (removals.length) await Promise.all(removals);
      return res.json({ mode: 'force_test', sent, removed, failed, subscribers: subCount });
    }

    const now = new Date();

    // Lecture Firebase (matches + notifs déjà envoyées)
    const [sharedSnap, sentSnap] = await Promise.all([
      db.ref('cdm2026/shared').once('value'),
      db.ref('cdm2026/notifsSent').once('value'),
    ]);

    const shared = sharedSnap.val() || {};
    const notifsSent = sentSnap.val() || {};

    // Firebase peut retourner un objet à clés numériques au lieu d'un tableau
    const rawMatches = shared.matches;
    const matches = Array.isArray(rawMatches) ? rawMatches : Object.values(rawMatches || {});
    const pronos = shared.pronos || {};

    // Sélection des matchs : fenêtre [-2 min, +7 min] autour de la marque 1h avant.
    // Le cron tourne toutes les 5 min ; fenêtre 7 min couvre le pire cas.
    const WINDOW_MS = 7 * 60 * 1000;
    const EARLY_MS  = 2 * 60 * 1000;
    const targetMatches = matches.filter(m => {
      if (m.status !== 'upcoming') return false;
      if (notifsSent[m.id]) return false;
      const notifAt = new Date(m.date).getTime() - 60 * 60 * 1000;
      const msSince = now - notifAt;
      return msSince >= -EARLY_MS && msSince < WINDOW_MS;
    });

    if (!targetMatches.length) {
      return res.json({
        sent: 0,
        subscribers: subCount,
        message: 'Aucun match à notifier maintenant',
        checked: now.toISOString(),
      });
    }

    let sent = 0, skipped = 0, removed = 0;

    for (const match of targetMatches) {
      // Transaction atomique : seul le premier appelant concurrent gagne le lock
      const sentRef = db.ref(`cdm2026/notifsSent/${match.id}`);
      const txResult = await sentRef.transaction(current => current ? undefined : now.toISOString());
      if (!txResult.committed) { skipped++; continue; }

      // Envoyer à TOUS les appareils abonnés (iPhone + PC + Android, etc.)
      // Chaque appareil a sa propre subscription — pas de dedup par joueur.
      for (const [subKey, subData] of Object.entries(subscriptions)) {
        if (!subData.subscription) { skipped++; continue; }
        if (pronos[match.id]?.[subData.playerId]) { skipped++; continue; }

        const payload = JSON.stringify({
          title: `⚽ ${match.flag1 || ''} ${match.team1} vs ${match.team2} ${match.flag2 || ''}`,
          body: `${subData.playerName ? subData.playerName + ', n' : 'N'}'oublie pas ton prono pour le match ${match.team1} vs ${match.team2} !`,
          tag: match.id,
        });

        try {
          await webpush.sendNotification(subData.subscription, payload, PUSH_OPTS);
          sent++;
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await db.ref(`cdm2026/subscriptions/${subKey}`).remove();
            removed++;
          } else { skipped++; }
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

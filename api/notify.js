const webpush = require('web-push');
const admin = require('firebase-admin');

// ── Firebase Admin (singleton, compatible warm restart Vercel) ──────────────
function getDB() {
  if (!admin.apps.length) {
    let serviceAccount;
    try {
      // Tente d'abord le décodage base64 (méthode recommandée)
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    } catch {
      // Sinon, parse JSON direct (avec fix des \n dans private_key)
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
  // 1. Vérification du secret
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Non autorisé — mauvais secret' });
  }

  // 2. Vérification des variables d'environnement
  const missing = ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','FIREBASE_SERVICE_ACCOUNT','FIREBASE_DATABASE_URL','CRON_SECRET']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: `Variables manquantes : ${missing.join(', ')}` });
  }

  try {
    const db = getDB();

    // 3. Lecture Firebase
    const [sharedSnap, subsSnap] = await Promise.all([
      db.ref('cdm2026/shared').once('value'),
      db.ref('cdm2026/subscriptions').once('value'),
    ]);

    const shared = sharedSnap.val() || {};
    const subscriptions = subsSnap.val() || {};
    const matches = shared.matches || [];
    const pronos = shared.pronos || {};
    const now = new Date();

    // 4. Matchs qui commencent dans 50–70 min
    const targetMatches = matches.filter(m => {
      if (m.status !== 'upcoming') return false;
      const mins = (new Date(m.date) - now) / 60000;
      return mins >= 50 && mins <= 70;
    });

    const subCount = Object.keys(subscriptions).length;

    if (!targetMatches.length) {
      return res.json({
        sent: 0,
        subscribers: subCount,
        message: 'Aucun match dans la fenêtre 50–70 min',
        checked: now.toISOString(),
      });
    }

    // 5. Envoi des push
    let sent = 0;
    let skipped = 0;
    let removed = 0;

    for (const match of targetMatches) {
      for (const [playerId, subData] of Object.entries(subscriptions)) {
        // playerId peut être dans subData.playerId (nouveau format) ou la clé elle-même (ancien format)
        const pid = subData.playerId || playerId;
        if (pronos[match.id]?.[pid]) { skipped++; continue; }

        const payload = JSON.stringify({
          title: `⚽ ${match.flag1 || ''} ${match.team1} vs ${match.team2} ${match.flag2 || ''}`,
          body: `${subData.playerName || 'Hey'}, donne ton prono avant le coup d'envoi !`,
          tag: match.id,
        });

        try {
          await webpush.sendNotification(subData.subscription, payload);
          sent++;
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await db.ref(`cdm2026/subscriptions/${playerId}`).remove();
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
      matches: targetMatches.map(m => `${m.team1} vs ${m.team2}`),
    });

  } catch (e) {
    console.error('ERREUR notify:', e);
    return res.status(500).json({
      error: e.message,
      hint: e.message.includes('private_key')
        ? 'Problème avec FIREBASE_SERVICE_ACCOUNT — essaie la méthode base64 ci-dessous'
        : 'Vérifie les logs Vercel pour plus de détails',
    });
  }
};

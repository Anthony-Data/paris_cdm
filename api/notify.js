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
  // Vercel cron envoie : Authorization: Bearer <CRON_SECRET>
  // Fallback : header x-cron-secret ou ?secret= (cron externe)
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const secret = bearerToken || req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Non autorisé — mauvais secret' });
  }

  // 2. Vérification des variables d'environnement (CRON_SECRET exclu : optionnel)
  const missing = ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','FIREBASE_SERVICE_ACCOUNT','FIREBASE_DATABASE_URL']
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
    // Firebase peut retourner un objet à clés numériques au lieu d'un tableau
    const rawMatches = shared.matches;
    const matches = Array.isArray(rawMatches) ? rawMatches : Object.values(rawMatches || {});
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

    // 5. Dédupliquer : 1 seul abonnement par joueur (le plus récent)
    //    Évite les doublons Safari + PWA sur le même téléphone
    const bestSubPerPlayer = {};
    for (const [subKey, subData] of Object.entries(subscriptions)) {
      const pid = subData.playerId || subKey;
      const existing = bestSubPerPlayer[pid];
      if (!existing || (subData.updatedAt || 0) > (existing.updatedAt || 0)) {
        bestSubPerPlayer[pid] = { ...subData, playerId: pid, _subKey: subKey };
      }
    }

    // 6. Envoi des push (1 par joueur max)
    let sent = 0;
    let skipped = 0;
    let removed = 0;

    for (const match of targetMatches) {
      for (const subData of Object.values(bestSubPerPlayer)) {
        if (pronos[match.id]?.[subData.playerId]) { skipped++; continue; }

        const payload = JSON.stringify({
          title: `⚽ ${match.flag1 || ''} ${match.team1} vs ${match.team2} ${match.flag2 || ''}`,
          body: `${subData.playerName ? subData.playerName + ', n' : 'N'}’oublie pas ton prono pour le match ${match.team1} vs ${match.team2} !`,
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

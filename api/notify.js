const webpush = require('web-push');
const admin = require('firebase-admin');

// Init Firebase Admin (singleton)
let firebaseApp;
function getDB() {
  if (!firebaseApp) {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      ),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

// Config VAPID
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@example.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async (req, res) => {
  // Sécurité : vérifier le secret cron
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const db = getDB();
    const [sharedSnap, subsSnap] = await Promise.all([
      db.ref('cdm2026/shared').once('value'),
      db.ref('cdm2026/subscriptions').once('value'),
    ]);

    const shared = sharedSnap.val() || {};
    const subscriptions = subsSnap.val() || {};

    const matches = shared.matches || [];
    const pronos = shared.pronos || {};
    const now = new Date();

    // Matchs qui commencent dans 50 à 70 minutes
    // (fenêtre large pour couvrir le cron toutes les 30 min)
    const upcomingMatches = matches.filter(m => {
      if (m.status !== 'upcoming') return false;
      const matchTime = new Date(m.date);
      const minutesUntil = (matchTime - now) / 60000;
      return minutesUntil >= 50 && minutesUntil <= 70;
    });

    if (!upcomingMatches.length) {
      return res.json({ sent: 0, message: 'Aucun match dans la fenêtre 50-70min' });
    }

    let sent = 0;
    let removed = 0;
    const subEntries = Object.entries(subscriptions);

    for (const match of upcomingMatches) {
      for (const [playerId, subData] of subEntries) {
        // Ne pas notifier si le prono est déjà rempli
        if (pronos[match.id]?.[playerId]) continue;

        const payload = JSON.stringify({
          title: `⚽ ${match.flag1 || ''} ${match.team1} vs ${match.team2} ${match.flag2 || ''}`,
          body: `${subData.playerName || 'Hey'}, donne ton prono avant le coup d'envoi !`,
          tag: match.id,
          icon: 'https://anthony-data.github.io/paris_cdm/icon.png',
        });

        try {
          await webpush.sendNotification(subData.subscription, payload);
          sent++;
        } catch (e) {
          // Abonnement expiré ou invalide → supprimer
          if (e.statusCode === 410 || e.statusCode === 404) {
            await db.ref(`cdm2026/subscriptions/${playerId}`).remove();
            removed++;
          } else {
            console.error(`Push failed for ${playerId}:`, e.message);
          }
        }
      }
    }

    return res.json({
      sent,
      removed,
      matches: upcomingMatches.map(m => `${m.team1} vs ${m.team2}`),
    });

  } catch (e) {
    console.error('Erreur notify:', e);
    return res.status(500).json({ error: e.message });
  }
};

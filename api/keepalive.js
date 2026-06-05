const webpush = require('web-push');
const admin = require('firebase-admin');

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

webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@paris-cdm.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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

    const payload = JSON.stringify({ type: 'keepalive' });

    let sent = 0;
    let removed = 0;
    let failed = 0;
    const removals = [];

    for (const [subKey, subData] of Object.entries(subscriptions)) {
      if (!subData.subscription) continue;
      try {
        await webpush.sendNotification(subData.subscription, payload, { urgency: 'high', TTL: 3600 });
        sent++;
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          removals.push(db.ref(`cdm2026/subscriptions/${subKey}`).remove());
          removed++;
        } else {
          failed++;
        }
      }
    }

    if (removals.length) await Promise.all(removals);

    return res.json({ sent, removed, failed, total: Object.keys(subscriptions).length });
  } catch (e) {
    console.error('ERREUR keepalive:', e);
    return res.status(500).json({ error: e.message });
  }
};

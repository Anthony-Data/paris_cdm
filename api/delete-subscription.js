const admin = require('firebase-admin');

function getDB() {
  if (!admin.apps.length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
    } catch {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (serviceAccount.private_key)
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

module.exports = async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'Paramètre key manquant' });

  try {
    const db = getDB();
    await db.ref(`cdm2026/subscriptions/${key}`).remove();
    res.redirect('/api/subscribers');
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};

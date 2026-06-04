const admin = require('firebase-admin');

function getDB() {
  if (!admin.apps.length) {
    let serviceAccount;
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
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
  const missing = ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_DATABASE_URL'].filter(k => !process.env[k]);
  if (missing.length)
    return res.status(500).json({ error: `Variables manquantes : ${missing.join(', ')}` });

  try {
    const db = getDB();
    const snap = await db.ref('cdm2026/subscriptions').once('value');
    const raw = snap.val() || {};

    const subscribers = Object.entries(raw).map(([key, v]) => ({
      key,
      playerName: v.playerName || '—',
      playerId:   v.playerId   || '—',
      endpoint:   v.subscription?.endpoint
        ? v.subscription.endpoint.replace(/^https:\/\/[^/]+/, '').slice(0, 60) + '…'
        : '—',
      updatedAt: v.updatedAt
        ? new Date(v.updatedAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })
        : '—',
    }));

    // Trier par nom
    subscribers.sort((a, b) => a.playerName.localeCompare(b.playerName));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Abonnés push — CDM 2026</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #eee; padding: 24px; max-width: 800px; margin: 0 auto; }
    h1   { color: #ffd600; font-size: 20px; margin-bottom: 4px; }
    p    { color: #aaa; font-size: 13px; margin: 0 0 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th   { text-align: left; padding: 8px 12px; background: #1a1a1a; color: #ffd600; border-bottom: 1px solid #333; }
    td   { padding: 8px 12px; border-bottom: 1px solid #222; color: #ccc; }
    tr:hover td { background: #111; }
    .badge { display:inline-block; background:#1a2a1a; color:#4caf50; border-radius:4px; padding:1px 6px; font-size:11px; }
    .count { color:#ffd600; font-weight:700; }
  </style>
</head>
<body>
  <h1>⚽ Abonnés push — CDM 2026</h1>
  <p>Vérifié le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} · <span class="count">${subscribers.length}</span> abonné(s)</p>
  ${subscribers.length === 0 ? '<p style="color:#f66">Aucun abonné enregistré.</p>' : `
  <table>
    <thead><tr><th>#</th><th>Joueur</th><th>Endpoint (extrait)</th><th>Mis à jour</th></tr></thead>
    <tbody>
      ${subscribers.map((s, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><span class="badge">✓</span> ${s.playerName}</td>
          <td style="font-size:11px;color:#666">${s.endpoint}</td>
          <td>${s.updatedAt}</td>
        </tr>`).join('')}
    </tbody>
  </table>`}
</body>
</html>`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

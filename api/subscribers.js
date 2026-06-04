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

function parseDevice(ua) {
  if (!ua) return { label: 'Inconnu', icon: '❓' };

  // iOS
  if (/iPhone/.test(ua)) {
    const m = ua.match(/CPU iPhone OS ([\d_]+)/);
    const ios = m ? ' · iOS ' + m[1].replace(/_/g, '.') : '';
    return { label: `iPhone${ios}`, icon: '📱' };
  }
  if (/iPad/.test(ua)) {
    const m = ua.match(/CPU OS ([\d_]+)/);
    const ios = m ? ' · iPadOS ' + m[1].replace(/_/g, '.') : '';
    return { label: `iPad${ios}`, icon: '📱' };
  }

  // Android
  if (/Android/.test(ua)) {
    // Samsung — numéro de modèle SM-XXXXX
    const samsung = ua.match(/;\s*(SM-[A-Z0-9]+)/);
    if (samsung) {
      const androidV = (ua.match(/Android ([\d.]+)/) || [])[1] || '';
      return { label: `Samsung ${samsung[1]}${androidV ? ' · Android ' + androidV : ''}`, icon: '📱' };
    }
    // Google Pixel
    const pixel = ua.match(/;\s*(Pixel[\s\w]+)\)/);
    if (pixel) {
      const androidV = (ua.match(/Android ([\d.]+)/) || [])[1] || '';
      return { label: `Google ${pixel[1].trim()}${androidV ? ' · Android ' + androidV : ''}`, icon: '📱' };
    }
    // Autre Android
    const gen = ua.match(/Android ([\d.]+);\s*([^)]+)\)/);
    if (gen) return { label: `Android ${gen[1]} — ${gen[2].trim()}`, icon: '📱' };
    return { label: 'Android', icon: '📱' };
  }

  // Desktop
  const isWin = /Windows NT ([\d.]+)/.test(ua);
  const isMac = /Macintosh/.test(ua);
  const isLinux = /Linux/.test(ua) && !/Android/.test(ua);

  let os = isWin
    ? (RegExp.$1 === '10.0' ? 'Windows 10/11' : 'Windows')
    : isMac ? 'Mac'
    : isLinux ? 'Linux' : 'PC';

  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : '';

  return { label: `${os}${browser ? ' — ' + browser : ''}`, icon: '💻' };
}

module.exports = async (req, res) => {
  const missing = ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_DATABASE_URL'].filter(k => !process.env[k]);
  if (missing.length)
    return res.status(500).json({ error: `Variables manquantes : ${missing.join(', ')}` });

  try {
    const db = getDB();
    const snap = await db.ref('cdm2026/subscriptions').once('value');
    const raw = snap.val() || {};

    const subscribers = Object.entries(raw).map(([key, v]) => {
      const device = parseDevice(v.userAgent);
      return {
        key,
        playerName: v.playerName || '—',
        playerId:   v.playerId   || '—',
        device:     device.label,
        icon:       device.icon,
        updatedAt:  v.updatedAt
          ? new Date(v.updatedAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })
          : '—',
      };
    }).sort((a, b) => a.playerName.localeCompare(b.playerName));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Abonnés push — CDM 2026</title>
  <style>
    body  { font-family:system-ui,sans-serif; background:#0a0a0a; color:#eee; padding:24px; max-width:900px; margin:0 auto; }
    h1    { color:#ffd600; font-size:20px; margin-bottom:4px; }
    p     { color:#aaa; font-size:13px; margin:0 0 20px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th    { text-align:left; padding:10px 14px; background:#1a1a1a; color:#ffd600; border-bottom:1px solid #333; }
    td    { padding:9px 14px; border-bottom:1px solid #1e1e1e; color:#ccc; }
    tr:hover td { background:#111; }
    .badge { display:inline-block; background:#1a2a1a; color:#4caf50; border-radius:4px; padding:1px 7px; font-size:11px; }
    .count { color:#ffd600; font-weight:700; font-size:16px; }
    .device { color:#aaa; }
    .ts    { color:#555; font-size:11px; }
  </style>
</head>
<body>
  <h1>⚽ Abonnés push — CDM 2026</h1>
  <p>Vérifié le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} &nbsp;·&nbsp;
     <span class="count">${subscribers.length}</span> abonné(s)</p>
  ${subscribers.length === 0
    ? '<p style="color:#f66">Aucun abonné enregistré.</p>'
    : `<table>
    <thead>
      <tr><th>#</th><th>Joueur</th><th>Appareil</th><th>Abonné le</th><th></th></tr>
    </thead>
    <tbody>
      ${subscribers.map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><span class="badge">✓</span> ${s.playerName}</td>
        <td class="device">${s.icon} ${s.device}</td>
        <td class="ts">${s.updatedAt}</td>
        <td><a href="/api/delete-subscription?key=${encodeURIComponent(s.key)}" onclick="return confirm('Supprimer cet abonnement ?')" style="color:#f66;font-size:11px;text-decoration:none;">🗑 Supprimer</a></td>
      </tr>`).join('')}
    </tbody>
  </table>`}
</body>
</html>`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

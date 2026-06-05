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

    // ── Mode force (?force=1) : push immédiat vers tous les abonnés ──────────
    // Accepte optionnellement team1/team2/flag1/flag2/matchTag pour notif match réelle
    if (req.query.force === '1') {
      const hasMatch = req.query.team1 && req.query.team2;
      const payload = JSON.stringify({
        title: hasMatch
          ? `⚽ ${req.query.flag1 || ''} ${req.query.team1} vs ${req.query.team2} ${req.query.flag2 || ''}`.trim()
          : '⚽ CdM 2026 — Test push serveur',
        body: hasMatch
          ? `N'oublie pas ton prono pour le match ${req.query.team1} vs ${req.query.team2} !`
          : 'Si tu vois cette notification, le push serveur fonctionne !',
        tag: req.query.matchTag || 'server_test',
      });
      let sent = 0, removed = 0, failed = 0;
      const details = [];
      const removals = [];
      for (const [subKey, subData] of Object.entries(subscriptions)) {
        if (!subData.subscription) continue;
        const ep = subData.subscription.endpoint || '';
        const type = ep.includes('web.push.apple.com') ? 'apns'
                   : ep.includes('fcm.googleapis.com') || ep.includes('push.services.mozilla') ? 'fcm'
                   : 'other';
        try {
          await webpush.sendNotification(subData.subscription, payload, PUSH_OPTS);
          sent++;
          details.push({ type, player: subData.playerName, status: 'ok' });
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            removals.push(db.ref(`cdm2026/subscriptions/${subKey}`).remove());
            removed++;
            details.push({ type, player: subData.playerName, status: '410_removed' });
          } else {
            failed++;
            details.push({ type, player: subData.playerName, status: `err_${e.statusCode}`, msg: e.body || e.message });
          }
        }
      }
      if (removals.length) await Promise.all(removals);
      return res.json({ mode: 'force_test', sent, removed, failed, subscribers: subCount, details });
    }

    // ── Mode keepalive (?keepalive=1) : maintient la connexion APNS chaude ───
    // À appeler toutes les 15-20 min via cron-job.com pour garantir la livraison
    // sur écran verrouillé iOS (connexion APNS dormante = notification différée).
    if (req.query.keepalive === '1') {
      const payload = JSON.stringify({ type: 'keepalive' });
      let sent = 0, removed = 0;
      const removals = [];
      for (const [subKey, subData] of Object.entries(subscriptions)) {
        if (!subData.subscription) continue;
        const ep = subData.subscription.endpoint || '';
        if (!ep.includes('web.push.apple.com')) continue; // iOS seulement
        try {
          await webpush.sendNotification(subData.subscription, payload, PUSH_OPTS);
          sent++;
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            removals.push(db.ref(`cdm2026/subscriptions/${subKey}`).remove());
            removed++;
          }
        }
      }
      if (removals.length) await Promise.all(removals);
      return res.json({ mode: 'keepalive', sent, removed, subscribers: subCount });
    }

    // ── Mode match immédiat (?matchId=<id>) : même logique que le cron ──────
    // mais pour un match spécifique, sans vérification de fenêtre temporelle.
    // Utilisé par betaTestNotif() et par tout appelant connaissant l'heure exacte.
    if (req.query.matchId) {
      const [sharedSnap2, sentSnap2] = await Promise.all([
        db.ref('cdm2026/shared').once('value'),
        db.ref('cdm2026/notifsSent').once('value'),
      ]);
      const shared2 = sharedSnap2.val() || {};
      const notifsSent2 = sentSnap2.val() || {};
      const pronos2 = shared2.pronos || {};
      const rawMatches2 = shared2.matches;
      const matches2 = Array.isArray(rawMatches2) ? rawMatches2 : Object.values(rawMatches2 || {});
      const match = matches2.find(m => m.id === req.query.matchId);
      if (!match) return res.status(404).json({ error: 'Match introuvable : ' + req.query.matchId });
      if (notifsSent2[match.id]) return res.json({ mode: 'matchId', skipped: 1, reason: 'already_sent' });

      const sentRef2 = db.ref(`cdm2026/notifsSent/${match.id}`);
      const tx2 = await sentRef2.transaction(cur => cur ? undefined : new Date().toISOString());
      if (!tx2.committed) return res.json({ mode: 'matchId', skipped: 1, reason: 'race_condition' });

      let sent = 0, skipped = 0, removed = 0;
      for (const [subKey, subData] of Object.entries(subscriptions)) {
        if (!subData.subscription) { skipped++; continue; }
        if (pronos2[match.id]?.[subData.playerId]) { skipped++; continue; }
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
          } else {
            console.error(`APNS error [${subKey}]: HTTP ${e.statusCode} — ${e.message}`);
            skipped++;
          }
        }
      }
      return res.json({ mode: 'matchId', match: match.id, sent, skipped, removed });
    }

    const now = new Date();

    // Lecture Firebase (matches + notifs déjà envoyées)
    const [sharedSnap, sentSnap] = await Promise.all([
      db.ref('cdm2026/shared').once('value'),
      db.ref('cdm2026/notifsSent').once('value'),
    ]);

    const shared = sharedSnap.val() || {};
    const notifsSent = sentSnap.val() || {};
    const rawMatches = shared.matches;
    const matches = Array.isArray(rawMatches) ? rawMatches : Object.values(rawMatches || {});

    // Fenêtre : 1h avant match ±2 min jusqu'au coup d'envoi.
    // On inclut les matchs déjà "partiellement" envoyés (format objet) pour retry iOS.
    // Format string (ancien) = entièrement envoyé → ignoré.
    const EARLY_MS = 2 * 60 * 1000;
    const targetMatches = matches.filter(m => {
      if (m.status !== 'upcoming') return false;
      if (typeof notifsSent[m.id] === 'string') return false; // ancien format = déjà envoyé
      const notifAt = new Date(m.date).getTime() - 60 * 60 * 1000;
      const msSince = now - notifAt;
      return msSince >= -EARLY_MS && now < new Date(m.date).getTime();
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
      // Tracking par abonné : { _at: ISO, subs: { subKey: 'ok'|'expired' } }
      // Si un abonné a échoué (non-410), il n'est pas marqué → retry à la prochaine minute.
      const sentData = notifsSent[match.id] || {};
      const sentSubs = sentData.subs || {};

      const payload = JSON.stringify({
        title: `⚽ ${match.flag1 || ''} ${match.team1} vs ${match.team2} ${match.flag2 || ''}`.trim(),
        body: `N'oublie pas ton prono pour le match ${match.team1} vs ${match.team2} !`,
        tag: match.id,
      });

      for (const [subKey, subData] of Object.entries(subscriptions)) {
        if (!subData.subscription) { skipped++; continue; }
        if (sentSubs[subKey] === 'ok' || sentSubs[subKey] === 'expired') { skipped++; continue; }

        try {
          await webpush.sendNotification(subData.subscription, payload, PUSH_OPTS);
          await db.ref(`cdm2026/notifsSent/${match.id}/subs/${subKey}`).set('ok');
          if (!sentData._at) await db.ref(`cdm2026/notifsSent/${match.id}/_at`).set(now.toISOString());
          sent++;
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await db.ref(`cdm2026/notifsSent/${match.id}/subs/${subKey}`).set('expired');
            await db.ref(`cdm2026/subscriptions/${subKey}`).remove();
            removed++;
          } else {
            // Pas marqué → le prochain cron (dans 1 min) réessaiera pour cet abonné
            console.error(`Push retry pending [${subKey}]: HTTP ${e.statusCode} — ${e.message}`);
            skipped++;
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

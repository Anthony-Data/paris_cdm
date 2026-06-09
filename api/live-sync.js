// Cron endpoint : appelé toutes les minutes par cron-job.com ("Cron API ESPN").
// Interroge ESPN puis écrit les scores/statuts dans Firebase → tous les clients
// reçoivent les mises à jour en temps réel via le listener Firebase, même app
// fermée / écran verrouillé / à 4h du matin.
//
// Ce fichier réutilise fetchEspn() et le mapping d'équipes de api/live.js
// (source unique de vérité) pour garantir que les noms d'équipes ESPN
// correspondent exactement à ceux stockés dans Firebase.

const admin = require('firebase-admin');
const { fetchEspn } = require('./live');

// ── Firebase Admin singleton (même pattern que api/notify.js) ────────────────
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

// ── Auto-switch de league ESPN ───────────────────────────────────────────────
// Avant le 10 juin 12h Paris (= 10h UTC) → amicaux ; après → Coupe du Monde.
const LEAGUE_CUTOFF = new Date('2026-06-10T10:00:00Z').getTime();
function currentLeague() {
  return Date.now() >= LEAGUE_CUTOFF ? 'fifa.world' : 'fifa.friendly';
}

// Normalise un nom d'équipe pour comparaison robuste (accents, ponctuation, casse)
function norm(name) {
  return (name || '').toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

// ── Handler principal ────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const missing = ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_DATABASE_URL']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: `Variables manquantes : ${missing.join(', ')}` });
  }

  try {
    const db = getDB();
    const league = req.query.league || currentLeague();
    const now = Date.now();

    // Lecture des matchs Firebase
    const sharedSnap = await db.ref('cdm2026/shared/matches').once('value');
    const rawMatches = sharedSnap.val();
    if (!rawMatches) {
      return res.json({ updated: 0, reason: 'no_matches_in_firebase', league });
    }

    // Firebase renvoie parfois un objet à clés numériques au lieu d'un tableau
    const matchEntries = Array.isArray(rawMatches)
      ? rawMatches.map((m, i) => [String(i), m])
      : Object.entries(rawMatches);

    // Un match est "pertinent" s'il est déjà live/halftime, ou dans la fenêtre
    // [coup d'envoi −2h ; coup d'envoi +3h]. Sinon inutile d'interroger ESPN.
    const isRelevant = (m) => {
      if (!m || !m.date) return false;
      if (m.status === 'live' || m.status === 'halftime') return true;
      const diff = now - new Date(m.date).getTime();
      return diff >= -2 * 60 * 60 * 1000 && diff < 3 * 60 * 60 * 1000;
    };

    const relevant = matchEntries.filter(([, m]) => isRelevant(m));
    if (!relevant.length) {
      return res.json({ updated: 0, skipped: 0, reason: 'no_relevant_matches', league, checked: new Date().toISOString() });
    }

    // Appel ESPN (réutilise exactement la même logique que /api/live)
    let espnMatches;
    try {
      espnMatches = await fetchEspn(null, league, null);
    } catch (espnErr) {
      return res.status(502).json({ error: 'ESPN inaccessible', detail: espnErr.message, league });
    }

    // Comparaison ESPN ↔ Firebase, construction d'un update multi-chemins atomique
    let updated = 0, skipped = 0;
    const updates = {};
    const changes = [];

    for (const [idx, m] of relevant) {
      const fbT1 = norm(m.team1);
      const fbT2 = norm(m.team2);

      const espn = espnMatches.find(e => {
        const et1 = norm(e.team1);
        const et2 = norm(e.team2);
        return (et1 === fbT1 && et2 === fbT2) || (et1 === fbT2 && et2 === fbT1);
      });

      if (!espn) { skipped++; continue; }

      // ESPN peut inverser domicile/extérieur par rapport à notre base
      const swapped = norm(espn.team1) === fbT2;
      const newScore1 = swapped ? espn.score2 : espn.score1;
      const newScore2 = swapped ? espn.score1 : espn.score2;
      const newStatus = espn.status;
      const newClock = espn.displayClock;
      const newMinute = espn.minute;

      const changed =
        m.status !== newStatus ||
        m.score1 !== newScore1 ||
        m.score2 !== newScore2;

      if (!changed) { skipped++; continue; }

      const base = `cdm2026/shared/matches/${idx}`;
      updates[`${base}/status`] = newStatus;
      if (newScore1 !== null) updates[`${base}/score1`] = newScore1;
      if (newScore2 !== null) updates[`${base}/score2`] = newScore2;
      // displayClock/minute : utiles tant que le match tourne, nettoyés une fois fini
      if (newStatus === 'finished') {
        updates[`${base}/displayClock`] = null;
        updates[`${base}/minute`] = null;
      } else {
        if (newClock) updates[`${base}/displayClock`] = newClock;
        if (newMinute) updates[`${base}/minute`] = newMinute;
      }

      updated++;
      changes.push(`${m.team1} ${newScore1 ?? '-'}-${newScore2 ?? '-'} ${m.team2} [${newStatus}]`);
    }

    if (Object.keys(updates).length) {
      await db.ref().update(updates);
    }

    return res.json({
      updated,
      skipped,
      league,
      espnMatchesFound: espnMatches.length,
      changes,
      checked: new Date().toISOString(),
    });

  } catch (e) {
    console.error('ERREUR live-sync:', e);
    return res.status(500).json({ error: e.message });
  }
};

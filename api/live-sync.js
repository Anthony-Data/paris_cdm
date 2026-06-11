// Cron endpoint : appelé toutes les minutes par cron-job.com ("Cron API ESPN").
// Interroge ESPN puis écrit les scores/statuts dans Firebase → tous les clients
// reçoivent les mises à jour en temps réel via le listener Firebase, même app
// fermée / écran verrouillé / à 4h du matin.
//
// Ce fichier réutilise fetchEspn() et le mapping d'équipes de api/live.js
// (source unique de vérité) pour garantir que les noms d'équipes ESPN
// correspondent exactement à ceux stockés dans Firebase.

const admin = require('firebase-admin');
const webpush = require('web-push');
const { fetchEspn } = require('./live');

// VAPID : configuré une seule fois si les clés sont présentes. Sans elles, on
// continue le sync des scores mais sans envoyer de notification de fin de match.
let _vapidReady = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'admin@paris-cdm.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  _vapidReady = true;
}
const PUSH_OPTS = { urgency: 'high', TTL: 3600 };

// Envoie une notification "match terminé" à tous les abonnés, une seule fois
// par match. Utilise le MÊME verrou de déduplication que api/notify.js
// (cdm2026/notifsSent/fin_<id>) → la notif de fin part une seule fois, que ce
// soit ce cron ESPN ou la saisie manuelle de l'admin qui termine le match.
async function notifyFinished(db, match) {
  if (!_vapidReady) return { sent: 0, reason: 'no_vapid' };
  const dedupKey = `fin_${match.id}`;
  // Verrou anti-doublon partagé avec notify.js : seul le premier appel passe.
  const lockRef = db.ref(`cdm2026/notifsSent/${dedupKey}`);
  const tx = await lockRef.transaction(cur => cur ? undefined : new Date().toISOString());
  if (!tx.committed) return { sent: 0, reason: 'already_sent' };

  const subsSnap = await db.ref('cdm2026/subscriptions').once('value');
  const subscriptions = subsSnap.val() || {};
  const payload = JSON.stringify({
    title: `🏁 ${match.flag1 || ''} ${match.team1} ${match.score1} – ${match.score2} ${match.team2} ${match.flag2 || ''}`.trim(),
    body: `Le match est terminé ! Viens voir ton score 🏆`,
    tag: dedupKey,
  });
  let sent = 0, removed = 0;
  for (const [subKey, subData] of Object.entries(subscriptions)) {
    if (!subData.subscription) continue;
    try {
      await webpush.sendNotification(subData.subscription, payload, PUSH_OPTS);
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await db.ref(`cdm2026/subscriptions/${subKey}`).remove();
        removed++;
      }
    }
  }
  return { sent, removed };
}

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

    // Un match est "pertinent" s'il est déjà live/halftime, ou si son coup d'envoi
    // était dans les dernières 24h (et qu'il est encore "upcoming" dans Firebase).
    // La fenêtre large couvre : délais ESPN importants, matchs jamais passés en
    // STATUS_IN_PROGRESS, et cas où ESPN ne met STATUS_FINAL que bien après le coup
    // de sifflet final. Les matchs déjà "finished" dans Firebase sont ignorés.
    const isRelevant = (m) => {
      if (!m || !m.date) return false;
      if (m.status === 'live' || m.status === 'halftime') return true;
      if (m.status === 'finished') return false; // Déjà réglé, inutile de re-interroger
      const diff = now - new Date(m.date).getTime();
      // Fenêtre : de 2h avant le coup d'envoi jusqu'à 24h après.
      // Les 24h couvrent les délais ESPN extrêmes ET les cas où on a raté la fenêtre
      // active (ESPN bloqué en STATUS_SCHEDULED pendant tout le match).
      return diff >= -2 * 3600000 && diff < 24 * 3600000;
    };

    const relevant = matchEntries.filter(([, m]) => isRelevant(m));
    if (!relevant.length) {
      return res.json({ updated: 0, skipped: 0, reason: 'no_relevant_matches', league, checked: new Date().toISOString() });
    }

    // Appel ESPN — on interroge une PLAGE de dates (±1 jour) autour de chaque
    // match pertinent. ESPN regroupe ses matchs par date américaine (heure de
    // l'Est), pas en UTC : un match à 4h du matin Paris (= 02h UTC) est classé
    // sous la VEILLE côté ESPN. Interroger UTC seul rate donc le match. La plage
    // ±1 jour couvre tous les cas quel que soit le fuseau de regroupement ESPN.
    const toYmd = (ms) => {
      const dt = new Date(ms);
      return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
    };
    const DAY = 24 * 60 * 60 * 1000;
    const dateSet = new Set();
    for (const [, m] of relevant) {
      const t = new Date(m.date).getTime();
      dateSet.add(toYmd(t - DAY));
      dateSet.add(toYmd(t));
      dateSet.add(toYmd(t + DAY));
    }
    const dates = [...dateSet];

    // Promise.allSettled : une date qui échoue ne doit pas faire tomber le sync.
    const espnMatches = [];
    const seen = new Set();
    const results = await Promise.allSettled(dates.map(ds => fetchEspn(null, league, ds)));
    const okCount = results.filter(r => r.status === 'fulfilled').length;
    if (!okCount) {
      const firstErr = results.find(r => r.status === 'rejected');
      return res.status(502).json({ error: 'ESPN inaccessible', detail: firstErr?.reason?.message || 'all dates failed', league, dates });
    }
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const e of r.value) {
        if (e.fdId && seen.has(e.fdId)) continue;
        if (e.fdId) seen.add(e.fdId);
        espnMatches.push(e);
      }
    }

    // Comparaison ESPN ↔ Firebase, construction d'un update multi-chemins atomique
    let updated = 0, skipped = 0;
    const updates = {};
    const changes = [];
    const finishedNow = []; // matchs qui viennent de passer "terminé" → notif push

    for (const [idx, m] of relevant) {
      const fbT1 = norm(m.team1);
      const fbT2 = norm(m.team2);

      // Chaque côté ESPN peut matcher sur son nom FR (mappé) OU son nom EN brut.
      // → l'admin peut taper le nom français ou anglais, ça marche dans les deux cas.
      const sideMatch = (e) => {
        const s1 = new Set([norm(e.team1), norm(e.team1En)]);
        const s2 = new Set([norm(e.team2), norm(e.team2En)]);
        if (s1.has(fbT1) && s2.has(fbT2)) return 'direct';
        if (s1.has(fbT2) && s2.has(fbT1)) return 'swapped';
        return null;
      };
      // La plage de dates ±1 jour peut renvoyer DEUX entrées pour la même paire
      // d'équipes (ex. une en cours + une programmée un autre jour). On prend la
      // plus "avancée" (en direct/terminé prioritaire sur à venir) pour ne jamais
      // matcher par erreur l'entrée pré-match au lieu du match réellement en cours.
      const RANK = { upcoming: 0, live: 1, halftime: 1, finished: 2 };
      let espn = null, orientation = null;
      for (const e of espnMatches) {
        const o = sideMatch(e);
        if (!o) continue;
        if (!espn || (RANK[e.status] ?? 0) > (RANK[espn.status] ?? 0)) {
          espn = e; orientation = o;
        }
      }

      if (!espn) { skipped++; continue; }

      // Garde MONOTONE : un match déjà commencé/terminé ne doit JAMAIS être
      // rétrogradé en "à venir". Si l'entrée ESPN retenue est "pre" alors que
      // Firebase a déjà le match en direct, on l'ignore — sinon le match clignote
      // "en direct ↔ à venir" toutes les ~30s.
      if ((RANK[espn.status] ?? 0) < (RANK[m.status] ?? 0)) { skipped++; continue; }

      // ESPN peut inverser domicile/extérieur par rapport à notre base
      const swapped = orientation === 'swapped';
      const newScore1 = swapped ? espn.score2 : espn.score1;
      const newScore2 = swapped ? espn.score1 : espn.score2;
      const newStatus = espn.status;
      const newClock = espn.displayClock;
      const newMinute = espn.minute;

      const base = `cdm2026/shared/matches/${idx}`;

      // Stade : métadonnée statique fournie par ESPN (dispo à tout moment, même
      // match en cours). On la pose une seule fois si elle manque — indépendamment
      // du score, donc AVANT la sortie "pas de changement".
      if (espn.venue && !m.venue) {
        updates[`${base}/venue`] = espn.venue;
        if (espn.city) updates[`${base}/city`] = espn.city;
      }

      const changed =
        m.status !== newStatus ||
        m.score1 !== newScore1 ||
        m.score2 !== newScore2 ||
        // La minute avance à chaque tick → on l'inclut dans "changed" pour que
        // Firebase reste à jour même sans but. Sans ça, un refresh renvoie
        // l'utilisateur à la minute du dernier but au lieu de la minute actuelle.
        (newClock && m.displayClock !== newClock);

      if (!changed) { skipped++; continue; }

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

      // Transition vers "terminé" → on note le match pour la notif "viens voir
      // ton score" (envoyée après l'écriture Firebase, dédupliquée par verrou).
      if (newStatus === 'finished' && m.status !== 'finished') {
        finishedNow.push({ ...m, score1: newScore1, score2: newScore2 });
      }

      updated++;
      changes.push(`${m.team1} ${newScore1 ?? '-'}-${newScore2 ?? '-'} ${m.team2} [${newStatus}]`);
    }

    if (Object.keys(updates).length) {
      await db.ref().update(updates);
    }

    // Notifications "match terminé" — après l'écriture Firebase, une seule fois
    // par match. Une erreur de notif ne doit pas faire échouer le sync des scores.
    const notified = [];
    for (const fm of finishedNow) {
      try {
        const r = await notifyFinished(db, fm);
        notified.push(`${fm.team1} ${fm.score1}–${fm.score2} ${fm.team2} → ${r.sent ?? 0} envoyée(s)${r.reason ? ' ('+r.reason+')' : ''}`);
      } catch (e) {
        notified.push(`${fm.team1} vs ${fm.team2} → erreur notif: ${e.message}`);
      }
    }

    return res.json({
      updated,
      skipped,
      league,
      dates,
      espnMatchesFound: espnMatches.length,
      // Aide au diagnostic : si un match attendu est skippé, on voit ici les
      // équipes qu'ESPN a renvoyées pour comparer les noms.
      espnTeams: espnMatches.map(e => `${e.team1} vs ${e.team2} [${e.status}]`),
      relevant: relevant.map(([, m]) => `${m.team1} vs ${m.team2}`),
      changes,
      notified,
      checked: new Date().toISOString(),
    });

  } catch (e) {
    console.error('ERREUR live-sync:', e);
    return res.status(500).json({ error: e.message });
  }
};

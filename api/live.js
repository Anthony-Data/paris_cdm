// Route Vercel : proxy football-data.org → évite d'exposer la clé API côté client
// Appelée par l'app toutes les 60s pour les matchs en cours

const FDORG_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FDORG_BASE  = 'https://api.football-data.org/v4';

// Compétitions supportées (codes football-data.org)
// WC = FIFA World Cup, CL = Champions League (pour les tests avant le 11 juin)
const COMP_MAP = {
  WC:  2000,
  CL:  2001,
  PL:  2021,
  FL1: 2015,
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!FDORG_TOKEN) {
    return res.status(500).json({ error: 'FOOTBALL_DATA_TOKEN non configuré dans les variables Vercel' });
  }

  const { competition = 'WC', matchId } = req.query;

  try {
    let url;
    if (matchId) {
      // Récupère un match précis par son ID football-data.org
      url = `${FDORG_BASE}/matches/${matchId}`;
    } else {
      // Récupère les matchs en cours / aujourd'hui pour la compétition
      const compId = COMP_MAP[competition] || COMP_MAP.WC;
      url = `${FDORG_BASE}/competitions/${compId}/matches?status=IN_PLAY,PAUSED,LIVE`;
    }

    const response = await fetch(url, {
      headers: { 'X-Auth-Token': FDORG_TOKEN }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `football-data.org: ${response.status}`, detail: text });
    }

    const data = await response.json();

    // Normalise la réponse pour l'app
    const matches = matchId
      ? [data]
      : (data.matches || []);

    const normalized = matches.map(m => ({
      fdId:    m.id,
      team1:   m.homeTeam?.shortName || m.homeTeam?.name || '',
      team2:   m.awayTeam?.shortName || m.awayTeam?.name || '',
      score1:  m.score?.fullTime?.home ?? m.score?.regularTime?.home ?? null,
      score2:  m.score?.fullTime?.away ?? m.score?.regularTime?.away ?? null,
      minute:  m.minute || null,
      status:  normalizeStatus(m.status),
      utcDate: m.utcDate,
    }));

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ matches: normalized, updatedAt: new Date().toISOString() });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function normalizeStatus(s) {
  if (['IN_PLAY', 'LIVE'].includes(s))  return 'live';
  if (s === 'PAUSED')                   return 'halftime';
  if (['FINISHED', 'AWARDED'].includes(s)) return 'finished';
  if (s === 'TIMED' || s === 'SCHEDULED') return 'upcoming';
  return 'upcoming';
}

const FDORG_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FDORG_BASE  = 'https://api.football-data.org/v4';
const ESPN_BASE   = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';

const COMP_MAP = {
  WC:  2000,
  CL:  2001,
  PL:  2021,
  ELC: 2016,
  BL1: 2002,
  SA:  2019,
  PD:  2014,
  FL1: 2015,
  DED: 2003,
  PPL: 2017,
  BSA: 2013,
  EC:  2018,
};

const ESPN_TO_FR = {
  'Mexico': 'Mexique',
  'South Africa': 'Afrique du Sud',
  'South Korea': 'Corée du Sud',
  'Korea Republic': 'Corée du Sud',
  'Czech Republic': 'Rep. Tchèque',
  'Czechia': 'Rep. Tchèque',
  'Canada': 'Canada',
  'Bosnia and Herzegovina': 'Bosnie',
  'Bosnia-Herzegovina': 'Bosnie',
  'Qatar': 'Qatar',
  'Switzerland': 'Suisse',
  'Brazil': 'Brésil',
  'Scotland': 'Écosse',
  'Haiti': 'Haïti',
  'Morocco': 'Maroc',
  'Australia': 'Australie',
  'Turkey': 'Turquie',
  'Türkiye': 'Turquie',
  'United States': 'USA',
  'USA': 'USA',
  'Paraguay': 'Paraguay',
  'Germany': 'Allemagne',
  'Ivory Coast': "Côte d'Ivoire",
  "Cote d'Ivoire": "Côte d'Ivoire",
  "Côte d'Ivoire": "Côte d'Ivoire",
  'Curaçao': 'Curaçao',
  'Ecuador': 'Équateur',
  'Netherlands': 'Pays-Bas',
  'Japan': 'Japon',
  'Sweden': 'Suède',
  'Tunisia': 'Tunisie',
  'Spain': 'Espagne',
  'Cape Verde': 'Cap-Vert',
  'Belgium': 'Belgique',
  'Egypt': 'Égypte',
  'Saudi Arabia': 'Arabie Saoudite',
  'Uruguay': 'Uruguay',
  'Iran': 'Iran',
  'New Zealand': 'Nouvelle-Zélande',
  'France': 'France',
  'Iraq': 'Irak',
  'Norway': 'Norvège',
  'Senegal': 'Sénégal',
  'Argentina': 'Argentine',
  'Algeria': 'Algérie',
  'Austria': 'Autriche',
  'Jordan': 'Jordanie',
  'Portugal': 'Portugal',
  'DR Congo': 'Congo DR',
  'Democratic Republic of Congo': 'Congo DR',
  'Congo DR': 'Congo DR',
  'England': 'Angleterre',
  'Croatia': 'Croatie',
  'Ghana': 'Ghana',
  'Panama': 'Panama',
  'Uzbekistan': 'Ouzbékistan',
  'Colombia': 'Colombie',
};

function toFr(name) {
  return ESPN_TO_FR[name] || name;
}

function normalizeEspnStatus(statusName) {
  if (statusName === 'STATUS_IN_PROGRESS') return 'live';
  if (statusName === 'STATUS_HALFTIME') return 'halftime';
  if (['STATUS_FINAL', 'STATUS_FULL_TIME', 'STATUS_AWARDED'].includes(statusName)) return 'finished';
  return 'upcoming';
}

function normalizeFdStatus(s) {
  if (['IN_PLAY', 'LIVE'].includes(s)) return 'live';
  if (s === 'PAUSED' || s === 'HALF_TIME') return 'halftime';
  if (['FINISHED', 'AWARDED'].includes(s)) return 'finished';
  return 'upcoming';
}

async function fetchEspn(matchId, league, dates) {
  const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');
  // league : slug ESPN (fifa.world par défaut, fifa.friendly pour les amicaux...)
  const lg = /^[a-z0-9.]+$/i.test(league || '') ? league : 'fifa.world';
  let url = `${ESPN_BASE}${lg}/scoreboard`;
  if (/^\d{8}$/.test(dates || '')) url += `?dates=${dates}`;
  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const data = await res.json();
  const events = data.events || [];
  const filtered = matchId ? events.filter(e => e.id === matchId) : events;

  return filtered.map(event => {
    const comp = event.competitions?.[0] || {};
    const status = event.status || {};
    const statusType = status.type || {};
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home') || {};
    const away = competitors.find(c => c.homeAway === 'away') || {};
    const isActive = statusType.state === 'in' || statusType.state === 'post';
    const scoreStarted = statusType.state !== 'pre';

    return {
      fdId: event.id,
      team1: toFr(home.team?.displayName || ''),
      team2: toFr(away.team?.displayName || ''),
      score1: scoreStarted && home.score !== undefined ? (parseInt(home.score) >= 0 ? parseInt(home.score) : null) : null,
      score2: scoreStarted && away.score !== undefined ? (parseInt(away.score) >= 0 ? parseInt(away.score) : null) : null,
      minute: isActive ? Math.round(status.clock) : null,
      displayClock: isActive ? (status.displayClock || null) : null,
      status: normalizeEspnStatus(statusType.name),
      venue: comp.venue?.fullName || null,
      city: comp.venue?.address?.city || null,
      utcDate: event.date,
      source: 'espn',
    };
  });
}

async function fetchFallback(competition, matchId) {
  const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');
  const compId = COMP_MAP[competition] || COMP_MAP['WC'];

  if (matchId) {
    const res = await fetchFn(`${FDORG_BASE}/matches/${matchId}`, {
      headers: { 'X-Auth-Token': FDORG_TOKEN },
    });
    if (!res.ok) throw new Error(`football-data HTTP ${res.status}`);
    const match = await res.json();
    return [formatFdMatch(match)];
  }

  const res = await fetchFn(`${FDORG_BASE}/competitions/${compId}/matches?status=IN_PLAY,PAUSED,LIVE`, {
    headers: { 'X-Auth-Token': FDORG_TOKEN },
  });
  if (!res.ok) throw new Error(`football-data HTTP ${res.status}`);
  const data = await res.json();
  return (data.matches || []).map(formatFdMatch);
}

function formatFdMatch(m) {
  const isActive = ['IN_PLAY', 'LIVE', 'PAUSED', 'HALF_TIME'].includes(m.status);
  return {
    fdId: m.id,
    team1: m.homeTeam?.shortName || m.homeTeam?.name || '',
    team2: m.awayTeam?.shortName || m.awayTeam?.name || '',
    score1: m.score?.fullTime?.home ?? m.score?.regularTime?.home ?? null,
    score2: m.score?.fullTime?.away ?? m.score?.regularTime?.away ?? null,
    minute: isActive ? (m.minute || null) : null,
    displayClock: null,
    status: normalizeFdStatus(m.status),
    utcDate: m.utcDate,
    source: 'football-data',
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const competition = req.query.competition || 'WC';
  const matchId = req.query.matchId || null;
  const league = req.query.league || 'fifa.world';
  const dates = req.query.dates || null;

  try {
    const matches = await fetchEspn(matchId, league, dates);
    return res.status(200).json(matches);
  } catch (espnErr) {
    console.error('ESPN failed, falling back to football-data:', espnErr.message);
    try {
      const matches = await fetchFallback(competition, matchId);
      return res.status(200).json(matches);
    } catch (fdErr) {
      console.error('football-data fallback also failed:', fdErr.message);
      return res.status(502).json({ error: 'Both data sources failed', espn: espnErr.message, fd: fdErr.message });
    }
  }
};

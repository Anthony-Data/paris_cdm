import pdfplumber, re, sys

FLAGS = {
  'MEX':'🇲🇽','RSA':'🇿🇦','KOR':'🇰🇷','CZE':'🇨🇿','CAN':'🇨🇦','BIH':'🇧🇦',
  'QAT':'🇶🇦','SUI':'🇨🇭','BRA':'🇧🇷','MAR':'🇲🇦','HAI':'🇭🇹','SCO':'🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  'USA':'🇺🇸','PAR':'🇵🇾','AUS':'🇦🇺','TUR':'🇹🇷','GER':'🇩🇪','CUW':'🏝',
  'CIV':'🇨🇮','ECU':'🇪🇨','NED':'🇳🇱','JPN':'🇯🇵','SWE':'🇸🇪','TUN':'🇹🇳',
  'KSA':'🇸🇦','URU':'🇺🇾','ESP':'🇪🇸','CPV':'🇨🇻','BEL':'🇧🇪','EGY':'🇪🇬',
  'IRN':'🇮🇷','NZL':'🇳🇿','FRA':'🇫🇷','SEN':'🇸🇳','IRQ':'🇮🇶','NOR':'🇳🇴',
  'ARG':'🇦🇷','ALG':'🇩🇿','AUT':'🇦🇹','JOR':'🇯🇴','POR':'🇵🇹','COD':'🇨🇩',
  'UZB':'🇺🇿','COL':'🇨🇴','ENG':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','CRO':'🇭🇷','GHA':'🇬🇭','PAN':'🇵🇦',
}
NAMES = {
  'MEX':'Mexique','RSA':'Afrique du Sud','KOR':'Corée du Sud','CZE':'Tchéquie',
  'CAN':'Canada','BIH':'Bosnie','QAT':'Qatar','SUI':'Suisse',
  'BRA':'Brésil','MAR':'Maroc','HAI':'Haïti','SCO':'Écosse','USA':'USA',
  'PAR':'Paraguay','AUS':'Australie','TUR':'Türkiye','GER':'Allemagne',
  'CUW':'Curaçao','CIV':"Côte d'Ivoire",'ECU':'Équateur','NED':'Pays-Bas',
  'JPN':'Japon','SWE':'Suède','TUN':'Tunisie','KSA':'Arabie Saoudite',
  'URU':'Uruguay','ESP':'Espagne','CPV':'Cap-Vert','BEL':'Belgique',
  'EGY':'Égypte','IRN':'Iran','NZL':'Nouvelle-Zélande','FRA':'France',
  'SEN':'Sénégal','IRQ':'Irak','NOR':'Norvège','ARG':'Argentine',
  'ALG':'Algérie','AUT':'Autriche','JOR':'Jordanie','POR':'Portugal',
  'COD':'Congo DR','UZB':'Ouzbékistan','COL':'Colombie','ENG':'Angleterre',
  'CRO':'Croatie','GHA':'Ghana','PAN':'Panama',
}

DATE_MAP = {
  'June Thursday 11':'2026-06-11','June Friday 12':'2026-06-12',
  'June Saturday 13':'2026-06-13','June Sunday 14':'2026-06-14',
  'June Monday 15':'2026-06-15','June Tuesday 16':'2026-06-16',
  'Wednesday June 17':'2026-06-17','June Thursday 18':'2026-06-18',
  'June Friday 19':'2026-06-19','June Saturday 20':'2026-06-20',
  'June Sunday 21':'2026-06-21','June Monday 22':'2026-06-22',
  'June Tuesday 23':'2026-06-23','Wednesday June 24':'2026-06-24',
  'June Thursday 25':'2026-06-25','June Friday 26':'2026-06-26',
  'June Saturday 27':'2026-06-27','June Sunday 28':'2026-06-28',
  'June Monday 29':'2026-06-29','June Tuesday 30':'2026-06-30',
  'Wednesday July 1':'2026-07-01','Thursday July 2':'2026-07-02',
  'July Friday 3':'2026-07-03','Saturday July 4':'2026-07-04',
  'July Sunday 5':'2026-07-05','July Monday 6':'2026-07-06',
  'Tuesday July 7':'2026-07-07','Thursday July 9':'2026-07-09',
  'July Friday 10':'2026-07-10','July Saturday 11':'2026-07-11',
  'Tuesday July 14':'2026-07-14','Wednesday July 15':'2026-07-15',
}

def phase(n):
    if n <= 72: return 'Groupes'
    if n <= 88: return '32es'
    if n <= 96: return '16es'
    if n <= 100: return 'Quarts'
    if n <= 102: return 'Demies'
    if n == 103: return '3e place'
    return 'Finale'

def unreverse(s):
    if not s: return None
    lines = s.split('\n')
    return ' '.join(l[::-1].strip() for l in lines if l.strip())

with pdfplumber.open(r'C:\Users\irontech\Downloads\calendrier_cdm.pdf') as pdf:
    page = pdf.pages[0]
    tbl = page.extract_tables()[1]
    header = tbl[0]
    dates = {}
    for i, h in enumerate(header):
        if i < 2 or not h: continue
        d = unreverse(h)
        if d: dates[i] = d

    matches = {}
    for row in tbl[1:]:
        city_raw = row[0]
        if not city_raw: continue
        for ci, cell in enumerate(row):
            if ci < 2 or not cell or ci not in dates: continue
            m = re.match(r'(\d+)\s+(\d+:\d+)\n(\w+)\nv\n(\w+)', cell)
            if m:
                num = int(m.group(1))
                time_val = m.group(2)
                t1, t2 = m.group(3), m.group(4)
                date_str = DATE_MAP.get(dates[ci])
                if date_str:
                    iso = date_str + 'T' + time_val + ':00-04:00'
                    matches[num] = (t1, t2, iso, phase(num))

    # Manual knockout stage entries not parsed by regex
    matches[103] = ('?','?','2026-07-18T17:00:00-04:00','3e place')
    matches[104] = ('?','?','2026-07-19T15:00:00-04:00','Finale')

    print('const OFFICIAL_MATCHES = [')
    for n in sorted(matches.keys()):
        t1, t2, iso, ph = matches[n]
        n1 = NAMES.get(t1, 'TBD')
        n2 = NAMES.get(t2, 'TBD')
        f1 = FLAGS.get(t1, 'TBD' if t1 == '?' else '⚽')
        f2 = FLAGS.get(t2, 'TBD' if t2 == '?' else '⚽')
        # For knockout with known codes (2A, 1B etc), keep as team names
        if t1 not in NAMES and t1 != '?':
            n1 = t1; f1 = '⚽'
        if t2 not in NAMES and t2 != '?':
            n2 = t2; f2 = '⚽'
        line = "  {id:'o" + str(n) + "',matchNum:" + str(n) + ",team1:'" + n1.replace("'","\\'") + "',team2:'" + n2.replace("'","\\'") + "',flag1:'" + f1 + "',flag2:'" + f2 + "',date:'" + iso + "',phase:'" + ph + "',status:'upcoming',score1:null,score2:null},"
        print(line)
    print('];')

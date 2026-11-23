# Lee el calendario de la Federació Catalana de Ciclisme (ciclisme.cat) y deja las carreras y marchas
# de BTT, carretera y gravel en datos/carreras/carreras.json para Ichnos.
# Respeta el "Crawl-delay: 10" de su robots.txt (10 s entre páginas) y solo lee páginas públicas.
import json, os, re, sys, time, html, datetime, urllib.request, urllib.parse, math

BASE = 'https://www.ciclisme.cat'
UA = 'Ichnos-calendario/1.0 (+https://carreterobike.github.io/ruta-fuentes/)'
OUT = 'datos/carreras'
DELAY = 10
SECCIONES = ['btt', 'pedalades', 'carretera', 'cicloturisme', 'gravel', 'brevet']
# lo que no es para nosotros (categorías de chavales, pista, etc.)
FUERA = re.compile(r'ruta permanent|permanent|promoci|cadet|junior|infantil|kids|escolar|alev|benjam|pumptrack|bmx|trial|pista|dhi|enduro|ciclocr|paraciclisme', re.I)
MAX_FICHAS = int(os.environ.get('MAX_FICHAS', '260'))
MAX_TRACKS = int(os.environ.get('MAX_TRACKS', '80'))
last_req = [0.0]


def get(url, timeout=40, binary=False, polite=True):
    if polite:
        wait = DELAY - (time.time() - last_req[0])
        if wait > 0: time.sleep(wait)
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ca,es'})
    for intento in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read(6_000_000)
            if polite: last_req[0] = time.time()
            return data if binary else data.decode('utf-8', 'replace')
        except Exception as e:
            if polite: last_req[0] = time.time()
            if intento == 2: raise
            time.sleep(20)


def txt(s):
    s = re.sub(r'<br\s*/?>', '\n', s or '')
    s = re.sub(r'<[^>]+>', ' ', s)
    return re.sub(r'[ \t\r]+', ' ', html.unescape(s)).strip()


def parse_lista(h):
    """Filas del calendario: fecha, enlace, nombre, campeonatos, pueblo, provincia, modalidad, oci/anulada."""
    out = []
    tb = h.find('<tbody>')
    if tb < 0: return out, False
    body = h[tb:h.find('</tbody>', tb)]
    for tr in re.split(r'<tr[ >]', body)[1:]:
        tds = re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S)
        if len(tds) < 4: continue
        m = re.search(r'content="([^"]+)"', tds[0])
        a = re.search(r'<a href="(/cursa/[^"]+)">(.*?)</a>', tds[1], re.S)
        if not (m and a): continue
        camps = [txt(x) for x in re.findall(r'<li><a [^>]*>(.*?)</a>', tds[1], re.S)]
        lugar = [x.strip() for x in txt(tds[2]).split('\n') if x.strip()]
        mod = [x.strip() for x in txt(tds[3]).split('\n') if x.strip()]
        extra = tds[4] if len(tds) > 4 else tr
        out.append({
            'd': m.group(1), 'url': a.group(1), 'n': txt(a.group(2)), 'camp': camps,
            'pob': lugar[0].title() if lugar else '', 'prov': lugar[1] if len(lugar) > 1 else '',
            'm1': mod[0] if mod else '', 'm2': mod[1] if len(mod) > 1 else '',
            'oci': 'span-comp oci' in extra, 'anul': bool(re.search(r'ANUL', txt(a.group(2)), re.I)),
        })
    nxt = re.search(r'<li class="next"><a [^>]*href="([^"]+)"', h)
    return out, bool(nxt)


def parse_ficha(h):
    f = {}
    for k, v in re.findall(r'<li><strong>\s*([^<:]+?)\s*:\s*</strong>(.*?)</li>', h, re.S):
        f[k.strip()] = txt(v)
    r = {}
    if f.get('Hora sortida'): r['h'] = f['Hora sortida'][:5]
    if f.get('Adreça sortida'): r['dir'] = f['Adreça sortida'][:80]
    for key in ('Quilòmetres totals', 'Quilòmetres circuit'):
        m = re.search(r'([\d.,]+)', f.get(key, ''))
        if m:
            try:
                km = float(m.group(1).replace('.', '').replace(',', '.')) if m.group(1).count('.') > 0 and ',' in m.group(1) else float(m.group(1).replace(',', '.'))
                if 3 <= km <= 1500: r['km'] = round(km); break
            except ValueError: pass
    if f.get('Tipus'): r['tipus'] = f['Tipus']
    m = re.search(r'maps\.google\.[a-z.]+/maps\?[^"\']*q=(-?\d+\.\d+),\s*(-?\d+\.\d+)', h)
    if m:
        lat, lon = float(m.group(1)), float(m.group(2))
        if 40.3 < lat < 43.0 and -0.5 < lon < 3.5: r['lat'], r['lon'] = round(lat, 5), round(lon, 5)
    m = re.search(r'Web:\s*</strong>\s*(?:<a [^>]*href="([^"]+)")?\s*([^<\s]*)', h)
    web = (m and (m.group(1) or m.group(2)) or '').strip()
    if web and not web.startswith('http'): web = 'https://' + web
    if re.match(r'https?://[^\s/]+\.[a-z]{2,}', web or ''): r['web'] = web[:200]
    return r


def disciplina(c):
    t = (c['m1'] + ' ' + c['m2']).lower()
    if 'gravel' in t: return 'gravel'
    if 'btt' in t or 'resist' in t: return 'btt'
    if c['m1'].lower() in ('carretera', 'cicloturisme', 'brevet') or 'carretera' in t: return 'carretera'
    return None


def nivel(c):
    """1 para disfrutar · 2 marcha larga · 3 exigente · 4 competición/muy dura."""
    km, ds, m2 = c.get('km'), c['ds'], c['m2'].lower()
    if not c['oci']:
        if 'marat' in m2 and 'ultra' not in m2: return 3
        if 'open-social' in m2 or 'social' in m2: return 3
        if c['m1'].lower() == 'brevet' or 'brevet' in m2: return 4 if (km or 200) >= 300 else 3
        if 'gravel' in ds and km and km < 120: return 3
        return 4
    if 'resist' in m2: return 3
    if 'ultra' in m2: return 4
    if not km: return 2
    lim = {'btt': (35, 60, 90), 'gravel': (60, 110, 200), 'carretera': (80, 130, 200)}[ds]
    return 1 if km <= lim[0] else 2 if km <= lim[1] else 3 if km <= lim[2] else 4


def geocode(pob, prov):
    q = urllib.parse.urlencode({'q': f'{pob}, {prov}, Catalunya, España', 'format': 'json', 'limit': 1, 'countrycodes': 'es'})
    time.sleep(1.2)
    try:
        j = json.loads(get('https://nominatim.openstreetmap.org/search?' + q, polite=False))
        if j: return round(float(j[0]['lat']), 5), round(float(j[0]['lon']), 5)
    except Exception as e:
        print('geocode', pob, e)
    return None


def gpx_points(data):
    s = data.decode('utf-8', 'replace')
    pts = []
    for tag in re.findall(r'<(?:trkpt|rtept)\b[^>]*>', s):
        la, lo = re.search(r'lat="(-?[\d.]+)"', tag), re.search(r'lon="(-?[\d.]+)"', tag)
        if la and lo: pts.append((float(la.group(1)), float(lo.group(1))))
    if not pts:  # KML: lon,lat[,alt]
        for blk in re.findall(r'<coordinates>(.*?)</coordinates>', s, re.S):
            for t in blk.split():
                p = t.split(',')
                if len(p) >= 2: pts.append((float(p[1]), float(p[0])))
    return pts


def simplify(pts, maxn=500):
    if len(pts) <= maxn: return pts
    step = len(pts) / maxn
    out = [pts[int(i * step)] for i in range(maxn)]
    out.append(pts[-1])
    return out


def find_track(web):
    """Busca en la web del organizador un enlace directo a un .gpx o .kml (muchas no lo tienen)."""
    try:
        h = get(web, timeout=20, polite=False)
    except Exception as e:
        return None
    links = re.findall(r'href="([^"]+\.(?:gpx|kml)(?:\?[^"]*)?)"', h, re.I)
    for l in links[:3]:
        u = urllib.parse.urljoin(web, html.unescape(l))
        try:
            pts = gpx_points(get(u, timeout=30, binary=True, polite=False))
            if len(pts) > 20: return {'src': u, 'p': [[round(a, 5), round(b, 5)] for a, b in simplify(pts)]}
        except Exception as e:
            print('track', u, e)
    return None


# ---------- running y trail: calendarios de la Federació Catalana d'Atletisme (PDF) ----------
FCA = 'https://fcatletisme.cat'
MESOS = {'GENER': 1, 'FEBRER': 2, 'MARÇ': 3, 'MARC': 3, 'ABRIL': 4, 'MAIG': 5, 'JUNY': 6, 'JULIOL': 7, 'AGOST': 8, 'SETEMBRE': 9, 'OCTUBRE': 10, 'NOVEMBRE': 11, 'DESEMBRE': 12}
FUERA_PIE = re.compile(r"espanya|españa|europa|europe|m[oó]n\b|world|international|internactional|kids|promoci|sub ?1[468]|sub ?20|susp[eè]s|suspesa|anul|ajornat", re.I)
CAT_BOX = (40.45, 43.0, 0.1, 3.4)


def fca_pdfs(hoy):
    """Los PDF más nuevos de cada año (este y el siguiente) de trail y de ruta."""
    out = []
    for q, ds in (('calendari-trail', 'trail'), ('calendari-ruta', 'correr')):
        try:
            l = json.loads(get(f'{FCA}/wp-json/wp/v2/media?search={q}&per_page=30&orderby=date&order=desc', polite=False))
        except Exception as e:
            print('fca', q, e); continue
        for y in (hoy.year, hoy.year + 1):
            for x in l:
                u = x.get('source_url', '')
                if u.lower().endswith('.pdf') and str(y) in u.rsplit('/', 1)[-1] and 'nota' not in u.lower():
                    out.append((ds, y, u)); break
    return out


def pdf_text(u):
    import subprocess, tempfile
    with tempfile.NamedTemporaryFile(suffix='.pdf') as f:
        f.write(get(u, binary=True, polite=False)); f.flush()
        return subprocess.run(['pdftotext', '-layout', f.name, '-'], capture_output=True, text=True).stdout


def km_de(nombre, esp):
    n = nombre.lower(); ds = []
    if re.search(r'\bmarat[oó]\b', n) and not re.search(r'mitja|mini|quart', n): ds.append(42)
    if re.search(r'mitja', n): ds.append(21)
    if re.search(r'\bmilla\b', n): ds.append(1.6)
    for grp in re.findall(r'((?:\d+(?:[.,]\d+)?\s*k?m?\s*(?:-|\bi\b|\by\b|,\s)\s*)+\d+(?:[.,]\d+)?)\s*k', n):
        ds += [float(x.replace(',', '.')) for x in re.findall(r'\d+(?:[.,]\d+)?', grp)]
    for a in re.findall(r'(\d+(?:[.,]\d+)?)\s*km', n): ds.append(float(a.replace(',', '.')))
    for a in re.findall(r'\b(\d+)k\b', n): ds.append(float(a))
    ds = sorted(set(d for d in ds if 0.5 < d < 400))
    return ds


def nivel_pie(ds_, dists, esp):
    e = esp.lower(); mx = max(dists) if dists else None
    if 'ultra' in e: return 4
    if 'vertical' in e: return 3
    if ds_ == 'correr':
        if not mx: return 2
        return 1 if mx <= 10 else 2 if mx <= 21.1 else 3 if mx <= 42.2 else 4
    if not mx: return 2
    return 1 if mx <= 12 else 2 if mx <= 25 else 3 if mx <= 45 else 4


def parse_fca(txt, ds_, year, url):
    out, mes, yy, last = [], None, year, None
    for ln in txt.splitlines():
        m = re.match(r'\s*(GENER|FEBRER|MAR[ÇC]|ABRIL|MAIG|JUNY|JULIOL|AGOST|SETEMBRE|OCTUBRE|NOVEMBRE|DESEMBRE)\b\s*(\d{4})?', ln)
        if m and not re.match(r'\s*\d', ln): mes, yy = MESOS[m.group(1)], int(m.group(2) or year); continue
        m = re.match(r'\s*(\d{1,2})(?:\s*-\s*\d{1,2})?\s+(\S.*)$', ln)
        if mes and m:
            parts = [p.strip() for p in re.split(r'\s{2,}', m.group(2).strip()) if p.strip()]
            if len(parts) < 2: continue
            nombre, lugar = parts[0], parts[-1]
            esp = parts[1] if len(parts) > 2 else ''
            try: d = datetime.date(yy, mes, int(m.group(1)))
            except ValueError: continue
            last = {'d': d.isoformat() + 'T09:00:00+01:00', 'n': nombre, 'pob': lugar, 'prov': '', 'ds': ds_, 'esp': esp, 'url': url, 'camp': []}
            out.append(last); continue
        t = ln.strip()
        if last and t and re.match(r'(Campionat|Copa)', t) and not re.search(r'\s{2,}', t): last['camp'].append(t)
    return out


def carreras_pie(hoy, geo):
    items = []
    for ds_, y, u in fca_pdfs(hoy):
        try: txt = pdf_text(u)
        except Exception as e: print('pdf', u, e); continue
        rows = parse_fca(txt, ds_, y, u); print('FCA', ds_, y, len(rows), u, flush=True)
        for c in rows:
            if FUERA_PIE.search(c['n'] + ' ' + c['esp'] + ' ' + ' '.join(c['camp'])) or FUERA_PIE.search(c['pob']): continue
            if re.search(r'\((?:[A-Z]{3})\)|\bpolonia|sud-?[àa]frica|la rioja|murcia|palma|cantabria|m[aá]laga|m[eé]rida', c['pob'], re.I): continue
            k = c['pob'].lower()
            if k not in geo: geo[k] = geocode(c['pob'], '')
            g = geo[k]
            if not g or not (CAT_BOX[0] < g[0] < CAT_BOX[1] and CAT_BOX[2] < g[1] < CAT_BOX[3]): continue
            c['lat'], c['lon'], c['aprox'] = g[0], g[1], 1
            c['camp'] += [x.strip() for x in re.findall(r'\((Campionat[^)]*)\)', c['n'])]
            dists = km_de(c['n'], c['esp'])
            c['n'] = re.sub(r'\s*\((?:TRS|CMT|CCP|RFEA|FCA|Campionat[^)]*)\)', '', c['n']).strip(' -')
            if len(dists) > 1 or re.search(r'\(\s*[\d.,]+\s*km\s*\)', c['n'], re.I): c['n'] = re.sub(r'\s*\((?=[^)]*\d)[\d.,\sKkmMiIy-]+\)', '', c['n']).strip(' -')
            if dists: c['km'] = round(max(dists)) if max(dists) >= 3 else max(dists)
            if len(dists) > 1: c['dists'] = [round(x, 1) if x < 3 else round(x) for x in dists]
            c['n'] = re.sub(r'\s*\+\s*$', '', re.sub(r'\s*\+\s*\+', ' +', c['n'])).strip()
            if len(c['n']) < 6 and c['camp']: c['n'] = c['camp'][0]
            c['lv'] = nivel_pie(ds_, dists, c['esp'] + (' vertical' if re.search(r'vertical', c['n'], re.I) else ''))
            c['comp'] = False
            esp = c.pop('esp')
            c['mod'] = ('Trail' + (' · ' + esp if esp and esp.lower() not in ('trail running',) else '')) if ds_ == 'trail' else ('Carrera en asfalto' + (' · ' + esp if esp and 'homolog' not in esp.lower() else ''))
            c['src'] = 'fca'
            c['id'] = 'fca-' + re.sub(r'[^a-z0-9]+', '-', (c['d'][:10] + '-' + c['n']).lower()).strip('-')[:80]
            items.append(c)
    return items


def main():
    os.makedirs(OUT + '/tracks', exist_ok=True)
    est_path = OUT + '/_estado.json'
    est = json.load(open(est_path)) if os.path.exists(est_path) else {}
    old = {}
    if os.path.exists(OUT + '/carreras.json'):
        for c in json.load(open(OUT + '/carreras.json')).get('items', []): old[c['url'].replace(BASE, '')] = c
    hoy = datetime.date.today()
    d0, d1 = datetime.date(hoy.year, 1, 1), datetime.date(hoy.year + 1, 12, 31)
    q = urllib.parse.urlencode({'field_event_date_value[value][date]': d0.strftime('%d/%m/%Y'), 'field_event_date_value_1[value][date]': d1.strftime('%d/%m/%Y')})
    filas = {}
    for sec in SECCIONES:
        page = 0
        while page < 80:
            h = get(f'{BASE}/calendari/{sec}?{q}' + (f'&page={page}' if page else ''))
            rows, more = parse_lista(h)
            for c in rows: filas.setdefault(c['url'], c)
            print(sec, page, len(rows), flush=True)
            if not more or not rows: break
            page += 1
    items = []
    for url, c in filas.items():
        if c['anul'] or FUERA.search(c['m1'] + ' ' + c['m2']) or c['n'].lower().startswith('clone of'): continue
        c['ds'] = disciplina(c)
        if not c['ds']: continue
        prev = old.get(url, {})
        for k in ('h', 'dir', 'km', 'tipus', 'lat', 'lon', 'web', 'tr'):
            if k in prev: c[k] = prev[k]
        items.append(c)
    # fichas: primero las que vienen antes; nuevas o con más de 21 días sin mirar (si la carrera aún no ha pasado)
    hoy_s = hoy.isoformat()
    pend = [c for c in items if c['d'][:10] >= hoy_s and (time.time() - est.get(c['url'], {}).get('f', 0)) > 21 * 86400]
    pend += [c for c in items if c['d'][:10] < hoy_s and c['url'] not in est]
    pend.sort(key=lambda c: (c['d'][:10] < hoy_s, c['d']))
    n = 0
    for c in pend[:MAX_FICHAS]:
        try:
            r = parse_ficha(get(BASE + c['url']))
            c.update(r); n += 1
            est.setdefault(c['url'], {})['f'] = int(time.time())
        except Exception as e:
            print('ficha', c['url'], e)
    print('fichas leídas', n, 'de', len(pend), flush=True)
    # sitio en el mapa: el de la ficha; si no, el pueblo
    geo = est.setdefault('_geo', {})
    for c in items:
        if 'lat' in c: continue
        k = (c['pob'] + '|' + c['prov']).lower()
        if k not in geo: geo[k] = geocode(c['pob'], c['prov'])
        if geo[k]: c['lat'], c['lon'], c['aprox'] = geo[k][0], geo[k][1], 1
    # recorridos: solo carreras que aún no han pasado, con web, sin probar en 30 días
    nt = 0
    for c in sorted(items, key=lambda c: c['d']):
        if nt >= MAX_TRACKS: break
        if c['d'][:10] < hoy_s or not c.get('web') or c.get('tr'): continue
        e = est.setdefault(c['url'], {})
        if time.time() - e.get('t', 0) < 30 * 86400: continue
        e['t'] = int(time.time()); nt += 1
        tr = find_track(c['web'])
        if tr:
            tid = re.sub(r'[^a-z0-9-]', '', c['url'].split('/')[-1].lower())[:80]
            json.dump(tr, open(f'{OUT}/tracks/{tid}.json', 'w'), separators=(',', ':'))
            c['tr'] = tid
            print('recorrido', c['n'], len(tr['p']), flush=True)
    for c in items:
        # menos de 9 km no es una marcha: es lo que mide una vuelta del circuito (resistencias, XCO, criteriums)
        if c.get('km') and c['km'] < 9: c['kmc'] = c.pop('km')
        c['lv'] = nivel(c)
        c['id'] = re.sub(r'[^a-z0-9-]', '', c['url'].split('/')[-1].lower())[:80]
        c['comp'] = not c.pop('oci', False)
        c['mod'] = (c.pop('m1', '') + (' · ' + c['m2'] if c.get('m2') else '')).strip()
        c.pop('m2', None); c.pop('anul', None)
        c['url'] = BASE + c['url'] if c['url'].startswith('/') else c['url']
    # una carrera con varias categorías (Màster 30-40, Màster 50-60, Elit…) sale una sola vez
    CAT = re.compile(r'\s*[-–(]?\s*\b(m[aà]ster|elit|sub[ -]?23|f[eè]mines|femen\w*|mascul\w*)\b[\d\s/+-]*\)?\s*$', re.I)
    junt = {}
    for c in items:
        k = (c['d'][:10], c['pob'].lower(), CAT.sub('', c['n']).strip().lower())
        if k in junt:
            j = junt[k]
            j['camp'] = sorted(set(j['camp']) | set(c['camp']))
            if c.get('km') and c['km'] > (j.get('km') or 0): j['km'] = c['km']
            if 'tr' in c and 'tr' not in j: j['tr'] = c['tr']
            j['n'] = CAT.sub('', j['n']).strip() or j['n']
        else:
            junt[k] = c
    items = list(junt.values())
    try:
        pie = carreras_pie(hoy, geo); items += pie; print('a pie', len(pie), flush=True)
    except Exception as e:
        print('a pie: error', e)
    items.sort(key=lambda c: c['d'])
    json.dump({'upd': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%MZ'), 'src': 'Federació Catalana de Ciclisme (ciclisme.cat)', 'items': items},
              open(OUT + '/carreras.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    est = {k: v for k, v in est.items() if k == '_geo' or k in filas}
    json.dump(est, open(est_path, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('carreras', len(items), 'con recorrido', sum(1 for c in items if c.get('tr')))


if __name__ == '__main__':
    main()

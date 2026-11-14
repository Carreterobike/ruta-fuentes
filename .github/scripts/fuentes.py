# Prepara las fuentes de España y Andorra (OpenStreetMap) en trozos de 0,5° para que Ichnos las lea al momento.
# Lo ejecuta GitHub cada semana (.github/workflows/fuentes.yml).
import json, os, shutil, sys, time, urllib.parse, urllib.request

SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
           'https://overpass.private.coffee/api/interpreter']
KEEP = ('amenity', 'natural', 'man_made', 'drinking_water', 'seasonal', 'name', 'access')
OUT = 'datos/fuentes'

def query(s, w, n, e):
    bb = f'{s},{w},{n},{e}'
    q = (f'[out:json][timeout:300];(nwr["amenity"="drinking_water"]({bb});nwr["amenity"="water_point"]({bb});'
         f'nwr["man_made"="water_tap"]({bb});nwr["natural"="spring"]({bb});'
         f'nwr["amenity"="fountain"]["drinking_water"="yes"]({bb}););out center tags;')
    data = urllib.parse.urlencode({'data': q}).encode()
    for attempt in range(6):
        url = SERVERS[attempt % len(SERVERS)]
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': 'Ichnos (app de una grupeta ciclista)'})
            with urllib.request.urlopen(req, timeout=360) as r:
                return json.load(r)['elements']
        except Exception as ex:
            print('  reintento', attempt + 1, url, ex, flush=True)
            time.sleep(20 * (attempt + 1))
    raise SystemExit(f'No se ha podido bajar la zona {bb}')

tiles, seen = {}, set()
lat = 35.5
while lat < 44:
    lon = -9.5
    while lon < 4.5:
        print('zona', lat, lon, flush=True)
        for el in query(lat, lon, min(lat + 2, 44), min(lon + 2, 4.5)):
            t = el.get('tags') or {}
            la = el.get('lat', (el.get('center') or {}).get('lat'))
            lo = el.get('lon', (el.get('center') or {}).get('lon'))
            key = (el['type'], el['id'])
            if la is None or lo is None or key in seen:
                continue
            if t.get('access') in ('no', 'private') or t.get('drinking_water') == 'no' \
                    or t.get('drinking_water:legal') == 'no' or t.get('disused') == 'yes':
                continue
            seen.add(key)
            k = f'{(la // 0.5) * 0.5:.1f}_{(lo // 0.5) * 0.5:.1f}'
            tiles.setdefault(k, []).append([el['type'][0], el['id'], round(la, 6), round(lo, 6),
                                            {x: t[x] for x in KEEP if x in t}])
        time.sleep(5)
        lon += 2
    lat += 2

if len(seen) < 1000:
    raise SystemExit(f'Muy pocas fuentes ({len(seen)}): algo ha fallado, no se cambia nada')
tmp = OUT + '.nuevo'
shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
for k, v in tiles.items():
    with open(f'{tmp}/{k}.json', 'w') as f:
        json.dump(v, f, separators=(',', ':'), ensure_ascii=False)
with open(f'{tmp}/index.json', 'w') as f:
    json.dump({'v': int(time.time()), 'n': len(seen), 't': sorted(tiles)}, f, separators=(',', ':'))
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(os.path.dirname(OUT), exist_ok=True); os.rename(tmp, OUT)
print('fuentes:', len(seen), 'trozos:', len(tiles))

# Prepara las fuentes de España (OpenStreetMap, copia de Geofabrik) en trozos de 0,5° para que Ichnos las lea al momento.
# Lo ejecuta GitHub cada semana (.github/workflows/fuentes.yml). Lee fuentes.geojson, que sale de osmium.
import json, os, shutil, time

KEEP = ('amenity', 'natural', 'man_made', 'drinking_water', 'seasonal', 'name', 'access')
OUT = 'datos/fuentes'

def wanted(t):
    a = t.get('amenity'); ok = a in ('drinking_water', 'water_point') or t.get('man_made') == 'water_tap' \
        or t.get('natural') == 'spring' or (a == 'fountain' and t.get('drinking_water') == 'yes')
    if not ok: return False
    if t.get('access') in ('no', 'private') or t.get('drinking_water') == 'no' \
            or t.get('drinking_water:legal') == 'no' or t.get('disused') == 'yes': return False
    return True

def center(g):
    c = g['coordinates']
    while isinstance(c[0], list): c = c[0]
    return c[1], c[0]

tiles, n = {}, 0
with open('fuentes.geojson') as f:
    for line in f:
        line = line.strip().lstrip('\x1e')
        if not line: continue
        ft = json.loads(line); t = ft.get('properties') or {}
        if not wanted(t): continue
        oid = str(ft.get('id') or '')   # n123 / w123 (osmium --add-unique-id=type_id)
        typ, num = (oid[0], oid[1:]) if oid[:1] in 'nwr' and oid[1:].isdigit() else ('n', str(n))
        la, lo = center(ft['geometry'])
        k = f'{(la // 0.5) * 0.5:.1f}_{(lo // 0.5) * 0.5:.1f}'
        tiles.setdefault(k, []).append([typ, int(num), round(la, 6), round(lo, 6), {x: t[x] for x in KEEP if x in t}])
        n += 1

if n < 1000:
    raise SystemExit(f'Muy pocas fuentes ({n}): algo ha fallado, no se cambia nada')
tmp = OUT + '.nuevo'
shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
for k, v in tiles.items():
    with open(f'{tmp}/{k}.json', 'w') as f: json.dump(v, f, separators=(',', ':'), ensure_ascii=False)
with open(f'{tmp}/index.json', 'w') as f:
    json.dump({'v': int(time.time()), 'n': n, 't': sorted(tiles)}, f, separators=(',', ':'))
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(os.path.dirname(OUT), exist_ok=True); os.rename(tmp, OUT)
print('fuentes:', n, 'trozos:', len(tiles))

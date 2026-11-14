// ===== Puente de Ichnos (Cloudflare Worker) · versión 2: cuentas, amigos y Strava para todos =====
// Necesita: STRAVA_ID (variable), STRAVA_SECRET (secreto) y un espacio KV enlazado con el nombre KV.
const API_OK = /^(athlete|athlete\/activities|activities\/\d+|activities\/\d+\/(streams|photos)|gear\/[\w-]+|segments\/explore|segments\/\d+)$/;
const APP_OK = /^https:\/\/carreterobike\.github\.io\/ruta-fuentes\//;
const USER_OK = /^[a-z0-9._-]{3,20}$/;
const CODE_OK = /^[A-Za-z0-9ñÑ._-]{3,30}$/;
const SYNC_OK = /^[\w.-]{1,80}$/;
const PUB_OK = /^(pub|resumen|p-\d{4}-\d{2})$/;
const ITER = 20000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, X-Ichnos-Key, Content-Type',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const J = (o, s = 200) => json(o, s, cors);
    const P = url.pathname;
    try {
      if (!env.KV || !env.STRAVA_ID || !env.STRAVA_SECRET) {
        const falta = ['KV', 'STRAVA_ID', 'STRAVA_SECRET'].filter(k => !env[k]);
        return page('Falta configurar', 'Falta: <b>' + falta.join(', ') + '</b>.<br>Lo que hay ahora: ' + esc(Object.keys(env).join(', ') || 'nada'));
      }
      const KV = env.KV;
      const body = async () => { try { return await req.json(); } catch (e) { return {}; } };

      // ---------- sin cuenta ----------
      if (P === '/estado') return J({ v: 2, primero: !(await KV.get('admin')), viejo: !!(await KV.get('key')), icu: !!(env.ICU_ID && env.ICU_SECRET) });

      // El primero (David): pasa su conexión antigua a una cuenta de verdad
      if (P === '/auth/primero' && req.method === 'POST') {
        const b = await body();
        if (await KV.get('admin')) return J({ error: 'Ya hay una cuenta principal.' }, 400);
        const key = await KV.get('key');
        if (!key || b.key !== key) return J({ error: 'Este aparato no tiene la conexión antigua.' }, 401);
        const bad = checkNew(b); if (bad) return J({ error: bad }, 400);
        if (await KV.get('login:' + b.user.toLowerCase())) return J({ error: 'Ese usuario ya existe.' }, 400);
        const u = await newUser(KV, b, true);
        await KV.put('admin', u.id);
        const old = JSON.parse(await KV.get('tok') || 'null'), owner = await KV.get('owner');
        if (old && owner) {
          await KV.put('tok:' + u.id, JSON.stringify({ ...old, ath: owner }));
          await KV.put('ath:' + owner, u.id);
          u.strava = owner; await KV.put('u:' + u.id, JSON.stringify(u));
        }
        await KV.delete('key');   // el código antiguo ICHNOS- deja de valer
        return J(await session(env, u));
      }

      if (P === '/auth/registro' && req.method === 'POST') {
        const b = await body();
        const code = String(b.code || '').trim();
        const inv = JSON.parse(await KV.get('inv:' + code.toLowerCase()) || 'null');
        if (!inv || inv.tipo !== 'alta') return J({ error: 'Ese código de invitación no existe. Revisa que esté bien escrito.' }, 400);
        if (inv.used) return J({ error: 'Ese código de invitación ya se ha usado.' }, 400);
        const bad = checkNew(b); if (bad) return J({ error: bad }, 400);
        if (await KV.get('login:' + b.user.toLowerCase())) return J({ error: 'Ese usuario ya existe. Elige otro.' }, 400);
        const u = await newUser(KV, b, false);
        inv.used = { uid: u.id, t: Date.now() };
        if (inv.g) { const g = JSON.parse(await KV.get('gr:' + inv.g) || 'null'); if (g) { g.members[u.id] = Date.now(); await KV.put('gr:' + g.id, JSON.stringify(g)); await ugAdd(KV, u.id, g.id); } }
        await KV.put('inv:' + code.toLowerCase(), JSON.stringify(inv));
        // quien invita y el invitado se siguen el uno al otro desde el principio
        if (inv.by) {
          const a = await getFw(KV, inv.by), c = await getFw(KV, u.id);
          a.in[u.id] = 'ok'; a.out[u.id] = 'ok'; c.in[inv.by] = 'ok'; c.out[inv.by] = 'ok';
          await KV.put('fw:' + inv.by, JSON.stringify(a)); await KV.put('fw:' + u.id, JSON.stringify(c));
          await notify(KV, inv.by, { k: 'alta', u: u.id });
        }
        return J(await session(env, u));
      }

      if (P === '/auth/entrar' && req.method === 'POST') {
        const b = await body();
        const user = String(b.user || '').trim().toLowerCase();
        const fk = 'fail:' + user, fails = +(await KV.get(fk) || 0);
        if (fails >= 8) return J({ error: 'Demasiados intentos. Espera 15 minutos.' }, 429);
        const uid = await KV.get('login:' + user);
        const u = uid && JSON.parse(await KV.get('u:' + uid) || 'null');
        if (!u || (await hashPw(String(b.pass || ''), u.pw.s)) !== u.pw.h) {
          await KV.put(fk, String(fails + 1), { expirationTtl: 900 });
          return J({ error: 'Usuario o contraseña incorrectos.' }, 401);
        }
        return J(await session(env, u));
      }

      if (P === '/auth/clave' && req.method === 'POST') {   // contraseña nueva con el código que da David
        const b = await body();
        const code = String(b.code || '').trim().toLowerCase();
        const inv = JSON.parse(await KV.get('inv:' + code) || 'null');
        if (!inv || inv.tipo !== 'clave' || inv.used) return J({ error: 'Ese código no vale. Pide uno nuevo.' }, 400);
        if (String(b.pass || '').length < 6) return J({ error: 'La contraseña tiene que tener al menos 6 letras o números.' }, 400);
        const u = JSON.parse(await KV.get('u:' + inv.uid) || 'null');
        if (!u) return J({ error: 'Esa cuenta ya no existe.' }, 400);
        u.pw = await pwRec(String(b.pass)); u.v = (u.v || 0) + 1;
        await KV.put('u:' + u.id, JSON.stringify(u));
        await KV.delete('inv:' + code); await idxDel(KV, 'invs', code);
        return J(await session(env, u));
      }

      // Strava vuelve aquí con el permiso
      if (P === '/vuelta') {
        let st = {}; try { st = JSON.parse(b64dec(url.searchParams.get('state') || '')); } catch (e) {}
        const back = APP_OK.test(st.r || '') ? st.r.split('#')[0] : null;
        const fin = (k) => back ? Response.redirect(back + '#strava=' + k, 302) : page('Strava', k === 'ok' ? 'Strava conectado. Vuelve a Ichnos.' : 'No se ha podido conectar Strava. Vuelve a Ichnos e inténtalo otra vez.');
        const me = await auth(env, st.t);
        if (!me) return fin('sesion');
        if (url.searchParams.get('error')) return fin('cancelado');
        if (!(url.searchParams.get('scope') || '').includes('activity:read')) return fin('permiso');
        const r = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: env.STRAVA_ID, client_secret: env.STRAVA_SECRET, code: url.searchParams.get('code'), grant_type: 'authorization_code' }),
        });
        const t = await r.json();
        if (!r.ok || !t.access_token) return fin(/limit/i.test(JSON.stringify(t)) ? 'limite' : 'error');
        const ath = String(t.athlete && t.athlete.id);
        const other = await KV.get('ath:' + ath);
        if (other && other !== me.id) return fin('otra');
        await KV.put('tok:' + me.id, JSON.stringify({ a: t.access_token, r: t.refresh_token, e: t.expires_at, ath }));
        await KV.put('ath:' + ath, me.id);
        if (me.strava !== ath) { me.strava = ath; await KV.put('u:' + me.id, JSON.stringify(me)); }
        return fin('ok');
      }

      // ----- Intervals.icu: las salidas que llegan directas del reloj (sí se pueden enseñar a los amigos)
      if (P === '/icu/conectar') {
        const t = url.searchParams.get('t') || '', r = url.searchParams.get('r') || '';
        if (!(await auth(env, t))) return page('Intervals.icu', 'Primero entra en Ichnos con tu usuario.');
        if (!APP_OK.test(r)) return page('Intervals.icu', 'Abre Ichnos y pulsa "Conectar Intervals.icu" desde allí.');
        if (!env.ICU_ID) return page('Intervals.icu', 'Todavía no está activada la conexión con Intervals.icu.');
        return Response.redirect('https://intervals.icu/oauth/authorize?client_id=' + encodeURIComponent(env.ICU_ID) + '&redirect_uri=' + encodeURIComponent(url.origin + '/icu/vuelta') +
          '&scope=ACTIVITY:READ&state=' + encodeURIComponent(b64enc(JSON.stringify({ t, r }))), 302);
      }
      if (P === '/icu/vuelta') {
        let st = {}; try { st = JSON.parse(b64dec(url.searchParams.get('state') || '')); } catch (e) {}
        const back = APP_OK.test(st.r || '') ? st.r.split('#')[0] : null;
        const fin = (k) => back ? Response.redirect(back + '#icu=' + k, 302) : page('Intervals.icu', k === 'ok' ? 'Conectado. Vuelve a Ichnos.' : 'No se ha podido conectar. Vuelve a Ichnos.');
        const me = await auth(env, st.t);
        if (!me) return fin('sesion');
        if (url.searchParams.get('error')) return fin('cancelado');
        const r = await fetch('https://intervals.icu/api/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: env.ICU_ID, client_secret: env.ICU_SECRET, code: url.searchParams.get('code') || '' }) });
        const t = await r.json().catch(() => ({}));
        if (!r.ok || !t.access_token) return fin('error');
        await KV.put('icu:' + me.id, JSON.stringify({ b: t.access_token, a: String(t.athlete && t.athlete.id || ''), n: (t.athlete && t.athlete.name) || '' }));
        return fin('ok');
      }

      // Ir a Strava a dar permiso: /conectar?t=<sesión>&r=<dirección de la app>
      if (P === '/conectar') {
        const t = url.searchParams.get('t') || '', r = url.searchParams.get('r') || '';
        if (!(await auth(env, t))) return page('Strava', 'Primero entra en Ichnos con tu usuario y luego pulsa "Conectar con Strava".');
        if (!APP_OK.test(r)) return page('Strava', 'Abre Ichnos y pulsa "Conectar con Strava" desde allí.');
        const go = 'https://www.strava.com/oauth/authorize?client_id=' + encodeURIComponent(env.STRAVA_ID) +
          '&response_type=code&approval_prompt=auto&scope=read,activity:read_all,profile:read_all' +
          '&redirect_uri=' + encodeURIComponent(url.origin + '/vuelta') + '&state=' + encodeURIComponent(b64enc(JSON.stringify({ t, r })));
        return Response.redirect(go, 302);
      }

      // ---------- con cuenta ----------
      const tk = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const me = await auth(env, tk);
      if (!me) {
        if (P === '/' || P === '') return page('Ichnos', 'Puente de Ichnos. Todo funciona.');
        return J({ error: 'sesion' }, 401);
      }
      const isAdmin = (await KV.get('admin')) === me.id;
      const canSee = async (uid) => uid === me.id || (await getFw(KV, uid)).in[me.id] === 'ok' || await mates(KV, me.id, uid);

      if (P === '/yo' && req.method === 'GET') return J({ ...pubUser(me), admin: isAdmin, strava: !!me.strava, icu: !!(await KV.get('icu:' + me.id)) });

      // Intervals.icu con la clave personal de cada uno (mientras no esté la conexión oficial)
      if (P === '/icu/clave' && req.method === 'POST') {
        const b = await body(); const k = String(b.key || '').trim();
        if (!/^[\w-]{10,80}$/.test(k)) return J({ error: 'Esa clave no parece buena. Cópiala entera de Intervals.icu.' }, 400);
        const r = await fetch('https://intervals.icu/api/v1/athlete/0', { headers: { Authorization: 'Basic ' + btoa('API_KEY:' + k) } });
        if (!r.ok) return J({ error: 'Intervals.icu no acepta esa clave. Revisa que esté bien copiada.' }, 400);
        const a = await r.json().catch(() => ({}));
        await KV.put('icu:' + me.id, JSON.stringify({ k, a: String(a.id || ''), n: a.name || '' }));
        return J({ ok: true, name: a.name || '' });
      }
      if (P === '/icu/quitar' && req.method === 'POST') { await KV.delete('icu:' + me.id); return J({ ok: true }); }
      if (P.startsWith('/icu/api/')) {
        const path = P.slice(9);
        if (!/^(athlete\/0\/activities|activity\/[\w-]+(\/file)?)$/.test(path)) return J({ error: 'ruta' }, 404);
        const c = JSON.parse(await KV.get('icu:' + me.id) || 'null');
        if (!c) return J({ error: 'sin conectar' }, 409);
        const s = await fetch('https://intervals.icu/api/v1/' + path + url.search, { headers: { Authorization: c.b ? 'Bearer ' + c.b : 'Basic ' + btoa('API_KEY:' + c.k) } });
        if (s.status === 401 || s.status === 403) return J({ error: 'renovar' }, 409);
        return new Response(s.body, { status: s.status, headers: { ...cors, 'Content-Type': s.headers.get('Content-Type') || 'application/octet-stream' } });
      }
      if (P === '/yo' && req.method === 'POST') {
        const b = await body();
        const name = String(b.name || '').trim().slice(0, 30);
        if (name && name !== me.name) { me.name = name; await KV.put('u:' + me.id, JSON.stringify(me)); await usersPut(KV, me); }
        if (b.pass) {
          if ((await hashPw(String(b.old || ''), me.pw.s)) !== me.pw.h) return J({ error: 'La contraseña actual no es correcta.' }, 400);
          if (String(b.pass).length < 6) return J({ error: 'La contraseña nueva tiene que tener al menos 6 letras o números.' }, 400);
          me.pw = await pwRec(String(b.pass)); me.v = (me.v || 0) + 1; await KV.put('u:' + me.id, JSON.stringify(me));
          return J(await session(env, me));
        }
        return J({ ok: true });
      }

      // Copia de tus datos entre aparatos
      if (P === '/sync') {
        const idx = {}; let cur;
        do {
          const l = await KV.list({ prefix: 's:' + me.id + ':', cursor: cur });
          l.keys.forEach(k => { idx[k.name.slice(3 + me.id.length)] = (k.metadata && k.metadata.t) || 1; });
          cur = l.list_complete ? null : l.cursor;
        } while (cur);
        return J(idx);
      }
      if (P.startsWith('/sync/')) {
        const name = P.slice(6);
        if (!SYNC_OK.test(name)) return J({ error: 'nombre' }, 400);
        const k = 's:' + me.id + ':' + name;
        if (req.method === 'GET') return raw(await KV.get(k), cors);
        if (req.method === 'PUT') {
          const t = +url.searchParams.get('t');   // la hora va en la dirección: así no hace falta leer todo el paquete
          if (!t) return J({ error: 'datos' }, 400);
          await KV.put(k, await req.text(), { metadata: { t } });
          return J({ ok: true, t });
        }
      }
      // Lo que ven tus amigos (perfil público, resumen y salidas sin la zona de casa)
      if (P.startsWith('/pub/') && req.method === 'PUT') {
        const name = P.slice(5);
        if (!PUB_OK.test(name)) return J({ error: 'nombre' }, 400);
        await KV.put('p:' + me.id + ':' + name, await req.text());
        return J({ ok: true });
      }
      let m = /^\/u\/([\w-]+)\/([\w.-]+)$/.exec(P);
      if (m && req.method === 'GET') {
        if (!PUB_OK.test(m[2])) return J({ error: 'nombre' }, 400);
        if (!(await canSee(m[1]))) return J({ error: 'privado' }, 403);
        return raw(await KV.get('p:' + m[1] + ':' + m[2]), cors);
      }

      // Amigos
      if (P === '/usuarios') return J(await usersList(KV));
      if (P === '/amigos') return J({ ...(await getFw(KV, me.id)), users: await usersList(KV) });
      m = /^\/(seguir|aceptar|quitar|dejar)\/([\w-]+)$/.exec(P);
      if (m && req.method === 'POST') {
        const [, act, uid] = m;
        if (uid === me.id) return J({ error: 'yo' }, 400);
        if (!(await KV.get('u:' + uid))) return J({ error: 'no existe' }, 404);
        const a = await getFw(KV, me.id), b = await getFw(KV, uid);
        if (act === 'seguir') { if (a.out[uid] !== 'ok') { a.out[uid] = 'pend'; b.in[me.id] = 'pend'; await notify(KV, uid, { k: 'seg', u: me.id }); } }
        if (act === 'aceptar') { if (a.in[uid] !== 'pend') return J({ error: 'no hay solicitud' }, 400); a.in[uid] = 'ok'; b.out[me.id] = 'ok'; await notify(KV, uid, { k: 'acep', u: me.id }); }
        if (act === 'quitar') { delete a.in[uid]; delete b.out[me.id]; }
        if (act === 'dejar') { delete a.out[uid]; delete b.in[me.id]; }
        await KV.put('fw:' + me.id, JSON.stringify(a)); await KV.put('fw:' + uid, JSON.stringify(b));
        return J(a);
      }

      // ----- Grupetas: grupos con nombre; dentro todos ven a todos
      if (P === '/grupos' && req.method === 'GET') {
        const ids = JSON.parse(await KV.get('ug:' + me.id) || '[]'), groups = [];
        for (const id of ids) { const g = JSON.parse(await KV.get('gr:' + id) || 'null'); if (g && g.members[me.id]) groups.push({ ...g, members: Object.keys(g.members) }); }
        return J({ groups, users: await usersList(KV) });
      }
      if (P === '/grupos' && req.method === 'POST') {
        const b = await body(), name = String(b.name || '').trim().slice(0, 40);
        if (name.length < 2) return J({ error: 'Ponle un nombre a la grupeta.' }, 400);
        const id = 'g' + Date.now().toString(36) + rnd(3);
        let code = (name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase() || 'GRUPETA') + '-' + rnd(4).toUpperCase();
        const g = { id, name, admin: me.id, code, members: { [me.id]: Date.now() }, t: Date.now() };
        await KV.put('gr:' + id, JSON.stringify(g)); await KV.put('gcode:' + code.toLowerCase(), id); await ugAdd(KV, me.id, id);
        return J({ ...g, members: Object.keys(g.members) });
      }
      if (P === '/grupos/unirse' && req.method === 'POST') {
        const b = await body(), gid = await KV.get('gcode:' + String(b.code || '').trim().toLowerCase());
        const g = gid && JSON.parse(await KV.get('gr:' + gid) || 'null');
        if (!g) return J({ error: 'No hay ninguna grupeta con ese código. Revisa que esté bien escrito.' }, 404);
        if (!g.members[me.id]) { g.members[me.id] = Date.now(); await KV.put('gr:' + g.id, JSON.stringify(g)); await ugAdd(KV, me.id, g.id); if (g.admin !== me.id) await notify(KV, g.admin, { k: 'gjoin', u: me.id, x: g.name }); }
        return J({ ...g, members: Object.keys(g.members) });
      }
      m = /^\/grupos\/([\w-]+)\/(salir|quitar|nombre|salidas|chat)(?:\/([\w-]+))?$/.exec(P);
      if (m) {
        const [, gid, act, sub] = m; const g = JSON.parse(await KV.get('gr:' + gid) || 'null');
        if (!g || !g.members[me.id]) return J({ error: 'No estás en esa grupeta.' }, 403);
        const gAdmin = g.admin === me.id;
        const b = req.method === 'POST' ? await body() : {};
        if (act === 'salir' && req.method === 'POST') {
          delete g.members[me.id];
          if (gAdmin) { const rest = Object.keys(g.members); g.admin = rest[0] || null; }
          await KV.put('gr:' + gid, JSON.stringify(g)); await ugDel(KV, me.id, gid); return J({ ok: true });
        }
        if (act === 'quitar' && req.method === 'POST') {
          if (!gAdmin) return J({ error: 'Solo quien lleva la grupeta puede quitar gente.' }, 403);
          const uid = String(b.uid || ''); if (uid && uid !== me.id) { delete g.members[uid]; await KV.put('gr:' + gid, JSON.stringify(g)); await ugDel(KV, uid, gid); }
          return J({ ...g, members: Object.keys(g.members) });
        }
        if (act === 'nombre' && req.method === 'POST') {
          if (!gAdmin) return J({ error: 'Solo quien lleva la grupeta puede cambiar el nombre.' }, 403);
          const n = String(b.name || '').trim().slice(0, 40); if (n.length >= 2) { g.name = n; await KV.put('gr:' + gid, JSON.stringify(g)); }
          return J({ ...g, members: Object.keys(g.members) });
        }
        if (act === 'salidas') {
          const S = JSON.parse(await KV.get('gs:' + gid) || '{}');
          if (req.method === 'GET') { const now = Date.now(); for (const k in S) if (S[k].when < now - 2 * 86400000) delete S[k]; return J(S); }
          if (!sub) {   // proponer una salida
            const when = +b.when, title = String(b.title || '').trim().slice(0, 100);
            if (!when || !title) return J({ error: 'Pon el día, la hora y un título.' }, 400);
            const r = b.route || {};
            const sid = 's' + Date.now().toString(36) + rnd(3);
            S[sid] = { id: sid, by: me.id, t: Date.now(), when, title, notes: String(b.notes || '').slice(0, 1000),
              route: { coords: line(r.coords).slice(0, 400).map(p => [p[0], p[1]]), km: +r.km || null, up: +r.up || null, mode: String(r.mode || '').slice(0, 10), link: String(r.link || '').slice(0, 4000) },
              going: { [me.id]: Date.now() }, no: {} };
            for (const k in S) if (S[k].when < Date.now() - 7 * 86400000) delete S[k];
            await KV.put('gs:' + gid, JSON.stringify(S));
            for (const uid of Object.keys(g.members)) if (uid !== me.id) await notify(KV, uid, { k: 'gsal', u: me.id, x: title, g: gid, n: g.name });
            return J(S);
          }
          const sa = S[sub]; if (!sa) return J({ error: 'Esa salida ya no está.' }, 404);
          if (b.del) { if (sa.by !== me.id && !gAdmin) return J({ error: 'Solo quien la propuso puede quitarla.' }, 403); delete S[sub]; }
          else if (b.go === true) { sa.going[me.id] = Date.now(); delete sa.no[me.id]; if (sa.by !== me.id) await notify(KV, sa.by, { k: 'gvoy', u: me.id, x: sa.title, g: gid }); }
          else if (b.go === false) { delete sa.going[me.id]; sa.no[me.id] = Date.now(); }
          await KV.put('gs:' + gid, JSON.stringify(S));
          return J(S);
        }
        if (act === 'chat') {
          const C = JSON.parse(await KV.get('gc:' + gid) || '[]');
          if (req.method === 'GET') return J(C);
          if (b.del) { const i = C.findIndex(x => x.id === b.del && (x.u === me.id || gAdmin)); if (i >= 0) C.splice(i, 1); }
          else { const x = String(b.x || '').trim().slice(0, 1000); if (!x) return J({ error: 'vacío' }, 400); C.push({ id: 'm' + Date.now().toString(36) + rnd(3), u: me.id, t: Date.now(), x }); }
          const out = C.slice(-200); await KV.put('gc:' + gid, JSON.stringify(out)); return J(out);
        }
        return J({ error: 'no existe' }, 404);
      }

      // Me gusta y comentarios
      m = /^\/soc\/([\w-]+)$/.exec(P);
      if (m && req.method === 'GET') {
        if (!(await canSee(m[1]))) return J({ error: 'privado' }, 403);
        return raw(await KV.get('soc:' + m[1]) || '{}', cors);
      }
      m = /^\/soc\/([\w-]+)\/([^/]{1,300})$/.exec(P);
      if (m && req.method === 'POST') {
        const owner = m[1]; let rid; try { rid = decodeURIComponent(m[2]).slice(0, 200); } catch (e) { return J({ error: 'nombre' }, 400); }
        if (!(await canSee(owner))) return J({ error: 'privado' }, 403);
        const b = await body();
        const all = JSON.parse(await KV.get('soc:' + owner) || '{}');
        const s = all[rid] = all[rid] || { l: [], c: [] };
        const rn = String(b.n || '').slice(0, 80);
        if (b.like === true && !s.l.includes(me.id)) { s.l.push(me.id); if (owner !== me.id) await notify(KV, owner, { k: 'like', u: me.id, r: rid, n: rn }); }
        if (b.like === false) s.l = s.l.filter(x => x !== me.id);
        if (b.com) {
          const x = String(b.com).trim().slice(0, 1000);
          if (x) { s.c.push({ id: 'c' + Date.now().toString(36) + rnd(3), u: me.id, t: Date.now(), x }); if (owner !== me.id) await notify(KV, owner, { k: 'com', u: me.id, r: rid, n: rn, x: x.slice(0, 80) }); }
        }
        if (b.del) s.c = s.c.filter(c => !(c.id === b.del && (c.u === me.id || owner === me.id)));
        if (!s.l.length && !s.c.length) delete all[rid];
        await KV.put('soc:' + owner, JSON.stringify(all));
        return J(all[rid] || { l: [], c: [] });
      }
      if (P === '/avisos') return raw(await KV.get('nt:' + me.id) || '[]', cors);

      // Mapa compartido: opiniones de sitios, sitios añadidos u ocultados y fuentes
      if (P === '/g' && req.method === 'GET') {
        return J({ l: JSON.parse(await KV.get('g:l') || '{}'), f: JSON.parse(await KV.get('g:f') || '{}'), t: JSON.parse(await KV.get('g:t') || '{}'), c: JSON.parse(await KV.get('g:c') || '{}') });
      }
      if (P === '/g' && req.method === 'POST') {
        const b = await body(), ops = Array.isArray(b.ops) ? b.ops.slice(0, 500) : [];
        const G = await gLoad(KV), PR = JSON.parse(await KV.get('g:p') || '{}');
        let np = 0; const now = Date.now();
        for (const o of ops) {
          if (!String(o.id || '')) continue;
          // fuentes, sitios y colores de trialeras solo los cambia David; los demás proponen o avisan
          if (o.k === 'aviso' || (!isAdmin && MOD_OPS.includes(o.k))) { PR['p' + now.toString(36) + rnd(4)] = { op: o, by: me.id, t: now }; np++; continue; }
          applyOp(G, o, me.id, isAdmin);
        }
        await gSave(KV, G);
        if (np) {
          await KV.put('g:p', JSON.stringify(PR));
          const adm = await KV.get('admin'); if (adm && adm !== me.id) await notify(KV, adm, { k: 'prop', u: me.id, x: np === 1 ? opText(ops.find(o => o.k === 'aviso' || MOD_OPS.includes(o.k))) : np + ' propuestas' });
        }
        return J({ l: G.l, f: G.f, t: G.t, c: G.c, pend: np });
      }

      // Strava de cada uno
      if (P === '/strava/quitar' && req.method === 'POST') {
        const tok = JSON.parse(await KV.get('tok:' + me.id) || 'null');
        if (tok && tok.ath) await KV.delete('ath:' + tok.ath);
        await KV.delete('tok:' + me.id);
        if (me.strava) { me.strava = null; await KV.put('u:' + me.id, JSON.stringify(me)); }
        return J({ ok: true });
      }
      if (P.startsWith('/api/')) {
        const path = P.slice(5);
        if (!API_OK.test(path)) return J({ error: 'ruta' }, 404);
        let tok = JSON.parse(await KV.get('tok:' + me.id) || 'null');
        if (!tok) return J({ error: 'sin conectar' }, 409);
        if (tok.e < Date.now() / 1000 + 120) {
          const r = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: env.STRAVA_ID, client_secret: env.STRAVA_SECRET, grant_type: 'refresh_token', refresh_token: tok.r }),
          });
          const t = await r.json();
          if (!r.ok || !t.access_token) return J({ error: 'renovar' }, 409);
          tok = { ...tok, a: t.access_token, r: t.refresh_token, e: t.expires_at };
          await KV.put('tok:' + me.id, JSON.stringify(tok));
        }
        const s = await fetch('https://www.strava.com/api/v3/' + path + url.search, { headers: { Authorization: 'Bearer ' + tok.a } });
        return new Response(s.body, { status: s.status === 401 ? 409 : s.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // Solo David: invitaciones y contraseñas olvidadas
      if (P.startsWith('/admin')) {
        if (!isAdmin) return J({ error: 'solo el administrador' }, 403);
        if (P === '/admin' && req.method === 'GET') {
          const codes = JSON.parse(await KV.get('invs') || '[]');
          const invs = [];
          for (const c of codes) { const i = JSON.parse(await KV.get('inv:' + c) || 'null'); if (i) invs.push(i); }
          return J({ invs, users: await usersList(KV), props: JSON.parse(await KV.get('g:p') || '{}') });
        }
        const b = await body();
        if (P === '/admin/propuestas' && req.method === 'POST') {
          const PR = JSON.parse(await KV.get('g:p') || '{}'), pr = PR[b.pid];
          if (!pr) return J({ error: 'Esa propuesta ya no está.' }, 404);
          const G = await gLoad(KV);
          if (b.ok) {
            const o = pr.op;
            if (o.k === 'aviso') {
              if (G.f[o.id]) delete G.f[o.id];
              else applyOp(G, { k: 'oculto', id: o.id, m: o.m || {}, on: true }, me.id, true);
            } else applyOp(G, o, pr.by, true);
            await gSave(KV, G);
          }
          delete PR[b.pid]; await KV.put('g:p', JSON.stringify(PR));
          if (pr.by !== me.id) await notify(KV, pr.by, { k: b.ok ? 'propok' : 'propno', u: me.id, x: opText(pr.op) });
          return J({ ok: true, l: G.l, f: G.f, t: G.t, c: G.c });
        }
        if (P === '/admin/invitar' && req.method === 'POST') {
          const code = String(b.code || '').trim();
          if (!CODE_OK.test(code)) return J({ error: 'El código solo puede llevar letras, números y guiones (entre 3 y 30).' }, 400);
          if (await KV.get('inv:' + code.toLowerCase())) return J({ error: 'Ese código ya existe.' }, 400);
          const inv = { code, tipo: 'alta', t: Date.now(), by: me.id, used: null, g: b.g ? String(b.g).slice(0, 40) : null };
          await KV.put('inv:' + code.toLowerCase(), JSON.stringify(inv)); await idxAdd(KV, 'invs', code.toLowerCase());
          return J(inv);
        }
        if (P === '/admin/anular' && req.method === 'POST') {
          const c = String(b.code || '').toLowerCase(), i = JSON.parse(await KV.get('inv:' + c) || 'null');
          if (i && !i.used) await KV.delete('inv:' + c);
          await idxDel(KV, 'invs', c);
          return J({ ok: true });
        }
        if (P === '/admin/clave' && req.method === 'POST') {
          const u = JSON.parse(await KV.get('u:' + b.uid) || 'null');
          if (!u) return J({ error: 'no existe' }, 404);
          const code = 'CLAVE-' + rnd(6).toUpperCase();
          const inv = { code, tipo: 'clave', uid: u.id, name: u.name, t: Date.now(), by: me.id, used: null };
          await KV.put('inv:' + code.toLowerCase(), JSON.stringify(inv), { expirationTtl: 7 * 86400 }); await idxAdd(KV, 'invs', code.toLowerCase());
          return J(inv);
        }
      }
      return J({ error: 'no existe' }, 404);
    } catch (e) {
      return json({ error: 'Algo ha fallado: ' + (e.message || e) }, 500, cors);
    }
  },
};


// ---------- grupetas ----------
async function ugAdd(KV, uid, gid) { const l = JSON.parse(await KV.get('ug:' + uid) || '[]'); if (!l.includes(gid)) { l.push(gid); await KV.put('ug:' + uid, JSON.stringify(l)); } }
async function ugDel(KV, uid, gid) { const l = JSON.parse(await KV.get('ug:' + uid) || '[]'); if (l.includes(gid)) await KV.put('ug:' + uid, JSON.stringify(l.filter(x => x !== gid))); }
async function mates(KV, a, b) {   // ¿están los dos en alguna grupeta?
  const la = JSON.parse(await KV.get('ug:' + a) || '[]'); if (!la.length) return false;
  const lb = JSON.parse(await KV.get('ug:' + b) || '[]');
  for (const id of la) if (lb.includes(id)) { const g = JSON.parse(await KV.get('gr:' + id) || 'null'); if (g && g.members[a] && g.members[b]) return true; }
  return false;
}
// ---------- mapa compartido ----------
const MOD_OPS = ['sitio', 'sitio-', 'oculto', 'fuente', 'fuente-', 'color', 'color-'];
async function gLoad(KV) { const g = {}; for (const k of ['l', 'f', 't', 'c']) g[k] = JSON.parse(await KV.get('g:' + k) || '{}'); g._ch = {}; return g; }
async function gSave(KV, g) { for (const k of ['l', 'f', 't', 'c']) if (g._ch[k]) await KV.put('g:' + k, JSON.stringify(g[k])); }
const meta = (o) => ({ name: String(o.name || '').slice(0, 80), lat: +o.lat, lon: +o.lon, cat: String(o.cat || '').slice(0, 20) });
const line = (c) => Array.isArray(c) ? c.slice(0, 400).map(p => [+p[0], +p[1], p[2] == null ? null : +p[2]]).filter(p => isFinite(p[0]) && isFinite(p[1])) : [];
function applyOp(G, o, by, admin) {
  const id = String(o.id || '').slice(0, 80), now = Date.now(), L = G.l, F = G.f, T = G.t, C = G.c;
  if (o.k === 'op') {
    const p = L[id] = L[id] || { m: meta(o.m || {}), o: {} };
    if (o.o) p.o[by] = { nota: +o.o.nota || null, precio: +o.o.precio || null, txt: String(o.o.txt || '').slice(0, 1000), t: +o.o.t || now };
    else delete p.o[by];
    G._ch.l = 1;
  } else if (o.k === 'oculto') {
    const p = L[id] = L[id] || { m: meta(o.m || {}), o: {} };
    if (o.on) p.h = { by, t: +o.t || now }; else delete p.h; G._ch.l = 1;
  } else if (o.k === 'sitio') {
    const p = L[id] = L[id] || { o: {} }; p.m = { ...meta(o.m || {}), add: true, by, t: +o.t || now }; G._ch.l = 1;
  } else if (o.k === 'sitio-') {
    if (L[id] && (!L[id].m || L[id].m.by === by || admin)) { delete L[id]; G._ch.l = 1; }
  } else if (o.k === 'fuente') {
    if (isFinite(+o.lat) && isFinite(+o.lon)) { F[id] = { lat: +o.lat, lon: +o.lon, name: String(o.name || '').slice(0, 80), by, t: +o.t || now }; G._ch.f = 1; }
  } else if (o.k === 'fuente-') {
    if (F[id] && (F[id].by === by || admin)) { delete F[id]; G._ch.f = 1; }
  } else if (o.k === 'tramo') {
    const c = line(o.coords);
    if (c.length >= 2 && (!T[id] || T[id].by === by || admin)) { T[id] = { name: String(o.name || '').slice(0, 80), coords: c, by, t: now }; G._ch.t = 1; }
  } else if (o.k === 'tramo-') {
    if (T[id] && (T[id].by === by || admin)) { delete T[id]; G._ch.t = 1; }
  } else if (o.k === 'color') {   // color corregido de una trialera
    const c = line(o.coords), lv = +o.lv;
    if (c.length >= 2 && lv >= 0 && lv <= 4) { C[id] = { coords: c, lv, name: String(o.name || '').slice(0, 80), by, t: now }; G._ch.c = 1; }
  } else if (o.k === 'color-') {
    if (C[id]) { delete C[id]; G._ch.c = 1; }
  }
}
function opText(o) {
  if (!o) return '';
  const n = (o.m && o.m.name) || o.name || '';
  const LV = ['verde', 'azul', 'roja', 'negra', 'doble negra'];
  return { aviso: `avisa en «${n}»: ${String(o.txt || '').slice(0, 80)}`, fuente: `propone añadir la fuente «${n || 'sin nombre'}»`, 'fuente-': 'propone borrar una fuente',
    sitio: `propone añadir «${n}»`, 'sitio-': `propone borrar «${n}»`, oculto: `propone ocultar «${n}»`, color: `propone poner «${n || 'una trialera'}» en ${LV[+o.lv] || ''}`, 'color-': 'propone quitar un color' }[o.k] || 'hace una propuesta';
}

// ---------- ayudas ----------
const te = new TextEncoder();
function json(o, status, cors) { return new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } }); }
function raw(v, cors) { return new Response(v || 'null', { headers: { ...cors, 'Content-Type': 'application/json' } }); }
function rnd(n) { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; crypto.getRandomValues(new Uint8Array(n)).forEach(x => s += a[x % a.length]); return s; }
function b64u(bytes) { let s = ''; new Uint8Array(bytes).forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64enc(str) { return b64u(te.encode(str)); }
function b64dec(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); return new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))); }
async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(salt), iterations: ITER }, k, 256));
}
async function pwRec(pw) { const s = rnd(16); return { s, h: await hashPw(pw, s) }; }
function checkNew(b) {
  const user = String(b.user || '').trim().toLowerCase();
  if (!USER_OK.test(user)) return 'El usuario tiene que tener entre 3 y 20 letras o números, sin espacios ni acentos.';
  if (String(b.pass || '').length < 6) return 'La contraseña tiene que tener al menos 6 letras o números.';
  if (!String(b.name || '').trim()) return 'Escribe tu nombre o apodo.';
  return null;
}
async function newUser(KV, b, admin) {
  const id = Date.now().toString(36) + rnd(4);
  const u = { id, user: String(b.user).trim().toLowerCase(), name: String(b.name).trim().slice(0, 30), pw: await pwRec(String(b.pass)), v: 1, t: Date.now(), strava: null };
  await KV.put('u:' + id, JSON.stringify(u)); await KV.put('login:' + u.user, id);
  await usersPut(KV, u);
  return u;
}
const pubUser = u => ({ id: u.id, user: u.user, name: u.name });
async function usersList(KV) { return JSON.parse(await KV.get('users') || '[]'); }
async function usersPut(KV, u) { const l = (await usersList(KV)).filter(x => x.id !== u.id); l.push(pubUser(u)); await KV.put('users', JSON.stringify(l)); }
async function idxAdd(KV, k, v) { const l = JSON.parse(await KV.get(k) || '[]'); if (!l.includes(v)) { l.push(v); await KV.put(k, JSON.stringify(l)); } }
async function idxDel(KV, k, v) { const l = JSON.parse(await KV.get(k) || '[]'); if (l.includes(v)) await KV.put(k, JSON.stringify(l.filter(x => x !== v))); }
async function getFw(KV, uid) { const f = JSON.parse(await KV.get('fw:' + uid) || 'null') || {}; f.in = f.in || {}; f.out = f.out || {}; return f; }
async function notify(KV, uid, n) { const l = JSON.parse(await KV.get('nt:' + uid) || '[]'); l.unshift({ ...n, t: Date.now() }); await KV.put('nt:' + uid, JSON.stringify(l.slice(0, 60))); }
async function hkey(env) { return crypto.subtle.importKey('raw', te.encode('ichnos-sesion:' + env.STRAVA_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); }
async function session(env, u) {
  const b = b64enc(u.id + '.' + (u.v || 1) + '.' + (Date.now() + 400 * 86400000));
  const t = b + '.' + b64u(await crypto.subtle.sign('HMAC', await hkey(env), te.encode(b)));
  return { t, ...pubUser(u), admin: (await env.KV.get('admin')) === u.id, strava: !!u.strava };
}
async function auth(env, tok) {
  const [b, sig] = String(tok || '').split('.');
  if (!b || !sig) return null;
  if (b64u(await crypto.subtle.sign('HMAC', await hkey(env), te.encode(b))) !== sig) return null;
  const [uid, v, exp] = b64dec(b).split('.');
  if (+exp < Date.now()) return null;
  const u = JSON.parse(await env.KV.get('u:' + uid) || 'null');
  return u && String(u.v || 1) === v ? u : null;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function page(title, body) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ichnos</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1E2328;color:#fff;font:17px/1.5 -apple-system,system-ui,sans-serif;padding:20px;box-sizing:border-box}
div{max-width:440px}h1{font-size:30px;margin:0 0 12px}h1 span{color:#B6E22E}</style>
<div><h1>ICH<span>NOS</span> · ${title}</h1><p>${body}</p></div>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

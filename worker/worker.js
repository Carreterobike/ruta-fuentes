// ===== Puente de Ichnos (Cloudflare Worker) · versión 2: cuentas, amigos y Strava para todos =====
// Necesita: STRAVA_ID (variable), STRAVA_SECRET (secreto) y un espacio KV enlazado con el nombre KV.
const API_OK = /^(athlete|athlete\/activities|activities\/\d+|activities\/\d+\/(streams|photos)|gear\/[\w-]+|segments\/explore|segments\/\d+)$/;
const APP_OK = /^https:\/\/carreterobike\.github\.io\/ruta-fuentes\//;
const USER_OK = /^[a-z0-9._-]{3,20}$/;
const CODE_OK = /^[A-Za-z0-9ñÑ._-]{3,30}$/;
const SYNC_OK = /^[\w.-]{1,80}$/;
const PUB_OK = /^(pub|resumen|p-\d{4}-\d{2})$/;
const ITER = 20000;

let CTX = null;   // para mandar los avisos al móvil sin hacer esperar a quien los provoca
export default {
  async fetch(req, env, ctx) {
    CTX = ctx || null;
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, X-Ichnos-Key, X-Ichnos-Build, Content-Type',
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
      if (P === '/push/key') return J({ key: (await vapid(KV)).pub });
      // Strava avisa aquí al momento cuando alguien conectado sube una salida
      if (P === '/strava/hook') {
        if (req.method === 'GET') { const vt = await KV.get('sthookvt');
          if (url.searchParams.get('hub.mode') === 'subscribe' && vt && url.searchParams.get('hub.verify_token') === vt) return J({ 'hub.challenge': url.searchParams.get('hub.challenge') });
          return J({ error: 'no' }, 403); }
        if (req.method === 'POST') { const ev = await body(); const p = onStravaEvent(env, KV, ev).catch(() => { }); if (CTX && CTX.waitUntil) CTX.waitUntil(p); return J({ ok: true }); }
      }
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
          else { const x = String(b.x || '').trim().slice(0, 1000); if (!x) return J({ error: 'vacío' }, 400); C.push({ id: 'm' + Date.now().toString(36) + rnd(3), u: me.id, t: Date.now(), x });
            const who = me.name || 'Alguien'; for (const uid of Object.keys(g.members || {})) if (uid !== me.id) pushLater(KV, uid, { title: (g.name || 'Grupeta') + ' · ' + who, body: x.slice(0, 140), url: './#grupeta', tag: 'chat-' + gid }); }
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
      // avisos en el móvil (web push): la app pide permiso y manda aquí su suscripción
      if (P === '/push/sub' && req.method === 'POST') {
        const b = await body(); const sub = b.sub; if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return J({ error: 'suscripción' }, 400);
        const l = JSON.parse(await KV.get('push:' + me.id) || '[]').filter(x => x.endpoint !== sub.endpoint);
        l.unshift({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, t: Date.now() }); await KV.put('push:' + me.id, JSON.stringify(l.slice(0, 6)));
        if (b.test) await pushTo(KV, me.id, { title: 'Ichnos', body: 'Así te llegarán los avisos de tu grupeta.', url: './' });
        return J({ ok: true });
      }
      if (P === '/push/estado') return raw(await KV.get('pushlast:' + me.id) || '{}', cors);
      if (P === '/push/prefs') { if (req.method === 'POST') { const b = await body(); const pp = { own: b.own !== false, fr: b.fr !== false }; await KV.put('pp:' + me.id, JSON.stringify(pp)); return J(pp); } return J(await pPrefs(KV, me.id)); }
      if (P === '/push/quitar' && req.method === 'POST') { const b = await body(); const l = JSON.parse(await KV.get('push:' + me.id) || '[]').filter(x => x.endpoint !== b.endpoint); await KV.put('push:' + me.id, JSON.stringify(l)); return J({ ok: true }); }
      // "Algo va mal": el aviso llega al administrador con lo que estaba pasando en la app
      if (P === '/fallo' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const id = 'bug:' + Date.now() + ':' + me.id;
        const rec = { id, u: me.id, t: Date.now(), auto: !!b.auto, txt: String(b.txt || '').slice(0, 2000), info: b.info && typeof b.info === 'object' ? JSON.parse(JSON.stringify(b.info).slice(0, 20000) || '{}') : {}, foto: typeof b.foto === 'string' && b.foto.startsWith('data:image/') && b.foto.length < 600000 ? b.foto : null };
        await KV.put(id, JSON.stringify(rec), { expirationTtl: 90 * 86400 });
        const adm = await KV.get('admin');
        if (adm) await notify(KV, adm, { k: 'bug', u: me.id, x: (rec.auto ? '[automático] ' : '') + rec.txt.slice(0, 140), id });
        return J({ ok: 1 });
      }
      if (P === '/fallos' && (await KV.get('admin')) === me.id) {
        const L = await KV.list({ prefix: 'bug:' }); const out = [];
        for (const k of L.keys.slice(-40).reverse()) { const v = JSON.parse(await KV.get(k.name) || 'null'); if (v) { v.foto = !!v.foto; out.push(v); } }
        return J(out);
      }
      if (P.startsWith('/fallos/') && (await KV.get('admin')) === me.id) return raw(await KV.get(decodeURIComponent(P.slice(8))) || 'null', cors);

      // Mapa compartido: opiniones de sitios, sitios añadidos u ocultados y fuentes
      // Lo compartido de la grupeta vive en un "Durable Object": atiende los cambios de uno en uno (no se pisan aunque guardéis a la vez)
      const GS = env.GSTORE ? async (o) => (await env.GSTORE.get(env.GSTORE.idFromName('g')).fetch('https://g/', { method: 'POST', body: JSON.stringify(o) })).json() : null;
      if (P === '/g' && req.method === 'POST' && +(req.headers.get('X-Ichnos-Build') || 0) < MIN_BUILD)
        return J({ error: 'Tu Ichnos es una versión vieja: ciérrala del todo y ábrela otra vez para actualizarla.', viejo: 1 }, 426);
      if (GS && P === '/g' && req.method === 'GET') return J(await GS({ act: 'get' }));
      if (GS && P === '/g' && req.method === 'POST') {
        const b = await body(), ops = Array.isArray(b.ops) ? b.ops.slice(0, 500) : [];
        const r = await GS({ act: 'post', ops, by: me.id, admin: isAdmin });
        if (r.pend) { const adm = await KV.get('admin'); if (adm && adm !== me.id) await notify(KV, adm, { k: 'prop', u: me.id, x: r.x }); }
        delete r.x; return J(r);
      }
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
        if (P === '/admin/hook') return J({ hook: JSON.parse(await KV.get('sthook') || 'null'), last: JSON.parse(await KV.get('sthooklast') || 'null') });
        if (P === '/admin' && req.method === 'GET') {
          const codes = JSON.parse(await KV.get('invs') || '[]');
          const invs = [];
          for (const c of codes) { const i = JSON.parse(await KV.get('inv:' + c) || 'null'); if (i) invs.push(i); }
          return J({ invs, users: await usersList(KV), props: GS ? await GS({ act: 'props' }) : JSON.parse(await KV.get('g:p') || '{}') });
        }
        const b = await body();
        if (GS && P === '/admin/propuestas' && req.method === 'POST') {
          const r = await GS({ act: 'decide', pid: b.pid, ok: !!b.ok, by: me.id });
          if (r.error) return J({ error: r.error }, 404);
          if (r.pby !== me.id) await notify(KV, r.pby, { k: b.ok ? 'propok' : 'propno', u: me.id, x: r.x });
          return J({ ok: true, l: r.l, f: r.f, t: r.t, c: r.c });
        }
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
  // cada 10 minutos: dar de alta el aviso de Strava (una vez) y mirar si hay salidas nuevas en Intervals.icu
  async scheduled(ev, env, ctx) { CTX = ctx || null; if (!env.KV) return;
    const run = (async () => { try { await ensureHook(env, env.KV); } catch (e) { } try { await stravaRetry(env, env.KV); } catch (e) { } try { await pollIcu(env, env.KV); } catch (e) { } })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(run); else await run; },
};

// ---------- avisos de salidas nuevas ----------
const HOOK_URL = 'https://ichnos-strava.dcarreterov86.workers.dev/strava/hook';
async function pPrefs(KV, uid) { return Object.assign({ own: true, fr: true }, JSON.parse(await KV.get('pp:' + uid) || '{}')); }
const kmTxt = m => (m / 1000).toFixed(1).replace('.', ',');
function tipoTxt(t) { t = String(t || ''); return /Ride/i.test(t) ? 'en bici' : /Run/i.test(t) ? 'a correr' : /Hike/i.test(t) ? 'de ruta a pie' : /Walk/i.test(t) ? 'a caminar' : 'a hacer deporte'; }
async function stravaTok(env, KV, uid) { let tok = JSON.parse(await KV.get('tok:' + uid) || 'null'); if (!tok) return null;
  if (tok.e < Date.now() / 1000 + 120) { const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.STRAVA_ID, client_secret: env.STRAVA_SECRET, grant_type: 'refresh_token', refresh_token: tok.r }) });
    const t = await r.json().catch(() => ({})); if (!r.ok || !t.access_token) return null; tok = { ...tok, a: t.access_token, r: t.refresh_token, e: t.expires_at }; await KV.put('tok:' + uid, JSON.stringify(tok)); }
  return tok; }
// ---------- la salida se sube sola a Ichnos (sin abrir la app) ----------
// Se guarda en un paquete propio "r-AAAA-MM-…": la app lo junta con lo demás la próxima vez que se abre.
const W_RAD = Math.PI / 180;
function wDist(a, b) { const dLa = (b[0] - a[0]) * W_RAD, dLo = (b[1] - a[1]) * W_RAD, x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * W_RAD) * Math.cos(b[0] * W_RAD) * Math.sin(dLo / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(x)); }
function wGain(es, th = 2) { if (!es || !es.length) return null; let up = 0, base = null, n = 0;
  for (const e of es) { if (e == null || !isFinite(e)) continue; n++; if (base == null) { base = e; continue; } if (e > base + th) { up += e - base; base = e; } else if (e < base - th) base = e; }
  return n > es.length * 0.5 ? Math.round(up) : null; }
function wThin(c, ts, es, ex = {}) {   // igual que en la app: un punto cada 10 m, con hora, altura, pulso, cadencia y vatios
  const out = [], tt = [], ee = [], hr = [], cad = [], pw = []; let t0 = null;
  if (ts) for (const t of ts) { if (t != null && isFinite(t)) { t0 = t; break; } }
  const num = (a, i) => a && a[i] != null && isFinite(a[i]) ? Math.round(a[i]) : null;
  c.forEach((p, i) => { if (!p || p[0] == null || p[1] == null) return; if (!out.length || wDist(out[out.length - 1], p) >= 10) {
    out.push([+(+p[0]).toFixed(5), +(+p[1]).toFixed(5)]);
    tt.push(t0 != null && ts[i] != null && isFinite(ts[i]) ? Math.round((ts[i] - t0) / 1000) : null);
    ee.push(num(es, i)); hr.push(num(ex.hr, i)); cad.push(num(ex.cad, i)); pw.push(num(ex.pw, i)); } });
  const has = a => a.filter(x => x != null).length > out.length * 0.6;
  let m = 0; for (let i = 1; i < out.length; i++) m += wDist(out[i - 1], out[i]);
  return { coords: out, times: has(tt) ? tt : null, eles: has(ee) ? ee : null, hr: has(hr) ? hr : null, cad: has(cad) ? cad : null, pw: has(pw) ? pw : null, upRaw: wGain(es), km: m / 1000 };
}
const wNrm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
function wTipo(type) { const t = wNrm(type).replace(/[_\s]+/g, ' ');
  if (!t || /virtual/.test(t)) return null; if (/trail|carrera (por|de) montana|montana.*carrera/.test(t)) return 'trail';
  if (/^run|\brun\b|carrera|correr|running/.test(t)) return 'run'; if (/hike|senderismo|excursion|trekking|alpinismo/.test(t)) return 'hike';
  if (/walk|caminata|paseo|andar/.test(t)) return 'walk'; if (/e-?mountain|e-?mtb|montana electr|electrica de montana|e ?bike|e-bike|electr/.test(t)) return 'ebike';
  if (/mountain|montana|mtb|btt/.test(t)) return 'mtb'; if (/gravel/.test(t)) return 'gravel'; if (/\bride\b|ride$|bici|cicl|velo|handcycle|bike/.test(t)) return 'road'; return null; }
async function wBike(KV, uid, tipo, gear) {   // la bici: la que se llama como en Strava, o la principal de ese tipo
  let bikes = []; try { const o = JSON.parse(await KV.get('s:' + uid + ':ichnos-bicis') || 'null'); bikes = (o && o.v) || []; } catch (e) { }
  if (!Array.isArray(bikes)) return null; const g = wNrm(gear);
  let b = g && (bikes.find(b => (b.alias || []).some(a => wNrm(a) === g)) || bikes.find(b => b.mote && g.includes(wNrm(b.mote))) || bikes.find(b => b.modelo && g.includes(wNrm(b.modelo))) || bikes.find(b => b.marca && g.includes(wNrm(b.marca))));
  if (!b && tipo) b = bikes.find(b => b.tipo === tipo && b.principal && !b.retirada) || bikes.find(b => b.tipo === tipo && !b.retirada);
  return b ? b.id : null; }
function wMonth(t) { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).formatToParts(new Date(t));
  return p.find(x => x.type === 'year').value + '-' + p.find(x => x.type === 'month').value; }
async function wStore(KV, uid, ride, tag) {
  try { const d = JSON.parse(await KV.get('s:' + uid + ':rdel') || 'null'); if (d && (d.v || []).includes(ride.id)) return false; } catch (e) { }
  const t = Date.now(); ride.mt = t;
  await KV.put('s:' + uid + ':r-' + wMonth(ride.date) + '-' + tag, JSON.stringify({ t, v: [ride] }), { metadata: { t }, expirationTtl: 400 * 86400 });
  return true; }
async function stravaImport(env, KV, uid, id) {   // → la actividad, o null si aún no se puede
  const tok = await stravaTok(env, KV, uid); if (!tok) return null;
  const H = { headers: { Authorization: 'Bearer ' + tok.a } };
  const r = await fetch('https://www.strava.com/api/v3/activities/' + id, H); if (!r.ok) return null;
  const a = await r.json(), tipo = wTipo(a.sport_type || a.type);
  if (!tipo || !a.map || !a.map.summary_polyline) return { a, skip: true };   // sin GPS (rodillo, gimnasio…): no hay nada que subir
  const s = await fetch(`https://www.strava.com/api/v3/activities/${id}/streams?keys=latlng,time,altitude,heartrate,cadence,watts&key_by_type=true`, H);
  if (!s.ok) return null; const st = await s.json(), g = k => st && st[k] && st[k].data, ll = g('latlng');
  if (!ll || ll.length < 2) return { a, skip: true };
  const t0 = Date.parse(a.start_date), tm = g('time'), ts = ll.map((_, i) => tm && tm[i] != null ? t0 + tm[i] * 1000 : null);
  const th = wThin(ll, ts, g('altitude'), { hr: g('heartrate'), cad: g('cadence'), pw: g('watts') });
  if (th.coords.length < 2) return { a, skip: true };
  const ride = { id: 'strava-' + id, name: a.name || 'Salida', date: t0, source: 'Strava', api: 1, tipo, coords: th.coords, times: th.times, eles: th.eles, hr: th.hr, cad: th.cad, pw: th.pw,
    bike: await wBike(KV, uid, tipo, a.gear && a.gear.name), km: th.km, upRaw: th.upRaw, upDev: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : null,
    movDev: a.moving_time != null ? Math.round(a.moving_time) : null, elDev: a.elapsed_time != null ? Math.round(a.elapsed_time) : null, kmDev: a.distance != null ? Math.round(a.distance) : null, srv: 1 };
  await wStore(KV, uid, ride, 's' + id);
  return { a, ride }; }
async function icuImport(KV, c, uid, a) {
  const tipo = wTipo(a.type), t0 = Date.parse(a.start_date || a.start_date_local || ''); if (!tipo || !t0) return null;
  const r = await fetch(`https://intervals.icu/api/v1/activity/${encodeURIComponent(a.id)}/streams.json?types=latlng,time,altitude,fixed_altitude,heartrate,cadence,watts`, { headers: { Authorization: c.b ? 'Bearer ' + c.b : 'Basic ' + btoa('API_KEY:' + c.k) } });
  if (!r.ok) return null; const l = await r.json(); if (!Array.isArray(l)) return null;
  const g = k => { const x = l.find(z => z && z.type === k); return x || null; }, L = g('latlng'); if (!L || !Array.isArray(L.data)) return null;
  const ll = Array.isArray(L.data2) ? L.data.map((la, i) => [la, L.data2[i]]) : L.data;   // Intervals da la latitud y la longitud por separado
  const d = k => { const x = g(k); return x && Array.isArray(x.data) ? x.data : null; };
  const tm = d('time'), ts = ll.map((_, i) => tm && tm[i] != null ? t0 + tm[i] * 1000 : null);
  const th = wThin(ll, ts, d('fixed_altitude') || d('altitude'), { hr: d('heartrate'), cad: d('cadence'), pw: d('watts') });
  if (th.coords.length < 2) return null;
  const ride = { id: 'icu-' + a.id, icu: String(a.id), name: a.name || 'Salida', date: t0, tipo, coords: th.coords, times: th.times, eles: th.eles, hr: th.hr, cad: th.cad, pw: th.pw,
    bike: await wBike(KV, uid, tipo, null), km: th.km, upRaw: th.upRaw, upDev: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : null,
    movDev: a.moving_time != null ? Math.round(a.moving_time) : null, elDev: a.elapsed_time != null ? Math.round(a.elapsed_time) : null, kmDev: a.distance != null ? Math.round(a.distance) : null, srv: 1 };
  return (await wStore(KV, uid, ride, 'i' + a.id)) ? ride : null; }
const upTxt = (a, km) => `Tu salida${a.name ? ' «' + a.name + '»' : ''} se ha subido sola a Ichnos${km ? ' · ' + km : ''}${a.total_elevation_gain ? ' · +' + Math.round(a.total_elevation_gain) + ' m' : ''}. Tócala para verla.`;
// Strava: se sube la salida y luego se avisa al dueño (las normas de Strava no dejan enseñar sus datos a otros)
async function onStravaEvent(env, KV, ev) {
  if (!ev || ev.object_type !== 'activity' || ev.aspect_type !== 'create') return;
  const hook = JSON.parse(await KV.get('sthook') || 'null'); if (hook && ev.subscription_id && String(ev.subscription_id) !== String(hook.id)) return;
  const id = String(ev.object_id); if (await KV.get('pn:s:' + id)) return;
  const uid = await KV.get('ath:' + ev.owner_id); if (!uid) return;
  await stravaDo(env, KV, uid, id, 0);
}
async function stravaDo(env, KV, uid, id, tries) {
  let res = null; try { res = await stravaImport(env, KV, uid, id); } catch (e) { }
  if (!res) {   // Strava a veces tarda en tener la salida lista: se vuelve a probar cada 10 minutos (hasta 6 veces)
    if (tries < 6) { const q = JSON.parse(await KV.get('sretry') || '[]').filter(x => x.id !== id); q.push({ uid, id, n: tries + 1 }); await KV.put('sretry', JSON.stringify(q.slice(-50))); }
    return; }
  await KV.put('pn:s:' + id, '1', { expirationTtl: 30 * 86400 });
  if (res.skip || !(await pPrefs(KV, uid)).own) return;
  await pushTo(KV, uid, { title: 'Ichnos', body: upTxt(res.a, res.a.distance ? kmTxt(res.a.distance) + ' km' : ''), url: './#salidas', tag: 's' + id });
}
async function stravaRetry(env, KV) {
  const q = JSON.parse(await KV.get('sretry') || '[]'); if (!q.length) return; await KV.put('sretry', '[]');
  for (const x of q) if (!(await KV.get('pn:s:' + x.id))) await stravaDo(env, KV, x.uid, x.id, x.n);
}
async function ensureHook(env, KV) {
  if (await KV.get('sthook')) return;
  let vt = await KV.get('sthookvt'); if (!vt) { vt = rnd(20); await KV.put('sthookvt', vt); }
  const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', { method: 'POST', body: new URLSearchParams({ client_id: env.STRAVA_ID, client_secret: env.STRAVA_SECRET, callback_url: HOOK_URL, verify_token: vt }) });
  const t = await r.json().catch(() => ({}));
  if (r.ok && t.id) { await KV.put('sthook', JSON.stringify({ id: t.id, t: Date.now() })); return; }
  const g = await fetch(`https://www.strava.com/api/v3/push_subscriptions?client_id=${encodeURIComponent(env.STRAVA_ID)}&client_secret=${encodeURIComponent(env.STRAVA_SECRET)}`);
  const l = await g.json().catch(() => []), sb = Array.isArray(l) && l[0];
  if (sb && sb.callback_url === HOOK_URL) await KV.put('sthook', JSON.stringify({ id: sb.id, t: Date.now() }));
  else await KV.put('sthooklast', JSON.stringify({ t: Date.now(), status: r.status, r: t, l }), { expirationTtl: 7 * 86400 });
}
// Intervals.icu: salidas que vienen directas del GPS → aviso a sus amigos y a su grupeta (y a él si no tiene Strava)
async function pollIcu(env, KV) {
  const users = await usersList(KV), oldest = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), newest = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  for (const u of users) {
    const c = JSON.parse(await KV.get('icu:' + u.id) || 'null'); if (!c) continue;
    let l = []; try { const r = await fetch(`https://intervals.icu/api/v1/athlete/0/activities?oldest=${oldest}&newest=${newest}`, { headers: { Authorization: c.b ? 'Bearer ' + c.b : 'Basic ' + btoa('API_KEY:' + c.k) } }); if (!r.ok) continue; l = await r.json(); } catch (e) { continue; }
    if (!Array.isArray(l)) continue;
    const sk = 'icuseen:' + u.id, seen = JSON.parse(await KV.get(sk) || 'null'), ids = l.map(a => String(a.id));
    if (!seen) { await KV.put(sk, JSON.stringify(ids)); continue; }   // la primera vez solo se apunta lo que ya había (sin avisar de lo viejo)
    const nw = l.filter(a => !seen.includes(String(a.id))); if (!nw.length) continue;
    await KV.put(sk, JSON.stringify([...new Set([...ids, ...seen])].slice(0, 300)));
    for (const a of nw) {
      if (String(a.source || '').toUpperCase() === 'STRAVA') continue;
      const st = Date.parse(a.start_date || a.start_date_local || ''); if (st && Date.now() - st > 36 * 3600e3) continue;
      if (await KV.get('pn:i:' + a.id)) continue;
      let ride = null; try { ride = await icuImport(KV, c, u.id, a); } catch (e) { }   // primero se sube, luego se avisa
      await KV.put('pn:i:' + a.id, '1', { expirationTtl: 30 * 86400 });
      const up = a.total_elevation_gain ? Math.round(a.total_elevation_gain) : 0, km = a.distance ? kmTxt(a.distance) + ' km' : '', who = u.name || 'Alguien';
      const f = await getFw(KV, u.id), to = new Set(Object.keys(f.in).filter(x => f.in[x] === 'ok'));
      for (const gid of JSON.parse(await KV.get('ug:' + u.id) || '[]')) { const g = JSON.parse(await KV.get('gr:' + gid) || 'null'); if (g) Object.keys(g.members || {}).forEach(x => to.add(x)); }
      to.delete(u.id);
      for (const x of to) if ((await pPrefs(KV, x)).fr) await pushTo(KV, x, { title: 'Ichnos', body: `${who} ha salido ${tipoTxt(a.type)}${km ? ': ' + km : ''}${up ? ' · +' + up + ' m' : ''}${a.name ? ' · «' + a.name + '»' : ''}.`, url: './#grupeta', tag: 'a' + a.id });
      if (ride && !(await KV.get('tok:' + u.id)) && (await pPrefs(KV, u.id)).own) await pushTo(KV, u.id, { title: 'Ichnos', body: upTxt(a, km), url: './#salidas', tag: 'i' + a.id });
    }
  }
}


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
const MOD_OPS = ['sitio', 'sitio-', 'oculto', 'fuente', 'fuente-', 'color', 'color-', 'trial', 'trial-'];
const MIN_BUILD = 1794859010;   // versiones de la app más viejas no pueden cambiar el mapa de todos
// ---- Lo compartido de la grupeta, de uno en uno ----
export class GStore {
  constructor(state, env) {
    this.s = state.storage; this.env = env;
    state.blockConcurrencyWhile(async () => {   // la primera vez se trae lo que había en KV
      if (!(await this.s.get('init'))) { for (const k of ['l', 'f', 't', 'c', 'p']) await this.s.put('g:' + k, JSON.parse(await env.KV.get('g:' + k) || '{}')); await this.s.put('init', 1); }
    });
  }
  async load() { const g = {}; for (const k of ['l', 'f', 't', 'c']) g[k] = (await this.s.get('g:' + k)) || {}; g._ch = {}; return g; }
  async save(g) { for (const k of ['l', 'f', 't', 'c']) if (g._ch[k]) await this.s.put('g:' + k, g[k]); }
  async fetch(req) {
    const b = await req.json(), out = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    if (b.act === 'get') { const G = await this.load(); return out({ l: G.l, f: G.f, t: G.t, c: G.c }); }
    if (b.act === 'props') return out((await this.s.get('g:p')) || {});
    if (b.act === 'post') {
      const G = await this.load(), PR = (await this.s.get('g:p')) || {}; let np = 0, x = ''; const now = Date.now();
      for (const o of b.ops || []) {
        if (!String(o.id || '')) continue;
        if (o.k === 'aviso' || (!b.admin && MOD_OPS.includes(o.k))) { PR['p' + now.toString(36) + rnd(4)] = { op: o, by: b.by, t: now }; np++; x = x || opText(o); continue; }
        applyOp(G, o, b.by, b.admin);
      }
      await this.save(G); if (np) await this.s.put('g:p', PR);
      return out({ l: G.l, f: G.f, t: G.t, c: G.c, pend: np, x: np === 1 ? x : np + ' propuestas' });
    }
    if (b.act === 'decide') {
      const PR = (await this.s.get('g:p')) || {}, pr = PR[b.pid]; if (!pr) return out({ error: 'Esa propuesta ya no está.' });
      const G = await this.load();
      if (b.ok) { const o = pr.op;
        if (o.k === 'aviso') { if (G.f[o.id]) { delete G.f[o.id]; G._ch.f = 1; } else applyOp(G, { k: 'oculto', id: o.id, m: o.m || {}, on: true }, b.by, true); }
        else applyOp(G, o, pr.by, true);
        await this.save(G); }
      delete PR[b.pid]; await this.s.put('g:p', PR);
      return out({ ok: true, pby: pr.by, x: opText(pr.op), l: G.l, f: G.f, t: G.t, c: G.c });
    }
    return out({ error: 'act' });
  }
}
async function gLoad(KV) { const g = {}; for (const k of ['l', 'f', 't', 'c']) g[k] = JSON.parse(await KV.get('g:' + k) || '{}'); g._ch = {}; return g; }
async function gSave(KV, g) { for (const k of ['l', 'f', 't', 'c']) if (g._ch[k]) await KV.put('g:' + k, JSON.stringify(g[k])); }
const meta = (o) => ({ name: String(o.name || '').slice(0, 80), lat: +o.lat, lon: +o.lon, cat: String(o.cat || '').slice(0, 20) });
const line = (c) => Array.isArray(c) ? c.slice(0, 400).map(p => [+p[0], +p[1], p[2] == null ? null : +p[2]]).filter(p => isFinite(p[0]) && isFinite(p[1])) : [];
function applyOp(G, o, by, admin) {
  const id = String(o.id || '').slice(0, 80), now = Date.now(), L = G.l, F = G.f, T = G.t, C = G.c;
  if (o.k === 'op') {
    const p = L[id] = L[id] || { m: meta(o.m || {}), o: {} };
    if (o.o) { p.o[by] = { nota: +o.o.nota || null, precio: +o.o.precio || null, txt: String(o.o.txt || '').slice(0, 1000), t: +o.o.t || now }; if (o.o.h) { p.o[by].h = String(o.o.h).slice(0, 200); p.o[by].ht = +o.o.ht || now; } }   // h = horario puesto por la grupeta
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
  } else if (o.k === 'trial') {   // trialera de la grupeta: nombre, dificultad y recorrido
    const c = line(o.coords);
    if (c.length >= 2 && (!T[id] || T[id].by === by || admin)) { const old = T[id] || {}; T[id] = { kind: 'trial', name: String(o.name || '').slice(0, 80), lv: Math.max(0, Math.min(4, +o.lv || 0)), coords: c, by: old.by || by, t: now, tm: old.tm || {}, est: old.est, com: old.com }; G._ch.t = 1; }
  } else if (o.k === 'estado') {   // cómo está la trialera hoy (lo puede decir cualquiera de la grupeta)
    if (T[id] && T[id].kind === 'trial' && ['perfecta', 'barro', 'arbol', 'limpia'].includes(o.e)) { T[id].est = { e: o.e, by, t: now }; G._ch.t = 1; }
  } else if (o.k === 'tcom') {     // comentario en la ficha de la trialera
    const txt = String(o.txt || '').trim().slice(0, 300);
    if (T[id] && T[id].kind === 'trial' && txt) { T[id].com = (T[id].com || []).concat([{ by, t: now, txt }]).slice(-30); G._ch.t = 1; }
  } else if (o.k === 'tcom-') {
    if (T[id] && T[id].com) { const n = T[id].com.length; T[id].com = T[id].com.filter(c => !(c.t === +o.ct && (c.by === by || admin))); if (T[id].com.length !== n) G._ch.t = 1; }
  } else if (o.k === 'trial-') {
    if (T[id] && T[id].kind === 'trial' && (T[id].by === by || admin)) { delete T[id]; G._ch.t = 1; }
  } else if (o.k === 'ttime') {   // tu mejor tiempo en una trialera de la grupeta (solo de salidas del GPS, no de Strava)
    const s_ = Math.round(+o.s);
    if (T[id] && T[id].kind === 'trial' && s_ > 0 && s_ < 36000) { T[id].tm = T[id].tm || {}; const cur = T[id].tm[by]; if (!cur || s_ < cur.s) { T[id].tm[by] = { s: s_, d: +o.d || now }; G._ch.t = 1; } }
  } else if (o.k === 'tramo-') {
    if (T[id] && (T[id].by === by || admin)) { delete T[id]; G._ch.t = 1; }
  } else if (o.k === 'color') {   // sistema viejo: ya no se usa (las trialeras van todas a la lista única, op 'trial')
    const c = line(o.coords), lv = +o.lv;
    if (false && c.length >= 2 && lv >= 0 && lv <= 4) { C[id] = { coords: c, lv, name: String(o.name || '').slice(0, 80), by, t: now }; G._ch.c = 1; }
  } else if (o.k === 'color-') {
    if (C[id]) { delete C[id]; G._ch.c = 1; }
  }
}
function opText(o) {
  if (!o) return '';
  const n = (o.m && o.m.name) || o.name || '';
  const LV = ['verde', 'azul', 'roja', 'negra', 'doble negra'];
  return { aviso: `avisa en «${n}»: ${String(o.txt || '').slice(0, 80)}`, fuente: `propone añadir la fuente «${n || 'sin nombre'}»`, 'fuente-': 'propone borrar una fuente',
    sitio: `propone añadir «${n}»`, 'sitio-': `propone borrar «${n}»`, oculto: `propone ocultar «${n}»`, color: `propone poner «${n || 'una trialera'}» en ${LV[+o.lv] || ''}`, 'color-': 'propone quitar un color', trial: `propone la trialera «${n || 'sin nombre'}» (${LV[+o.lv] || ''})`, 'trial-': 'propone borrar una trialera' }[o.k] || 'hace una propuesta';
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
async function notify(KV, uid, n) { const l = JSON.parse(await KV.get('nt:' + uid) || '[]'); l.unshift({ ...n, t: Date.now() }); await KV.put('nt:' + uid, JSON.stringify(l.slice(0, 60)));
  try { const u = n.u ? JSON.parse(await KV.get('u:' + n.u) || 'null') : null, w = (u && u.name) || 'Alguien', rn = n.n ? ` «${n.n}»` : '';
    const txt = { seg: `${w} quiere seguirte.`, acep: `${w} ha aceptado que le sigas.`, alta: `${w} se ha unido a Ichnos con tu invitación.`, like: `A ${w} le gusta tu salida${rn}.`,
      com: `${w} ha comentado en tu salida${rn}: “${n.x || ''}”`, gjoin: `${w} se ha unido a tu grupeta «${n.x || ''}».`, gsal: `${w} propone una salida: ${n.x || ''}.`, gvoy: `${w} se apunta a tu salida «${n.x || ''}».`,
      prop: `${w} ${n.x || 'te ha mandado un aviso'}.`, bug: `${w} dice que algo va mal: “${n.x || ''}”`, propok: `${w} ha aceptado lo que mandaste.`, propno: `${w} ha visto lo que mandaste.` }[n.k] || 'Tienes un aviso nuevo.';
    pushLater(KV, uid, { title: 'Ichnos', body: txt.slice(0, 180), url: './#avisos', tag: n.k }); } catch (e) { } }
// ---------- avisos al móvil (web push, sin servicios de fuera: las llaves las crea el propio puente) ----------
function pushLater(KV, uid, msg) { const p = pushTo(KV, uid, msg).catch(() => { }); if (CTX && CTX.waitUntil) CTX.waitUntil(p); return p; }
const ub64 = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; a.forEach(x => { o.set(x, i); i += x.length; }); return o; };
async function vapid(KV) {
  let v = JSON.parse(await KV.get('vapid') || 'null');
  if (!v) { const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { priv: await crypto.subtle.exportKey('jwk', k.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', k.publicKey)) }; await KV.put('vapid', JSON.stringify(v)); }
  return v; }
async function hkdf(salt, ikm, info, bits) { const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bits)); }
async function pushOne(KV, sub, msg) {
  const v = await vapid(KV), aud = new URL(sub.endpoint).origin;
  const hdr = b64enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), cl = b64enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://carreterobike.github.io/ruta-fuentes/' }));
  const pk = await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwt = hdr + '.' + cl + '.' + b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pk, te.encode(hdr + '.' + cl)));
  // cifrado aes128gcm (RFC 8291)
  const uaPub = ub64(sub.keys.p256dh), authS = ub64(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']), asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(authS, ecdh, cat(te.encode('WebPush: info\0'), uaPub, asPub), 256), salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 128), nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 96);
  const ck = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, ck, cat(te.encode(JSON.stringify(msg)), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]), bodyB = cat(salt, rs, new Uint8Array([65]), asPub, ct);
  return fetch(sub.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt}, k=${v.pub}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' }, body: bodyB });
}
async function pushTo(KV, uid, msg) {
  const l = JSON.parse(await KV.get('push:' + uid) || '[]'); if (!l.length) return; let gone = false;
  const log = [];
  for (const sub of l) { try { const r = await pushOne(KV, sub, msg); log.push(new URL(sub.endpoint).host + ' ' + r.status + (r.status >= 400 && r.text ? ' ' + (await r.text()).slice(0, 120) : '')); if (r.status === 404 || r.status === 410) { sub.gone = true; gone = true; } } catch (e) { log.push('error ' + e.message); } }
  await KV.put('pushlast:' + uid, JSON.stringify({ t: Date.now(), log }));   // para ver si llegan (diagnóstico)
  if (gone) await KV.put('push:' + uid, JSON.stringify(l.filter(x => !x.gone)));
}
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

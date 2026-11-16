// Ichnos: funciona sin cobertura. La app se guarda sola; el mapa, solo las zonas que guardas ("Sin cobertura").
const APP='ichnos-app-v1', TILES='ichnos-tiles';
const TILE_HOSTS=/server\.arcgisonline\.com|tiles\.openfreemap\.org|elevation-tiles-prod|tile\.opentopomap\.org/;
const LIBS=/cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/;
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET') return; const u=r.url;
  if(TILE_HOSTS.test(u)){   // mapa: primero lo guardado; si no, internet (sin guardar todo lo que miras)
    e.respondWith(caches.open(TILES).then(c=>c.match(u).then(m=>m||fetch(r).catch(()=>m||Response.error()))));
    return; }
  if(LIBS.test(u)){   // librerías: lo guardado, y se refresca por detrás
    e.respondWith(caches.open(APP).then(c=>c.match(r).then(m=>{ const n=fetch(r).then(x=>{ if(x.ok||x.type==='opaque') c.put(r,x.clone()); return x; }).catch(()=>m); return m||n; })));
    return; }
  const url=new URL(u);
  if(url.origin===location.origin&&/\/datos\//.test(url.pathname)){   // fuentes: lo guardado al momento y se refresca por detrás
    e.respondWith(caches.open(APP).then(c=>c.match(r).then(m=>{ const n=fetch(r).then(x=>{ if(x.ok) c.put(r,x.clone()); return x; }).catch(()=>m); return m||n; })));
    return; }
  if(url.origin===location.origin&&(r.mode==='navigate'||/\/(index\.html)?$/.test(url.pathname))){   // la app: internet primero; sin cobertura, la guardada
    e.respondWith(fetch(r).then(x=>{ if(x.ok){ const cp=x.clone(); caches.open(APP).then(c=>c.put(url.pathname.replace(/index\.html$/,''),cp)); } return x; })
      .catch(()=>caches.open(APP).then(c=>c.match(url.pathname.replace(/index\.html$/,'')).then(m=>m||c.match(r)))));
  }
});

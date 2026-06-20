const VER = 'kimac-v36';
const BASE = '/kimac-service-sheet-system';
const CORE = [
  BASE+'/',
  BASE+'/index.html',
  BASE+'/login.html',
  BASE+'/history.html',
  BASE+'/form.html',
  BASE+'/manifest.json'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(CORE).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if(e.request.url.includes('supabase.co')||e.request.url.includes('googleapis')||e.request.url.includes('jsdelivr')||e.request.url.includes('cdnjs')) {
    e.respondWith(fetch(e.request).catch(()=>new Response('',{status:503})));
    return;
  }
  if(e.request.destination==='document') {
    e.respondWith(fetch(e.request).then(res=>{
      const c=res.clone();caches.open(VER).then(ca=>ca.put(e.request,c));return res;
    }).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});

self.addEventListener('push', e => {
  let d={};
  try{ d = e.data ? e.data.json() : {}; }catch(_){ d = { body: e.data && e.data.text() }; }
  const opt = {
    body: d.body || 'มีงานใหม่',
    data: { url: d.url || (BASE+'/history.html') },
    tag: d.tag || 'kimac-job',
    renotify: true,
    vibrate: [80,40,80]
  };
  e.waitUntil(self.registration.showNotification(d.title || 'KIMAC Service', opt));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || (BASE+'/');
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cls => {
    for(const c of cls){ if('focus' in c){ try{ c.navigate(url); }catch(_){ } return c.focus(); } }
    if(self.clients.openWindow) return self.clients.openWindow(url);
  }));
});

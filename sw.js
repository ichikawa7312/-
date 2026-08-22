const CACHE='shinwa-yotei-v17';const ASSETS=['./','./index.html','./app.css?v=20260814-2145','./app.js?v=20260814-2145','./attachments.js?v=20260815-1516','./past.js?v=20260822-1631','./manifest.webmanifest','./icon.svg'];self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);if(u.origin!==location.origin)return;e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))))});
self.addEventListener('push',e=>{
  let d={};
  try{d=e.data?e.data.json():{}}catch{d={body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'シンワ予定',{
    body:d.body||'',icon:'./icon.svg',badge:'./icon.svg',tag:d.tag||undefined,
    data:{url:self.registration.scope}
  }));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    const c=list.find(x=>x.url.startsWith(self.registration.scope));
    if(c)return c.focus();
    return clients.openWindow(self.registration.scope);
  }));
});

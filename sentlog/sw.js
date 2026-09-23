const CACHE='sentlog-pwa-v118';
const APP_SHELL=['./','./index.html','./manifest.webmanifest','./icon.svg','./sync.js','./part01.txt','./part02.txt','./part03.txt','./part04.txt','./part05.txt','./part06.txt','./part07.txt','./part08.txt','./part09.txt'];
const REMOTE_ASSETS=[
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/+esm'
];
self.addEventListener('install',event=>{event.waitUntil((async()=>{const c=await caches.open(CACHE);await c.addAll(APP_SHELL);for(const u of REMOTE_ASSETS){try{const r=await fetch(u,{mode:'cors'});if(r.ok)await c.put(u,r.clone())}catch(e){}}await self.skipWaiting()})())});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE&&k.startsWith('sentlog-')).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(async r=>{if(r&&(r.ok||r.type==='opaque')){const c=await caches.open(CACHE);c.put(event.request,r.clone())}return r}).catch(()=>{if(event.request.mode==='navigate')return caches.match('./index.html');throw new Error('offline')})))});

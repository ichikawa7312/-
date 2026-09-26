/* Only static app resources belong in Cache Storage. Never cache user APIs. */
const CACHE='sentlog-pwa-v133';
const ROOT=new URL('./',self.registration.scope);
const FILES=['','index.html','manifest.webmanifest','icon.svg','cloud-sync.js','phone-runtime.js','phone-layout.css','pdf-recovery.js',...Array.from({length:9},(_,i)=>'part0'+(i+1)+'.txt')];
const PDF_ASSETS=['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'];
const urls=FILES.map(f=>new URL(f,ROOT).href);
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  for(const url of urls){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('App resource unavailable');await cache.put(url,r)}
  for(const url of PDF_ASSETS){try{const r=await fetch(url);if(r.ok)await cache.put(url,r)}catch(_){}}
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const names=await caches.keys();
  await Promise.all(names.filter(n=>n.startsWith('sentlog-pwa-v')&&n!==CACHE).map(n=>caches.delete(n)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);const canonical=url.origin+url.pathname;
  // Supabase requests (including authenticated downloads) bypass this worker.
  const ownStatic=urls.includes(canonical);
  const pdfEngine=PDF_ASSETS.includes(canonical);
  if(!ownStatic&&!pdfEngine)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{const r=await fetch(event.request,{cache:'no-store'});if(!r.ok)throw new Error('Network response '+r.status);await cache.put(canonical,r.clone());return r}
    catch(e){const stored=await cache.match(canonical);if(stored)return stored;throw e}
  })());
});

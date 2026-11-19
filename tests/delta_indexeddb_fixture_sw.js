/* Test-only offline boot. Its /tests/ scope never controls /sentlog/. */
'use strict';
const CACHE='sentlog-delta-indexeddb-fixture-v1';
const FILES=[
  './delta_indexeddb_fixture.html',
  '../sentlog/record-collaboration.js',
  '../sentlog/delta-sync-core.js',
  '../sentlog/delta-sync-indexeddb.js'
].map(path=>new URL(path,self.location.href).href);
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll(FILES);
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||!FILES.includes(event.request.url))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(event.request);
    if(!cached)return fetch(event.request);
    const headers=new Headers(cached.headers);
    headers.set('X-Sentlog-Fixture-Source','service-worker-cache');
    return new Response(cached.body,{status:cached.status,statusText:cached.statusText,headers});
  })());
});

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
    return (await cache.match(event.request))||fetch(event.request);
  })());
});

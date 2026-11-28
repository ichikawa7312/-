'use strict';
// Check exact assembled production files and no accidental storage/version
// downgrade. This is a static release test; no user storage is opened.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=path=>fs.readFileSync(path,'utf8');
const token='20261128-photo-foreground-220';
const index=read('sentlog/index.html');
const writer=read('sentlog/record-store.js');
const photo=read('sentlog/collaboration-photos.js');
const phone=read('sentlog/phone-runtime.js');
const pc=read('sentlog-pc/index.html');
const worker=read('sentlog/sw.js');
const copies=(text,value)=>text.split(value).length-1;

assert.equal(copies(index,'record-store.js?v='+token),2);
assert.equal(copies(index,'collaboration-photos.js?v='+token),2);
assert.equal(copies(index,'phone-runtime.js?v=220'),2);
assert(index.includes("['record-store.js?v="+token+"','sentlog-iphone-cutoff-memory-v219']"));
assert(index.includes("['collaboration-photos.js?v="+token+"','SentlogCollaborationPhotos']"));
assert(index.includes("['phone-runtime.js?v=220','v2.20']"));
assert.equal(copies(index,'record-store.js?v=20261128-iphone-cutoff-memory-219'),0);
assert.equal(copies(index,'collaboration-photos.js?v=20261118-collaboration-photos'),0);
assert(writer.startsWith('// sentlog-iphone-cutoff-memory-v219\n'));
assert(writer.includes('get recordPending(){return pending.size+inFlight>0||operation||exclusive;}'));
assert(writer.includes('get pending(){return pending.size+inFlight>0||fileTasks.size>0||operation;}'),
    'The existing all-file pending/retention guard must stay available');
assert(photo.includes('async function settleRecordWrites(){'));
assert(photo.includes("typeof store.flush==='function'&&typeof store.recordPending==='boolean'"));
assert(photo.includes('if(scoped)await store.flush();else await store.settled();'));
assert.equal(copies(photo,'await settleRecordWrites();'),2,
    'Both pre-attachment and post-attachment record durability checks must remain');
assert(photo.includes("await store.settled();") && photo.includes('store.assertSafe();'));
assert(photo.includes("const timeout=setTimeout(") && photo.includes('SAVE_BUSY'));
assert.deepEqual(worker.match(/sentlog-pwa-v\d+/g),['sentlog-pwa-v262']);
assert(worker.includes("if(!ownStatic&&!pdfEngine)return"),
    'The service worker must never cache user/photo/cloud API traffic');
assert(phone.includes("window.SENTLOG_BUILD = 'v2.20'"));
assert(phone.includes('v2.20 · 写真保存中の不要な待機を軽減'));
assert(pc.includes('v2.20 · 写真保存中の不要な待機を軽減'));
assert(!read('sentlog/storage-maintenance.html').includes('v2.20'),
    'Independent storage maintenance must not be silently rewritten');
console.log('PASS v2.20: fresh PWA cache, versioned photo/writer modules, record-only flush and restore safety, unchanged original/maintenance interfaces');

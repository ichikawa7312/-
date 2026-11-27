'use strict';
// Reuse the established application/binding/controller fixtures. Every check
// executes the complete production writer against a disposable IndexedDB.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const {IDBObjectStore}=require('fake-indexeddb');
const source=path.join(__dirname,'delta_app_journal.test.cjs');
const fixture=fs.readFileSync(source,'utf8').split('let passed=0;async function test(')[0];
const {app,bind,edit,LOG,CONTROL,META,WS,scope,localProjectId}=new Function('require','__dirname',fixture+
  '\nreturn {app,bind,edit,LOG,CONTROL,META,WS,scope,localProjectId};')(createRequire(source),__dirname);
const KEY='photo:drawing-1:photo',BACKUP='page-replace-backup:drawing-1',BACKUP_META='page-replace-backup-meta:drawing-1';
const jpeg=text=>new Blob([text],{type:'image/jpeg'}),pdf=text=>new Blob([text],{type:'application/pdf'});
async function open(){const f=await app();Object.assign(f.ctx,{setTimeout,clearTimeout,TextDecoder});return f;}
async function transaction(f,stores,run){const db=await f.records.openFilesDatabase();
  try{const tx=db.transaction(stores,'readwrite'),done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('aborted'));});run(tx);await done;}
  finally{db.close();}}
async function update(f,store,key,change){await transaction(f,[store],tx=>{const s=tx.objectStore(store),q=s.get(key);q.onsuccess=()=>s.put(change(q.result),key);});}
async function retained(values=['same'],key=KEY){const f=await open(),e=await bind(f,{metadata:true});
  for(const value of values)await f.records.writeFile(key,value instanceof Blob?value:jpeg(value));
  const controller=e.controller();try{await controller.controller.drain();}finally{controller.close();}
  return {f,e,key,rows:[...(await f.disk(LOG)).values()]};}
async function backup({applied=false,content='original-pdf',current=content,meta={}}={}){
  const f=await open();await f.records.writeFile('background:drawing-1',pdf(current));await f.records.writeFile(BACKUP,pdf(content));
  const metadata=new Blob([JSON.stringify({version:1,drawingId:'drawing-1',applied,sourceSize:new Blob([content]).size,sourceHash:'a'.repeat(64),...meta})],{type:'application/json'});
  await f.records.writeFile(BACKUP_META,metadata);return {f,metadata};
}
async function valueFingerprint(value){if(value instanceof Blob)return {blob:await value.text(),type:value.type};
  if(Array.isArray(value))return Promise.all(value.map(valueFingerprint));
  if(value&&typeof value==='object'){const entries=await Promise.all(Object.entries(value).map(async([k,v])=>[k,await valueFingerprint(v)]));return Object.fromEntries(entries);}return value;}
async function fingerprint(f,store){return valueFingerprint([...(await f.disk(store)).entries()]);}
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS',name);}
(async()=>{
await test('dry-run counts only measured duplicate bytes and apply keeps live files, records, cutoff and offline outbox',async()=>{
  const {f,e,rows}=await retained(),beforeFiles=await fingerprint(f,'files'),beforeControl=await fingerprint(f,CONTROL),beforeLog=await fingerprint(f,LOG),outbox=e.read();
  assert.equal(rows.length,1);assert.equal(rows[0].kind,'sentlog-file-retention');
  const preview=await f.records.deltaJournal.compactRedundantFiles();
  assert.equal(preview.eligible,1);assert.equal(preview.logicalBytesEligible,4);assert.equal(preview.logicalBytesRemoved,0);assert.equal(preview.updated,0);assert.equal(preview.comparedBytes,8);
  assert.deepEqual(await fingerprint(f,LOG),beforeLog);assert.deepEqual(await fingerprint(f,CONTROL),beforeControl);
  const result=await f.records.deltaJournal.compactRedundantFiles({dryRun:false});assert.equal(result.updated,1);assert.equal(result.logicalBytesRemoved,4);assert.equal(result.releasedCopies,1);
  assert.equal((await f.disk(LOG)).size,0);assert.deepEqual(await fingerprint(f,'files'),beforeFiles);assert.deepEqual(await fingerprint(f,CONTROL),beforeControl);assert.deepEqual(e.read(),outbox);
  const reopened=await app({factory:f.factory,local:f.local});assert.equal(await (await reopened.disk()).get(KEY).text(),'same');
  assert.equal((await f.records.deltaJournal.compactRedundantFiles({dryRun:false})).updated,0);
});
await test('any distinct preimage keeps the entire retention row including its duplicate after-image',async()=>{
  const {f}=await retained(['first','newer']),before=await fingerprint(f,LOG);
  const result=await f.records.deltaJournal.compactRedundantFiles({dryRun:false});assert.equal(result.updated,0);assert.equal(result.keptUnique,2);assert.deepEqual(await fingerprint(f,LOG),before);
});
await test('old repeated equal before/after bytes are removed together without writing another Blob',async()=>{
  const {f,rows}=await retained();await update(f,LOG,rows[0].seq,row=>({...row,files:[{key:KEY,before:jpeg('same'),after:jpeg('same')}]}));
  const put=IDBObjectStore.prototype.put;let blobPuts=0;
  IDBObjectStore.prototype.put=function(value,...args){if(value instanceof Blob||value?.files?.some(file=>file.before instanceof Blob||file.after instanceof Blob)){blobPuts++;throw Error('native Blob rewrite');}return put.call(this,value,...args);};
  try{const result=await f.records.deltaJournal.compactRedundantFiles({dryRun:false});assert.equal(result.logicalBytesRemoved,8);assert.equal(result.releasedCopies,2);assert.equal(blobPuts,0);}
  finally{IDBObjectStore.prototype.put=put;}
  assert.equal(await (await f.disk()).get(KEY).text(),'same');
});
await test('same size different bytes, different MIME and missing live source are retained',async()=>{
  for(const scenario of ['bytes','mime','missing']){
    const {f,rows}=await retained();
    if(scenario==='missing')await transaction(f,['files'],tx=>tx.objectStore('files').delete(KEY));
    else await update(f,LOG,rows[0].seq,row=>({...row,files:[{key:KEY,before:null,after:scenario==='bytes'?jpeg('evil'):new Blob(['same'],{type:'application/octet-stream'})}]}));
    const before=await fingerprint(f,LOG),result=await f.records.deltaJournal.compactRedundantFiles({dryRun:false});assert.equal(result.updated,0);assert.equal(result.keptUnique,1);assert.deepEqual(await fingerprint(f,LOG),before);
  }
});
await test('unacknowledged WAL, active claims and missing or cross-scope proof are never pruned',async()=>{
  const f=await open();await bind(f,{metadata:true});await f.records.writeFile(KEY,jpeg('pending'));const unacked=await fingerprint(f,LOG);
  assert.equal((await f.records.deltaJournal.compactRedundantFiles({dryRun:false})).updated,0);assert.deepEqual(await fingerprint(f,LOG),unacked);
  for(const scenario of ['claim','claim-ref','missing-proof','scope','staging','detached']){
    const {f,rows}=await retained();
    if(scenario==='claim'){edit(f,'共有待ち');await f.records.settled();await f.records.deltaJournal.claim({scope,localProjectId});}
    else if(scenario==='claim-ref')await transaction(f,[CONTROL],tx=>tx.objectStore(CONTROL).put({kind:'claim',id:'other-claim',localProjectId:'other',rowIds:[],fileReferences:[{rowId:rows[0].id,seq:rows[0].seq}]},'claim:other'));
    else if(scenario==='missing-proof'||scenario==='scope')await update(f,LOG,rows[0].seq,row=>({...row,proofs:scenario==='missing-proof'?[]:row.proofs.map(p=>({...p,scope:{...p.scope,ownerId:'other'}}))}));
    else await update(f,CONTROL,'binding:'+localProjectId,row=>({...row,phase:scenario}));
    const before=await fingerprint(f,LOG),result=await f.records.deltaJournal.compactRedundantFiles({dryRun:false});assert.equal(result.updated,0,scenario);assert.deepEqual(await fingerprint(f,LOG),before,scenario);
    if(scenario.startsWith('claim'))assert.equal(result.skippedClaims,1);
  }
});
await test('cutoff blobs and rows with unique unknown fields stay untouched',async()=>{
  const f=await open();await f.records.writeFile(KEY,jpeg('cutoff'));const e=await bind(f,{metadata:true});
  await f.records.writeFile('photo:drawing-1:new',jpeg('new'));const c=e.controller();try{await c.controller.drain();}finally{c.close();}
  const cutoff=await fingerprint(f,CONTROL);await f.records.deltaJournal.compactRedundantFiles({dryRun:false});assert.deepEqual(await fingerprint(f,CONTROL),cutoff);
  const second=await retained();await update(second.f,LOG,second.rows[0].seq,row=>({...row,unexpectedOriginal:jpeg('unique-original')}));
  const before=await fingerprint(second.f,LOG);assert.equal((await second.f.records.deltaJournal.compactRedundantFiles({dryRun:false})).updated,0);assert.deepEqual(await fingerprint(second.f,LOG),before);
});
await test('cursor and row limits resume without skipping remaining duplicate files',async()=>{
  const f=await open(),e=await bind(f,{metadata:true});for(let index=0;index<4;index++)await f.records.writeFile(KEY+index,jpeg('file'+index));
  const c=e.controller();try{await c.controller.drain();}finally{c.close();}
  let cursor=0,removed=0,passes=0;
  for(;;){const result=await f.records.deltaJournal.compactRedundantFiles({cursor,scanLimit:2,limit:1,dryRun:false});removed+=result.updated;passes++;assert(result.scanned<=2);
    if(result.done)break;assert(result.nextCursor>cursor);cursor=result.nextCursor;assert(passes<10);}
  assert.equal(removed,4);assert.equal((await f.disk(LOG)).size,0);for(let index=0;index<4;index++)assert.equal(await (await f.disk()).get(KEY+index).text(),'file'+index);
});
await test('native read failure and short reads leave the whole pass unchanged',async()=>{
  for(const short of [false,true]){
    const {f}=await retained(),before=await fingerprint(f,LOG),read=Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer=function(){return short?Promise.resolve(new ArrayBuffer(1)):Promise.reject(Object.assign(Error('native unreadable'),{name:'NotReadableError'}));};
    try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantFiles({dryRun:false}),short?e=>e.code==='JOURNAL_MAINTENANCE_READ':/native unreadable/);}
    finally{Blob.prototype.arrayBuffer=read;}
    assert.deepEqual(await fingerprint(f,LOG),before);assert.equal(f.records.failed,false);
  }
});
await test('same-size concurrent file replacement invalidates CAS and retains its preimage in the normal writer',async()=>{
  const {f}=await retained(),other=await app({factory:f.factory,local:f.local});Object.assign(other.ctx,{setTimeout,clearTimeout,TextDecoder});
  const read=Blob.prototype.arrayBuffer;let once=true;
  Blob.prototype.arrayBuffer=async function(){if(once){once=false;await other.records.writeFile(KEY,jpeg('evil'));}return read.call(this);};
  try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantFiles({dryRun:false}),e=>e.code==='JOURNAL_MAINTENANCE_CHANGED');}
  finally{Blob.prototype.arrayBuffer=read;}
  const rows=[...(await f.disk(LOG)).values()];assert(rows.some(row=>row.kind==='sentlog-file-retention'));const changed=rows.find(row=>row.kind==='sentlog-app-intent');
  assert.equal(await changed.files[0].before.text(),'same');assert.equal(await changed.files[0].after.text(),'evil');assert.equal(await (await f.disk()).get(KEY).text(),'evil');
});
await test('a claim created during byte comparison invalidates controls without deleting its history',async()=>{
  const {f}=await retained();edit(f,'これから共有');await f.records.settled();const before=await fingerprint(f,LOG),read=Blob.prototype.arrayBuffer;let once=true;
  Blob.prototype.arrayBuffer=async function(){if(once){once=false;assert(await f.records.deltaJournal.claim({scope,localProjectId}));}return read.call(this);};
  try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantFiles({dryRun:false}),e=>e.code==='JOURNAL_MAINTENANCE_CHANGED');}
  finally{Blob.prototype.arrayBuffer=read;}
  assert.deepEqual(await fingerprint(f,LOG),before);
});
await test('pending editor input and simultaneous text maintenance fail closed',async()=>{
  const {f}=await retained();edit(f,'未保存');await assert.rejects(()=>f.records.deltaJournal.compactRedundantFiles({dryRun:false}),e=>e.code==='JOURNAL_MAINTENANCE_BUSY');await f.records.settled();
  const read=Blob.prototype.arrayBuffer;let once=true,release,entered;const enteredPromise=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);
  Blob.prototype.arrayBuffer=async function(){if(once){once=false;entered();await barrier;}return read.call(this);};
  const task=f.records.deltaJournal.compactRedundantFiles();
  try{await enteredPromise;await assert.rejects(()=>f.records.deltaJournal.compactRedundantRecords(),e=>e.code==='JOURNAL_MAINTENANCE_BUSY');release();await task;}
  finally{release();Blob.prototype.arrayBuffer=read;}
});
await test('deletion failure rolls back every prior deletion in the bounded pass',async()=>{
  const f=await open(),e=await bind(f,{metadata:true});for(const key of [KEY,KEY+'2'])await f.records.writeFile(key,jpeg('same'));
  const c=e.controller();try{await c.controller.drain();}finally{c.close();}const before=await fingerprint(f,LOG),remove=IDBObjectStore.prototype.delete;let deletes=0;
  IDBObjectStore.prototype.delete=function(...args){if(this.name===LOG&&++deletes===2)throw Error('injected cleanup failure');return remove.apply(this,args);};
  try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantFiles({dryRun:false}),/injected cleanup failure/);}
  finally{IDBObjectStore.prototype.delete=remove;}
  assert.deepEqual(await fingerprint(f,LOG),before);assert.equal(f.records.failed,false);assert.equal((await f.records.deltaJournal.compactRedundantFiles({dryRun:false})).updated,2);
});
await test('removed duplicate history is recreated as the exact preimage on a later overwrite or deletion',async()=>{
  for(const deletion of [false,true]){const {f}=await retained();await f.records.deltaJournal.compactRedundantFiles({dryRun:false});
    if(deletion)await f.records.removeFiles([KEY]);else await f.records.writeFile(KEY,jpeg('new-content'));
    const row=[...(await f.disk(LOG)).values()][0];assert.equal(row.kind,'sentlog-app-intent');assert.equal(await row.files[0].before.text(),'same');
    assert.equal(deletion?row.files[0].after:await row.files[0].after.text(),deletion?null:'new-content');}
});
await test('large comparisons use bounded slices and the byte budget never claims unmeasured data',async()=>{
  const blob=new Blob([new Uint8Array(4*1024*1024+13)],{type:'image/jpeg'}),{f}=await retained([blob]),read=Blob.prototype.arrayBuffer;let largest=0;
  Blob.prototype.arrayBuffer=function(){largest=Math.max(largest,this.size);return read.call(this);};
  try{const result=await f.records.deltaJournal.compactRedundantFiles();assert.equal(result.logicalBytesEligible,blob.size);assert.equal(result.comparedBytes,blob.size*2);assert(largest<=4*1024*1024);}
  finally{Blob.prototype.arrayBuffer=read;}
  const limited=await f.records.deltaJournal.compactRedundantFiles({dryRun:false,byteLimit:1024});assert.equal(limited.updated,0);assert.equal(limited.skippedLarge,1);assert.equal(limited.logicalBytesEligible,0);assert.equal(limited.comparedBytes,0);
});
await test('inactive page backup removes only identical bytes and its measured metadata with sequence guards',async()=>{
  const {f,metadata}=await backup(),before=await fingerprint(f,'files'),states=await f.records.readFileStates([BACKUP,BACKUP_META,'background:drawing-1']);
  const preview=await f.records.deltaJournal.compactRedundantPageBackups();assert.equal(preview.eligible,1);assert.equal(preview.logicalBytesEligible,12+metadata.size);assert.deepEqual(await fingerprint(f,'files'),before);
  const result=await f.records.deltaJournal.compactRedundantPageBackups({dryRun:false});assert.equal(result.updated,1);assert.equal(result.releasedCopies,2);
  const disk=await f.disk();assert(!disk.has(BACKUP));assert(!disk.has(BACKUP_META));assert.equal(await disk.get('background:drawing-1').text(),'original-pdf');
  const after=await f.records.readFileStates([BACKUP,BACKUP_META,'background:drawing-1']);assert(after[0].sequence>states[0].sequence);assert(after[1].sequence>states[1].sequence);assert.equal(after[2].sequence,states[2].sequence);
  assert.equal((await f.disk(LOG)).size,0,'cleanup must not copy the backup into the journal');
});
await test('undo-enabled, different, malformed and missing-meta page backups are retained',async()=>{
  for(const scenario of [{applied:true},{current:'different-pdf'},{meta:{sourceSize:1}},{meta:{sourceHash:'bad'}},{removeMeta:true}]){
    const {f}=await backup(scenario);if(scenario.removeMeta)await transaction(f,['files'],tx=>tx.objectStore('files').delete(BACKUP_META));
    const before=await fingerprint(f,'files'),result=await f.records.deltaJournal.compactRedundantPageBackups({dryRun:false});assert.equal(result.updated,0);assert.deepEqual(await fingerprint(f,'files'),before);
  }
});
await test('changing undo metadata during verification preserves the newly active backup',async()=>{
  const {f}=await backup(),other=await app({factory:f.factory,local:f.local});Object.assign(other.ctx,{setTimeout,clearTimeout,TextDecoder});
  const read=Blob.prototype.arrayBuffer;let once=true;
  Blob.prototype.arrayBuffer=async function(){if(once){once=false;const meta=JSON.parse(await (await other.disk()).get(BACKUP_META).text());
    await other.records.writeFile(BACKUP_META,new Blob([JSON.stringify({...meta,applied:true})],{type:'application/json'}));}return read.call(this);};
  try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantPageBackups({dryRun:false}),e=>e.code==='JOURNAL_MAINTENANCE_CHANGED');}
  finally{Blob.prototype.arrayBuffer=read;}
  const disk=await f.disk();assert(disk.has(BACKUP));assert.equal(JSON.parse(await disk.get(BACKUP_META).text()).applied,true);
});
await test('page backup deletion is atomic if metadata deletion fails',async()=>{
  const {f}=await backup(),before=await fingerprint(f,'files'),controls=await fingerprint(f,CONTROL),remove=IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete=function(key){if(this.name==='files'&&key===BACKUP_META)throw Error('metadata deletion failed');return remove.call(this,key);};
  try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantPageBackups({dryRun:false}),/metadata deletion failed/);}
  finally{IDBObjectStore.prototype.delete=remove;}
  assert.deepEqual(await fingerprint(f,'files'),before);assert.deepEqual(await fingerprint(f,CONTROL),controls);
});
await test('cancellation after a native read prevents deletion and releases the maintenance guard',async()=>{
  const {f}=await retained(),controller=new AbortController(),read=Blob.prototype.arrayBuffer;let once=true;
  Blob.prototype.arrayBuffer=async function(){const result=await read.call(this);if(once){once=false;controller.abort();}return result;};
  try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantFiles({dryRun:false,signal:controller.signal}),e=>e.name==='AbortError');}
  finally{Blob.prototype.arrayBuffer=read;}
  assert.equal((await f.disk(LOG)).size,1);assert.equal((await f.records.deltaJournal.compactRedundantFiles({dryRun:false})).updated,1);
});
console.log('Storage redundant file maintenance:',passed,'passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

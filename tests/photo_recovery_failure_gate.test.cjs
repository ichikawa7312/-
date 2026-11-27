'use strict';
// The assertions are identical for the old and patched production module.
// Real writer/session/ACK-cache code; synthetic transport and disposable IDB.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {IDBObjectStore}=require('fake-indexeddb');
const {fixture,deadline,digest,root,source,sha,DRAWING,DID}=require('./helpers/photo_recovery_fixture.cjs');
process.chdir(root);
let activeMetrics=null;
async function fingerprint(value){
  if(value instanceof Blob)return {bytes:value.size,type:value.type,sha256:await digest(value)};
  if(value instanceof Map)return Promise.all([...value].sort(([a],[b])=>String(a).localeCompare(String(b))).map(async([k,v])=>[k,await fingerprint(v)]));
  if(Array.isArray(value))return Promise.all(value.map(fingerprint));
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.keys(value).sort().map(async k=>[k,await fingerprint(value[k])])));
  return value;
}
const durable=async f=>sha(JSON.stringify(await fingerprint({stores:await f.app.durable(),local:[...f.app.local]})));
async function setup(options){const f=await fixture(options);activeMetrics=f.metrics;return f;}
function noDelivery(f){assert.equal(f.calls.acks.length,0);assert.equal(f.calls.viewUpdates.length,0);}
const cases=[];const test=(name,run)=>cases.push({name,run});
test('known record failure stops every scheduled photo cycle before any inventory or local Blob hash',async()=>{
  const f=await setup({count:3}),before=await durable(f),draft=await f.failRecordCommit();
  for(let n=0;n<3;n++)await f.tick();
  assert.equal(f.calls.requests.length,0);assert.equal(f.calls.hashCalls,0);assert.equal(f.calls.writes.length,0);noDelivery(f);
  assert.equal(await durable(f),before);assert.equal(f.app.records.getItem(draft.key),draft.raw);assert(f.app.records.failed&&f.app.records.pending);
  assert.match(f.metrics().status,/保存エラー/);return f.metrics();
});
test('a record failure during inventory stops before the first photo download',async()=>{
  const f=await setup({count:3}),before=await durable(f);let fired=false;
  f.hooks.onInventory=async()=>{if(!fired){fired=true;await f.failRecordCommit();}};
  await f.tick();assert.equal(f.calls.downloads.length,0);assert.equal(f.calls.writes.length,0);noDelivery(f);assert.equal(await durable(f),before);return f.metrics();
});
test('a record failure during download blocks that write and all remaining photos',async()=>{
  const f=await setup({count:3}),before=await durable(f);let fired=false;
  f.hooks.onDownload=async()=>{if(!fired){fired=true;await f.failRecordCommit();}};
  await f.tick();assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,0);noDelivery(f);assert.equal(await durable(f),before);return f.metrics();
});
test('already matching local photos are not acknowledged or rehashed during record failure',async()=>{
  const f=await setup({count:3,existing:true}),before=await durable(f);await f.failRecordCommit();await f.tick();
  assert.equal(f.calls.downloads.length,0);assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hashCalls,0);noDelivery(f);assert.equal(await durable(f),before);return f.metrics();
});
test('writeFile validation observes a prerequisite failure reported just before the file transaction',async()=>{
  const f=await setup(),before=await durable(f);
  f.hooks.beforeWrite=async()=>f.app.records.report('synthetic-prerequisite',Error('Synthetic storage prerequisite failure'));
  await f.tick();assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,1);
  assert.equal(f.calls.writeErrors[0]?.code,'PHOTO_RECOVERY_STORAGE_FAILED');noDelivery(f);assert.equal(await durable(f),before);return f.metrics();
});
test('a prerequisite failure after file put enqueue aborts the transaction and its journal changes',async()=>{
  const f=await setup(),before=await durable(f),key='photo:'+DID+':'+f.assets[0].metadata.photo_id;
  const put=IDBObjectStore.prototype.put;let fired=false;
  IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===key){fired=true;f.app.records.report('synthetic-prerequisite',Error('Synthetic prerequisite failed during file enqueue'));}return request;};
  try{await f.tick();}finally{IDBObjectStore.prototype.put=put;}
  assert(fired);assert.equal(f.calls.writeErrors[0]?.code,'PHOTO_RECOVERY_STORAGE_FAILED');noDelivery(f);assert.equal(await durable(f),before);return f.metrics();
});
test('a record failure in the queued ACK prevents the remote receipt and view update',async()=>{
  const f=await setup({count:3});let committed,draft;
  f.hooks.beforeAck=async()=>{committed=await durable(f);draft=await f.failRecordCommit();};
  await f.tick();assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,1);noDelivery(f);assert.equal(await durable(f),committed);
  assert.equal(f.app.records.getItem(draft.key),draft.raw);assert.equal(await digest((await f.app.disk()).get('photo:'+DID+':'+f.assets[0].metadata.photo_id)),f.assets[0].sha256);return f.metrics();
});
test('successful record retry resumes the same normal sixty-second recovery scheduler',async()=>{
  const f=await setup({count:3}),draft=await f.failRecordCommit(),run=f.environment.sentlogCheckPhotoRecovery;
  await f.tick();assert.equal(f.calls.downloads.length,0);await f.retry();assert(!f.app.records.failed&&!f.app.records.pending);
  await f.tick();assert.equal(f.environment.sentlogCheckPhotoRecovery,run);assert.equal(f.calls.downloads.length,3);assert.equal(f.calls.writes.length,3);assert.equal(f.calls.acks.length,3);assert.equal(f.calls.viewUpdates.length,3);
  assert.equal(f.app.records.getItem(draft.key),draft.raw);assert.equal(await f.recordDisk(),draft.raw);return f.metrics();
});
test('recovery interrupted by a record failure can receive every photo after normal retry',async()=>{
  const f=await setup({count:3});let fired=false;f.hooks.onDownload=async()=>{if(!fired){fired=true;await f.failRecordCommit();}};
  await f.tick();assert.equal(f.calls.downloads.length,1);noDelivery(f);delete f.hooks.onDownload;await f.retry();await f.tick();
  assert.equal(f.calls.downloads.length,4);assert.equal(f.calls.writes.length,3);assert.equal(f.calls.acks.length,3);assert.equal((await f.savedPhotoIds()).length,3);return f.metrics();
});
test('healthy pending records do not block photo receiving',async()=>{
  const f=await setup(),draft=f.draft();assert(f.app.records.pending&&!f.app.records.failed);await f.tick();
  assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,1);assert.equal(f.calls.acks.length,1);assert.equal(f.calls.viewUpdates.length,1);
  assert(!f.app.records.pending&&!f.app.records.failed);assert.equal(await f.recordDisk(),draft.raw);return f.metrics();
});
test('a guarded photo write abort does not latch record failure and the next cycle retries',async()=>{
  const f=await setup(),before=await durable(f),key='photo:'+DID+':'+f.assets[0].metadata.photo_id,put=IDBObjectStore.prototype.put;let fired=false;
  IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===key){fired=true;request.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));}return request;};
  try{await f.tick();}finally{IDBObjectStore.prototype.put=put;}
  assert(fired);assert.equal(f.calls.writeErrors[0]?.name,'QuotaExceededError');assert.equal(f.app.records.failed,false);noDelivery(f);assert.equal(await durable(f),before);
  await f.tick();assert.equal(f.calls.downloads.length,2);assert.equal(f.calls.writes.length,2);assert.equal(f.calls.acks.length,1);assert.equal(f.calls.viewUpdates.length,1);assert.equal(await digest((await f.app.disk()).get(key)),f.assets[0].sha256);return f.metrics();
});
test('owner and device changes still stop in-flight persistence without creating record failure',async()=>{
  for(const actor of ['owner','device']){const f=await setup();f.hooks.onDownload=async()=>actor==='owner'?f.changeOwner():f.changeDevice();await f.tick();
    assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,0);noDelivery(f);assert.equal((await f.savedPhotoIds()).length,0);assert.equal(f.app.records.failed,false);}
  return {actorVariants:2};
});
test('offline to online waits for failed-record retry and then completes photo delivery',async()=>{
  const f=await setup({count:3});await f.failRecordCommit();f.environment.navigator.onLine=false;await f.tick();f.environment.navigator.onLine=true;await f.online();
  assert.equal(f.calls.requests.length,0);noDelivery(f);await f.retry();await f.online();await f.tick();
  assert.equal(f.calls.downloads.length,3);assert.equal(f.calls.writes.length,3);assert.equal(f.calls.acks.length,3);assert.equal(f.calls.viewUpdates.length,3);assert(!f.app.records.failed&&!f.app.records.pending);return f.metrics();
});
test('PC redelivery still verifies and uploads the original without consulting main Records',async()=>{
  const run=vm.runInContext;let protectedPC=false;
  vm.runInContext=function(code,context,...args){if(String(code).includes('async function uploadPhoto(')){protectedPC=true;Object.defineProperty(context,'SentlogRecords',{get(){throw Error('PC sender must not consult the main record store');}});}return run.call(this,code,context,...args);};
  let f;try{f=await require(path.join(root,'tests/photo_recovery_pc.test.cjs')).fixture();}finally{vm.runInContext=run;}
  assert(protectedPC);assert.equal(f.posts.length,1);assert.deepEqual(f.calls,['claim','finish']);assert.equal(await digest(f.original),f.sha);assert.equal(await digest(f.posts[0].bytes),f.sha);return {verifiedUploads:1,mainRecordStoreReads:0};
});
(async()=>{
  const results=[];
  for(const c of cases){activeMetrics=null;try{const measurements=await deadline(c.run());results.push({name:c.name,status:'passed',measurements});console.log('PASS '+c.name);}
    catch(error){results.push({name:c.name,status:'failed',measurements:activeMetrics?.(),error:{name:error?.name||'Error',message:String(error?.message||error).slice(0,500)}});console.error('FAIL '+c.name+': '+String(error?.message||error).slice(0,500));}}
  const failed=results.filter(r=>r.status==='failed').length,report={scope:'Synthetic Node VM and FakeIndexedDB; real photo receiver, record writer, SessionGuard and ACK cache, virtual timers; no native-browser claim',sourceRoot:root,sourceSHA256:sha(source),recordStoreSHA256:sha(fs.readFileSync(path.join(root,'sentlog/record-store.js'))),passed:results.length-failed,failed,cases:results};
  if(process.env.SENTLOG_PHOTO_FAILURE_REPORT)fs.writeFileSync(process.env.SENTLOG_PHOTO_FAILURE_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log('Photo save-failure gate: '+report.passed+' passed, '+failed+' failed');if(failed)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

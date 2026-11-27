'use strict';
// Identical assertions against the old and patched assembled coordinator.
// All records/files/server responses are synthetic; no native-browser claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {IDBObjectStore}=require('fake-indexeddb'),{createHash}=require('node:crypto');
const {fixture,cp,fileKey,within,root}=require('./helpers/delta_photo_failure_fixture.cjs');
process.chdir(root);
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',OTHER='synthetic-other-project',ODRAW='synthetic-other-drawing';
const META='__sentlog_records_meta_v130__',PREFIX='__sentlog_record__:',SYNC='sentlogCloudProjectSyncV2:',PRESERVED='photo:'+ODRAW+':preserved';
const cloud=fs.readFileSync(path.join(root,'sentlog/cloud-sync.js'),'utf8'),setStart=cloud.indexOf('function setSyncMeta('),setEnd=cloud.indexOf('function projectSnapshot(',setStart);
assert(setStart>=0&&setEnd>setStart,'Use the production sync-metadata writer');
const setMetaSource=cloud.slice(setStart,setEnd),part=fs.readFileSync(path.join(root,'sentlog/part05.txt'),'utf8');
const persistSource=part.slice(part.indexOf('function drawingStorageKey('),part.indexOf('function showError('));
assert(persistSource.includes('function persist()'),'Use the real editor workspace/drawing batch');
let activeMetrics=null;
async function hash(value){if(value===undefined)return null;return createHash('sha256').update(value instanceof Blob?Buffer.from(await value.arrayBuffer()):String(value)).digest('hex');}
async function durable(f,store='files'){const db=await f.records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),rows=new Map();tx.objectStore(store).openCursor().onsuccess=e=>{const c=e.target.result;if(c){rows.set(c.key,c.value);c.continue();}};tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
async function fingerprint(value){
  if(value instanceof Blob)return {bytes:value.size,type:value.type,sha256:await hash(value)};
  if(value instanceof Map)return Promise.all([...value].sort(([a],[b])=>String(a).localeCompare(String(b))).map(async([k,v])=>[k,await fingerprint(v)]));
  if(Array.isArray(value))return Promise.all(value.map(fingerprint));
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.keys(value).sort().map(async key=>[key,await fingerprint(value[key])])));
  return value;
}
const mainStores=async f=>hash(JSON.stringify(await fingerprint([await durable(f),await durable(f,'sentlog_delta_control_v1'),await durable(f,'sentlog_delta_journal_v1')])));
function setMeta(f,revision){const set=vm.runInNewContext(setMetaSource+';setSyncMeta',{window:{SentlogRecords:f.records},SYNC_META_PREFIX:SYNC,SYNC_FINGERPRINT_SCHEMA:2});set(OTHER,{revision,fingerprint:'synthetic-'+revision});return {key:SYNC+OTHER,raw:f.records.getItem(SYNC+OTHER)};}
function persistOther(f){const state=JSON.parse(f.records.getItem(DRAW+ODRAW));state.shapes[0].memo='Unsaved synthetic other-project note';
  vm.runInNewContext(persistSource+';persist();',{window:{SentlogRecords:f.records},WORKSPACE_KEY:WS,DRAWING_KEY_PREFIX:DRAW,workspace:JSON.parse(f.records.getItem(WS)),state,activeProjectId:OTHER,activeDrawingId:ODRAW,Date,Intl});
  return {key:DRAW+ODRAW,raw:f.records.getItem(DRAW+ODRAW)};
}
async function failRecordCommit(f,kind='metadata'){
  const original=IDBObjectStore.prototype.put;let fired=false,draft;
  IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===META){fired=true;request.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));}return request;};
  try{draft=kind==='editor'?persistOther(f):setMeta(f,2);await assert.rejects(f.records.flush(),error=>error.name==='QuotaExceededError');}finally{IDBObjectStore.prototype.put=original;}
  assert(fired);assert(f.records.failed&&f.records.pending);assert.equal(f.records.recordFailureDetails.phase,'commit');return draft;
}
function metrics(f){return {...f.stats,photoNotifications:f.received.length,recordFailed:f.records.failed,recordPending:f.records.pending};}
async function setup(options){const f=await fixture(options);setMeta(f,1);await f.records.settled();await f.runtime.sync(cp);
  await f.records.writeFile(PRESERVED,new Blob(['Preserved synthetic other-project photo'],{type:'image/jpeg'}));
  for(const key of Object.keys(f.stats))f.stats[key]=0;f.events.length=0;activeMetrics=()=>metrics(f);return f;
}
function noReceipt(f){assert.equal(f.stats.ackRequests,0);assert.equal(f.received.length,0);}
async function recordsPreserved(f,before,draft){const after=await durable(f);for(const key of [WS,DRAW+'drawing',DRAW+ODRAW])assert.equal(after.get(PREFIX+key),before.get(PREFIX+key),key+' must retain its durable bytes');
  if(draft){assert.equal(f.records.getItem(draft.key),draft.raw);assert.equal(after.get(PREFIX+draft.key),before.get(PREFIX+draft.key));}
  assert.equal(await hash(after.get(PRESERVED)),await hash(before.get(PRESERVED)));
}
const cases=[];const test=(name,run)=>cases.push({name,run});
test('a known record commit failure blocks shared photos before any network or file mutation',async()=>{
  const f=await setup();try{const before=await durable(f),all=await mainStores(f),draft=await failRecordCommit(f);const outcome=await f.start().outcome;
    assert(outcome.error);assert.equal(f.stats.downloads,0);assert.equal(f.stats.writes,0);noReceipt(f);assert.equal(await mainStores(f),all);await recordsPreserved(f,before,draft);return metrics(f);
  }finally{await f.close();}
});
test('other-project metadata failure during download stops mirror persistence, ACK and completion',async()=>{
  const f=await setup({hold:'download'});try{const work=f.start();await f.gate.started.promise;const before=await durable(f),all=await mainStores(f),draft=await failRecordCommit(f);
    f.gate.release.resolve();const outcome=await work.outcome;assert(outcome.error);assert.equal(f.stats.downloads,1);assert.equal(f.stats.writes,0);noReceipt(f);
    assert.equal(await f.readFile(fileKey),undefined);assert.equal((await f.row()).phase,'waiting');assert.equal(await mainStores(f),all);await recordsPreserved(f,before,draft);return metrics(f);
  }finally{await f.close();}
});
test('record retry after interrupted download resumes the same shared-photo runtime',async()=>{
  const f=await setup({hold:'download'});try{const work=f.start();await f.gate.started.promise;const draft=await failRecordCommit(f);f.gate.release.resolve();assert((await work.outcome).error);noReceipt(f);
    await f.records.retry();assert(!f.records.failed&&!f.records.pending);assert.equal((await durable(f)).get(PREFIX+draft.key),draft.raw);
    const completed=await f.runtime.photos(cp);assert.equal(completed.complete,true);assert.equal(f.stats.downloads,2);assert.equal(f.stats.commits,1);assert.equal(f.stats.ackRequests,1);assert.equal(f.received.length,1);
    assert.equal(await hash(await f.readFile(fileKey)),f.ref.sha256);assert.equal((await f.row()).phase,'acknowledged');return metrics(f);
  }finally{await f.close();}
});
test('a late ACK response after other-project metadata failure cannot promote the receipt or completion',async()=>{
  const f=await setup({hold:'ack'});try{const work=f.start();await f.gate.started.promise;assert.equal(f.stats.ackRequests,1);assert.equal((await f.row()).phase,'received');
    const before=await durable(f),all=await mainStores(f),draft=await failRecordCommit(f);f.gate.release.resolve();const outcome=await work.outcome;
    assert(outcome.error);assert.equal(f.stats.ackRequests,1,'the request accepted before failure cannot be unsent');assert.equal(f.stats.receiptReads,0);assert.equal(f.received.length,0);assert.equal((await f.row()).phase,'received');
    assert.equal(await hash(await f.readFile(fileKey)),f.ref.sha256);assert.equal(await mainStores(f),all);await recordsPreserved(f,before,draft);return metrics(f);
  }finally{await f.close();}
});
test('record retry after a delayed ACK reuses saved photo bytes and completes a new receipt',async()=>{
  const f=await setup({hold:'ack'});try{const work=f.start();await f.gate.started.promise;const draft=await failRecordCommit(f);f.gate.release.resolve();assert((await work.outcome).error);assert.equal(f.received.length,0);
    await f.records.retry();assert.equal((await durable(f)).get(PREFIX+draft.key),draft.raw);const completed=await f.runtime.photos(cp);assert.equal(completed.complete,true);
    assert.equal(f.stats.downloads,1);assert.equal(f.stats.commits,1);assert.equal(f.stats.ackRequests,2);assert.equal(f.received.length,1);assert.equal((await f.row()).phase,'acknowledged');assert.equal(await hash(await f.readFile(fileKey)),f.ref.sha256);return metrics(f);
  }finally{await f.close();}
});
test('failure reported immediately before the guarded mirror transaction prevents its write',async()=>{
  let f,all;f=await setup({onWrite:async key=>{if(key===fileKey){all=await mainStores(f);f.records.report('synthetic-prerequisite',Error('Synthetic prerequisite failure'));}}});
  try{const outcome=await f.start().outcome;assert(all);assert(outcome.error);assert.equal(f.stats.writes,1);assert.equal(f.stats.commits,0);noReceipt(f);assert.equal(await f.readFile(fileKey),undefined);assert.equal(await mainStores(f),all);return metrics(f);
  }finally{await f.close();}
});
test('failure reported after file-put enqueue aborts the mirror and its WAL atomically',async()=>{
  let f,all;f=await setup({onWrite:async key=>{if(key===fileKey)all=await mainStores(f);}});const put=IDBObjectStore.prototype.put;let fired=false;
  try{IDBObjectStore.prototype.put=function(...args){const q=put.apply(this,args);if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===fileKey){fired=true;f.records.report('synthetic-prerequisite',Error('Synthetic prerequisite failed while enqueueing the file'));}return q;};
    const outcome=await f.start().outcome;assert(fired);assert(outcome.error);assert.equal(f.stats.commits,0);noReceipt(f);assert.equal(await mainStores(f),all);assert.equal(await f.readFile(fileKey),undefined);return metrics(f);
  }finally{IDBObjectStore.prototype.put=put;await f.close();}
});
test('healthy pending other-project metadata is allowed and becomes durable normally',async()=>{
  const f=await setup();try{const draft=setMeta(f,2);assert(f.records.pending&&!f.records.failed);const result=await f.runtime.photos(cp);assert.equal(result.complete,true);
    assert.equal((await durable(f)).get(PREFIX+draft.key),draft.raw);assert(!f.records.failed&&!f.records.pending);assert.equal(f.stats.commits,1);assert.equal(f.stats.ackRequests,1);assert.equal(f.received.length,1);return metrics(f);
  }finally{await f.close();}
});
test('a guarded photo-only transaction abort remains retryable without a global record-failure latch',async()=>{
  const f=await setup(),put=IDBObjectStore.prototype.put;let fired=false;
  try{IDBObjectStore.prototype.put=function(...args){const q=put.apply(this,args);if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===fileKey){fired=true;q.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));}return q;};
    const result=await f.runtime.photos(cp);assert(fired);assert.equal(result.complete,false);assert.equal(f.records.failed,false);assert.equal(f.stats.commits,0);noReceipt(f);assert.equal(await f.readFile(fileKey),undefined);
  }finally{IDBObjectStore.prototype.put=put;}
  try{const result=await f.runtime.photos(cp);assert.equal(result.complete,true);assert.equal(f.records.failed,false);assert.equal(f.stats.downloads,1);assert.equal(f.stats.writes,2);assert.equal(f.stats.commits,1);assert.equal(f.stats.ackRequests,1);assert.equal(await hash(await f.readFile(fileKey)),f.ref.sha256);return metrics(f);
  }finally{await f.close();}
});
test('ordinary other-project editor failure still stops through the workspace snapshot fence',async()=>{
  const f=await setup({hold:'download'});try{const work=f.start();await f.gate.started.promise;const before=await durable(f),draft=await failRecordCommit(f,'editor');f.gate.release.resolve();const outcome=await work.outcome;
    assert(outcome.error);assert.equal(f.stats.writes,0);noReceipt(f);await recordsPreserved(f,before,draft);return metrics(f);
  }finally{await f.close();}
});
test('an authentication change still fences a late photo download without setting record failure',async()=>{
  const f=await setup({hold:'download'});try{const work=f.start();await f.gate.started.promise;f.switchUser('11000000-0000-4000-8000-000000000002');f.gate.release.resolve();assert((await work.outcome).error);
    assert.equal(f.stats.writes,0);noReceipt(f);assert.equal(f.records.failed,false);assert.equal(await f.readFile(fileKey),undefined);return metrics(f);
  }finally{await f.close();}
});
test('PC redelivery does not load the shared-photo application coordinator',async()=>{
  const pc=fs.readFileSync(path.join(root,'sentlog-pc/index.html'),'utf8');assert.equal(pc.includes('delta-sync-app-runtime.js'),false);
  const f=await require(path.join(root,'tests/photo_recovery_pc.test.cjs')).fixture();assert.equal(f.posts.length,1);assert.deepEqual(f.calls,['claim','finish']);assert.equal(await hash(f.posts[0].bytes),f.sha);assert.equal(await hash(f.original),f.sha);return {verifiedPCUploads:1};
});
(async()=>{const results=[];for(const c of cases){activeMetrics=null;try{const measurements=await within(c.run(),c.name);results.push({name:c.name,status:'passed',measurements});console.log('PASS '+c.name);}
  catch(error){results.push({name:c.name,status:'failed',measurements:activeMetrics?.(),error:{name:error?.name||'Error',message:String(error?.message||error).slice(0,500)}});console.error('FAIL '+c.name+': '+String(error?.message||error).slice(0,500));}}
  const failed=results.filter(r=>r.status==='failed').length,report={scope:'Synthetic Node VM and FakeIndexedDB; real coordinator, asset runtime/transport, photo queue and writer; metadata replica boundary simulated; no native-browser claim',sourceRoot:root,sourceSHA256:await hash(fs.readFileSync(path.join(root,'sentlog/delta-sync-app-runtime.js'),'utf8')),passed:results.length-failed,failed,cases:results};
  if(process.env.SENTLOG_DELTA_FAILURE_REPORT)fs.writeFileSync(process.env.SENTLOG_DELTA_FAILURE_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log('Delta save-failure gate: '+report.passed+' passed, '+failed+' failed');if(failed)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

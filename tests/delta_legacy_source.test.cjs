'use strict';
// Isolated IDB only. No production URL, real browser profile, or user files.
const assert=require('node:assert/strict');
const {webcrypto,createHash}=require('node:crypto');
const {IDBFactory,IDBDatabase,IDBObjectStore}=require('fake-indexeddb');
const Source=require('../sentlog/delta-sync-legacy-source.js');
const PREFIX='__sentlog_record__:',WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
const META='__sentlog_records_meta_v130__',SYNC='sentlogCloudProjectSyncV2:',INTENT='sentlogPhotoCaptureIntentV1';
const project='project-1',drawing='drawing-1',photoId='photo-1';
const json=JSON.stringify;
const digest=async blob=>createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
let serial=0,count=0;
function open(factory,name,version,upgrade){return new Promise((resolve,reject)=>{
  const q=factory.open(name,version);q.onupgradeneeded=()=>upgrade?.(q.result);
  q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
});}
function transaction(db,stores,mode,fn){return new Promise((resolve,reject)=>{
  const tx=db.transaction(stores,mode);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};
  fn(tx);
});}
async function fixture(options={}){
  const factory=new IDBFactory(),name='sentlog-delta-test-source-'+(++serial),originalName=name+'-original';
  const shared=new Blob(['shared-photo'],{type:'image/jpeg'}),original=new Blob(['original-photo'],{type:'image/jpeg'});
  const photo={id:photoId,name:'near.jpg',size:shared.size,sha256:await digest(shared)};
  const workspace={projects:[{id:project,name:'テスト橋梁',drawings:[{id:drawing,name:'図面1'}]}]};
  const state={sourceType:null,fileName:'',shapes:[{id:'record-1',memo:'未送信の所見',photos:[photo]}],pageSettings:{1:{scale:100}}};
  const data=new Map([[PREFIX+WS,json(workspace)],[PREFIX+DRAW+drawing,json(state)],
    [PREFIX+SYNC+project,json({revision:5,local_updated_at:-1,base_snapshot:{project,drawings:[]}})],
    [META,{schema:1,revision:7}],[`photo:${drawing}:${photoId}`,shared]]);
  const db=await open(factory,name,options.version||1,db=>{db.createObjectStore('files');
    if(options.journal){db.createObjectStore('sentlog_delta_journal_v1');db.createObjectStore('sentlog_delta_control_v1');}});
  await transaction(db,['files'],'readwrite',tx=>{for(const [k,v]of data)tx.objectStore('files').put(v,k);});db.close();
  const originalMeta={key:`${drawing}:${photoId}`,projectId:project,drawingId:drawing,photoId,size:original.size,
    type:original.type,originalName:'near-original.jpg',exportedAt:null,
    photoAssociation:{version:1,status:'attached',photoId,operationId:'capture-1',target:{projectId:project,drawingId:drawing,recordId:'record-1'}}};
  if(!options.noOriginalDb){
    const odb=await open(factory,originalName,options.originalVersion||1,db=>{
      db.createObjectStore('photos');db.createObjectStore('meta',{keyPath:'key'});
    });
    await transaction(odb,['photos','meta'],'readwrite',tx=>{
      tx.objectStore('photos').put(original,originalMeta.key);tx.objectStore('meta').put(originalMeta);
    });odb.close();
  }
  const local=new Map();
  const storage={getItem:key=>local.get(key)??null,setItem(){throw Error('source must not write localStorage');},removeItem(){throw Error('source must not delete localStorage');}};
  const source=(extra={})=>Source.createSource({indexedDB:factory,localStorage:storage,crypto:webcrypto,databaseName:name,originalDatabaseName:originalName,...extra});
  async function change(entries){
    const db=await open(factory,name);try{await transaction(db,['files'],'readwrite',tx=>{
      for(const [k,v]of entries){if(v===undefined)tx.objectStore('files').delete(k);else tx.objectStore('files').put(v,k);}
    });}finally{db.close();}
  }
  async function changeOriginal(entries){
    const db=await open(factory,originalName);try{await transaction(db,['photos','meta'],'readwrite',tx=>{
      for(const [store,key,value]of entries){if(value===undefined)tx.objectStore(store).delete(key);
        else if(store==='meta')tx.objectStore(store).put(value);else tx.objectStore(store).put(value,key);}
    });}finally{db.close();}
  }
  return {factory,name,originalName,source,data,local,workspace,state,photo,shared,original,originalMeta,change,changeOriginal};
}
async function test(name,fn){await fn();count++;console.log('PASS',name);}
const codes=s=>s.issues.map(x=>x.code);
async function readonly(fn){
  const oldTx=IDBDatabase.prototype.transaction,oldPut=IDBObjectStore.prototype.put,
    oldDelete=IDBObjectStore.prototype.delete,oldClear=IDBObjectStore.prototype.clear;
  const modes=[];
  IDBDatabase.prototype.transaction=function(stores,mode,...rest){
    modes.push(mode);assert.equal(mode,'readonly','source must use readonly transactions only');return oldTx.call(this,stores,mode,...rest);
  };
  const fail=()=>{throw Error('source attempted a write');};
  IDBObjectStore.prototype.put=fail;IDBObjectStore.prototype.delete=fail;IDBObjectStore.prototype.clear=fail;
  try{await fn();assert(modes.length>=1);}finally{
    IDBDatabase.prototype.transaction=oldTx;IDBObjectStore.prototype.put=oldPut;
    IDBObjectStore.prototype.delete=oldDelete;IDBObjectStore.prototype.clear=oldClear;
  }
}
(async()=>{
 await test('reads durable records, shared photos and originals without writing any source',async()=>{
  const f=await fixture();
  await readonly(async()=>{
    const source=f.source(),s=await source.capture(project);
    assert.equal(s.readyForStaging,true);assert.equal(s.readyForActivation,false);
    assert.equal(s.source.recordRevision,7);assert.equal(s.files.length,2);
    assert.equal(s.rawEntries.find(x=>x.key===DRAW+drawing).value,json(f.state));
    assert.deepEqual(s.originals,[{key:f.originalMeta.key,meta:f.originalMeta}]);
    assert.equal(await s.files.find(x=>x.kind==='photo').blob.text(),'shared-photo');
    assert.equal(await s.files.find(x=>x.kind==='original-photo').blob.text(),'original-photo');
    const copied=structuredClone(s);assert.equal((await source.recheck(copied)).unchanged,true);source.close();
  });
 });
 await test('source snapshot includes full drawing options and unconfirmed sync baseline',async()=>{
  const f=await fixture(),s=await f.source().capture(project);
  assert.deepEqual(JSON.parse(s.rawEntries.find(x=>x.key===DRAW+drawing).value).pageSettings,{1:{scale:100}});
  assert.equal(JSON.parse(s.rawEntries.find(x=>x.key===SYNC+project).value).local_updated_at,-1);
  assert.equal(s.readyForActivation,false);
 });
 await test('a stale memory mirror cannot hide a completed write from another tab',async()=>{
  const f=await fixture(),source=f.source(),before=await source.capture(project),old=before.rawEntries.find(x=>x.key===DRAW+drawing).value;
  const changed=structuredClone(f.state);changed.shapes[0].memo='別タブの追記';
  await f.change([[PREFIX+DRAW+drawing,json(changed)],[META,{schema:1,revision:8}]]);
  assert.equal((await source.recheck(before)).sourceChanged,true);
  const after=await source.capture(project);assert.notEqual(after.rawEntries.find(x=>x.key===DRAW+drawing).value,old);
 });
 await test('same-size shared photo replacement is detected without record revision change',async()=>{
  const f=await fixture(),source=f.source(),s=await source.capture(project);
  await f.change([[`photo:${drawing}:${photoId}`,new Blob(['broken-photo'],{type:'image/jpeg'})]]);
  const r=await source.recheck(s);assert.equal(r.unchanged,false);assert(r.issues.some(x=>x.code==='LEGACY_SOURCE_FILE_MISMATCH'));
  assert.equal((await source.capture(project)).source.recordRevision,7);
 });
 await test('original replacement is detected independently of shared metadata',async()=>{
  const f=await fixture(),source=f.source(),s=await source.capture(project);
  await f.changeOriginal([['photos',f.originalMeta.key,new Blob(['different-file'],{type:'image/jpeg'})]]);
  assert.equal((await source.recheck(s)).unchanged,false);
 });
 await test('a missing shared photo retains raw references and requires recovery',async()=>{
  const f=await fixture();await f.change([[`photo:${drawing}:${photoId}`,undefined]]);
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_FILE_MISSING'));
  assert.equal(JSON.parse(s.rawEntries.find(x=>x.key===DRAW+drawing).value).shapes[0].photos.length,1);
  assert(s.manifest.some(x=>x.key===`photo:${drawing}:${photoId}`&&x.status==='recovery-required'));
 });
 await test('original metadata with missing bytes is retained for recovery',async()=>{
  const f=await fixture();await f.changeOriginal([['photos',f.originalMeta.key,undefined]]);
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,false);
  assert.deepEqual(s.originals[0].meta,f.originalMeta);
  assert(s.manifest.some(x=>x.kind==='original-photo'&&x.status==='recovery-required'));
 });
 await test('a missing original database remains absent with original completeness unknown',async()=>{
  const f=await fixture({noOriginalDb:true}),before=await f.factory.databases();
  const s=await f.source().capture(project);assert.equal(s.source.originalsPresent,false);
  assert.equal(s.readyForStaging,true);assert(codes(s).includes('LEGACY_SOURCE_ORIGINALS_MISSING'));
  assert.equal(s.source.originalCompleteness,'unknown');assert.equal(s.readyForActivation,false);
  assert(s.issues.some(x=>x.status==='original-not-present-in-source'&&x.blocking===false));
  assert.deepEqual(await f.factory.databases(),before);
 });
 await test('without databases(), absent DB creation is aborted and leaves no new database',async()=>{
  const f=await fixture({noOriginalDb:true}),list=f.factory.databases.bind(f.factory),before=await list();
  f.factory.databases=undefined;
  const s=await f.source().capture(project);assert.equal(s.source.originalsPresent,false);
  assert.deepEqual(await list(),before);
 });
 await test('missing record DB is not created, with or without databases()',async()=>{
  for(const fallback of [false,true]){
    const factory=new IDBFactory(),list=factory.databases.bind(factory);
    if(fallback)factory.databases=undefined;
    const source=Source.createSource({indexedDB:factory,crypto:webcrypto,localStorage:{getItem:()=>null},
      databaseName:'sentlog-delta-test-absent-main',originalDatabaseName:'sentlog-delta-test-absent-original'});
    const s=await source.capture(project);assert.equal(s.readyForStaging,false);
    assert(codes(s).includes('LEGACY_SOURCE_DATABASE_MISSING'));assert.deepEqual(await list(),[]);
  }
 });
 await test('unknown record schema version fails without upgrade or data changes',async()=>{
  const f=await fixture({version:2}),before=await f.factory.databases();
  await assert.rejects(()=>f.source().capture(project),e=>e.code==='LEGACY_SOURCE_SCHEMA');
  assert.deepEqual(await f.factory.databases(),before);
 });
 await test('journal-enabled version 2 source remains readonly and preserves exact shared bytes',async()=>{
  const f=await fixture({version:2,journal:true});
  await readonly(async()=>{const source=f.source(),s=await source.capture(project);
    assert.equal(s.readyForStaging,true);assert.equal(s.source.recordRevision,7);assert.equal(await s.files.find(x=>x.kind==='photo').blob.text(),'shared-photo');
    assert.equal((await source.recheck(s)).unchanged,true);source.close();});
  assert.equal((await f.factory.databases()).find(x=>x.name===f.name).version,2);
 });
 await test('unknown future schema remains rejected even if known journal stores exist',async()=>{
  const f=await fixture({version:3,journal:true});await assert.rejects(()=>f.source().capture(project),e=>e.code==='LEGACY_SOURCE_SCHEMA');
 });
 await test('unknown original schema version becomes an explicit blocking issue',async()=>{
  const f=await fixture({originalVersion:2}),before=await f.factory.databases();
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_ORIGINALS_UNAVAILABLE'));assert.equal(s.source.originalsPresent,null);
  assert.deepEqual(await f.factory.databases(),before);
 });
 await test('pending native capture intent is preserved before shape attachment',async()=>{
  const f=await fixture(),intent={version:1,inputs:{cameraInput:'pending-op'},operations:{'pending-op':{
    operationId:'pending-op',target:{projectId:project,drawingId:drawing,recordId:'record-1'},photoIds:[]}},entries:{}};
  f.local.set(INTENT,json(intent));const s=await f.source().capture(project);
  assert.equal(s.captureIntentRaw,json(intent));assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_CAPTURE_IN_PROGRESS'));
 });
 await test('pending original association blocks completion even with no localStorage journal',async()=>{
  const f=await fixture(),meta={...f.originalMeta,photoAssociation:{...f.originalMeta.photoAssociation,status:'pending'}};
  await f.changeOriginal([['meta',meta.key,meta]]);const s=await f.source().capture(project);
  assert.equal(s.readyForStaging,false);assert(codes(s).includes('LEGACY_SOURCE_PENDING_ORIGINAL'));
  assert.equal(s.originals[0].meta.photoAssociation.status,'pending');
 });
 await test('unattached original with a target photo absent from shapes is still copied',async()=>{
  const f=await fixture(),blob=new Blob(['pending-original']),key=drawing+':pending';
  const meta={...f.originalMeta,key,photoId:'pending',size:blob.size,photoAssociation:{...f.originalMeta.photoAssociation,
    photoId:'pending',status:'pending'}};
  await f.changeOriginal([['meta',key,meta],['photos',key,blob]]);
  const s=await f.source().capture(project);assert(s.files.some(x=>x.key==='original:'+key));
  assert(s.originals.some(x=>x.key===key));assert.equal(s.readyForStaging,false);
 });
 await test('orphan shared bytes are copied even when absent from current photo references',async()=>{
  const f=await fixture();await f.change([[`photo:${drawing}:orphan`,new Blob(['orphan-photo'])]]);
  const s=await f.source().capture(project);assert(s.files.some(x=>x.key===`photo:${drawing}:orphan`));
 });
 await test('orphan original bytes without metadata are preserved with a blocking issue',async()=>{
  const f=await fixture(),key=drawing+':orphan';await f.changeOriginal([['photos',key,new Blob(['orphan-original'])]]);
  const s=await f.source().capture(project);assert(s.files.some(x=>x.key==='original:'+key));
  assert(codes(s).includes('LEGACY_SOURCE_ORIGINAL_META_MISSING'));assert.equal(s.readyForStaging,false);
 });
 await test('unrelated project originals are excluded',async()=>{
  const f=await fixture(),key='other-drawing:other-photo',meta={key,projectId:'other',drawingId:'other-drawing',photoId:'other-photo',size:3};
  await f.changeOriginal([['meta',key,meta],['photos',key,new Blob(['abc'])]]);
  const s=await f.source().capture(project);assert(!s.originals.some(x=>x.key===key));assert(!s.files.some(x=>x.sourceKey===key));
 });
 await test('background source bytes are copied, and declared but missing files block confirmation',async()=>{
  const f=await fixture(),state={...f.state,sourceType:'pdf',fileName:'plan.pdf'};
  await f.change([[PREFIX+DRAW+drawing,json(state)]]);
  const missing=await f.source().capture(project);assert.equal(missing.readyForStaging,false);
  await f.change([['background:'+drawing,new Blob(['%PDF-test'],{type:'application/pdf'})]]);
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,true);
  assert.equal(await s.files.find(x=>x.kind==='background').blob.text(),'%PDF-test');
 });
 await test('replacement backups and merge checkpoints are included unchanged',async()=>{
  const f=await fixture(),backup='sentlogReplaceBackupV1:'+drawing,checkpoint='sentlogSyncMergeCheckpointV1:'+project+':hash';
  await f.change([[PREFIX+backup,'{"old":"drawing"}'],[PREFIX+checkpoint,'{"unsent":"candidate"}']]);
  const s=await f.source().capture(project);assert.equal(s.rawEntries.find(x=>x.key===backup).value,'{"old":"drawing"}');
  assert.equal(s.rawEntries.find(x=>x.key===checkpoint).value,'{"unsent":"candidate"}');
 });
 await test('broken drawing JSON remains intact and is never interpreted as empty',async()=>{
  const f=await fixture();await f.change([[PREFIX+DRAW+drawing,'{broken']]);
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,false);
  assert.equal(s.rawEntries.find(x=>x.key===DRAW+drawing).value,'{broken');assert(codes(s).includes('LEGACY_SOURCE_JSON'));
 });
 await test('duplicate record IDs block staging instead of overwriting a record',async()=>{
  const f=await fixture(),state=structuredClone(f.state);state.shapes.push({...state.shapes[0],memo:'別の内容'});
  await f.change([[PREFIX+DRAW+drawing,json(state)]]);
  const s=await f.source().capture(project);assert(codes(s).includes('LEGACY_SOURCE_RECORD_ID'));
  assert.equal(JSON.parse(s.rawEntries.find(x=>x.key===DRAW+drawing).value).shapes.length,2);
 });
 await test('capture intent change while hashing prevents completion and retains both strings',async()=>{
  const f=await fixture();let changed=false;
  const crypto={subtle:{digest:async(...args)=>{if(!changed){changed=true;f.local.set(INTENT,'{"changed":true}');}return webcrypto.subtle.digest(...args);}}};
  const s=await f.source({crypto}).capture(project);assert.equal(s.captureIntentRaw,null);
  assert.equal(s.source.captureIntentAfterRaw,'{"changed":true}');assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_CHANGED'));
 });
 await test('sync metadata change alone invalidates a previously captured copy',async()=>{
  const f=await fixture(),source=f.source(),s=await source.capture(project);
  await f.change([[PREFIX+SYNC+project,'{"revision":9,"local_updated_at":-1}']]);
  assert.equal((await source.recheck(s)).unchanged,false);
 });
 await test('A to B to A record edits are visible through the durable revision',async()=>{
  const f=await fixture(),source=f.source(),s=await source.capture(project),raw=json(f.state);
  await f.change([[PREFIX+DRAW+drawing,raw.replace('未送信の所見','一時の変更')],[META,{schema:1,revision:8}]]);
  await f.change([[PREFIX+DRAW+drawing,raw],[META,{schema:1,revision:9}]]);
  assert.equal((await source.recheck(s)).unchanged,false);
 });
 await test('readonly transaction gives coherent records and bytes during a concurrent writer',async()=>{
  const f=await fixture(),source=f.source(),oldTx=IDBDatabase.prototype.transaction;
  let signal;const started=new Promise(r=>{signal=r;});
  IDBDatabase.prototype.transaction=function(...args){const tx=oldTx.apply(this,args);if(this.name===f.name&&args[1]==='readonly')signal();return tx;};
  let s;
  try{
    const capture=source.capture(project);await started;
    const next=structuredClone(f.state);next.shapes[0].memo='次の状態';
    const write=f.change([[PREFIX+DRAW+drawing,json(next)],[META,{schema:1,revision:8}]]);
    s=await capture;await write;
  }finally{IDBDatabase.prototype.transaction=oldTx;}
  assert.equal(s.source.recordRevision,7);assert.equal(JSON.parse(s.rawEntries.find(x=>x.key===DRAW+drawing).value).shapes[0].memo,'未送信の所見');
  assert.equal((await source.recheck(s)).unchanged,false);
 });
 await test('a changed captured raw entry cannot be passed to recheck as the original',async()=>{
  const f=await fixture(),source=f.source(),s=await source.capture(project);s.rawEntries[0].value='{}';
  await assert.rejects(()=>source.recheck(s),e=>e.code==='LEGACY_SOURCE_SNAPSHOT_CHANGED');
 });
 await test('an unknown project cannot be accepted as a successfully copied empty project',async()=>{
  const f=await fixture(),s=await f.source().capture('unknown');assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_PROJECT'));
 });
 await test('closed source and unapproved DB names fail without opening a writable path',async()=>{
  const f=await fixture(),source=f.source();source.close();
  await assert.rejects(()=>source.capture(project),e=>e.code==='LEGACY_SOURCE_CLOSED');
  assert.throws(()=>f.source({databaseName:'unrelated-private-db'}),e=>e.code==='LEGACY_SOURCE_CONFIG');
 });
 await test('normal shared-only photos retain unknown original completeness without blocking a copy',async()=>{
  const f=await fixture();await f.changeOriginal([['meta',f.originalMeta.key,undefined],['photos',f.originalMeta.key,undefined]]);
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,true);
  assert.equal(s.source.originalCompleteness,'unknown');assert.equal(s.source.capturedOriginalCount,0);
  assert(s.issues.some(x=>x.code==='LEGACY_SOURCE_ORIGINAL_NOT_LOCAL'&&x.blocking===false));
 });
 await test('capture intent expecting original bytes blocks even if the original database is absent',async()=>{
  const f=await fixture({noOriginalDb:true});
  f.local.set(INTENT,json({version:1,operations:{},entries:{pending:{photoId:'pending',storageDrawingId:drawing,
    status:'attached',originalSaved:true,target:{projectId:project,drawingId:drawing,recordId:'record-1'}}}}));
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_EXPECTED_ORIGINAL_MISSING'));assert.equal(s.source.originalCompleteness,'incomplete');
 });
 await test('the same shared key with conflicting metadata is retained and blocked',async()=>{
  const f=await fixture(),state=structuredClone(f.state);
  state.shapes.push({id:'record-2',photos:[{...f.photo,name:'other-photo.jpg'}]});
  await f.change([[PREFIX+DRAW+drawing,json(state)]]);
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_PHOTO_COLLISION'));assert(s.files.some(x=>x.kind==='photo'));
 });
 await test('ambiguous drawing IDs cannot silently reinterpret a shared storage key',async()=>{
  const f=await fixture(),workspace=structuredClone(f.workspace),extra=drawing+':suffix';
  workspace.projects[0].drawings.push({id:extra});
  await f.change([[PREFIX+WS,json(workspace)],[PREFIX+DRAW+extra,json({shapes:[]})],
    [`photo:${extra}:orphan`,new Blob(['ambiguously-keyed'])]]);
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_ASSET_ID_COLLISION'));assert(s.files.some(x=>x.key===`photo:${extra}:orphan`));
 });
 await test('conflicting original project and drawing metadata blocks confirmation',async()=>{
  const f=await fixture(),meta={...f.originalMeta,projectId:'different-project'};
  await f.changeOriginal([['meta',meta.key,meta]]);
  const s=await f.source().capture(project);assert.equal(s.readyForStaging,false);
  assert(codes(s).includes('LEGACY_SOURCE_ORIGINAL_SCOPE'));assert.equal(s.originals[0].meta.projectId,'different-project');
 });
 await test('original metadata changes invalidate a copy even when all bytes remain equal',async()=>{
  const f=await fixture(),source=f.source(),s=await source.capture(project);
  await f.changeOriginal([['meta',f.originalMeta.key,{...f.originalMeta,exportedAt:123}]]);
  assert.equal((await source.recheck(s)).unchanged,false);
 });
 async function pendingFixture({present=false,value,mutate=()=>{}}={}){
  const f=await fixture({noOriginalDb:true}),state=structuredClone(f.state);mutate(state);
  const key=`photo:${drawing}:${photoId}`,cutoff={version:1,kind:'sentlog-journal-cutoff',bindingId:'pending-binding',
   localProjectId:project,scope:{ownerId:'owner',projectId:'cloud-project',deviceId:'device'},cutoffSeq:0,sourceRevision:7,
   sourceMeta:{schema:1,revision:7},rawEntries:[[WS,json(f.workspace)],[DRAW+drawing,json(state)]],files:present?[{key,value}]:[]};
  const journal={version:1,assertFence:()=>true,bindingFor:()=>({cutoff}),readCutoff:async()=>structuredClone(cutoff)};
  const source=f.source({journal,allowPendingSharedPhotos:true});return {f,source,cutoff,key};
 }
 await test('an absent protected shared photo retains exact reference metadata as pending without certifying bytes',async()=>{
  const {f,source,cutoff,key}=await pendingFixture(),s=await source.capture(project,{recordCutoff:cutoff});
  assert.equal(s.readyForStaging,true);assert.equal(s.readyForActivation,false);assert.equal(s.files.length,0);
  const entry=s.manifest.find(item=>item.key===key);assert.equal(entry.status,'shared-photo-pending');
  assert.equal(entry.deliveryVerified,false);assert.deepEqual(entry.references,[{recordId:'record-1',photo:f.photo}]);
  assert(s.issues.some(item=>item.code==='LEGACY_SOURCE_SHARED_PHOTO_PENDING'&&item.blocking===false));
  assert.equal(s.rawEntries.find(item=>item.key===DRAW+drawing).value,cutoff.rawEntries[1][1]);
  assert.equal((await source.recheck(s)).unchanged,true);assert.equal(cutoff.files.length,0);source.close();
 });
 await test('stored empty null undefined corrupt and mismatched photo bytes remain blocking even when pending references are enabled',async()=>{
  for(const value of [new Blob([]),null,undefined,'unreadable',new Blob(['wrong bytes'])]){
   const {source,cutoff,key}=await pendingFixture({present:true,value}),s=await source.capture(project,{recordCutoff:cutoff});
   assert.equal(s.readyForStaging,false);assert(!s.manifest.some(item=>item.key===key&&item.status==='shared-photo-pending'));
   assert(s.issues.some(item=>['LEGACY_SOURCE_FILE_MISSING','LEGACY_SOURCE_FILE_MISMATCH'].includes(item.code)));source.close();
  }
 });
 await test('missing incomplete conflicting photo identities and background PDFs never become pending shared photos',async()=>{
  for(const mutate of [s=>delete s.shapes[0].photos[0].sha256,s=>s.shapes[0].photos[0].size=0,s=>s.shapes[0].photos[0].variant='original',
   ...[null,false,'',0].map(variant=>s=>s.shapes[0].photos[0].variant=variant),
   s=>s.shapes[0].photos[0].size='12',s=>s.shapes.push({id:'record-2',photos:[{...s.shapes[0].photos[0],sha256:'f'.repeat(64)}]}),
   s=>{s.sourceType='pdf';s.fileName='drawing.pdf';}]){
   const {source,cutoff}=await pendingFixture({mutate}),s=await source.capture(project,{recordCutoff:cutoff});
   assert.equal(s.readyForStaging,false);assert(s.issues.some(item=>item.blocking));source.close();
  }
 });
 await test('pending eligibility is opt-in and cannot be used outside the canonical journal cutoff',async()=>{
  const {f,source,cutoff,key}=await pendingFixture();await f.change([[key,undefined]]);
  assert.equal((await source.capture(project)).readyForStaging,false);
  const strict=f.source({journal:{version:1,assertFence:()=>true,bindingFor:()=>({cutoff}),readCutoff:async()=>structuredClone(cutoff)}});
  assert.equal((await strict.capture(project,{recordCutoff:cutoff})).readyForStaging,false);source.close();strict.close();
 });
 console.log('PASS legacy durable source:',count,'cases (synthetic IndexedDB only, no source writes)');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});

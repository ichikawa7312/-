'use strict';
// Real record-store and persist() entry points in an isolated fake IndexedDB.
// No browser process, network, live Supabase project, or real user data.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {webcrypto,createHash}=require('node:crypto'),{IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const B=require('../sentlog/delta-sync-app-bridge.js'),T=require('../sentlog/record-transfer.js');
const G=require('../sentlog/drawing-groups.js'),R=require('../sentlog/delta-sync-reconcile.js');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',PREFIX='__sentlog_record__:';
const META='__sentlog_records_meta_v130__',localProjectId='local-project';
const scope={ownerId:'owner-a',projectId:'server-project',deviceId:'device-a'},actor={deviceId:scope.deviceId,deviceName:'編集端末'};
const copy=x=>structuredClone(x),json=JSON.stringify;
const options=(prefix='edit',device=scope.deviceId)=>{let n=0;return {actor:{deviceId:device,deviceName:device},at:50,idFactory:()=>prefix+'-'+(++n)};};
const baseRecord=(id='record-1')=>C.upgrade({id,kind:'field-record',recordKind:'field-record',recordType:'survey',page:1,
  type:'腐食',point:{x:10,y:20},memo:'最初の所見',photos:[{id:'photo-1',name:'近接.jpg',sha256:'a'.repeat(64),size:3,type:'image/jpeg'}]});
function initial(){
  const records=[baseRecord(),C.upgrade({id:'memo-1',kind:'text',recordKind:'drawing-memo',memoType:'text',page:1,x:3,y:4,text:'図面メモ',memo:'',photos:[]})];
  const dimension=C.upgrade({id:'dimension-1',kind:'dimension',recordKind:'dimension-line',page:1,points:[{x:1,y:2},{x:3,y:4}],manualText:'2 m',memo:'',photos:[]});
  const states=[records,[dimension]].map((shapes,i)=>({project:'橋梁調査',sourceType:'pdf',fileName:'drawing-'+(i+1)+'.pdf',pageCount:2,
    currentPage:1,width:1200,height:800,shapes,collabDeletedRecords:[],nextGlobalNo:4,typeCounters:{},
    pageSettings:{1:{scaleDenom:100}},pageRotations:{},pdfPageInfo:{1:{width:1200,height:800}},leaderMarker:'open-circle',labelSize:12}));
  const drawings=states.map((state,i)=>({meta:{id:'drawing-'+(i+1),name:'図面 '+(i+1),sourceType:'pdf',fileName:state.fileName,
    pageCount:2,shapeCount:state.shapes.length,photoCount:state.shapes.reduce((n,r)=>n+r.photos.length,0),updatedAt:10},state}));
  return {version:1,kind:'sentlog-app-project',localProjectId,source:'editor-memory',readyForActivation:false,
    project:{id:localProjectId,name:'橋梁調査',collaborationVersion:1,updatedAt:10,drawings:drawings.map(d=>copy(d.meta))},drawings};
}
const row=(snapshot,id='record-1')=>snapshot.drawings.flatMap(d=>[...d.state.shapes,...(d.state.collabDeletedRecords||[])]).find(r=>r.id===id);
function seeded(snapshot){
  const records={};for(const d of snapshot.drawings)for(const r of [...d.state.shapes,...(d.state.collabDeletedRecords||[])])records[D.keyOf(d.meta.id,r.id)]=C.upgrade(r);
  return {version:2,scope:copy(scope),cursor:0,records,outbox:[]};
}
function environment(snapshot=initial(),mutate=()=>{}){
  let durable=seeded(snapshot),writes=0,attempts=0,fail=0,hook=null,currentScope=copy(scope);mutate(durable);
  const store={read:async()=>copy(durable),write:async next=>{attempts++;if(hook)await hook(next);if(fail){fail--;throw Error('端末の保存容量不足');}durable=copy(next);writes++;}};
  const replica=D.createReplica({...scope,store,transport:{online:()=>false,push:async()=>{throw Error('network must not be used');},list:async()=>[]}});
  const bridge=B.createBridge({replica,scope,localProjectId,currentScope:()=>currentScope});
  return {replica,bridge,get writes(){return writes;},get attempts(){return attempts;},current:()=>copy(durable),
    failOnce(){fail++;},onWrite(fn){hook=fn;},changeScope(value){currentScope=value;},close(){bridge.close();replica.close();}};
}
async function actualApp(snapshot=initial()){
  const entries=new Map([[WS,json({projects:[snapshot.project]})],...snapshot.drawings.map(d=>[DRAW+d.meta.id,json(d.state)])]);
  const localStorage={get length(){return entries.size;},key:i=>[...entries.keys()][i]??null,getItem:k=>entries.get(k)??null,
    setItem:(k,v)=>entries.set(k,String(v)),removeItem:k=>entries.delete(k)};
  const indexedDB=new IDBFactory(),ctx={indexedDB,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,crypto:webcrypto,
    WORKSPACE_KEY:WS,DRAWING_KEY_PREFIX:DRAW,workspace:{projects:[copy(snapshot.project)]},state:copy(snapshot.drawings[0].state),
    activeProjectId:localProjectId,activeDrawingId:snapshot.drawings[0].meta.id};
  ctx.window=ctx;vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8'),ctx,{filename:'actual-record-store.js'});
  await ctx.SentlogRecords.init();
  const part=fs.readFileSync(path.join(__dirname,'../sentlog/part05.txt'),'utf8');
  const start=part.indexOf('function drawingStorageKey'),end=part.indexOf('function showError');
  assert(start>=0&&end>start,'the fixture must execute the actual persist implementation');
  vm.runInContext(part.slice(start,end),ctx,{filename:'actual-app-persist.js'});
  async function disk(){
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('surveyFieldNoteDB',1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try{return await new Promise((resolve,reject)=>{const tx=db.transaction('files','readonly'),s=tx.objectStore('files');let keys,values;
      s.getAllKeys().onsuccess=e=>{keys=e.target.result;};s.getAll().onsuccess=e=>{values=e.target.result;};
      tx.oncomplete=()=>resolve(new Map(keys.map((k,i)=>[k,values[i]])));tx.onabort=()=>reject(tx.error);});}
    finally{db.close();}
  }
  return {ctx,records:ctx.SentlogRecords,disk,capture:()=>B.captureProject({records:ctx.SentlogRecords,localProjectId})};
}
function actualSharedSnapshot(snapshot){
  const runtime=fs.readFileSync(path.join(__dirname,'../sentlog/collaboration-sync-runtime.txt'),'utf8');
  const ctx={SentlogRecordCollaboration:C,structuredClone,getSyncMeta:()=>null,drawingState:id=>snapshot.drawings.find(d=>d.meta.id===id)?.state};ctx.window=ctx;
  vm.createContext(ctx);
  const normalize=runtime.slice(runtime.indexOf('function collaborationNormalizeRecord('),runtime.indexOf('function collaborationNormalizeStored('));
  const capture=runtime.slice(runtime.indexOf('function collaborationProjectSnapshot('),runtime.indexOf('function collaborationCanonicalIncoming('));
  assert(normalize&&capture,'actual collaborative snapshot functions must exist');vm.runInContext(normalize+'\n'+capture,ctx);
  const view=fs.readFileSync(path.join(__dirname,'../sentlog/sync-view.js'),'utf8');
  vm.runInContext(view.slice(view.indexOf('  const clone='),view.indexOf('  const same=')),ctx);
  const payload=copy(ctx.collaborationProjectSnapshot(snapshot.project));
  // build_group_sync_migration.py applies these exact deterministic defaults
  // before snapshotText. No production files are built or changed here.
  const comparison=JSON.parse(ctx.snapshotText(G.normalizeSnapshotPayload(payload)));
  return {payload,comparison};
}
async function reconcileActualSnapshots(before,after){
  const payload=actualSharedSnapshot(before).payload,records=[],metadata=[],hash=text=>createHash('sha256').update(text).digest('hex');
  for(const d of payload.drawings)for(const record of [...d.state.shapes,...(d.state.collabDeletedRecords||[])]){
    const row={ordinal:records.length+1,drawingId:d.meta.id,recordId:record.id,recordJson:json(record),sha256:hash(json(record))};
    row.manifestEntryJson=json({ordinal:row.ordinal,drawingId:row.drawingId,recordId:row.recordId,sha256:row.sha256});records.push(row);
  }
  const values=[['header','project',{project:payload.project}],...payload.drawings.map(d=>{
    const state=copy(d.state);delete state.shapes;delete state.collabDeletedRecords;return ['drawing',d.meta.id,{meta:d.meta,state}];})];
  for(const [kind,key,value]of values){
    const row={ordinal:metadata.length+1,kind,key,metadataJson:json(value),sha256:hash(json(value))};
    row.manifestEntryJson=json({ordinal:row.ordinal,kind,key,sha256:row.sha256});metadata.push(row);
  }
  const receipt={schema:1,baselineId:'actual-app-baseline',ownerId:scope.ownerId,projectId:scope.projectId,clientProjectId:localProjectId,
    drawingIds:payload.project.drawings.map(d=>d.id),snapshotRevision:1,cursor:0,recordCount:records.length,importedCount:records.length,metadataCount:metadata.length,
    snapshotSha256:hash(json(payload)),manifestSha256:hash('['+records.map(r=>r.manifestEntryJson).join(', ')+']'),
    metadataManifestSha256:hash('['+metadata.map(r=>r.manifestEntryJson).join(', ')+']'),hashFormat:'postgres-jsonb-text-sha256-v1',
    state:'active',deltaEnabled:true,deviceMigrationVerified:false,assetDeliveryVerified:false};
  const rawEntries=after.rawEntries.map(([key,value])=>({key,value})),localSnapshot={version:1,kind:'sentlog-legacy-source',projectId:localProjectId,
    rawEntries,issues:[],fingerprint:hash(json(rawEntries)),readyForStaging:true};
  const baseline=await R.readBaseline({receipt,scope,readPage:async()=>({receipt,records,nextOrdinal:records.length,hasMore:false}),
    readMetadataPage:async()=>({receipt,metadata,nextOrdinal:metadata.length,hasMore:false})});
  return R.plan({scope,baseline,localSnapshot});
}
async function draft(env,before,after,prefix='edit',operation='edit'){return env.bridge.prepare({before,after,operation,...options(prefix)});}
const issues=plan=>plan.issues.map(i=>i.code);
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS',name);}
(async()=>{
await test('real persist writes drawing and workspace in one old-store transaction; bridge commits its captured edit only to the replica',async()=>{
  const f=await actualApp(),before=f.capture(),env=environment(before),firstDisk=await f.disk();
  f.ctx.state.shapes[0].memo='現場で追記';f.ctx.persist();assert.equal(f.records.pending,true);
  const after=f.capture();assert.equal(after.source,'editor-memory');assert.equal(after.readyForActivation,false);
  await f.records.settled();const sourceDisk=await f.disk();assert.equal(sourceDisk.get(META).revision,firstDisk.get(META).revision+1);
  assert.equal(JSON.parse(sourceDisk.get(PREFIX+DRAW+'drawing-1')).shapes[0].memo,'現場で追記');
  const p=await draft(env,before,after),receipt=await env.bridge.commit(p);
  assert.equal(p.ready,true);assert.equal(env.writes,1);assert.equal(env.current().outbox.length,1);
  assert(row(receipt.projection).memo.includes('最初の所見'));assert(row(receipt.projection).memo.includes('現場で追記'));
  assert.deepEqual(await f.disk(),sourceDisk,'the bridge must never independently update the old writer');
  assert.equal(receipt.readyForActivation,false);assert.equal(receipt.result.snapshotToken,undefined);env.close();
});
await test('the actual exported batch captures a move intact and blocks it until remote atomic grouping exists',async()=>{
  const f=await actualApp(),before=f.capture(),env=environment(before),origin=row(before);
  const plan=T.makeTransferPlan(before.drawings[0].state,before.drawings[1].state,['record-1'],{...options('transfer'),collaborative:true,
    operation:'move',sourceDrawingId:'drawing-1',targetDrawingId:'drawing-2',targetPage:2,sx:2,sy:3,
    idFactory:()=> 'moved-record',photoIdFactory:()=> 'moved-photo',revisionIdFactory:options('move-revision').idFactory});
  f.records.batch([[DRAW+'drawing-1',json(plan.sourceState)],[DRAW+'drawing-2',json(plan.targetState)],[WS,json({projects:[before.project]})]]);
  const after=f.capture();await f.records.settled();const p=await draft(env,before,after,'move-events','move');
  assert.equal(p.ready,false);assert.equal(p.atomicGroupRequired,true);assert.equal(p.changes.length,2);
  assert(issues(p).includes('BRIDGE_ATOMIC_GROUP_REQUIRED'));await assert.rejects(()=>env.bridge.commit(p),e=>e.code==='BRIDGE_REVIEW');
  assert.equal(env.writes,0);assert.equal(env.current().outbox.length,0);
  assert(C.isDeleted(row(p.after)));const moved=row(p.after,'moved-record');
  assert.equal(moved.page,2);assert.deepEqual(moved.point,{x:20,y:60});assert.deepEqual(moved.collab.comments,origin.collab.comments);
  assert.equal(moved.photos[0].id,'moved-photo');assert.equal(moved.photos[0].transferSource.photoId,'photo-1');
  const migrationPlan=await reconcileActualSnapshots(before,after);assert.equal(migrationPlan.readyForInstall,false);
  assert(migrationPlan.reviewItems.some(x=>x.code==='RECONCILE_ATOMIC_GROUP_REQUIRED'&&x.blocking));
  assert.equal(migrationPlan.state.outbox.length,2,'pending legacy move stays inspectable without authorization to install or send');env.close();
});
await test('explicit operation is mandatory and a partially captured move cannot be sent as an ordinary edit',async()=>{
  const before=initial(),after=copy(before),env=environment(before);row(after).memo='途中まで捕捉された入力';
  const missing=await env.bridge.prepare({before,after,...options('missing-operation')});assert(issues(missing).includes('BRIDGE_OPERATION'));
  assert.equal(missing.ready,false);assert.equal(row(missing.submittedAfter).memo,'途中まで捕捉された入力');
  await assert.rejects(()=>env.bridge.commit(missing));
  const partial=await draft(env,before,after,'partial','move');assert(issues(partial).includes('BRIDGE_ATOMIC_GROUP_REQUIRED'));
  await assert.rejects(()=>env.bridge.commit(partial));assert.equal(env.writes,0);env.close();
});
await test('same-ID relocation, unlinked create plus deletion, and destination-only transfer markers all block',async()=>{
  for(const kind of ['same-id','unlinked','destination-only','same-drawing']){
    const before=initial(),after=copy(before),env=environment(before),original=row(before);
    if(kind==='same-id'){
      after.drawings[0].state.shapes=after.drawings[0].state.shapes.filter(r=>r.id!==original.id);after.drawings[1].state.shapes.push(copy(original));
    }else{
      if(kind!=='destination-only'){
        after.drawings[0].state.shapes=after.drawings[0].state.shapes.filter(r=>r.id!==original.id);
        after.drawings[0].state.collabDeletedRecords.push(C.markDeleted(original,{...options('move-delete'),expectedToken:C.revisionToken(original)}));
      }
      let target=baseRecord('new-destination');
      if(kind==='destination-only')target=C.applyLocalEdit(target,{...target,transferOrigin:{drawingId:'another-source',recordId:'original',operation:'move'}},options('move-marker'));
      after.drawings[kind==='same-drawing'?0:1].state.shapes.push(target);
    }
    const p=await draft(env,before,after,'mislabeled','edit');assert.equal(p.ready,false,kind);assert.equal(p.atomicGroupRequired,true,kind);
    assert(issues(p).includes('BRIDGE_ATOMIC_GROUP_REQUIRED'),kind);await assert.rejects(()=>env.bridge.commit(p));assert.equal(env.writes,0);env.close();
  }
});
await test('copy operations keep the source and its complete history without being mistaken for destructive moves',async()=>{
  const before=initial(),after=copy(before),env=environment(before),origin=row(before);
  const copyPlan=T.makeTransferPlan(before.drawings[0].state,before.drawings[1].state,['record-1'],{...options('copy'),collaborative:true,
    operation:'copy',sourceDrawingId:'drawing-1',targetDrawingId:'drawing-2',targetPage:2,idFactory:()=> 'copied-record',photoIdFactory:()=> 'copied-photo',revisionIdFactory:options('copy-revision').idFactory});
  after.drawings[0].state=copyPlan.sourceState;after.drawings[1].state=copyPlan.targetState;
  const p=await draft(env,before,after,'copy-event','copy');assert.equal(p.ready,true);assert.equal(p.atomicGroupRequired,false);
  const r=await env.bridge.commit(p);assert(C.equal(row(r.projection),origin));assert.deepEqual(row(r.projection,'copied-record').collab.comments,origin.collab.comments);
  assert.equal(env.writes,1);env.close();
});
await test('ordinary edits to an already imported moved record remain possible',async()=>{
  const before=initial(),record=row(before);before.drawings[0].state.shapes[0]=C.applyLocalEdit(record,{...record,
    transferOrigin:{drawingId:'old-drawing',recordId:'old-record',operation:'move'}},options('historic-move'));
  const after=copy(before),env=environment(before);row(after).memo='移動後の通常追記';const p=await draft(env,before,after,'ordinary-after-move');
  assert.equal(p.ready,true);assert.equal(p.atomicGroupRequired,false);const r=await env.bridge.commit(p);assert(row(r.projection).memo.includes('移動後の通常追記'));env.close();
});
await test('drawing memos, dimension lines and ordinary record geometry use the same immutable changes',async()=>{
  const before=initial(),after=copy(before),env=environment(before);
  row(after).point.x=77;row(after,'memo-1').text='点検口';row(after,'dimension-1').manualText='3 m';
  const p=await draft(env,before,after,'all-kinds');assert.equal(p.ready,true);assert.equal(p.changes.length,3);
  const r=await env.bridge.commit(p);assert.equal(env.writes,1);assert.equal(row(r.projection).point.x,77);
  assert.equal(row(r.projection,'memo-1').text,'点検口');assert.equal(row(r.projection,'dimension-1').manualText,'3 m');env.close();
});
await test('raw new records are normalized while pre-authored copied histories are never reseeded',async()=>{
  const before=initial(),after=copy(before),env=environment(before);
  after.drawings[0].state.shapes.push({id:'new-record',kind:'field-record',recordKind:'field-record',memo:'新しい記録',photos:[],point:{x:1,y:1}});
  const p=await draft(env,before,after,'create');assert.equal(p.ready,true);const r=await env.bridge.commit(p);
  const created=row(r.projection,'new-record');assert(created.collab);assert.equal(created.memo,'新しい記録');
  assert.equal(C.view(created).comments[0].heads[0].actor.deviceId,scope.deviceId);env.close();
});
await test('edits rebase onto received comments and preserve records added by another device',async()=>{
  const before=initial(),after=copy(before);row(after).memo='この端末の追記';
  const env=environment(before,state=>{state.records[D.keyOf('drawing-1','record-1')]=C.appendComment(row(before),'別端末の追記',options('peer','peer-device'));
    state.records[D.keyOf('drawing-2','peer-record')]=baseRecord('peer-record');});
  const p=await draft(env,before,after),r=await env.bridge.commit(p);assert.equal(p.ready,true);
  for(const text of ['最初の所見','この端末の追記','別端末の追記'])assert(row(r.projection).memo.includes(text));
  assert(row(r.projection,'peer-record'));env.close();
});
await test('overlapping scalar edits remain visible alternatives rather than silently replacing the peer value',async()=>{
  const before=initial(),after=copy(before),record=row(before);row(after).type='ひび割れ';
  const env=environment(before,state=>{state.records[D.keyOf('drawing-1',record.id)]=C.setField(record,'type','変形',{
    ...options('peer-field','peer-device'),expectedHeads:C.view(record).fields.type.headIds});});
  const p=await draft(env,before,after),r=await env.bridge.commit(p),view=C.view(row(r.projection));
  assert.equal(view.fields.type.conflict,true);assert.deepEqual(new Set(view.fields.type.heads.map(h=>h.value)),new Set(['ひび割れ','変形']));env.close();
});
await test('an unchanged missing baseline record prevents a successful projection from discarding it',async()=>{
  const before=initial(),after=copy(before);row(after).memo='保存したい入力';
  const env=environment(before,state=>{delete state.records[D.keyOf('drawing-1','memo-1')];});
  const p=await draft(env,before,after);assert.equal(p.ready,false);assert(issues(p).includes('BRIDGE_RECORD_MISSING'));
  await assert.rejects(()=>env.bridge.commit(p),e=>e.code==='BRIDGE_REVIEW');assert.equal(env.writes,0);assert(row(p.submittedAfter,'memo-1'));env.close();
});
await test('a divergent baseline or unknown received drawing blocks all changes with the draft retained',async()=>{
  for(const kind of ['lineage','drawing']){
    const before=initial(),after=copy(before);row(after).memo='残す文章';
    const env=environment(before,state=>{if(kind==='lineage')state.records[D.keyOf('drawing-1','record-1')]=C.upgrade({...baseRecord(),collab:undefined,memo:'別系統'});
      else state.records[D.keyOf('unknown-drawing','peer-record')]=baseRecord('peer-record');});
    const p=await draft(env,before,after);assert.equal(p.ready,false);assert.equal(row(p.submittedAfter).memo,'残す文章');
    await assert.rejects(()=>env.bridge.commit(p),e=>e.code==='BRIDGE_REVIEW');assert.equal(env.writes,0);env.close();
  }
});
await test('a missing tombstone blocks a mixed draft instead of committing only its other valid edit',async()=>{
  const before=initial(),after=copy(before),env=environment(before);after.drawings[0].state.shapes=after.drawings[0].state.shapes.filter(r=>r.id!=='record-1');
  row(after,'memo-1').text='残す入力';const p=await draft(env,before,after);assert.equal(p.changes.length,1);assert(issues(p).includes('BRIDGE_RECORD_REMOVAL'));
  await assert.rejects(()=>env.bridge.commit(p),e=>e.code==='BRIDGE_REVIEW');assert.equal(env.writes,0);assert.equal(row(p.submittedAfter,'memo-1').text,'残す入力');env.close();
});
await test('explicit record deletion and restoration retain immutable histories and correct visible buckets',async()=>{
  const before=initial(),after=copy(before),record=row(before),env=environment(before);
  const tomb=C.markDeleted(record,{...options('delete'),expectedToken:C.revisionToken(record)});
  after.drawings[0].state.shapes=after.drawings[0].state.shapes.filter(r=>r.id!==record.id);after.drawings[0].state.collabDeletedRecords.push(tomb);
  const deleted=await env.bridge.commit(await draft(env,before,after));assert(C.isDeleted(row(deleted.projection)));
  assert.equal(deleted.projection.drawings[0].state.shapes.some(r=>r.id===record.id),false);
  const restored=copy(deleted.projection),current=row(restored),live=C.restore(current,{...options('restore'),expectedToken:C.revisionToken(current)});
  restored.drawings[0].state.collabDeletedRecords=[];restored.drawings[0].state.shapes.push(live);
  const r=await env.bridge.commit(await draft(env,deleted.projection,restored,'restored-event'));
  assert.equal(C.isDeleted(row(r.projection)),false);assert.equal(row(r.projection).memo,'最初の所見');assert.equal(env.writes,2);env.close();
});
await test('raw edits on a deleted record are retained and cannot disappear behind its materialized tombstone',async()=>{
  const before=initial(),record=row(before),tomb=C.markDeleted(record,{...options('deleted-base'),expectedToken:C.revisionToken(record)});
  before.drawings[0].state.shapes=before.drawings[0].state.shapes.filter(r=>r.id!==record.id);before.drawings[0].state.collabDeletedRecords=[tomb];
  const after=copy(before),env=environment(before);row(after).memo='削除後の未反映入力';
  const p=await draft(env,before,after);assert(issues(p).includes('BRIDGE_DELETED_DRAFT'));assert.equal(row(p.submittedAfter).memo,'削除後の未反映入力');
  await assert.rejects(()=>env.bridge.commit(p));assert.equal(env.writes,0);env.close();
});
await test('raw photo omission and empty memo require explicit immutable removal revisions',async()=>{
  for(const kind of ['photo','comment']){
    const before=initial(),after=copy(before),env=environment(before);
    if(kind==='photo')row(after).photos=[];else row(after).memo='';
    const p=await draft(env,before,after);assert.equal(p.ready,false);assert(issues(p).includes(kind==='photo'?'BRIDGE_PHOTO_REMOVAL':'BRIDGE_COMMENT_REMOVAL'));
    await assert.rejects(()=>env.bridge.commit(p));assert.equal(env.writes,0);env.close();
  }
});
await test('explicit photo and comment deletion are accepted without losing their old revisions',async()=>{
  const before=initial(),after=copy(before),env=environment(before),record=row(before);
  let changed=C.removePhoto(record,'photo-1',{...options('remove-photo'),expectedHeads:C.view(record).photos[0].headIds});
  const comment=C.view(changed).comments[0];changed=C.removeComment(changed,comment.id,{...options('remove-comment'),expectedHeads:comment.headIds});
  after.drawings[0].state.shapes[0]=changed;const p=await draft(env,before,after),r=await env.bridge.commit(p);
  assert.equal(p.ready,true);assert.deepEqual(row(r.projection).photos,[]);assert.equal(row(r.projection).memo,'');
  assert(row(r.projection).collab.photos['photo-1'].revisions.length>1);env.close();
});
await test('all shared drawing settings and unknown future metadata are retained rather than silently omitted',async()=>{
  const mutations={pageSettings:{1:{scaleDenom:200}},pageRotations:{1:90},pageStates:{1:{hidden:true}},pageReplacements:{1:{hash:'new'}},
    sourceType:'image',fileName:'replacement.pdf',pageCount:4,dxf:{entities:[1]},leaderMarker:'filled-circle',
    nextGlobalNo:99,typeCounters:{調査:7},autoTracePhotos:[{id:'trace-photo'}],futureSharedOption:{enabled:true}};
  for(const [key,value]of Object.entries(mutations)){
    const before=initial(),after=copy(before),env=environment(before);after.drawings[0].state[key]=value;row(after).memo='設定と同時の記入';
    const p=await draft(env,before,after);assert.equal(p.ready,false,key);assert(p.metadataChanges.some(m=>m.kind==='drawing'&&C.equal(m.after[key],value)),key);
    assert.deepEqual(p.submittedAfter.drawings[0].state[key],value);await assert.rejects(()=>env.bridge.commit(p));assert.equal(env.writes,0);env.close();
  }
});
await test('actual cloud snapshot construction retains full metadata while excluding only its explicit local cache fields',()=>{
  const input=initial(),record=row(input),drawing=input.drawings[0];
  input.project.customProjectOption={kept:true};Object.assign(drawing.meta,{groupId:'group-a',groupName:'主桁',sheetName:'平面',groupOrder:3,sheetOrder:2,deletedAt:40});
  input.project.drawings[0]=copy(drawing.meta);drawing.state.futureSharedOption={kept:true};drawing.state.autoTracePhotos=[{id:'trace',data:'legacy-trace-cache'}];
  record.photos[0].localBlob=new Blob(['abc']);record.photos[0].data='data:image/jpeg;base64,YWJj';
  const {payload,comparison}=actualSharedSnapshot(input),out=payload.drawings[0];
  assert.deepEqual(payload.project,input.project);assert.deepEqual(out.meta,drawing.meta);assert.equal(out.state.labelSize,undefined);
  for(const key of ['currentPage','width','height','pdfPageInfo','nextGlobalNo','typeCounters','pageSettings','pageRotations','futureSharedOption','autoTracePhotos'])
    assert.deepEqual(out.state[key],drawing.state[key],key);
  assert.equal(out.state.shapes[0].photos[0].localBlob,undefined);assert.equal(out.state.shapes[0].photos[0].data,undefined);
  assert.equal(payload.project.updatedAt,10);assert.equal(out.meta.updatedAt,10);
  assert.equal(comparison.project.updatedAt,undefined);assert.equal(comparison.drawings[0].meta.updatedAt,undefined);
  for(const key of ['currentPage','width','height','pdfPageInfo'])assert.equal(comparison.drawings[0].state[key],undefined,key);
  assert.equal(comparison.project.drawings[0].shapeCount,2);assert.equal(comparison.drawings[0].state.nextGlobalNo,4);
  assert.equal(comparison.project.drawings[1].groupId,'drawing-2');assert.equal(comparison.project.drawings[1].sheetOrder,1);
  const editMetadata=B.metadataOf(input);assert.equal(editMetadata.project.drawings[0].shapeCount,undefined);
  assert.equal(editMetadata.drawings[0].state.nextGlobalNo,4);assert.deepEqual(editMetadata.drawings[0].state.autoTracePhotos,drawing.state.autoTracePhotos);
  assert(record.photos[0].localBlob instanceof Blob,'snapshot construction must leave source cache untouched');
});
await test('project names, drawing order, groups and drawing removal are blocked as complete metadata-bearing plans',async()=>{
  const meta=(s,values)=>{Object.assign(s.project.drawings[0],values);s.drawings[0].meta=copy(s.project.drawings[0]);};
  const changes=[s=>{s.project.name='改名';},s=>{s.project.drawings.reverse();},s=>{meta(s,{groupId:'g',groupName:'主桁',sheetName:'平面',groupOrder:2,sheetOrder:3});},
    s=>{meta(s,{deletedAt:50});},
    s=>{s.project.drawings.pop();s.drawings.pop();},s=>{s.project.archived=true;}];
  for(const change of changes){const before=initial(),after=copy(before),env=environment(before);change(after);const p=await draft(env,before,after);
    assert.equal(p.ready,false);assert(p.metadataChanges.some(m=>m.kind==='project'));await assert.rejects(()=>env.bridge.commit(p));assert.equal(env.writes,0);env.close();}
});
await test('device view, computed numbering and display counts do not create shared record edits',async()=>{
  const before=initial(),after=copy(before),env=environment(before);Object.assign(after.drawings[0].state,{currentPage:2,width:600,height:900,pdfPageInfo:{2:{width:600}},labelSize:20});
  after.project.updatedAt=30;after.project.drawings[0].updatedAt=30;after.project.drawings[0].shapeCount=99;after.project.drawings[0].photoCount=99;
  after.drawings[0].meta=copy(after.project.drawings[0]);Object.assign(row(after),{globalNo:40,typeNo:5,autoLabel:'調査5',labelPosEditedAt:100});
  const p=await draft(env,before,after);assert.equal(p.ready,true);assert.equal(p.changes.length,0);assert.deepEqual(p.metadataChanges,[]);
  const r=await env.bridge.commit(p);assert.equal(env.writes,0);assert.equal(r.result.unchanged,true);assert.equal(r.projection.drawings[0].state.currentPage,2);
  assert.equal(row(r.projection).globalNo,40);assert.equal(r.projection.drawings[0].meta.shapeCount,2);env.close();
});
await test('projection preserves editor order and only restores a photo cache matching current metadata',async()=>{
  const before=initial(),record=row(before);record.photos[0].localBlob=new Blob(['abc'],{type:'image/jpeg'});record.photos[0].data='data:image/jpeg;base64,YWJj';
  before.drawings[0].state.shapes.reverse();const state=seeded(before);
  const projected=B.project({template:before,state,scope,localProjectId});assert.deepEqual(projected.drawings[0].state.shapes.map(r=>r.id),['memo-1','record-1']);
  assert.equal(await row(projected).photos[0].localBlob.text(),'abc');assert.equal(row(projected).photos[0].data,record.photos[0].data);
  const raw=C.upgrade(record),edited=copy(raw);edited.photos[0].sha256='b'.repeat(64);
  state.records[D.keyOf('drawing-1',record.id)]=C.applyLocalEdit(raw,edited,options('replace-photo'));
  const changed=B.project({template:before,state,scope,localProjectId});assert.equal(row(changed).photos[0].localBlob,undefined);assert.equal(row(changed).photos[0].data,undefined);
});
await test('photo caches survive an ordinary comment save but are absent from its durable event',async()=>{
  const before=initial(),after=copy(before),env=environment(before);row(after).memo='写真を見て追記';
  row(after).photos[0].localBlob=new Blob(['abc']);row(after).photos[0].data='data:image/jpeg;base64,YWJj';
  const p=await draft(env,before,after),r=await env.bridge.commit(p);assert.equal(await row(r.projection).photos[0].localBlob.text(),'abc');
  const encoded=json(env.current());assert(!encoded.includes('localBlob'));assert(!encoded.includes('data:image'));env.close();
});
await test('caller mutation cannot alter a prepared edit or approve a metadata plan',async()=>{
  const before=initial(),after=copy(before),env=environment(before);row(after).memo='確定した入力';
  const p=await draft(env,before,after);p.changes.length=0;row(p.after).memo='差し替え';p.scope.ownerId='wrong-owner';
  const r=await env.bridge.commit(p);assert(row(r.projection).memo.includes('確定した入力'));assert(!row(r.projection).memo.includes('差し替え'));
  const settings=copy(r.projection);settings.drawings[0].state.pageSettings={1:{scaleDenom:800}};
  const blocked=await draft(env,r.projection,settings,'settings');blocked.ready=true;blocked.metadataChanges=[];
  await assert.rejects(()=>env.bridge.commit(blocked),e=>e.code==='BRIDGE_REVIEW');assert.equal(env.writes,1);env.close();
});
await test('commit receipts are idempotent and unknown or foreign plans cannot be committed',async()=>{
  const before=initial(),after=copy(before),env=environment(before),other=environment(before);row(after).memo='一度だけ';
  const p=await draft(env,before,after);const [a,b]=await Promise.all([env.bridge.commit(p),env.bridge.commit(p)]);assert.deepEqual(a,b);assert.equal(env.writes,1);
  await env.bridge.commit(p);assert.equal(env.writes,1);await assert.rejects(()=>other.bridge.commit(p),e=>e.code==='BRIDGE_PLAN');
  await assert.rejects(()=>env.bridge.commit(copy(p)),e=>e.code==='BRIDGE_PLAN');env.close();other.close();
});
await test('an intervening durable update rejects a stale plan and a fresh rebase preserves both edits',async()=>{
  const before=initial(),after=copy(before),env=environment(before);row(after).memo='編集中の文章';const p=await draft(env,before,after);
  const record=row(before,'memo-1'),next=C.applyLocalEdit(record,{...record,text:'後から届いたメモ'},options('later'));
  await env.replica.change({drawingId:'drawing-1',before:record,after:next,eventId:'later-event'});
  await assert.rejects(()=>env.bridge.commit(p),e=>e.code==='DELTA_STALE');assert.equal(env.writes,1);assert.equal(row(p.submittedAfter).memo,'編集中の文章');
  const r=await env.bridge.commit(await draft(env,before,after,'retry'));assert.equal(row(r.projection,'memo-1').text,'後から届いたメモ');assert(row(r.projection).memo.includes('編集中の文章'));env.close();
});
await test('quota failure leaves the whole batch absent and the same retained plan can be saved after recovery',async()=>{
  const before=initial(),after=copy(before),env=environment(before);row(after).memo='記録の追記';row(after,'dimension-1').manualText='4 m';
  const p=await draft(env,before,after),durable=env.current();env.failOnce();await assert.rejects(()=>env.bridge.commit(p),/容量不足/);
  assert.deepEqual(env.current(),durable);assert.equal(env.writes,0);assert.equal(p.changes.length,2);
  const r=await env.bridge.commit(p);assert.equal(env.writes,1);assert.equal(env.current().outbox.length,2);assert.equal(row(r.projection,'dimension-1').manualText,'4 m');env.close();
});
await test('owner, server project, and device changes fence an already prepared editor action',async()=>{
  for(const key of ['ownerId','projectId','deviceId']){const before=initial(),after=copy(before),env=environment(before);row(after).memo='元の案件に残す';
    const p=await draft(env,before,after);env.changeScope({...scope,[key]:'changed'});
    await assert.rejects(()=>env.bridge.commit(p),e=>e.code==='BRIDGE_SCOPE');assert.equal(env.writes,0);assert.equal(row(p.submittedAfter).memo,'元の案件に残す');env.close();}
});
await test('account change during durable commit never returns a late projection into the new screen',async()=>{
  const before=initial(),after=copy(before),env=environment(before);row(after).memo='元の利用者の入力';const p=await draft(env,before,after);
  env.onWrite(()=>{env.changeScope({...scope,ownerId:'new-owner'});});await assert.rejects(()=>env.bridge.commit(p),e=>e.code==='BRIDGE_SCOPE');
  assert.equal(env.writes,1);assert.deepEqual(env.current().scope,scope);assert.equal(env.current().outbox[0].projectId,scope.projectId);env.close();
});
await test('closing an editor bridge prevents pending plans from writing or projecting',async()=>{
  const before=initial(),after=copy(before),env=environment(before);row(after).memo='離脱前の文章';const p=await draft(env,before,after);env.bridge.close();
  await assert.rejects(()=>env.bridge.commit(p),e=>e.code==='BRIDGE_CLOSED');await assert.rejects(()=>env.bridge.project(after),e=>e.code==='BRIDGE_CLOSED');assert.equal(env.writes,0);env.close();
});
await test('capture rejects cross-project drawing identities, malformed source JSON and missing drawing state',async()=>{
  const f=await actualApp(),workspace=JSON.parse(f.records.getItem(WS));workspace.projects.push({id:'other-project',drawings:[copy(workspace.projects[0].drawings[0])]});
  f.records.setItem(WS,json(workspace));assert.throws(()=>f.capture(),e=>e.code==='BRIDGE_DRAWING');
  f.records.setItem(WS,'invalid-json');assert.throws(()=>f.capture(),e=>e.code==='BRIDGE_SOURCE');
  f.records.setItem(WS,json({projects:[initial().project]}));f.records.removeItem(DRAW+'drawing-1');assert.throws(()=>f.capture(),e=>e.code==='BRIDGE_SOURCE');await f.records.settled();
});
await test('untracked base edits and duplicate record IDs fail without losing their submitted contents',async()=>{
  const before=initial(),after=copy(before);row(before).memo='履歴にない入力';row(after).memo='さらに入力';
  const env=environment(initial()),p=await draft(env,before,after);assert.equal(p.ready,false);assert(issues(p).includes('BRIDGE_UNTRACKED_BASE'));
  await assert.rejects(()=>env.bridge.commit(p));assert.equal(row(p.before).memo,'履歴にない入力');assert.equal(row(p.submittedAfter).memo,'さらに入力');
  const duplicate=initial();duplicate.drawings[0].state.shapes.push(copy(row(duplicate)));
  assert.throws(()=>B.prepare({scope,localProjectId,before:initial(),after:duplicate,...options()}),e=>e.code==='BRIDGE_RECORD');env.close();
});
console.log(passed+' delta app bridge scenarios passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

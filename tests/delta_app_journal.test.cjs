'use strict';
// Disposable IndexedDB only. Exercises the actual canvas writer and durable
// replay controller, including crashes between its two database transactions.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange,IDBObjectStore,IDBCursor}=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const B=require('../sentlog/delta-sync-app-bridge.js'),J=require('../sentlog/delta-sync-app-journal.js');
const M=require('../sentlog/delta-sync-metadata.js'),Source=require('../sentlog/delta-sync-legacy-source.js');
const Runtime=require('../sentlog/delta-sync-app-runtime.js'),Installer=require('../sentlog/delta-sync-app-migration.js');
const I=require('../sentlog/delta-sync-indexeddb.js'),Migration=require('../sentlog/delta-sync-migration.js');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',PREFIX='__sentlog_record__:';
const LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1',META='__sentlog_records_meta_v130__';
const scope={ownerId:'owner',projectId:'shared-project',deviceId:'device'},localProjectId='local-project',actor={deviceId:'device',deviceName:'現場端末'};
const copy=x=>structuredClone(x),json=JSON.stringify;
function snapshot(){const state={fileName:'',sourceType:null,pageCount:1,currentPage:1,pageSettings:{1:{scale:100}},
  shapes:[C.upgrade({id:'record-1',type:'腐食',memo:'初期所見',photos:[]})],collabDeletedRecords:[]};
  const meta={id:'drawing-1',name:'図面1',fileName:'',sourceType:null,pageCount:1};
  return {version:1,kind:'sentlog-app-project',localProjectId,project:{id:localProjectId,name:'現場',drawings:[copy(meta)]},drawings:[{meta,state}]};}
function builtWriter(){let code=fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8');
  const builder=fs.readFileSync(path.join(__dirname,'../scripts/build_capacity.py'),'utf8'),injected=/storage_code=r'''([\s\S]*?)'''/.exec(builder)[1];
  code=code.replace('  async function stats(){',injected+'\n  async function stats(){');
  code=code.replace('batch,replaceAll,stats,','batch,replaceAll,archiveAtomic,stats,');return code;}
async function app({factory=new IDBFactory(),initial=snapshot(),local=new Map()}={}){
  if(!(await factory.databases()).length){local.set(WS,json({projects:[initial.project]}));for(const d of initial.drawings)local.set(DRAW+d.meta.id,json(d.state));}
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const ctx={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,crypto:webcrypto,SentlogDeltaSyncCore:D};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(builtWriter(),ctx);const records=ctx.SentlogRecords;await records.init();
  const capture=()=>B.captureProject({records,localProjectId});
  async function disk(store='files'){
    const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),s=tx.objectStore(store);let keys,values;
      s.getAllKeys().onsuccess=e=>keys=e.target.result;s.getAll().onsuccess=e=>values=e.target.result;tx.oncomplete=()=>resolve(new Map(keys.map((k,i)=>[k,values[i]])));tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
  return {factory,local,localStorage,ctx,records,capture,disk};
}
async function bind(f,options={}){
  const cutoff=await f.records.deltaJournal.begin({scope,localProjectId,actor,serverRevision:options.serverRevision});
  const base=copy(cutoff.snapshot),records={};for(const drawing of base.drawings)for(const record of [...drawing.state.shapes,...drawing.state.collabDeletedRecords])records[D.keyOf(drawing.meta.id,record.id)]=C.upgrade(record);
  if(options.metadata)Object.assign(records,await M.seed(base));
  let durable={version:2,scope:copy(scope),cursor:0,records,outbox:[]},writes=0,fail=false;
  const store={read:async()=>copy(durable),write:async value=>{if(fail){fail=false;throw Error('quota');}durable=copy(value);writes++;}};
  if(!options.staging)await f.records.deltaJournal.activate({scope,localProjectId,baselineId:'baseline',baselineSnapshot:base,metadataRecords:options.metadata?M.metadataRecords(records):{}});
  function controller(extra={}){
    const transport={online:()=>false,push:async()=>{throw Error('offline');},pushGroup:async()=>{throw Error('offline');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
    const replica=D.createReplica({...scope,store,transport}),bridge=B.createBridge({replica,scope,localProjectId,currentScope:()=>scope});
    const controller=J.createController({records:f.records,scope,localProjectId,replica,replicaStore:store,bridge,currentScope:()=>scope,metadata:M,...extra});
    return {controller,replica,bridge,close(){controller.close();bridge.close();replica.close();}};
  }
  return {cutoff,store,controller,get writes(){return writes;},read:()=>copy(durable),failOnce(){fail=true;}};
}
function edit(f,text){const state=JSON.parse(f.records.getItem(DRAW+'drawing-1'));state.shapes[0].memo=text;f.records.setItem(DRAW+'drawing-1',json(state));}
function waitPoint(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};}
function projectionWriter(f){return async(projection,options)=>{
  const workspace=JSON.parse(f.records.getItem(WS));const index=workspace.projects.findIndex(p=>p.id===localProjectId);
  if(index<0)workspace.projects.push(copy(projection.project));else workspace.projects[index]=copy(projection.project);
  return f.records.deltaJournal.applyProjection({...options,writes:[[WS,json(workspace)],...projection.drawings.map(d=>[DRAW+d.meta.id,json(d.state)])]});};}
function runtimeFixture(f,e,options={}){
  let user=scope.ownerId,generation=1,enabled=!options.staging,inspections=0,installedRevision=null;const auth=new Set(),published=[];
  const cp={id:scope.projectId,client_key:localProjectId,name:'現場'},payload=snapshot();
  const transport={getScope:()=>copy(scope),online:()=>false,ready:async()=>true,close(){},wake(){},push:async()=>{throw Error('offline');},pushGroup:async()=>{throw Error('offline');},list:async()=>[],
    getCapabilities:()=>({atomicGroups:true,sharedMetadata:true,certifiedArchive:true,writerJournal:2}),
    inspect:async()=>({schema:1,...scope,enabled,canActivate:true,headSeq:0,snapshotRevision:++inspections===1?9:12,checking:false,
      baseline:enabled?{baselineId:'baseline',snapshotRevision:12}:null}),
    publishCheckpoint:async headSeq=>{const out={schema:1,projectId:scope.projectId,headSeq,revision:12,payloadSha256:'a'.repeat(64),payload};published.push(out);return copy(out);}};
  const store={...e.store,readProvenance:async()=>options.missing?null:{baseline:{baselineId:'baseline'}},close(){}};
  if(options.missing)store.read=async()=>null;
  const runtime=Runtime.createRuntime({records:f.records,url:'https://example.invalid',key:'fixture',session:()=>({user:{id:user}}),ensureSession:async()=>{},
    authGeneration:()=>generation,subscribeAuth:fn=>{auth.add(fn);return()=>auth.delete(fn);},deviceId:()=>scope.deviceId,actor:()=>copy(actor),
    install:async args=>{installedRevision=args.revision;await f.records.deltaJournal.activate({scope,localProjectId,baselineId:'baseline',baselineSnapshot:e.cutoff.snapshot,
      metadataRecords:M.metadataRecords(e.read().records)});enabled=true;},
    applyProjection:async(cp,projection,context)=>{if(options.beforeProjection)await options.beforeProjection();return projectionWriter(f)(projection,context);},
    readFile:async key=>(await f.disk()).get(key),withFileLock:async(key,fn)=>fn(),
    factories:{provider:()=>({}),transport:()=>transport,store:()=>store,...options.factories}});
  return {runtime,cp,published,get installedRevision(){return installedRevision;},switchAuth(){user='other-owner';generation++;for(const fn of auth)fn();}};
}
async function installerFixture(f,{onRead}={}){
  const server=snapshot(),hash=async text=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',await new Blob([text]).arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const rows=[],metadata=[];
  for(const drawing of server.drawings)for(const record of [...drawing.state.shapes,...drawing.state.collabDeletedRecords]){
    const row={ordinal:rows.length+1,drawingId:drawing.meta.id,recordId:record.id,recordJson:json(record),sha256:await hash(json(record))};
    row.manifestEntryJson=json({ordinal:row.ordinal,drawingId:row.drawingId,recordId:row.recordId,sha256:row.sha256});rows.push(row);
  }
  const header={project:copy(server.project)},values=[['header','project',header],...server.drawings.map(d=>{const state=copy(d.state);delete state.shapes;delete state.collabDeletedRecords;return ['drawing',d.meta.id,{meta:d.meta,state}];})];
  for(const [kind,key,value]of values){const row={ordinal:metadata.length+1,kind,key,metadataJson:json(value),sha256:await hash(json(value))};row.manifestEntryJson=json({ordinal:row.ordinal,kind,key,sha256:row.sha256});metadata.push(row);}
  const receipt={schema:1,baselineId:'baseline',ownerId:scope.ownerId,projectId:scope.projectId,clientProjectId:localProjectId,drawingIds:server.project.drawings.map(d=>d.id),
    snapshotRevision:9,cursor:0,recordCount:rows.length,importedCount:rows.length,metadataCount:metadata.length,snapshotSha256:await hash(json({project:server.project,drawings:server.drawings})),
    manifestSha256:await hash('['+rows.map(r=>r.manifestEntryJson).join(', ')+']'),metadataManifestSha256:await hash('['+metadata.map(r=>r.manifestEntryJson).join(', ')+']'),
    hashFormat:'postgres-jsonb-text-sha256-v1',state:'verified',deltaEnabled:false,deviceMigrationVerified:false,assetDeliveryVerified:false};
  let readHook=onRead,currentScope=scope,activated=0;
  const transport={getCapabilities:()=>({atomicGroups:true,sharedMetadata:true}),pushGroup:async()=>{},
    prepareBaseline:async revision=>{assert.equal(revision,9);return copy(receipt);},importBaselineBatch:async()=>{throw Error('already verified');},
    activateBaseline:async(id,proof)=>{assert.equal(id,'baseline');assert.equal(proof.writerVersion,2);activated++;receipt.state='active';receipt.deltaEnabled=true;return copy(receipt);},
    readBaselinePage:async(id,after,limit)=>{if(readHook){const hook=readHook;readHook=null;await hook();}return {receipt:copy(receipt),records:rows.slice(after,after+limit),nextOrdinal:Math.min(after+limit,rows.length),hasMore:after+limit<rows.length};},
    readBaselineMetadataPage:async(id,after,limit)=>({receipt:copy(receipt),metadata:metadata.slice(after,after+limit),nextOrdinal:Math.min(after+limit,metadata.length),hasMore:after+limit<metadata.length})};
  const store=I.createStore({...scope,indexedDB:f.factory});
  function installer(records=f.records){return Installer.createInstaller({records,factories:{
    source:args=>Source.createSource({...args,indexedDB:f.factory,localStorage:f.localStorage,crypto:webcrypto}),
    migrationStore:s=>Migration.createStore({...s,indexedDB:f.factory})}});}
  const args=()=>({scope,localProjectId,transport,store,mode:{enabled:receipt.deltaEnabled,baseline:receipt.deltaEnabled?copy(receipt):null,snapshotRevision:9},revision:9,currentScope:()=>currentScope,actor});
  return {store,transport,receipt,installer,args,get activated(){return activated;},switchScope(){currentScope={...scope,ownerId:'other-owner'};}};
}
let passed=0;async function test(name,fn){if(process.env.JOURNAL_CASE&&!new RegExp(process.env.JOURNAL_CASE).test(name))return;await fn();passed++;console.log('PASS',name);}
(async()=>{
await test('ordinary canvas commits atomically pair raw records and stable replay intents',async()=>{
  const f=await app(),e=await bind(f);edit(f,'現場の追記');await f.records.settled();
  const rows=[...(await f.disk(LOG)).values()];assert.equal(rows.length,1);assert.equal(rows[0].changes[0].before,e.cutoff.rawEntries.find(x=>x[0]===DRAW+'drawing-1')[1]);
  assert.equal(JSON.parse(rows[0].changes[0].after).shapes[0].memo,'現場の追記');
  const c=e.controller();await c.controller.drain();assert.equal(e.read().outbox.length,1);assert(e.read().records[D.keyOf('drawing-1','record-1')].memo.includes('現場の追記'));
  assert.equal((await f.records.deltaJournal.claim({scope,localProjectId})),null);assert(f.capture().drawings[0].state.shapes[0].memo.includes('現場の追記'));c.close();
});
await test('journal append quota failure rolls back the record and keeps its retryable editor input',async()=>{
  const f=await app();await bind(f);const before=await f.disk(),original=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){if(this.name===LOG)throw Object.assign(Error('quota'),{name:'QuotaExceededError'});return original.apply(this,args);};
  try{edit(f,'保存容量の不足中の入力');await assert.rejects(()=>f.records.settled(),/quota/);}finally{IDBObjectStore.prototype.add=original;}
  assert.equal((await f.disk()).get(PREFIX+DRAW+'drawing-1'),before.get(PREFIX+DRAW+'drawing-1'));assert.equal((await f.disk(LOG)).size,0);
  assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-1')).shapes[0].memo,'保存容量の不足中の入力');await f.records.retry();assert.equal((await f.disk(LOG)).size,1);
});
await test('restart before replay restores a stable claim and finishes the offline outbox',async()=>{
  const f=await app(),e=await bind(f);edit(f,'再起動前の入力');await f.records.settled();const first=await f.records.deltaJournal.claim({scope,localProjectId});
  const reopened=await app({factory:f.factory,local:f.local});const second=await reopened.records.deltaJournal.claim({scope,localProjectId});assert.equal(second.id,first.id);assert.deepEqual(second.rowIds,first.rowIds);
  f.records=reopened.records;f.capture=reopened.capture;const c=e.controller();await c.controller.drain();assert.equal(e.read().outbox.length,1);assert(e.read().records[D.keyOf('drawing-1','record-1')].memo.includes('再起動前の入力'));c.close();
});
await test('replica crash after commit but before WAL acknowledgement replays exactly once',async()=>{
  const f=await app(),e=await bind(f);edit(f,'二重にしない追記');await f.records.settled();let once=true;
  const first=e.controller({afterReplicaCommit:()=>{if(once){once=false;throw Error('simulated crash');}}});
  await assert.rejects(()=>first.controller.drain(),/simulated crash/);const afterCrash=e.read();assert.equal(afterCrash.outbox.length,1);first.close();
  const reopened=await app({factory:f.factory,local:f.local});f.records=reopened.records;f.capture=reopened.capture;const retry=e.controller();await retry.controller.drain();
  assert.deepEqual(e.read().records,afterCrash.records);assert.deepEqual(e.read().outbox,afterCrash.outbox);assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);retry.close();
});
await test('new raw input during replica replay is retained for the next stable claim',async()=>{
  const f=await app(),e=await bind(f);edit(f,'一つ目の追記');await f.records.settled();let once=true;
  const c=e.controller({afterReplicaCommit:async()=>{if(once){once=false;edit(f,'二つ目の追記');await f.records.settled();}}});
  await c.controller.drain();const value=e.read().records[D.keyOf('drawing-1','record-1')];assert(value.memo.includes('一つ目の追記'));assert(value.memo.includes('二つ目の追記'));
  assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);c.close();
});
await test('a drawing written before workspace membership is retained in the later creation claim',async()=>{
  const f=await app(),e=await bind(f,{metadata:true});const state={shapes:[C.upgrade({id:'new-record',memo:'先に保存した図面',photos:[]})],collabDeletedRecords:[]};
  f.records.setItem(DRAW+'new-drawing',json(state));await f.records.settled();assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);
  const workspace=JSON.parse(f.records.getItem(WS));workspace.projects[0].drawings.push({id:'new-drawing',name:'新しい図面'});f.records.setItem(WS,json(workspace));await f.records.settled();
  const claim=await f.records.deltaJournal.claim({scope,localProjectId});assert.equal(claim.before.drawings.length,1);assert.equal(claim.after.drawings.length,2);assert.equal(claim.after.drawings[1].state.shapes[0].memo,'先に保存した図面');
  const c=e.controller();await c.controller.drain();assert.equal(e.read().records[D.keyOf('new-drawing','new-record')].memo,'先に保存した図面');assert.equal(f.capture().project.drawings.length,2);c.close();
});
await test('drawing settings are saved through the real writer, durable outbox and projected view',async()=>{
  const f=await app(),e=await bind(f,{metadata:true});const state=JSON.parse(f.records.getItem(DRAW+'drawing-1'));state.pageSettings[1].scale=250;
  f.records.setItem(DRAW+'drawing-1',json(state));await f.records.settled();const c=e.controller();await c.controller.drain();
  assert.equal(f.capture().drawings[0].state.pageSettings[1].scale,250);assert(e.read().outbox.length>0);assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);c.close();
});
await test('created record replay after durable commit uses identical immutable IDs',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),state=JSON.parse(f.records.getItem(DRAW+'drawing-1'));state.shapes.push({id:'new-record',memo:'新規入力',photos:[]});
  f.records.setItem(DRAW+'drawing-1',json(state));await f.records.settled();const first=e.controller({afterReplicaCommit:()=>{throw Error('crash');}});
  await assert.rejects(()=>first.controller.drain(),/crash/);const saved=e.read();first.close();const next=e.controller();await next.controller.drain();
  assert.deepEqual(e.read().records,saved.records);assert.deepEqual(e.read().outbox,saved.outbox);assert.equal(f.capture().drawings[0].state.shapes.length,2);next.close();
});
await test('old remote writer cannot bypass a bound project; projection defers during new input',async()=>{
  const f=await app();await bind(f);const before=f.records.getItem(DRAW+'drawing-1'),changed=JSON.parse(before);changed.shapes[0].memo='旧受信';
  assert.throws(()=>f.records.setItem(DRAW+'drawing-1',json(changed),{origin:'remote'}),e=>e.code==='JOURNAL_REMOTE_WRITER');assert.equal(f.records.getItem(DRAW+'drawing-1'),before);
  assert.throws(()=>f.records.removeItem(WS,{origin:'remote'}),e=>e.code==='JOURNAL_REMOTE_WRITER');
  edit(f,'手元の入力');const result=await f.records.deltaJournal.applyProjection({scope,localProjectId,writes:[[DRAW+'drawing-1',before]],expectedRecords:[[DRAW+'drawing-1',before]],validate:()=>true});
  assert.equal(result.applied,false);await f.records.settled();assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-1')).shapes[0].memo,'手元の入力');
});
await test('archiveAtomic and clearFiles retain original bytes in the same deletion intent',async()=>{
  const f=await app();await bind(f);await f.records.writeFile('photo:drawing-1:p',new Blob(['original'],{type:'image/jpeg'}));
  await f.records.archiveAtomic({writes:[],deleteFiles:[{key:'photo:drawing-1:p',size:8}],expectedWorkspace:f.records.getItem(WS)});
  assert.equal((await f.disk()).has('photo:drawing-1:p'),false);const removed=[...(await f.disk(LOG)).values()].find(x=>x.mutationKind==='archive');
  assert.equal(await removed.files[0].before.text(),'original');assert.equal(removed.files[0].after,null);
  await f.records.writeFile('background:drawing-1',new Blob(['pdf']));await f.records.clearFiles();
  const cleared=[...(await f.disk(LOG)).values()].find(x=>x.mutationKind==='file-delete');assert.equal(await cleared.files[0].before.text(),'pdf');
});
await test('archive transaction rejects same-size cross-tab file replacement after verification',async()=>{
  const f=await app();await bind(f);const key='photo:drawing-1:p';await f.records.writeFile(key,new Blob(['old']));
  const expectedFileStates=await f.records.readFileStates([key]),other=await app({factory:f.factory,local:f.local});
  await other.records.writeFile(key,new Blob(['new']));assert.notDeepEqual(await f.records.readFileStates([key]),expectedFileStates);
  await assert.rejects(()=>f.records.archiveAtomic({writes:[],deleteFiles:[{key,size:3}],expectedWorkspace:f.records.getItem(WS),expectedFileStates}),e=>e.code==='JOURNAL_FILE_CHANGED');
  assert.equal(await (await f.disk()).get(key).text(),'new');assert.equal([...(await f.disk(LOG)).values()].filter(x=>x.mutationKind==='archive').length,0);
});
await test('archive guard is checked after settling and again inside the deletion transaction',async()=>{
  const f=await app();await bind(f);const key='photo:drawing-1:p';await f.records.writeFile(key,new Blob(['bytes']));let checks=0;
  await assert.rejects(()=>f.records.archiveAtomic({writes:[],deleteFiles:[{key,size:5}],expectedWorkspace:f.records.getItem(WS),validate:()=>++checks===1}),e=>e.code==='JOURNAL_GUARD');
  assert.equal(checks,2);assert.equal(await (await f.disk()).get(key).text(),'bytes');
  await assert.rejects(()=>f.records.archiveAtomic({writes:[],deleteFiles:[{key,size:5}],expectedWorkspace:f.records.getItem(WS),validate:async()=>true}),e=>e.code==='JOURNAL_GUARD');
  assert.equal(await (await f.disk()).get(key).text(),'bytes');
});
await test('replaceAll protects prior record and file images and explicitly marks restoration',async()=>{
  const f=await app(),e=await bind(f);await f.records.writeFile('photo:drawing-1:old',new Blob(['before']));
  const records=copy(e.cutoff.rawEntries),drawing=JSON.parse(records.find(x=>x[0]===DRAW+'drawing-1')[1]);drawing.shapes[0].memo='復元した入力';
  records.find(x=>x[0]===DRAW+'drawing-1')[1]=json(drawing);await f.records.replaceAll(records,[]);
  const row=[...(await f.disk(LOG)).values()].find(x=>x.mutationKind==='restore');assert(row.contexts.some(x=>x.operation==='restore'));assert.equal(await row.files[0].before.text(),'before');
  assert.equal(JSON.parse(row.changes.find(x=>x.key===DRAW+'drawing-1').before).shapes[0].memo,'初期所見');
});
await test('verified local project archival remains detached until explicit restoration',async()=>{
  const f=await app(),e=await bind(f,{metadata:true});const workspace=f.records.getItem(WS);
  await f.records.archiveAtomic({writes:[[WS,json({projects:[]})],[DRAW+'drawing-1',null]],deleteFiles:[],expectedWorkspace:workspace,
    operation:'archive-local',context:{localArchive:true,mode:'project',projectId:localProjectId,jobId:'verified-job'}});
  assert.equal(f.records.deltaJournal.bindingFor(localProjectId).phase,'detached');const c=e.controller();const result=await c.controller.drain();assert.equal(result.projection.detached,true);
  assert.equal(JSON.parse(f.records.getItem(WS)).projects.length,0);assert.equal(e.read().outbox.length,0);
  await f.records.replaceAll(e.cutoff.rawEntries,[],{operation:'restore'});assert.equal(f.records.deltaJournal.bindingFor(localProjectId).phase,'active');
  await c.controller.drain();assert.equal(f.capture().drawings[0].state.shapes[0].memo,'初期所見');assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);c.close();
});
await test('protected migration cutoff ignores journaled later edits but rechecks capture intent',async()=>{
  const f=await app();await f.records.writeFile('photo:drawing-1:p',new Blob(['cutoff']));
  const cutoff=await f.records.deltaJournal.begin({scope,localProjectId,actor});edit(f,'基準後の追記');await f.records.settled();
  await f.records.writeFile('photo:drawing-1:p',new Blob(['replacement']));
  const source=Source.createSource({indexedDB:f.factory,localStorage:f.localStorage,crypto:webcrypto,journal:f.records.deltaJournal});
  const saved=await source.capture(localProjectId,{recordCutoff:cutoff});assert.equal(saved.source.recordRevision,cutoff.sourceRevision);
  assert.equal(JSON.parse(saved.rawEntries.find(x=>x.key===DRAW+'drawing-1').value).shapes[0].memo,'初期所見');
  assert.equal(await saved.files.find(x=>x.key==='photo:drawing-1:p').blob.text(),'cutoff');assert.equal((await source.recheck(saved)).unchanged,true);
  f.local.set('sentlogPhotoCaptureIntentV1',json({version:1,entries:{},operations:{}}));assert.equal((await source.recheck(saved)).unchanged,false);source.close();
});
await test('version-1 reopen is rejected and per-key writer capabilities reflect real pending work',async()=>{
  const f=await app();await assert.rejects(()=>new Promise((resolve,reject)=>{const q=f.factory.open('surveyFieldNoteDB',1);q.onsuccess=()=>{q.result.close();resolve();};q.onerror=()=>reject(q.error);}),e=>e.name==='VersionError');
  const pending=f.records.writeFile('photo:drawing-1:p',new Blob(['pending']));assert.equal(f.records.writerState('photo:drawing-1:p').pending,1);assert.equal(f.records.writerState('photo:drawing-1:p').exclusive,false);
  await pending;assert.equal(f.records.writerState('photo:drawing-1:p').pending,0);assert.equal(f.records.writerState('photo:drawing-1:p').exclusive,true);
  const token={operation:'asset'},task=f.records.writeFile('photo:drawing-1:q',new Blob(['guarded']),{ownerToken:token,validate:()=>f.records.writerState('photo:drawing-1:q',{ownerToken:token}).exclusive});
  assert.equal(f.records.writerState('photo:drawing-1:q').exclusive,false);assert.equal(f.records.writerState('photo:drawing-1:q',{ownerToken:token}).exclusive,true);await task;
});
await test('delayed UI projection cannot overwrite a newer durable replica snapshot',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),started=waitPoint(),release=waitPoint();let hold=true;
  const c=e.controller({applyProjection:async(projection,options)=>{if(hold){hold=false;started.resolve();await release.promise;}return projectionWriter(f)(projection,options);}});
  const work=c.controller.project();await started.promise;const base=(await c.replica.snapshot()).records[D.keyOf('drawing-1','record-1')];
  const after=C.applyLocalEdit(base,{...base,type:'新しい種別'},{actor,at:50,idFactory:()=> 'received-type'});
  await c.replica.change({drawingId:'drawing-1',before:base,after,eventId:'received-event'});release.resolve();
  const result=await work;assert.equal(result.applied,false);assert.equal(f.capture().drawings[0].state.shapes[0].type,'腐食');
  assert.equal((await c.controller.project()).applied,true);assert.equal(f.capture().drawings[0].state.shapes[0].type,'新しい種別');c.close();
});
await test('actual app runtime resumes a staged journal against the latest inspected server revision',async()=>{
  const f=await app(),e=await bind(f,{metadata:true,staging:true,serverRevision:7});edit(f,'切替中も保存した入力');await f.records.settled();
  const r=runtimeFixture(f,e,{staging:true});const result=await r.runtime.sync(r.cp);
  assert.equal(result.enabled,true);assert.equal(r.installedRevision,12);assert.equal(f.records.deltaJournal.bindingFor(localProjectId).phase,'active');
  assert.equal(f.records.deltaJournal.bindingFor(localProjectId).cutoff.serverRevision,7);assert(e.read().records[D.keyOf('drawing-1','record-1')].memo.includes('切替中も保存した入力'));r.runtime.close();
});
await test('actual app runtime auth switch during asynchronous projection retains old-owner data',async()=>{
  const f=await app(),e=await bind(f,{metadata:true});edit(f,'ログイン切替前の入力');await f.records.settled();const started=waitPoint(),release=waitPoint();let hold=true;
  const r=runtimeFixture(f,e,{beforeProjection:async()=>{if(hold){hold=false;started.resolve();await release.promise;}}});
  const work=r.runtime.sync(r.cp);await started.promise;r.switchAuth();release.resolve();await assert.rejects(()=>work,e=>['JOURNAL_CLOSED','JOURNAL_SCOPE','DELTA_APP_SCOPE'].includes(e.code));
  assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-1')).shapes[0].memo,'ログイン切替前の入力');assert.equal(f.records.deltaJournal.bindingFor(localProjectId).scope.ownerId,scope.ownerId);r.runtime.close();
});
await test('photo snapshot cancellation retries after the actual guarded file transaction rolls back',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),tokens=[],key='photo:drawing-1:retry',blob=new Blob(['retry-photo']);let attempts=0;
  const r=runtimeFixture(f,e,{factories:{assetStore:()=>({close(){}}),assetTransport:()=>({close(){}}),assets:options=>({close(){},async sync(state){
    attempts++;tokens.push(state.snapshotToken);assert.equal(options.currentSnapshotToken(),state.snapshotToken);
    let checks=0;
    await options.localFiles.withLock(key,()=>options.localFiles.write(key,blob,{onlyIfMissing:true,validate:()=>{
      if(attempts===1&&++checks===6)edit(f,'写真の処理中の追記');
      if(options.currentSnapshotToken()!==state.snapshotToken)throw Object.assign(Error('snapshot changed'),{code:'ASSET_SNAPSHOT_CHANGED'});
      return true;
    }}));
    assert(state.snapshot.records[D.keyOf('drawing-1','record-1')].memo.includes('写真の処理中の追記'));
    return {complete:true,pending:0,issues:[]};
  }})}});
  try{
    assert.equal((await r.runtime.photos(r.cp)).complete,true);assert.equal(attempts,2);assert.notEqual(tokens[0],tokens[1]);
    await f.records.settled();assert.equal(f.records.failed,false);assert.equal(f.records.writerState(key).failed,false);assert.equal(f.records.writerState(key).pending,0);
    assert.equal(await (await f.disk()).get(key).text(),'retry-photo');
    assert(e.read().records[D.keyOf('drawing-1','record-1')].memo.includes('写真の処理中の追記'));assert.equal(e.read().outbox.length,1);
    const fileRows=[...(await f.disk(LOG)).values()].filter(row=>row.files?.some(file=>file.key===key));assert.equal(fileRows.length,1);
  }finally{r.runtime.close();}
});
await test('photo snapshot recovery stops after three cancellations and keeps the final durable intent',async()=>{
  const f=await app(),e=await bind(f,{metadata:true});let attempts=0,lastError;
  const r=runtimeFixture(f,e,{factories:{assetStore:()=>({close(){}}),assetTransport:()=>({close(){}}),assets:options=>({close(){},async sync(state){
    attempts++;assert.equal(options.currentSnapshotToken(),state.snapshotToken);
    if(attempts<=3){edit(f,'写真取消中の追記 '+attempts);await f.records.settled();lastError=Object.assign(Error('snapshot changed '+attempts),{code:'ASSET_SNAPSHOT_CHANGED'});throw lastError;}
    return {complete:true,pending:0,issues:[]};
  }})}});
  try{
    await assert.rejects(()=>r.runtime.photos(r.cp),error=>error===lastError);assert.equal(attempts,3);
    assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-1')).shapes[0].memo,'写真取消中の追記 3');
    assert((await f.records.deltaJournal.pending({scope,localProjectId})).count>0);
    assert.equal((await r.runtime.photos(r.cp)).complete,true);assert.equal(attempts,4);
    assert(e.read().records[D.keyOf('drawing-1','record-1')].memo.includes('写真取消中の追記 3'));
    assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  }finally{r.runtime.close();}
});
await test('photo recovery never retries authentication or storage errors and fences an expired scope',async()=>{
  for(const mode of ['ASSET_AUTH_CHANGED','ASSET_QUOTA','scope-after-cancellation']){
    const f=await app(),e=await bind(f,{metadata:true});let attempts=0,original;
    const r=runtimeFixture(f,e,{factories:{assetStore:()=>({close(){}}),assetTransport:()=>({close(){}}),assets:()=>({close(){},async sync(){
      attempts++;edit(f,'失敗時も残す入力');await f.records.settled();
      if(mode!=='ASSET_QUOTA')r.switchAuth();
      original=Object.assign(Error(mode),{code:mode==='scope-after-cancellation'?'ASSET_SNAPSHOT_CHANGED':mode});throw original;
    }})}});
    try{
      await assert.rejects(()=>r.runtime.photos(r.cp),error=>mode==='scope-after-cancellation'?error.code==='DELTA_APP_SCOPE':error===original);
      assert.equal(attempts,1);assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing-1')).shapes[0].memo,'失敗時も残す入力');
      assert((await f.records.deltaJournal.pending({scope,localProjectId})).count>0);assert.equal(f.records.deltaJournal.bindingFor(localProjectId).scope.ownerId,scope.ownerId);
    }finally{r.runtime.close();}
  }
});
await test('missing active replica cannot turn the existing canvas into an empty projection',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),before=f.records.getItem(DRAW+'drawing-1'),r=runtimeFixture(f,e,{missing:true});
  await assert.rejects(()=>r.runtime.sync(r.cp),e=>e.code==='DELTA_APP_LOCAL_STATE');assert.equal(f.records.getItem(DRAW+'drawing-1'),before);r.runtime.close();
});
await test('detached runtime skips photos, publishes server checkpoint and attests absence for restoration',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),original=snapshot();
  await f.records.archiveAtomic({writes:[[WS,json({projects:[]})],[DRAW+'drawing-1',null]],deleteFiles:[],expectedWorkspace:f.records.getItem(WS),operation:'archive-local',
    context:{localArchive:true,mode:'project',projectId:localProjectId,jobId:'verified'}});
  const r=runtimeFixture(f,e);assert.equal((await r.runtime.photos(r.cp)).complete,true);const certificate=await r.runtime.checkpoint(r.cp);assert.equal(certificate.headSeq,0);
  const proof=await r.runtime.archiveProof(r.cp,{revision:12,delta_checkpoint:certificate,payload:original,manifest:[]});assert.equal(proof.absent,true);assert.equal(await proof.validate(),true);
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);assert.equal(JSON.parse(f.records.getItem(WS)).projects.length,0);r.runtime.close();
});
await test('actual installer protects one cutoff while ordinary edits continue into the durable WAL',async()=>{
  const f=await app(),i=await installerFixture(f,{onRead:async()=>{edit(f,'移行処理中の追記');await f.records.settled();}});
  const result=await i.installer()(i.args());assert.equal(result.installed,true);assert.equal(i.activated,1);const state=await i.store.read();
  assert.equal(state.records[D.keyOf('drawing-1','record-1')].memo,'初期所見');assert((await f.records.deltaJournal.pending({scope,localProjectId})).count>0);
  const transport={online:()=>false,push:async()=>{},pushGroup:async()=>{},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
  const replica=D.createReplica({...scope,store:i.store,transport}),controller=J.createController({records:f.records,scope,localProjectId,replica,replicaStore:i.store,currentScope:()=>scope});
  await controller.drain();assert((await i.store.read()).records[D.keyOf('drawing-1','record-1')].memo.includes('移行処理中の追記'));
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);controller.close();replica.close();i.store.close();
});
await test('actual installer resumes a committed replica after crash before binding activation',async()=>{
  const f=await app(),i=await installerFixture(f),activate=f.records.deltaJournal.activate;
  f.records.deltaJournal.activate=async()=>{throw Error('crash before activate');};
  await assert.rejects(()=>i.installer()(i.args()),/crash before activate/);assert(await i.store.readProvenance());assert.equal(f.records.deltaJournal.bindingFor(localProjectId).phase,'staging');
  f.records.deltaJournal.activate=activate;const reopened=await app({factory:f.factory,local:f.local});edit(reopened,'再開前の追記');await reopened.records.settled();
  const resumed=await i.installer(reopened.records)(i.args());assert.equal(resumed.resumed,true);assert.equal(i.activated,1);assert.equal(reopened.records.deltaJournal.bindingFor(localProjectId).phase,'active');
  assert((await reopened.records.deltaJournal.pending({scope,localProjectId})).count>0);i.store.close();
});
await test('acknowledged typing WAL is compacted while durable history survives restart',async()=>{
  const f=await app(),e=await bind(f,{metadata:true});
  for(let n=1;n<=120;n++){edit(f,'入力 '+n);await f.records.settled();}
  assert.equal((await f.disk(LOG)).size,120);const c=e.controller();await c.controller.drain();const saved=e.read();
  assert.equal((await f.disk(LOG)).size,0);assert(saved.records[D.keyOf('drawing-1','record-1')].memo.includes('入力 120'));c.close();
  const reopened=await app({factory:f.factory,local:f.local});f.records=reopened.records;f.capture=reopened.capture;const next=e.controller();await next.controller.drain();
  assert.deepEqual(e.read(),saved);assert.equal((await f.disk(LOG)).size,0);next.close();
});
await test('compaction retains exact file preimages but removes acknowledged raw record copies',async()=>{
  const f=await app(),e=await bind(f,{metadata:true});await f.records.writeFile('photo:drawing-1:p',new Blob(['first']));await f.records.writeFile('photo:drawing-1:p',new Blob(['second']));
  edit(f,'ファイルと入力');await f.records.settled();const c=e.controller();await c.controller.drain();const rows=[...(await f.disk(LOG)).values()];
  assert.equal(rows.length,2);assert(rows.every(row=>row.kind==='sentlog-file-retention'&&!row.changes&&!row.workspaceBefore&&!row.workspaceAfter));
  assert.equal(await rows[1].files[0].before.text(),'first');assert.equal(await rows[1].files[0].after.text(),'second');assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  await f.records.deltaJournal.compact();assert.equal((await f.disk(LOG)).size,2);c.close();
});
await test('file replay claims pin original WAL bytes without copying native Blobs into control rows',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),key='photo:drawing-1:camera';
  await f.records.writeFile(key,new Blob(['original-camera-bytes']));edit(f,'写真付きの記録');await f.records.settled();
  const put=IDBObjectStore.prototype.put,containsBlob=value=>value instanceof Blob||value&&typeof value==='object'&&Object.values(value).some(containsBlob);
  let copiedBlobs=0;
  IDBObjectStore.prototype.put=function(value,...rest){
    if(this.name===CONTROL&&value?.kind==='claim'&&containsBlob(value)){
      copiedBlobs++;throw Object.assign(Error('Error preparing Blob/File data to be stored in object store'),{name:'UnknownError'});
    }
    return put.call(this,value,...rest);
  };
  try{
    const claim=await f.records.deltaJournal.claim({scope,localProjectId}),rows=[...(await f.disk(LOG)).values()];
    assert.equal(copiedBlobs,0);assert.equal(containsBlob(claim),false);assert.equal(claim.fileReferences.length,1);
    const reference=claim.fileReferences[0],row=rows.find(item=>item.id===reference.rowId);
    assert.equal(reference.seq,row.seq);assert.equal(reference.key,key);assert(claim.rowIds.includes(row.id));
    assert.equal(await row.files[reference.index].after.text(),'original-camera-bytes');
    const reopened=await app({factory:f.factory,local:f.local});f.records=reopened.records;f.capture=reopened.capture;
    const resumed=await f.records.deltaJournal.claim({scope,localProjectId});assert.equal(resumed.id,claim.id);assert.deepEqual(resumed.fileReferences,claim.fileReferences);
    const c=e.controller();try{await c.controller.drain();assert(e.read().records[D.keyOf('drawing-1','record-1')].memo.includes('写真付きの記録'));}
    finally{c.close();}
    assert.equal(await (await f.disk()).get(key).text(),'original-camera-bytes');assert.equal(copiedBlobs,0);
  }finally{IDBObjectStore.prototype.put=put;}
});
await test('native Blob compaction failure preserves WAL and does not block verified photo work',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),key='photo:drawing-1:camera';await f.records.writeFile(key,new Blob(['durable-camera-bytes']));
  const before=[...(await f.disk(LOG)).values()],update=IDBCursor.prototype.update;
  const blobError=Object.assign(Error('Error preparing Blob/File data to be stored in object store'),{name:'UnknownError'});
  let aborted=0,photoCalls=0;
  IDBCursor.prototype.update=function(value){
    const result=update.call(this,value);
    if(value?.kind==='sentlog-file-retention'){
      const tx=this.source.transaction;
      result.addEventListener('success',()=>{aborted++;tx.sentlogJournalError=blobError;tx.abort();});
    }
    return result;
  };
  const c=e.controller(),r=runtimeFixture(f,e,{factories:{assetStore:()=>({close(){}}),assetTransport:()=>({close(){}}),
    assets:()=>({close(){},async sync(){photoCalls++;return {complete:true,pending:0,issues:[]};}})}});
  try{
    await c.controller.drain();assert.equal(c.controller.status().retentionError.code,'UnknownError');assert(aborted>=2);
    assert.deepEqual([...(await f.disk(LOG)).values()],before);assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
    assert.equal(f.records.failed,false);assert.equal((await r.runtime.photos(r.cp)).complete,true);assert.equal(photoCalls,1);
    assert.equal(await (await f.disk()).get(key).text(),'durable-camera-bytes');assert.equal(await (await f.disk(LOG)).values().next().value.files[0].after.text(),'durable-camera-bytes');
  }finally{IDBCursor.prototype.update=update;c.close();r.runtime.close();}
  await f.records.deltaJournal.compact();assert.equal((await f.disk(LOG)).values().next().value.kind,'sentlog-file-retention');
});
await test('project cutoff does not duplicate unrelated project or unassigned photo blobs',async()=>{
  const f=await app(),workspace=JSON.parse(f.records.getItem(WS)),other={id:'other-local',name:'別案件',drawings:[{id:'other-drawing',name:'別図面'}]};
  workspace.projects.push(other);f.records.batch([[WS,json(workspace)],[DRAW+'other-drawing',json({shapes:[],collabDeletedRecords:[]})]]);await f.records.settled();
  for(const key of ['background:drawing-1','photo:drawing-1:p','background:other-drawing','photo:other-drawing:p','photo:unassigned:p'])await f.records.writeFile(key,new Blob([key]));
  const first=await f.records.deltaJournal.begin({scope,localProjectId,actor}),second=await f.records.deltaJournal.begin({scope:{...scope,projectId:'other-cloud'},localProjectId:other.id,actor});
  assert.deepEqual(first.files.map(x=>x.key).sort(),['background:drawing-1','photo:drawing-1:p']);
  assert.deepEqual(second.files.map(x=>x.key).sort(),['background:other-drawing','photo:other-drawing:p']);
  assert(!first.rawEntries.some(([key])=>key===DRAW+'other-drawing'));assert(!second.rawEntries.some(([key])=>key===DRAW+'drawing-1'));
  assert.equal((await f.disk()).get('photo:unassigned:p').size,'photo:unassigned:p'.length);
});
await test('shared workspace row remains until every affected project has durable replay proof',async()=>{
  const f=await app(),otherId='other-local',otherScope={...scope,projectId:'other-cloud'},workspace=JSON.parse(f.records.getItem(WS));
  workspace.projects.push({id:otherId,name:'別案件',drawings:[{id:'other-drawing',name:'別図面'}]});
  f.records.batch([[WS,json(workspace)],[DRAW+'other-drawing',json({shapes:[],collabDeletedRecords:[]})]]);await f.records.settled();
  const e=await bind(f,{metadata:true}),otherCutoff=await f.records.deltaJournal.begin({scope:otherScope,localProjectId:otherId,actor});
  let otherState={version:2,scope:otherScope,cursor:0,outbox:[],records:await M.seed(otherCutoff.snapshot)};
  const otherStore={read:async()=>copy(otherState),write:async value=>{otherState=copy(value);}};
  await f.records.deltaJournal.activate({scope:otherScope,localProjectId:otherId,baselineId:'other-baseline',baselineSnapshot:otherCutoff.snapshot,metadataRecords:M.metadataRecords(otherState.records)});
  const next=JSON.parse(f.records.getItem(WS));next.projects[0].name='変更した主案件';next.projects[1].name='変更した別案件';f.records.setItem(WS,json(next));await f.records.settled();
  const c=e.controller();await c.controller.drain();assert.equal([...(await f.disk(LOG)).values()].filter(x=>x.kind==='sentlog-app-intent').length,1);
  const transport={online:()=>false,push:async()=>{},pushGroup:async()=>{},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
  const replica=D.createReplica({...otherScope,store:otherStore,transport}),controller=J.createController({records:f.records,scope:otherScope,localProjectId:otherId,replica,replicaStore:otherStore,currentScope:()=>otherScope});
  await controller.drain();assert.equal((await f.disk(LOG)).size,0);assert.equal(JSON.parse(f.records.getItem(WS)).projects[1].name,'変更した別案件');controller.close();replica.close();c.close();
});
await test('unassigned drawing survives unrelated ACK and cannot be overwritten by a received membership',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),orphan=json({shapes:[C.upgrade({id:'orphan-record',memo:'先に保存した入力',photos:[]})],collabDeletedRecords:[]});
  f.records.setItem(DRAW+'orphan-drawing',orphan);await f.records.settled();edit(f,'別の通常入力');await f.records.settled();const c=e.controller();await c.controller.drain();
  assert.equal([...(await f.disk(LOG)).values()].filter(x=>x.kind==='sentlog-app-intent').length,1);
  const ws=JSON.parse(f.records.getItem(WS));ws.projects[0].drawings.push({id:'orphan-drawing',name:'新図面'});
  const projection=await f.records.deltaJournal.applyProjection({scope,localProjectId,writes:[[WS,json(ws)],[DRAW+'orphan-drawing',json({shapes:[],collabDeletedRecords:[]})]],
    expectedRecords:[[WS,f.records.getItem(WS)],[DRAW+'orphan-drawing',orphan]],validate:()=>true});
  assert.equal(projection.applied,false);assert.equal(f.records.getItem(DRAW+'orphan-drawing'),orphan);
  f.records.setItem(WS,json(ws));await f.records.settled();await c.controller.drain();
  assert.equal(e.read().records[D.keyOf('orphan-drawing','orphan-record')].memo,'先に保存した入力');assert.equal((await f.disk(LOG)).size,0);c.close();
});
await test('archived project checkpoint inspection preserves its existing server certificate',async()=>{
  const f=await app(),e=await bind(f,{metadata:true}),r=runtimeFixture(f,e);r.cp.status='archived';
  assert.equal(await r.runtime.checkpoint(r.cp,{force:true}),null);assert.equal(r.published.length,0);
  const synced=await r.runtime.sync(r.cp);assert.equal(synced.enabled,true);assert.equal(synced.revision,9);
  assert.equal(r.published.length,0);r.runtime.close();
});
console.log(passed+' durable application journal scenarios passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js'),B=require('../sentlog/delta-sync-app-bridge.js');
const J=require('../sentlog/delta-sync-app-journal.js'),M=require('../sentlog/delta-sync-metadata.js'),GC=require('../sentlog/delta-sync-capacity-gc.js');
const Migration=require('../sentlog/delta-sync-migration.js'),Assets=require('../sentlog/delta-sync-assets.js');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',LOCAL='sentlogArchiveLocalV1';
const LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1',scope={ownerId:'owner',projectId:'project',deviceId:'device'},localId='local-project';
const copy=structuredClone,hash=async blob=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
function source(){
 let text=fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8');
 const builder=fs.readFileSync(path.join(__dirname,'../scripts/build_capacity.py'),'utf8'),injected=/storage_code=r'''([\s\S]*?)'''/.exec(builder)[1];
 text=text.replace('const managed=k=>k===WS ||',"const managed=k=>k==='sentlogArchiveLocalV1' || k===WS ||");
 return text.replace('  async function stats(){',injected+'\n  async function stats(){').replace('batch,replaceAll,stats,','batch,replaceAll,archiveAtomic,stats,');
}
async function fixture(){
 const photo=new Blob(['newer'],{type:'image/png'}),old=new Blob(['older'],{type:'image/png'}),pdf=new Blob(['pdf'],{type:'application/pdf'});
 const record=C.upgrade({id:'record',memo:'preserved history',photos:[{id:'p',name:'photo.png',size:5,type:'image/png'}]});
 const meta={id:'drawing',name:'Drawing'},payload={project:{id:localId,name:'Project',collaborationVersion:1,drawings:[meta]},drawings:[{meta,state:{shapes:[record],collabDeletedRecords:[]}}]};
 const memory=new Map([[WS,JSON.stringify({projects:[payload.project]})],[DRAW+'drawing',JSON.stringify(payload.drawings[0].state)]]),factory=new IDBFactory();
 const localStorage={get length(){return memory.size;},key:i=>[...memory.keys()][i]??null,getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)};
 const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,crypto:webcrypto,SentlogDeltaSyncCore:D};context.window=context;
 vm.createContext(context);vm.runInContext(source(),context);const records=context.SentlogRecords;await records.init();
 await records.writeFile('background:drawing',pdf);await records.writeFile('photo:drawing:p',old);
 await records.writeFile('original:camera-photo',new Blob(['camera-original']));
 const cutoff=await records.deltaJournal.begin({scope,localProjectId:localId,actor:{deviceId:scope.deviceId,deviceName:'Phone'},serverRevision:1});
 let durable={version:2,scope:copy(scope),cursor:0,records:{[D.keyOf('drawing','record')]:record,...await M.seed(payload)},outbox:[]};
 const store={read:async()=>copy(durable),write:async value=>{durable=copy(value);}};
 await records.deltaJournal.activate({scope,localProjectId:localId,baselineId:'baseline',metadataRecords:M.metadataRecords(durable.records),baselineSnapshot:payload,proof:{verified:true}});
 const transport={online:()=>false,push:async()=>{throw Error('offline');},pushGroup:async()=>{throw Error('offline');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
 const replica=D.createReplica({...scope,store,transport}),bridge=B.createBridge({replica,scope,localProjectId:localId,currentScope:()=>scope});
 const controller=J.createController({records,scope,localProjectId:localId,replica,replicaStore:store,bridge,metadata:M,currentScope:()=>scope});
 await records.writeFile('background:drawing',pdf);await records.writeFile('photo:drawing:p',photo);await controller.drain();
 assert.equal((await records.deltaJournal.pending({scope,localProjectId:localId})).count,0);assert.equal(durable.outbox.length,0);
 const certificate={schema:1,projectId:scope.projectId,headSeq:0,revision:2,payloadSha256:'a'.repeat(64)};
 const manifest=await Promise.all([['background:drawing','drawing','background-asset',pdf],['photo:drawing:p','photo','photo-asset',photo]].map(async([key,kind,id,blob])=>({key,kind,id,sha256:await hash(blob),byte_size:blob.size,mime_type:blob.type})));
 const info={operation:{id:'operation',owner_id:scope.ownerId,project_id:scope.projectId,device_id:scope.deviceId,job_id:'job',action:'verify',mode:'project',state:'ready',pc_device_id:'pc',pc_ready_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString()},
  job:{id:'job',project_id:scope.projectId,revision:2,payload,manifest,catalog_hash:'b'.repeat(64),delta_checkpoint:certificate,pc_receipt:{catalog_hash:'b'.repeat(64),package_sha256:'c'.repeat(64),file_count:manifest.length}},files:copy(manifest)};
 const files=manifest.map(f=>({key:f.key,kind:f.kind,assetId:f.id,size:f.byte_size,sha256:f.sha256,mimeType:f.mime_type}));
 let generation=1;const expectedGeneration=generation;
 const validateScope=()=>{assert.equal(generation,expectedGeneration,'auth generation changed');return true;};
 const proof={delta:true,validate:async()=>true,validateSync:()=>true};
 async function disk(name='files'){
  const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(name,'readonly'),s=tx.objectStore(name);let keys,values;
   s.getAllKeys().onsuccess=e=>keys=e.target.result;s.getAll().onsuccess=e=>values=e.target.result;tx.oncomplete=()=>resolve(new Map(keys.map((key,i)=>[key,values[i]])));tx.onabort=()=>reject(tx.error);});}finally{db.close();}
 }
 const calls=[];let applied=false;
 const emptyStore=name=>()=>({releaseArchivedCopies:async args=>{args.validate();assert((await disk()).has('background:drawing'),'ordinary bytes must remain until all copy passes finish');calls.push(name);return {releasedCopies:0,releasedBytes:0};},close(){calls.push(name+'-close');}});
 async function apply(ticket){
  calls.push('apply');const projectMode=info.operation.mode==='project',raw=records.getItem(WS),ws=JSON.parse(raw);
  const writes=[[LOCAL,JSON.stringify({[scope.projectId]:{mode:info.operation.mode,job_id:'job',revision:2}})]];
  if(projectMode){writes.push([WS,JSON.stringify({...ws,projects:ws.projects.filter(p=>p.id!==localId)})],[DRAW+'drawing',null]);}
  await records.archiveAtomic({writes,deleteFiles:files.map(f=>({key:f.key,size:f.size})),expectedWorkspace:raw,
   expectedFileStates:await records.readFileStates(files.map(f=>f.key)),validate:validateScope,operation:'archive-local',
   context:{localArchive:true,mode:info.operation.mode,projectId:localId,jobId:'job',deltaCheckpoint:certificate},retentionRelease:ticket});applied=true;
 }
 const options={records,cloudProject:{id:scope.projectId,client_key:localId,status:'archived'},info,proof,getScope:()=>scope,validateScope,apply,
  factories:{migrationStore:emptyStore('migration'),assetStore:emptyStore('assets')}};
 async function restore(){
  await records.writeFile('background:drawing',pdf);await records.writeFile('photo:drawing:p',photo);
  const raw=records.getItem(WS),ws=JSON.parse(raw);if(!ws.projects.some(p=>p.id===localId))ws.projects.push(copy(payload.project));
  await records.archiveAtomic({writes:[[WS,JSON.stringify(ws)],[DRAW+'drawing',JSON.stringify(payload.drawings[0].state)],[LOCAL,'{}']],
   deleteFiles:[],expectedWorkspace:raw,operation:'restore',validate:validateScope});
  await controller.drain();return copy(durable);
 }
 return {records,factory,info,files,certificate,options,cutoff,disk,apply,calls,get applied(){return applied;},changeAuth(){generation++;},
  restore,
  prepare:()=>records.deltaJournal.prepareArchivedRelease({scope,localProjectId:localId,certificate,jobId:'job',operationId:'operation',mode:info.operation.mode,files,validate:validateScope}),
  close(){controller.close();bridge.close();replica.close();}};
}
function blobBytes(value){if(value instanceof Blob)return value.size;if(!value||typeof value!=='object')return 0;return Object.values(value).reduce((n,x)=>n+blobBytes(x),0);}
async function protectedCopies(f){
 const live=await f.disk(),files=[];
 for(const [kind,key]of [['background','background:drawing'],['photo','photo:drawing:p'],['original-photo','original:camera-photo']]){
  const blob=live.get(key);files.push({kind,key,drawingId:'drawing',...(kind==='background'?{}:{photoId:'p'}),blob,size:blob.size,sha256:await hash(blob)});
 }
 const snapshot={version:1,kind:'sentlog-legacy-source',projectId:localId,rawEntries:copy(f.cutoff.rawEntries),files,
  issues:[],fingerprint:'d'.repeat(64),readyForStaging:true};
 const source={capture:async()=>copy(snapshot),recheck:async()=>({unchanged:true,expectedFingerprint:snapshot.fingerprint,actualFingerprint:snapshot.fingerprint})};
 const migration=Migration.createStore({...scope,indexedDB:f.factory});
 const coordinator=Migration.createCoordinator({source,store:migration,localProjectId:localId,currentScope:()=>scope});
 await coordinator.stage('capacity-gc-integration');coordinator.close();
 const assets=Assets.createIndexedDBStore({...scope,indexedDB:f.factory}),file=f.files.find(x=>x.kind==='photo');
 const reference={ownerId:scope.ownerId,projectId:scope.projectId,assetId:file.assetId,drawingId:'drawing',photoId:'p',variant:'shared',sha256:file.sha256,size:file.size,mimeType:file.mimeType};
 const original={...reference,assetId:'original-asset',variant:'original'};
 for(const ref of [reference,original]){await assets.ensure(ref);await assets.received(ref,live.get(file.key));await assets.acknowledged(ref,{...copy(ref),deviceId:scope.deviceId,durable:true});}
 assets.close();
 f.options.factories={migrationStore:value=>Migration.createStore({...value,indexedDB:f.factory}),assetStore:value=>Assets.createIndexedDBStore({...value,indexedDB:f.factory})};
 return {reference,original};
}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
 await test('certified cleanup frees matching cutoff/WAL bytes and never recreates deletion preimages',async()=>{
  const f=await fixture();try{
   const before=[...(await f.disk(CONTROL)).values(),...(await f.disk(LOG)).values()].reduce((n,x)=>n+blobBytes(x),0);
   const result=await GC.release(f.options);assert.equal(f.applied,true);assert.deepEqual(f.calls.slice(0,3),['migration','assets','apply']);
   assert.equal(result.releasedCopies,4);assert.equal(result.releasedBytes,14);assert.equal(result.avoidedPreimageCopies,2);
   const stored=await f.disk(),bindings=await f.disk(CONTROL),rows=[...(await f.disk(LOG)).values()];
   assert.equal(stored.has('background:drawing'),false);assert.equal(stored.has('photo:drawing:p'),false);
   assert.equal(await stored.get('original:camera-photo').text(),'camera-original');
   const binding=bindings.get('binding:'+localId);assert.equal(binding.phase,'detached');
   assert.equal(binding.cutoff.files.find(x=>x.key==='background:drawing').value,null);
   assert.equal(await binding.cutoff.files.find(x=>x.key==='photo:drawing:p').value.text(),'older');
   assert(binding.cutoff.snapshot.drawings[0].state.shapes[0].collab);assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count,0);
   const last=rows.find(row=>row.kind==='sentlog-app-intent'&&row.mutationKind==='archive');assert(last.files.every(x=>x.before===null&&x.releasedBefore.certificate.payloadSha256==='a'.repeat(64)));
   const after=[...bindings.values(),...rows].reduce((n,x)=>n+blobBytes(x),0);assert.equal(before-after,14);
  }finally{f.close();}
 });
 await test('one certified cleanup releases actual migration, photo-store and WAL copies together',async()=>{
  const f=await fixture();let migration,assets;try{
   const refs=await protectedCopies(f),result=await GC.release(f.options);
   assert.equal(result.releasedCopies,7);assert.equal(result.releasedBytes,27);assert.equal(result.avoidedPreimageCopies,2);
   migration=Migration.createStore({...scope,indexedDB:f.factory});assets=Assets.createIndexedDBStore({...scope,indexedDB:f.factory});
   assert.equal((await migration.status('capacity-gc-integration')).status,'archived-copy');
   const items=await migration.readItems('capacity-gc-integration',0,4);assert.equal(items[1].value,null);assert.equal(items[2].value,null);
   assert.equal(await items[3].value.text(),'camera-original');assert.equal((await assets.read(refs.reference)).phase,'archived');
   assert.equal((await assets.read(refs.reference)).blob,null);assert((await assets.read(refs.original)).blob instanceof Blob);
   assert.equal((await f.disk()).has('photo:drawing:p'),false);assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'detached');
  }finally{migration?.close();assets?.close();f.close();}
 });
 await test('file-only cleanup keeps records active while freeing the same redundant copies',async()=>{
  const f=await fixture();try{f.info.operation.mode='files';await GC.release(f.options);assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'active');
   assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing')).shapes[0].memo,'preserved history');assert.equal((await f.disk()).has('photo:drawing:p'),false);
  }finally{f.close();}
 });
 await test('explicit whole-project restoration replays with released cutoff bytes and preserves histories',async()=>{
  const f=await fixture();try{await GC.release(f.options);const restored=await f.restore();
   assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'active');
   assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count,0);
   assert.equal(restored.records[D.keyOf('drawing','record')].memo,'preserved history');
   const original=f.info.job.payload.drawings[0].state.shapes[0],current=restored.records[D.keyOf('drawing','record')];
   const merged=C.mergeRecords(original,current);assert(merged.ok);assert(C.equal(merged.record.collab,current.collab));
   assert.equal(C.view(current).deleted,false);
   assert.equal(await (await f.disk()).get('photo:drawing:p').text(),'newer');
   assert.equal(f.records.deltaJournal.bindingFor(localId).cutoff.files.find(x=>x.key==='background:drawing').value,null);
  }finally{f.close();}
 });
 await test('foreign device, expired PC verification and omitted catalog entries stop before any copy mutation',async()=>{
  for(const mutate of [f=>f.info.operation.device_id='foreign',f=>f.info.operation.expires_at=new Date(0).toISOString(),f=>f.info.files.pop(),f=>f.info.files[0].sha256='d'.repeat(64)]){
   const f=await fixture();try{mutate(f);await assert.rejects(()=>GC.release(f.options),e=>['CAPACITY_GC_PROOF','CAPACITY_GC_CATALOG'].includes(e.code));assert.deepEqual(f.calls,[]);assert((await f.disk()).has('background:drawing'));}finally{f.close();}
  }
 });
 await test('opaque retention tickets cannot be forged or rebound to another archive',async()=>{
  const f=await fixture();try{await assert.rejects(()=>f.apply({}),{code:'JOURNAL_ARCHIVE_RELEASE'});assert((await f.disk()).has('background:drawing'));
   const ticket=await f.prepare();f.certificate.payloadSha256='d'.repeat(64);await assert.rejects(()=>f.apply(ticket),{code:'JOURNAL_ARCHIVE_RELEASE'});assert((await f.disk()).has('background:drawing'));
  }finally{f.close();}
 });
 await test('same-size file rewrite after hashing invalidates the final transaction by durable generation',async()=>{
  const f=await fixture();try{const ticket=await f.prepare();await f.records.writeFile('photo:drawing:p',new Blob(['later'],{type:'image/png'}));
   await assert.rejects(()=>f.apply(ticket),{code:'JOURNAL_ARCHIVE_CHANGED'});assert.equal(await (await f.disk()).get('photo:drawing:p').text(),'later');
   assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'active');
  }finally{f.close();}
 });
 await test('file-only verification cannot authorize detaching a complete project',async()=>{
  const f=await fixture();try{f.info.operation.mode='files';const ticket=await f.prepare();f.info.operation.mode='project';
   await assert.rejects(()=>f.apply(ticket),{code:'JOURNAL_ARCHIVE_RELEASE'});assert((await f.disk()).has('background:drawing'));
   assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'active');
  }finally{f.close();}
 });
 await test('pending WAL and claims prevent preparation even when a caller supplies an old proof',async()=>{
  const f=await fixture();try{await f.records.writeFile('background:drawing',new Blob(['new'],{type:'application/pdf'}));
   await f.records.deltaJournal.claim({scope,localProjectId:localId});await assert.rejects(()=>f.prepare(),{code:'JOURNAL_PENDING'});
   assert((await f.disk()).has('background:drawing'));
  }finally{f.close();}
 });
 await test('auth generation changes between stores stop before ordinary files or record-retention commit',async()=>{
  const f=await fixture();try{f.options.factories.migrationStore=()=>({releaseArchivedCopies:async args=>{args.validate();f.changeAuth();return {releasedCopies:1,releasedBytes:3};},close(){}});
   await assert.rejects(()=>GC.release(f.options),/auth generation changed/);assert.equal(f.applied,false);assert((await f.disk()).has('background:drawing'));
   assert(f.records.deltaJournal.bindingFor(localId).cutoff.files.find(x=>x.key==='background:drawing').value instanceof Blob);
  }finally{f.close();}
 });
 await test('interruption after redundant-copy release leaves visible bytes and supports a fresh idempotent retry',async()=>{
  const f=await fixture();try{let migrationReleased=false;
   f.options.factories.migrationStore=()=>({releaseArchivedCopies:async args=>{args.validate();const first=!migrationReleased;migrationReleased=true;return {releasedCopies:first?1:0,releasedBytes:first?3:0};},close(){}});
   f.options.factories.assetStore=()=>({releaseArchivedCopies:async()=>{throw Error('interrupted');},close(){}});
   await assert.rejects(()=>GC.release(f.options),/interrupted/);assert(migrationReleased);assert.equal(f.applied,false);assert((await f.disk()).has('background:drawing'));
   f.options.factories.assetStore=()=>({releaseArchivedCopies:async args=>{args.validate();return {releasedCopies:0,releasedBytes:0};},close(){}});
   const result=await GC.release(f.options);assert.equal(result.releasedBytes,14);assert.equal(f.applied,true);
  }finally{f.close();}
 });
 await test('legacy capacity delegates its existing atomic operation without opening delta stores',async()=>{
  let called=false;const result=await GC.release({info:{job:{}},apply:async ticket=>{assert.equal(ticket,null);called=true;return 'legacy';}});
  assert(called);assert.equal(result.value,'legacy');assert.equal(result.releasedBytes,0);
 });
 await test('a later copy-store open failure closes earlier stores and preserves ordinary files',async()=>{
  const f=await fixture();try{f.options.factories.assetStore=()=>{throw Error('asset store unavailable');};
   await assert.rejects(()=>GC.release(f.options),/asset store unavailable/);assert.deepEqual(f.calls,['migration','migration-close']);
   assert.equal(f.applied,false);assert((await f.disk()).has('background:drawing'));
  }finally{f.close();}
 });
 console.log('PASS capacity retained-copy GC: '+count+' scenarios');
})().catch(error=>{console.error(error);process.exitCode=1;});

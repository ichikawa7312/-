'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js'),B=require('../sentlog/delta-sync-app-bridge.js');
const J=require('../sentlog/delta-sync-app-journal.js'),M=require('../sentlog/delta-sync-metadata.js'),GC=require('../sentlog/delta-sync-capacity-gc.js');
const Migration=require('../sentlog/delta-sync-migration.js'),Assets=require('../sentlog/delta-sync-assets.js');
const Runtime=require('../sentlog/delta-sync-app-runtime.js'),Capacity=require('../sentlog/delta-sync-capacity.js');
const Transport=require('../sentlog/delta-sync-transport.js');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',LOCAL='sentlogArchiveLocalV1';
const LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1',scope={ownerId:'11111111-1111-4111-8111-111111111111',projectId:'55555555-5555-4555-8555-555555555555',deviceId:'33333333-3333-4333-8333-333333333333'},localId='local-project';
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
 const store={read:async()=>copy(durable),write:async value=>{durable=copy(value);},
  readProvenance:async()=>({baseline:{baselineId:records.deltaJournal.bindingFor(localId)?.baselineId}}),close(){}};
 await records.deltaJournal.activate({scope,localProjectId:localId,baselineId:'baseline',metadataRecords:M.metadataRecords(durable.records),baselineSnapshot:payload,proof:{verified:true}});
 let connectedTransport=null;
 const transport={online:()=>connectedTransport?.online()??false,push:async(...args)=>{if(connectedTransport)return connectedTransport.push(...args);throw Error('offline');},
  pushGroup:async(...args)=>{if(connectedTransport)return connectedTransport.pushGroup(...args);throw Error('offline');},list:async(...args)=>connectedTransport?connectedTransport.list(...args):[],
  getCapabilities:()=>connectedTransport?.getCapabilities()||({atomicGroups:true})};
 const replica=D.createReplica({...scope,store,transport}),bridge=B.createBridge({replica,scope,localProjectId:localId,currentScope:()=>scope});
 const controller=J.createController({records,scope,localProjectId:localId,replica,replicaStore:store,bridge,metadata:M,currentScope:()=>scope});
 await records.writeFile('background:drawing',pdf);await records.writeFile('photo:drawing:p',photo);await controller.drain();
 assert.equal((await records.deltaJournal.pending({scope,localProjectId:localId})).count,0);assert.equal(durable.outbox.length,0);
 let certificate={schema:1,projectId:scope.projectId,headSeq:0,revision:2,payloadSha256:'a'.repeat(64)};
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
  const writes=[[LOCAL,JSON.stringify({[scope.projectId]:{mode:info.operation.mode,job_id:info.job.id,revision:info.job.revision}})]];
  if(projectMode){writes.push([WS,JSON.stringify({...ws,projects:ws.projects.filter(p=>p.id!==localId)})],[DRAW+'drawing',null]);}
  await records.archiveAtomic({writes,deleteFiles:files.map(f=>({key:f.key,size:f.size})),expectedWorkspace:raw,
   expectedFileStates:await records.readFileStates(files.map(f=>f.key)),validate:validateScope,operation:'archive-local',
   context:{localArchive:true,mode:info.operation.mode,projectId:localId,jobId:info.job.id,deltaCheckpoint:certificate},retentionRelease:ticket});applied=true;
 }
 const options={records,cloudProject:{id:scope.projectId,client_key:localId,status:'archived'},info,proof,getScope:()=>scope,validateScope,apply,
  factories:{migrationStore:emptyStore('migration'),assetStore:emptyStore('assets')}};
 async function restore({proofFactory}={}){
  const restoreInfo=info.operation.action==='restore'?copy(info):{...copy(info),operation:{...copy(info.operation),id:'restore-operation',action:'restore',mode:'project'}};
  const fileOptions=Capacity.restoreFileOptions({cloudProject:options.cloudProject,info:restoreInfo,getScope:()=>scope,validateScope});
  await records.writeFile('background:drawing',pdf,fileOptions);await records.writeFile('photo:drawing:p',photo,fileOptions);
  const restoreProof=proofFactory?await proofFactory(restoreInfo):null;
  const restoredPayload=info.job.payload,raw=records.getItem(WS),ws=JSON.parse(raw);if(!ws.projects.some(p=>p.id===localId))ws.projects.push(copy(restoredPayload.project));
  if(restoreProof)await restoreProof.validate();
  await records.archiveAtomic({writes:[[WS,JSON.stringify(ws)],[DRAW+'drawing',JSON.stringify(restoredPayload.drawings[0].state)],[LOCAL,'{}']],
   deleteFiles:[],expectedWorkspace:raw,operation:'restore',expectedRecords:restoreProof?.expectedRecords,
   expectedFileStates:restoreProof?.expectedFileStates,restorationProof:restoreProof?.restorationProof,
   validate:()=>validateScope()&&(restoreProof?.validateSync()??true)});
  await controller.drain();return copy(durable);
 }
 return {records,factory,info,files,get certificate(){return certificate;},options,cutoff,disk,apply,calls,get applied(){return applied;},changeAuth(){generation++;},
  restore,
  configureArchive(value){Object.assign(info,copy(value));certificate=copy(info.job.delta_checkpoint);},
  connectTransport(value){connectedTransport=value;},snapshot:()=>copy(durable),sync:async()=>{await controller.drain();return replica.sync();},
  controller,replica,store,
  connectedRuntime(value){connectedTransport=value;return Runtime.createRuntime({records,url:'https://example.invalid',key:'key',
   session:()=>({user:{id:scope.ownerId}}),ensureSession:async()=>{},authGeneration:()=>1,subscribeAuth:()=>()=>{},deviceId:()=>scope.deviceId,
   install:async()=>{throw Error('The existing replica must remain installed after cache restoration');},applyProjection:async()=>{throw Error('The existing controller owns projection');},
   readFile:async key=>(await disk()).get(key),withFileLock:async(_key,fn)=>fn(),actor:()=>({deviceId:scope.deviceId,deviceName:'Phone'}),
   factories:{provider:()=>({}),transport:()=>value,store:()=>store,replica:()=>replica,bridge:()=>bridge,controller:()=>controller}});},
  prepare:()=>records.deltaJournal.prepareArchivedRelease({scope,localProjectId:localId,certificate,jobId:info.job.id,operationId:info.operation.id,mode:info.operation.mode,files,validate:validateScope}),
  close(){controller.close();bridge.close();replica.close();}};
}
function blobBytes(value){if(value instanceof Blob)return value.size;if(!value||typeof value!=='object')return 0;return Object.values(value).reduce((n,x)=>n+blobBytes(x),0);}
function absentRuntime(f){
 return Runtime.createRuntime({records:f.records,url:'https://example.invalid',key:'key',session:()=>({user:{id:scope.ownerId}}),
  ensureSession:async()=>{},authGeneration:()=>1,subscribeAuth:()=>()=>{},deviceId:()=>scope.deviceId,
  install:async()=>{throw Error('An absent restore proof must not reinstall the project');},applyProjection:async()=>{throw Error('An absent restore proof must not project records');},
  readFile:async key=>(await f.disk()).get(key),withFileLock:async(_key,fn)=>fn(),actor:()=>({deviceId:scope.deviceId,deviceName:'Phone'}),
  factories:{provider:()=>({}),transport:()=>({close(){}}),store:()=>({close(){}})}});
}
function restoreInfo(f){return f.info.operation.action==='restore'?copy(f.info):{...copy(f.info),operation:{...copy(f.info.operation),id:'restore-operation',action:'restore',mode:'project'}};}
function projectRestoreProof(f,runtime,info=restoreInfo(f)){
 return Capacity.createProof({records:f.records,cloudProject:f.options.cloudProject,info,archiveProof:runtime.archiveProof,
  getScope:()=>scope,validateScope:f.options.validateScope,mode:'restore-project'});
}
async function emptyRecords(){
 const memory=new Map([[WS,'{"projects":[]}']]);
 const localStorage={get length(){return memory.size;},key:i=>[...memory.keys()][i]??null,getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)};
 const context={window:null,indexedDB:new IDBFactory(),IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,crypto:webcrypto,SentlogDeltaSyncCore:D};context.window=context;
 vm.createContext(context);vm.runInContext(source(),context);await context.SentlogRecords.init();return context.SentlogRecords;
}
async function stagedRestore(f){
 const info=restoreInfo(f),options=Capacity.restoreFileOptions({cloudProject:f.options.cloudProject,info,getScope:()=>scope,validateScope:f.options.validateScope});
 await f.records.writeFile('background:drawing',new Blob(['pdf'],{type:'application/pdf'}),options);
 await f.records.writeFile('photo:drawing:p',new Blob(['newer'],{type:'image/png'}),options);
 const runtime=absentRuntime(f);
 try{const proof=await projectRestoreProof(f,runtime,info),ws=JSON.parse(proof.raw);
  const writes=[[WS,JSON.stringify({...ws,projects:[...ws.projects,f.info.job.payload.project]})],
   [DRAW+'drawing',JSON.stringify(f.info.job.payload.drawings[0].state)],[LOCAL,'{}']];
  return {runtime,proof,writes};
 }catch(error){runtime.close();throw error;}
}
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
async function archivedBackend(f){
 const {createBackend,statusOf}=require('./delta_app_backend.cjs'),backend=await createBackend();
 const pc='77777777-7777-4777-8777-777777777777',args={p_project_id:scope.projectId,p_device_id:scope.deviceId};
 const rpc=(name,body)=>backend.request({ownerId:scope.ownerId,method:'POST',path:'/rest/v1/rpc/'+name,body});
 const archive=(action,data={},device=scope.deviceId)=>rpc('sentlog_archive_v1',{...args,p_device_id:device,p_action:action,p_data:data});
 const capacity=(action,data={},device=scope.deviceId)=>rpc('sentlog_capacity_v1',{...args,p_device_id:device,p_action:action,p_data:data});
 try{
  await backend.seed({ownerId:scope.ownerId,devices:[{id:scope.deviceId,name:'Phone'},{id:pc,name:'Company PC',type:'pc'}],
   projects:[{id:scope.projectId,client_key:localId,payload:copy(f.info.job.payload)}],rollout:true});
  await backend.admin({action:'assets',ownerId:scope.ownerId,deviceId:scope.deviceId,assets:f.files.map(file=>({
   id:webcrypto.randomUUID(),project_id:scope.projectId,client_key:file.kind==='drawing'?'drawing:drawing':file.key,
   kind:file.kind,file_name:file.kind==='drawing'?'drawing.pdf':'photo.png',mime_type:file.mimeType,byte_size:file.size,sha256:file.sha256,status:'uploaded'}))});
  const baseline=await rpc('sentlog_delta_prepare_baseline_v1',{...args,p_expected_revision:1});
  await rpc('sentlog_delta_import_baseline_batch_v1',{...args,p_baseline_id:baseline.baselineId,p_limit:100});
  await rpc('sentlog_delta_activate_baseline_v1',{...args,p_baseline_id:baseline.baselineId,p_proof:{writerVersion:2,
   migrationId:'cache-restoration-integration',sourceFingerprint:'1'.repeat(64),planSha256:'2'.repeat(64)}});
  const certificate=await rpc('sentlog_delta_publish_checkpoint_v1',{...args,p_expected_head:0,p_request_id:'cache-archive-checkpoint'});
  const job=await archive('begin',{revision:certificate.revision});
  await archive('report',{job_id:job.id,catalog_hash:job.catalog_hash,clean:true,delta_proof:{schema:1,headSeq:0,cursor:0,pending:0,
   revision:certificate.revision,payloadSha256:certificate.payloadSha256}});
  await archive('pc_complete',{job_id:job.id,catalog_hash:job.catalog_hash,file_count:job.manifest.length,package_sha256:'c'.repeat(64),path:'synthetic/cache-backup'},pc);
  assert.equal((await archive('finalize',{job_id:job.id})).status,'archived');
  async function ready(action){
   const operation=await capacity('begin',{action,mode:'project'});
   await capacity('pc_ready',{operation_id:operation.id,catalog_hash:job.catalog_hash,package_sha256:'c'.repeat(64),file_count:job.manifest.length},pc);
   return capacity('inspect',{operation_id:operation.id});
  }
  const requests=[],session={access_token:'synthetic-session',user:{id:scope.ownerId}};
  const provider=Transport.createRestProvider({url:'https://synthetic.invalid',key:'synthetic-public-key',session:()=>session,subscribeAuth:()=>()=>{},Socket:null,
   fetch:async(url,options)=>{
    const pathname=new URL(url).pathname;if(pathname==='/auth/v1/user')return new Response(JSON.stringify({id:scope.ownerId}),{status:200});
    requests.push(pathname);
    try{return new Response(JSON.stringify(await backend.request({ownerId:scope.ownerId,method:options.method,path:pathname,body:options.body})),{status:200});}
    catch(error){return new Response(JSON.stringify({code:error.code,message:error.message}),{status:statusOf(error)});}
   }});
  const transport=Transport.createTransport({provider,scope,currentScope:()=>scope,online:()=>true});
  return {backend,transport,requests,ready,rpc,capacity,args,job,certificate,close:async()=>{transport.close();await backend.close();}};
 }catch(error){await backend.close();throw error;}
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
   const rawBinding=bindings.get('binding:'+localId),binding=f.records.deltaJournal.bindingFor(localId);assert.equal(binding.phase,'detached');
   assert.equal(blobBytes(rawBinding),0);assert(rawBinding.cutoff.files.every(file=>typeof file.valueRef==='string'));
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
   assert(restored.outbox.length>0,'an ordinary backup restore remains a new shared intent');
   assert.equal(await (await f.disk()).get('photo:drawing:p').text(),'newer');
   assert.equal(f.records.deltaJournal.bindingFor(localId).cutoff.files.find(x=>x.key==='background:drawing').value,null);
  }finally{f.close();}
 });
 await test('whole-project PC restore passes the actual absent runtime proof after its verified file writes',async()=>{
  const f=await fixture();let runtime;try{
   await GC.release(f.options);runtime=absentRuntime(f);
   assert.equal((await runtime.archiveProof(f.options.cloudProject,f.info.job)).absent,true);
   const restored=await f.restore({proofFactory:info=>projectRestoreProof(f,runtime,info)});
   assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'active');
   assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count,0);
   assert.equal(restored.records[D.keyOf('drawing','record')].memo,'preserved history');
   assert.equal(restored.outbox.length,0,'restoring a certified local cache must not manufacture a new shared edit');
   assert.equal(await (await f.disk()).get('photo:drawing:p').text(),'newer');
   assert.equal(f.records.getItem(LOCAL),'{}');
  }finally{runtime?.close();f.close();}
 });
 await test('certified cache restoration keeps the actual archived backend readable without creating a forbidden append',async()=>{
  const f=await fixture();let server,proofRuntime,runtime;try{
   server=await archivedBackend(f);f.configureArchive(await server.ready('verify'));
   const before=f.snapshot();assert.equal(before.outbox.length,0);
   await GC.release(f.options);await server.capacity('finish',{operation_id:f.info.operation.id});
   f.configureArchive(await server.ready('restore'));proofRuntime=absentRuntime(f);
   const restored=await f.restore({proofFactory:info=>projectRestoreProof(f,proofRuntime,info)});
   assert.equal(restored.outbox.length,0);assert.equal(restored.blockedOutbox?.length||0,0);
   assert(C.equal(restored.records,before.records),'cache restoration must preserve every existing record and metadata revision');
   await server.capacity('finish',{operation_id:f.info.operation.id});
   const original=f.info.job.payload.drawings[0].state.shapes[0];
   const edited=C.appendComment(original,'blocked while archived',{actor:{deviceId:scope.deviceId,deviceName:'Phone'},at:5,revisionId:'blocked-comment',commentId:'blocked-comment'});
   const event=D.diffRecord(original,edited,{eventId:'blocked-cache-edit',projectId:scope.projectId,deviceId:scope.deviceId,drawingId:'drawing'});
   await assert.rejects(()=>server.rpc('sentlog_delta_append_v1',{...server.args,p_event_id:event.eventId,p_drawing_id:'drawing',p_record_id:original.id,p_envelope:event}),
    error=>error.code==='42501'&&/DELTA_PROJECT_FORBIDDEN/.test(error.message));
   await server.transport.ready();runtime=f.connectedRuntime(server.transport);
   const result=await runtime.sync(f.options.cloudProject);
   assert.equal(result.enabled,true);assert.equal(result.pending,0);assert.equal(result.deferred,false);
   assert.equal(server.requests.filter(path=>path.includes('sentlog_delta_append')).length,0);
   assert(server.requests.some(path=>path.includes('sentlog_delta_list_groups')));
   const state=await server.backend.state({ownerId:scope.ownerId,projectId:scope.projectId});
   assert.equal(state.projects[0].status,'archived');assert.equal(state.counts.events,0);assert.equal(Number(state.heads[0].last_seq),0);
  }finally{runtime?.close();proofRuntime?.close();f.close();await server?.close();}
 });
 await test('an interrupted certified file restore can resume under a new PC operation at the same archive',async()=>{
  const f=await fixture();let runtime;try{
   await GC.release(f.options);const first=restoreInfo(f);
   const options=Capacity.restoreFileOptions({cloudProject:f.options.cloudProject,info:first,getScope:()=>scope,validateScope:f.options.validateScope});
   await f.records.writeFile('background:drawing',new Blob(['pdf'],{type:'application/pdf'}),options);
   assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count,1);
   f.info.operation={...first.operation,id:'resumed-pc-operation'};runtime=absentRuntime(f);
   const restored=await f.restore({proofFactory:info=>projectRestoreProof(f,runtime,info)});
   assert.equal(restored.outbox.length,0);assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count,0);
   assert.equal(await (await f.disk()).get('background:drawing').text(),'pdf');
   assert.equal(await (await f.disk()).get('photo:drawing:p').text(),'newer');
  }finally{runtime?.close();f.close();}
 });
 await test('an editor change after the certified cache boundary creates only its own ordinary history',async()=>{
  const f=await fixture();let staged;try{
   const originalMetadata=M.metadataRecords(f.snapshot().records);await GC.release(f.options);staged=await stagedRestore(f);
   await f.records.archiveAtomic({writes:staged.writes,deleteFiles:[],expectedWorkspace:staged.proof.raw,
    restorationProof:staged.proof.restorationProof,validate:f.options.validateScope,operation:'restore'});
   const state=JSON.parse(f.records.getItem(DRAW+'drawing'));state.shapes[0].memo='edited after the cache returned';
   f.records.setItem(DRAW+'drawing',JSON.stringify(state));await f.records.settled();await f.controller.drain();
   const restored=f.snapshot(),events=restored.outbox.flatMap(entry=>entry.events||[entry]);
   assert.equal(events.length,1);assert.equal(events[0].recordId,'record');assert.equal(events[0].drawingId,'drawing');
   assert.equal(restored.records[D.keyOf('drawing','record')].memo,'preserved history\n\nedited after the cache returned');
   assert(C.equal(M.metadataRecords(restored.records),originalMetadata));
   assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count,0);
  }finally{staged?.runtime.close();f.close();}
 });
 await test('different record or metadata histories and a dirty replica retain the certified cache WAL without ACK',async()=>{
  for(const variant of ['record','metadata','outbox']){const f=await fixture();let staged,replica,bridge,controller;try{
   await GC.release(f.options);staged=await stagedRestore(f);
   await f.records.archiveAtomic({writes:staged.writes,deleteFiles:[],expectedWorkspace:staged.proof.raw,
    restorationProof:staged.proof.restorationProof,validate:f.options.validateScope,operation:'restore'});
   let durable=f.snapshot();const actor={deviceId:scope.deviceId,deviceName:'Phone'};
   if(variant==='metadata'){
    const before=copy(f.info.job.payload),after=copy(before);after.project.name='another accepted metadata history';
    const changed=await M.edit({before,after,currentRecords:durable.records,beforeRecords:M.metadataRecords(durable.records),
     actor,at:10,operationId:'different-metadata'});
    for(const change of changed.changes)durable.records[D.keyOf(change.drawingId,change.after.id)]=copy(change.after);
   }else{
    const key=D.keyOf('drawing','record'),before=durable.records[key];
    const after=C.appendComment(before,'another accepted record history',{actor,at:10,revisionId:'different-record',commentId:'different-record'});
    durable.records[key]=after;
    if(variant==='outbox')durable.outbox=[D.diffRecord(before,after,{drawingId:'drawing',eventId:'pending-record-edit',projectId:scope.projectId,deviceId:scope.deviceId})];
   }
   const captured=copy(durable),acked=f.records.deltaJournal.bindingFor(localId).ackedSeq;
   const store={read:async()=>copy(durable),write:async value=>{durable=copy(value);}};
   const transport={online:()=>false,push:async()=>{throw Error('offline');},pushGroup:async()=>{throw Error('offline');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
   replica=D.createReplica({...scope,store,transport});bridge=B.createBridge({replica,scope,localProjectId:localId,currentScope:()=>scope});
   controller=J.createController({records:f.records,scope,localProjectId:localId,replica,replicaStore:store,bridge,metadata:M,currentScope:()=>scope});
   await assert.rejects(()=>controller.drain(),{code:'JOURNAL_RESTORE_PENDING'});
   assert(C.equal(durable,captured));assert.equal(f.records.deltaJournal.bindingFor(localId).ackedSeq,acked);
   const pending=await f.records.deltaJournal.pending({scope,localProjectId:localId});assert(pending.count>0);assert(pending.claimId);
   assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing')).shapes[0].memo,'preserved history');
  }finally{controller?.close();bridge?.close();replica?.close();staged?.runtime.close();f.close();}}
 });
 await test('the absent restore proof refuses ordinary file edits, unrelated orphan files and drawing changes',async()=>{
  const mutations=[
   f=>f.records.writeFile('background:drawing',new Blob(['pdf'],{type:'application/pdf'})),
   f=>f.records.writeFile('photo:orphan:extra',new Blob(['extra'],{type:'image/png'}),
    Capacity.restoreFileOptions({cloudProject:f.options.cloudProject,info:restoreInfo(f),getScope:()=>scope,validateScope:f.options.validateScope})),
   async f=>{f.records.setItem(DRAW+'orphan',JSON.stringify({shapes:[]}));await f.records.settled();}
  ];
  for(const mutate of mutations){const f=await fixture();let runtime;try{
   await GC.release(f.options);runtime=absentRuntime(f);
   const options=Capacity.restoreFileOptions({cloudProject:f.options.cloudProject,info:restoreInfo(f),getScope:()=>scope,validateScope:f.options.validateScope});
   await f.records.writeFile('background:drawing',new Blob(['pdf'],{type:'application/pdf'}),options);
   await f.records.writeFile('photo:drawing:p',new Blob(['newer'],{type:'image/png'}),options);
   await mutate(f);
   await assert.rejects(()=>projectRestoreProof(f,runtime),error=>/RESTORE|PENDING/.test(error.code||''));
   assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'detached');
   assert.equal(f.records.getItem(DRAW+'drawing'),null);assert.notEqual(f.records.getItem(LOCAL),'{}');
   assert((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count>0);
  }finally{runtime?.close();f.close();}}
 });
 await test('restored file options retain their original auth-generation lease across an A-to-B-to-A return',async()=>{
  const f=await fixture();try{
   await GC.release(f.options);
   const options=Capacity.restoreFileOptions({cloudProject:f.options.cloudProject,info:restoreInfo(f),getScope:()=>scope,validateScope:f.options.validateScope});
   f.changeAuth();
   await assert.rejects(()=>f.records.writeFile('background:drawing',new Blob(['pdf'],{type:'application/pdf'}),options),/auth generation changed/);
   assert.equal((await f.disk()).has('background:drawing'),false);
   assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count,0);
  }finally{f.close();}
 });
 await test('a fresh device without a prior binding can still restore the certified archived project',async()=>{
  const f=await fixture();let runtime;try{
   const records=await emptyRecords(),fresh={...f,records,options:{...f.options,records}},info=restoreInfo(f);
   const options=Capacity.restoreFileOptions({cloudProject:f.options.cloudProject,info,getScope:()=>scope,validateScope:f.options.validateScope});
   await records.writeFile('background:drawing',new Blob(['pdf'],{type:'application/pdf'}),options);
   await records.writeFile('photo:drawing:p',new Blob(['newer'],{type:'image/png'}),options);
   runtime=absentRuntime(fresh);const proof=await projectRestoreProof(fresh,runtime,info);await proof.validate();
   await records.archiveAtomic({writes:[[WS,JSON.stringify({projects:[f.info.job.payload.project]})],[DRAW+'drawing',JSON.stringify(f.info.job.payload.drawings[0].state)]],
    deleteFiles:[],expectedWorkspace:proof.raw,expectedRecords:proof.expectedRecords,expectedFileStates:proof.expectedFileStates,
    restorationProof:proof.restorationProof,validate:proof.validateSync,operation:'restore'});
   assert.equal(JSON.parse(records.getItem(DRAW+'drawing')).shapes[0].memo,'preserved history');
   assert.equal(records.deltaJournal.bindingFor(localId),null);
   assert.equal(records.getItem(LOCAL),null);
  }finally{runtime?.close();f.close();}
 });
 await test('the final restore transaction rejects forged tickets and a different drawing snapshot',async()=>{
  const f=await fixture();let staged;try{
   await GC.release(f.options);staged=await stagedRestore(f);
   const apply=(ticket,writes=staged.writes)=>f.records.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:staged.proof.raw,
    restorationProof:ticket,validate:f.options.validateScope,operation:'restore'});
   await assert.rejects(()=>apply({}),{code:'JOURNAL_RESTORE_PROOF'});
   const altered=copy(staged.writes),state=JSON.parse(altered[1][1]);state.shapes[0].memo='not the archived record';altered[1][1]=JSON.stringify(state);
   await assert.rejects(()=>apply(staged.proof.restorationProof,altered),{code:'JOURNAL_RESTORE_PROOF'});
   assert.equal(f.records.getItem(DRAW+'drawing'),null);assert.notEqual(f.records.getItem(LOCAL),'{}');
   assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'detached');
   await apply(staged.proof.restorationProof);
   assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'active');
   assert((await f.records.deltaJournal.pending({scope,localProjectId:localId})).count>0,'restoration must not ACK its intents before replica replay');
  }finally{staged?.runtime.close();f.close();}
 });
 await test('a file rewrite after restoration proof aborts the final private-ticket transaction',async()=>{
  const f=await fixture();let staged;try{
   await GC.release(f.options);staged=await stagedRestore(f);
   await f.records.writeFile('photo:drawing:p',new Blob(['later'],{type:'image/png'}));
   await assert.rejects(()=>f.records.archiveAtomic({writes:staged.writes,deleteFiles:[],expectedWorkspace:staged.proof.raw,
    restorationProof:staged.proof.restorationProof,validate:f.options.validateScope,operation:'restore'}),{code:'JOURNAL_RESTORE_CHANGED'});
   assert.equal(f.records.getItem(DRAW+'drawing'),null);assert.notEqual(f.records.getItem(LOCAL),'{}');
   assert.equal(f.records.deltaJournal.bindingFor(localId).phase,'detached');
   assert.equal(await (await f.disk()).get('photo:drawing:p').text(),'later');
  }finally{staged?.runtime.close();f.close();}
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

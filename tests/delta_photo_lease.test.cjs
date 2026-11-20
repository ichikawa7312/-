'use strict';
// Real app coordinator, asset runtime/transport, guarded record writer and
// IndexedDB photo queue. Only the authenticated server responses are synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const Runtime=require('../sentlog/delta-sync-app-runtime.js'),D=require('../sentlog/delta-sync-core.js');
const C=require('../sentlog/record-collaboration.js'),M=require('../sentlog/delta-sync-metadata.js');
const A=require('../sentlog/delta-sync-assets.js'),AT=require('../sentlog/delta-sync-asset-transport.js'),AR=require('../sentlog/delta-sync-asset-runtime.js');
const root=path.resolve(__dirname,'..'),copy=structuredClone,WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:drawing';
const scope={ownerId:'11000000-0000-4000-8000-000000000001',projectId:'22000000-0000-4000-8000-000000000001',deviceId:'33000000-0000-4000-8000-000000000001'};
const cp={id:scope.projectId,client_key:'lease-project',name:'Photo lease fixture',status:'active'};
const fileKey='photo:drawing:photo',assetId='44000000-0000-4000-8000-000000000001';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function within(promise,label){let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{
 timer=setTimeout(()=>reject(Error('Deadline: '+label)),5000);})]);}finally{clearTimeout(timer);}}
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
let serial=0;
async function fixture({hold=null,onWrite=null}={}){
 const factory=new IDBFactory(),blob=new Blob([new Uint8Array([255,0,2,77,128,4,0])],{type:'image/jpeg'});
 const sha=[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const record=C.upgrade({id:'record',type:'corrosion',memo:'keep the photo',photos:[{id:'photo',name:'evidence.jpg',size:blob.size,type:blob.type,sha256:sha}]});
 const meta={id:'drawing',name:'Drawing'},project={id:cp.client_key,name:cp.name,collaborationVersion:1,drawings:[meta]};
 const local=new Map([[WS,JSON.stringify({projects:[project]})],[DRAW,JSON.stringify({shapes:[record],collabDeletedRecords:[],pageSettings:{1:{scale:100}}})]]);
 const context={window:null,indexedDB:factory,IDBKeyRange,Blob,AbortController,console,navigator:{},crypto:webcrypto,structuredClone,SentlogDeltaSyncCore:D,
  queueMicrotask,setTimeout,clearTimeout,localStorage:{get length(){return local.size;},key:i=>[...local.keys()][i],getItem:key=>local.get(key)??null,
   setItem:(key,value)=>local.set(key,String(value)),removeItem:key=>local.delete(key)}};
 context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'sentlog/record-store.js'),'utf8'),context);
 const records=context.SentlogRecords;await records.init();
 const cutoff=await records.deltaJournal.begin({scope,localProjectId:cp.client_key,actor:{deviceId:scope.deviceId,deviceName:'Lease phone'}});
 const seeded={[D.keyOf('drawing','record')]:record,...await M.seed(cutoff.snapshot)};
 let state={version:2,scope:copy(scope),cursor:0,records:seeded,outbox:[]};
 await records.deltaJournal.activate({scope,localProjectId:cp.client_key,baselineId:'baseline',baselineSnapshot:cutoff.snapshot,metadataRecords:M.metadataRecords(seeded)});
 const replicaStore={read:async()=>copy(state),write:async value=>{state=copy(value);},readProvenance:async()=>({baseline:{baselineId:'baseline'}}),close(){}};
 const transport={getScope:()=>copy(scope),online:()=>false,ready:async()=>true,close(){},wake(){},push:async()=>{throw Error('Unexpected record send');},
  pushGroup:async()=>{throw Error('Unexpected record send');},list:async()=>[],getCapabilities:()=>({atomicGroups:true,sharedMetadata:true,certifiedArchive:true,writerJournal:2}),
  inspect:async()=>({schema:1,...scope,enabled:true,canActivate:false,headSeq:0,snapshotRevision:1,checking:false,baseline:{baselineId:'baseline',snapshotRevision:1}})};
 const asset={id:assetId,owner_id:scope.ownerId,project_id:scope.projectId,kind:'photo',client_key:fileKey,file_name:'evidence.jpg',
  storage_path:scope.ownerId+'/'+scope.projectId+'/photos/evidence.jpg',mime_type:blob.type,byte_size:blob.size,sha256:sha,status:'uploaded',
  source_device_id:scope.deviceId,metadata:{drawing_id:'drawing',photo_id:'photo',local_project_key:cp.client_key}};
 const gate={started:deferred(),release:deferred(),returned:deferred(),signal:null},events=[],received=[],auth=new Set();
 const stats={downloads:0,ackRequests:0,receiptReads:0,writes:0,commits:0};let blocked=hold,user=scope.ownerId,generation=1,cleared=false,receipt=null;
 const previousCapacity=globalThis.SentlogCapacity,capacity={isCleared:id=>id===cp.id&&cleared};globalThis.SentlogCapacity=capacity;
 function event(kind,extra={}){events.push({kind,cleared,...extra});}
 async function pause(stage,options){
  if(blocked!==stage)return;blocked=null;gate.signal=options.signal;
  options.signal.addEventListener('abort',()=>event(stage+'-aborted'),{once:true});event(stage+'-pending');gate.started.resolve();
  // Deliberately ignore AbortSignal at this transport boundary. The real
  // transport must race cancellation and fence every late response itself.
  await gate.release.promise;event(stage+'-response');gate.returned.resolve();
 }
 async function fetcher(url,options={}){
  const parsed=new URL(url),pathname=parsed.pathname;event('request',{path:pathname});
  assert(!options.signal?.aborted,'a cancelled request must never be started');
  if(pathname==='/auth/v1/user')return response({id:scope.ownerId});
  if(pathname==='/rest/v1/sentlog_projects')return response([{id:cp.id,owner_id:scope.ownerId,status:'active',client_key:cp.client_key}]);
  if(pathname==='/rest/v1/sentlog_devices')return response([{id:scope.deviceId,owner_id:scope.ownerId,active:true,device_type:'iphone'}]);
  if(pathname==='/rest/v1/sentlog_assets')return response(parsed.searchParams.has('id')&&parsed.searchParams.get('id').startsWith('gt.')?[]:[asset]);
  if(pathname.startsWith('/storage/v1/object/authenticated/')){
   stats.downloads++;await pause('download',options);return new Response(blob,{headers:{'content-length':String(blob.size)}});
  }
  if(pathname==='/rest/v1/rpc/sentlog_ack_photo'){
   stats.ackRequests++;event('ack-request');const body=JSON.parse(options.body);
   assert.equal(body.p_sha256,sha);assert.equal(body.p_byte_size,blob.size);
   // A request already accepted by the server can have a lost/delayed response.
   // Cancellation must prevent promoting that response locally after cleanup.
   receipt={asset_id:assetId,owner_id:scope.ownerId,device_id:scope.deviceId,sha256:sha,byte_size:blob.size,received_at:'2026-11-20T00:00:00Z'};
   await pause('ack',options);return response({received:true});
  }
  if(pathname==='/rest/v1/sentlog_asset_device_receipts'){stats.receiptReads++;return response(receipt?[receipt]:[]);}
  throw Error('Unexpected photo request '+pathname);
 }
 const originalWrite=records.writeFile;records.writeFile=(key,value,options)=>{
  stats.writes++;event('file-write',{key});onWrite?.(key,value,options);
  return originalWrite(key,value,options).then(result=>{stats.commits++;event('file-commit',{key});return result;});
 };
 async function readFile(key){const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('files','readonly'),q=tx.objectStore('files').get(key);let value;q.onsuccess=()=>{value=q.result;};tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);
 });}finally{db.close();}}
 const locks=new Map();function withFileLock(key,fn){const work=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(fn);locks.set(key,work);
  return work.finally(()=>{if(locks.get(key)===work)locks.delete(key);});}
 const databaseName='sentlog-delta-assets-test-lease-'+(++serial),created=[];
 function closeTracked(value,kind){const close=value.close.bind(value);value.close=()=>{event(kind+'-close');close();};created.push(value);return value;}
 const runtime=Runtime.createRuntime({records,url:'https://lease.invalid',key:'public-fixture',session:()=>({access_token:'fixture-token',user:{id:user}}),ensureSession:async()=>{},
  authGeneration:()=>generation,subscribeAuth:fn=>{auth.add(fn);return()=>auth.delete(fn);},deviceId:()=>scope.deviceId,actor:()=>({deviceId:scope.deviceId,deviceName:'Lease phone'}),
  install:async()=>{throw Error('Already installed');},readFile,withFileLock,network:()=>true,visible:()=>true,fetch:fetcher,
  onPhotoReceived:detail=>{received.push(detail);event('photo-received');},
  applyProjection:async(project,projection,options)=>records.deltaJournal.applyProjection({...options,writes:[[WS,JSON.stringify({projects:[projection.project]})],
   ...projection.drawings.map(d=>['surveyFieldNoteDrawingV1:'+d.meta.id,JSON.stringify(d.state)])]}),
  factories:{provider:()=>({}),transport:()=>transport,store:()=>replicaStore,
   assetStore:args=>closeTracked(A.createIndexedDBStore({...args,indexedDB:factory,databaseName}),'store'),
   assetTransport:args=>closeTracked(AT.createTransport({...args,online:()=>true,timeoutMs:10000}),'transport'),
   assets:args=>closeTracked(AR.createRuntime(args),'assets')}});
 const ref=AT.referenceFromAsset(asset,scope);
 return {records,runtime,cp,blob,ref,gate,events,stats,received,factory,readFile,
  start(){const work=runtime.photos(cp);return {work,outcome:work.then(value=>({value}),error=>({error}))};},
  async row(){const store=A.createIndexedDBStore({...scope,indexedDB:factory,databaseName});try{return await store.read(ref);}finally{store.close();}},
  markCleared(){cleared=true;event('capacity-marker');},restoreMarker(){cleared=false;event('capacity-restore');},
  switchUser(next){user=next;generation++;for(const listener of [...auth])listener();},
  async close(){runtime.close();gate.release.resolve();await tick();for(const value of created)try{value.close();}catch{}
   if(globalThis.SentlogCapacity===capacity){if(previousCapacity===undefined)delete globalThis.SentlogCapacity;else globalThis.SentlogCapacity=previousCapacity;}}};
}
let passed=0;async function test(label,fn){await within(fn(),label);passed++;console.log('PASS '+label);}
(async()=>{
 await test('capacity lease cancels a pending download before resolving and fences its ignored-abort response',async()=>{
  const f=await fixture({hold:'download'});try{
   const work=f.start();await f.gate.started.promise;assert.equal(f.gate.signal.aborted,false);
   const release=await f.runtime.suspendPhotos(cp);f.events.push({kind:'lease-acquired'});
   assert.equal(release.validate(),true);assert(f.gate.signal.aborted);assert((await work.outcome).error);
   assert(f.events.findIndex(x=>x.kind==='download-aborted')<f.events.findIndex(x=>x.kind==='lease-acquired'));
   for(const kind of ['assets-close','transport-close','store-close'])assert(f.events.some(x=>x.kind===kind));
   f.markCleared();const requests=f.events.filter(x=>x.kind==='request').length;
   assert.equal((await f.runtime.photos(cp)).skipped,true);release();release();
   assert.throws(()=>release.validate(),e=>e.code==='DELTA_PHOTOS_LEASE');assert.equal((await f.runtime.photos(cp)).skipped,true);
   f.gate.release.resolve();await f.gate.returned.promise;await tick();await f.records.settled();
   assert.equal(await f.readFile(fileKey),undefined);assert.equal((await f.row()).phase,'waiting');
   assert.deepEqual([f.stats.writes,f.stats.ackRequests,f.received.length],[0,0,0]);
   assert.equal(f.events.filter(x=>x.kind==='request').length,requests);assert(!f.events.some(x=>x.cleared&&['file-write','ack-request'].includes(x.kind)));
   f.restoreMarker();assert.equal((await f.runtime.photos(cp)).complete,true);
   await A.verifyBlob(await f.readFile(fileKey),f.ref);assert.equal((await f.row()).phase,'acknowledged');
  }finally{await f.close();}
 });
 await test('a delayed ACK response cannot recreate a cleared mirror or promote the old local receipt',async()=>{
  const f=await fixture({hold:'ack'});try{
   const work=f.start();await f.gate.started.promise;await A.verifyBlob(await f.readFile(fileKey),f.ref);
   assert.equal((await f.row()).phase,'received');assert.equal(f.stats.ackRequests,1);
   const release=await f.runtime.suspendPhotos(cp);assert(release.validate());assert(f.gate.signal.aborted);assert((await work.outcome).error);
   f.markCleared();await f.records.removeFiles([fileKey]);const requests=f.events.filter(x=>x.kind==='request').length;
   f.gate.release.resolve();await f.gate.returned.promise;await tick();await f.records.settled();
   assert.equal(await f.readFile(fileKey),undefined);assert.equal((await f.row()).phase,'received');
   assert.equal(f.stats.ackRequests,1);assert.equal(f.stats.receiptReads,0);assert.equal(f.received.length,0);
   assert.equal(f.events.filter(x=>x.kind==='request').length,requests);assert(!f.events.some(x=>x.cleared&&['file-write','ack-request','photo-received'].includes(x.kind)));
   release();assert.equal((await f.runtime.photos(cp)).skipped,true);
   f.restoreMarker();assert.equal((await f.runtime.photos(cp)).complete,true);assert.equal(f.stats.downloads,1);
   await A.verifyBlob(await f.readFile(fileKey),f.ref);assert.equal((await f.row()).phase,'acknowledged');assert.equal(f.stats.ackRequests,2);
  }finally{await f.close();}
 });
 await test('nested pending-pipeline leases stay valid independently and a failed cleanup resumes photo delivery',async()=>{
  const f=await fixture({hold:'download'});try{
   const work=f.start();await f.gate.started.promise;
   const [first,second]=await Promise.all([f.runtime.suspendPhotos(cp),f.runtime.suspendPhotos(cp)]);
   assert(first.validate());assert(second.validate());assert((await work.outcome).error);
   first();first();assert.throws(()=>first.validate(),e=>e.code==='DELTA_PHOTOS_LEASE');assert(second.validate());
   const before={...f.stats};assert.equal((await f.runtime.photos(cp)).skipped,true);assert.deepEqual(f.stats,before);
   await assert.rejects(async()=>{try{assert(second.validate());throw Error('Synthetic cleanup failure');}finally{second();}},/Synthetic cleanup failure/);
   assert.equal((await f.runtime.photos(cp)).complete,true);const after={...f.stats};
   f.gate.release.resolve();await f.gate.returned.promise;await tick();assert.deepEqual(f.stats,after);
   await A.verifyBlob(await f.readFile(fileKey),f.ref);assert.equal(f.stats.commits,1);assert.equal(f.stats.ackRequests,1);
  }finally{await f.close();}
 });
 await test('suspending during an enqueued guarded mirror write aborts it before granting the cleanup lease',async()=>{
  const f=await fixture(),put=IDBObjectStore.prototype.put,started=deferred();let lease,intercepted=false;
  try{
   IDBObjectStore.prototype.put=function(value,key){const request=put.apply(this,arguments);
    if(!intercepted&&this.transaction.db.name==='surveyFieldNoteDB'&&this.name==='files'&&key===fileKey){
     intercepted=true;lease=f.runtime.suspendPhotos(cp);started.resolve();
    }return request;};
   const work=f.start();await started.promise;const release=await lease;assert(release.validate());assert((await work.outcome).error);
   assert.equal(f.records.writerState(fileKey).pending,0);assert.equal(await f.readFile(fileKey),undefined);assert.equal(f.stats.commits,0);
   assert.equal(f.stats.ackRequests,0);assert.equal((await f.row()).phase,'received');
   release();assert.equal((await f.runtime.photos(cp)).complete,true);await A.verifyBlob(await f.readFile(fileKey),f.ref);
  }finally{IDBObjectStore.prototype.put=put;await f.close();}
 });
 await test('an A-to-B-to-A auth switch invalidates an acquired lease and fences the old ignored-abort download',async()=>{
  const f=await fixture({hold:'download'});try{
   const work=f.start();await f.gate.started.promise;const release=await f.runtime.suspendPhotos(cp);assert(release.validate());
   f.switchUser('11000000-0000-4000-8000-000000000002');f.switchUser(scope.ownerId);
   assert.throws(()=>release.validate(),e=>e.code==='DELTA_APP_SCOPE');release();assert((await work.outcome).error);
   f.gate.release.resolve();await f.gate.returned.promise;await tick();
   assert.equal(await f.readFile(fileKey),undefined);assert.equal(f.stats.ackRequests,0);assert.equal(f.stats.writes,0);
   assert.equal((await f.runtime.photos(cp)).complete,true);await A.verifyBlob(await f.readFile(fileKey),f.ref);
  }finally{await f.close();}
 });
 await test('an auth switch during asynchronous photo cancellation refuses to grant a stale cleanup lease',async()=>{
  const f=await fixture({hold:'download'});try{
   const work=f.start();await f.gate.started.promise;
   f.gate.signal.addEventListener('abort',()=>{f.switchUser('11000000-0000-4000-8000-000000000002');f.switchUser(scope.ownerId);},{once:true});
   await assert.rejects(()=>f.runtime.suspendPhotos(cp),e=>e.code==='DELTA_APP_SCOPE');assert((await work.outcome).error);
   f.gate.release.resolve();await f.gate.returned.promise;await tick();
   assert.equal(await f.readFile(fileKey),undefined);assert.equal(f.stats.ackRequests,0);assert.equal(f.stats.writes,0);
   assert.equal((await f.runtime.photos(cp)).complete,true);await A.verifyBlob(await f.readFile(fileKey),f.ref);
  }finally{await f.close();}
 });
 console.log('PASS '+passed+' real pending photo-pipeline capacity lease regressions');
})().catch(error=>{console.error(error);process.exitCode=1;});

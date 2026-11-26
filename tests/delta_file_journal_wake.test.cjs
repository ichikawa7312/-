'use strict';
// Actual writer, replica, journal, app coordinator and edit scheduler. The asset
// batch is controlled here; native asset hash/ACK/lease tests remain separate.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const root=process.env.SENTLOG_FILE_WAKE_SOURCE_ROOT||path.resolve(__dirname,'..');
const C=require(path.join(root,'sentlog/record-collaboration.js')),D=require(path.join(root,'sentlog/delta-sync-core.js'));
const I=require(path.join(root,'sentlog/delta-sync-indexeddb.js')),M=require(path.join(root,'sentlog/delta-sync-metadata.js'));
const Runtime=require(path.join(root,'sentlog/delta-sync-app-runtime.js')),Edit=require(path.join(root,'sentlog/edit-sync.js'));
const copy=structuredClone,WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:drawing';
const scope={ownerId:'synthetic-owner',projectId:'synthetic-project',deviceId:'synthetic-device'};
const cp={id:scope.projectId,client_key:'synthetic-local',name:'Synthetic project',status:'active'};
const complete=()=>({complete:true,pending:0,issues:[]});
const gate=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check,label){for(let i=0;i<1000;i++){if(await check())return;await new Promise(r=>setTimeout(r,2));}throw Error(label);}
function clock(){
 let now=0,serial=0;const tasks=new Map();return {now:()=>now,setTimer:(fn,ms)=>{const id=++serial;tasks.set(id,{at:now+ms,fn});return id;},clearTimer:id=>tasks.delete(id),
  async tick(ms){const end=now+ms;let count=0;for(;;){const next=[...tasks].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
   assert(++count<100,'unbounded scheduler loop');now=next[1].at;tasks.delete(next[0]);next[1].fn();for(let i=0;i<20;i++)await Promise.resolve();}
   now=end;await flush();},get size(){return tasks.size;}};
}
async function fixture({plan=async io=>{await io.write('one');return complete();},onNotify=()=>{}}={}){
 const factory=new IDBFactory(),record=C.upgrade({id:'record',memo:'Synthetic record',photos:[]}),meta={id:'drawing',name:'Synthetic drawing'};
 const project={id:cp.client_key,name:cp.name,collaborationVersion:1,drawings:[meta]};
 const local=new Map([[WS,JSON.stringify({projects:[project]})],[DRAW,JSON.stringify({shapes:[record],collabDeletedRecords:[],pageSettings:{1:{scale:100}}})]]);
 const context={window:null,indexedDB:factory,IDBKeyRange,Blob,queueMicrotask,structuredClone,crypto:webcrypto,console,navigator:{},SentlogDeltaSyncCore:D,
  localStorage:{get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)}};
 context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'sentlog/record-store.js'),'utf8'),context);
 const records=context.SentlogRecords;await records.init();
 const cutoff=await records.deltaJournal.begin({scope,localProjectId:cp.client_key,actor:{deviceId:scope.deviceId,deviceName:'Synthetic phone'}});
 const seeded={[D.keyOf('drawing','record')]:record,...await M.seed(cutoff.snapshot)};
 await records.deltaJournal.activate({scope,localProjectId:cp.client_key,baselineId:'synthetic-baseline',baselineSnapshot:cutoff.snapshot,metadataRecords:M.metadataRecords(seeded)});
 const adapter=I.createStore({...scope,indexedDB:factory,databaseName:'sentlog-delta-test-file-journal-wake'});
 await adapter.read();await adapter.write({version:2,scope:copy(scope),cursor:0,records:seeded,outbox:[]});
 const store={...adapter,readProvenance:async()=>({baseline:{baselineId:'synthetic-baseline'}})};
 const transport={getScope:()=>copy(scope),online:()=>false,ready:async()=>true,close(){},wake(){},push:async()=>{throw Error('unexpected network');},
  pushGroup:async()=>{throw Error('unexpected network');},list:async()=>[],
  getCapabilities:()=>({atomicGroups:true,sharedMetadata:true,certifiedArchive:true,writerJournal:2}),
  inspect:async()=>({enabled:true,canActivate:false,headSeq:0,snapshotRevision:1,baseline:{baselineId:'synthetic-baseline',snapshotRevision:1}})};
 let user=scope.ownerId,generation=1,cleared=false,capacityFailure=null,assetCalls=0;const auth=new Set(),notifications=[],events=[],locks=new Map();
 const previousCapacity=globalThis.SentlogCapacity,capacity={isCleared:id=>{if(capacityFailure)throw capacityFailure;return id===cp.id&&cleared;}};globalThis.SentlogCapacity=capacity;
 async function readFile(key){const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('files','readonly');let value;tx.objectStore('files').get(key).onsuccess=e=>{value=e.target.result;};
  tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
 function withFileLock(key,fn){const task=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(fn);locks.set(key,task);
  return task.finally(()=>{if(locks.get(key)===task)locks.delete(key);});}
 const runtime=Runtime.createRuntime({records,url:'https://synthetic.invalid',key:'synthetic-key',session:()=>({user:{id:user}}),
  ensureSession:async()=>{},authGeneration:()=>generation,subscribeAuth:fn=>{auth.add(fn);return()=>auth.delete(fn);},deviceId:()=>scope.deviceId,
  actor:()=>({deviceId:scope.deviceId,deviceName:'Synthetic phone'}),install:async()=>{throw Error('already installed');},readFile,withFileLock,
  network:()=>true,visible:()=>true,onFileJournaled:detail=>{notifications.push(copy(detail));events.push('notify');return onNotify(detail);},
  applyProjection:async(_cp,projection,options)=>records.deltaJournal.applyProjection({...options,writes:[[WS,JSON.stringify({projects:[projection.project]})],
   ...projection.drawings.map(d=>['surveyFieldNoteDrawingV1:'+d.meta.id,JSON.stringify(d.state)])]}),
  factories:{provider:()=>({}),transport:()=>transport,store:()=>store,assetStore:()=>({close(){}}),assetTransport:()=>({close(){}}),assets:options=>{
   let closed=false;const check=()=>{if(closed)throw Object.assign(Error('synthetic asset closed'),{code:'ASSET_CLOSED'});
    if(!options.currentScope())throw Object.assign(Error('synthetic scope changed'),{code:'ASSET_AUTH_CHANGED'});return true;};
   const io={check,async write(id,bytes='Synthetic mirror '+id){check();const key='photo:drawing:'+id;
    const saved=await options.localFiles.withLock(key,()=>options.localFiles.write(key,new Blob([bytes]),{onlyIfMissing:true,validate:check}));
    events.push(saved.written?'written':'unchanged');check();return saved;},ack(){check();options.onPhotoReceived({reference:{drawingId:'drawing'}});}};
   return {close(){closed=true;},async sync(snapshot){assetCalls++;events.push('batch-start');try{return await plan(io,snapshot);}finally{events.push('batch-end');}}};
  }}});
 return {records,runtime,notifications,events,readFile,get assetCalls(){return assetCalls;},setPlan:value=>{plan=value;},
  pending:()=>records.deltaJournal.pending({scope,localProjectId:cp.client_key}),markCleared:value=>{cleared=value;},failCapacity:value=>{capacityFailure=value;},
  switchUser(value){user=value;generation++;for(const fn of [...auth])fn();},
  async close(){runtime.close();adapter.close();await flush();if(globalThis.SentlogCapacity===capacity){if(previousCapacity===undefined)delete globalThis.SentlogCapacity;else globalThis.SentlogCapacity=previousCapacity;}}};
}
const tests=[],test=(name,fn)=>tests.push([name,fn]);
test('a mirror-only WAL wakes the existing scheduler and drains without a quiet audit',async()=>{
 const time=clock(),runs=[];let fileRunning=true,edit;
 const f=await fixture({onNotify:({localProjectId})=>edit.request([localProjectId])});
 edit=Edit.createScheduler({...time,canRun:()=>!fileRunning,run:async ids=>{runs.push(ids);await f.runtime.sync(cp);return {started:true};}});
 const observed=[];const watcher=Edit.watchRecords(f.records,{onChange:ids=>observed.push(ids)});
 try{
  await f.runtime.photos(cp);assert.equal((await f.pending()).count,1);assert.equal(observed.length,0,'file bytes became a legacy record edit');
  assert.deepEqual(f.notifications,[{localProjectId:cp.client_key}]);
  await time.tick(800);assert.equal(runs.length,0,'metadata started while the outer file cycle was running');
  fileRunning=false;edit.wake();await time.tick(0);await until(()=>!edit.running,'scheduled journal drain did not complete');
  assert.equal(runs.length,1);assert.equal((await f.pending()).count,0);assert.equal(await (await f.readFile('photo:drawing:one')).text(),'Synthetic mirror one');
  await time.tick(15000);assert.equal(runs.length,1,'idle worker notified itself again');
 }finally{watcher.dispose();edit.dispose();await f.close();}
});
test('fifty durable mirrors produce one notification after the complete batch',async()=>{
 let f;f=await fixture({plan:async io=>{for(let n=0;n<50;n++){await io.write('many-'+n);assert.equal(f.notifications.length,0,'notification interrupted an active asset batch');}return complete();}});
 try{await f.runtime.photos(cp);assert.equal(f.notifications.length,1);assert.equal((await f.pending()).count,50);
  assert(f.events.lastIndexOf('batch-end')<f.events.lastIndexOf('notify'));assert.equal(f.assetCalls,1);
 }finally{await f.close();}
});
test('existing mirrors and repeated ACK callbacks do not create another dirty event',async()=>{
 const f=await fixture({plan:async io=>{await io.write('one');for(let i=0;i<20;i++)io.ack();return complete();}});
 try{await f.runtime.photos(cp);assert.equal(f.notifications.length,1);await f.runtime.photos(cp);
  assert.equal(f.notifications.length,1);assert.equal((await f.pending()).count,0);assert.equal(f.events.filter(x=>x==='unchanged').length,1);
  await f.runtime.photos(cp);assert.equal(f.notifications.length,1);
 }finally{await f.close();}
});
test('partial durable success followed by a transfer error still notifies without replacing the error',async()=>{
 const original=Object.assign(Error('synthetic ACK response failure'),{code:'ASSET_NETWORK'});
 const f=await fixture({plan:async io=>{await io.write('partial');throw original;}});
 try{await assert.rejects(()=>f.runtime.photos(cp),error=>error===original);assert.equal(f.notifications.length,1);
  assert.equal((await f.pending()).count,1);assert.equal(await (await f.readFile('photo:drawing:partial')).text(),'Synthetic mirror partial');
 }finally{await f.close();}
});
test('a transfer failure before any durable mirror sends no notification',async()=>{
 const original=Error('synthetic pre-download failure'),f=await fixture({plan:async()=>{throw original;}});
 try{await assert.rejects(()=>f.runtime.photos(cp),error=>error===original);assert.equal(f.notifications.length,0);assert.equal((await f.pending()).count,0);}
 finally{await f.close();}
});
test('a rejected durable file transaction cannot be advertised as journaled',async()=>{
 const f=await fixture(),native=IDBObjectStore.prototype.put;
 try{IDBObjectStore.prototype.put=function(...args){if(this.transaction.db.name==='surveyFieldNoteDB'&&String(args[1]).startsWith('photo:'))throw new DOMException('synthetic quota','QuotaExceededError');return native.apply(this,args);};
  await assert.rejects(()=>f.runtime.photos(cp),error=>error.name==='QuotaExceededError');assert.equal(f.notifications.length,0);
 }finally{IDBObjectStore.prototype.put=native;}
 try{assert.equal((await f.pending()).count,0);assert.equal(await f.readFile('photo:drawing:one'),undefined);}
 finally{await f.close();}
});
test('a throwing observer preserves the result and retries the dirty notice on the next batch',async()=>{
 let attempts=0;const f=await fixture({onNotify:()=>{if(++attempts===1)throw Error('synthetic observer failure');}});
 try{assert.equal((await f.runtime.photos(cp)).complete,true);assert.equal(attempts,1);assert.equal((await f.pending()).count,1);
  assert.equal((await f.runtime.photos(cp)).complete,true);assert.equal(attempts,2);assert.equal((await f.pending()).count,0);
  await f.runtime.photos(cp);assert.equal(attempts,2);assert.equal(await (await f.readFile('photo:drawing:one')).text(),'Synthetic mirror one');
 }finally{await f.close();}
});
test('a notification guard failure cannot replace the transfer error or lose the saved dirty state',async()=>{
 const original=Object.assign(Error('synthetic original transfer error'),{code:'ASSET_NETWORK'}),guard=Error('synthetic capacity read failure');
 let f;f=await fixture({plan:async io=>{await io.write('guarded-notice');f.failCapacity(guard);throw original;}});
 try{await assert.rejects(()=>f.runtime.photos(cp),error=>error===original);assert.equal(f.notifications.length,0);
  assert.equal((await f.pending()).count,1);assert.equal(await (await f.readFile('photo:drawing:guarded-notice')).text(),'Synthetic mirror guarded-notice');
  f.failCapacity(null);f.setPlan(async io=>{await io.write('guarded-notice');return complete();});
  await f.runtime.photos(cp);assert.equal(f.notifications.length,1);assert.equal((await f.pending()).count,0);
 }finally{f.failCapacity(null);await f.close();}
});
test('a notification guard failure after final transfer validation preserves successful completion',async()=>{
 let checks=0;const guard=Error('synthetic notification-only guard failure');
 const f=await fixture({plan:async io=>{await io.write('successful-guard');
  const ordinary=globalThis.SentlogCapacity.isCleared;
  globalThis.SentlogCapacity.isCleared=id=>{
   // First call is the existing post-transfer check; second is the new notice.
   if(++checks===2)throw guard;return ordinary(id);
  };return complete();}});
 try{assert.equal((await f.runtime.photos(cp)).complete,true);assert.equal(checks,2);assert.equal(f.notifications.length,0);
  assert.equal((await f.pending()).count,1);assert.equal(await (await f.readFile('photo:drawing:successful-guard')).text(),'Synthetic mirror successful-guard');
  f.setPlan(async io=>{await io.write('successful-guard');return complete();});await f.runtime.photos(cp);
  assert.equal(f.notifications.length,1);assert.equal((await f.pending()).count,0);
 }finally{await f.close();}
});
test('concurrent callers share one photo flight and one notification',async()=>{
 const entered=gate(),release=gate();const f=await fixture({plan:async io=>{await io.write('concurrent');entered.resolve();await release.promise;io.check();return complete();}});
 try{const first=f.runtime.photos(cp);await entered.promise;const second=f.runtime.photos(cp);await flush();
  assert.equal(f.assetCalls,1);assert.equal(f.notifications.length,0);release.resolve();await Promise.all([first,second]);assert.equal(f.notifications.length,1);
 }finally{release.resolve();await f.close();}
});
test('an auth generation change never sends an old file event to the new account',async()=>{
 const entered=gate(),release=gate();const f=await fixture({plan:async io=>{await io.write('old-owner');entered.resolve();await release.promise;io.check();return complete();}});
 try{const result=f.runtime.photos(cp).then(value=>({value}),error=>({error}));await entered.promise;f.switchUser('synthetic-other-owner');release.resolve();
  assert((await result).error);assert.equal(f.notifications.length,0);assert.equal((await f.pending()).count,1);
  assert.equal(await (await f.readFile('photo:drawing:old-owner')).text(),'Synthetic mirror old-owner');
 }finally{release.resolve();await f.close();}
});
test('runtime close suppresses a late dirty callback while preserving the old WAL',async()=>{
 const entered=gate(),release=gate();const f=await fixture({plan:async io=>{await io.write('closing');entered.resolve();await release.promise;io.check();return complete();}});
 try{const result=f.runtime.photos(cp).then(value=>({value}),error=>({error}));await entered.promise;f.runtime.close();release.resolve();
  assert((await result).error);assert.equal(f.notifications.length,0);assert.equal((await f.pending()).count,1);
 }finally{release.resolve();await f.close();}
});
test('cleanup leases retain a partial batch notice until the last lease is released',async()=>{
 const entered=gate(),release=gate();const f=await fixture({plan:async io=>{await io.write('paused');entered.resolve();await release.promise;io.check();return complete();}});
 try{const result=f.runtime.photos(cp).then(value=>({value}),error=>({error}));await entered.promise;
  const pausing=f.runtime.suspendPhotos(cp);await flush();release.resolve();assert((await result).error);const first=await pausing;
  const second=await f.runtime.suspendPhotos(cp);assert.equal(f.notifications.length,0);assert.equal((await f.pending()).count,1);
  first();assert.equal(f.notifications.length,0);second();assert.equal(f.notifications.length,1);second();assert.equal(f.notifications.length,1);
 }finally{release.resolve();await f.close();}
});
test('a persisted cleanup marker prevents dirty callbacks until explicit restore and a completed batch',async()=>{
 const entered=gate(),release=gate();const f=await fixture({plan:async io=>{await io.write('cleared');entered.resolve();await release.promise;io.check();return complete();}});
 try{const result=f.runtime.photos(cp).then(value=>({value}),error=>({error}));await entered.promise;const pausing=f.runtime.suspendPhotos(cp);
  await flush();release.resolve();assert((await result).error);const resume=await pausing;f.markCleared(true);resume();
  assert.equal(f.notifications.length,0);assert.equal((await f.runtime.photos(cp)).skipped,true);assert.equal(f.notifications.length,0);
  f.markCleared(false);f.setPlan(async io=>{await io.write('cleared');return complete();});await f.runtime.photos(cp);assert.equal(f.notifications.length,1);
 }finally{release.resolve();await f.close();}
});
test('new file events respect the existing retry boundary and minimum start gap',async()=>{
 const time=clock(),starts=[];let edit;const f=await fixture({onNotify:({localProjectId})=>edit.request([localProjectId])});
 edit=Edit.createScheduler({...time,run:async()=>{starts.push(time.now());return starts.length===1?{started:true,retryAt:time.now()+30000}:{started:true};}});
 try{await f.runtime.photos(cp);await time.tick(800);assert.deepEqual(starts,[800]);
  f.setPlan(async io=>{await io.write('two');return complete();});await f.runtime.photos(cp);
  await time.tick(29999);assert.deepEqual(starts,[800]);await time.tick(1);assert.deepEqual(starts,[800,30800]);
  f.setPlan(async io=>{await io.write('three');return complete();});await f.runtime.photos(cp);
  await time.tick(1499);assert.deepEqual(starts,[800,30800]);await time.tick(1);assert.deepEqual(starts,[800,30800,32300]);
 }finally{edit.dispose();await f.close();}
});
test('the cloud hook feeds the established edit scheduler without forcing work or ACKing',async()=>{
 const source=fs.readFileSync(path.join(root,'sentlog/delta-sync-cloud-runtime.txt'),'utf8');
 assert.equal(source.split('onFileJournaled:({localProjectId})=>editSync.request([localProjectId]),').length-1,1);
 const callback=/onFileJournaled:(\(\{localProjectId\}\)=>editSync\.request\(\[localProjectId\]\)),/.exec(source)[1],calls=[];
 const notify=vm.runInNewContext('('+callback+')',{editSync:{request:(...args)=>calls.push(args)}});
 notify({localProjectId:cp.client_key});assert.equal(JSON.stringify(calls),JSON.stringify([[[cp.client_key]]]));
});
(async()=>{let passed=0,failed=0;for(const [name,fn]of tests){if(process.env.SENTLOG_FILE_WAKE_TEST&&!name.includes(process.env.SENTLOG_FILE_WAKE_TEST))continue;
 try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,'\n'+(error.stack||error));}}
 assert(passed+failed>0,'test filter selected no cases');console.log(JSON.stringify({suite:'file journal batch wake',passed,failed}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

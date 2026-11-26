'use strict';
// Synthetic scheduling only. No production source is patched or live DB read.
// The observer runs real receive/ACK operations after the real bridge has
// prepared a plan and before the real controller calls bridge.commit(plan).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const root=process.env.SENTLOG_RECEIVE_CONTENTION_SOURCE_ROOT||path.resolve(__dirname,'..');
const coreRoot=process.env.SENTLOG_RECEIVE_CONTENTION_CORE_ROOT||root;
const C=require(path.join(root,'sentlog/record-collaboration.js'));
const D=require(path.join(coreRoot,'sentlog/delta-sync-core.js'));
const I=require(path.join(root,'sentlog/delta-sync-indexeddb.js'));
const B=require(path.join(root,'sentlog/delta-sync-app-bridge.js'));
const J=require(path.join(root,'sentlog/delta-sync-app-journal.js'));
const M=require(path.join(root,'sentlog/delta-sync-metadata.js'));
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const copy=structuredClone,json=JSON.stringify,sha=value=>createHash('sha256').update(typeof value==='string'?value:json(value)).digest('hex');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:drawing',LOG='sentlog_delta_journal_v1';
const localProjectId='synthetic-local',scope={ownerId:'synthetic-owner',projectId:'synthetic-shared',deviceId:'synthetic-phone'};
const actor={deviceId:scope.deviceId,deviceName:'Synthetic local'};
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const append=(r,id,device='synthetic-peer')=>C.appendComment(r,'Synthetic '+id,{at:2000,actor:{deviceId:device,deviceName:'Synthetic'},commentId:id,revisionId:id+'-revision'});
const moduleNames=['delta-sync-core.js','delta-sync-app-bridge.js','delta-sync-app-journal.js','delta-sync-indexeddb.js','record-store.js'];
const moduleHashes=()=>Object.fromEntries(moduleNames.map(name=>[name,createHash('sha256').update(
 fs.readFileSync(path.join(name==='delta-sync-core.js'?coreRoot:root,'sentlog',name))).digest('hex')]));
const report={format:'sentlog-synthetic-delta-stale-reproduction',version:1,moduleSha256:moduleHashes(),
  callbacksLoaded:false,productionEdited:false,syntheticIndexedDB:true,cases:[]};

async function fixture(){
 const factory=new IDBFactory(),target=C.upgrade({id:'target',memo:'Synthetic seed',photos:[]}),clock=C.upgrade({id:'clock',memo:'Synthetic clock',photos:[]});
 const meta={id:'drawing',name:'Synthetic drawing'},project={id:localProjectId,name:'Synthetic project',collaborationVersion:1,drawings:[meta]};
 const local=new Map([[WS,json({projects:[project]})],[DRAW,json({shapes:[target,clock],collabDeletedRecords:[],pageSettings:{1:{scale:100}}})]]);
 const ctx={window:null,indexedDB:factory,IDBKeyRange,Blob,queueMicrotask,structuredClone,crypto:webcrypto,console,navigator:{},SentlogDeltaSyncCore:D,
  localStorage:{get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)}};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'sentlog/record-store.js'),'utf8'),ctx);
 const records=ctx.SentlogRecords;await records.init();
 const cutoff=await records.deltaJournal.begin({scope,localProjectId,actor});
 const initial={[D.keyOf('drawing','target')]:target,[D.keyOf('drawing','clock')]:clock,...await M.seed(cutoff.snapshot)};
 await records.deltaJournal.activate({scope,localProjectId,baselineId:'synthetic-baseline',baselineSnapshot:cutoff.snapshot,metadataRecords:M.metadataRecords(initial)});
 const adapter=I.createStore({...scope,indexedDB:factory,databaseName:'sentlog-delta-test-stale-repro'}),durableWrites=[];
 let beforeWrite=null;
 const store={...adapter,async write(value){if(beforeWrite)await beforeWrite(value);const result=await adapter.write(value);
  durableWrites.push({cursor:value.cursor,outbox:value.outbox.length});return result;}};
 await store.read();await store.write({version:2,scope:copy(scope),cursor:0,records:initial,outbox:[]});
 const rows=[],tickets=[],listEntered=gate(),listRelease=gate(),listPages=[];let pushSignal=gate(),holdAck=false,holdList=false,remote=copy(target);
 const transport={online:()=>true,getCapabilities:()=>({atomicGroups:true}),
  async push(event){
   const found=rows.find(r=>r.event.eventId===event.eventId);let row=found;
   if(!row){row={seq:rows.length+1,event:copy(event)};rows.push(row);}
   const ack={seq:row.seq,eventId:event.eventId,projectId:event.projectId,deviceId:event.deviceId,drawingId:event.drawingId,recordId:event.recordId};
   if(!holdAck)return ack;
   const deferred=gate();tickets.push({ack,deferred});pushSignal.resolve();pushSignal=gate();return deferred.promise;
  },
  async list(_project,cursor,limit){if(holdList){listEntered.resolve();await listRelease.promise;}const page=copy(rows.filter(r=>r.seq>cursor).slice(0,limit));listPages.push({cursor,rows:page.length});return page;}
 };
 const replica=D.createReplica({...scope,store,transport,reconcileIntervalMs:0});
 const bridge=B.createBridge({replica,scope,localProjectId,currentScope:()=>scope});
 let afterPrepare=null,attempts=0;const plans=[];
 const observedBridge={...bridge,async prepare(options){const plan=await bridge.prepare(options);attempts++;
  const before=await replica.snapshotWithStatus();
  const detail={attempt:attempts,changes:plan.changes.length,ready:plan.ready,operationIds:(plan.changes||[]).map(x=>x.eventId),beforeCursor:before.snapshot.cursor,beforeOutbox:before.snapshot.outbox.length};
  if(afterPrepare)await afterPrepare(plan,attempts);
  const after=await replica.snapshotWithStatus();detail.afterCursor=after.snapshot.cursor;detail.afterOutbox=after.snapshot.outbox.length;
  detail.tokenChanged=before.snapshotToken!==after.snapshotToken;plans.push(detail);return plan;
 }};
 const controller=J.createController({records,scope,localProjectId,replica,replicaStore:store,bridge:observedBridge,metadata:M,currentScope:()=>scope});
 async function readStore(name){const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction(name,'readonly'),s=tx.objectStore(name);let keys,values;s.getAllKeys().onsuccess=e=>{keys=e.target.result;};s.getAll().onsuccess=e=>{values=e.target.result;};
  tx.oncomplete=()=>resolve(keys.map((k,i)=>[k,values[i]]));tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
 function queueRemote(i){const before=remote;remote=append(before,'peer-'+i);const event=D.diffRecord(before,remote,{eventId:'remote-event-'+i,projectId:scope.projectId,drawingId:'drawing',deviceId:'synthetic-peer'});
  rows.push({seq:rows.length+1,event});}
 async function receive(i){queueRemote(i);await replica.sync();}
 async function seedAcks(){for(let i=1;i<=8;i++){const before=(await replica.snapshot()).records[D.keyOf('drawing','clock')];
  await replica.change({drawingId:'drawing',before,after:append(before,'ack-'+i,scope.deviceId),eventId:'ack-event-'+i});}
  await controller.project();holdAck=holdList=true;}
 async function waitPushCount(n){while(tickets.length<n){const signal=pushSignal;await signal.promise;}}
 async function releaseAck(i){const ticket=tickets[i-1];assert(ticket,'missing controlled ACK');ticket.deferred.resolve(ticket.ack);
  if(i<8)await waitPushCount(i+1);else await listEntered.promise;}
 function finishAcks(){holdAck=holdList=false;listRelease.resolve();for(const t of tickets)t.deferred.resolve(t.ack);}
 return {records,store,replica,controller,bridge,observedBridge,plans,listPages,durableWrites,readStore,queueRemote,receive,seedAcks,waitPushCount,releaseAck,finishAcks,
  set writeGate(value){beforeWrite=value;},
  set afterPrepare(value){afterPrepare=value;},get attempts(){return attempts;},
  pending:()=>records.deltaJournal.pending({scope,localProjectId}),capture:()=>B.captureProject({records,localProjectId}),
  close(){finishAcks();controller.close();bridge.close();replica.close();store.close();}};
}

async function singlePageScenario(kind){
 const f=await fixture();let pump=null,held=null,changed=gate(),pumpDone=false,preparing=false,prepareReadPending=false,lastCursor=0,attempts=0;
 const entry={kind,pressure:'one-page-18-rows',planTrace:[],writeCursorTrace:[]};
 const signal=()=>{changed.resolve();changed=gate();};
 const release=()=>{if(held){held.release.resolve();held=null;signal();}};
 const snapshot=f.replica.snapshotWithStatus.bind(f.replica);
 try{
  if(kind==='file-no-op')await f.records.writeFile('photo:drawing:synthetic-mirror',new Blob(['Synthetic durable photo bytes'],{type:'image/png'}));
  else{const state=JSON.parse(f.records.getItem(DRAW));state.shapes=state.shapes.map(r=>r.id==='target'?append(r,'local-claim',scope.deviceId):r);
   f.records.setItem(DRAW,json(state));await f.records.settled();}
  const claimed=await f.records.deltaJournal.claim({scope,localProjectId}),beforeWal=sha(await f.readStore(LOG));assert(claimed);
  for(let i=1;i<=18;i++)f.queueRemote(i);
  f.writeGate=async candidate=>{
   if(candidate.cursor<=lastCursor)return;
   lastCursor=candidate.cursor;entry.writeCursorTrace.push(candidate.cursor);
   const ticket={cursor:candidate.cursor,release:gate()};held=ticket;signal();
   // A snapshot already queued behind this local write must be allowed to
   // read. No snapshot value/token is fabricated or read outside core.local.
   if(prepareReadPending)release();
   await ticket.release.promise;if(held===ticket)held=null;
  };
  f.replica.snapshotWithStatus=(...args)=>{
   const observed=preparing;const value=snapshot(...args);
   if(observed){prepareReadPending=true;release();}
   return value.then(result=>{if(observed)prepareReadPending=false;return result;},error=>{if(observed)prepareReadPending=false;throw error;});
  };
  f.observedBridge.prepare=async options=>{
   attempts++;preparing=true;let plan;
   try{plan=await f.bridge.prepare(options);}finally{preparing=false;}
   const detail={attempt:attempts,changes:plan.changes.length,ready:plan.ready};entry.planTrace.push(detail);
   if(!pump){pump=f.replica.sync().finally(()=>{pumpDone=true;signal();});}
   while(!held&&!pumpDone){const waiting=changed;await waiting.promise;}
   detail.writeReleasedAfterPlan=held?.cursor??null;
   // Let the next real receive transaction finish before the controller's
   // ordinary commit runs. The old row loop offers this window repeatedly;
   // an atomic page write offers it only once.
   release();return plan;
  };
  let error=null;try{await f.controller.drain();}catch(e){error=e;}
  entry.attemptsBeforeResume=attempts;entry.firstDrainError=error?{code:error.code,message:error.message}:null;
  entry.firstDrainCompleted=!error;
  assert(entry.planTrace.every(p=>p.changes===(kind==='file-no-op'?0:1)));
  if(error){
   assert.equal(error.code,'DELTA_STALE');assert.equal(attempts,8);
   const retained=await f.records.deltaJournal.claim({scope,localProjectId});assert.equal(retained.id,claimed.id);assert.deepEqual(retained.rowIds,claimed.rowIds);
   assert.equal(sha(await f.readStore(LOG)),beforeWal);entry.claimRetained=true;entry.walSha256=beforeWal;
  }else{assert.equal((await f.pending()).count,0);}
  f.writeGate=null;release();await pump;
  f.replica.snapshotWithStatus=snapshot;f.observedBridge.prepare=options=>f.bridge.prepare(options);
  if(error)await f.controller.drain();
  const after=await f.replica.snapshot(),target=after.records[D.keyOf('drawing','target')];
  assert.equal(after.cursor,18);for(let i=1;i<=18;i++)assert(target.collab.comments['peer-'+i]);
  assert.equal((await f.pending()).count,0);assert.equal(after.outbox.length,kind==='file-no-op'?0:1);
  if(kind==='record-change')assert(target.collab.comments['local-claim']);
  const projected=f.capture().drawings[0].state.shapes.find(r=>r.id==='target');assert.equal(json(projected.collab),json(target.collab));
  assert.equal(json(await f.store.readForVerification()),json(after));
  if(kind==='file-no-op'){const file=(await f.readStore('files')).find(([k])=>k==='photo:drawing:synthetic-mirror')?.[1];assert.equal(await file.text(),'Synthetic durable photo bytes');}
  assert.deepEqual(f.listPages,[{cursor:0,rows:18}],'reproduction must receive exactly one complete page');
  let durableCursor=0;entry.receivePersistCursors=[];for(const write of f.durableWrites)if(write.cursor>durableCursor){entry.receivePersistCursors.push(write.cursor);durableCursor=write.cursor;}
  entry.transportPages=copy(f.listPages);entry.final={cursor:after.cursor,journal:0,outbox:after.outbox.length,replicaSha256:sha(after),
   projectedTargetHistorySha256:sha(projected.collab),targetCommentCount:Object.keys(target.collab.comments).length};
  entry.status=error?'single-page-starvation-reproduced':'single-page-first-drain-completed';report.cases.push(entry);
  console.log(entry.status,kind,'attempts',attempts,'writes',entry.writeCursorTrace.length,'error',error?.code||'none');
  assert.equal(error,null,'one complete receive page must not exhaust the first journal drain');
  assert(attempts<=2,'one page may invalidate at most the first prepared plan');
  assert.deepEqual(entry.receivePersistCursors,[18],'one valid receive page must commit records and cursor together once');
 }finally{f.writeGate=null;release();f.replica.snapshotWithStatus=snapshot;f.close();if(pump)await pump.catch(()=>{});}
}

async function scenario(kind,pressure){
 const f=await fixture();let pump=null;
 const entry={kind,pressure,attemptsBeforeResume:0};
 try{
  if(pressure==='ack')await f.seedAcks();
  if(kind==='file-no-op')await f.records.writeFile('photo:drawing:synthetic-mirror',new Blob(['Synthetic durable photo bytes'],{type:'image/png'}));
  else {const state=JSON.parse(f.records.getItem(DRAW));state.shapes=state.shapes.map(r=>r.id==='target'?append(r,'local-claim',scope.deviceId):r);
   f.records.setItem(DRAW,json(state));await f.records.settled();}
  const claimed=await f.records.deltaJournal.claim({scope,localProjectId});assert(claimed);
  const beforeWal=await f.readStore(LOG),beforeWalSha=sha(beforeWal);
  if(pressure==='receive')f.afterPrepare=async(_plan,i)=>f.receive(i);
  if(pressure==='ack'){pump=f.replica.sync();await f.waitPushCount(1);f.afterPrepare=async(_plan,i)=>f.releaseAck(i);}
  let error=null;try{await f.controller.drain();}catch(e){error=e;}
  entry.attemptsBeforeResume=f.attempts;entry.firstDrainError=error?{code:error.code,message:error.message}:null;
  entry.planTrace=copy(f.plans);
  if(pressure==='none'){
   assert.equal(error,null);assert.equal(f.attempts,1);assert.equal((await f.pending()).count,0);
   entry.firstDrainCompleted=true;
  }else{
   assert.equal(error?.code,'DELTA_STALE');assert.equal(f.attempts,8);
   assert(f.plans.every(p=>p.tokenChanged));
   const retained=await f.records.deltaJournal.claim({scope,localProjectId});assert.equal(retained.id,claimed.id);assert.deepEqual(retained.rowIds,claimed.rowIds);
   assert.equal(sha(await f.readStore(LOG)),beforeWalSha,'failed CAS changed the immutable WAL');
   const pending=await f.pending();assert(pending.count>0&&pending.claimId===claimed.id);
   entry.firstDrainCompleted=false;entry.claimRetained=true;entry.walSha256=beforeWalSha;
   entry.pendingAfterError={count:pending.count,hasClaim:!!pending.claimId};
  }
  assert(f.plans.every(p=>p.changes===(kind==='file-no-op'?0:1)),entry.planTrace);
  // End only the controlled contention, then explicitly retry the same claim.
  f.afterPrepare=null;f.finishAcks();if(pump)await pump;
  const beforeResume=await f.replica.snapshot();entry.replicaBeforeResumeSha256=sha(beforeResume);
  if(pressure==='receive')for(let i=1;i<=8;i++)assert(beforeResume.records[D.keyOf('drawing','target')].collab.comments['peer-'+i]);
  if(pressure==='ack')for(let i=1;i<=8;i++)assert(beforeResume.records[D.keyOf('drawing','clock')].collab.comments['ack-'+i]);
  if(pressure!=='none')await f.controller.drain();
  const pendingAfter=await f.pending();assert.equal(pendingAfter.count,0);assert.equal(pendingAfter.claimId,null);
  const after=await f.replica.snapshot(),target=after.records[D.keyOf('drawing','target')];
  assert.equal(after.outbox.length,kind==='file-no-op'?0:1);
  if(kind==='record-change')assert(target.collab.comments['local-claim']);
  if(pressure==='receive')for(let i=1;i<=8;i++)assert(target.collab.comments['peer-'+i]);
  if(kind==='file-no-op'){
   const file=(await f.readStore('files')).find(([k])=>k==='photo:drawing:synthetic-mirror')?.[1];assert(file instanceof Blob);
   assert.equal(await file.text(),'Synthetic durable photo bytes');entry.photoSha256=sha(await file.text());
  }
  const projected=f.capture().drawings[0].state.shapes.find(r=>r.id==='target');assert.equal(json(projected.collab),json(target.collab));
  assert.equal(json(await f.store.readForVerification()),json(after));
  entry.manualResume={journal:0,outbox:after.outbox.length,replicaSha256:sha(after),projectedTargetHistorySha256:sha(projected.collab),targetCommentCount:Object.keys(target.collab.comments).length};
  entry.status=pressure==='none'?'control-passed':'starvation-reproduced-and-retained';
  report.cases.push(entry);console.log(entry.status,kind,pressure,'attempts',entry.attemptsBeforeResume,'error',entry.firstDrainError?.code||'none');
 }finally{f.finishAcks();f.close();if(pump)await pump.catch(()=>{});}
}

(async()=>{
 const timer=setTimeout(()=>{console.error('synthetic reproduction did not complete');process.exit(2);},30000);
 try{
  const cases=[];
  for(const pressure of ['none','receive','ack'])for(const kind of ['file-no-op','record-change'])cases.push([kind+' / '+pressure,()=>scenario(kind,pressure)]);
  for(const kind of ['file-no-op','record-change'])cases.push([kind+' / single-page',()=>singlePageScenario(kind)]);
  let passed=0,failed=0;report.results=[];
  for(const [name,run]of cases){
   if(process.env.SENTLOG_RECEIVE_CONTENTION_CASE&&!name.includes(process.env.SENTLOG_RECEIVE_CONTENTION_CASE))continue;
   try{await run();passed++;report.results.push({name,status:'passed'});console.log('PASS',name);}
   catch(error){failed++;report.results.push({name,status:'failed',code:error.code||error.name,message:error.message});console.error('FAIL',name,'\n'+(error.stack||error));}
  }
  assert(passed+failed>0,'case filter must select a regression');assert.deepEqual(moduleHashes(),report.moduleSha256,'product source changed during the isolated test');
  report.passed=passed;report.failed=failed;
  const out=process.env.SENTLOG_RECEIVE_CONTENTION_REPORT;if(out)fs.writeFileSync(out,json(report));
  console.log(json({suite:'delta journal receive contention',passed,failed,callbacksLoaded:false}));if(failed)process.exitCode=1;
 }finally{clearTimeout(timer);}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

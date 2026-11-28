'use strict';
// The real writer, WAL controller, replica and durable IndexedDB store. Only
// network delivery/photo batches are controlled; no user's database is opened.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const base=process.env.SENTLOG_RESIDENCY_SOURCE_ROOT||path.resolve(__dirname,'..');
const load=name=>require(path.join(base,'sentlog',name+'.js'));
const C=load('record-collaboration'),D=load('delta-sync-core'),I=load('delta-sync-indexeddb'),M=load('delta-sync-metadata');
const R=load('delta-sync-app-runtime'),B=load('delta-sync-app-bridge'),J=load('delta-sync-app-journal');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',copy=structuredClone;
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const gate=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
async function until(fn,label){for(let n=0;n<1000;n++){if(await fn())return;await tick();}throw Error(label);}
async function fixture({count=4,online=false,photo,recordsPerProject=1}={}){
  const db=new IDBFactory(),local=new Map(),auth=new Set(),scopes=new Map(),states=new Map(),created=[],stores=[],assets=[];
  const projects=Array.from({length:count},(_,n)=>({id:'local-'+n,name:'案件'+n,collaborationVersion:1,drawings:[{id:'drawing-'+n,name:'図面'+n}]}));
  const cps=projects.map((p,n)=>({id:'cloud-'+n,client_key:p.id,name:p.name,status:'active'}));
  local.set(WS,JSON.stringify({projects}));
  for(let n=0;n<count;n++)local.set(DRAW+'drawing-'+n,JSON.stringify({shapes:Array.from({length:recordsPerProject},(_,r)=>
    C.upgrade({id:'record-'+r,memo:'保存した所見 '+n+':'+r,photos:[]})),collabDeletedRecords:[],pageSettings:{1:{scale:100}}}));
  const context={window:null,indexedDB:db,IDBKeyRange,Blob,queueMicrotask,structuredClone,crypto:webcrypto,console,navigator:{},SentlogDeltaSyncCore:D,
    localStorage:{get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)}};
  context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(base,'sentlog/record-store.js'),'utf8'),context);
  const records=context.SentlogRecords;await records.init();
  const actor={deviceId:'device',deviceName:'合成端末'};
  for(let n=0;n<count;n++){
    const scope={ownerId:'owner',projectId:cps[n].id,deviceId:'device'};scopes.set(cps[n].id,scope);
    const cutoff=await records.deltaJournal.begin({scope,localProjectId:projects[n].id,actor});
    const seeded=await M.seed(cutoff.snapshot);
    for(const d of cutoff.snapshot.drawings)for(const record of d.state.shapes)seeded[D.keyOf(d.meta.id,record.id)]=record;
    await records.deltaJournal.activate({scope,localProjectId:projects[n].id,baselineId:'baseline-'+n,baselineSnapshot:cutoff.snapshot,metadataRecords:M.metadataRecords(seeded)});
    const adapter=I.createStore({...scope,indexedDB:db,databaseName:'sentlog-delta-test-residency'});
    await adapter.read();await adapter.write({version:2,scope:copy(scope),cursor:0,records:seeded,outbox:[]});adapter.close();
    states.set(scope.projectId,{index:n,scope,listeners:new Set(),events:[],checkpoint:null,requests:[],listGate:null,reading:false,writeGate:null,writing:false,readyCalls:0,failReady:false});
  }
  let owner='owner',generation=1,isOnline=online,assetPlan=photo,projectionGate=null;
  function makeStore(scope){
    const state=states.get(scope.projectId),inner=I.createStore({...scope,indexedDB:db,databaseName:'sentlog-delta-test-residency'}),entry={scope,closed:false};stores.push(entry);
    return {...inner,readProvenance:async()=>({baseline:{baselineId:'baseline-'+state.index}}),async write(value){
      if(state.writeGate){state.writing=true;await state.writeGate.promise;state.writing=false;}
      return inner.write(value);
    },close(){assert(!state.writing,'park interrupted an outstanding durable write');entry.closed=true;inner.close();}};
  }
  function transport({scope}){
    const state=states.get(scope.projectId),recordEvent=event=>{
      const old=state.events.find(x=>x.event?.eventId===event.eventId);if(old)return {seq:old.seq,...copy(event)};
      const seq=(state.events.at(-1)?.endSeq||state.events.at(-1)?.seq||0)+1;state.events.push({seq,event:copy(event)});return {seq,...copy(event)};
    };
    return {getScope:()=>copy(scope),getCapabilities:()=>({atomicGroups:true,sharedMetadata:true,certifiedArchive:true,writerJournal:2}),
      online:()=>isOnline,ready:async()=>{state.readyCalls++;if(state.failReady)throw Error('synthetic authentication offline');return true;},close(){state.listeners.clear();},wake(){},
      inspect:async()=>({enabled:true,canActivate:false,headSeq:state.events.at(-1)?.endSeq||state.events.at(-1)?.seq||0,snapshotRevision:1,
        baseline:{baselineId:'baseline-'+state.index,snapshotRevision:1}}),
      subscribe(_id,fn){state.listeners.add(fn);return()=>state.listeners.delete(fn);},
      push:async event=>recordEvent(event),pushGroup:async group=>{
        const old=state.events.find(x=>x.group?.groupId===group.groupId);if(old)return {startSeq:old.seq,endSeq:old.endSeq};
        const seq=(state.events.at(-1)?.endSeq||state.events.at(-1)?.seq||0)+1,endSeq=seq+group.events.length-1;
        state.events.push({seq,endSeq,group:copy(group)});return {startSeq:seq,endSeq};
      },async list(_id,after){
        state.reading=true;try{if(state.listGate)await state.listGate.promise;return copy(state.events.filter(x=>x.seq>after));}finally{state.reading=false;}
      },async publishCheckpoint(headSeq,requestId){
        state.requests.push(requestId);if(state.checkpoint?.headSeq!==headSeq){state.checkpoint={schema:1,projectId:scope.projectId,headSeq,revision:2,
          payloadSha256:'a'.repeat(64),payload:B.captureProject({records,localProjectId:cps[state.index].client_key})};}
        return {...copy(state.checkpoint),requestId};
      }};
  }
  let runtime;
  function create(){return R.createRuntime({records,url:'https://synthetic.invalid',key:'fixture',session:()=>({user:{id:owner}}),ensureSession:async()=>{},
    authGeneration:()=>generation,subscribeAuth:fn=>{auth.add(fn);return()=>auth.delete(fn);},deviceId:()=>actor.deviceId,actor:()=>copy(actor),network:()=>isOnline,visible:()=>true,
    install:async()=>{throw Error('already installed');},readFile:async()=>null,withFileLock:async(_key,fn)=>fn(),
    applyProjection:async(cp,projection,options)=>{
      if(projectionGate)await projectionGate.promise;
      const ws=JSON.parse(records.getItem(WS)),index=ws.projects.findIndex(p=>p.id===cp.client_key);ws.projects[index]=projection.project;
      return records.deltaJournal.applyProjection({...options,writes:[[WS,JSON.stringify(ws)],...projection.drawings.map(d=>[DRAW+d.meta.id,JSON.stringify(d.state)])]});
    },factories:{provider:()=>({}),transport,store:makeStore,replica:options=>{
      const actual=D.createReplica(options),entry={scope:options.store.getScope(),actual,closed:false};created.push(entry);
      return {...actual,close(){entry.closed=true;actual.close();}};
    },bridge:options=>B.createBridge(options),controller:options=>J.createController(options),
      assetStore:()=>({close(){}}),assetTransport:()=>({close(){}}),assets:options=>{
        const entry={scope:options.scope,closed:false};assets.push(entry);
        return {close(){entry.closed=true;},async sync(snapshot){
          return assetPlan?assetPlan({options,entry,snapshot}):{complete:true,pending:0,issues:[]};
        }};
      }}});}
  runtime=create();
  return {db,records,cps,scopes,states,created,stores,assets,get runtime(){return runtime;},get live(){return created.filter(x=>!x.closed);},
    online:value=>{isOnline=value;},setPhoto:fn=>{assetPlan=fn;},setProjection:point=>{projectionGate=point;},
    async read(n){const s=makeStore(scopes.get(cps[n].id));try{return await s.read();}finally{s.close();}},
    async edit(n,text){const key=DRAW+'drawing-'+n,state=JSON.parse(records.getItem(key));state.shapes[0].memo=text;records.setItem(key,JSON.stringify(state));await records.settled();},
    async park(n){await runtime.sync(cps[(n+1)%count]);await until(()=>!created.some(x=>x.scope.projectId===cps[n].id&&!x.closed),'project did not park');},
    notify(n,seq){const state=states.get(cps[n].id);for(const fn of [...state.listeners])fn({projectId:cps[n].id,seq});},
    restart(){runtime.close();runtime=create();},
    switchOwner(){owner='other';generation++;for(const fn of [...auth])fn();},
    close(){runtime.close();}};
}
const cases=[],test=(name,fn)=>cases.push([name,fn]);
test('many ordinary projects retain one idle replica and keep every ownership fence',async()=>{
  const f=await fixture({count:12,recordsPerProject:20});try{
    for(const cp of f.cps){await f.runtime.sync(cp);await tick();assert(f.live.length<=1,'idle project histories accumulated');}
    assert.equal(f.live.length,1);assert.equal(f.stores.filter(x=>!x.closed).length,1);
    for(const cp of f.cps)assert.equal(f.runtime.isActive(cp.client_key),true,'parking enabled the legacy fallback');
    for(const entry of f.created.slice(0,-1))assert.equal(entry.closed,true);
    const generations=f.created.length;await f.runtime.sync(f.cps[0]);await tick();
    assert.equal(f.created.length,generations+1);assert.equal(f.live.length,1);assert.equal(f.live[0].scope.projectId,f.cps[0].id);
  }finally{f.close();}
});
test('parking and full restart preserve exact durable unsent events and later ordinary edits',async()=>{
  const f=await fixture();try{
    await f.edit(0,'通信前の未送信入力');await f.runtime.sync(f.cps[0]);const saved=await f.read(0);assert(saved.outbox.length);
    await f.park(0);assert.deepEqual(await f.read(0),saved);
    f.restart();await f.runtime.sync(f.cps[0]);assert.deepEqual(await f.read(0),saved);
    await f.edit(0,'再起動後の追記');await f.runtime.sync(f.cps[0]);const after=await f.read(0);
    assert.deepEqual(after.outbox.slice(0,saved.outbox.length),saved.outbox);
    assert(after.records[D.keyOf('drawing-0','record-0')].memo.includes('再起動後の追記'));
    assert.equal((await f.records.deltaJournal.pending({scope:f.scopes.get(f.cps[0].id),localProjectId:f.cps[0].client_key})).count,0);
  }finally{f.close();}
});
test('an active photo batch and its nested sync cannot be parked by another project',async()=>{
  const entered=gate(),release=gate(),f=await fixture({photo:async({entry})=>{entered.resolve();await release.promise;assert.equal(entry.closed,false);return {complete:true};}});
  try{const first=f.runtime.photos(f.cps[0]);await entered.promise;await f.runtime.sync(f.cps[1]);await tick();
    assert(f.live.some(x=>x.scope.projectId===f.cps[0].id));assert.equal(f.assets[0].closed,false);
    release.resolve();assert.equal((await first).complete,true);await f.park(0);assert.equal(f.assets[0].closed,true);
  }finally{release.resolve();f.close();}
});
test('internal realtime receive and a pending IndexedDB save hold the replica until completion',async()=>{
  const f=await fixture({online:true});try{
    await f.runtime.sync(f.cps[0]);const state=f.states.get(f.cps[0].id),before=(await f.read(0)).records[D.keyOf('drawing-0','record-0')];
    const changed=C.applyLocalEdit(before,{...before,memo:'別端末からの受信'},{actor:{deviceId:'remote',deviceName:'別端末'},at:100,idFactory:()=> 'remote-revision'});
    const event=D.diffRecord(before,changed,{drawingId:'drawing-0',eventId:'remote-event',projectId:f.cps[0].id,deviceId:'remote'});
    state.events.push({seq:1,event});state.listGate=gate();f.notify(0,1);await until(()=>state.reading,'receive did not start');
    await f.runtime.sync(f.cps[1]);await tick();assert(f.live.some(x=>x.scope.projectId===f.cps[0].id),'in-flight receive was closed');
    state.writeGate=gate();state.listGate.resolve();state.listGate=null;await until(()=>state.writing,'durable receive did not start');
    await f.runtime.sync(f.cps[2]);await tick();assert(f.live.some(x=>x.scope.projectId===f.cps[0].id),'durable write was closed');
    state.writeGate.resolve();state.writeGate=null;await until(async()=>{const s=await f.read(0);return s.cursor===1;},'received bytes did not persist');
    await until(()=>!state.writing,'write remained active');await f.runtime.sync(f.cps[0]);await f.park(0);
    assert((await f.read(0)).records[D.keyOf('drawing-0','record-0')].memo.includes('別端末からの受信'));
  }finally{for(const state of f.states.values()){state.listGate?.resolve();state.writeGate?.resolve();}f.close();}
});
test('a parked project receives realtime through the bounded ordinary sync path',async()=>{
  const f=await fixture({online:true});try{
    await f.runtime.sync(f.cps[0]);await f.park(0);const first=f.created.length;
    f.notify(0,1);await until(()=>f.created.length>first&&f.live.some(x=>x.scope.projectId===f.cps[0].id),'parked notification was lost');
    await until(()=>f.live.length===1,'notification retained extra idle replicas');assert.equal(f.runtime.isActive(f.cps[0].client_key),true);
  }finally{f.close();}
});
test('checkpoint payload is reacquired with its stable request and unchanged certificate after parking',async()=>{
  const f=await fixture();try{
    const first=await f.runtime.checkpoint(f.cps[0]);await f.park(0);const second=await f.runtime.checkpoint(f.cps[0]);
    assert.deepEqual(second,first);const requests=f.states.get(f.cps[0].id).requests;assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
  }finally{f.close();}
});
test('archive proof stays valid across parking but rejects a newer durable edit',async()=>{
  const f=await fixture();try{
    for(const cp of f.cps)await f.runtime.sync(cp);
    const certificate=await f.runtime.checkpoint(f.cps[0]),job={id:'job',revision:certificate.revision,delta_checkpoint:certificate,payload:certificate.payload,manifest:[]};
    const proof=await f.runtime.archiveProof(f.cps[0],job);await f.park(0);
    const state=f.states.get(f.cps[0].id),calls=state.readyCalls;state.failReady=true;
    assert.equal(await proof.validate(),true);assert.equal(state.readyCalls,calls,'proof validation added a network requirement');state.failReady=false;
    await until(()=>!f.live.some(x=>x.scope.projectId===f.cps[0].id),'proof-only replica did not return to parked notifications');
    const before=(await f.read(0)).records[D.keyOf('drawing-0','record-0')];
    const received=C.applyLocalEdit(before,{...before,memo:'証明確認後も受信する'},{actor:{deviceId:'remote',deviceName:'別端末'},at:200,idFactory:()=> 'proof-notice-revision'});
    state.events.push({seq:1,event:D.diffRecord(before,received,{drawingId:'drawing-0',eventId:'proof-notice-event',projectId:f.cps[0].id,deviceId:'remote'})});
    f.online(true);f.notify(0,1);
    await until(async()=>{const saved=await f.read(0);return saved.cursor===1;},'proof validation disabled later realtime receive');
    await f.runtime.sync(f.cps[0]);f.online(false);
    await f.edit(0,'保管確認後の新しい変更');await f.runtime.sync(f.cps[0]);await f.park(0);
    await assert.rejects(()=>proof.validate(),error=>error.code==='DELTA_APP_CHANGED');
  }finally{f.close();}
});
test('photo cleanup leases survive parking and auth reset closes all owned resources',async()=>{
  const f=await fixture();try{
    await f.runtime.sync(f.cps[0]);const resume=await f.runtime.suspendPhotos(f.cps[0]);await f.park(0);
    assert.equal(resume.validate(),true);assert.equal((await f.runtime.photos(f.cps[0])).skipped,true);resume();
    assert.equal((await f.runtime.photos(f.cps[0])).complete,true);f.switchOwner();assert.equal(f.live.length,0);
    assert(f.stores.every(x=>x.closed));assert.equal(f.runtime.isActive(f.cps[0].client_key),false);
    assert.throws(()=>resume.validate(),error=>error.code==='DELTA_APP_SCOPE');
  }finally{f.close();}
});
(async()=>{for(const [name,fn] of cases){await fn();console.log('PASS',name);}console.log(JSON.stringify({suite:'ordinary app runtime residency',passed:cases.length}));})()
 .catch(error=>{console.error(error);process.exitCode=1;});

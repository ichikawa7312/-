'use strict';
// Real adapter + replica + journal proof, backed only by disposable fake IDB.
// Two writers are deliberate here; production Web Lock reachability is separate.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto');
const {IDBFactory,IDBKeyRange,IDBDatabase,IDBObjectStore}=require('fake-indexeddb');
const sourceRoot=process.env.SENTLOG_PROOF_SOURCE_ROOT||path.resolve(__dirname,'..');
const C=require(path.join(sourceRoot,'sentlog/record-collaboration.js'));
const D=require(path.join(sourceRoot,'sentlog/delta-sync-core.js'));
const I=require(path.join(sourceRoot,'sentlog/delta-sync-indexeddb.js'));
const writerSource=fs.readFileSync(path.join(sourceRoot,'sentlog/record-store.js'),'utf8');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const scope={ownerId:'synthetic-owner',projectId:'synthetic-project',deviceId:'synthetic-device'};
const drawingId='synthetic-drawing',recordId='synthetic-record',recordKey=D.keyOf(drawingId,recordId);
const envelopeKey=JSON.stringify([scope.ownerId,scope.projectId,scope.deviceId]);
const copy=structuredClone,json=JSON.stringify;
const hash=value=>createHash('sha256').update(json(value)).digest('hex');
const transport={online:()=>false,push:async()=>{throw Error('synthetic offline');},list:async()=>[]};
const base=()=>C.upgrade({id:recordId,memo:'Synthetic seed',photos:[]});
function append(record,writer){return C.appendComment(record,'Synthetic writer '+writer,{at:2,
  actor:{deviceId:scope.deviceId,deviceName:'Synthetic writer'},commentId:'comment-'+writer,revisionId:'revision-'+writer});}
async function fixture({seed=true}={}){
  const factory=new IDBFactory(),databaseName='sentlog-delta-test-proof-verification',local=new Map(),handles=[];
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,
    getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,
    queueMicrotask,structuredClone,crypto:webcrypto,SentlogDeltaSyncCore:D};
  context.window=context;vm.createContext(context);vm.runInContext(writerSource,context);await context.SentlogRecords.init();
  const records=context.SentlogRecords;
  const sa=I.createStore({...scope,indexedDB:factory,databaseName}),sb=I.createStore({...scope,indexedDB:factory,databaseName});
  const replica=store=>{const value=D.createReplica({...scope,store,transport,reconcileIntervalMs:0});handles.push(value);return value;};
  const a=replica(sa),b=replica(sb);
  if(seed)await a.change({drawingId,before:null,after:base(),eventId:'event-seed'});
  async function disk(){
    const db=await new Promise((resolve,reject)=>{const q=factory.open(databaseName);
      q.onupgradeneeded=()=>{q.transaction.abort();reject(Error('unexpected test DB creation'));};
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try{return await new Promise((resolve,reject)=>{const tx=db.transaction('replicas','readonly');let value;
      tx.objectStore('replicas').get(envelopeKey).onsuccess=e=>{value=e.target.result;};
      tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  async function otherWrite(){const before=(await b.snapshot()).records[recordKey];
    await b.change({drawingId,before,after:append(before,'B'),eventId:'event-B'});return disk();}
  async function prove(other={}){return records.deltaJournal.verifyReplay({scope,claimId:'synthetic-claim',replica:a,
    replicaStore:sa,requiredRecords:{[recordKey]:base()},projection:{synthetic:true},...other});}
  return {factory,databaseName,records,sa,sb,a,b,replica,disk,otherWrite,prove,
    close(){for(const value of handles)value.close();sa.close();sb.close();}};
}
const tests=[],test=(name,fn)=>tests.push([name,fn]);
test('verification peek cannot adopt an initial write revision',async()=>{
  const f=await fixture({seed:false});try{
    assert.equal(await f.sa.readForVerification(),null);
    const empty={version:2,scope:copy(scope),cursor:0,records:{},outbox:[]};
    await assert.rejects(()=>f.sa.write(empty),e=>e.code==='DELTA_STORE_NOT_READ');
    assert.equal(await f.disk(),undefined);
    assert.equal(await f.sa.read(),null);await f.sa.write(empty);assert.equal((await f.disk()).revision,1);
  }finally{f.close();}
});
test('normal durable proof uses only a readonly peek and preserves exact bytes',async()=>{
  const f=await fixture(),native=IDBDatabase.prototype.transaction,modes=[];try{
    const before=await f.disk(),snapshot=await f.a.snapshot();
    IDBDatabase.prototype.transaction=function(...args){if(this.name===f.databaseName)modes.push(args[1]||'readonly');return native.apply(this,args);};
    let proof;try{proof=await f.prove();}finally{IDBDatabase.prototype.transaction=native;}
    assert.deepEqual(modes,['readonly']);assert.equal(proof.kind,'durable-replay-proof');assert.equal(proof.recordCount,1);
    assert.equal(proof.replicaSha256,hash(snapshot));assert.equal(proof.requiredSha256,hash({[recordKey]:base()}));
    assert.equal(json(await f.disk()),json(before));assert.equal(json(await f.a.snapshot()),json(snapshot));
  }finally{IDBDatabase.prototype.transaction=native;f.close();}
});
test('rejected proof cannot let a stale replica overwrite another writer history or outbox',async()=>{
  const f=await fixture();try{
    const before=await f.otherWrite(),cached=await f.a.snapshot(),beforeBytes=Buffer.from(json(before));
    assert.equal(before.revision,2);assert(before.state.records[recordKey].collab.comments['comment-B']);
    await assert.rejects(()=>f.prove(),e=>e.code==='JOURNAL_PROOF');
    assert.equal(json(await f.a.snapshot()),json(cached),'failed proof silently refreshed cached state');
    assert.equal(json(await f.disk()),json(before),'proof itself changed durable bytes');
    const stale=cached.records[recordKey];
    await assert.rejects(()=>f.a.change({drawingId,before:stale,after:append(stale,'A'),eventId:'event-A'}),e=>e.code==='DELTA_STORE_STALE');
    const final=await f.disk();assert.deepEqual(Buffer.from(json(final)),beforeBytes);assert.equal(hash(final),hash(before));
    assert(final.state.records[recordKey].collab.comments['comment-B']);
    assert.deepEqual(final.state.outbox.map(x=>x.eventId),['event-seed','event-B']);
    assert.equal(json(await f.a.snapshot()),json(cached),'rejected stale save changed the replica cache');
  }finally{f.close();}
});
test('proof without the non-adopting API fails closed before any ordinary read',async()=>{
  const f=await fixture();let reads=0,snapshots=0;try{
    const before=await f.disk(),snapshot=f.a.snapshotWithStatus;
    f.a.snapshotWithStatus=(...args)=>{snapshots++;return snapshot(...args);};
    await assert.rejects(()=>f.prove({replicaStore:{read:async()=>{reads++;return f.sa.read();}}}),e=>e.code==='JOURNAL_PROOF');
    assert.equal(reads,0);assert.equal(snapshots,0);assert.equal(json(await f.disk()),json(before));
  }finally{f.close();}
});
test('ordinary read and explicit fresh replica reload retain both writers history',async()=>{
  const f=await fixture();try{
    const fromB=await f.otherWrite(),refreshed=await f.sa.read();assert.deepEqual(refreshed,fromB.state);
    f.a.close();const fresh=f.replica(f.sa),before=(await fresh.snapshot()).records[recordKey];
    await fresh.change({drawingId,before,after:append(before,'A'),eventId:'event-A'});
    const final=await f.disk();assert.equal(final.revision,3);
    assert(final.state.records[recordKey].collab.comments['comment-A']);assert(final.state.records[recordKey].collab.comments['comment-B']);
    assert.deepEqual(final.state.outbox.map(x=>x.eventId),['event-seed','event-B','event-A']);
    assert.equal(json(await fresh.snapshot()),json(final.state));
  }finally{f.close();}
});
test('failed verification read retains the old CAS boundary and other writer bytes',async()=>{
  const f=await fixture(),native=IDBObjectStore.prototype.get;try{
    const before=await f.otherWrite(),cached=await f.a.snapshot();
    IDBObjectStore.prototype.get=function(...args){if(this.transaction.db.name===f.databaseName)throw new DOMException('synthetic read fault','UnknownError');return native.apply(this,args);};
    try{await assert.rejects(()=>f.prove(),e=>e.name==='UnknownError');}finally{IDBObjectStore.prototype.get=native;}
    const stale=cached.records[recordKey];
    await assert.rejects(()=>f.a.change({drawingId,before:stale,after:append(stale,'A'),eventId:'event-A'}),e=>e.code==='DELTA_STORE_STALE');
    assert.equal(json(await f.disk()),json(before));assert.equal(json(await f.a.snapshot()),json(cached));
  }finally{IDBObjectStore.prototype.get=native;f.close();}
});
(async()=>{
  let passed=0,failed=0;
  for(const [name,fn]of tests){if(process.env.SENTLOG_PROOF_TEST&&!name.includes(process.env.SENTLOG_PROOF_TEST))continue;
    try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,'\n'+(error.stack||error));}}
  assert(passed+failed>0,'test filter must select at least one regression');
  console.log(JSON.stringify({suite:'delta replay non-adopting verification',passed,failed}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

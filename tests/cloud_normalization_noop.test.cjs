'use strict';
// Synthetic, disposable VM/IndexedDB only. Exercise the production normalizer,
// collaboration model and record writer together; never load account/network code.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const ROOT=path.resolve(process.env.SENTLOG_BUILT_ROOT||path.join(__dirname,'..'));
const SOURCE=path.resolve(process.env.SENTLOG_NORMALIZATION_SOURCE||
  path.join(ROOT,'sentlog/collaboration-sync-runtime.txt'));
const source=fs.readFileSync(SOURCE,'utf8');
const start=source.indexOf('function collaborationNormalizeRecord(');
const end=source.indexOf('function collaborationProjectSnapshot(',start);
assert(start>=0&&end>start,'The actual stored-normalization functions must be present');
const normalizer=source.slice(start,end);
const writerSource=fs.readFileSync(path.join(ROOT,'sentlog/record-store.js'),'utf8');
const C=require(path.join(ROOT,'sentlog/record-collaboration.js'));
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
const PREFIX='__sentlog_record__:',META='__sentlog_records_meta_v130__';
const LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const STORES=['files',LOG,CONTROL];
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const tasks=[];const test=(name,run)=>tasks.push({name,run});

function rawRecord(index=0){
  return {id:'synthetic-record-'+index,kind:'point',page:1,point:{x:10+index,y:20},
    type:'Synthetic observation',member:'Synthetic member',memo:'Synthetic original memo '+index,
    inspectionValue:1,optionalValue:null,readingOrder:[1,2],
    photos:[{id:'synthetic-photo-'+index,name:'Synthetic original.jpg',size:32,type:'image/jpeg'}]};
}
function stateFor(record){
  return {sourceType:'image',pageCount:1,currentPage:1,shapes:[record],collabDeletedRecords:[],
    localDisplay:{enabled:false,labels:['first','second'],nullable:null}};
}
function reverseObjectKeys(value){
  if(Array.isArray(value))return value.map(reverseObjectKeys);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).reverse()
    .map(([key,child])=>[key,reverseObjectKeys(child)]));
  return value;
}
async function stableValue(value){
  if(value===undefined)return {type:'undefined'};
  if(value instanceof Blob)return {type:'Blob',mime:value.type,size:value.size,sha256:hash(Buffer.from(await value.arrayBuffer()))};
  if(Array.isArray(value))return Promise.all(value.map(stableValue));
  if(value&&typeof value==='object'){
    const result={};for(const key of Object.keys(value).sort())result[key]=await stableValue(value[key]);return result;
  }
  return value;
}
async function snapshot(records,local){
  const db=await records.openFilesDatabase();let rows;
  try{rows=await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORES,'readonly'),result={};
    for(const name of STORES){const store=tx.objectStore(name);let keys;
      store.getAllKeys().onsuccess=e=>{keys=e.target.result;};
      store.getAll().onsuccess=e=>{result[name]=keys.map((key,i)=>[key,e.target.result[i]]);};}
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  return {stores:await stableValue(rows),local:[...local]};
}
async function fixture(states,{projectVersion=1,includeLocal=()=>true}={}){
  const indexedDB=new IDBFactory(),local=new Map([['synthetic-unrelated','preserve this setting']]);
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,
    getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,String(value)),removeItem:key=>local.delete(key)};
  const drawings=states.map((_,i)=>({id:'synthetic-drawing-'+i,name:'Synthetic drawing '+i}));
  const project={id:'synthetic-project',name:'Synthetic project',drawings,...(projectVersion===undefined?{}:{collaborationVersion:projectVersion})};
  const context={window:null,indexedDB,IDBKeyRange,localStorage,navigator:{},console,Blob,
    queueMicrotask,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,
    WORKSPACE_KEY:WS,DRAWING_KEY_PREFIX:DRAW,SentlogRecordCollaboration:C,
    archive:{includeLocal},collaborationManualProjects:new Map(),getSyncMeta:()=>null};
  context.window=context;vm.createContext(context);vm.runInContext(writerSource,context,{filename:'record-store.js'});
  const records=context.SentlogRecords;await records.init();
  records.batch([[WS,JSON.stringify({projects:[project]})],...states.map((state,i)=>[DRAW+drawings[i].id,JSON.stringify(state)])]);
  await records.settled();
  await records.writeFile('background:'+drawings[0].id,new Blob(['Synthetic existing original bytes'],{type:'image/png'}));
  await records.settled();
  const batches=[],notifications=[];const batch=records.batch;
  records.batch=(writes,options)=>{const entries=[...writes];batches.push({entries:clone(entries),options:clone(options)});return batch(entries,options);};
  context.SentlogCollaboration={afterStoredNormalization:(writes,before)=>notifications.push({writes:clone(writes),before:clone(before)})};
  vm.runInContext(normalizer,context,{filename:'production-stored-normalization.js'});
  return {context,records,local,project,drawings,batches,notifications,
    normalize:(ids=[project.id],guard={assertCurrent(){}})=>context.collaborationNormalizeStored(ids,guard),
    snapshot:()=>snapshot(records,local),read:(i=0)=>JSON.parse(records.getItem(DRAW+drawings[i].id))};
}
function observeMutations(){
  const counts={put:0,add:0,delete:0,clear:0},originals={};
  for(const method of Object.keys(counts)){
    originals[method]=IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method]=function(...args){
      if(this.transaction.db.name==='surveyFieldNoteDB')counts[method]++;
      return originals[method].apply(this,args);
    };
  }
  return {counts,restore(){for(const [method,original] of Object.entries(originals))IDBObjectStore.prototype[method]=original;}};
}
function assertSettled(records){
  assert.equal(records.ready,true);assert.equal(records.pending,false);assert.equal(records.failed,false);records.assertSafe();
}

test('92 order-only drawings remain byte-identical without a batch, history or native write',async()=>{
  const canonical=Array.from({length:92},(_,i)=>stateFor(C.upgrade(rawRecord(i))));
  const states=canonical.map(reverseObjectKeys);
  assert(states.every((state,i)=>isDeepStrictEqual(state,canonical[i])),'Fixture may only change object key order');
  assert(states.every((state,i)=>JSON.stringify(state)!==JSON.stringify(canonical[i])),'Each drawing must have a real text-order difference');
  const f=await fixture(states),before=await f.snapshot(),oldStrings=f.drawings.map(d=>f.records.getItem(DRAW+d.id));
  const observed=observeMutations();
  try{
    f.normalize();await f.records.settled();
    assert.equal(f.batches.flatMap(batch=>batch.entries.filter(([key])=>key.startsWith(DRAW))).length,0,
      'Order-only normalization must not enqueue any of the 92 drawing values');
    assert.equal(f.batches.length,0,'Order-only normalization must not enqueue the 92-drawing rewrite');
    assert.equal(f.notifications.length,0,'An unchanged editor must not receive a normalization callback');
    assert.deepEqual(observed.counts,{put:0,add:0,delete:0,clear:0});
    assert.deepEqual(await f.snapshot(),before,'Every store, Blob SHA and localStorage value must stay unchanged');
    assert.deepEqual(f.drawings.map(d=>f.records.getItem(DRAW+d.id)),oldStrings,'Keep original serialized records in the editor mirror');
    // Keeping the old key order must remain a no-op on the next sync round.
    f.normalize();await f.records.settled();
    assert.equal(f.batches.length,0);assert.equal(f.notifications.length,0);
    assert.deepEqual(observed.counts,{put:0,add:0,delete:0,clear:0});
    assert.deepEqual(await f.snapshot(),before);assertSettled(f.records);
  }finally{observed.restore();}
});

test('legacy records and the project collaboration version still migrate durably',async()=>{
  const original=rawRecord(),f=await fixture([stateFor(original)],{projectVersion:0});
  const before=await f.snapshot();f.normalize();await f.records.settled();
  assert.equal(f.batches.length,1);assert.equal(f.batches[0].entries.length,2);
  assert.equal(f.batches[0].options.origin,'device');assert.equal(f.notifications.length,1);
  const saved=f.read().shapes[0];assert(saved.collab);assert.equal(saved.memo,original.memo);assert.deepEqual(saved.photos,original.photos);
  assert.equal(JSON.parse(f.records.getItem(WS)).projects[0].collaborationVersion,1);
  assert.deepEqual((await f.snapshot()).local,before.local);assertSettled(f.records);
});

for(const [label,modify,verify] of [
  ['raw comment edit',r=>{r.memo='Synthetic newly typed memo';},r=>{
    assert(r.memo.includes('Synthetic newly typed memo'));assert(r.memo.includes('Synthetic original memo'));
    assert.equal(C.view(r).comments.length,2);
  }],
  ['number to string field edit',r=>{r.inspectionValue='1';},r=>{
    assert.equal(r.inspectionValue,'1');assert.equal(C.view(r).fields.inspectionValue.value,'1');
  }],
  ['null replacing a value',r=>{r.member=null;},r=>{
    assert.equal(r.member,null);assert.equal(C.view(r).fields.member.unset,false);assert.equal(C.view(r).fields.member.value,null);
  }],
  ['missing field replacing null',r=>{delete r.optionalValue;},r=>{
    assert.equal(Object.hasOwn(r,'optionalValue'),false);assert.equal(C.view(r).fields.optionalValue.unset,true);
  }],
  ['array order edit',r=>{r.readingOrder=[2,1];},r=>{
    assert.deepEqual(r.readingOrder,[2,1]);assert.deepEqual(C.view(r).fields.readingOrder.value,[2,1]);
  }],
  ['photo metadata edit with local cache fields',r=>{
    r.photos[0].name='Synthetic changed.jpg';r.photos[0].localBlob=true;r.photos[0].data='data:image/png;base64,U1lOVEhFVElD';
  },r=>{
    assert.equal(r.photos[0].name,'Synthetic changed.jpg');assert.equal(r.photos[0].localBlob,true);
    assert.equal(r.photos[0].data,'data:image/png;base64,U1lOVEhFVElD');
    assert.equal(r.collab.photos[r.photos[0].id].revisions.length,2);
  }]
])test(label+' is not mistaken for a key-order-only no-op',async()=>{
  const input=clone(C.upgrade(rawRecord()));modify(input);const f=await fixture([stateFor(input)]);
  const old=f.records.getItem(DRAW+f.drawings[0].id),before=await f.snapshot();
  f.normalize();await f.records.settled();
  assert.equal(f.batches.length,1);assert.equal(f.batches[0].entries.length,1);assert.equal(f.notifications.length,1);
  assert.equal(f.batches[0].options.origin,'device');assert.deepEqual(f.notifications[0].before,[[DRAW+f.drawings[0].id,old]]);
  assert.notEqual(f.records.getItem(DRAW+f.drawings[0].id),old);verify(f.read().shapes[0]);
  const after=await f.snapshot();assert.deepEqual(after.local,before.local);
  const stored=new Map(after.stores.files);assert.equal(stored.get(PREFIX+DRAW+f.drawings[0].id),f.records.getItem(DRAW+f.drawings[0].id));
  assert.deepEqual(stored.get('background:'+f.drawings[0].id),new Map(before.stores.files).get('background:'+f.drawings[0].id));
  assertSettled(f.records);
});

test('revision array order is still normalized and all immutable history is retained',async()=>{
  let record=C.upgrade(rawRecord());const heads=C.view(record).fields.member.headIds;
  record=C.setField(record,'member','Synthetic revised member',{expectedHeads:heads,actor:{deviceId:'synthetic-device',deviceName:'Synthetic'},at:10,revisionId:'synthetic-member-revision'});
  const expected=clone(record),entry=record.collab.fields.member;
  assert.equal(entry.revisions.length,2);entry.revisions.reverse();
  assert(!isDeepStrictEqual(record,expected));
  const f=await fixture([stateFor(record)]);f.normalize();await f.records.settled();
  assert.equal(f.batches.length,1);assert.equal(f.batches[0].entries.length,1);
  assert.deepEqual(f.read().shapes[0],expected);assertSettled(f.records);
});

test('unselected or archive-excluded projects do not normalize malformed records',async()=>{
  const malformed=stateFor({memo:'Synthetic invalid record without an ID'});
  for(const included of [true,false]){
    const f=await fixture([malformed],{includeLocal:()=>included}),before=await f.snapshot();
    // Isolate each guard: the other condition must permit normalization.
    f.normalize(included?['synthetic-other-project']:undefined);await f.records.settled();
    assert.equal(f.batches.length,0);assert.equal(f.notifications.length,0);assert.deepEqual(await f.snapshot(),before);
    assertSettled(f.records);
  }
});

test('invalid immutable history still rejects before any queued write',async()=>{
  const record=C.upgrade(rawRecord());record.collab.fields.member.revisions=[];
  const f=await fixture([stateFor(record)]),before=await f.snapshot();
  assert.throws(()=>f.normalize(),error=>error.code==='COLLAB_INVALID');
  assert.equal(f.batches.length,0);assert.equal(f.notifications.length,0);assert.deepEqual(await f.snapshot(),before);assertSettled(f.records);
});

test('a stale normalization context preserves the exact old data and error',async()=>{
  const raw=clone(C.upgrade(rawRecord()));raw.memo='Synthetic pending comment';
  const f=await fixture([stateFor(raw)]),before=await f.snapshot(),stale=Error('Synthetic stale account generation');
  assert.throws(()=>f.normalize(undefined,{assertCurrent(){throw stale;}}),error=>error===stale);
  assert.equal(f.batches.length,0);assert.equal(f.notifications.length,0);assert.deepEqual(await f.snapshot(),before);assertSettled(f.records);
});

test('a real normalization change retains rollback, pending state and explicit retry on commit failure',async()=>{
  const raw=clone(C.upgrade(rawRecord()));raw.memo='Synthetic pending comment';
  const f=await fixture([stateFor(raw)]),before=await f.snapshot(),native=IDBObjectStore.prototype.put;let injected=0;
  IDBObjectStore.prototype.put=function(...args){
    const request=native.apply(this,args);
    if(this.transaction.db.name==='surveyFieldNoteDB'&&this.name==='files'&&args[1]===META){
      injected++;request.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));
    }
    return request;
  };
  try{f.normalize();await assert.rejects(f.records.flush(),error=>error.name==='QuotaExceededError');}
  finally{IDBObjectStore.prototype.put=native;}
  assert.equal(injected,1);assert.deepEqual(await f.snapshot(),before,'The complete transaction must roll back');
  assert.equal(f.records.pending,true);assert.equal(f.records.failed,true);
  assert.equal(f.records.recordFailureDetails.phase,'commit');assert.equal(f.records.recordFailureDetails.recordsToWrite,1);
  assert(f.read().shapes[0].memo.includes('Synthetic pending comment'),'Unsaved normalized editor data must remain available');
  await f.records.retry();assertSettled(f.records);
  const stored=new Map((await f.snapshot()).stores.files);
  assert.equal(stored.get(PREFIX+DRAW+f.drawings[0].id),f.records.getItem(DRAW+f.drawings[0].id));
});

(async()=>{
  let passed=0;
  for(const {name,run} of tasks){try{await run();}catch(error){error.message=name+': '+error.message;throw error;}
    passed++;console.log('PASS '+name);}
  console.log('PASS cloud normalization no-op regression '+passed+' cases');
})().catch(error=>{console.error(error);process.exitCode=1;});

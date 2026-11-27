'use strict';
// Synthetic IndexedDB only: measure writes through the actual projection API.
// Set SENTLOG_PROJECTION_SOURCE to the prior writer to reproduce the regression.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const writer=fs.readFileSync(process.env.SENTLOG_PROJECTION_SOURCE||path.join(__dirname,'../sentlog/record-store.js'),'utf8');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',PREFIX='__sentlog_record__:';
const LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1',META='__sentlog_records_meta_v130__';
const scope={ownerId:'fixture-owner',projectId:'fixture-shared',deviceId:'fixture-device'},localProjectId='fixture-local';
const copy=structuredClone,json=JSON.stringify;
const metadata={layout:{version:1,settings:{zoom:2,rotation:0}},order:['drawing-1','drawing-2']};
function reverseKeys(value){return Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])])):value;}

async function fixture({staging=false}={}){
  const factory=new IDBFactory(),project={id:localProjectId,name:'Synthetic local',drawings:[{id:'drawing-1',name:'One'},{id:'drawing-2',name:'Two'}]};
  const other={id:'other-local',name:'Synthetic other',drawings:[{id:'other-drawing',name:'Other'}]};
  const state=id=>({shapes:[C.upgrade({id:'record-'+id,memo:'Synthetic record',photos:[]})],collabDeletedRecords:[],pageSettings:{1:{scale:100,unit:'mm'}},pageOrder:[1,2]});
  const local=new Map([[WS,json({projects:[project,other]})],...['drawing-1','drawing-2','other-drawing'].map(id=>[DRAW+id,json(state(id))])]);
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:key=>local.get(key)??null,
    setItem:(key,value)=>local.set(key,String(value)),removeItem:key=>local.delete(key)};
  const ctx={window:null,indexedDB:factory,IDBKeyRange,Blob,queueMicrotask,structuredClone,crypto:webcrypto,console,navigator:{},localStorage,SentlogDeltaSyncCore:D};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(writer,ctx);const records=ctx.SentlogRecords;await records.init();
  await records.writeFile('photo:drawing-1:photo-1',new Blob(['Synthetic original file bytes'],{type:'image/jpeg'}));
  const cutoff=await records.deltaJournal.begin({scope,localProjectId,actor:{deviceId:scope.deviceId,deviceName:'Synthetic'}});
  if(!staging)await records.deltaJournal.activate({scope,localProjectId,baselineId:'synthetic-baseline',baselineSnapshot:cutoff.snapshot,metadataRecords:metadata});
  async function disk(name='files'){
    const db=await records.openFilesDatabase();
    try{return await new Promise((resolve,reject)=>{const tx=db.transaction(name,'readonly'),s=tx.objectStore(name);let keys,values;
      s.getAllKeys().onsuccess=e=>{keys=e.target.result;};s.getAll().onsuccess=e=>{values=e.target.result;};
      tx.oncomplete=()=>resolve(new Map(keys.map((key,i)=>[key,values[i]])));tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  async function seed(name,key,value){const db=await records.openFilesDatabase();
    try{await new Promise((resolve,reject)=>{const tx=db.transaction(name,'readwrite');tx.objectStore(name).put(value,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
  function input(overrides={}){
    const writes=[WS,DRAW+'drawing-1',DRAW+'drawing-2'].map(key=>[key,records.getItem(key)]);
    return {scope,localProjectId,writes,expectedRecords:copy(writes),metadataRecords:copy(metadata),validate:()=>true,...overrides};
  }
  async function snapshot(){
    async function normal(value){
      if(value instanceof Blob)return {blob:true,type:value.type,bytes:[...new Uint8Array(await value.arrayBuffer())]};
      if(Array.isArray(value))return Promise.all(value.map(normal));
      if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.keys(value).sort().map(async key=>[key,await normal(value[key])])));
      return value;
    }
    return Promise.all(['files',LOG,CONTROL].map(async name=>[name,await normal([...(await disk(name))])])).then(json);
  }
  return {records,disk,seed,input,snapshot};
}
async function observe(fn,{failMeta=false}={}){
  const methods=['put','add','delete','clear'],originals=new Map(methods.map(method=>[method,IDBObjectStore.prototype[method]])),writes=[];
  for(const method of methods)IDBObjectStore.prototype[method]=function(...args){
    const key=method==='put'||method==='add'?args[1]:args[0];writes.push({store:this.name,method,key});
    if(failMeta&&this.name==='files'&&method==='put'&&key===META)throw Object.assign(Error('Synthetic quota failure'),{name:'QuotaExceededError'});
    return originals.get(method).apply(this,args);
  };
  try{return {result:await fn(),writes};}finally{for(const [method,original]of originals)IDBObjectStore.prototype[method]=original;}
}
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS',name);}
(async()=>{
await test('repeated identical projections perform zero mutations and preserve revision, records, file bytes and WAL',async()=>{
  const f=await fixture(),before=await f.snapshot(),initial=(await f.disk()).get(META).revision;
  const observed=await observe(async()=>{for(let i=0;i<5;i++){const result=await f.records.deltaJournal.applyProjection(f.input());assert.equal(result.applied,true);}});
  assert.deepEqual(observed.writes,[],'unchanged receive rewrote durable storage');
  assert.equal((await f.disk()).get(META).revision,initial);assert.equal(await f.snapshot(),before);
});
await test('duplicate projection keys returning A to B to A retain the last value without writes',async()=>{
  const f=await fixture(),before=await f.snapshot(),input=f.input(),key=DRAW+'drawing-1',original=f.records.getItem(key);
  const intermediate=JSON.parse(original);intermediate.pageSettings[1].scale=250;
  input.writes.push([key,json(intermediate)],[key,original]);
  const observed=await observe(()=>f.records.deltaJournal.applyProjection(input));
  assert.equal(observed.result.applied,true);assert.deepEqual(observed.writes,[]);
  assert.equal(f.records.getItem(key),original);assert.equal(await f.snapshot(),before);
});
await test('duplicate projection keys with a final real change write only that final value',async()=>{
  const f=await fixture(),input=f.input(),key=DRAW+'drawing-1',original=f.records.getItem(key),before=await f.disk();
  const intermediate=JSON.parse(original),last=JSON.parse(original);intermediate.pageSettings[1].scale=250;last.pageSettings[1].scale=400;
  input.writes.push([key,json(intermediate)],[key,json(last)]);
  const observed=await observe(()=>f.records.deltaJournal.applyProjection(input));
  assert.equal(observed.result.applied,true);
  assert.deepEqual(observed.writes,[{store:'files',method:'put',key:PREFIX+key},{store:'files',method:'put',key:META}]);
  const after=await f.disk();assert.equal(after.get(PREFIX+key),json(last));assert.equal(f.records.getItem(key),json(last));
  assert.equal(after.get(META).revision,before.get(META).revision+1);assert.equal((await f.disk(LOG)).size,0);
});
await test('legacy JSON key order and whitespace remain byte-for-byte unchanged without writes',async()=>{
  const f=await fixture(),before=await f.snapshot(),input=f.input();
  input.writes=input.writes.map(([key,text])=>[key,json(reverseKeys(JSON.parse(text)),null,2)]);
  input.metadataRecords=reverseKeys(input.metadataRecords);
  const observed=await observe(()=>f.records.deltaJournal.applyProjection(input));
  assert.equal(observed.result.applied,true);assert.deepEqual(observed.writes,[]);assert.equal(await f.snapshot(),before);
  for(const [key,text]of input.expectedRecords)assert.equal(f.records.getItem(key),text,'no-op changed the synchronous mirror');
});
await test('one real drawing change writes that drawing and its revision, retaining all other records and blobs',async()=>{
  const f=await fixture(),before=await f.disk(),control=await f.disk(CONTROL),input=f.input(),state=JSON.parse(input.writes[1][1]);
  state.pageSettings[1].scale=250;input.writes[1][1]=json(state);
  const observed=await observe(()=>f.records.deltaJournal.applyProjection(input));
  assert.equal(observed.result.applied,true);
  assert.deepEqual(observed.writes,[{store:'files',method:'put',key:PREFIX+DRAW+'drawing-1'},{store:'files',method:'put',key:META}]);
  const after=await f.disk();assert.equal(after.get(PREFIX+DRAW+'drawing-1'),json(state));assert.equal(f.records.getItem(DRAW+'drawing-1'),json(state));
  assert.equal(after.get(META).revision,before.get(META).revision+1);
  for(const key of [PREFIX+WS,PREFIX+DRAW+'drawing-2',PREFIX+DRAW+'other-drawing'])assert.equal(after.get(key),before.get(key));
  assert.equal(await after.get('photo:drawing-1:photo-1').text(),'Synthetic original file bytes');assert.deepEqual(await f.disk(CONTROL),control);assert.equal((await f.disk(LOG)).size,0);
});
await test('array order and explicit null are real record changes, while absent properties stay absent',async()=>{
  const f=await fixture(),input=f.input(),state=JSON.parse(input.writes[1][1]);state.pageOrder.reverse();state.optionalValue=null;input.writes[1][1]=json(state);
  const first=await observe(()=>f.records.deltaJournal.applyProjection(input));assert.equal(first.result.applied,true);assert.equal(first.writes.length,2);
  const saved=JSON.parse(f.records.getItem(DRAW+'drawing-1'));assert.deepEqual(saved.pageOrder,[2,1]);assert.equal(saved.optionalValue,null);
  const next=f.input();delete saved.optionalValue;next.writes[1][1]=json(saved);
  const second=await observe(()=>f.records.deltaJournal.applyProjection(next));assert.equal(second.writes.length,2);
  assert.equal(Object.hasOwn(JSON.parse(f.records.getItem(DRAW+'drawing-1')),'optionalValue'),false);
});
await test('metadata-only changes commit binding and revision without rewriting unchanged records',async()=>{
  const f=await fixture(),before=await f.disk(),input=f.input();input.metadataRecords.layout.settings.zoom=3;
  const observed=await observe(()=>f.records.deltaJournal.applyProjection(input));assert.equal(observed.result.applied,true);
  assert.deepEqual(observed.writes,[{store:'files',method:'put',key:META},{store:CONTROL,method:'put',key:'binding:'+localProjectId}]);
  const after=await f.disk();for(const [key,value]of input.expectedRecords)assert.equal(after.get(PREFIX+key),value);
  assert.equal(after.get(META).revision,before.get(META).revision+1);
  assert.deepEqual((await f.disk(CONTROL)).get('binding:'+localProjectId).metadataRecords,input.metadataRecords);
  const again=f.input({metadataRecords:reverseKeys(input.metadataRecords)}),second=await observe(()=>f.records.deltaJournal.applyProjection(again));
  assert.deepEqual(second.writes,[]);assert.equal(second.result.applied,true);
});
await test('metadata removal is retained as a real metadata-only update',async()=>{
  const f=await fixture(),observed=await observe(()=>f.records.deltaJournal.applyProjection(f.input({metadataRecords:{}})));
  assert.equal(observed.writes.length,2);assert.deepEqual((await f.disk(CONTROL)).get('binding:'+localProjectId).metadataRecords,{});
});
await test('stale expected bytes and a failed validation fence defer even identical data without mutations',async()=>{
  const f=await fixture(),before=await f.snapshot(),stale=f.input();stale.expectedRecords[1][1]+=' ';
  for(const input of [stale,f.input({validate:()=>false})]){
    const observed=await observe(()=>f.records.deltaJournal.applyProjection(input));assert.equal(observed.result.deferred,true);assert.deepEqual(observed.writes,[]);
  }
  let checks=0;const later=f.input({validate:()=>++checks===1}),observed=await observe(()=>f.records.deltaJournal.applyProjection(later));
  assert.equal(observed.result.deferred,true);assert.deepEqual(observed.writes,[]);assert.equal(await f.snapshot(),before);
});
await test('pending durable edits remain unreplayed and prevent a no-op projection from claiming success',async()=>{
  const f=await fixture(),state=JSON.parse(f.records.getItem(DRAW+'drawing-1'));state.shapes[0].memo='Synthetic unsent edit';
  f.records.setItem(DRAW+'drawing-1',json(state));await f.records.settled();const before=await f.snapshot();
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,1);
  const observed=await observe(()=>f.records.deltaJournal.applyProjection(f.input()));
  assert.equal(observed.result.deferred,true);assert.deepEqual(observed.writes,[]);assert.equal(await f.snapshot(),before);
});
await test('an outstanding claim alone still blocks an otherwise identical projection',async()=>{
  const f=await fixture();await f.seed(CONTROL,'claim:'+localProjectId,{version:1,kind:'claim',id:'synthetic-claim',localProjectId,scope:copy(scope),rowIds:[]});
  const before=await f.snapshot(),observed=await observe(()=>f.records.deltaJournal.applyProjection(f.input()));
  assert.equal(observed.result.deferred,true);assert.deepEqual(observed.writes,[]);assert.equal(await f.snapshot(),before);
});
await test('a durable revision change outside the current mirror blocks the no-op fast path',async()=>{
  const f=await fixture(),meta=(await f.disk()).get(META);await f.seed('files',META,{...meta,revision:meta.revision+1});
  const before=await f.snapshot(),observed=await observe(()=>f.records.deltaJournal.applyProjection(f.input()));
  assert.equal(observed.result.deferred,true);assert.deepEqual(observed.writes,[]);assert.equal(await f.snapshot(),before);
});
await test('staging bindings remain deferred and keep their full cutoff and journal',async()=>{
  const f=await fixture({staging:true}),before=await f.snapshot(),observed=await observe(()=>f.records.deltaJournal.applyProjection(f.input({metadataRecords:{}})));
  assert.equal(observed.result.deferred,true);assert.deepEqual(observed.writes,[]);assert.equal(await f.snapshot(),before);
});
await test('wrong owner, unowned no-op drawing and missing expected keys keep all scope guards',async()=>{
  const f=await fixture(),before=await f.snapshot(),foreign=f.input();foreign.writes.push([DRAW+'other-drawing',f.records.getItem(DRAW+'other-drawing')]);foreign.expectedRecords.push(foreign.writes.at(-1));
  const missing=f.input();missing.expectedRecords=missing.expectedRecords.filter(([key])=>key!==DRAW+'drawing-1');
  const workspace=f.input(),changed=JSON.parse(workspace.writes[0][1]);changed.projects[1].name='Unauthorized other project';workspace.writes[0][1]=json(changed);
  for(const [input,code]of [[f.input({scope:{...scope,ownerId:'different-owner'}}),'JOURNAL_SCOPE'],[foreign,'JOURNAL_SCOPE'],[missing,'JOURNAL_PROJECTION'],[workspace,'JOURNAL_SCOPE']]){
    const observed=await observe(async()=>{await assert.rejects(()=>f.records.deltaJournal.applyProjection(input),e=>e.code===code);});assert.deepEqual(observed.writes,[]);
  }
  assert.equal(await f.snapshot(),before);
});
await test('a failed changed projection rolls back its record, metadata and revision together',async()=>{
  const f=await fixture(),before=await f.snapshot(),input=f.input(),state=JSON.parse(input.writes[1][1]);state.pageSettings[1].scale=999;input.writes[1][1]=json(state);
  input.metadataRecords.layout.version=2;
  await assert.rejects(()=>observe(()=>f.records.deltaJournal.applyProjection(input),{failMeta:true}),/Synthetic quota failure/);
  assert.equal(await f.snapshot(),before);assert.equal(f.records.getItem(DRAW+'drawing-1'),input.expectedRecords[1][1]);
  const retry=await observe(()=>f.records.deltaJournal.applyProjection(input));assert.equal(retry.result.applied,true);assert.equal(retry.writes.length,3);
});
console.log(passed+' projection write-amplification tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

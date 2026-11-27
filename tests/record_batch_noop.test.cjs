'use strict';
// Disposable synthetic databases only. A no-op must be proved from the same
// transaction as its revision/ownership checks, never from a stale memory copy.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const ROOT=path.resolve(process.env.SENTLOG_STORAGE_SOURCE_ROOT||path.join(__dirname,'..'));
const code=fs.readFileSync(path.join(ROOT,'sentlog/record-store.js'),'utf8');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',PREFIX='__sentlog_record__:';
const META='__sentlog_records_meta_v130__',LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const scope={ownerId:'synthetic-owner',projectId:'synthetic-cloud',deviceId:'synthetic-device'};
const project={id:'synthetic-project',name:'Synthetic project',drawings:[{id:'one',name:'One'},{id:'two',name:'Two'}]};
const json=JSON.stringify,changed=memo=>json({shapes:[{id:'synthetic-record',memo,photos:[]}],collabDeletedRecords:[]});
async function fixture({factory=new IDBFactory(),local=new Map(),bound=true,padding=''}={}){
  if(!(await factory.databases()).length){
    local.set(WS,json({projects:[project],padding}));
    local.set(DRAW+'one',changed('original one'));local.set(DRAW+'two',changed('original two'));
  }
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,crypto:webcrypto};
  context.window=context;vm.createContext(context);vm.runInContext(code,context);const records=context.SentlogRecords;await records.init();
  async function bind(){
    await records.deltaJournal.begin({scope,localProjectId:project.id,actor:{deviceId:scope.deviceId,deviceName:'Synthetic'},serverRevision:1});
    await records.deltaJournal.activate({scope,localProjectId:project.id,baselineId:'synthetic-baseline'});
  }
  if(bound&&!records.deltaJournal.bindingFor(project.id))await bind();
  async function disk(){
    const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
      const stores=['files',LOG,CONTROL],tx=db.transaction(stores,'readonly'),result={};
      for(const name of stores){const s=tx.objectStore(name);let keys,values;
        s.getAllKeys().onsuccess=e=>keys=e.target.result;s.getAll().onsuccess=e=>{values=e.target.result;result[name]=new Map(keys.map((k,i)=>[k,values[i]]));};}
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  }
  return {records,factory,local,bind,disk};
}
async function observe(fn){
  const originals={},mutations=[];
  for(const method of ['put','add','delete','clear']){
    originals[method]=IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method]=function(...args){
      mutations.push({store:this.name,method,key:method==='delete'?args[0]:args[1]??null});
      return originals[method].apply(this,args);
    };
  }
  try{await fn(mutations);return mutations;}finally{for(const [method,original]of Object.entries(originals))IDBObjectStore.prototype[method]=original;}
}
function roundTrip(records,key,value=changed('temporary'),options){const original=records.getItem(key);records.setItem(key,value);if(original===null)records.removeItem(key,options);else records.setItem(key,original,options);}
const cases=[];function test(name,fn){cases.push([name,fn]);}
test('bound A to B to A has zero mutations and leaves all three stores unchanged',async()=>{
  const f=await fixture(),before=await f.disk();
  const mutations=await observe(async()=>{roundTrip(f.records,DRAW+'one');await f.records.settled();});
  assert.equal(mutations.length,0,'equal durable records must not rewrite the record, META or clock');
  assert.deepEqual(await f.disk(),before);assert.equal(f.records.pending,false);assert.equal(f.records.failed,false);
});
test('adding then removing an absent record does not issue a delete or advance a revision',async()=>{
  const f=await fixture({bound:false}),before=await f.disk();
  const mutations=await observe(async()=>{roundTrip(f.records,DRAW+'absent');await f.records.settled();});
  assert.equal(mutations.length,0);assert.deepEqual(await f.disk(),before);assert.equal(f.records.getItem(DRAW+'absent'),null);
});
test('removing then restoring an existing record does not rewrite it',async()=>{
  const f=await fixture(),before=await f.disk(),original=f.records.getItem(DRAW+'one');
  const mutations=await observe(async()=>{f.records.removeItem(DRAW+'one');f.records.setItem(DRAW+'one',original);await f.records.settled();});
  assert.equal(mutations.length,0);assert.deepEqual(await f.disk(),before);
});
test('mixed batches skip the unchanged large workspace while committing a real edit and its full replay intent',async()=>{
  const f=await fixture({padding:'synthetic 日本語 '.repeat(12000)}),before=await f.disk(),workspace=f.records.getItem(WS),value=changed('real edit');
  const mutations=await observe(async()=>{
    roundTrip(f.records,WS,json({...JSON.parse(workspace),padding:'temporary'}));
    f.records.setItem(DRAW+'one',value);await f.records.settled();
  });
  assert.equal(mutations.filter(x=>x.store==='files'&&x.key===PREFIX+WS).length,0,'unchanged workspace must not be rewritten');
  assert.equal(mutations.length,4,'exactly WAL, clock, changed record and META must be written');
  const after=await f.disk(),rows=[...after[LOG].values()];assert.equal(rows.length,1);
  assert.deepEqual(rows[0].changes,[{key:DRAW+'one',before:before.files.get(PREFIX+DRAW+'one'),after:value}]);
  assert.equal(rows[0].workspaceBefore,workspace);assert.equal(rows[0].workspaceAfter,workspace);
  assert.deepEqual(rows[0].projectIds,[project.id]);assert.deepEqual(rows[0].drawingIds,['one']);
  assert.equal(after.files.get(PREFIX+WS),workspace);assert.equal(after.files.get(PREFIX+DRAW+'one'),value);
  assert.equal(after.files.get(META).revision,before.files.get(META).revision+1);
});
test('a mixed deletion removes only an actually present record and preserves its before-image',async()=>{
  const f=await fixture(),before=await f.disk();
  const mutations=await observe(async()=>{roundTrip(f.records,DRAW+'absent');f.records.removeItem(DRAW+'two');await f.records.settled();});
  assert.deepEqual(mutations.filter(x=>x.method==='delete').map(x=>x.key),[PREFIX+DRAW+'two']);
  const after=await f.disk();assert.equal(after.files.has(PREFIX+DRAW+'two'),false);
  assert.deepEqual([...after[LOG].values()][0].changes,[{key:DRAW+'two',before:before.files.get(PREFIX+DRAW+'two'),after:null}]);
});
test('net-zero input still fails closed when another tab advanced META',async()=>{
  const f=await fixture(),other=await fixture({factory:f.factory,local:f.local});
  other.records.setItem(DRAW+'two',changed('other tab'));await other.records.settled();const before=await f.disk();
  const mutations=await observe(async()=>{roundTrip(f.records,DRAW+'one');await assert.rejects(()=>f.records.settled(),/別の画面で記録が変更/);});
  assert.equal(mutations.length,0);assert.deepEqual(await f.disk(),before);
  assert.equal(f.records.failed,true);assert.equal(f.records.pending,true);assert.throws(()=>f.records.assertSafe(),/別の画面で記録が変更/);
});
test('returning to old memory while the previous commit is in flight remains a real second change',async()=>{
  const f=await fixture(),before=await f.disk(),original=f.records.getItem(DRAW+'one'),value=changed('in flight');
  const native=IDBObjectStore.prototype.put;let injected=false;
  IDBObjectStore.prototype.put=function(...args){const request=native.apply(this,args);
    if(this.name==='files'&&args[1]===META&&!injected){injected=true;request.addEventListener('success',()=>f.records.setItem(DRAW+'one',original));}return request;};
  try{f.records.setItem(DRAW+'one',value);await f.records.settled();}finally{IDBObjectStore.prototype.put=native;}
  assert.equal(injected,true);const after=await f.disk(),rows=[...after[LOG].values()];assert.equal(rows.length,2);
  assert.equal(rows[0].changes[0].after,value);assert.equal(rows[1].changes[0].before,value);assert.equal(rows[1].changes[0].after,original);
  assert.equal(after.files.get(PREFIX+DRAW+'one'),original);assert.equal(f.records.getItem(DRAW+'one'),original);
  assert.equal(after.files.get(META).revision,before.files.get(META).revision+2);assert.equal(f.records.pending,false);
});
test('a queued round-trip is compared with the preceding completed commit, not its old durable cache',async()=>{
  const f=await fixture(),before=await f.disk(),value=changed('first commit'),native=IDBObjectStore.prototype.put;let injected=false;
  const mutations=await observe(async()=>{
    const counted=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){const request=counted.apply(this,args);
      if(this.name==='files'&&args[1]===META&&!injected){injected=true;request.addEventListener('success',()=>{
        f.records.setItem(DRAW+'one',changed('temporary pending'));f.records.setItem(DRAW+'one',value);
      });}return request;};
    try{f.records.setItem(DRAW+'one',value);await f.records.settled();}finally{IDBObjectStore.prototype.put=counted;}
  });
  assert.equal(IDBObjectStore.prototype.put,native);assert.equal(injected,true);assert.equal(mutations.length,4);
  const after=await f.disk();assert.equal(after[LOG].size,1);assert.equal(after.files.get(PREFIX+DRAW+'one'),value);
  assert.equal(after.files.get(META).revision,before.files.get(META).revision+1);assert.equal(f.records.pending,false);
});
test('a mixed batch quota failure rolls back every store and retries exactly the unsaved change',async()=>{
  const f=await fixture(),before=await f.disk(),value=changed('unsaved edit'),workspace=f.records.getItem(WS),native=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){if(this.name===LOG)throw new DOMException('synthetic quota','QuotaExceededError');return native.apply(this,args);};
  try{roundTrip(f.records,WS,json({...JSON.parse(workspace),padding:'temporary'}));f.records.setItem(DRAW+'one',value);
    await assert.rejects(()=>f.records.settled(),error=>error.name==='QuotaExceededError');}finally{IDBObjectStore.prototype.add=native;}
  assert.deepEqual(await f.disk(),before);assert.equal(f.records.getItem(DRAW+'one'),value);assert.equal(f.records.pending,true);assert.equal(f.records.failed,true);
  const mutations=await observe(()=>f.records.retry());assert.equal(mutations.length,4);
  const after=await f.disk();assert.equal(after[LOG].size,1);assert.equal(after.files.get(PREFIX+DRAW+'one'),value);
  assert.equal(after.files.get(META).revision,before.files.get(META).revision+1);assert.equal(f.records.failed,false);assert.equal(f.records.pending,false);
});
test('reverting a failed save can settle without writing while retaining its diagnostic history',async()=>{
  const f=await fixture(),before=await f.disk(),original=f.records.getItem(DRAW+'one'),native=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){if(this.name===LOG)throw new DOMException('synthetic quota','QuotaExceededError');return native.apply(this,args);};
  try{f.records.setItem(DRAW+'one',changed('failed edit'));await assert.rejects(()=>f.records.settled(),error=>error.name==='QuotaExceededError');}
  finally{IDBObjectStore.prototype.add=native;}
  f.records.setItem(DRAW+'one',original);assert.equal(f.records.failed,true);assert.equal(f.records.pending,true);
  const mutations=await observe(()=>f.records.retry());assert.equal(mutations.length,0);assert.deepEqual(await f.disk(),before);
  assert.equal(f.records.failed,false);assert.equal(f.records.pending,false);assert.equal(f.records.recordFailureDetails,null);
  const history=f.records.recordFailureHistory;assert.equal(history.firstRecordFailure.errorName,'QuotaExceededError');
  assert.equal(history.events.at(-1).kind,'record-save-completed');assert.equal(history.current.recordsFailed,false);
});
test('archive and restore contexts retain their binding lifecycle even when record values are unchanged',async()=>{
  const f=await fixture(),before=await f.disk();
  roundTrip(f.records,DRAW+'one',changed('temporary'),{operation:'archive-local',context:{localArchive:true,mode:'project',localProjectId:project.id}});
  await f.records.settled();const archived=await f.disk();
  assert.equal(f.records.deltaJournal.bindingFor(project.id).phase,'detached');
  assert.equal(archived[CONTROL].get('clock'),(Number(before[CONTROL].get('clock'))||0)+1);
  assert.equal(archived.files.get(META).revision,before.files.get(META).revision+1);
  roundTrip(f.records,DRAW+'one',changed('temporary'),{operation:'restore'});await f.records.settled();const restored=await f.disk();
  assert.equal(f.records.deltaJournal.bindingFor(project.id).phase,'active');
  assert.equal(restored[CONTROL].get('clock'),archived[CONTROL].get('clock')+1);
  assert.equal(restored.files.get(META).revision,archived.files.get(META).revision+1);
  for(const key of [WS,DRAW+'one',DRAW+'two'])assert.equal(restored.files.get(PREFIX+key),before.files.get(PREFIX+key));
});
test('a net-zero archive request cannot bypass the pending-journal guard',async()=>{
  const f=await fixture();f.records.setItem(DRAW+'one',changed('pending shared edit'));await f.records.settled();const before=await f.disk();
  const mutations=await observe(async()=>{
    roundTrip(f.records,DRAW+'two',changed('temporary'),{operation:'archive-local',context:{localArchive:true,mode:'project',localProjectId:project.id}});
    await assert.rejects(()=>f.records.settled(),error=>error.code==='JOURNAL_PENDING');
  });
  assert.equal(mutations.length,0);assert.deepEqual(await f.disk(),before);assert.equal(f.records.failed,true);assert.equal(f.records.pending,true);
});
test('mixed no-op values cannot hide a remote write after another tab binds the project',async()=>{
  const f=await fixture({bound:false}),other=await fixture({factory:f.factory,local:f.local,bound:false});await other.bind();const before=await f.disk();
  const workspace=f.records.getItem(WS),mutations=await observe(async()=>{
    roundTrip(f.records,WS,json({...JSON.parse(workspace),padding:'temporary'}));
    f.records.setItem(DRAW+'one',changed('legacy remote'),{origin:'remote'});
    await assert.rejects(()=>f.records.settled(),error=>error.code==='JOURNAL_REMOTE_WRITER');
  });
  assert.equal(mutations.length,0);assert.deepEqual(await f.disk(),before);assert.equal(f.records.failed,true);assert.equal(f.records.pending,true);
});
test('a no-op keeps same-page and reloaded revisions aligned for later real edits',async()=>{
  const f=await fixture(),before=await f.disk();roundTrip(f.records,DRAW+'one');await f.records.settled();
  const samePageValue=changed('after no-op');f.records.setItem(DRAW+'two',samePageValue);await f.records.settled();
  assert.equal((await f.disk()).files.get(META).revision,before.files.get(META).revision+1);
  const reopened=await fixture({factory:f.factory,local:f.local}),value=changed('after restart');reopened.records.setItem(DRAW+'one',value);await reopened.records.settled();
  const after=await reopened.disk();assert.equal(after.files.get(META).revision,before.files.get(META).revision+2);
  assert.equal(after.files.get(PREFIX+DRAW+'one'),value);assert.equal(after.files.get(PREFIX+DRAW+'two'),samePageValue);assert.equal(after[LOG].size,2);
});
(async()=>{let passed=0,failed=0;for(const [name,fn]of cases){try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack);}}
  console.log(json({passed,failed,total:cases.length,nativeBrowserExecuted:false,syntheticOnly:true}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

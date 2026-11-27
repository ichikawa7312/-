'use strict';
// Real record-store, isolated VMs and FakeIndexedDB only. A forced close here
// exercises the close event contract; it is not a native-browser quota test.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto');
const {IDBFactory,IDBKeyRange,IDBObjectStore,forceCloseDatabase}=require('fake-indexeddb');
const ROOT=path.resolve(process.env.SENTLOG_STORAGE_SOURCE_ROOT||path.join(__dirname,'..'));
const source=fs.readFileSync(path.join(ROOT,'sentlog/record-store.js'),'utf8');
const DB='surveyFieldNoteDB',WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:drawing';
const PREFIX='__sentlog_record__:',META='__sentlog_records_meta_v130__';
const JOURNAL='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1',STORES=['files',JOURNAL,CONTROL];
const FILE='photo:drawing:kept',scope={ownerId:'synthetic-owner',projectId:'synthetic-cloud',deviceId:'synthetic-device'};
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const point=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const cases=[];const test=(name,run)=>cases.push({name,run});
async function content(value){
  if(value===undefined)return {type:'undefined'};
  if(value instanceof Blob)return {type:'Blob',mime:value.type,bytes:value.size,sha256:hash(Buffer.from(await value.arrayBuffer()))};
  if(Array.isArray(value))return Promise.all(value.map(content));
  if(value&&typeof value==='object'){
    const result={};for(const key of Object.keys(value).sort())result[key]=await content(value[key]);return result;
  }
  return value;
}
async function fixture(){
  const factory=new IDBFactory(),nativeOpen=factory.open.bind(factory),handles=[],held=[];
  let holdKicks=false;
  const local=new Map([[WS,JSON.stringify({projects:[{id:'project',name:'Synthetic project',drawings:[{id:'drawing',name:'Synthetic drawing'}]}]})],
    [DRAW,JSON.stringify({shapes:[{id:'record',memo:'Synthetic durable memo',photos:[{id:'kept'}]}],collabDeletedRecords:[]})],
    ['synthetic-unrelated','Preserve synthetic local setting']]);
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,
    getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,String(value)),removeItem:key=>local.delete(key)};
  const probe={opens:0,transactions:0,deadHandleTransactions:0,mutations:0},dead=new Set();
  factory.open=(...args)=>{
    probe.opens++;const q=nativeOpen(...args);
    q.addEventListener('success',()=>{
      const db=q.result;handles.push(db);const transaction=db.transaction.bind(db);
      db.transaction=(...args)=>{probe.transactions++;if(dead.has(db))probe.deadHandleTransactions++;return transaction(...args);};
    });return q;
  };
  const ctx={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,structuredClone,crypto:webcrypto,
    setTimeout,clearTimeout,queueMicrotask:fn=>holdKicks?held.push(fn):queueMicrotask(fn)};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source,ctx,{filename:'record-store.js'});
  const records=ctx.SentlogRecords;await records.init();
  await records.writeFile(FILE,new Blob(['Synthetic original photo bytes'],{type:'image/jpeg'}));
  await records.deltaJournal.begin({scope,localProjectId:'project',actor:{deviceId:scope.deviceId,deviceName:'Synthetic'},serverRevision:1});
  await records.deltaJournal.activate({scope,localProjectId:'project',baselineId:'synthetic-baseline'});
  const state=JSON.parse(records.getItem(DRAW));state.shapes[0].memo='Synthetic durable second revision';
  records.setItem(DRAW,JSON.stringify(state));await records.settled();
  const connection=handles[0];assert(connection,'The real writer must own a database connection');
  const originals={};
  for(const method of ['put','add','delete','clear']){
    originals[method]=IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method]=function(...args){
      if(handles.includes(this.transaction.db))probe.mutations++;
      return originals[method].apply(this,args);
    };
  }
  async function snapshot(){
    // Observer handles bypass the writer's open probe, and never use its closed handle.
    const db=await new Promise((resolve,reject)=>{const q=nativeOpen(DB);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    let saved;
    try{saved=await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORES,'readonly'),stores={};
      for(const name of STORES){const store=tx.objectStore(name),entry={keyPath:store.keyPath,autoIncrement:store.autoIncrement,
        indexes:[...store.indexNames].map(name=>{const index=store.index(name);return {name,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};})};let keys;
        stores[name]=entry;store.getAllKeys().onsuccess=e=>{keys=e.target.result;};
        store.getAll().onsuccess=e=>{entry.rows=keys.map((key,i)=>[key,e.target.result[i]]);};}
      tx.oncomplete=()=>resolve({version:db.version,storeNames:[...db.objectStoreNames],stores});tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
    return {database:await content(saved),local:[...local]};
  }
  const resetProbe=()=>{for(const key of Object.keys(probe))probe[key]=0;};
  async function forceClose(){
    const closed=point();connection.addEventListener('close',closed.resolve,{once:true});dead.add(connection);
    forceCloseDatabase(connection);await closed.promise;
  }
  function draft(text='Synthetic unsaved memo'){
    const state=JSON.parse(records.getItem(DRAW));state.shapes[0].memo=text;const raw=JSON.stringify(state);records.setItem(DRAW,raw);return raw;
  }
  function hold(){holdKicks=true;}
  function release(){holdKicks=false;for(const fn of held.splice(0))queueMicrotask(fn);}
  function close(){
    for(const [method,original]of Object.entries(originals))IDBObjectStore.prototype[method]=original;
    release();for(const handle of handles)try{handle.close();}catch{}
  }
  return {factory,records,connection,probe,snapshot,resetProbe,forceClose,draft,hold,release,close};
}
async function use(run){const f=await fixture();try{return await run(f);}finally{f.close();}}
function closeError(records){let error;try{records.assertSafe();}catch(e){error=e;}
  assert.equal(error?.code,'RECORD_CONNECTION_CLOSED');assert.equal(records.failed,true);assert.equal(records.ready,true);
  assert.equal(records.issues.filter(([key])=>key==='records').length,1);
  assert.match(records.issues.find(([key])=>key==='records')[1],/接続/);return error;
}
function noFurtherIO(f){assert.deepEqual(f.probe,{opens:0,transactions:0,deadHandleTransactions:0,mutations:0});}
function abortNextPut(f,key,errorName='QuotaExceededError'){
  const old=IDBObjectStore.prototype.put;let count=0;
  IDBObjectStore.prototype.put=function(...args){const request=old.apply(this,args);
    if(this.transaction.db===f.connection&&this.name==='files'&&args[1]===key&&count++===0)
      request.addEventListener('success',()=>this.transaction._abort(errorName));
    return request;
  };
  return ()=>{IDBObjectStore.prototype.put=old;};
}

test('lifecycle capability can be checked without opening or initializing storage',async()=>{
  const context={window:null};context.window=context;
  for(const key of ['indexedDB','localStorage'])Object.defineProperty(context,key,{get(){throw Error('Capability probe touched storage');}});
  vm.runInNewContext(source,context);assert.equal(context.SentlogRecords.storageLifecycleVersion,1);
  assert.equal(context.SentlogRecords.ready,false);
});

test('an idle unexpected close raises one record warning and preserves all durable stores and Blobs',()=>use(async f=>{
  const before=await f.snapshot(),memory=Object.fromEntries(f.records.keys().map(key=>[key,f.records.getItem(key)])),events=[];
  assert(before.database.stores[JOURNAL].rows.length>0&&before.database.stores[CONTROL].rows.length>0,'Fixture must have real WAL and protected control data');
  f.records.subscribe(()=>events.push({failed:f.records.failed,ready:f.records.ready,pending:f.records.pending}));
  f.resetProbe();await f.forceClose();closeError(f.records);
  assert.equal(f.records.pending,false);assert(events.some(event=>event.failed&&event.ready));
  assert.deepEqual(Object.fromEntries(f.records.keys().map(key=>[key,f.records.getItem(key)])),memory);
  assert.equal(f.records.getFileWriteCapabilities().journaled,false);
  noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

test('a pending editor batch survives close and its queued automatic flush never touches a dead handle',()=>use(async f=>{
  const before=await f.snapshot();f.hold();const raw=f.draft();assert.equal(f.records.pending,true);
  f.resetProbe();await f.forceClose();const error=closeError(f.records);f.release();
  await assert.rejects(f.records.settled(),caught=>caught===error);
  assert.equal(f.records.pending,true);assert.equal(f.records.getItem(DRAW),raw);
  await assert.rejects(f.records.retry(),caught=>caught===error);
  noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

test('close blocks read, write, replay and explicit retry APIs without recreating a database or clearing the warning',()=>use(async f=>{
  const before=await f.snapshot();await f.forceClose();const error=closeError(f.records);f.resetProbe();
  for(const action of [()=>f.records.flush(),()=>f.records.settled(),()=>f.records.retry(),()=>f.records.openFilesDatabase(),
    ()=>f.records.readFileStates([FILE]),()=>f.records.stats(),()=>f.records.writeFile('photo:drawing:new',new Blob(['Synthetic incoming']),{validate:()=>true}),
    ()=>f.records.removeFiles([FILE]),()=>f.records.clearFiles(),()=>f.records.replaceAll([],[]),
    ()=>f.records.deltaJournal.begin({scope,localProjectId:'project',actor:{deviceId:scope.deviceId,deviceName:'Synthetic'}}),
    ()=>f.records.deltaJournal.claim({scope,localProjectId:'project'})])
    await assert.rejects(Promise.resolve().then(action),caught=>caught===error);
  f.records.recovered('records');assert.equal(closeError(f.records),error);
  assert.equal(f.records.uncommittedFiles().length,0,'Guarded incoming bytes retain the caller-owned retry policy');
  noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

test('close during a Blob comparison prevents the later write and retains the failed legacy file bytes',()=>use(async f=>{
  const before=await f.snapshot(),entered=point(),release=point(),incoming=new Blob(['Synthetic original photo bytes'],{type:'image/jpeg'});
  const slice=incoming.slice.bind(incoming);let first=true;
  incoming.slice=(...args)=>{const part=slice(...args);if(first){first=false;const read=part.arrayBuffer.bind(part);part.arrayBuffer=async()=>{entered.resolve();await release.promise;return read();};}return part;};
  const outcome=f.records.writeFile(FILE,incoming).then(value=>({value}),error=>({error}));
  let error;try{await entered.promise;f.resetProbe();await f.forceClose();error=closeError(f.records);}finally{release.resolve();}
  assert.equal((await outcome).error,error);assert.equal(f.records.pending,false);
  const pending=f.records.uncommittedFiles();assert.equal(pending.length,1);assert.equal(pending[0].key,FILE);assert.equal(pending[0].value,incoming);
  await assert.rejects(f.records.retry(),caught=>caught===error);
  assert.equal(f.records.uncommittedFiles()[0].value,incoming);
  noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

test('a previously failed file and its warning survive an unexpected close and blocked retry',()=>use(async f=>{
  const before=await f.snapshot(),incoming=new Blob(['Synthetic changed photo'],{type:'image/jpeg'}),restore=abortNextPut(f,FILE);
  try{await assert.rejects(f.records.writeFile(FILE,incoming),error=>error.name==='QuotaExceededError');}finally{restore();}
  assert.equal(f.records.uncommittedFiles()[0].value,incoming);assert.deepEqual(await f.snapshot(),before);
  f.resetProbe();await f.forceClose();const error=closeError(f.records);
  await assert.rejects(f.records.retry(),caught=>caught===error);
  assert.equal(f.records.uncommittedFiles()[0].value,incoming);assert(f.records.issues.some(([key])=>key==='file:'+FILE));
  noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

test('an ordinary commit quota failure still rolls back and can be explicitly retried while its connection is alive',()=>use(async f=>{
  const before=await f.snapshot();f.hold();const raw=f.draft(),restore=abortNextPut(f,META);
  try{await assert.rejects(f.records.flush(),error=>error.name==='QuotaExceededError');}finally{restore();f.release();}
  assert.equal(f.records.pending,true);assert.equal(f.records.failed,true);assert.equal(f.records.recordFailureDetails.phase,'commit');
  assert.deepEqual(await f.snapshot(),before);
  await f.records.retry();assert.equal(f.records.failed,false);assert.equal(f.records.pending,false);f.records.assertSafe();
  const after=await f.snapshot();assert.equal(new Map(after.database.stores.files.rows).get(PREFIX+DRAW),raw);
  assert(after.database.stores[JOURNAL].rows.length>before.database.stores[JOURNAL].rows.length);
  assert.deepEqual(new Map(after.database.stores.files.rows).get(FILE),new Map(before.database.stores.files.rows).get(FILE));
}));

test('close after a quota failure keeps its unsaved draft but reports the current connection failure',()=>use(async f=>{
  const before=await f.snapshot();f.hold();const raw=f.draft(),restore=abortNextPut(f,META);
  try{await assert.rejects(f.records.flush(),error=>error.name==='QuotaExceededError');}finally{restore();}
  assert.equal(f.records.recordFailureDetails.errorName,'QuotaExceededError');
  f.resetProbe();await f.forceClose();const error=closeError(f.records);f.release();
  assert.equal(f.records.recordFailureDetails,null,'A past quota detail must not be labelled as the current close failure');
  assert.equal(f.records.getItem(DRAW),raw);assert.equal(f.records.pending,true);
  await assert.rejects(f.records.retry(),caught=>caught===error);
  noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

test('a close event before an in-flight abort rejection keeps the close warning and the original rejected error',()=>use(async f=>{
  const before=await f.snapshot();f.hold();const raw=f.draft(),put=IDBObjectStore.prototype.put;let closed,abortedError,triggered=0;
  IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);
    if(this.transaction.db===f.connection&&this.name==='files'&&args[1]===META&&triggered++===0){
      request.addEventListener('success',()=>{
        // The abort is synthetic. FakeIndexedDB dispatches the real close event
        // once this transaction is finished, before flush handles its rejection.
        this.transaction._abort('AbortError');abortedError=this.transaction.error;f.resetProbe();closed=f.forceClose();
      });
    }
    return request;
  };
  try{await assert.rejects(f.records.flush(),error=>error.name==='AbortError'&&error===abortedError);}
  finally{IDBObjectStore.prototype.put=put;f.release();}
  assert(closed,'The test must close the actual writer after queuing its mutations');await closed;
  const error=closeError(f.records);assert.equal(f.records.recordFailureDetails,null);
  const history=clone(f.records.recordFailureHistory);
  assert.deepEqual(history.events.map(event=>event.kind),['database-unexpected-close','record-save-failed']);
  assert.equal(history.latestRecordFailure.errorName,'AbortError');assert.equal(history.firstRecordFailure.sequence,2);
  assert.equal(f.records.pending,true);assert.equal(f.records.getItem(DRAW),raw);
  await assert.rejects(f.records.retry(),caught=>caught===error);
  noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

test('closing a separate read-only handle does not invalidate the writer or block an ordinary save',()=>use(async f=>{
  const readHandle=await f.records.openFilesDatabase();readHandle.close();
  assert.equal(f.records.failed,false);const raw=f.draft();await f.records.settled();
  f.records.assertSafe();assert.equal(new Map((await f.snapshot()).database.stores.files.rows).get(PREFIX+DRAW),raw);
}));

test('the existing versionchange warning still preserves a pending draft without becoming an unexpected-close report',()=>use(async f=>{
  const before=await f.snapshot();f.hold();const raw=f.draft();f.resetProbe();
  f.connection.onversionchange();f.release();
  await assert.rejects(f.records.flush(),error=>error.code!=='RECORD_CONNECTION_CLOSED'&&/別の画面/.test(error.message));
  assert.equal(f.records.ready,true);assert.equal(f.records.failed,true);assert.equal(f.records.pending,true);
  assert.equal(f.records.getItem(DRAW),raw);noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

test('quota then close retains the original safe failure history without changing the current failure or doing IO',()=>use(async f=>{
  const before=await f.snapshot();
  f.hold();const raw=f.draft('Synthetic secret memo /private/path'),restore=abortNextPut(f,META);let original;
  try{await assert.rejects(f.records.flush(),error=>{original=error;return error.name==='QuotaExceededError';});}finally{restore();}
  assert.throws(()=>f.records.assertSafe(),error=>error===original);
  const originalDetail=clone(f.records.recordFailureDetails);
  f.resetProbe();await f.forceClose();const error=closeError(f.records);f.release();
  assert.equal(f.records.recordFailureDetails,null,'The historical cause must not replace the current close diagnosis');
  const history=clone(f.records.recordFailureHistory),quota=history.latestRecordFailure;
  assert.deepEqual(quota.detail,originalDetail);
  assert.equal(quota.kind,'record-save-failed');assert.equal(quota.detail.errorName,'QuotaExceededError');assert.equal(quota.detail.phase,'commit');
  assert.equal(quota.nativeMessageClass,'empty','FakeIndexedDB provides no quota message for this native-style abort');assert.equal(quota.sequence,1);assert(Number.isFinite(Date.parse(quota.observedAt)));
  assert.deepEqual(history.events.map(event=>event.kind),['record-save-failed','database-unexpected-close']);
  assert.deepEqual(history.events.map(event=>event.sequence),[1,2]);
  assert.deepEqual(history.firstRecordFailure,quota);assert.deepEqual(history.latestRecordFailure,quota);
  assert.deepEqual(history.current,{connection:'unexpected-close',recordsFailed:true});
  assert.equal(history.events[1].reason,'not-reported');assert.equal(f.records.recordFailureDetails,null);
  assert.equal(f.records.getItem(DRAW),raw);assert.equal(f.records.pending,true);
  await assert.rejects(f.records.retry(),caught=>caught===error);
  for(const secret of ['/private/path','Synthetic secret','synthetic-owner',FILE,DRAW])assert(!JSON.stringify(history).includes(secret));
  const changed=f.records.recordFailureHistory;changed.firstRecordFailure.detail.errorName='changed';changed.latestRecordFailure.detail.phase='changed';changed.events[0].detail.store='changed';changed.current.connection='changed';
  assert.deepEqual(clone(f.records.recordFailureHistory),history,'Every nested exported snapshot must be isolated from the writer');
  noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
}));

for(const [name,newVersion,change]of [['delete request',null,'delete-request'],['upgrade request',3,'upgrade-request'],['untyped event',undefined,'unknown']]){
  test('quota then '+name+' is recorded distinctly without asserting deletion completed',()=>use(async f=>{
    const before=await f.snapshot();f.hold();const raw=f.draft(),restore=abortNextPut(f,META);
    try{await assert.rejects(f.records.flush(),error=>error.name==='QuotaExceededError');}finally{restore();}
    f.resetProbe();f.connection.onversionchange(newVersion===undefined?undefined:{oldVersion:2,newVersion});
    f.connection.onclose();f.release();
    await assert.rejects(f.records.flush(),error=>error.code!=='RECORD_CONNECTION_CLOSED'&&/別の画面/.test(error.message));
    const history=clone(f.records.recordFailureHistory),event=history.events[1];
    assert.deepEqual(history.events.map(value=>value.kind),['record-save-failed','database-versionchange']);
    assert.equal(event.change,change);assert.equal(event.oldVersion,newVersion===undefined?null:2);assert.equal(event.newVersion,newVersion??null);
    assert.equal(history.latestRecordFailure.detail.errorName,'QuotaExceededError');assert.equal(history.firstRecordFailure.sequence,1);
    assert.deepEqual(history.current,{connection:'not-open',recordsFailed:true});assert.equal(f.records.recordFailureDetails,null);
    assert.equal(f.records.getItem(DRAW),raw);assert.equal(f.records.pending,true);
    noFurtherIO(f);assert.deepEqual(await f.snapshot(),before);
  }));
}

test('history keeps its first and latest failures while bounded events show successful explicit retries',()=>use(async f=>{
  for(let i=0;i<10;i++){
    f.hold();f.draft('Synthetic revision '+i);const restore=abortNextPut(f,META);
    try{await assert.rejects(f.records.flush(),error=>error.name==='QuotaExceededError');}finally{restore();f.release();}
    await f.records.retry();f.records.assertSafe();
  }
  f.resetProbe();const history=clone(f.records.recordFailureHistory);
  assert.equal(history.capacity,16);assert.equal(history.events.length,16);assert.equal(history.droppedEvents,4);
  assert.equal(history.firstRecordFailure.sequence,1);assert.equal(history.latestRecordFailure.sequence,19);
  assert.deepEqual(history.events.map(event=>event.sequence),Array.from({length:16},(_,i)=>i+5));
  assert.equal(history.events.at(-1).kind,'record-save-completed');assert.equal(history.events.at(-1).afterFailureSequence,19);
  assert.deepEqual(history.current,{connection:'open',recordsFailed:false});assert.equal(f.records.recordFailureDetails,null);
  assert.equal(f.records.pending,false);noFurtherIO(f);
}));

test('native messages are classified into constants and never export arbitrary text, paths or names',()=>use(async f=>{
  let revision=0;
  for(const [name,message,expectedName,expectedClass]of [
    ['QuotaExceededError','QuotaExceededError','QuotaExceededError','quota-mentioned'],
    ['UnknownError','IO error: /private/synthetic-user/database','UnknownError','io-mentioned'],
    ['UnknownError','No space left on device: /private/synthetic-user/database','UnknownError','disk-space-mentioned'],
    ['InvalidStateError','The database connection is closing. /private/synthetic-user/database','InvalidStateError','connection-closed-mentioned'],
    ['UnknownError','private-synthetic-account unknown failure','UnknownError','unclassified'],
    ['private-synthetic-error-name','private-synthetic-message','Error','unclassified'],
    ['UnknownError','private-synthetic-message'.repeat(100),'UnknownError','unavailable']
  ]){
    const original=new Error(message);original.name=name;const put=IDBObjectStore.prototype.put;let injected=false;
    IDBObjectStore.prototype.put=function(...args){if(this.transaction.db===f.connection&&this.name==='files'&&args[1]===PREFIX+DRAW&&!injected){injected=true;throw original;}return put.apply(this,args);};
    f.hold();f.draft('Synthetic revision '+(++revision));
    try{await assert.rejects(f.records.flush(),error=>error===original);}finally{IDBObjectStore.prototype.put=put;f.release();}
    assert.throws(()=>f.records.assertSafe(),error=>error===original);
    const history=clone(f.records.recordFailureHistory),event=history.latestRecordFailure;
    assert.equal(event.detail.errorName,expectedName);assert.equal(event.nativeMessageClass,expectedClass);
    assert(!JSON.stringify(history).includes('private-synthetic'));assert(!JSON.stringify(history).includes('/private/'));
    await f.records.retry();
  }
}));

(async()=>{
  let passed=0,failed=0;
  for(const {name,run}of cases){try{await run();passed++;console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+' ['+(error?.code||error?.name||'Error')+'] '+String(error?.message||'').slice(0,500));}}
  console.log('Record connection lifecycle: '+passed+' passed, '+failed+' failed; FakeIndexedDB only');
  if(failed)process.exitCode=1;
})().catch(error=>{console.error(error?.name||'Error');process.exitCode=1;});

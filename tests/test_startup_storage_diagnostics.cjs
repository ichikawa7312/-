'use strict';
// All databases below are disposable fake IndexedDB instances. The production
// scanner is watched at the API boundary; the test's before/after snapshots use
// unrestricted reads only outside that boundary.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {IDBFactory,IDBDatabase,IDBObjectStore}=require('fake-indexeddb');
const D=require('../sentlog/startup-storage-diagnostics.js');
const SOURCE=fs.readFileSync(path.join(__dirname,'../sentlog/startup-storage-diagnostics.js'),'utf8');
const META='__sentlog_records_meta_v130__',WS='__sentlog_record__:surveyFieldNoteWorkspaceV1';
const ARCHIVE='__sentlog_records_archive_v130__',MARKER='sentlogRecordsReadyV130';
// Deliberately independent of the implementation's allowlist.
const SPECS=[
  ['surveyFieldNoteDB','records',['files','sentlog_delta_journal_v1','sentlog_delta_control_v1']],
  ['sentlog-original-photos-v1','originals',['photos','meta']],
  ['sentlog-delta-migration-v1','migration',['sessions','items']],
  ['sentlog-delta-assets-v1','assets',['assets']],
  ['sentlog-delta-v1','replicas',['replicas']],
  ['sentlogSyncTrafficV1','receipts',['acks']],
  ['sentlog-pc-sync','pc',['kv']]
];
const SECRET='PRIVATE_SYNTHETIC_CASE_居場所_01234567';
const PRIVATE_DB='private-unrelated-app-'+SECRET,PRIVATE_STORE='private-store-'+SECRET;
const RAW_OPEN=IDBFactory.prototype.open,RAW_DELETE=IDBFactory.prototype.deleteDatabase;
const RAW_COUNT=IDBObjectStore.prototype.count;
const cases=[];function test(name,run){cases.push({name,run});}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,message,ms=1000){const end=Date.now()+ms;while(!test()){if(Date.now()>end)throw Error(message);await pause(5);}}
function opened(factory,name,version){
  return new Promise((resolve,reject)=>{const q=version===undefined?RAW_OPEN.call(factory,name):RAW_OPEN.call(factory,name,version);
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });
}
async function seed(factory,name,stores,version=1){
  const db=await new Promise((resolve,reject)=>{const q=RAW_OPEN.call(factory,name,version);
    q.onupgradeneeded=()=>{for(const store of Object.keys(stores))q.result.createObjectStore(store);};
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{if(Object.keys(stores).length)await new Promise((resolve,reject)=>{
    const tx=db.transaction(Object.keys(stores),'readwrite');
    for(const [name,rows]of Object.entries(stores))for(const [key,value]of rows)tx.objectStore(name).put(value,key);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
async function remove(factory,name){
  await new Promise((resolve,reject)=>{const q=RAW_DELETE.call(factory,name);q.onsuccess=resolve;q.onerror=()=>reject(q.error);});
}
async function normalize(value){
  if(value instanceof Blob)return {blob:true,type:value.type,size:value.size,sha256:createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex')};
  if(Array.isArray(value))return Promise.all(value.map(normalize));
  if(value&&typeof value==='object'){const out={};for(const key of Object.keys(value).sort())out[key]=await normalize(value[key]);return out;}
  return value;
}
async function snapshot(factory){
  const result=[];
  for(const entry of (await factory.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
    const db=await opened(factory,entry.name),row={name:db.name,version:db.version,stores:[]};
    try{for(const name of Array.from(db.objectStoreNames)){
      const data=await new Promise((resolve,reject)=>{const tx=db.transaction(name,'readonly'),store=tx.objectStore(name);
        let keys,values;store.getAllKeys().onsuccess=e=>keys=e.target.result;store.getAll().onsuccess=e=>values=e.target.result;
        tx.oncomplete=()=>resolve({name,keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes:Array.from(store.indexNames),keys,values});
        tx.onabort=()=>reject(tx.error);
      });row.stores.push(await normalize(data));
    }}finally{db.close();}result.push(row);
  }return result;
}
async function recordsFactory(stores){
  const factory=new IDBFactory();
  await seed(factory,SPECS[0][0],stores||{
    files:[[META,{schema:1,revision:37,note:SECRET}],[WS,JSON.stringify({projects:[{id:SECRET,name:SECRET}]})],
      [ARCHIVE,{entries:[[SECRET,SECRET]]}],['photo:'+SECRET,new Blob([SECRET],{type:'image/png'})]],
    sentlog_delta_journal_v1:[[1,{kind:'sentlog-app-intent',privateMemo:SECRET}]],
    sentlog_delta_control_v1:[['binding:'+SECRET,{ownerId:SECRET,projectId:SECRET}]]
  },2);return factory;
}
function row(result,kind='records'){return result.indexedDB.databases.find(value=>value.kind===kind);}
function privacy(value){
  const text=JSON.stringify(value);
  for(const token of [SECRET,PRIVATE_DB,PRIVATE_STORE,...SPECS.map(spec=>spec[0]),META,WS,ARCHIVE])
    assert(!text.includes(token),'report/progress disclosed '+token);
}
function unknownPresence(result){
  assert.deepEqual(row(result).presence,{status:'unconfirmed',meta:null,workspace:null,legacyArchive:null});
}
// Forbidden operations are recorded as well as thrown: swallowing a spy error
// must not turn an unsafe attempt into a passing test.
async function guarded(factory,options={},hooks={}){
  const audit={violations:[],opens:[],counts:[],transactions:[],connections:[],progress:[],markerReads:[],enumerations:0};
  const restore=[];let enumerated=false;
  const forbidden=label=>{audit.violations.push(label);throw Error('Forbidden diagnostic operation: '+label);};
  function patch(object,key,value){const descriptor=Object.getOwnPropertyDescriptor(object,key);
    Object.defineProperty(object,key,{configurable:true,writable:true,value});
    restore.push(()=>descriptor?Object.defineProperty(object,key,descriptor):delete object[key]);
  }
  const proxy={
    async databases(){audit.enumerations++;const value=hooks.enumerate?await hooks.enumerate(factory):await factory.databases();enumerated=true;return value;},
    open(name,...args){
      if(!enumerated)forbidden('open before completed databases()');
      if(!SPECS.some(spec=>spec[0]===name))forbidden('open non-allowlisted database');
      if(args.some(value=>value!==undefined))forbidden('open with a version');
      audit.opens.push(name);
      const q=hooks.open?hooks.open(factory,name):RAW_OPEN.call(factory,name);
      q.addEventListener?.('success',()=>{
        const db=q.result,connection={name,closed:false};audit.connections.push(connection);
        const close=db.close.bind(db);db.close=()=>{connection.closed=true;return close();};
      });
      return q;
    },
    deleteDatabase(){return forbidden('deleteDatabase');}
  };
  const localStorage={
    getItem(key){audit.markerReads.push(key);if(key!==MARKER)return forbidden('localStorage private getItem');return SECRET;},
    get length(){return forbidden('localStorage length');},key(){return forbidden('localStorage key');},
    setItem(){return forbidden('localStorage setItem');},removeItem(){return forbidden('localStorage removeItem');},
    clear(){return forbidden('localStorage clear');}
  };
  const storageManager={
    async estimate(){return {usage:1234,quota:5678,get usageDetails(){return forbidden('estimate usageDetails');}};},
    async persisted(){return true;},persist(){return forbidden('persist permission request');},
    getDirectory(){return forbidden('OPFS access');}
  };
  const caches={
    async keys(){return ['sentlog-pwa-v246','private-cache-'+SECRET,'sentlog-pwa-v7','sentlog-pwa-v246-'+SECRET];},
    open(){return forbidden('cache open');},match(){return forbidden('cache match');},delete(){return forbidden('cache delete');}
  };
  const oldTransaction=IDBDatabase.prototype.transaction;
  patch(IDBDatabase.prototype,'transaction',function(names,mode,...args){
    audit.transactions.push({names:Array.from(typeof names==='string'?[names]:names),mode});
    // fake-indexeddb itself enters through this method to construct the
    // unavoidable upgrade transaction of a disappeared database. The scanner
    // must abort it; schema/data methods and explicit open versions remain
    // forbidden, and the race tests require that no new database survives.
    if(mode!=='readonly'&&mode!=='versionchange')return forbidden('non-readonly transaction');
    return oldTransaction.call(this,names,mode,...args);
  });
  for(const method of ['put','add','delete','clear','get','getKey','getAll','getAllKeys','openCursor','openKeyCursor','index','createIndex','deleteIndex'])
    patch(IDBObjectStore.prototype,method,()=>forbidden('objectStore '+method));
  for(const method of ['createObjectStore','deleteObjectStore'])
    patch(IDBDatabase.prototype,method,()=>forbidden('database '+method));
  for(const method of ['arrayBuffer','text','stream'])
    patch(Blob.prototype,method,()=>forbidden('Blob '+method));
  patch(IDBObjectStore.prototype,'count',function(...args){
    const entry={database:this.transaction.db.name,store:this.name,args};audit.counts.push(entry);
    if(args.length&&!(this.transaction.db.name==='surveyFieldNoteDB'&&this.name==='files'&&args.length===1&&[META,WS,ARCHIVE].includes(args[0])))
      return forbidden('count non-fixed key/range');
    return hooks.count?hooks.count.call(this,args,RAW_COUNT):RAW_COUNT.apply(this,args);
  });
  let result;
  try{result=await D.scan({indexedDB:proxy,localStorage,storageManager,caches,requestTimeoutMs:80,maxDurationMs:1500,...options,
    onProgress(value){audit.progress.push(structuredClone(value));options.onProgress?.(value);}
  });}finally{for(const undo of restore.reverse())undo();}
  assert.deepEqual(audit.violations,[],'scanner attempted a forbidden operation even if it handled the error');
  privacy(result);for(const value of audit.progress)privacy(value);
  assert(result.finishedAt&&Number.isFinite(Date.parse(result.finishedAt)));
  return {result,audit};
}
function assertClosed(audit){assert(audit.connections.every(value=>value.closed),'all diagnostic connections must be closed');}

test('CommonJS and browser exports load without probing storage or requiring the main app',()=>{
  assert.equal(D.version,1);assert.equal(typeof D.scan,'function');assert.equal(typeof D.mount,'function');
  const context={document:null,module:undefined,console};let touched=0;
  for(const name of ['indexedDB','localStorage','caches','navigator'])Object.defineProperty(context,name,{get(){touched++;throw Error(SECRET);}});
  vm.createContext(context);vm.runInContext(SOURCE,context);
  assert.equal(context.SentlogStartupStorageDiagnostics.version,1);assert.equal(typeof context.SentlogStartupStorageDiagnostics.scan,'function');
  assert.equal(touched,0,'loading the standalone module must not start a scan');
});

test('seven exact databases and unknown stores are counted without data reads, writes, names or Blob access',async()=>{
  const factory=await recordsFactory();
  for(const [name,kind,stores]of SPECS.slice(1))await seed(factory,name,Object.fromEntries(stores.map((store,index)=>[store,[[SECRET+index,{kind,note:SECRET,blob:new Blob([SECRET])}]]])));
  // Private names must neither expand the allowlist nor appear in the report.
  await seed(factory,PRIVATE_DB,{[PRIVATE_STORE]:[[SECRET,SECRET]]});
  await seed(factory,'surveyFieldNoteDB-'+SECRET,{files:[[SECRET,SECRET]]});
  const before=await snapshot(factory),{result,audit}=await guarded(factory);
  assert.equal(result.status,'complete');assert.equal(result.readOnly,true);assert.equal(result.format,'sentlog-startup-storage-diagnostics');
  assert.equal(result.indexedDB.listedSentlogDatabaseCount,7);assert.equal(result.indexedDB.excludedDatabaseCount,2);
  assert.deepEqual(audit.opens,SPECS.map(spec=>spec[0]));assert.equal(audit.enumerations,1);
  assert.deepEqual(audit.markerReads,[MARKER]);assert.deepEqual(result.marker,{status:'complete',present:true});
  assert.deepEqual(result.estimate,{status:'complete',usageBytes:1234,quotaBytes:5678});
  assert.deepEqual(result.persisted,{status:'complete',persisted:true});assert.deepEqual(result.cache,{status:'complete',count:2,generations:[7,246]});
  assert.deepEqual(row(result).presence,{status:'complete',meta:true,workspace:true,legacyArchive:true});
  for(const [,kind,stores]of SPECS){const database=row(result,kind);assert.equal(database.status,'complete');
    assert.deepEqual(database.stores.map(store=>store.name).sort(),[...stores].sort());
    for(const store of database.stores)assert.equal(store.count,kind==='records'&&store.name==='files'?4:1);
  }
  assert.equal(audit.counts.length,SPECS.reduce((n,spec)=>n+spec[2].length,0)+3);
  assert(audit.transactions.every(value=>value.mode==='readonly'));
  assertClosed(audit);assert.deepEqual(await snapshot(factory),before,'values, Blob hashes, keys and schema must all remain unchanged');
});

test('an unknown store name stays private while its count is retained',async()=>{
  const factory=await recordsFactory({files:[],[PRIVATE_STORE]:[[SECRET,new Blob([SECRET])]]});
  const before=await snapshot(factory),{result,audit}=await guarded(factory);
  const hidden=row(result).stores.find(store=>store.name===null);assert(hidden);assert.equal(hidden.count,1);assert(Number.isSafeInteger(hidden.sequence));
  assert.deepEqual(row(result).presence,{status:'complete',meta:false,workspace:false,legacyArchive:false});
  assertClosed(audit);assert.deepEqual(await snapshot(factory),before);
});

test('missing databases are confirmed from enumeration without opening or creating anything',async()=>{
  const factory=new IDBFactory(),{result,audit}=await guarded(factory);
  assert.equal(result.status,'complete');assert.equal(result.indexedDB.listedSentlogDatabaseCount,0);
  assert.equal(result.indexedDB.excludedDatabaseCount,0);assert(result.indexedDB.databases.every(value=>value.status==='missing'));
  unknownPresence(result);assert.deepEqual(audit.opens,[]);assert.deepEqual(await factory.databases(),[]);
});

test('absent fixed keys, zero stores and absent files store have distinct confirmed/unknown results',async()=>{
  for(const stores of [{files:[]},{}, {[PRIVATE_STORE]:[]}]){const factory=await recordsFactory(stores),before=await snapshot(factory);
    const {result}=await guarded(factory),presence=row(result).presence;
    assert.equal(row(result).status,'complete');
    assert.equal(presence.status,Object.hasOwn(stores,'files')?'complete':'missing-store');
    for(const key of ['meta','workspace','legacyArchive'])assert.equal(presence[key],Object.hasOwn(stores,'files')?false:null);
    assert.deepEqual(await snapshot(factory),before);
  }
});

test('unsupported APIs remain unconfirmed and never trigger an open or permission request',async()=>{
  let opens=0;
  const {result,audit}=await guarded(new IDBFactory(),{indexedDB:{open(){opens++;throw Error(SECRET);}},localStorage:null,storageManager:null,caches:null});
  assert.equal(result.status,'partial');assert.equal(result.indexedDB.status,'unsupported');
  assert(result.indexedDB.databases.every(value=>value.status==='unsupported'));
  assert.equal(result.marker.present,null);assert.equal(result.estimate.usageBytes,null);assert.equal(result.persisted.persisted,null);assert.equal(result.cache.count,null);
  unknownPresence(result);assert.equal(opens,0);assert.deepEqual(audit.opens,[]);
});

test('already-aborted scan performs no enumeration, marker read or cache access',async()=>{
  const controller=new AbortController();controller.abort();
  const {result,audit}=await guarded(new IDBFactory(),{signal:controller.signal});
  assert.equal(result.status,'cancelled');assert.equal(audit.enumerations,0);assert.deepEqual(audit.opens,[]);assert.deepEqual(audit.markerReads,[]);
  unknownPresence(result);assert.equal(result.cache.count,null);
});

for(const [name,listed]of [
  ['non-array','private-'+SECRET],['null row',[null]],['missing name',[{version:1}]],['empty name',[{name:'',version:1}]],
  ['duplicate known name',[{name:SPECS[0][0],version:2},{name:SPECS[0][0],version:2}]],
  ['duplicate private name',[{name:PRIVATE_DB,version:1},{name:PRIVATE_DB,version:1}]],
  ['missing known version',[{name:SPECS[0][0]}]],['zero known version',[{name:SPECS[0][0],version:0}]],
  ['fractional known version',[{name:SPECS[0][0],version:1.5}]],['unsafe known version',[{name:SPECS[0][0],version:Number.MAX_SAFE_INTEGER+1}]],
  ['string known version',[{name:SPECS[0][0],version:'2'}]]
])test('malformed database enumeration is unconfirmed, not empty: '+name,async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory);
  const {result,audit}=await guarded(factory,{}, {enumerate:async()=>listed});
  assert.equal(result.indexedDB.status,'error');assert.equal(result.indexedDB.code,'INVALID_RESPONSE');assert.equal(result.indexedDB.listedSentlogDatabaseCount,null);
  assert(result.indexedDB.databases.every(value=>value.status==='error'));unknownPresence(result);assert.deepEqual(audit.opens,[]);
  assert.deepEqual(await snapshot(factory),before);
});

test('valid unrelated database metadata is counted without reading its version or opening it',async()=>{
  const privateRow={name:PRIVATE_DB};Object.defineProperty(privateRow,'version',{get(){throw Error(SECRET);}});
  const {result,audit}=await guarded(new IDBFactory(),{}, {enumerate:async()=>[privateRow]});
  assert.equal(result.indexedDB.status,'complete');assert.equal(result.indexedDB.excludedDatabaseCount,1);assert.deepEqual(audit.opens,[]);
});

test('error messages and nonstandard error names are excluded from every result and progress event',async()=>{
  const denied=()=>{throw Object.assign(Error(SECRET),{name:SECRET});};
  const {result,audit}=await guarded(new IDBFactory(),{
    indexedDB:{databases:denied,open:denied},localStorage:{getItem:denied},storageManager:{estimate:denied,persisted:denied},caches:{keys:denied}
  });
  for(const part of [result.marker,result.estimate,result.persisted,result.cache,result.indexedDB]){assert.equal(part.status,'error');assert.equal(part.errorName,'Error');}
  assert.equal(result.status,'partial');unknownPresence(result);assert.equal(result.cache.count,null);assert(audit.progress.length>0);
});

test('a standard browser error preserves its safe class, never its private message',async()=>{
  const {result}=await guarded(new IDBFactory(),{indexedDB:{databases(){throw new DOMException(SECRET,'SecurityError');},open(){assert.fail('must not open');}}});
  assert.equal(result.indexedDB.errorName,'SecurityError');assert.equal(result.indexedDB.code,'DATABASE_LIST_FAILED');unknownPresence(result);
});

test('invalid marker, storage and cache responses never become false or zero',async()=>{
  const {result}=await guarded(new IDBFactory(),{
    localStorage:{getItem:()=>undefined},storageManager:{estimate:async()=>({usage:-1,quota:NaN}),persisted:async()=>0},caches:{keys:async()=>['sentlog-pwa-v1',null]}
  });
  for(const part of [result.marker,result.estimate,result.persisted,result.cache]){assert.equal(part.status,'error');assert.equal(part.code,'INVALID_RESPONSE');}
  assert.equal(result.marker.present,null);assert.equal(result.estimate.usageBytes,null);assert.equal(result.estimate.quotaBytes,null);
  assert.equal(result.persisted.persisted,null);assert.equal(result.cache.count,null);
});

test('a real zero usage or absent marker remains distinguishable from unsupported values',async()=>{
  const {result}=await guarded(new IDBFactory(),{
    localStorage:{getItem:()=>null},storageManager:{estimate:async()=>({usage:0}),persisted:async()=>false},caches:{keys:async()=>[]}
  });
  assert.deepEqual(result.marker,{status:'complete',present:false});
  assert.deepEqual(result.estimate,{status:'complete',usageBytes:0,quotaBytes:null});
  assert.deepEqual(result.persisted,{status:'complete',persisted:false});assert.equal(result.cache.count,0);
});

test('request and global time limits bound an unresponsive enumeration without opening anything',async()=>{
  for(const [requestTimeoutMs,maxDurationMs,code]of [[20,500,'REQUEST_TIMEOUT'],[500,20,'TIME_LIMIT']]){
    const started=Date.now(),{result,audit}=await guarded(new IDBFactory(),{requestTimeoutMs,maxDurationMs},{enumerate:()=>new Promise(()=>{})});
    assert(Date.now()-started<1000);assert.equal(result.indexedDB.status,'timeout');assert.equal(result.indexedDB.code,code);
    unknownPresence(result);assert.deepEqual(audit.opens,[]);
  }
});

test('cancellation during pending enumeration cannot later open a database',async()=>{
  let resolve;const controller=new AbortController(),pending=new Promise(done=>resolve=done);
  const flight=guarded(new IDBFactory(),{signal:controller.signal},{enumerate:()=>pending});
  await pause(5);controller.abort();const {result,audit}=await flight;
  assert.equal(result.status,'cancelled');unknownPresence(result);
  resolve([{name:SPECS[0][0],version:2}]);await pause(10);assert.deepEqual(audit.opens,[]);
});

test('a database deleted after enumeration is not recreated by the diagnostic open',async()=>{
  const factory=await recordsFactory();
  const {result,audit}=await guarded(factory,{}, {enumerate:async value=>{const rows=await value.databases();await remove(value,SPECS[0][0]);return rows;}});
  assert.equal(row(result).status,'error');assert.equal(row(result).code,'DATABASE_CHANGED');unknownPresence(result);
  assert.equal(audit.counts.length,0);assert.deepEqual(await factory.databases(),[]);
});

test('a version changed after enumeration is closed without reading or modifying the new version',async()=>{
  const factory=await recordsFactory();let afterOtherWriter;
  const {result,audit}=await guarded(factory,{}, {enumerate:async value=>{
    const rows=await value.databases(),db=await opened(value,SPECS[0][0],3);db.close();afterOtherWriter=true;return rows;
  }});
  assert(afterOtherWriter);assert.equal(row(result).code,'VERSION_CHANGED');assert.equal(audit.counts.length,0);unknownPresence(result);assertClosed(audit);
  const db=await opened(factory,SPECS[0][0]);assert.equal(db.version,3);db.close();
  assert.equal((await snapshot(factory))[0].stores.find(store=>store.name==='files').values.length,4);
});

for(const [name,fault]of [
  ['negative total',{query:undefined,value:-1}],['fractional total',{query:undefined,value:1.5}],
  ['missing presence result',{query:META,value:undefined}],['invalid presence count',{query:WS,value:2}],
  ['string presence result',{query:ARCHIVE,value:'0'}]
])test('invalid count results are never reported as confirmed presence/absence: '+name,async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory);let injected=false;
  const {result,audit}=await guarded(factory,{}, {count(args,raw){
    const request=raw.apply(this,args);
    if(!injected&&this.name==='files'&&args[0]===fault.query){injected=true;
      // The fake engine assigns request.result internally; let that assignment
      // occur while exposing a malformed response only to the diagnostic.
      Object.defineProperty(request,'result',{get:()=>fault.value,set(){}});}
    return request;
  }});
  assert(injected);assert.equal(row(result).status,'error');assert.equal(row(result).code,'INVALID_RESPONSE');
  assert.deepEqual(row(result).stores,[]);unknownPresence(result);assertClosed(audit);assert.deepEqual(await snapshot(factory),before);
});

test('a missing presence success callback stays unconfirmed even when the transaction completes',async()=>{
  const factory=await recordsFactory();let injected=false;
  const {result}=await guarded(factory,{}, {count(args,raw){
    const request=raw.apply(this,args);
    if(args[0]===META){injected=true;Object.defineProperty(request,'onsuccess',{configurable:true,get:()=>null,set(){}});}
    return request;
  }});
  assert(injected);assert.equal(row(result).code,'INVALID_RESPONSE');unknownPresence(result);assert.deepEqual(row(result).stores,[]);
});

test('a synchronous count exception aborts its readonly transaction and discards partial counts',async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory);let aborted=false,injected=false;
  const {result,audit}=await guarded(factory,{}, {count(args,raw){
    if(args[0]===WS){injected=true;this.transaction.addEventListener('abort',()=>aborted=true);throw new DOMException(SECRET,'UnknownError');}
    return raw.apply(this,args);
  }});
  await until(()=>aborted,'the transaction was not aborted after count() threw');
  assert(injected);assert.equal(row(result).status,'error');assert.equal(row(result).errorName,'UnknownError');
  unknownPresence(result);assert.deepEqual(row(result).stores,[]);assertClosed(audit);assert.deepEqual(await snapshot(factory),before);
});

test('an asynchronous count request failure aborts without exposing values or confirmed partial results',async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory);let injected=false;
  const {result,audit}=await guarded(factory,{}, {count(args,raw){
    const request=raw.apply(this,args);
    if(args[0]===ARCHIVE){const queued=this.transaction._requests.find(value=>value.request===request);assert(queued);
      injected=true;queued.operation=()=>{throw new DOMException(SECRET,'UnknownError');};}
    return request;
  }});
  assert(injected);assert.equal(row(result).status,'error');assert.equal(row(result).errorName,'UnknownError');
  unknownPresence(result);assert.deepEqual(row(result).stores,[]);assertClosed(audit);assert.deepEqual(await snapshot(factory),before);
});

test('timeout aborts a still-active readonly transaction and closes the database',async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory);let started=false,aborted=false,keep=true;
  const {result,audit}=await guarded(factory,{requestTimeoutMs:25,maxDurationMs:500},{count(args,raw){
    if(!started){started=true;const store=this;store.transaction.addEventListener('abort',()=>{aborted=true;keep=false;});
      const pump=()=>{if(!keep)return;try{const q=raw.call(store);q.onsuccess=pump;q.onerror=()=>{keep=false;};}catch{keep=false;}};pump();}
    return raw.apply(this,args);
  }});
  keep=false;await until(()=>aborted,'timed-out readonly transaction was not aborted');
  assert.equal(row(result).status,'timeout');assert.equal(row(result).code,'REQUEST_TIMEOUT');unknownPresence(result);
  assertClosed(audit);assert.deepEqual(await snapshot(factory),before);
});

test('cancelling an active readonly transaction closes it and leaves all stored values unchanged',async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory),controller=new AbortController();
  let started=false,aborted=false;
  const {result,audit}=await guarded(factory,{signal:controller.signal},{count(args,raw){
    if(!started){started=true;this.transaction.addEventListener('abort',()=>aborted=true);queueMicrotask(()=>controller.abort());}
    return raw.apply(this,args);
  }});
  await until(()=>aborted,'cancelled readonly transaction was not aborted');
  assert(started);assert.equal(result.status,'cancelled');assert.equal(row(result).status,'cancelled');
  unknownPresence(result);assert.deepEqual(row(result).stores,[]);assertClosed(audit);assert.deepEqual(await snapshot(factory),before);
});

test('external versionchange during counting closes the connection and rejects partial observations',async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory);let started=false,keep=true,aborted=false,finishUpgrade;
  const upgradeDone=new Promise(resolve=>finishUpgrade=resolve);
  const {result,audit}=await guarded(factory,{}, {count(args,raw){
    if(!started){started=true;const store=this;
      store.transaction.addEventListener('abort',()=>{aborted=true;keep=false;});
      const pump=()=>{if(!keep)return;try{const q=raw.call(store);q.onsuccess=pump;q.onerror=()=>{keep=false;};}catch{keep=false;}};pump();
      queueMicrotask(()=>{
        const q=RAW_OPEN.call(factory,SPECS[0][0],3);
        q.onupgradeneeded=()=>q.transaction.abort();
        q.onerror=finishUpgrade;
        q.onsuccess=()=>{q.result.close();finishUpgrade();};
      });
    }
    return raw.apply(this,args);
  }});
  keep=false;await upgradeDone;await until(()=>aborted,'versionchange did not abort the ongoing count');
  assert.equal(row(result).status,'error');assert.equal(row(result).code,'VERSION_CHANGED');
  unknownPresence(result);assert.deepEqual(row(result).stores,[]);assertClosed(audit);assert.deepEqual(await snapshot(factory),before);
});

test('late successful open after a blocked request times out is closed, with no schema changes',async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory),blocker=await opened(factory,SPECS[0][0]);
  const upgrade=RAW_OPEN.call(factory,SPECS[0][0],3);
  const blocked=new Promise(resolve=>upgrade.onblocked=resolve),upgradeDone=new Promise(resolve=>{
    upgrade.onupgradeneeded=()=>upgrade.transaction.abort();upgrade.onerror=resolve;
  });
  await blocked;
  const {result,audit}=await guarded(factory,{requestTimeoutMs:25,maxDurationMs:500});
  assert.equal(row(result).status,'timeout');unknownPresence(result);assert.equal(audit.counts.length,0);
  blocker.close();await upgradeDone;await until(()=>audit.connections.length>0,'queued diagnostic open did not complete');
  assertClosed(audit);assert.deepEqual(await snapshot(factory),before);
});

test('late implicit creation after timeout is aborted and leaves no empty database',async()=>{
  const factory=await recordsFactory();let release,request;
  const {result}=await guarded(factory,{requestTimeoutMs:15,maxDurationMs:500},{
    enumerate:async value=>{const list=await value.databases();await remove(value,SPECS[0][0]);return list;},
    open(value,name){
      const proxy={readyState:'pending',addEventListener(){}};request=proxy;
      release=()=>{const real=RAW_OPEN.call(value,name);real.onupgradeneeded=()=>{
        proxy.transaction=real.transaction;proxy.onupgradeneeded?.();
      };real.onerror=()=>{proxy.readyState='done';proxy.error=real.error;proxy.onerror?.();};real.onsuccess=()=>{
        proxy.readyState='done';proxy.result=real.result;proxy.onsuccess?.();
      };};return proxy;
    }
  });
  assert.equal(row(result).status,'timeout');unknownPresence(result);release();
  await until(()=>request.readyState==='done','late open did not finish');assert.deepEqual(await factory.databases(),[]);
});

test('progress snapshots are defensive and a throwing observer cannot break the scan',async()=>{
  const factory=await recordsFactory(),before=await snapshot(factory);let callbacks=0;
  const {result,audit}=await guarded(factory,{onProgress(value){
    callbacks++;value.indexedDB.databases.length=0;value.marker.present=false;value.cache.generations.push(99999);throw Error(SECRET);
  }});
  assert(callbacks>1);assert.equal(result.status,'complete');assert.equal(result.indexedDB.databases.length,7);
  assert.equal(result.marker.present,true);assert.deepEqual(result.cache.generations,[7,246]);assertClosed(audit);
  assert.deepEqual(await snapshot(factory),before);
});

(async()=>{
  let passed=0;
  for(const {name,run}of cases){await run();passed++;console.log('PASS '+name);}
  console.log('PASS startup storage diagnostics: '+passed+' independent synthetic cases; no production browser or data used');
})().catch(error=>{console.error(error);process.exitCode=1;});

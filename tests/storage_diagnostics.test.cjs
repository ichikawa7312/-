'use strict';
// Disposable databases only. The diagnostic must never mutate app data/schema.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const D=require('../sentlog/storage-diagnostics.js');
const tests=[];const test=(name,run)=>tests.push({name,run});
async function seed(factory,name,stores,version=1){
  const db=await new Promise((resolve,reject)=>{const q=factory.open(name,version);q.onupgradeneeded=()=>{
    for(const store of Object.keys(stores))if(!q.result.objectStoreNames.contains(store))q.result.createObjectStore(store);
  };q.onerror=()=>reject(q.error);q.onsuccess=()=>resolve(q.result);});
  try{await new Promise((resolve,reject)=>{const tx=db.transaction(Object.keys(stores),'readwrite');
    for(const [name,rows]of Object.entries(stores))for(const [key,value]of rows)tx.objectStore(name).put(value,key);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
async function remove(factory,name){await new Promise((resolve,reject)=>{const q=factory.deleteDatabase(name);q.onsuccess=resolve;q.onerror=()=>reject(q.error);});}
async function contents(factory,name,store){
  const db=await new Promise((resolve,reject)=>{const q=factory.open(name);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),q=tx.objectStore(store).getAll();let rows;q.onsuccess=()=>rows=q.result;tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
const scan=(factory,options={})=>D.scan({indexedDB:factory,IDBKeyRange,...options});
const blob=n=>new Blob([new Uint8Array(n)]);
function store(result,name){for(const db of result.databases)for(const item of db.stores)if(item.name===name)return item;throw Error('missing '+name);}

// Advance the timer independently of the wall clock. Native clocks may still
// report the preceding millisecond when a deadline timer has already fired.
for(const scenario of [
  {name:'global budget with a coarse clock',max:50,request:500,elapsed:49,global:true},
  {name:'request budget with a coarse clock',max:500,request:50,elapsed:49,global:false},
  {name:'equal budgets with a coarse clock',max:50,request:50,elapsed:49,global:true},
  {name:'request timer delayed beyond the global deadline',max:500,request:50,elapsed:501,global:false}
])test('timeout reason follows the scheduled '+scenario.name,async()=>{
  const start=1700000000000,timers=new Map();let now=start,serial=0,enumerated=0,opened=0;
  class CoarseDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context={module:{exports:{}},Date:CoarseDate,
    setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../sentlog/storage-diagnostics.js'),'utf8'),context,{filename:'storage-diagnostics.js'});
  const resultPromise=context.module.exports.scan({indexedDB:{
    databases(){enumerated++;return new Promise(()=>{});},open(){opened++;throw Error('must not open');}
  },IDBKeyRange,maxDurationMs:scenario.max,requestTimeoutMs:scenario.request});
  assert.equal(enumerated,1);assert.equal(timers.size,1);
  const [id,timer]=[...timers][0];assert.equal(timer.delay,Math.min(scenario.max,scenario.request));
  now=start+scenario.elapsed;timers.delete(id);timer.fn();
  const result=await resultPromise;
  assert.equal(result.status,'failed');assert.equal(result.complete,false);assert.equal(result.records,0);assert.equal(opened,0);
  assert.equal(result.reason,scenario.global?'計測時間の上限に達しました。表示は途中までの集計です。':'保存先からの応答がないため、この診断を中止しました。');
  assert.equal(timers.size,0,'the completed scan must not leave a pending timer');
});

test('counts all known hidden stores without reading image bytes, bulk reads, writes or unrelated databases',async()=>{
  const f=new IDBFactory(),secret='PRIVATE CASE AND PHOTO NAME';
  await seed(f,'surveyFieldNoteDB',{
    files:[['photo:d:p',blob(10)]],
    sentlog_delta_journal_v1:[[1,{kind:'sentlog-file-retention',at:1700000000000,files:[{before:blob(10),after:blob(10)}],note:secret}]],
    sentlog_delta_control_v1:[['cutoff',{kind:'cutoff-file',value:blob(10)}]]
  },2);
  await seed(f,'sentlog-original-photos-v1',{photos:[['p',blob(20)]],meta:[['p',{size:20,storedAt:1700000000100}]]});
  await seed(f,'sentlog-delta-migration-v1',{
    sessions:[['s',{status:'copying',createdAt:1700000000000}]],
    items:[[0,{descriptor:{kind:'photo',size:10},value:blob(10)}]]});
  await seed(f,'sentlog-delta-assets-v1',{assets:[['p',{state:'received',blob:blob(10)}]]});
  await seed(f,'sentlog-delta-v1',{replicas:[['r',{outbox:[{text:'日本語😀'}]}]]});
  await seed(f,'unrelated-private-app',{private:[['secret',secret]]});
  const before=await f.databases(),opened=[],originalOpen=f.open.bind(f),saved={};
  f.open=(name,...args)=>{opened.push(name);return originalOpen(name,...args);};
  for(const key of ['put','add','delete','clear','getAll','getAllKeys']){
    saved[key]=IDBObjectStore.prototype[key];IDBObjectStore.prototype[key]=()=>{throw Error('diagnostic must not '+key);};
  }
  const originals={arrayBuffer:Blob.prototype.arrayBuffer,text:Blob.prototype.text,stream:Blob.prototype.stream};
  for(const key of Object.keys(originals))Blob.prototype[key]=()=>{throw Error('must not read Blob '+key);};
  let result;
  try{result=await scan(f);}finally{
    for(const [key,value]of Object.entries(saved))IDBObjectStore.prototype[key]=value;
    for(const [key,value]of Object.entries(originals))Blob.prototype[key]=value;
  }
  assert.equal(result.status,'complete');assert.equal(result.complete,true);assert.equal(result.databases.length,5);
  assert.equal(result.blobBytes,80);assert.equal(result.blobCount,7);assert.equal(result.records,9);
  assert.equal(store(result,'sentlog_delta_journal_v1').blobBytes,20);
  assert.equal(store(result,'sentlog_delta_journal_v1').kinds['sentlog-file-retention'],1);
  assert.equal(store(result,'sessions').states.copying,1);assert.equal(store(result,'items').kinds.photo,1);
  assert.equal(store(result,'sentlog_delta_journal_v1').earliestTimestamp,1700000000000);
  assert.equal(result.excludedDatabaseCount,1);assert.equal(result.excludedDatabases[0].name,'unrelated-private-app');
  assert(!opened.includes('unrelated-private-app'));assert(!JSON.stringify(result).includes(secret));
  assert.deepEqual(await f.databases(),before);
  assert.equal((await contents(f,'surveyFieldNoteDB','sentlog_delta_journal_v1'))[0].note,secret);
  assert.equal(result.databases.find(db=>db.name==='surveyFieldNoteDB').openedVersion,2);
});

test('unsupported enumeration does not probe or create any databases',async()=>{
  let opened=0;const result=await D.scan({indexedDB:{open(){opened++;throw Error('never');}},IDBKeyRange});
  assert.equal(result.status,'unsupported');assert.equal(opened,0);assert.equal(result.records,0);
});

test('an already-cancelled scan never enumerates or opens databases',async()=>{
  let calls=0;const controller=new AbortController();controller.abort();
  const result=await D.scan({indexedDB:{databases(){calls++;return Promise.resolve([]);},open(){calls++;}},
    IDBKeyRange,signal:controller.signal});
  assert.equal(result.status,'cancelled');assert.equal(calls,0);
});

test('global time limit also stops a nonresponsive enumeration without opening anything',async()=>{
  let opened=0;const result=await D.scan({indexedDB:{databases(){return new Promise(()=>{});},open(){opened++;}},
    IDBKeyRange,maxDurationMs:50,requestTimeoutMs:500});
  assert.equal(result.status,'failed');assert.equal(result.complete,false);assert.match(result.reason,/時間/);assert.equal(opened,0);
});

test('missing known databases are not opened or created',async()=>{
  const f=new IDBFactory();let opened=0;const old=f.open.bind(f);f.open=(...args)=>{opened++;return old(...args);};
  const result=await scan(f);assert.equal(result.status,'complete');assert.equal(result.records,0);
  assert.equal(result.missingDatabases.length,5);assert.equal(opened,0);assert.deepEqual(await f.databases(),[]);
});

test('stale enumeration after deletion aborts implicit creation without leaving a database',async()=>{
  const f=new IDBFactory();await seed(f,'surveyFieldNoteDB',{files:[['x','kept']]});
  const databases=f.databases.bind(f);let once=true;
  f.databases=async()=>{const result=await databases();if(once){once=false;await remove(f,'surveyFieldNoteDB');}return result;};
  const result=await scan(f);assert.equal(result.status,'partial');assert.match(result.reason,/作成・更新せず/);
  assert.deepEqual(await databases(),[]);
});

test('cancellation keeps existing data and schema intact',async()=>{
  const f=new IDBFactory();await seed(f,'surveyFieldNoteDB',{files:Array.from({length:20},(_,i)=>[i,blob(i+1)])});
  const controller=new AbortController(),before=await f.databases();let cancelled=false;
  const result=await scan(f,{signal:controller.signal,yieldEvery:1,onProgress(value){
    if(value.records===3&&!cancelled){cancelled=true;controller.abort();}
  }});
  assert.equal(result.status,'cancelled');assert.equal(result.records,3);assert.equal(store(result,'files').status,'partial');
  assert.equal((await contents(f,'surveyFieldNoteDB','files')).length,20);assert.deepEqual(await f.databases(),before);
});

test('zero, empty string and array keys resume without skipping or counting rows twice',async()=>{
  const f=new IDBFactory();await seed(f,'surveyFieldNoteDB',{files:[[0,'a'],[1,'bb'],['','ccc'],['x','dddd'],[['a',0],'eeeee']]});
  const result=await scan(f,{yieldEvery:1});assert.equal(result.status,'complete');assert.equal(result.records,5);
  assert.equal(result.textBytes,15);assert.equal(store(result,'files').recordsAtStart,5);
});

test('row limit returns an explicit lower-bound partial result, without deleting records',async()=>{
  const f=new IDBFactory();await seed(f,'surveyFieldNoteDB',{files:[[0,blob(10)],[1,blob(20)],[2,blob(30)]]});
  const result=await scan(f,{maxRows:2});assert.equal(result.status,'partial');assert.equal(result.complete,false);
  assert.match(result.reason,/件数/);assert.equal(result.records,2);assert.equal(result.blobBytes,30);
  assert.equal((await contents(f,'surveyFieldNoteDB','files')).length,3);
});

test('large Unicode text is measured without JSON serialization, encoders or Blob allocations',async()=>{
  const f=new IDBFactory(),value=('漢字😀a\ud800b\udc00').repeat(12000),expected=Buffer.byteLength(value);
  await seed(f,'surveyFieldNoteDB',{files:[[0,value]]});
  const original=JSON.stringify,encode=TextEncoder.prototype.encode;
  JSON.stringify=()=>{throw Error('no JSON allocation');};TextEncoder.prototype.encode=()=>{throw Error('no UTF8 allocation');};
  let result;try{result=await scan(f);}finally{JSON.stringify=original;TextEncoder.prototype.encode=encode;}
  assert.equal(result.status,'complete');assert.equal(result.textBytes,expected);assert.equal(result.records,1);
});

test('blocked queued open times out and closes any late connection without changing version',async()=>{
  const f=new IDBFactory();await seed(f,'surveyFieldNoteDB',{files:[[0,'kept']]});
  const blocker=await new Promise((resolve,reject)=>{const q=f.open('surveyFieldNoteDB');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const upgrade=f.open('surveyFieldNoteDB',2);let upgradeBlocked;
  const blocked=new Promise(resolve=>upgradeBlocked=resolve);upgrade.onblocked=()=>upgradeBlocked();
  const aborted=new Promise(resolve=>{upgrade.onupgradeneeded=()=>upgrade.transaction.abort();upgrade.onerror=()=>resolve();});
  await blocked;
  const result=await scan(f,{requestTimeoutMs:50,maxDurationMs:1000});
  assert.equal(result.status,'partial');assert.match(result.reason,/応答/);
  blocker.close();await aborted;await new Promise(resolve=>setTimeout(resolve,10));
  const versions=await f.databases();assert.equal(versions.find(x=>x.name==='surveyFieldNoteDB').version,1);
  assert.deepEqual(await contents(f,'surveyFieldNoteDB','files'),['kept']);
});

test('a version change releases the diagnostic connection and reports partial data',async()=>{
  const f=new IDBFactory();await seed(f,'surveyFieldNoteDB',{files:Array.from({length:20},(_,i)=>[i,blob(10)])});
  let changed=false,upgradeDone;
  const upgraded=new Promise(resolve=>upgradeDone=resolve);
  const result=await scan(f,{yieldEvery:1,onProgress(value){
    if(!changed&&value.records===2){changed=true;const q=f.open('surveyFieldNoteDB',2);
      q.onupgradeneeded=()=>{};q.onsuccess=()=>{q.result.close();upgradeDone();};q.onerror=()=>upgradeDone();}
  }});
  await upgraded;assert.equal(result.status,'partial');assert.match(result.reason,/保存先の変更/);
  assert.equal((await contents(f,'surveyFieldNoteDB','files')).length,20);
});

test('a concurrent scan is refused, and mutations to progress summaries cannot corrupt results',async()=>{
  const f=new IDBFactory();await seed(f,'surveyFieldNoteDB',{files:[[0,blob(7)]]});
  let second;
  const result=await scan(f,{onProgress(value){
    if(!second)second=scan(f);value.records=999999;if(value.databases[0])value.databases[0].stores.length=0;
  }});
  assert.equal((await second).status,'busy');assert.equal(result.records,1);assert.equal(result.blobBytes,7);
});

(async()=>{for(const {name,run}of tests){await run();console.log('PASS '+name);}console.log(`${tests.length} storage diagnostics tests passed`);})().catch(error=>{console.error(error);process.exitCode=1;});

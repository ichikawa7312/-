'use strict';
// Disposable fake IndexedDB only. No production backup, account, browser or DB.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {IDBFactory,IDBDatabase,IDBObjectStore}=require('fake-indexeddb');
const Format=require('../sentlog/backup-format.js'),Recovery=require('../sentlog/startup-backup-recovery.js');
const Hash=require('../sentlog/blob-sha256.js');
const DB='surveyFieldNoteDB',FILES='files',JOURNAL='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const META='__sentlog_records_meta_v130__',ARCHIVE='__sentlog_records_archive_v130__',INTENT='startup-backup-recovery:v1';
const MARKER='sentlogRecordsReadyV130',PREFIX='__sentlog_record__:',WS='surveyFieldNoteWorkspaceV1';
const tests=[],test=(name,fn)=>tests.push({name,fn});
const digest=blob=>Hash.digest(blob);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
const finished=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Synthetic abort'));tx.onerror=()=>{};});
const copy=value=>JSON.parse(JSON.stringify(value));
function backup(){
  const photo=Buffer.from('Synthetic shared photo bytes 日本語');
  const pdf=Buffer.from('%PDF-1.7 synthetic drawing bytes');
  const drawing={id:'synthetic-drawing',name:'Synthetic drawing',sourceType:'pdf',fileName:'synthetic.pdf',pageCount:1};
  return {format:'sentlog-backup',version:1,exportedAt:'2026-01-01T00:00:00.000Z',
    workspace:{projects:[{id:'synthetic-project',name:'Synthetic project',updatedAt:12,drawings:[drawing]}]},
    drawingStates:{'synthetic-drawing':{sourceType:'pdf',fileName:'synthetic.pdf',shapes:[{id:'synthetic-record',memo:'Synthetic memo',
      photos:[{id:'synthetic-photo',size:photo.length,type:'image/jpeg',sha256:sha(photo)},
        {id:'synthetic-missing-photo',size:7,type:'image/jpeg'}]}],collabDeletedRecords:[]}},
    files:[{key:'background:synthetic-drawing',type:'application/pdf',name:'',data:'data:application/pdf;base64,'+pdf.toString('base64')},
      {key:'photo:synthetic-drawing:synthetic-photo',type:'image/jpeg',name:'',data:'data:image/jpeg;base64,'+photo.toString('base64')}]};
}
const asFile=pack=>new File([JSON.stringify(pack)],'synthetic.sentlog.json',{type:'application/json',lastModified:100});
async function seed(factory,{version=2,files=[],journal=[],control=[],extraStore=false,badIndex=false,badKeyPath=false}={}){
  const q=factory.open(DB,version);q.onupgradeneeded=()=>{
    q.result.createObjectStore(FILES,badKeyPath?{keyPath:'id'}:undefined);
    for(const name of [JOURNAL,CONTROL])q.result.createObjectStore(name).createIndex('kind','kind',{unique:badIndex});
    if(extraStore)q.result.createObjectStore('synthetic-unknown-store');
  };
  const db=await request(q);try{const tx=db.transaction([...db.objectStoreNames],'readwrite'),done=finished(tx);
    for(const [name,rows]of [[FILES,files],[JOURNAL,journal],[CONTROL,control]])for(const [key,value]of rows)tx.objectStore(name).add(value,key);
    await done;
  }finally{db.close();}
}
const OTHER=[
  ['sentlog-original-photos-v1',{photos:{},meta:{keyPath:'key',indexes:['createdAt','exportedAt','projectId']}}],
  ['sentlog-delta-migration-v1',{sessions:{},items:{}}],['sentlog-delta-assets-v1',{assets:{}}],
  ['sentlog-delta-v1',{replicas:{}}],['sentlogSyncTrafficV1',{acks:{}}],['sentlog-pc-sync',{kv:{}}]
];
async function seedOther(factory,[name,stores],rows=[]){
  const q=factory.open(name,1);q.onupgradeneeded=()=>{for(const [key,s]of Object.entries(stores)){
    const store=q.result.createObjectStore(key,s.keyPath?{keyPath:s.keyPath}:undefined);
    for(const index of s.indexes||[])store.createIndex(index,index);
  }};
  const db=await request(q);try{if(rows.length){const tx=db.transaction(Object.keys(stores),'readwrite'),done=finished(tx);
    for(const [store,key,value]of rows)tx.objectStore(store).add(value,key);await done;}}
  finally{db.close();}
}
function createApi(f,extra={}){return Recovery.create({indexedDB:f.factory,localStorage:f.local,locks:f.locks,...extra});}
async function fixture(options={}){
  const factory=new IDBFactory(),data=new Map([[MARKER,'1'],['synthetic-unrelated-setting','preserve']]);
  for(const [key,value]of options.local||[])data.set(key,value);
  if(!options.absent)await seed(factory,options);
  const local={get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:key=>data.get(key)??null,
    setItem(){throw Error('Recovery must not write localStorage');},removeItem(){throw Error('Recovery must not remove localStorage');},clear(){throw Error('Recovery must not clear localStorage');}};
  const locks={held:false,async request(name,opts,fn){assert.equal(name,'sentlog-record-writer-v130');assert.deepEqual(opts,{mode:'exclusive',ifAvailable:true});
    if(this.held)return fn(null);this.held=true;try{return await fn({name});}finally{this.held=false;}}};
  const f={factory,data,local,locks};f.api=createApi(f);return f;
}
async function normalized(value){
  if(value===undefined)return {kind:'undefined'};
  if(value instanceof Blob)return {kind:'Blob',type:value.type,size:value.size,sha256:await digest(value)};
  if(Array.isArray(value))return Promise.all(value.map(normalized));
  if(value&&typeof value==='object'){const out={};for(const key of Object.keys(value).sort())out[key]=await normalized(value[key]);return out;}
  return value;
}
async function snapshot(f){
  const result=[];
  for(const {name}of (await f.factory.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
    const db=await request(f.factory.open(name));
    try{
      const row=await new Promise((resolve,reject)=>{const tx=db.transaction([...db.objectStoreNames],'readonly'),stores=[];
        for(const name of db.objectStoreNames){const s=tx.objectStore(name),out={name,keyPath:s.keyPath,autoIncrement:s.autoIncrement,
          indexes:[...s.indexNames].map(n=>{const i=s.index(n);return {name:n,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry};})};stores.push(out);
          s.getAllKeys().onsuccess=e=>{out.keys=e.target.result;};s.getAll().onsuccess=e=>{out.values=e.target.result;};}
        tx.oncomplete=()=>resolve({name,version:db.version,stores});tx.onabort=()=>reject(tx.error);
      });
      for(const s of row.stores)s.values=await normalized(s.values);result.push(row);
    }finally{db.close();}
  }
  return {databases:result,local:[...f.data]};
}
async function rawRows(f){const db=await request(f.factory.open(DB));try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction([FILES,JOURNAL,CONTROL],'readonly'),out={};for(const name of [FILES,JOURNAL,CONTROL]){
    const r=out[name]={};tx.objectStore(name).getAllKeys().onsuccess=e=>r.keys=e.target.result;tx.objectStore(name).getAll().onsuccess=e=>r.values=e.target.result;}
  tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error);
});}finally{db.close();}}
async function onlyAdds(fn){
  const methods=['put','delete','clear'],saved=Object.fromEntries(methods.map(k=>[k,IDBObjectStore.prototype[k]]));
  for(const k of methods)IDBObjectStore.prototype[k]=function(){throw Error('Forbidden recovery write method: '+k);};
  try{return await fn();}finally{for(const k of methods)IDBObjectStore.prototype[k]=saved[k];}
}
async function prepared(f,pack=backup(),api=f.api){return api.prepare(asFile(pack));}
async function rejectsUnchanged(f,code){
  const before=await snapshot(f),plan=await prepared(f);
  await onlyAdds(()=>assert.rejects(f.api.restore(plan,{confirmedOtherTabsClosed:true}),e=>e.code===code));
  assert.deepEqual(await snapshot(f),before);assert.equal(f.locks.held,false);
}
function recordsFor(f){
  const context={console,Blob,File,DOMException,structuredClone,queueMicrotask,setTimeout,clearTimeout,indexedDB:f.factory,
    IDBKeyRange:require('fake-indexeddb').IDBKeyRange,navigator:{},crypto:crypto.webcrypto,
    localStorage:{...f.local,setItem:(key,value)=>f.data.set(key,String(value))}};
  Object.defineProperty(context.localStorage,'length',{get:()=>f.data.size});context.window=context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../sentlog/record-store.js'),'utf8'),context);return context.SentlogRecords;
}

test('normal-format extraction preserves the existing parser acceptance and decoded values',async()=>{
  const source=fs.readFileSync(require.resolve('../sentlog/part05.txt'),'utf8');
  const start=source.indexOf('async function importSentlogBackup(file){'),end=source.indexOf("  if(!confirm(",start);
  const decoder=source.slice(source.indexOf('function dataURLToBlob('),source.indexOf('async function exportSentlogBackup('));
  const legacy=vm.runInNewContext(decoder+'\n'+source.slice(start,end)+'\nreturn {pack,records,files};}\nimportSentlogBackup',
    {Blob,File,atob,Uint8Array,Map,Set,JSON,Date:{now:()=>0},WORKSPACE_KEY:WS,drawingStorageKey:id=>'surveyFieldNoteDrawingV1:'+id,alert:()=>{}});
  const cases=[backup()];
  const variants=[p=>{p.workspace.projects=[];p.drawingStates={};p.files=[];},p=>{p.files[0].name='synthetic.pdf';p.files[0].lastModified=50;},
    p=>{p.files.push({key:'background',data:'data:application/octet-stream;base64,AA=='});},p=>{delete p.drawingStates;},
    p=>{p.format='sentlog-record-rescue';},p=>{p.workspace.projects.push(p.workspace.projects[0]);},
    p=>{p.workspace.projects[0].drawings.push(p.workspace.projects[0].drawings[0]);},p=>{p.drawingStates['synthetic-drawing'].shapes={};},
    p=>{p.files.push(p.files[0]);},p=>{p.files[0].key='other:bad';},p=>{p.files[0].data='bad';},p=>{p.files[0].data='data:application/pdf;base64,A';}];
  for(const mutate of variants){const pack=backup();mutate(pack);cases.push(pack);}
  for(const pack of cases){const file=asFile(pack),old=await legacy(file);let next;
    try{next=Format.decode(await file.text(),{now:()=>0});}catch{}
    assert.equal(!!next,!!old,'shared parser must retain ordinary importer acceptance');
    if(old){assert.deepEqual(JSON.parse(JSON.stringify([...next.records])),JSON.parse(JSON.stringify([...old.records])));
      assert.deepEqual(await normalized(next.files.map(f=>[f.key,f.value])),await normalized(old.files.map(f=>[f.key,f.value])));}
  }
});
test('empty v2 recovery uses add only, reports missing media, and current startup accepts the verified result',async()=>{
  const f=await fixture(),source=asFile(backup()),sourceSha=await digest(source),beforeLocal=[...f.data];
  const plan=await f.api.prepare(source);assert.deepEqual(plan.summary,{projects:1,drawings:1,records:1,photoReferences:2,
    drawingFileReferences:1,requiredFiles:3,includedFiles:2,includedBytes:Buffer.byteLength('Synthetic shared photo bytes 日本語')+Buffer.byteLength('%PDF-1.7 synthetic drawing bytes'),
    missingFiles:1,includedUnreferencedFiles:0,unclassifiedDrawings:0});
  assert.equal((await f.api.inspect(plan)).mode,'empty');const result=await onlyAdds(()=>f.api.restore(plan,{confirmedOtherTabsClosed:true}));
  assert.equal(result.verified,true);assert.equal(result.resumed,false);assert.equal(await digest(source),sourceSha);assert.deepEqual([...f.data],beforeLocal);
  const rows=await rawRows(f);assert(rows[FILES].keys.includes(META));assert.deepEqual(rows[CONTROL].keys,[INTENT]);assert.deepEqual(rows[JOURNAL].keys,[]);
  const records=recordsFor(f);await records.init();assert.equal(records.ready,true);
  assert.equal(JSON.parse(records.getItem('surveyFieldNoteDrawingV1:synthetic-drawing')).shapes[0].memo,'Synthetic memo');
});
test('all six empty known companion databases are accepted without changing any of them',async()=>{
  const f=await fixture();for(const spec of OTHER)await seedOther(f.factory,spec);const before=await snapshot(f),plan=await prepared(f);
  await onlyAdds(()=>f.api.restore(plan,{confirmedOtherTabsClosed:true}));const after=await snapshot(f);
  assert.deepEqual(after.databases.filter(x=>x.name!==DB),before.databases.filter(x=>x.name!==DB));assert.deepEqual(after.local,before.local);
});
for(const [name,seedOptions]of [
  ['workspace',{files:[[PREFIX+WS,'{"projects":[]}']]}],['undefined managed record',{files:[[PREFIX+'surveyFieldNoteDrawingV1:x',undefined]]}],
  ['null metadata',{files:[[META,null]]}],['undefined archive',{files:[[ARCHIVE,undefined]]}],['photo Blob',{files:[['photo:x:y',new Blob(['synthetic retained'])]]}],
  ['journal',{journal:[[1,{kind:'synthetic-record',bytes:new Blob(['synthetic journal'])}]]}],['zero control',{control:[['clock',0]]}]
])test('rejects residual '+name+' with all stores, Blob bytes, schema and localStorage preserved',async()=>rejectsUnchanged(await fixture(seedOptions),'OTHER_BACKUP'));
for(const key of [WS,'surveyFieldNoteV2','surveyFieldNoteDrawingV1:x','sentlogCloudProjectSyncV2:x','sentlogArchiveLocalV1','sentlogReplaceBackupV1:x','sentlogSyncMergeCheckpointV1:x'])
  test('rejects legacy key '+key,async()=>rejectsUnchanged(await fixture({local:[[key,'null']]}),'LEGACY_PRESENT'));
for(const [name,seedOptions]of [['wrong version',{version:3}],['unknown store',{extraStore:true}],['wrong index',{badIndex:true}],['wrong keyPath',{badKeyPath:true}]])
  test('rejects '+name+' without upgrade or writes',async()=>rejectsUnchanged(await fixture(seedOptions),'SCHEMA'));
for(const spec of OTHER)test('rejects residual companion '+spec[0],async()=>{
  const f=await fixture(),store=Object.keys(spec[1])[0];await seedOther(f.factory,spec,[[store,'synthetic-private-key',new Blob(['synthetic retained other bytes'])]]);
  await rejectsUnchanged(f,'OTHER_DATA');
});
test('missing DB is not created',async()=>rejectsUnchanged(await fixture({absent:true}),'DATABASE_MISSING'));
test('unknown Sentlog DB is not opened or changed',async()=>{
  const f=await fixture();await seedOther(f.factory,['sentlog-unknown-synthetic',{private:{}}]);await rejectsUnchanged(f,'OTHER_DATABASE');
});
test('unknown differently named DB is rejected without opening it',async()=>{
  const f=await fixture();await seedOther(f.factory,['other-application-synthetic',{data:{}}],[['data','x',new Blob(['keep'])]]);
  const before=await snapshot(f),native=f.factory.open.bind(f.factory),plan=await prepared(f);let openedUnknown=0;
  f.factory.open=function(name,...args){if(name==='other-application-synthetic')openedUnknown++;return native(name,...args);};
  try{await assert.rejects(onlyAdds(()=>f.api.restore(plan,{confirmedOtherTabsClosed:true})),e=>e.code==='OTHER_DATABASE');}
  finally{f.factory.open=native;}
  assert.equal(openedUnknown,0);assert.deepEqual(await snapshot(f),before);
});
test('missing/unsupported locks and missing marker fail closed',async()=>{
  const f=await fixture(),before=await snapshot(f),noLock=createApi(f,{locks:null}),p=await prepared(f,backup(),noLock);
  await assert.rejects(noLock.restore(p,{confirmedOtherTabsClosed:true}),e=>e.code==='UNAVAILABLE');assert.deepEqual(await snapshot(f),before);
  f.locks.held=true;await assert.rejects(f.api.restore(await prepared(f),{confirmedOtherTabsClosed:true}),e=>e.code==='LOCK_UNAVAILABLE');f.locks.held=false;
  f.data.delete(MARKER);await rejectsUnchanged(f,'MARKER');
});
test('tab-closure confirmation is mandatory and cannot write',async()=>{
  const f=await fixture(),before=await snapshot(f);await assert.rejects(f.api.restore(await prepared(f)),e=>e.code==='TABS_REQUIRED');assert.deepEqual(await snapshot(f),before);
});
test('database disappearing after inventory aborts upgrade and leaves no new database',async()=>{
  const f=await fixture(),native=f.factory.databases.bind(f.factory);let first=true;
  f.factory.databases=async()=>{const rows=await native();if(first){first=false;await request(f.factory.deleteDatabase(DB));}return rows;};
  await assert.rejects(f.api.restore(await prepared(f),{confirmedOtherTabsClosed:true}),e=>e.code==='CHANGED');assert.deepEqual(await native(),[]);
});
test('writer queued after preview is detected by the same write transaction before any recovery add',async()=>{
  const f=await fixture(),plan=await prepared(f),native=IDBDatabase.prototype.transaction;let raced=false,raceDone;
  await f.api.inspect(plan);
  IDBDatabase.prototype.transaction=function(names,mode,...args){
    if(this.name===DB&&mode==='readwrite'&&!raced){raced=true;const tx=native.call(this,names,mode,...args);raceDone=finished(tx);tx.objectStore(JOURNAL).add({kind:'synthetic-new-input'},9);}
    return native.call(this,names,mode,...args);
  };
  try{await assert.rejects(onlyAdds(()=>f.api.restore(plan,{confirmedOtherTabsClosed:true})),e=>e.code==='RESIDUAL');await raceDone;}
  finally{IDBDatabase.prototype.transaction=native;}
  const rows=await rawRows(f);assert.deepEqual(rows[FILES].keys,[]);assert.deepEqual(rows[CONTROL].keys,[]);assert.deepEqual(rows[JOURNAL].keys,[9]);
});
test('QuotaExceeded during staging rolls every queued add back',async()=>{
  const f=await fixture(),plan=await prepared(f),before=await snapshot(f),native=IDBObjectStore.prototype.add;let fired=0;
  IDBObjectStore.prototype.add=function(value,key){if(this.transaction.db.name===DB&&key==='photo:synthetic-drawing:synthetic-photo'){fired++;throw new DOMException('Synthetic private details','QuotaExceededError');}return native.apply(this,arguments);};
  try{await assert.rejects(onlyAdds(()=>f.api.restore(plan,{confirmedOtherTabsClosed:true})),e=>e.errorName==='QuotaExceededError'&&e.persistence==='none');}
  finally{IDBObjectStore.prototype.add=native;}
  assert.equal(fired,1);assert.deepEqual(await snapshot(f),before);
});
test('asynchronous duplicate-key failure rolls staging back',async()=>{
  const f=await fixture(),plan=await prepared(f),before=await snapshot(f),native=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(value,key){if(this.transaction.db.name===DB&&key===ARCHIVE)return native.call(this,value,PREFIX+WS);return native.apply(this,arguments);};
  try{await assert.rejects(onlyAdds(()=>f.api.restore(plan,{confirmedOtherTabsClosed:true})),e=>e.errorName==='ConstraintError');}
  finally{IDBObjectStore.prototype.add=native;}
  assert.deepEqual(await snapshot(f),before);
});
test('failed META add leaves staged bytes; existing startup rejects; same backup resumes without re-adding data',async()=>{
  const f=await fixture(),source=asFile(backup()),plan=await f.api.prepare(source),native=IDBObjectStore.prototype.add;let calls=[];
  IDBObjectStore.prototype.add=function(value,key){calls.push(key);if(key===META)throw new DOMException('Synthetic final quota','QuotaExceededError');return native.apply(this,arguments);};
  try{await assert.rejects(onlyAdds(()=>f.api.restore(plan,{confirmedOtherTabsClosed:true})),e=>e.errorName==='QuotaExceededError'&&e.persistence==='staged');}
  finally{IDBObjectStore.prototype.add=native;}
  const before=await snapshot(f),rows=await rawRows(f);assert(!rows[FILES].keys.includes(META));assert(rows[CONTROL].keys.includes(INTENT));
  await assert.rejects(recordsFor(f).init(),/以前の端末内データ/);assert.deepEqual(await snapshot(f),before);
  const retry=createApi(f),again=await retry.prepare(source);assert.equal((await retry.inspect(again)).mode,'staged');calls=[];
  IDBObjectStore.prototype.add=function(value,key){calls.push(key);return native.apply(this,arguments);};
  try{assert.equal((await onlyAdds(()=>retry.restore(again,{confirmedOtherTabsClosed:true}))).resumed,true);}
  finally{IDBObjectStore.prototype.add=native;}
  assert.deepEqual(calls,[META]);const after=await snapshot(f);
  const beforeFiles=before.databases.find(x=>x.name===DB).stores.find(x=>x.name===FILES),afterFiles=after.databases.find(x=>x.name===DB).stores.find(x=>x.name===FILES);
  for(let i=0;i<beforeFiles.keys.length;i++)assert.deepEqual(afterFiles.values[afterFiles.keys.indexOf(beforeFiles.keys[i])],beforeFiles.values[i]);
});
test('completed same-backup recheck is entirely read-only',async()=>{
  const f=await fixture(),plan=await prepared(f);await f.api.restore(plan,{confirmedOtherTabsClosed:true});const before=await snapshot(f),native=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(){throw Error('Completed recheck must not add');};
  try{const next=createApi(f),p=await prepared(f,backup(),next);assert.equal((await next.inspect(p)).mode,'complete');
    assert.equal((await onlyAdds(()=>next.restore(p,{confirmedOtherTabsClosed:true}))).verified,true);}
  finally{IDBObjectStore.prototype.add=native;}
  assert.deepEqual(await snapshot(f),before);
});
test('different backup cannot overwrite staged recovery',async()=>{
  const f=await fixture(),controller=new AbortController();
  const api=createApi(f,{onProgress:p=>{if(p.phase==='verifying')controller.abort();}}),plan=await prepared(f,backup(),api);
  await assert.rejects(api.restore(plan,{signal:controller.signal,confirmedOtherTabsClosed:true}),e=>e.code==='CANCELLED');
  const before=await snapshot(f),other=backup();other.drawingStates['synthetic-drawing'].shapes[0].memo='Synthetic different memo';
  const next=createApi(f),p=await prepared(f,other,next);await assert.rejects(onlyAdds(()=>next.restore(p,{confirmedOtherTabsClosed:true})),e=>e.code==='OTHER_BACKUP');
  assert.deepEqual(await snapshot(f),before);assert(!(await rawRows(f))[FILES].keys.includes(META));
});
test('same-size Blob tampering before final proof is detected without repairing or overwriting it',async()=>{
  const f=await fixture(),native=IDBDatabase.prototype.transaction,nativePut=IDBObjectStore.prototype.put;let stages=0,tampered;
  IDBDatabase.prototype.transaction=function(names,mode,...args){
    if(this.name===DB&&mode==='readwrite'&&++stages===2){
      const tx=native.call(this,names,mode,...args);tampered=finished(tx);
      nativePut.call(tx.objectStore(FILES),new Blob([new Uint8Array(Buffer.byteLength('Synthetic shared photo bytes 日本語'))],{type:'image/jpeg'}),'photo:synthetic-drawing:synthetic-photo');
    }
    return native.call(this,names,mode,...args);
  };
  try{const plan=await prepared(f);await assert.rejects(onlyAdds(()=>f.api.restore(plan,{confirmedOtherTabsClosed:true})),e=>e.code==='VERIFY_FAILED');await tampered;}
  finally{IDBDatabase.prototype.transaction=native;}
  const rows=await rawRows(f);assert(!rows[FILES].keys.includes(META));
  const blob=rows[FILES].values[rows[FILES].keys.indexOf('photo:synthetic-drawing:synthetic-photo')];assert.equal(await digest(blob),sha(new Uint8Array(blob.size)));
});
test('final Blob read timeout aborts finalization and leaves retryable stage',async()=>{
  const f=await fixture();let verifying=false;
  const api=createApi(f,{verifyTimeoutMs:30,operationTimeoutMs:2000,onProgress:p=>{if(p.phase==='verifying')verifying=true;},
    hashBlob:(blob,opts)=>verifying?new Promise(()=>{}):Hash.digest(blob,opts)});
  const plan=await prepared(f,backup(),api),start=Date.now();
  await assert.rejects(api.restore(plan,{confirmedOtherTabsClosed:true}),e=>e.code==='REQUEST_TIMEOUT'&&e.persistence==='staged');
  assert(Date.now()-start<1000);assert(!(await rawRows(f))[FILES].keys.includes(META));
  const retry=createApi(f),p=await prepared(f,backup(),retry);assert.equal((await retry.restore(p,{confirmedOtherTabsClosed:true})).verified,true);
});
test('other DB appearing after staged commit stops before META, preserving its bytes',async()=>{
  const f=await fixture();let injected;
  const api=createApi(f,{onProgress:p=>{if(p.phase==='verifying'&&!injected)injected=seedOther(f.factory,OTHER[4],[['acks','synthetic-late-ack',{private:'synthetic keep'}]]);}});
  await assert.rejects(api.restore(await prepared(f,backup(),api),{confirmedOtherTabsClosed:true}),e=>e.code==='OTHER_DATA'||e.code==='CHANGED');
  await injected;assert(!(await rawRows(f))[FILES].keys.includes(META));
  const other=(await snapshot(f)).databases.find(x=>x.name===OTHER[4][0]);assert.deepEqual(other.stores[0].keys,['synthetic-late-ack']);
});
test('legacy data appearing after staged commit stops before META and is retained',async()=>{
  const f=await fixture();let changed=false;const api=createApi(f,{onProgress:p=>{if(p.phase==='verifying'&&!changed){changed=true;f.data.set(WS,'{"projects":[]}');}}});
  await assert.rejects(api.restore(await prepared(f,backup(),api),{confirmedOtherTabsClosed:true}),e=>e.code==='LEGACY_PRESENT');
  assert.equal(f.data.get(WS),'{"projects":[]}');assert(!(await rawRows(f))[FILES].keys.includes(META));
});
test('invalid/incomplete backup and mismatched photo bytes are rejected before storage access',async()=>{
  const f=await fixture(),before=await snapshot(f);
  for(const [mutate,code]of [[p=>delete p.drawingStates['synthetic-drawing'],'BACKUP_INCOMPLETE'],
    [p=>p.drawingStates['synthetic-drawing'].shapes[0].photos[0].size++,'BACKUP_MISMATCH'],
    [p=>p.files[0].data+='\n','BACKUP_INVALID'],[p=>p.format='sentlog-record-rescue','BACKUP_INVALID']]){
    const p=backup();mutate(p);await assert.rejects(f.api.prepare(asFile(p)),e=>e.code===code);
  }
  assert.deepEqual(await snapshot(f),before);
});
test('retained recovery intent coexists with ordinary edits, import and subsequent startup',async()=>{
  const f=await fixture(),plan=await prepared(f);await f.api.restore(plan,{confirmedOtherTabsClosed:true});
  const before=(await rawRows(f))[CONTROL],initialIntent=before.values[before.keys.indexOf(INTENT)];
  const records=recordsFor(f);await records.init();
  const key='surveyFieldNoteDrawingV1:synthetic-drawing',state=JSON.parse(records.getItem(key));
  state.shapes[0].memo='Synthetic subsequent edit';records.setItem(key,JSON.stringify(state));await records.settled();records.assertSafe();
  const next=backup();next.drawingStates['synthetic-drawing'].shapes[0].memo='Synthetic ordinary import';
  const decoded=Format.decode(JSON.stringify(next),{now:()=>0});await records.replaceAll(decoded.records,decoded.files);
  const row=(await rawRows(f))[CONTROL];assert.deepEqual(row.values[row.keys.indexOf(INTENT)],initialIntent);
  const reopened=recordsFor(f);await reopened.init();assert.equal(reopened.ready,true);
  assert.equal(JSON.parse(reopened.getItem(key)).shapes[0].memo,'Synthetic ordinary import');
  // The recovery screen never re-applies its original backup over later edits.
  const retry=createApi(f);await assert.rejects(retry.restore(await prepared(f,backup(),retry),{confirmedOtherTabsClosed:true}),e=>e.code==='RESIDUAL'||e.code==='VERIFY_FAILED');
});
test('public status hides native messages and contains no project/drawing identifiers',async()=>{
  const f=await fixture(),events=[],api=createApi(f,{onProgress:p=>events.push(p)}),p=await prepared(f,backup(),api);
  await api.restore(p,{confirmedOtherTabsClosed:true});const text=JSON.stringify(events)+JSON.stringify(p);
  assert(!text.includes('synthetic-project'));assert(!text.includes('synthetic-drawing'));assert(!text.includes('Synthetic memo'));
  const safe=Recovery.publicError(new DOMException('SYNTHETIC_PRIVATE_SECRET','QuotaExceededError'),'staged');assert(!JSON.stringify(safe).includes('SYNTHETIC_PRIVATE_SECRET'));
});

(async()=>{let passed=0;for(const {name,fn}of tests){await fn();passed++;console.log('PASS '+name);}console.log('PASS startup backup recovery '+passed+' cases');})()
  .catch(error=>{console.error(error);process.exitCode=1;});

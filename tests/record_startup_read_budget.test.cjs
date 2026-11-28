'use strict';
// Real writer/init/public binding APIs against disposable IndexedDB. Bulk IPC
// requests are forbidden, and every retained Blob is compared by SHA-256.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module'),{createHash}=require('node:crypto');
const {IDBFactory,IDBObjectStore,IDBIndex}=require('fake-indexeddb');
const fixturePath=path.join(__dirname,'delta_app_journal.test.cjs');
const fixtureSource=fs.readFileSync(fixturePath,'utf8').split('let passed=0;async function test(')[0]
  .replace("fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8')", "fs.readFileSync(process.env.SENTLOG_RECORD_SOURCE||path.join(__dirname,'../sentlog/record-store.js'),'utf8')");
const {app,bind,edit,scope,localProjectId,WS,DRAW,PREFIX,LOG,CONTROL}=new Function('require','__dirname',fixtureSource+
  '\nreturn {app,bind,edit,scope,localProjectId,WS,DRAW,PREFIX,LOG,CONTROL};')(createRequire(fixturePath),__dirname);
const stores=['files',LOG,CONTROL],json=JSON.stringify,copy=structuredClone;

async function fingerprint(value){
  if(value instanceof Blob)return {blob:true,type:value.type,size:value.size,
    sha256:createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex')};
  if(value instanceof Map)return Promise.all([...value].map(async([key,item])=>[key,await fingerprint(item)]));
  if(Array.isArray(value))return Promise.all(value.map(fingerprint));
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.keys(value).sort().map(async key=>[key,await fingerprint(value[key])])));
  return value;
}
async function disk(f){const out=new Map();for(const name of stores)out.set(name,await f.disk(name));return out;}
async function transaction(f,names,run){
  const db=await f.records.openFilesDatabase();try{
    const tx=db.transaction(names,'readwrite'),done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    run(tx);await done;
  }finally{db.close();}
}
async function seed(){
  const f=await app(),workspace=JSON.parse(f.records.getItem(WS)),drawings=[];
  for(let n=0;n<32;n++)drawings.push({id:'foreign-'+n,name:'Unrelated drawing '+n});
  workspace.projects.push({id:'foreign',name:'Unrelated retained project',drawings});
  f.records.batch([[WS,json(workspace)],...drawings.map(d=>[DRAW+d.id,json({shapes:[],memo:('body '+d.id+' ').repeat(1024)})])]);
  await f.records.settled();
  await f.records.writeFile('background:drawing-1',new Blob(['unchanged cutoff PDF bytes'],{type:'application/pdf'}));
  await f.records.writeFile('photo:drawing-1:cutoff',new Blob(['unchanged cutoff photo bytes'],{type:'image/jpeg'}));
  await bind(f,{metadata:true,serverRevision:9});
  edit(f,'未送信の記録を完全に保持');await f.records.settled();
  await f.records.writeFile('photo:drawing-1:unsent',new Blob(['unsent camera original bytes'],{type:'image/jpeg'}));
  await transaction(f,['files',CONTROL],tx=>{
    for(let n=0;n<96;n++)tx.objectStore('files').put(new Blob([`unrelated original ${n}`],{type:'image/jpeg'}),'photo:foreign-'+(n%32)+':'+n);
    for(let n=0;n<48;n++)tx.objectStore(CONTROL).put({version:1,kind:'retention-receipt',seq:10000+n,descriptor:'retained receipt '.repeat(64)},'retention-receipt:'+(10000+n));
  });
  const binding=f.records.deltaJournal.bindingFor(localProjectId),pending=await f.records.deltaJournal.pending({scope,localProjectId});
  assert.equal(binding.cutoff.files.length,2);assert(Object.keys(binding.metadataRecords).length>0);assert.equal(pending.count,2);
  return {f,binding,pending,rows:await disk(f)};
}
async function observe(run){
  const saved=[],events=[],wrapped=new WeakSet();
  function watch(request,store,index){
    request.addEventListener('success',()=>{
      const cursor=request.result;if(!cursor||wrapped.has(cursor))return;wrapped.add(cursor);
      const descriptor=Object.getOwnPropertyDescriptor(cursor,'value');
      assert(descriptor&&descriptor.configurable&&'value'in descriptor,'fixture must observe real cursor value reads');
      let value=descriptor.value;
      Object.defineProperty(cursor,'value',{configurable:true,enumerable:true,get(){events.push({method:'value',store,index,key:cursor.primaryKey});return value;},set(next){value=next;}});
    });return request;
  }
  for(const prototype of [IDBObjectStore.prototype,IDBIndex.prototype])for(const method of ['getAll','getAllKeys','get','openCursor','openKeyCursor']){
    const original=prototype[method];if(typeof original!=='function')continue;saved.push([prototype,method,original]);
    prototype[method]=function(...args){
      const store=this.objectStore?.name||this.name,index=this.objectStore?this.name:null;
      events.push({method,store,index,key:args[0]});
      if(['getAll','getAllKeys'].includes(method)&&['files',CONTROL].includes(store))throw Error('FORBIDDEN_STARTUP_BULK_READ '+store+' '+method);
      const request=original.apply(this,args);return method==='openCursor'?watch(request,store,index):request;
    };
  }
  try{return {value:await run(),events};}finally{for(const [prototype,method,original]of saved)prototype[method]=original;}
}
async function verifyReopen(seedData,factory=seedData.f.factory,local=seedData.f.local){
  const before=await fingerprint(seedData.rows);
  const observed=await observe(async()=>{
    const reopened=await app({factory,local});
    assert.equal(reopened.records.getItem(WS),seedData.rows.get('files').get(PREFIX+WS));
    for(const [key,value]of seedData.rows.get('files'))if(String(key).startsWith(PREFIX))
      assert.equal(reopened.records.getItem(String(key).slice(PREFIX.length)),value,'normal editor mirror changed');
    assert.deepEqual(await fingerprint(reopened.records.deltaJournal.bindingFor(localProjectId)),await fingerprint(seedData.binding));
    const all=reopened.records.deltaJournal.listBindingsSync();assert.equal(all.length,1);
    assert.deepEqual(await fingerprint(all[0]),await fingerprint(seedData.binding));
    assert.deepEqual(await fingerprint(await reopened.records.deltaJournal.readCutoff({scope,localProjectId})),await fingerprint(seedData.binding.cutoff));
    return reopened;
  });
  assert.deepEqual(copy(await observed.value.records.deltaJournal.pending({scope,localProjectId})),copy(seedData.pending));
  assert.deepEqual(await fingerprint(await disk(observed.value)),before,'startup changed metadata, unsent WAL or stored original bytes');
  const fileCursorValues=observed.events.filter(e=>e.method==='value'&&e.store==='files');
  assert(fileCursorValues.length>=34,'fixture must load actual current record bodies');
  assert(fileCursorValues.every(e=>String(e.key).startsWith(PREFIX)),'normal startup must never cursor-read live PDF/photo Blob bodies');
  return observed;
}

const tests=[],test=(name,run)=>tests.push({name,run});
test('indexed normal startup uses bounded cursor requests and preserves complete binding cutoffs, metadata and unsent work',async()=>{
  const seeded=await seed(),observed=await verifyReopen(seeded);
  assert(observed.events.some(e=>e.method==='openKeyCursor'&&e.store===CONTROL&&e.index==='kind'));
  assert(observed.events.some(e=>e.method==='openCursor'&&e.store===CONTROL&&e.index==='kind'));
  assert(!observed.events.some(e=>e.method==='value'&&e.store===CONTROL&&String(e.key).startsWith('retention-receipt:')));
});
test('existing version-two stores without kind indexes retain the same full APIs and exact original bytes',async()=>{
  const seeded=await seed(),factory=new IDBFactory();
  const db=await new Promise((resolve,reject)=>{const request=factory.open('surveyFieldNoteDB',2);
    request.onupgradeneeded=()=>{for(const name of stores)request.result.createObjectStore(name);};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(stores,'readwrite');
    for(const [name,rows]of seeded.rows)for(const [key,value]of rows)tx.objectStore(name).put(value,key);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  const observed=await verifyReopen(seeded,factory,new Map());
  assert(observed.events.some(e=>e.method==='openKeyCursor'&&e.store===CONTROL&&e.index===null));
  assert(observed.events.some(e=>e.method==='openCursor'&&e.store===CONTROL&&e.index===null));
});
test('a missing protected cutoff row still stops startup without repairing or overwriting saved records',async()=>{
  const seeded=await seed(),row=[...seeded.rows.get(CONTROL)].find(([,value])=>value?.kind==='cutoff-file');assert(row);
  await transaction(seeded.f,[CONTROL],tx=>tx.objectStore(CONTROL).delete(row[0]));
  const before=await fingerprint(await disk(seeded.f));
  await assert.rejects(observe(()=>app({factory:seeded.f.factory,local:seeded.f.local})),error=>error.code==='JOURNAL_CUTOFF_REF');
  assert.deepEqual(await fingerprint(await disk(seeded.f)),before);
});
(async()=>{for(const {name,run}of tests){await run();console.log('PASS',name);}console.log(tests.length+' normal startup read-budget tests passed');})().catch(error=>{console.error(error);process.exitCode=1;});

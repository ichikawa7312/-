'use strict';
// Actual writer and durable replay controller. Request guards make a return to
// bulk hydration fail deterministically without requiring an out-of-memory run.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{IDBFactory,IDBObjectStore,IDBIndex,IDBCursor}=require('fake-indexeddb');
const fixturePath=path.join(__dirname,'delta_app_journal.test.cjs');
const fixtureSource=fs.readFileSync(fixturePath,'utf8').split('let passed=0;async function test(')[0]
  .replace("fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8')", "fs.readFileSync(process.env.SENTLOG_RECORD_SOURCE||path.join(__dirname,'../sentlog/record-store.js'),'utf8')");
const {app,bind,edit,scope,localProjectId,WS,DRAW,PREFIX,LOG,CONTROL,META,M}=new Function('require','__dirname',fixtureSource+
  '\nreturn {app,bind,edit,scope,localProjectId,WS,DRAW,PREFIX,LOG,CONTROL,META,M};')(createRequire(fixturePath),__dirname);
const copy=structuredClone,json=JSON.stringify,AFTER=1000;
async function transaction(f,stores,run){const db=await f.records.openFilesDatabase();try{
  const tx=db.transaction(stores,'readwrite'),done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});run(tx);await done;
}finally{db.close();}}
async function update(f,store,key,change){await transaction(f,[store],tx=>{const s=tx.objectStore(store),q=s.get(key);q.onsuccess=()=>s.put(change(q.result),key);});}
async function base(){
  const f=await app(),workspace=JSON.parse(f.records.getItem(WS));workspace.projects.push({id:'foreign',name:'Other project',drawings:[{id:'foreign-drawing'}]});
  f.records.batch([[WS,json(workspace)],[DRAW+'foreign-drawing',json({shapes:[],memo:'unrelated current record'})]]);await f.records.settled();
  const e=await bind(f,{metadata:true});Object.assign(f.ctx,{setTimeout,clearTimeout});return {f,e};
}
async function history(){
  const {f,e}=await base(),large=json({shapes:[],memo:'old foreign history '.repeat(2048)}),blob=new Blob(['preserved file history'],{type:'image/jpeg'});
  await transaction(f,[LOG,CONTROL],tx=>{
    const log=tx.objectStore(LOG),control=tx.objectStore(CONTROL);
    for(let seq=1;seq<=128;seq++)log.put({version:1,kind:'sentlog-app-intent',id:'old:'+seq,seq,at:seq,sourceRevision:0,
      mutationKind:'batch',projectIds:['foreign'],drawingIds:['foreign-drawing'],contexts:[{origin:'local',operation:'edit'}],
      changes:[{key:DRAW+'foreign-drawing',before:large,after:large+' '}],files:[]},seq);
    log.put({version:1,kind:'sentlog-file-retention',id:'retained:900',seq:900,projectIds:['foreign'],drawingIds:['foreign-drawing'],
      files:[{key:'photo:foreign-drawing:original',before:blob,after:blob}]},900);
    const q=control.get('binding:'+localProjectId);q.onsuccess=()=>{const binding=q.result;
      control.put({...binding,ackedSeq:AFTER,cutoffSeq:AFTER,cutoff:{...binding.cutoff,cutoffSeq:AFTER}},'binding:'+localProjectId);};
    control.put(AFTER,'clock');
  });
  return {f,e};
}
function projection(f){const writes=[WS,DRAW+'drawing-1'].map(key=>[key,f.records.getItem(key)]);
  return {scope,localProjectId,writes,expectedRecords:copy(writes),metadataRecords:copy(f.records.deltaJournal.bindingFor(localProjectId).metadataRecords),validate:()=>true};}
async function observe(run){
  const originals=[],events=[],wrapped=new WeakSet();
  const watchCursor=request=>{request.addEventListener('success',()=>{
    const cursor=request.result;if(!cursor||wrapped.has(cursor))return;wrapped.add(cursor);
    const descriptor=Object.getOwnPropertyDescriptor(cursor,'value');
    assert(descriptor&&descriptor.configurable&&'value'in descriptor,'fixture must expose actual cursor value access');let value=descriptor.value;
    Object.defineProperty(cursor,'value',{configurable:true,enumerable:true,get(){
      const store=cursor.source.objectStore?.name||cursor.source.name;
      events.push({method:'value',store,key:cursor.primaryKey,kind:value?.kind});return value;
    },set(next){value=next;}});
  });return request;};
  for(const [prototype,methods]of [[IDBObjectStore.prototype,['getAll','getAllKeys','get','openCursor']],[IDBIndex.prototype,['getAll','openCursor']]]){
    for(const method of methods){const original=prototype[method];originals.push([prototype,method,original]);prototype[method]=function(...args){
      const store=this.objectStore?.name||this.name;events.push({method,store,key:args[0]});
      if(method==='getAll'&&[LOG,CONTROL,'files'].includes(store))throw Error('FORBIDDEN_BULK_READ '+store);
      const request=original.apply(this,args);return method==='openCursor'?watchCursor(request):request;
    };}
  }
  try{return {value:await run(),events};}finally{for(const [prototype,method,original]of originals)prototype[method]=original;}
}
async function oldReaders(f){
  let source=fs.readFileSync(require.resolve('../sentlog/record-store.js'),'utf8');
  const old=require('./fixtures/record_journal_readers_v214.cjs');
  for(const name of ['pending','claim']){const start=source.indexOf('    async '+name+'('),end=source.indexOf('\n    async ',start+1);
    assert(start>=0&&end>start);source=source.slice(0,start)+old[name]+source.slice(end);
  }
  const context={...f.ctx,SentlogRecords:undefined};context.window=context;vm.createContext(context);vm.runInContext(source,context);await context.SentlogRecords.init();return context.SentlogRecords;
}
const tests=[],test=(name,run)=>tests.push({name,run});
test('pending, idle claim and no-op projection skip acknowledged/retained values and unrelated current record bodies',async()=>{
  const {f}=await history(),files=await f.disk(),journal=await f.disk(LOG),control=await f.disk(CONTROL);
  const observed=await observe(async()=>{
    assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
    assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);
    assert.equal((await f.records.deltaJournal.applyProjection(projection(f))).applied,true);
  });
  assert(!observed.events.some(event=>event.method==='value'&&event.store===LOG&&event.key<=AFTER));
  assert(!observed.events.some(event=>event.method==='get'&&event.store==='files'&&event.key===PREFIX+DRAW+'foreign-drawing'));
  assert.deepEqual(await f.disk(),files);assert.deepEqual(await f.disk(LOG),journal);assert.deepEqual(await f.disk(CONTROL),control);
});
test('the preserved old reader fails the same bulk-read guard on the same large disposable history',async()=>{
  const {f}=await history(),prior=await oldReaders(f);
  await assert.rejects(observe(()=>prior.deltaJournal.pending({scope,localProjectId})),/FORBIDDEN_BULK_READ/);
});
test('browsers without continuePrimaryKey skip old values correctly using cursor continuation',async()=>{
  const {f}=await history(),original=IDBCursor.prototype.continuePrimaryKey;IDBCursor.prototype.continuePrimaryKey=undefined;
  try{const observed=await observe(()=>f.records.deltaJournal.pending({scope,localProjectId}));assert.equal(observed.value.count,0);
    assert(!observed.events.some(event=>event.method==='value'&&event.store===LOG&&event.key<=AFTER));
  }finally{IDBCursor.prototype.continuePrimaryKey=original;}
});
test('actual offline controller drains new record/file work without bulk journal or managed-record reads',async()=>{
  const {f,e}=await history(),originalHistory=await f.disk(LOG),photo=new Blob(['new original camera bytes'],{type:'image/jpeg'});
  const observed=await observe(async()=>{
    edit(f,'new local edit');await f.records.settled();await f.records.writeFile('photo:drawing-1:new',photo);
    assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,2);
    const controller=e.controller();try{await controller.controller.drain();}finally{controller.close();}
    assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  });
  assert(observed.events.some(event=>event.store===LOG&&event.method==='openCursor'));
  assert(e.read().outbox.length>0);assert(f.records.getItem(DRAW+'drawing-1').includes('new local edit'));
  const after=await f.disk(LOG);for(const [key,value]of originalHistory)assert.deepEqual(after.get(key),value,'foreign unsent history or original file retention changed');
  assert.equal(await (await f.disk()).get('photo:drawing-1:new').text(),await photo.text());
});
test('orphan intents between cutoff and ACK retain old-reader counts and still block incoming ownership',async()=>{
  const {f}=await base(),key=DRAW+'orphan';f.records.setItem(key,json({shapes:[],memo:'unassigned original'}));await f.records.settled();
  await update(f,CONTROL,'binding:'+localProjectId,binding=>({...binding,ackedSeq:AFTER}));
  const prior=await oldReaders(f),expected=await prior.deltaJournal.pending({scope,localProjectId});assert.equal(expected.count,1);
  const observed=await observe(()=>f.records.deltaJournal.pending({scope,localProjectId}));assert.deepEqual(copy(observed.value),copy(expected));
  const input=projection(f),workspace=JSON.parse(input.writes[0][1]);workspace.projects.find(project=>project.id===localProjectId).drawings.push({id:'orphan'});
  input.writes[0][1]=json(workspace);input.writes.push([key,f.records.getItem(key)]);input.expectedRecords.push([key,f.records.getItem(key)]);
  const before=await f.disk(),result=await observe(()=>f.records.deltaJournal.applyProjection(input));assert.equal(result.value.deferred,true);assert.deepEqual(await f.disk(),before);
});
test('an existing replay claim is returned unchanged without opening a WAL cursor',async()=>{
  const {f}=await history();edit(f,'claim this edit');await f.records.settled();const first=await f.records.deltaJournal.claim({scope,localProjectId});
  const observed=await observe(()=>f.records.deltaJournal.claim({scope,localProjectId}));assert.deepEqual(copy(observed.value),copy(first));
  assert(!observed.events.some(event=>event.store===LOG&&event.method==='openCursor'));
});
test('legacy version-two stores without kind indexes retain scoped reader behavior and exact bytes',async()=>{
  const {f}=await history(),rows=new Map();for(const name of ['files',LOG,CONTROL])rows.set(name,await f.disk(name));
  const factory=new IDBFactory(),db=await new Promise((resolve,reject)=>{const q=factory.open('surveyFieldNoteDB',2);
    q.onupgradeneeded=()=>{for(const name of rows.keys())q.result.createObjectStore(name);};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction([...rows.keys()],'readwrite');
    for(const [name,entries]of rows)for(const [key,value]of entries)tx.objectStore(name).put(value,key);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  const reopened=await app({factory,local:new Map()});const observed=await observe(async()=>{
    assert.equal((await reopened.records.deltaJournal.pending({scope,localProjectId})).count,0);
    assert.equal(await reopened.records.deltaJournal.claim({scope,localProjectId}),null);
    assert.equal((await reopened.records.deltaJournal.applyProjection(projection(reopened))).applied,true);
  });
  assert(!observed.events.some(event=>event.method==='value'&&event.store===LOG&&event.key<=AFTER));
  for(const [name,entries]of rows)assert.deepEqual(await reopened.disk(name),entries);
});
(async()=>{for(const {name,run}of tests){await run();console.log('PASS',name);}console.log(tests.length+' scoped journal read-budget tests passed');})().catch(error=>{console.error(error);process.exitCode=1;});

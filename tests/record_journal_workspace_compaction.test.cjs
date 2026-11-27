'use strict';
// Real writer/old production readers and replay controller; disposable synthetic
// FakeIndexedDB only. Logical UTF-8 savings are not physical-disk measurements.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange,IDBObjectStore,IDBCursor}=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const B=require('../sentlog/delta-sync-app-bridge.js'),J=require('../sentlog/delta-sync-app-journal.js'),M=require('../sentlog/delta-sync-metadata.js');
const oldReaders=require('./fixtures/record_journal_readers_v214.cjs');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const code=fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',PREFIX='__sentlog_record__:';
const LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1',META='__sentlog_records_meta_v130__';
const scope={ownerId:'synthetic-owner',projectId:'synthetic-cloud',deviceId:'synthetic-device'},pid='synthetic-project';
const actor={deviceId:scope.deviceId,deviceName:'Synthetic'},clone=structuredClone,json=JSON.stringify;
function legacyReaderSource(){
  let source=code;
  for(const [name,end]of [['pending','begin'],['claim','verifyReplay']]){
    const start=source.indexOf('    async '+name+'('),stop=source.indexOf('    async '+end+'(',start);
    assert(start>=0&&stop>start);source=source.slice(0,start)+oldReaders[name]+source.slice(stop);
  }
  return source;
}
async function app({factory=new IDBFactory(),local=new Map(),padding='synthetic 日本語 😀 '.repeat(2000),legacyReader=false}={}){
  if(!(await factory.databases()).length){
    const first={id:pid,name:'Synthetic project',drawings:[{id:'one',name:'One'}]},other={id:'other-project',name:'Other project',drawings:[{id:'two',name:'Two'}]};
    local.set(WS,json({projects:[first,other],padding}));
    for(const id of ['one','two'])local.set(DRAW+id,json({shapes:[C.upgrade({id:'record-'+id,type:'腐食',memo:'initial '+id,photos:[]})],collabDeletedRecords:[]}));
  }
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,crypto:webcrypto,SentlogDeltaSyncCore:D};
  context.window=context;vm.createContext(context);vm.runInContext(legacyReader?legacyReaderSource():code,context);
  const records=context.SentlogRecords;await records.init();
  async function disk(){const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(['files',LOG,CONTROL],'readonly'),out={};
    for(const name of ['files',LOG,CONTROL]){const store=tx.objectStore(name),keys=store.getAllKeys(),values=store.getAll();values.onsuccess=()=>out[name]=new Map(keys.result.map((key,i)=>[key,values.result[i]]));}
    tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}}
  async function alterRows(fn){const db=await records.openFilesDatabase();try{await new Promise((resolve,reject)=>{
    const tx=db.transaction(LOG,'readwrite'),store=tx.objectStore(LOG),q=store.getAll();
    q.onsuccess=()=>{for(const row of q.result){const next=fn(clone(row));if(next)store.put(next,row.seq);}};
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}}
  return {records,factory,local,disk,alterRows,capture:()=>B.captureProject({records,localProjectId:pid})};
}
async function bind(f,{staging=false}={}){
  const cutoff=await f.records.deltaJournal.begin({scope,localProjectId:pid,actor}),base=clone(cutoff.snapshot),metadata=await M.seed(base);
  const initial={...metadata};for(const drawing of base.drawings)for(const record of drawing.state.shapes)initial[D.keyOf(drawing.meta.id,record.id)]=C.upgrade(record);
  let durable={version:2,scope:clone(scope),cursor:0,records:initial,outbox:[]};
  const store={read:async()=>clone(durable),readForVerification:async()=>clone(durable),write:async value=>{durable=clone(value);}};
  async function activate(records=f.records){await records.deltaJournal.activate({scope,localProjectId:pid,baselineId:'synthetic-baseline',baselineSnapshot:base,metadataRecords:M.metadataRecords(initial)});}
  if(!staging)await activate();
  function controller(){
    const transport={online:()=>false,push:async()=>{throw Error('offline');},pushGroup:async()=>{throw Error('offline');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
    const replica=D.createReplica({...scope,store,transport}),bridge=B.createBridge({replica,scope,localProjectId:pid,currentScope:()=>scope});
    const controller=J.createController({records:f.records,scope,localProjectId:pid,replica,replicaStore:store,bridge,currentScope:()=>scope,metadata:M});
    return {controller,close(){controller.close();bridge.close();replica.close();}};
  }
  return {cutoff,activate,controller,read:()=>clone(durable)};
}
async function edit(f,text){const value=JSON.parse(f.records.getItem(DRAW+'one'));value.shapes[0].memo=text;f.records.setItem(DRAW+'one',json(value));await f.records.settled();}
async function oldRows(f){const workspace=f.records.getItem(WS);await f.alterRows(row=>{
  if(row.kind!=='sentlog-app-intent'||row.files.length)return row;
  const change=row.changes.find(entry=>entry.key===WS);row.workspaceBefore=change?change.before:workspace;row.workspaceAfter=change?change.after:workspace;return row;
});}
function withoutCopies(row){const next=clone(row);delete next.workspaceBefore;delete next.workspaceAfter;return next;}
async function mutations(fn){const originals=[],events=[];
  for(const [prototype,methods]of [[IDBObjectStore.prototype,['put','add','delete','clear']],[IDBCursor.prototype,['update','delete']]])for(const name of methods){
    const native=prototype[name];originals.push([prototype,name,native]);prototype[name]=function(...args){events.push(name);return native.apply(this,args);};
  }
  try{await fn();return events;}finally{for(const [prototype,name,native]of originals)prototype[name]=native;}
}
const cases=[],test=(name,fn)=>cases.push([name,fn]);
test('new real staged edits stop storing two unused whole-workspace copies but keep every change and order',async()=>{
  const f=await app();await bind(f,{staging:true});const workspace=f.records.getItem(WS),before=await f.disk();
  for(let n=1;n<=12;n++)await edit(f,'staged '+n);
  const after=await f.disk(),rows=[...after[LOG].values()];assert.equal(rows.length,12);
  assert(rows.every(row=>!('workspaceBefore'in row)&&!('workspaceAfter'in row)&&row.version===1&&row.kind==='sentlog-app-intent'));
  for(let i=0;i<rows.length;i++){
    assert.equal(rows[i].changes.length,1);assert.equal(JSON.parse(rows[i].changes[0].after).shapes[0].memo,'staged '+(i+1));
    assert.equal(rows[i].changes[0].before,i?rows[i-1].changes[0].after:before.files.get(PREFIX+DRAW+'one'));
  }
  const compact=await f.records.deltaJournal.compact();assert.equal(compact.removed,0);assert.equal((await f.disk())[LOG].size,12);
  const extraBytes=rows.length*2*Buffer.byteLength(workspace,'utf8');assert(extraBytes>1000000,'Fixture must show meaningful repeated payload size');
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:pid})).count,12);
});
test('workspace changes retain exact old/new text once, and frozen v2.14 readers reconstruct both projects after restart',async()=>{
  const f=await app(),e=await bind(f,{staging:true}),original=f.records.getItem(WS);await edit(f,'before rename');
  const workspace=JSON.parse(original);workspace.projects[0].name='Renamed own project';workspace.projects[1].name='Renamed other project';
  const value=json(workspace);f.records.setItem(WS,value);await f.records.settled();await edit(f,'after rename');
  const rows=[...(await f.disk())[LOG].values()],row=rows.find(row=>row.changes.some(change=>change.key===WS));
  assert.deepEqual(row.changes.find(change=>change.key===WS),{key:WS,before:original,after:value});assert(!('workspaceBefore'in row));
  const reopened=await app({factory:f.factory,local:f.local,legacyReader:true});await e.activate(reopened.records);
  assert.equal((await reopened.records.deltaJournal.pending({scope,localProjectId:pid})).count,3);
  const claim=await reopened.records.deltaJournal.claim({scope,localProjectId:pid});
  assert.equal(claim.before.project.name,'Synthetic project');assert.equal(claim.after.project.name,'Renamed own project');
  assert.equal(claim.before.drawings[0].state.shapes[0].memo,'initial one');assert.equal(claim.after.drawings[0].state.shapes[0].memo,'after rename');
  assert.equal(JSON.parse(claim.expectedRecords.find(([key])=>key===WS)[1]).projects[1].name,'Renamed other project');
  assert.deepEqual(claim.rowIds,rows.map(row=>row.id));
});
test('default preview performs no mutations; explicit maintenance trims only identical copies of current durable workspace',async()=>{
  const f=await app();await bind(f,{staging:true});await edit(f,'old pending one');await edit(f,'old pending two');await oldRows(f);
  const before=await f.disk(),workspace=f.records.getItem(WS);let preview;
  assert.equal((await mutations(async()=>{preview=await f.records.deltaJournal.compactRedundantRecords();})).length,0);
  assert.equal(preview.eligible,2);assert.equal(preview.updated,0);assert.equal(preview.logicalBytesRemoved,0);
  assert.equal(preview.logicalBytesEligible,4*Buffer.byteLength(workspace,'utf8'));assert.equal(preview.done,true);assert.deepEqual(await f.disk(),before);
  const changed=await f.records.deltaJournal.compactRedundantRecords({dryRun:false}),after=await f.disk();
  assert.equal(changed.updated,2);assert.equal(changed.logicalBytesRemoved,preview.logicalBytesEligible);assert.equal(changed.done,true);
  assert.deepEqual(after.files,before.files);assert.deepEqual(after[CONTROL],before[CONTROL]);
  for(const [seq,row]of before[LOG])assert.deepEqual(after[LOG].get(seq),withoutCopies(row));
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:pid})).count,2);assert.equal(f.records.failed,false);
});
test('old-format workspace changes have a self-contained proof even when their old text is no longer current',async()=>{
  const f=await app();await bind(f,{staging:true});const original=f.records.getItem(WS);
  const first=JSON.parse(original);first.projects[0].name='first rename';f.records.setItem(WS,json(first));await f.records.settled();
  const second=clone(first);second.projects[0].name='second rename';f.records.setItem(WS,json(second));await f.records.settled();await oldRows(f);
  const before=await f.disk(),result=await f.records.deltaJournal.compactRedundantRecords({dryRun:false}),after=await f.disk();
  assert.equal(result.updated,2);for(const [seq,row]of before[LOG])assert.deepEqual(after[LOG].get(seq),withoutCopies(row));
  assert.equal([...after[LOG].values()][0].changes[0].before,original);
});
test('an unproven historical workspace, file bytes, lifecycle intents, and retained file histories are untouched',async()=>{
  const f=await app();await bind(f,{staging:true});for(let i=0;i<5;i++)await edit(f,'preserve '+i);await oldRows(f);
  await f.alterRows(row=>{
    if(row.seq===1){row.workspaceBefore=row.workspaceAfter=json({projects:[],uniqueHistoricalText:'must remain'});}
    if(row.seq===2)row.files=[{key:'background:one',before:new Blob(['unique old PDF']),after:new Blob(['new PDF'])}];
    if(row.seq===3)row.contexts=[{origin:'local',operation:'restore'}];
    if(row.seq===4)row.kind='sentlog-file-retention';
    if(row.seq===5)row.contexts=[{origin:'local',operation:'archive-local',context:{localArchive:true}}];
    return row;
  });
  const before=await f.disk(),result=await f.records.deltaJournal.compactRedundantRecords({dryRun:false});
  assert.equal(result.updated,0);assert.equal(result.logicalBytesRemoved,0);assert.equal(result.skippedUnproven,4);assert.deepEqual(await f.disk(),before);
  assert.equal(await [...before[LOG].values()][1].files[0].before.text(),'unique old PDF');
});
test('a stable replay claim pins old rows throughout preview and execution',async()=>{
  const f=await app();await bind(f);await edit(f,'claimed draft');await oldRows(f);
  const claim=await f.records.deltaJournal.claim({scope,localProjectId:pid}),before=await f.disk();
  const result=await f.records.deltaJournal.compactRedundantRecords({dryRun:false});
  assert.equal(result.updated,0);assert.equal(result.skippedClaims,1);assert.deepEqual(await f.disk(),before);
  const old=await app({factory:f.factory,local:f.local,legacyReader:true});assert.deepEqual(await old.records.deltaJournal.claim({scope,localProjectId:pid}),claim);
});
test('bounded cursors resume without losing pending rows and a fresh preview rechecks intervening content',async()=>{
  const f=await app();await bind(f,{staging:true});for(let i=0;i<5;i++)await edit(f,'bounded '+i);await oldRows(f);
  const before=await f.disk();let cursor=0,total=0,passes=0;
  do{const result=await f.records.deltaJournal.compactRedundantRecords({cursor,scanLimit:2,limit:2,dryRun:false});
    assert(result.scanned<=2&&result.updated<=2);total+=result.updated;passes++;cursor=result.nextCursor;if(result.done)break;
  }while(passes<10);
  assert.equal(total,5);assert.equal(passes,3);assert.equal((await f.disk())[LOG].size,5);
  assert.deepEqual((await f.disk()).files,before.files);assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:pid})).count,5);
  await oldRows(f);const preview=await f.records.deltaJournal.compactRedundantRecords({dryRun:true});assert.equal(preview.eligible,5);
  await f.alterRows(row=>{if(row.seq===1)row.workspaceAfter=json({projects:[],unique:'changed after preview'});return row;});
  const execution=await f.records.deltaJournal.compactRedundantRecords({cursor:0,dryRun:false});assert.equal(execution.updated,4);assert.equal(execution.skippedUnproven,1);
  assert.equal((await f.disk())[LOG].get(1).workspaceAfter,json({projects:[],unique:'changed after preview'}));
});
test('an update failure rolls back the entire maintenance pass and remains explicitly retryable',async()=>{
  const f=await app();await bind(f,{staging:true});await edit(f,'one');await edit(f,'two');await oldRows(f);const before=await f.disk(),native=IDBCursor.prototype.update;let writes=0;
  IDBCursor.prototype.update=function(...args){if(this.source.name===LOG&&++writes===2)throw new DOMException('synthetic maintenance failure','UnknownError');return native.apply(this,args);};
  try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantRecords({dryRun:false}),e=>e.name==='UnknownError');}finally{IDBCursor.prototype.update=native;}
  assert.equal(writes,2);assert.deepEqual(await f.disk(),before);assert.equal(f.records.failed,false);assert.equal(f.records.pending,false);
  assert.equal((await f.records.deltaJournal.compactRedundantRecords({dryRun:false})).updated,2);
});
test('new editor input during a maintenance transaction aborts trimming and the subsequent real save still commits',async()=>{
  const f=await app();await bind(f,{staging:true});await edit(f,'before one');await edit(f,'before two');await oldRows(f);
  const before=await f.disk(),native=IDBCursor.prototype.update;let injected=false;
  IDBCursor.prototype.update=function(...args){const request=native.apply(this,args);
    if(this.source.name===LOG&&!injected){injected=true;request.addEventListener('success',()=>{
      const value=JSON.parse(f.records.getItem(DRAW+'one'));value.shapes[0].memo='new input during maintenance';f.records.setItem(DRAW+'one',json(value));
    });}return request;};
  try{await assert.rejects(()=>f.records.deltaJournal.compactRedundantRecords({dryRun:false}),e=>e.code==='JOURNAL_MAINTENANCE_BUSY');}
  finally{IDBCursor.prototype.update=native;}
  assert.equal(injected,true);await f.records.settled();const after=await f.disk();
  for(const [seq,row]of before[LOG])assert.deepEqual(after[LOG].get(seq),row);
  assert.equal(after[LOG].size,before[LOG].size+1);assert.equal(JSON.parse(after.files.get(PREFIX+DRAW+'one')).shapes[0].memo,'new input during maintenance');
  assert.equal(f.records.failed,false);assert.equal(f.records.pending,false);
});
test('a pending guarded file writer blocks cleanup without changing either its bytes or existing journal rows',async()=>{
  const f=await app();await bind(f,{staging:true});await edit(f,'record before photo');await oldRows(f);const before=await f.disk();
  const saving=f.records.writeFile('photo:one:guarded',new Blob(['synthetic photo']),{validate:()=>true});
  await assert.rejects(()=>f.records.deltaJournal.compactRedundantRecords({dryRun:false}),e=>e.code==='JOURNAL_MAINTENANCE_BUSY');await saving;
  const after=await f.disk();for(const [seq,row]of before[LOG])assert.deepEqual(after[LOG].get(seq),row);
  assert.equal(await after.files.get('photo:one:guarded').text(),'synthetic photo');assert.equal(f.records.failed,false);
});
test('pending input, a foreign-tab revision, and malformed options stop maintenance without losing input',async()=>{
  const f=await app();await bind(f,{staging:true});await edit(f,'old');await oldRows(f);
  const value=JSON.parse(f.records.getItem(DRAW+'one'));value.shapes[0].memo='pending user input';f.records.setItem(DRAW+'one',json(value));
  await assert.rejects(()=>f.records.deltaJournal.compactRedundantRecords({dryRun:false}),e=>e.code==='JOURNAL_MAINTENANCE_BUSY');await f.records.settled();
  assert.equal(JSON.parse(f.records.getItem(DRAW+'one')).shapes[0].memo,'pending user input');
  for(const options of [{dryRun:'yes'},{cursor:-1},{scanLimit:0},{limit:100,scanLimit:1},{limit:257,scanLimit:300}])
    await assert.rejects(()=>f.records.deltaJournal.compactRedundantRecords(options),e=>e.code==='JOURNAL_MAINTENANCE_OPTIONS');
  const other=await app({factory:f.factory,local:f.local});await edit(other,'other tab latest');const before=await f.disk();
  await assert.rejects(()=>f.records.deltaJournal.compactRedundantRecords({dryRun:false}),e=>e.code==='JOURNAL_STALE');assert.deepEqual(await f.disk(),before);
});
test('UTF-8 accounting handles Japanese, supplementary characters and unpaired surrogates without allocating a Blob',async()=>{
  const f=await app({padding:'日本語 😀 \ud800 end'});await bind(f,{staging:true});await edit(f,'unicode');await oldRows(f);
  const workspace=f.records.getItem(WS),result=await f.records.deltaJournal.compactRedundantRecords({dryRun:false});
  assert.equal(result.logicalBytesRemoved,2*Buffer.byteLength(workspace,'utf8'));
});
test('mixed old/reduced staged rows survive restart and real replica replay, then existing verified compaction removes only acknowledged intents',async()=>{
  const f=await app(),e=await bind(f,{staging:true});await edit(f,'legacy first');await oldRows(f);await edit(f,'new second');
  const before=await f.disk(),ids=[...before[LOG].values()].map(row=>row.id);assert.equal((await f.records.deltaJournal.compactRedundantRecords({dryRun:false})).updated,1);
  const reopened=await app({factory:f.factory,local:f.local,legacyReader:true});f.records=reopened.records;f.capture=reopened.capture;await e.activate(f.records);
  const oldClaim=await f.records.deltaJournal.claim({scope,localProjectId:pid});assert.deepEqual(oldClaim.rowIds,ids);
  assert.equal(oldClaim.before.drawings[0].state.shapes[0].memo,'initial one');assert.equal(oldClaim.after.drawings[0].state.shapes[0].memo,'new second');
  const c=e.controller();try{await c.controller.drain();assert(e.read().records[D.keyOf('one','record-one')].memo.includes('new second'));assert(e.read().outbox.length>0);
    assert.equal((await f.disk())[LOG].size,0);assert.equal((await f.records.deltaJournal.pending({scope,localProjectId:pid})).count,0);
  }finally{c.close();}
});
(async()=>{let passed=0,failed=0;for(const [name,fn]of cases)try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack);}
  console.log(json({passed,failed,total:cases.length,nativeBrowserExecuted:false,legacyProductionReaders:'a4a4bb5 v2.14',physicalBytesMeasured:false}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

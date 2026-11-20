'use strict';
// Historical embedded bindings are seeded directly in disposable IndexedDB.
// The current production writer must migrate them without re-putting a Blob
// inside a mutable binding, and its ordinary replay/GC APIs remain unchanged.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const B=require('../sentlog/delta-sync-app-bridge.js'),J=require('../sentlog/delta-sync-app-journal.js');
const M=require('../sentlog/delta-sync-metadata.js'),Source=require('../sentlog/delta-sync-legacy-source.js');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',PREFIX='__sentlog_record__:';
const CONTROL='sentlog_delta_control_v1',LOG='sentlog_delta_journal_v1',META='__sentlog_records_meta_v130__',LOCAL='sentlogArchiveLocalV1';
const copy=structuredClone,json=JSON.stringify;
const scopeFor=id=>({ownerId:'cutoff-owner',projectId:'cloud-'+id,deviceId:'cutoff-device'});
const actor={deviceId:'cutoff-device',deviceName:'Cutoff regression'};
const containsBlob=value=>value instanceof Blob||!!value&&typeof value==='object'&&Object.values(value).some(containsBlob);
const hash=async blob=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');
function builtWriter(){
 let code=fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8');
 const builder=fs.readFileSync(path.join(__dirname,'../scripts/build_capacity.py'),'utf8'),storage=/storage_code=r'''([\s\S]*?)'''/.exec(builder)?.[1];
 assert(storage,'actual capacity atomic writer injection must exist');
 code=code.replace('const managed=k=>k===WS ||',"const managed=k=>k==='sentlogArchiveLocalV1' || k===WS ||");
 return code.replace('  async function stats(){',storage+'\n  async function stats(){').replace('batch,replaceAll,stats,','batch,replaceAll,archiveAtomic,stats,');
}
function application(factory,memory){
 const localStorage={get length(){return memory.size;},key:i=>[...memory.keys()][i]??null,getItem:key=>memory.get(key)??null,
  setItem:(key,value)=>memory.set(key,String(value)),removeItem:key=>memory.delete(key)};
 const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,
  crypto:webcrypto,SentlogDeltaSyncCore:D};context.window=context;vm.createContext(context);vm.runInContext(builtWriter(),context);
 return {records:context.SentlogRecords,localStorage,factory,memory,context};
}
function snapshot(id,recordCount=1){const drawingId='drawing-'+id,meta={id:drawingId,name:'Drawing '+id,sourceType:'pdf',fileName:id+'.pdf'};
 const records=Array.from({length:recordCount},(_,index)=>C.upgrade({id:'record-'+id+(index?'-'+index:''),kind:'point',
  memo:'Original '+id+(index?' '+index:''),photos:[{id:'photo',name:id+'.png',type:'image/png',size:9}]}));
 return {version:1,kind:'sentlog-app-project',localProjectId:id,project:{id,name:'Project '+id,collaborationVersion:1,drawings:[meta]},
  drawings:[{meta:copy(meta),state:{sourceType:'pdf',fileName:id+'.pdf',shapes:records,collabDeletedRecords:[]}}]};
}
async function open(factory){return new Promise((resolve,reject)=>{const q=factory.open('surveyFieldNoteDB');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}
async function disk(factory,store=CONTROL){const db=await open(factory);try{return await new Promise((resolve,reject)=>{
 const tx=db.transaction(store,'readonly'),s=tx.objectStore(store);let keys,values;
 s.getAllKeys().onsuccess=e=>keys=e.target.result;s.getAll().onsuccess=e=>values=e.target.result;
 tx.oncomplete=()=>resolve(new Map(keys.map((key,i)=>[key,values[i]])));tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
async function write(factory,store,key,value){const db=await open(factory);try{await new Promise((resolve,reject)=>{
 const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};
 });}finally{db.close();}}
async function fixture({two=false,history=false,projectCount=two?2:1,recordCount=1}={}){
 const snapshots=Array.from({length:projectCount},(_,index)=>snapshot(index===0?'a':index===1?'b':'p-'+index,recordCount)),factory=new IDBFactory(),memory=new Map([[WS,json({projects:snapshots.map(s=>s.project)})],
  ...snapshots.flatMap(s=>s.drawings.map(d=>[DRAW+d.meta.id,json(d.state)]))]);
 const first=application(factory,memory);await first.records.init();const files=new Map();
 for(const s of snapshots){const id=s.localProjectId,drawingId=s.drawings[0].meta.id;
  files.set('background:'+drawingId,new Blob(['pdf-'+id],{type:'application/pdf'}));
  files.set('photo:'+drawingId+':photo',new Blob(['new-photo'],{type:'image/png'}));}
 files.set('original:camera-only',new Blob(['camera original outside GC'],{type:'image/jpeg'}));
 for(const [key,value]of files)await first.records.writeFile(key,value);
 const ordinary=await disk(factory,'files'),control=await disk(factory),seq=Number(control.get('clock'))||0;
 const oldBindings=new Map();
 for(const s of snapshots){
  const id=s.localProjectId,scope=scopeFor(id),drawingId=s.drawings[0].meta.id,bindingId='binding:legacy-'+id;
  const captured=[...files].filter(([key])=>key==='background:'+drawingId||key.startsWith('photo:'+drawingId+':')).map(([key,value])=>({key,value:
   history&&id==='a'&&key.startsWith('photo:')?new Blob(['old-photo'],{type:value.type}):value}));
  const cutoff={version:1,kind:'sentlog-journal-cutoff',bindingId,scope:copy(scope),localProjectId:id,cutoffSeq:seq,
   sourceRevision:ordinary.get(META).revision,sourceMeta:copy(ordinary.get(META)),snapshot:copy(s),
   rawEntries:[[WS,ordinary.get(PREFIX+WS)],[DRAW+drawingId,ordinary.get(PREFIX+DRAW+drawingId)]],files:captured,metadataRecords:{},serverRevision:1};
  const metadataRecords=M.metadataRecords(await M.seed(s));
  const binding={version:1,kind:'binding',id:bindingId,scope:copy(scope),localProjectId:id,phase:'active',actor:copy(actor),
   cutoffSeq:seq,ackedSeq:seq,metadataRecords,createdAt:1,cutoff,baselineId:'baseline-'+id,activatedAt:2,
   baselineProof:{migrationId:'old-'+id,sourceFingerprint:'a'.repeat(64)},replayBaseline:{before:copy(s),after:copy(s)}};
  oldBindings.set(id,copy(binding));await write(factory,CONTROL,'binding:'+id,binding);
 }
 return {factory,memory,files,snapshots,oldBindings,observer:first,restart:()=>application(factory,memory)};
}
function noEmbeddedPuts(extra){
 const originals={put:IDBObjectStore.prototype.put,add:IDBObjectStore.prototype.add},calls=[];
 for(const method of ['put','add'])IDBObjectStore.prototype[method]=function(value,key,...rest){
  if(this.name===CONTROL){calls.push({method,key,kind:value?.kind,blob:containsBlob(value)});
   if(value?.kind==='binding'&&containsBlob(value))throw Object.assign(Error('Error preparing Blob/File data to be stored in object store'),{name:'UnknownError'});
   extra?.({method,value,key,store:this});}
  return originals[method].call(this,value,key,...rest);
 };
 return {calls,close(){for(const method of ['put','add'])IDBObjectStore.prototype[method]=originals[method];}};
}
function observeBindingReads(app,{forbidHydration=false}={}){
 const originalClone=app.context.structuredClone,originals={get:IDBObjectStore.prototype.get,getAll:IDBObjectStore.prototype.getAll};
 const counts={gets:0,getAll:0,rows:0,cutoffRows:0,bindingClones:0,blobClones:0,keys:[]};
 app.context.structuredClone=value=>{
  if(value?.kind==='binding')counts.bindingClones++;
  if(value instanceof Blob)counts.blobClones++;
  if(forbidHydration&&(value?.kind==='binding'||value instanceof Blob))throw Error('A status check must not hydrate a cutoff');
  return originalClone(value);
 };
 for(const method of ['get','getAll'])IDBObjectStore.prototype[method]=function(...args){
  const request=originals[method].apply(this,args);
  if(this.name===CONTROL){if(method==='get'){counts.gets++;counts.keys.push(args[0]);}else counts.getAll++;
   request.addEventListener('success',()=>{const rows=method==='getAll'?request.result:request.result?[request.result]:[];
    counts.rows+=rows.length;counts.cutoffRows+=rows.filter(row=>row?.kind==='cutoff-file').length;});}
  return request;
 };
 return {counts,close(){app.context.structuredClone=originalClone;for(const method of ['get','getAll'])IDBObjectStore.prototype[method]=originals[method];}};
}
const cutoffRows=rows=>[...rows.values()].filter(row=>row?.kind==='cutoff-file');
async function hydratedSame(actual,expected){
 assert.equal(actual.id,expected.id);assert.equal(actual.localProjectId,expected.localProjectId);assert(C.equal(actual.scope,expected.scope));
 assert(C.equal(actual.cutoff.snapshot,expected.cutoff.snapshot));assert(C.equal(actual.cutoff.rawEntries,expected.cutoff.rawEntries));
 assert.equal(actual.cutoff.files.length,expected.cutoff.files.length);
 for(const item of actual.cutoff.files){const original=expected.cutoff.files.find(file=>file.key===item.key);assert(original,item.key);
  assert.equal(Object.hasOwn(item,'valueRef'),false,'public cutoff files preserve the pre-reference API');
  assert(item.value instanceof Blob);assert.equal(item.value.type,original.value.type);assert.equal(await hash(item.value),await hash(original.value));}
}
async function replay(app,id='a'){
 const {records}=app,scope=scopeFor(id),binding=records.deltaJournal.bindingFor(id),base=copy(binding.cutoff.snapshot),entries={...await M.seed(base)};
 for(const d of base.drawings)for(const record of [...d.state.shapes,...d.state.collabDeletedRecords])entries[D.keyOf(d.meta.id,record.id)]=record;
 let durable={version:2,scope:copy(scope),cursor:0,records:entries,outbox:[],blockedOutbox:[]};
 const store={read:async()=>copy(durable),write:async next=>{durable=copy(next);}};
 const transport={online:()=>false,push:async()=>{throw Error('offline');},pushGroup:async()=>{throw Error('offline');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
 const replica=D.createReplica({...scope,store,transport}),bridge=B.createBridge({replica,scope,localProjectId:id,currentScope:()=>scope});
 const controller=J.createController({records,scope,localProjectId:id,replica,replicaStore:store,bridge,metadata:M,currentScope:()=>scope});
 try{const state=JSON.parse(records.getItem(DRAW+'drawing-'+id));state.shapes[0].memo='A new ordinary edit';records.setItem(DRAW+'drawing-'+id,json(state));
  await records.settled();await controller.drain();assert.equal((await records.deltaJournal.pending({scope,localProjectId:id})).count,0);
  assert.equal(durable.outbox.length,1);assert(durable.records[D.keyOf('drawing-'+id,'record-'+id)].memo.includes('A new ordinary edit'));
 }finally{controller.close();bridge.close();replica.close();}
}
async function prepareRelease(app,f){
 const scope=scopeFor('a'),certificate={schema:1,projectId:scope.projectId,headSeq:0,revision:2,payloadSha256:'b'.repeat(64)};
 const files=await Promise.all([...f.files].filter(([key])=>key==='background:drawing-a'||key==='photo:drawing-a:photo').map(async([key,blob])=>({
  key,kind:key.startsWith('background:')?'drawing':'photo',assetId:'asset-'+key,size:blob.size,mimeType:blob.type,sha256:await hash(blob)})));
 const ticket=await app.records.deltaJournal.prepareArchivedRelease({scope,localProjectId:'a',certificate,jobId:'job-a',operationId:'operation-a',mode:'files',files,validate:()=>true});
 const raw=app.records.getItem(WS),fileStates=await app.records.readFileStates(files.map(file=>file.key));
 const apply=()=>app.records.archiveAtomic({writes:[[LOCAL,json({[scope.projectId]:{mode:'files',job_id:'job-a',revision:2}})]],
  deleteFiles:files.map(file=>({key:file.key,size:file.size})),expectedWorkspace:raw,expectedFileStates:fileStates,
  validate:()=>true,operation:'archive-local',context:{localArchive:true,mode:'files',projectId:'a',jobId:'job-a',deltaCheckpoint:certificate},retentionRelease:ticket});
 return {ticket,files,apply,certificate};
}

let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS',name);}
(async()=>{
 await test('binding status reads only the requested row and never hydrates protected photo bytes or history',async()=>{
  const f=await fixture({two:true,history:true}),app=f.restart();await app.records.init();const journal=app.records.deltaJournal,guard=observeBindingReads(app,{forbidHydration:true});
  try{
   const state=await journal.readBindingState('a');assert.equal(state.id,f.oldBindings.get('a').id);assert.equal(state.phase,'active');
   assert.equal(state.baselineId,'baseline-a');assert.equal(state.serverRevision,1);assert(C.equal(state.scope,scopeFor('a')));
   for(const key of ['cutoff','replayBaseline','metadataRecords','lastProof'])assert.equal(Object.hasOwn(state,key),false);
   state.scope.ownerId='changed by caller';state.phase='detached';
   assert(C.equal(journal.bindingStateFor('a').scope,scopeFor('a')));assert.equal(journal.bindingStateFor('a').phase,'active');
   const all=journal.listBindingStatesSync();assert.equal(all.length,2);all[1].scope.ownerId='changed by caller';
   assert(C.equal(journal.bindingStateFor('b').scope,scopeFor('b')));
   assert.deepEqual(guard.counts,{gets:1,getAll:0,rows:1,cutoffRows:0,bindingClones:0,blobClones:0,keys:['binding:a']});
  }finally{guard.close();}
  await hydratedSame(journal.bindingFor('a'),f.oldBindings.get('a'));
  await hydratedSame((await journal.listBindings()).find(row=>row.localProjectId==='b'),f.oldBindings.get('b'));
 });
 await test('a newly observed cross-tab binding populates its protected cutoff cache once before status becomes visible',async()=>{
  const f=await fixture({two:true,history:true}),observer=f.observer;assert.equal(observer.records.deltaJournal.bindingFor('a'),null);
  const writer=f.restart();await writer.records.init();const journal=observer.records.deltaJournal,first=observeBindingReads(observer);
  try{const state=await journal.readBindingState('a');assert.equal(state.phase,'active');
   assert.equal(first.counts.gets,1);assert.equal(first.counts.getAll,1);assert.equal(first.counts.cutoffRows,4);
  }finally{first.close();}
  await hydratedSame(journal.bindingFor('a'),f.oldBindings.get('a'));
  await hydratedSame(journal.bindingFor('b'),f.oldBindings.get('b'));
  const steady=observeBindingReads(observer,{forbidHydration:true});try{
   for(let index=0;index<3;index++)assert.equal((await journal.readBindingState('a')).phase,'active');
   assert.deepEqual(steady.counts,{gets:3,getAll:0,rows:3,cutoffRows:0,bindingClones:0,blobClones:0,keys:['binding:a','binding:a','binding:a']});
  }finally{steady.close();}
  await replay(observer);await hydratedSame(journal.bindingFor('a'),f.oldBindings.get('a'));
 });
 await test('fresh binding status observes other-tab changes and rejects malformed identity without replacing the last valid state',async()=>{
  const f=await fixture({two:true}),app=f.restart();await app.records.init();const journal=app.records.deltaJournal,raw=await disk(f.factory);
  const next={...raw.get('binding:a'),phase:'detached',ackedSeq:raw.get('binding:a').ackedSeq+3};
  await write(f.factory,CONTROL,'binding:a',next);
  assert.equal(journal.bindingStateFor('a').phase,'active');const fresh=await journal.readBindingState('a');
  assert.equal(fresh.phase,'detached');assert.equal(fresh.ackedSeq,next.ackedSeq);assert.equal(journal.bindingStateFor('b').phase,'active');
  for(const changed of [null,false,{...next,kind:'claim'},{...next,localProjectId:'b'},{...next,phase:'unknown'},
    {...next,ackedSeq:-1},{...next,scope:{...next.scope,ownerId:'another-owner'}},
    {...next,cutoff:{...next.cutoff,bindingId:'foreign-binding'}},{...next,cutoff:{...next.cutoff,serverRevision:{invalid:true}}}]){
   await write(f.factory,CONTROL,'binding:a',changed);await assert.rejects(()=>journal.readBindingState('a'),error=>error.code==='JOURNAL_BINDING');
   assert.equal(journal.bindingStateFor('a').phase,'detached');assert(C.equal(journal.bindingStateFor('a').scope,scopeFor('a')));
  }
  const foreign={...next,scope:{...next.scope,ownerId:'another-owner'},cutoff:{...next.cutoff,scope:{...next.scope,ownerId:'another-owner'}}};
  await write(f.factory,CONTROL,'binding:a',foreign);
  await assert.rejects(()=>journal.readBindingState('a'),error=>error.code==='JOURNAL_CUTOFF_REF');
  assert(C.equal(journal.bindingStateFor('a').scope,scopeFor('a')),'a mismatched foreign cutoff cannot replace the valid cache');
  for(const file of foreign.cutoff.files){const row=raw.get(file.valueRef);await write(f.factory,CONTROL,file.valueRef,{...row,scope:copy(foreign.scope)});}
  assert.equal((await journal.readBindingState('a')).scope.ownerId,'another-owner');
  const db=await open(f.factory);try{await new Promise((resolve,reject)=>{const tx=db.transaction(CONTROL,'readwrite');
   tx.objectStore(CONTROL).delete('binding:a');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  assert.equal(await journal.readBindingState('a'),null);assert.equal(journal.bindingStateFor('a'),null);
  assert.equal(journal.listBindingStatesSync().length,1);assert.equal(journal.bindingStateFor('b').localProjectId,'b');
 });
 await test('an old embedded cutoff migrates once and all public readers retain exact Blob bytes',async()=>{
  const f=await fixture({history:true}),guard=noEmbeddedPuts();try{
   const app=f.restart();await app.records.init();const raw=await disk(f.factory),saved=raw.get('binding:a'),rows=cutoffRows(raw);
   assert.equal(containsBlob(saved),false);assert.equal(rows.length,2);assert(rows.every(row=>row.revision===1&&row.value instanceof Blob));
   assert(saved.cutoff.files.every(file=>typeof file.valueRef==='string'&&!Object.hasOwn(file,'value')));
   await hydratedSame(app.records.deltaJournal.bindingFor('a'),f.oldBindings.get('a'));
   await hydratedSame((await app.records.deltaJournal.listBindings())[0],f.oldBindings.get('a'));
   const cutoff=await app.records.deltaJournal.begin({scope:scopeFor('a'),localProjectId:'a',actor});
   assert.equal(await cutoff.files.find(file=>file.key==='photo:drawing-a:photo').value.text(),'old-photo');
   const source=Source.createSource({indexedDB:f.factory,localStorage:app.localStorage,crypto:webcrypto,journal:app.records.deltaJournal});
   try{const captured=await source.capture('a',{recordCutoff:cutoff});
    assert.equal(await captured.files.find(file=>file.key==='photo:drawing-a:photo').blob.text(),'old-photo');
    assert.equal((await source.recheck(captured)).unchanged,true);
   }finally{source.close();}
   const writes=guard.calls.filter(call=>call.kind==='cutoff-file').length,again=f.restart();await again.records.init();
   await hydratedSame(again.records.deltaJournal.bindingFor('a'),f.oldBindings.get('a'));
   assert.equal(guard.calls.filter(call=>call.kind==='cutoff-file').length,writes,'restart must not rewrite migrated Blob rows');
  }finally{guard.close();}
 });
 await test('ordinary activate, replay ACK and projection never put cutoff Blobs back into mutable bindings',async()=>{
  const f=await fixture(),guard=noEmbeddedPuts();try{const app=f.restart();await app.records.init();const before=await disk(f.factory);
   await app.records.deltaJournal.activate({scope:scopeFor('a'),localProjectId:'a',baselineId:'baseline-a',
    metadataRecords:app.records.deltaJournal.bindingFor('a').metadataRecords,baselineSnapshot:f.snapshots[0],proof:{verified:true}});
   await replay(app);const after=await disk(f.factory);
   assert.equal(containsBlob(after.get('binding:a')),false);assert(after.get('binding:a').ackedSeq>f.oldBindings.get('a').ackedSeq);
   for(const original of cutoffRows(before)){const current=after.get(original.id);assert(current);assert.equal(current.revision,original.revision);
    assert.equal(await hash(current.value),await hash(original.value));}
   await hydratedSame(app.records.deltaJournal.bindingFor('a'),f.oldBindings.get('a'));
   assert(guard.calls.some(call=>call.kind==='binding'));
  }finally{guard.close();}
 });
 await test('a failed legacy per-file stage preserves embedded bytes and reuses the committed first file after restart',async()=>{
  const f=await fixture();let stages=0;const guard=noEmbeddedPuts(({method,value})=>{
   if(method==='add'&&value?.kind==='cutoff-file'&&++stages===2)throw Object.assign(Error('injected cutoff stage failure'),{name:'UnknownError'});
  });try{await assert.rejects(()=>f.restart().records.init(),/injected cutoff stage failure/);}finally{guard.close();}
  const partial=await disk(f.factory),old=partial.get('binding:a'),first=cutoffRows(partial);assert.equal(first.length,1);
  assert(containsBlob(old));await hydratedSame(old,f.oldBindings.get('a'));
  const retryGuard=noEmbeddedPuts();try{const resumed=f.restart();await resumed.records.init();const after=await disk(f.factory);
   assert.equal(cutoffRows(after).length,2);assert.equal(after.get(first[0].id).revision,1);assert.equal(await hash(after.get(first[0].id).value),await hash(first[0].value));
   assert.equal(retryGuard.calls.filter(call=>call.kind==='cutoff-file').length,1,'only the unfinished file needs a new immutable row');
   await hydratedSame(resumed.records.deltaJournal.bindingFor('a'),f.oldBindings.get('a'));
  }finally{retryGuard.close();}
 });
 await test('two legacy bindings migrate independently and cannot share a cutoff file identity',async()=>{
  const f=await fixture({two:true}),guard=noEmbeddedPuts();try{const app=f.restart();await app.records.init();const raw=await disk(f.factory),rows=cutoffRows(raw);
   assert.equal(rows.length,4);assert.equal(new Set(rows.map(row=>row.id)).size,4);
   for(const id of ['a','b']){const binding=raw.get('binding:'+id);assert.equal(containsBlob(binding),false);
    for(const reference of binding.cutoff.files){const row=raw.get(reference.valueRef);assert.equal(row.bindingId,binding.id);assert.equal(row.localProjectId,id);assert(C.equal(row.scope,scopeFor(id)));}
    await hydratedSame(app.records.deltaJournal.bindingFor(id),f.oldBindings.get(id));}
   await replay(app,'a');await hydratedSame(app.records.deltaJournal.bindingFor('b'),f.oldBindings.get('b'));
  }finally{guard.close();}
 });
 await test('changed staged bytes, foreign rows and foreign references fail closed without losing either original',async()=>{
  const f=await fixture({two:true});let count=0;const stop=noEmbeddedPuts(({method,value})=>{
   if(method==='add'&&value?.kind==='cutoff-file'&&++count===2)throw Error('stop after first staging row');
  });try{await assert.rejects(()=>f.restart().records.init(),/stop after first staging row/);}finally{stop.close();}
  const raw=await disk(f.factory),staged=cutoffRows(raw)[0];assert(staged);
  const altered={...staged,value:new Blob(['x'.repeat(staged.value.size)],{type:staged.value.type})};
  await write(f.factory,CONTROL,staged.id,altered);await assert.rejects(()=>f.restart().records.init(),error=>error.code==='JOURNAL_CUTOFF_COLLISION');
  await hydratedSame((await disk(f.factory)).get('binding:a'),f.oldBindings.get('a'));
  const foreign={...staged,scope:{...staged.scope,ownerId:'another-owner'}};
  await write(f.factory,CONTROL,staged.id,foreign);await assert.rejects(()=>f.restart().records.init());
  assert(containsBlob((await disk(f.factory)).get('binding:a')));assert(containsBlob((await disk(f.factory)).get('binding:b')));
  await write(f.factory,CONTROL,staged.id,staged);const app=f.restart();await app.records.init();const complete=await disk(f.factory);
  const a=copy(complete.get('binding:a')),b=complete.get('binding:b');a.cutoff.files[0].valueRef=b.cutoff.files[0].valueRef;
  await write(f.factory,CONTROL,'binding:a',a);await assert.rejects(()=>f.restart().records.init());
  for(const row of cutoffRows(complete))assert.equal(await hash((await disk(f.factory)).get(row.id).value),await hash(row.value));
 });
 await test('certified GC releases only matching referenced cutoff bytes in the same transaction as visible cleanup',async()=>{
  const f=await fixture({two:true,history:true}),app=f.restart();await app.records.init();const before=await disk(f.factory),release=await prepareRelease(app,f);
  const guard=noEmbeddedPuts();try{await release.apply();}finally{guard.close();}
  const after=await disk(f.factory),visible=await disk(f.factory,'files');
  for(const row of cutoffRows(before)){const current=after.get(row.id);assert(current);
   if(row.localProjectId==='a'&&row.key==='background:drawing-a'){
    assert.equal(current.value,null);assert.equal(current.revision,row.revision+1);assert(current.archiveRelease);
   }else{assert.equal(current.revision,row.revision);assert.equal(await hash(current.value),await hash(row.value));}}
  assert.equal(visible.has('background:drawing-a'),false);assert.equal(visible.has('photo:drawing-a:photo'),false);
  assert.equal(await visible.get('original:camera-only').text(),'camera original outside GC');
  assert.equal(await visible.get('photo:drawing-b:photo').text(),'new-photo');
  const hydrated=app.records.deltaJournal.bindingFor('a');assert.equal(hydrated.cutoff.files.find(file=>file.key==='background:drawing-a').value,null);
  assert.equal(await hydrated.cutoff.files.find(file=>file.key==='photo:drawing-a:photo').value.text(),'old-photo');
  const restarted=f.restart();await restarted.records.init();assert.equal(restarted.records.deltaJournal.bindingFor('a').cutoff.files.find(file=>file.key==='background:drawing-a').value,null);
 });
 await test('a cutoff row revision change after GC proof aborts cleanup and preserves visible files',async()=>{
  const f=await fixture(),app=f.restart();await app.records.init();const release=await prepareRelease(app,f),rows=await disk(f.factory);
  const row=cutoffRows(rows).find(item=>item.key==='background:drawing-a'),changed={...row,revision:row.revision+1,value:new Blob(['pdf-x'],{type:'application/pdf'})};
  if(row.sha256)changed.sha256=await hash(changed.value);await write(f.factory,CONTROL,row.id,changed);
  await assert.rejects(()=>release.apply(),error=>error.code==='JOURNAL_ARCHIVE_CHANGED');
  const visible=await disk(f.factory,'files');assert.equal(await visible.get('background:drawing-a').text(),'pdf-a');
  assert.equal(await visible.get('photo:drawing-a:photo').text(),'new-photo');assert.equal(visible.has(PREFIX+LOCAL),false);
  assert.equal(await (await disk(f.factory)).get(row.id).value.text(),'pdf-x');
 });
 console.log('PASS cutoff files:',passed,'legacy conversion, immutable-byte, replay and GC groups');
 if(process.env.BINDING_BENCHMARK==='1')for(const size of [{projectCount:1,recordCount:10},{projectCount:24,recordCount:40}]){
  const f=await fixture(size),app=f.restart();await app.records.init();const iterations=10,output={...size,iterations};
  for(const [name,read]of [['previousList',()=>app.records.deltaJournal.listBindings()],['selectedState',()=>app.records.deltaJournal.readBindingState('a')]]){
   const guard=observeBindingReads(app),start=performance.now();try{for(let index=0;index<iterations;index++)await read();
    output[name]={milliseconds:Math.round((performance.now()-start)*10)/10,...guard.counts};delete output[name].keys;
   }finally{guard.close();}
  }
  assert.equal(output.selectedState.rows,iterations);assert.equal(output.selectedState.cutoffRows,0);assert.equal(output.selectedState.bindingClones,0);
  assert.equal(output.previousList.cutoffRows,size.projectCount*2*iterations);
  console.log('BENCH binding reads (Node/fake IndexedDB; counters are deterministic, milliseconds are not browser latency)',JSON.stringify(output));
 }
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

'use strict';
// Real writer, durable replay and ACK with disposable synthetic IndexedDB.
// A small CONTROL receipt may explain an acknowledged oversized orphan row;
// its original WAL, live file and bytes must remain intact. No browser profile,
// production data or native-Blob lifetime claim is involved in this Node suite.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{createHash}=require('node:crypto');
const {IDBObjectStore}=require('fake-indexeddb');
const fixturePath=path.join(__dirname,'delta_app_journal.test.cjs');
const fixture=fs.readFileSync(fixturePath,'utf8').split('let passed=0;async function test(')[0]
  .replace("fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8')",
    "fs.readFileSync(process.env.SENTLOG_RECORD_SOURCE||path.join(__dirname,'../sentlog/record-store.js'),'utf8')");
const {app,bind,edit,scope,localProjectId,WS,DRAW,PREFIX,LOG,CONTROL,D,B,J,M,C}=new Function('require','__dirname',fixture+
  '\nreturn {app,bind,edit,scope,localProjectId,WS,DRAW,PREFIX,LOG,CONTROL,D,B,J,M,C};')(createRequire(fixturePath),__dirname);
const MIB=1024*1024,ORPHAN='later-drawing',RECEIPT='retention-receipt:',copy=structuredClone,json=JSON.stringify;
const source=()=>fs.readFileSync(process.env.SENTLOG_RECORD_SOURCE||require.resolve('../sentlog/record-store.js'),'utf8');
const drawing=()=>json({shapes:[],collabDeletedRecords:[]});
const image=(size,byte=7)=>new Blob([new Uint8Array(size).fill(byte)],{type:'image/jpeg'});
async function hash(blob){const h=createHash('sha256');for(let offset=0;offset<blob.size;offset+=2*MIB)
  h.update(Buffer.from(await blob.slice(offset,offset+2*MIB).arrayBuffer()));return h.digest('hex');}
async function fingerprint(value){
  if(value instanceof Blob)return {size:value.size,type:value.type,name:value.name??null,lastModified:value.lastModified??null,sha256:await hash(value)};
  if(value instanceof Map)return Promise.all([...value].map(async([key,item])=>[key,await fingerprint(item)]));
  if(Array.isArray(value))return Promise.all(value.map(fingerprint));
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await fingerprint(item)])));
  return value;
}
async function snapshot(f){return fingerprint({files:await f.disk(),journal:await f.disk(LOG),controls:await f.disk(CONTROL)});}
async function setStored(f,store,key,value){const db=await f.records.openFilesDatabase();try{
  await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');
    if(value===undefined)tx.objectStore(store).delete(key);else tx.objectStore(store).put(value,key);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
}finally{db.close();}}
async function drain(f,{deferCompact=false}={}){
  const original=f.records.deltaJournal.compact,c=f.engine.controller();
  if(deferCompact)f.records.deltaJournal.compact=async()=>({fixtureDeferred:true});
  try{return await c.controller.drain();}finally{c.close();f.records.deltaJournal.compact=original;}
}
async function bindOther(f,otherId,otherScope){
  // A second independent real replica supplies ownership/ACK proof after the
  // first project has already been archived. Its files must not block restore.
  const cutoff=await f.records.deltaJournal.begin({scope:otherScope,localProjectId:otherId,actor:{deviceId:otherScope.deviceId,deviceName:'Other device'}});
  const records={};for(const drawing of cutoff.snapshot.drawings)for(const record of [...drawing.state.shapes,...drawing.state.collabDeletedRecords])
    records[D.keyOf(drawing.meta.id,record.id)]=C.upgrade(record);
  Object.assign(records,await M.seed(cutoff.snapshot));
  let durable={version:2,scope:copy(otherScope),cursor:0,records,outbox:[]};
  const store={read:async()=>copy(durable),readForVerification:async()=>copy(durable),write:async value=>{durable=copy(value);}};
  await f.records.deltaJournal.activate({scope:otherScope,localProjectId:otherId,baselineId:'other-baseline',baselineSnapshot:copy(cutoff.snapshot),metadataRecords:M.metadataRecords(records)});
  return {controller(){
    const transport={online:()=>false,push:async()=>{throw Error('offline');},pushGroup:async()=>{throw Error('offline');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
    const replica=D.createReplica({...otherScope,store,transport}),bridge=B.createBridge({replica,scope:otherScope,localProjectId:otherId,currentScope:()=>otherScope});
    const controller=J.createController({records:f.records,scope:otherScope,localProjectId:otherId,replica,replicaStore:store,bridge,currentScope:()=>otherScope,metadata:M});
    return {controller,close(){controller.close();bridge.close();replica.close();}};
  }};
}
async function staged(sizes=[9*MIB]){
  const f=await app();Object.assign(f.ctx,{File,setTimeout,clearTimeout,TextDecoder,TextEncoder});
  f.engine=await bind(f,{metadata:true});f.keys=sizes.map((_,index)=>'photo:'+ORPHAN+':large-'+index);f.originalRaw=drawing();
  f.records.setItem(DRAW+ORPHAN,f.originalRaw);await f.records.settled();
  for(let index=0;index<sizes.length;index++)await f.records.writeFile(f.keys[index],image(sizes[index],7+index));
  f.fileRows=[...(await f.disk(LOG)).values()].filter(row=>row.files.some(file=>f.keys.includes(file.key)));
  assert.equal(f.fileRows.length,sizes.length);assert(f.fileRows.every(row=>row.projectIds.length===0));
  const workspace=JSON.parse(f.records.getItem(WS));workspace.projects[0].drawings.push({id:ORPHAN,name:'Later drawing'});
  f.records.setItem(WS,json(workspace));await f.records.settled();return f;
}
async function removeMembership(f,{deferCompact=false}={}){
  const workspace=JSON.parse(f.records.getItem(WS));workspace.projects[0].drawings=workspace.projects[0].drawings.filter(meta=>meta.id!==ORPHAN);
  f.records.batch([[WS,json(workspace)],[DRAW+ORPHAN,null]],{operation:'delete'});await f.records.settled();
  await drain(f,{deferCompact});assert.equal(f.records.getItem(DRAW+ORPHAN),null);
}
async function withCompactionReads(f,run){
  const original=f.records.deltaJournal.compact,read=Blob.prototype.arrayBuffer,results=[],reads=[];let active=false;
  f.records.deltaJournal.compact=async function(...args){assert(!active,'Compaction must remain serial');active=true;
    try{const result=await original.apply(this,args);results.push(result);return result;}finally{active=false;}};
  Blob.prototype.arrayBuffer=function(){if(active){assert(this.size<=2*MIB,'Compaction may read only bounded slices');reads.push(this.size);}return read.call(this);};
  try{await run();}finally{f.records.deltaJournal.compact=original;Blob.prototype.arrayBuffer=read;}
  for(const result of results){assert(Number.isSafeInteger(result.copiedBytes));assert(result.copiedBytes<=8*MIB);}
  return {results,reads};
}
async function coveredDeleted(){const f=await staged();await drain(f);await removeMembership(f);return f;}
async function receiptFor(f,row=f.fileRows[0]){return (await f.disk(CONTROL)).get(RECEIPT+row.seq);}
function incoming(f,id=ORPHAN,raw=f.originalRaw){
  const workspace=JSON.parse(f.records.getItem(WS));workspace.projects.find(project=>project.id===localProjectId).drawings.push({id,name:'Received drawing'});
  return {scope,localProjectId,writes:[[WS,json(workspace)],[DRAW+id,raw]],
    expectedRecords:[[WS,f.records.getItem(WS)],[DRAW+id,f.records.getItem(DRAW+id)]],
    metadataRecords:copy(f.records.deltaJournal.bindingFor(localProjectId).metadataRecords),validate:()=>true};
}
function archive(f){return f.records.archiveAtomic({writes:[],deleteFiles:[],expectedWorkspace:f.records.getItem(WS),
  operation:'archive-local',context:{localArchive:true,mode:'files',projectId:localProjectId,jobId:'synthetic-archive'}});}
async function oldReader(f){
  // Freeze both previous pending/claim methods AND their unfiltered bulk read.
  // Leaving the new journalRows receipt filter installed would falsely make the
  // historical reader understand metadata that it never supported.
  let code=source();const frozen=require('./fixtures/record_journal_readers_v214.cjs');
  for(const [name,next]of [['pending','begin'],['claim','verifyReplay']]){
    const begin=code.indexOf('    async '+name+'('),end=code.indexOf('    async '+next+'(',begin);
    assert(begin>=0&&end>begin);code=code.slice(0,begin)+frozen[name]+code.slice(end);
  }
  const begin=code.indexOf('  function collectJournal('),end=code.indexOf('  function collectProjectRecords(',begin);
  assert(begin>=0&&end>begin);const block=code.slice(begin,end),needle='journalRows(tx.objectStore(JOURNAL))';
  assert.equal(block.split(needle).length,2,'Previous raw journal reader must be installed exactly once');
  code=code.slice(0,begin)+block.replace(needle,'tx.objectStore(JOURNAL).getAll()')+code.slice(end);
  const context={...f.ctx,SentlogRecords:undefined};context.window=context;vm.createContext(context);vm.runInContext(code,context);
  await context.SentlogRecords.init();return context.SentlogRecords;
}
const cases=[],test=(name,run)=>cases.push([name,run]);

test('a 9 MiB acknowledged orphan survives ownership deletion without false pending, copying or loss after restart',async()=>{
  const f=await staged(),before=await fingerprint(f.fileRows[0]),photoHash=await hash((await f.disk()).get(f.keys[0]));
  const measured=await withCompactionReads(f,async()=>{await drain(f);assert(await receiptFor(f),'ACK must persist ownership before later deletion');await removeMembership(f);});
  assert.equal(measured.reads.length,0,'Oversized original bytes must stay untouched rather than being copied in full');
  assert(measured.results.some(result=>result.skippedLarge>=1));
  const row=(await f.disk(LOG)).get(f.fileRows[0].seq),receipt=await receiptFor(f);
  assert.deepEqual(await fingerprint(row),before);assert.equal(row.kind,'sentlog-app-intent');
  assert.equal(receipt.kind,'retention-receipt');assert.equal(receipt.rowId,row.id);assert.equal(receipt.seq,row.seq);
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);
  const reopened=await app({factory:f.factory,local:f.local});
  assert.equal((await reopened.records.deltaJournal.pending({scope,localProjectId})).count,0);
  assert.equal(await reopened.records.deltaJournal.claim({scope,localProjectId}),null);
  assert.deepEqual(await fingerprint((await reopened.disk(LOG)).get(row.seq)),before);
  assert.equal(await hash((await reopened.disk()).get(f.keys[0])),photoHash);
  const previous=await oldReader(f);assert.equal((await previous.deltaJournal.pending({scope,localProjectId})).count,1);
  assert.equal(await previous.deltaJournal.claim({scope,localProjectId}),null,'Unknown receipts leave old readers on the protective side');
});

test('a 5 MiB plus 5 MiB pass respects the total copy budget and later converts the receipted row after ownership is gone',async()=>{
  const f=await staged([5*MIB,5*MIB]);await drain(f,{deferCompact:true});let result;
  for(const row of f.fileRows)assert(await receiptFor(f,row),'ACK must persist the proof even when cleanup is deferred');
  const measured=await withCompactionReads(f,async()=>{result=await f.records.deltaJournal.compact();});
  assert.equal(result.copiedBytes,5*MIB);assert.equal(result.retainedFiles,1);assert.equal(result.skippedLarge,1);assert.equal(result.deferredReceipts,0);
  assert.equal(measured.reads.reduce((sum,size)=>sum+size,0),5*MIB);
  const journal=await f.disk(LOG),deferred=f.fileRows.find(row=>journal.get(row.seq)?.kind==='sentlog-app-intent');assert(deferred);
  assert(await receiptFor(f,deferred));const before=await fingerprint(journal.get(deferred.seq).files);
  await removeMembership(f,{deferCompact:true});assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  for(let pass=0;pass<6&&(await f.disk(LOG)).get(deferred.seq)?.kind==='sentlog-app-intent';pass++)await f.records.deltaJournal.compact();
  const converted=(await f.disk(LOG)).get(deferred.seq);assert.equal(converted.kind,'sentlog-file-retention');
  assert.deepEqual(await fingerprint(converted.files),before);assert.equal(await receiptFor(f,deferred),undefined);
});

test('ACK preserves ownership when cleanup throws busy before and after membership deletion',async()=>{
  const f=await staged(),before=await fingerprint(f.fileRows[0]),photoHash=await hash((await f.disk()).get(f.keys[0]));
  const compact=f.records.deltaJournal.compact,logger=f.ctx.console,warnings=[];let calls=0;
  f.ctx.console={...logger,warn:(...args)=>warnings.push(args)};
  f.records.deltaJournal.compact=async()=>{calls++;throw Object.assign(Error('synthetic concurrent maintenance'),{code:'JOURNAL_MAINTENANCE_BUSY'});};
  try{
    await drain(f);assert(await receiptFor(f),'The ACK transaction must save ownership even when no compact pass succeeded');
    await removeMembership(f);
  }finally{f.records.deltaJournal.compact=compact;f.ctx.console=logger;}
  assert(calls>=2);assert(warnings.length>=2,'Both verified ACKs must defer the busy cleanup without losing ownership');
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);
  assert.deepEqual(await fingerprint((await f.disk(LOG)).get(f.fileRows[0].seq)),before);
  assert.equal(await hash((await f.disk()).get(f.keys[0])),photoHash);
  const receipt=await receiptFor(f),invalid=copy(receipt);invalid.rowId+='-other';
  await setStored(f,CONTROL,RECEIPT+f.fileRows[0].seq,invalid);
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,1,'An invalid eager receipt must restore protective pending');
  await setStored(f,CONTROL,RECEIPT+f.fileRows[0].seq,receipt);
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
});

test('a shared orphan row needs both project ACKs and partial ownership never hides the other project\'s unacknowledged files',async()=>{
  const f=await app();Object.assign(f.ctx,{File,setTimeout,clearTimeout,TextDecoder,TextEncoder});
  const first=await bind(f,{metadata:true}),otherId='other-project',otherScope={...scope,projectId:'other-shared-project'};
  let workspace=JSON.parse(f.records.getItem(WS));workspace.projects.push({id:otherId,name:'Other project',drawings:[]});
  f.records.setItem(WS,json(workspace));await f.records.settled();const second=await bindOther(f,otherId,otherScope);
  const ids=['unassigned-left','unassigned-right'],keys=ids.map(id=>'photo:'+id+':removed');
  for(let index=0;index<ids.length;index++){
    f.records.setItem(DRAW+ids[index],drawing());await f.records.settled();await f.records.writeFile(keys[index],image(5*MIB,31+index));
  }
  await f.records.removeFiles(keys);
  const row=[...(await f.disk(LOG)).values()].find(row=>row.files.length===2);assert(row);assert.equal(row.projectIds.length,0);
  assert.equal(row.files.reduce((total,file)=>total+file.before.size,0),10*MIB);const before=await fingerprint(row);
  workspace=JSON.parse(f.records.getItem(WS));workspace.projects.find(project=>project.id===localProjectId).drawings.push({id:ids[0],name:'Left'});
  workspace.projects.find(project=>project.id===otherId).drawings.push({id:ids[1],name:'Right'});
  f.records.setItem(WS,json(workspace));await f.records.settled();f.engine=first;await drain(f,{deferCompact:true});
  const partial=await receiptFor(f,row);assert(partial);assert.deepEqual(partial.resolvedProjectIds,[localProjectId]);
  assert((await f.records.deltaJournal.pending({scope:otherScope,localProjectId:otherId})).count>0);
  const remaining=await f.records.deltaJournal.claim({scope:otherScope,localProjectId:otherId});assert(remaining.rowIds.includes(row.id));
  assert.equal(remaining.fileReferences.filter(reference=>reference.rowId===row.id).length,2,'A partial receipt must not filter the original row from replay');
  f.engine=second;await drain(f,{deferCompact:true});
  const complete=await receiptFor(f,row);assert.deepEqual(new Set(complete.resolvedProjectIds),new Set([localProjectId,otherId]));
  workspace=JSON.parse(f.records.getItem(WS));for(const project of workspace.projects)project.drawings=project.drawings.filter(drawing=>!ids.includes(drawing.id));
  f.records.batch([[WS,json(workspace)],...ids.map(id=>[DRAW+id,null])],{operation:'delete'});await f.records.settled();
  f.engine=first;await drain(f,{deferCompact:true});f.engine=second;await drain(f,{deferCompact:true});
  for(const [projectScope,id]of [[scope,localProjectId],[otherScope,otherId]]){
    assert.equal((await f.records.deltaJournal.pending({scope:projectScope,localProjectId:id})).count,0);
    assert.equal(await f.records.deltaJournal.claim({scope:projectScope,localProjectId:id}),null);
  }
  assert.deepEqual(await fingerprint((await f.disk(LOG)).get(row.seq)),before,'Both unique deletion preimages must stay exact');
  const live=await f.disk();for(const key of keys)assert.equal(live.get(key),undefined);
  await setStored(f,CONTROL,RECEIPT+row.seq,partial);
  for(const [projectScope,id]of [[scope,localProjectId],[otherScope,otherId]])
    assert.equal((await f.records.deltaJournal.pending({scope:projectScope,localProjectId:id})).count,1,'Incomplete coverage must restore orphan protection');
});

test('a different genuinely unassigned file remains pending after an unrelated ACK despite an existing valid receipt',async()=>{
  const f=await coveredDeleted(),id='never-assigned',key='photo:'+id+':unsent',raw=drawing();
  f.records.setItem(DRAW+id,raw);await f.records.settled();await f.records.writeFile(key,image(9*MIB,19));
  edit(f,'unrelated acknowledged edit');await f.records.settled();await drain(f);
  const unresolved=[...(await f.disk(LOG)).values()].filter(row=>row.drawingIds?.includes(id));
  assert(unresolved.length>=2);for(const row of unresolved)assert.equal(await receiptFor(f,row),undefined);
  assert((await f.records.deltaJournal.pending({scope,localProjectId})).count>=2);
  const before=await snapshot(f);const projected=await f.records.deltaJournal.applyProjection(incoming(f,id,raw));assert.equal(projected.deferred,true);
  await assert.rejects(()=>archive(f),error=>error.code==='JOURNAL_PENDING');assert.deepEqual(await snapshot(f),before);
  assert.equal((await f.disk()).get(key).size,9*MIB);assert(await receiptFor(f));
});

test('a proved oversized history does not block incoming ownership and keeps its exact WAL and photo',async()=>{
  const f=await coveredDeleted(),before=await fingerprint((await f.disk(LOG)).get(f.fileRows[0].seq));
  const photoHash=await hash((await f.disk()).get(f.keys[0]));
  const result=await f.records.deltaJournal.applyProjection(incoming(f));assert.equal(result.applied,true);assert.equal(result.deferred,undefined);
  assert.equal(f.records.getItem(DRAW+ORPHAN),f.originalRaw);
  assert.deepEqual(await fingerprint((await f.disk(LOG)).get(f.fileRows[0].seq)),before);
  assert.equal(await hash((await f.disk()).get(f.keys[0])),photoHash);
});

test('local archive guard accepts proved oversized history while retaining every live and historical file',async()=>{
  const f=await coveredDeleted(),fileHash=await hash((await f.disk()).get(f.keys[0])),before=await fingerprint((await f.disk(LOG)).get(f.fileRows[0].seq));
  await archive(f);assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  assert.deepEqual(await fingerprint((await f.disk(LOG)).get(f.fileRows[0].seq)),before);
  assert.equal(await hash((await f.disk()).get(f.keys[0])),fileHash);
});

test('PC restoration accepts another project\'s proved orphan history but rejects the same row when its receipt changes',async()=>{
  const f=await app();Object.assign(f.ctx,{File,setTimeout,clearTimeout,TextDecoder,TextEncoder});
  await bind(f,{metadata:true});const archived=f.capture(),certificate={schema:1,projectId:scope.projectId,headSeq:0,revision:1,payloadSha256:'a'.repeat(64)},jobId='restore-test-job';
  await f.records.archiveAtomic({writes:[[WS,json({projects:[]})],[DRAW+'drawing-1',null]],deleteFiles:[],expectedWorkspace:f.records.getItem(WS),
    operation:'archive-local',context:{localArchive:true,mode:'project',projectId:localProjectId,jobId,deltaCheckpoint:certificate}});
  const archivedThrough=f.records.deltaJournal.bindingFor(localProjectId).lastLocalArchiveSeq,otherId='other-project',otherScope={...scope,projectId:'other-shared-project'};
  f.records.setItem(WS,json({projects:[{id:otherId,name:'Other project',drawings:[]}]}));await f.records.settled();
  f.engine=await bindOther(f,otherId,otherScope);
  f.records.setItem(DRAW+ORPHAN,drawing());await f.records.settled();const key='photo:'+ORPHAN+':restore-guard';
  await f.records.writeFile(key,image(9*MIB,23));
  const row=[...(await f.disk(LOG)).values()].find(row=>row.files.some(file=>file.key===key));assert(row.seq>archivedThrough);assert.equal(row.projectIds.length,0);
  const workspace=JSON.parse(f.records.getItem(WS));workspace.projects[0].drawings.push({id:ORPHAN,name:'Later owned by another project'});
  f.records.setItem(WS,json(workspace));await f.records.settled();await drain(f);
  workspace.projects[0].drawings=[];f.records.batch([[WS,json(workspace)],[DRAW+ORPHAN,null]],{operation:'delete'});await f.records.settled();await drain(f);
  const receipt=await receiptFor(f,row);assert(receipt);assert.deepEqual(receipt.resolvedProjectIds,[otherId]);
  const before=await fingerprint((await f.disk(LOG)).get(row.seq)),photoHash=await hash((await f.disk()).get(key));
  const request={scope,localProjectId,certificate,jobId,files:[],snapshot:archived,validate:()=>true};
  const ticket=await f.records.deltaJournal.proveArchiveRestore(request);assert.equal(await f.records.deltaJournal.validateArchiveRestore(ticket,request),true);
  await setStored(f,CONTROL,RECEIPT+row.seq,{...receipt,descriptor:receipt.descriptor+' '});
  await assert.rejects(()=>f.records.deltaJournal.proveArchiveRestore(request),error=>error.code==='JOURNAL_RESTORE_PENDING');
  await assert.rejects(()=>f.records.deltaJournal.validateArchiveRestore(ticket,request),error=>error.code==='JOURNAL_RESTORE_CHANGED');
  assert.deepEqual(await fingerprint((await f.disk(LOG)).get(row.seq)),before);assert.equal(await hash((await f.disk()).get(key)),photoHash);
});

test('malformed or mismatched receipts never suppress pending, projection or archive protection',async()=>{
  const f=await coveredDeleted(),row=f.fileRows[0],key=RECEIPT+row.seq,original=await receiptFor(f);assert(original);
  const changes=[
    ['version',value=>{value.version=2;}],['kind',value=>{value.kind='unknown-receipt';}],
    ['row identity',value=>{value.rowId+='-other';}],['sequence',value=>{value.seq++;}],
    ['descriptor',value=>{value.descriptor+=' ';}],['resolved owners',value=>{value.resolvedProjectIds=[];}],
    ['proof owner',value=>{value.proofs[0].localProjectId='foreign-project';}],
    ['proof scope',value=>{value.proofs[0].scope.projectId='foreign-cloud';}],
    ['ACK proof scope',value=>{value.proofs[0].lastProof.scope.ownerId='foreign-owner';}],
    ['ACK proof digest',value=>{value.proofs[0].lastProof.requiredSha256='not-a-sha256';}],
    ['ACK proof claim',value=>{value.proofs[0].lastProof.claimId='';}],
    ['uncovered phase',value=>{value.proofs[0].phase='staging';}],
    ['uncovered sequence',value=>{Object.assign(value.proofs[0],{ackedSeq:0,cutoffSeq:0,lastLocalArchiveSeq:0});}],
    ['drawing coverage',value=>{value.proofs[0].drawingIds=[];}],['missing proofs',value=>{value.proofs=[];}],
    ['empty baseline proof',value=>{Object.assign(value.proofs[0],{ackedSeq:row.seq,lastProof:null,cutoffSeq:row.seq,baselineProof:{},lastLocalArchiveSeq:0});}],
    ['foreign resumed baseline',value=>{Object.assign(value.proofs[0],{ackedSeq:row.seq,lastProof:null,cutoffSeq:row.seq,lastLocalArchiveSeq:0,
      baselineProof:{migrationId:'synthetic-migration',localProjectId:'foreign-project',fingerprint:'a'.repeat(64)}});}],
    ['incomplete archive certificate',value=>{Object.assign(value.proofs[0],{ackedSeq:0,lastProof:null,cutoffSeq:0,lastLocalArchiveSeq:row.seq,
      archive:{context:{deltaCheckpoint:{schema:1,projectId:scope.projectId,payloadSha256:'a'.repeat(64)}}}});}],
  ];
  for(const [label,change]of changes){
    const invalid=copy(original);change(invalid);await setStored(f,CONTROL,key,invalid);
    assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,1,label+' must not hide original work');
    const received=await f.records.deltaJournal.applyProjection(incoming(f));assert.equal(received.deferred,true,label+' must protect incoming ownership');
    await assert.rejects(()=>archive(f),error=>error.code==='JOURNAL_PENDING',label+' must protect local archive');
    assert.equal(f.records.getItem(DRAW+ORPHAN),null);assert.equal((await f.disk(LOG)).get(row.seq).kind,'sentlog-app-intent');
  }
  await setStored(f,CONTROL,key,original);assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
});

test('a receipt stored under the wrong key or matching a changed WAL descriptor is ignored',async()=>{
  const f=await coveredDeleted(),original=(await f.disk(LOG)).get(f.fileRows[0].seq),key=RECEIPT+original.seq,receipt=await receiptFor(f);
  await setStored(f,CONTROL,key,undefined);await setStored(f,CONTROL,RECEIPT+(original.seq+100),receipt);
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,1);
  await setStored(f,CONTROL,RECEIPT+(original.seq+100),undefined);await setStored(f,CONTROL,key,receipt);
  await setStored(f,LOG,original.seq,{...original,at:original.at+1});
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,1);
  assert.equal((await f.records.deltaJournal.applyProjection(incoming(f))).deferred,true);
  await setStored(f,LOG,original.seq,original);assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
});

test('receipt persistence failure rolls back ACK and keeps a stable retryable claim without duplicate replay or lost bytes',async()=>{
  const f=await staged(),claim=await f.records.deltaJournal.claim({scope,localProjectId});assert(claim);
  const before=await snapshot(f),bindingBefore=copy(f.records.deltaJournal.bindingFor(localProjectId)),put=IDBObjectStore.prototype.put;let rejected=0;
  IDBObjectStore.prototype.put=function(value,key){if(this.name===CONTROL&&String(key).startsWith(RECEIPT)){rejected++;throw Error('synthetic receipt storage failure');}return put.call(this,value,key);};
  try{await assert.rejects(()=>drain(f),/synthetic receipt storage failure/);}
  finally{IDBObjectStore.prototype.put=put;}
  assert.equal(rejected,1);assert.deepEqual(await snapshot(f),before);assert.equal(f.records.failed,false);
  assert.equal(f.records.deltaJournal.bindingFor(localProjectId).ackedSeq,bindingBefore.ackedSeq);
  assert.equal((await f.records.deltaJournal.claim({scope,localProjectId})).id,claim.id);
  assert.equal(await receiptFor(f),undefined);
  const replicaBefore=f.engine.read();assert(replicaBefore.outbox.length>0,'Replica commit precedes the failed writer ACK');
  await drain(f);assert.deepEqual(f.engine.read(),replicaBefore,'Retry must use the same immutable replay events');
  assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
  assert.equal(await f.records.deltaJournal.claim({scope,localProjectId}),null);
  assert(await receiptFor(f));assert.deepEqual(await fingerprint((await f.disk(LOG)).get(f.fileRows[0].seq)),await fingerprint(f.fileRows[0]));
});

(async()=>{let passed=0;for(const [name,run]of cases){await run();passed++;console.log('PASS',name);}
  console.log(JSON.stringify({passed,total:cases.length,actualWriter:true,actualReplayAndACK:true,maximumCopyBytesPerPass:8*MIB,
    oversizedOriginalBytes:9*MIB,oldReaderKeepsProtectivePending:true,nativeBrowserExecuted:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});

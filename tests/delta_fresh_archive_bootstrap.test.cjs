'use strict';
// The actual installer reads the actual immutable baseline and accepted SQL
// log into a fresh IndexedDB. No browser, local server or deployed DB is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange}=require('fake-indexeddb');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const M=require('../sentlog/delta-sync-metadata.js'),I=require('../sentlog/delta-sync-indexeddb.js');
const R=require('../sentlog/delta-sync-reconcile.js'),Bootstrap=require('../sentlog/delta-sync-bootstrap.js');
const Migration=require('../sentlog/delta-sync-migration.js'),Source=require('../sentlog/delta-sync-legacy-source.js');
const Installer=require('../sentlog/delta-sync-app-migration.js'),Bridge=require('../sentlog/delta-sync-app-bridge.js');
const Journal=require('../sentlog/delta-sync-app-journal.js'),Transport=require('../sentlog/delta-sync-transport.js');
const {createBackend,statusOf}=require('./delta_app_backend.cjs');
const owner='11111111-1111-4111-8111-111111111111',writer='33333333-3333-4333-8333-333333333333';
const reader='44444444-4444-4444-8444-444444444444',project='55555555-5555-4555-8555-555555555555';
const pc='77777777-7777-4777-8777-777777777777',localProjectId='fresh-archive-project';
const scope={ownerId:owner,projectId:project,deviceId:reader},actor={deviceId:writer,deviceName:'Original phone'};
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',copy=structuredClone;
const sha=async blob=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS',name);}

async function serverFixture(){
 const backend=await createBackend(),requests=[];
 const args={p_project_id:project,p_device_id:writer};
 const rpc=(name,body)=>backend.request({ownerId:owner,method:'POST',path:'/rest/v1/rpc/'+name,body});
 const archive=(action,data={},device=writer)=>rpc('sentlog_archive_v1',{...args,p_device_id:device,p_action:action,p_data:data});
 const baseRecord=C.upgrade({id:'record-one',kind:'point',x:1,y:2,memo:'Immutable baseline',photos:[]});
 const meta={id:'drawing-one',name:'Original drawing',fileName:'one.pdf',sourceType:'pdf'};
 const baselinePayload={project:{id:localProjectId,name:'Fresh archive',collaborationVersion:1,drawings:[meta]},
  drawings:[{meta:copy(meta),state:{fileName:'one.pdf',sourceType:'pdf',pageSettings:{1:{scale:100}},shapes:[baseRecord],collabDeletedRecords:[]}}]};
 const files=new Map([['background:drawing-one',new Blob(['pdf-one'],{type:'application/pdf'})],
  ['background:図面-二😀',new Blob(['pdf-two'],{type:'application/pdf'})]]);
 await backend.seed({ownerId:owner,devices:[{id:writer,name:'A'},{id:reader,name:'B'},{id:pc,name:'PC',type:'pc'}],
  projects:[{id:project,client_key:localProjectId,payload:baselinePayload}],rollout:true});
 const baseline=await rpc('sentlog_delta_prepare_baseline_v1',{...args,p_expected_revision:1});
 await rpc('sentlog_delta_import_baseline_batch_v1',{...args,p_baseline_id:baseline.baselineId,p_limit:100});
 const receipt=await rpc('sentlog_delta_activate_baseline_v1',{...args,p_baseline_id:baseline.baselineId,
  p_proof:{writerVersion:2,migrationId:'source-activation',sourceFingerprint:'a'.repeat(64),planSha256:'b'.repeat(64)}});
 let records={[D.keyOf(meta.id,baseRecord.id)]:baseRecord,...await M.seed(baselinePayload)};
 const after=copy(baselinePayload);after.project.name='Accepted project name';after.drawings[0].state.pageSettings[1].scale=250;
 const newMeta={id:'図面-二😀',name:'Accepted new drawing',fileName:'two.pdf',sourceType:'pdf'};
 const newRecord=C.upgrade({id:'record-二😀',kind:'point',x:3,y:4,memo:'Accepted record in new drawing',photos:[]});
 after.project.drawings.push(newMeta);after.drawings.push({meta:copy(newMeta),state:{fileName:'two.pdf',sourceType:'pdf',shapes:[newRecord],collabDeletedRecords:[]}});
 const metadata=await M.edit({before:baselinePayload,after,currentRecords:records,operationId:'accepted-metadata',actor,at:5});
 let changed=C.appendComment(baseRecord,'Accepted after baseline',{actor,at:5,commentId:'accepted-comment',revisionId:'accepted-comment'});
 const events=[D.diffRecord(baseRecord,changed,{projectId:project,deviceId:writer,drawingId:meta.id,eventId:'accepted-record'}),
  ...metadata.changes.map((change,n)=>D.diffRecord(change.before,change.after,{projectId:project,deviceId:writer,drawingId:M.namespace,eventId:'accepted-meta-'+n})),
  D.diffRecord(null,newRecord,{projectId:project,deviceId:writer,drawingId:newMeta.id,eventId:'accepted-new-record'})];
 const group=D.validateGroup({schema:1,kind:'atomic-group',groupId:'accepted-group',projectId:project,deviceId:writer,events});
 const groupReceipt=await rpc('sentlog_delta_append_group_v1',{...args,p_group:group});
 for(const event of events){const key=D.keyOf(event.drawingId,event.recordId);records[key]=D.combine(records[key]||null,event);}
 const latest=C.appendComment(changed,'Accepted standalone after group',{actor,at:6,commentId:'accepted-last',revisionId:'accepted-last'});
 const last=D.diffRecord(changed,latest,{projectId:project,deviceId:writer,drawingId:meta.id,eventId:'accepted-last'});
 await rpc('sentlog_delta_append_v1',{...args,p_event_id:last.eventId,p_drawing_id:last.drawingId,p_record_id:last.recordId,p_envelope:last});
 records[D.keyOf(meta.id,baseRecord.id)]=D.combine(records[D.keyOf(meta.id,baseRecord.id)],last);
 const head=groupReceipt.endSeq+1;
 const certificate=await rpc('sentlog_delta_publish_checkpoint_v1',{...args,p_expected_head:head,p_request_id:'fresh-archive-checkpoint'});
 await backend.admin({action:'assets',ownerId:owner,assets:await Promise.all([...files].map(async([key,blob])=>({
  project_id:project,client_key:'drawing:'+key.slice('background:'.length),kind:'drawing',file_name:key+'.pdf',mime_type:blob.type,
  byte_size:blob.size,sha256:await sha(blob),status:'uploaded'})))});
 const job=await archive('begin',{revision:certificate.revision});
 for(const device of [writer,reader])await archive('report',{job_id:job.id,catalog_hash:job.catalog_hash,clean:true,
  delta_proof:{schema:1,headSeq:head,cursor:device===writer?head:null,pending:0,revision:certificate.revision,
   payloadSha256:certificate.payloadSha256,...(device===reader?{absent:true}:{})}},device);
 await archive('pc_complete',{job_id:job.id,catalog_hash:job.catalog_hash,file_count:job.manifest.length,
  package_sha256:'c'.repeat(64),path:'synthetic/fresh-archive'},pc);
 assert.equal((await archive('finalize',{job_id:job.id})).status,'archived');
 const session={access_token:'synthetic-session',user:{id:owner}};
 const provider=Transport.createRestProvider({url:'https://synthetic.invalid',key:'synthetic-public-key',session:()=>session,
  subscribeAuth:()=>()=>{},Socket:null,fetch:async(url,options)=>{
   const pathname=new URL(url).pathname;
   if(pathname==='/auth/v1/user')return new Response(JSON.stringify({id:owner}),{status:200});
   requests.push({path:pathname,body:JSON.parse(options.body)});
   try{return new Response(JSON.stringify(await backend.request({ownerId:owner,method:options.method,path:pathname,body:options.body})),{status:200});}
   catch(error){return new Response(JSON.stringify({code:error.code,message:error.message}),{status:statusOf(error)});}
  }});
 const transport=Transport.createTransport({provider,scope,currentScope:()=>scope,online:()=>true});await transport.ready();
 return {backend,transport,requests,args,rpc,archive,receipt,certificate,head,group,files,baselinePayload,records,
  async close(){transport.close();await backend.close();}};
}

async function localFixture(server,payload=server.certificate.payload){
 const factory=new IDBFactory(),memory=new Map([[WS,JSON.stringify({projects:[payload.project]})],
  ...payload.drawings.map(d=>[DRAW+d.meta.id,JSON.stringify(d.state)])]);
 const localStorage={get length(){return memory.size;},key:i=>[...memory.keys()][i]??null,getItem:key=>memory.get(key)??null,
  setItem:(key,value)=>memory.set(key,String(value)),removeItem:key=>memory.delete(key)};
 const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,structuredClone,
  crypto:webcrypto,SentlogDeltaSyncCore:D};context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8'),context);
 const records=context.SentlogRecords;await records.init();for(const [key,blob]of server.files)await records.writeFile(key,blob);
 const store=I.createStore({...scope,indexedDB:factory});
 const factories={source:args=>Source.createSource({...args,indexedDB:factory,localStorage,crypto:webcrypto}),
  migrationStore:s=>Migration.createStore({...s,indexedDB:factory})};
 const installer=Installer.createInstaller({records,factories});
 const args=async()=>({scope,localProjectId,transport:server.transport,store,mode:await server.transport.inspect(),
  currentScope:()=>scope,actor:{deviceId:reader,deviceName:'Fresh phone'}});
 async function bootstrap(transport=server.transport){
  const staged=await records.deltaJournal.begin({scope,localProjectId,serverRevision:server.certificate.revision,
   actor:{deviceId:reader,deviceName:'Fresh phone'}});
  const rawSource=factories.source({journal:records.deltaJournal});
  const source={capture:id=>rawSource.capture(id,{recordCutoff:staged}),recheck:snapshot=>rawSource.recheck(snapshot)};
  const migration=Migration.createCoordinator({source,store:factories.migrationStore(scope),localProjectId,currentScope:()=>scope});
  const coordinator=Bootstrap.createCoordinator({source,migration,replicaStore:store,transport,localProjectId,currentScope:()=>scope,timeoutMs:30000});
  return {source,migration,coordinator,prepare:()=>coordinator.prepare({migrationId:'fresh-handover',receipt:server.receipt}),
   install:plan=>coordinator.install({migrationId:'fresh-handover',plan,assertLegacyWritesBlocked:()=>records.deltaJournal.assertFence({scope,localProjectId})}),
   close(){coordinator.close();migration.close();rawSource.close();}};
 }
 return {records,store,factory,installer,args,bootstrap,close(){store.close();}};
}

(async()=>{
 const server=await serverFixture();
 try{
  await test('baseline-only bootstrap reproduces duplicate accepted intents on a fresh archived checkpoint',async()=>{
   const f=await localFixture(server);let h;try{
    const legacy={...server.transport};delete legacy.inspect;delete legacy.list;h=await f.bootstrap(legacy);
    const prepared=await h.prepare();assert.equal(prepared.readyForInstall,true,JSON.stringify(prepared.plan.reviewItems));
    assert.equal(prepared.plan.state.cursor,0);assert(prepared.plan.state.outbox.length>0);
    assert.equal(await f.store.read(),null,'reproduction never installs the unsafe pending seed');
   }finally{h?.close();f.close();}
  });
  await test('actual fresh-device installer restores archived accepted records, metadata and new drawing without append',async()=>{
   const f=await localFixture(server);let replica,bridge,controller;try{
    assert.equal(await f.store.readProvenance(),null);const before=server.requests.length;
    assert.equal((await f.installer(await f.args())).installed,true);
    const saved=await f.store.read(),proof=await f.store.readProvenance();
    assert.equal(saved.cursor,server.head);assert.equal(saved.outbox.length,0);assert.equal(saved.blockedOutbox.length,0);
    assert.equal(proof.baseline.cursor,0);assert.equal(proof.accepted.headSeq,server.head);assert.equal(proof.accepted.eventCount,server.head);
    assert.deepEqual(Object.keys(saved.records).sort(),Object.keys(server.records).sort());
    for(const [key,record]of Object.entries(server.records))assert(C.equal(saved.records[key].collab,record.collab),key);
    replica=D.createReplica({...scope,store:f.store,transport:server.transport,reconcileIntervalMs:0});
    bridge=Bridge.createBridge({replica,scope,localProjectId,currentScope:()=>scope});
    controller=Journal.createController({records:f.records,scope,localProjectId,replica,replicaStore:f.store,bridge,metadata:M,currentScope:()=>scope});
    await controller.drain();const result=await replica.sync();assert.equal(result.pending,0);assert.equal(result.cursor,server.head);
    assert.equal((await recordsPending(f)).count,0);assert.equal((await f.store.read()).outbox.length,0);
    assert.equal(server.requests.slice(before).filter(r=>/append|activate|prepare_baseline|import_baseline/.test(r.path)).length,0);
    const projected=await bridge.project();assert.equal(projected.project.name,'Accepted project name');
    assert.equal(projected.drawings[0].state.pageSettings[1].scale,250);assert.equal(projected.drawings[1].meta.id,'図面-二😀');
    assert.equal((await server.backend.state({ownerId:owner,projectId:project})).projects[0].status,'archived');
    assert.equal((await f.installer(await f.args())).resumed,true);assert.equal((await f.store.read()).outbox.length,0);
   }finally{controller?.close();bridge?.close();replica?.close();f.close();}
  });
  await test('fresh archived bootstrap retains genuinely unsent local changes and archived SQL still refuses them',async()=>{
   const local=copy(server.certificate.payload),old=local.drawings[0].state.shapes[0];
   local.drawings[0].state.shapes[0]=C.appendComment(old,'Only on the fresh device',{actor:{deviceId:reader,deviceName:'Fresh phone'},at:8,
    commentId:'unaccepted-local',revisionId:'unaccepted-local'});
   const f=await localFixture(server,local);let replica;try{
    await f.installer(await f.args());const saved=await f.store.read();assert.equal(saved.cursor,server.head);assert.equal(saved.outbox.length,1);
    assert(saved.records[D.keyOf('drawing-one','record-one')].memo.includes('Only on the fresh device'));
    const events=saved.outbox.flatMap(D.eventsOf);assert.equal(events.length,1);assert.equal(events[0].recordId,'record-one');
    replica=D.createReplica({...scope,store:f.store,transport:server.transport,reconcileIntervalMs:0});
    await assert.rejects(()=>replica.sync(),error=>error.code==='DELTA_PROJECT_FORBIDDEN');
    const kept=await f.store.read();assert.deepEqual(kept.outbox,saved.outbox);assert.equal(kept.cursor,server.head);
    assert.equal((await server.backend.state({ownerId:owner,projectId:project})).counts.events,server.head);
   }finally{replica?.close();f.close();}
  });
  await test('pinned accepted history is reread before atomic installation and exact retries retain provenance',async()=>{
   const f=await localFixture(server);let h,shortPage=true;try{
    const transport={...server.transport,list:async(...args)=>{const rows=await server.transport.list(...args);return shortPage?rows.slice(0,1):rows;}};
    h=await f.bootstrap(transport);const prepared=await h.prepare();assert(prepared.readyForInstall,JSON.stringify(prepared.plan.reviewItems));
    assert.equal(prepared.plan.state.cursor,server.head);assert.equal(prepared.plan.state.outbox.length,0);
    shortPage=false;
    const first=await h.install(prepared.plan),again=await h.install(prepared.plan);
    assert.equal(first.idempotent,false);assert.equal(again.idempotent,true);assert.deepEqual(again.provenance,first.provenance);
    assert.deepEqual(again.state,first.state);
   }finally{h?.close();f.close();}
  });
  await test('a changed accepted event cannot replace the protected source or initialize a replica',async()=>{
   const f=await localFixture(server);let h,mutate=false;try{
    const transport={...server.transport,list:async(...args)=>{const rows=await server.transport.list(...args);if(mutate){
     const altered=copy(rows);altered[altered.length-1].event.eventId='different-accepted-event';return altered;}return rows;}};
    h=await f.bootstrap(transport);const prepared=await h.prepare();assert(prepared.readyForInstall);mutate=true;
    await assert.rejects(()=>h.install(prepared.plan),/引き継ぐ内容が照合時から変わっています/);
    assert.equal(await f.store.read(),null);assert.equal((await h.migration.readCopy('fresh-handover')).status,'verified-copy');
   }finally{h?.close();f.close();}
  });
  await test('missing, foreign, split-group and partially replayed invalid histories stop before any installation',async()=>{
   for(const variant of ['gap','foreign','split','history']){
    const f=await localFixture(server);let h;try{
     const transport={...server.transport,
      inspect:async(...args)=>{const value=await server.transport.inspect(...args);if(variant==='split')value.headSeq=1;return value;},
      list:async(...args)=>{const rows=copy(await server.transport.list(...args));
       if(variant==='gap')rows.shift();if(variant==='foreign')rows[0].group.projectId='66666666-6666-4666-8666-666666666666';
       if(variant==='history')Object.values(rows[rows.length-1].event.patch.comments)[0].revisions[0].parents=['missing-parent'];return rows;}};
     h=await f.bootstrap(transport);const prepared=await h.prepare();assert.equal(prepared.readyForInstall,false,variant);
     assert(prepared.plan.reviewItems.some(item=>item.blocking),variant);assert.equal(await f.store.read(),null);
     if(variant==='history')assert(prepared.plan.state.records[D.keyOf('図面-二😀','record-二😀')],'the earlier valid group was reached');
     await assert.rejects(()=>h.install(prepared.plan));assert.equal(await f.store.read(),null);
     assert.equal((await h.migration.readCopy('fresh-handover')).status,'verified-copy');
    }finally{h?.close();f.close();}
   }
  });
  await test('installation stays at the verified head while newer accepted history arrives and sync catches up read-only',async()=>{
   await server.archive('reopen');const f=await localFixture(server);let h,replica;try{
    h=await f.bootstrap();const prepared=await h.prepare();assert(prepared.readyForInstall);
    const before=server.records[D.keyOf('drawing-one','record-one')];
    const after=C.appendComment(before,'After the prepared head',{actor,at:9,commentId:'after-pinned',revisionId:'after-pinned'});
    const event=D.diffRecord(before,after,{projectId:project,deviceId:writer,drawingId:'drawing-one',eventId:'after-pinned'});
    await server.rpc('sentlog_delta_append_v1',{...server.args,p_event_id:event.eventId,p_drawing_id:event.drawingId,p_record_id:event.recordId,p_envelope:event});
    const installed=await h.install(prepared.plan);assert.equal(installed.state.cursor,server.head);assert.equal(installed.state.outbox.length,0);
    assert(!installed.state.records[D.keyOf('drawing-one','record-one')].memo.includes('After the prepared head'));
    replica=D.createReplica({...scope,store:f.store,transport:server.transport,reconcileIntervalMs:0});const from=server.requests.length;
    assert.equal((await replica.sync()).cursor,server.head+1);assert.equal((await f.store.read()).outbox.length,0);
    assert((await f.store.read()).records[D.keyOf('drawing-one','record-one')].memo.includes('After the prepared head'));
    assert.equal(server.requests.slice(from).filter(r=>/append/.test(r.path)).length,0);
   }finally{h?.close();replica?.close();f.close();}
  });
  console.log('PASS fresh archive bootstrap:',passed,'actual installer/SQL and durability groups');
 }finally{await server.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
function recordsPending(f){return f.records.deltaJournal.pending({scope,localProjectId});}

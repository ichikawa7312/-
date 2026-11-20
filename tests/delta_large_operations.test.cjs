'use strict';
const assert=require('node:assert/strict');if(!globalThis.crypto)globalThis.crypto=require('node:crypto').webcrypto;
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js'),M=require('../sentlog/delta-sync-metadata.js'),B=require('../sentlog/delta-sync-app-bridge.js');
const copy=x=>structuredClone(x),scope={ownerId:'owner',projectId:'project',deviceId:'pc'},actor={deviceId:'pc',deviceName:'PC'};
function data(count,value='old'){
 const old=[],current=[];for(let i=0;i<count;i++){
  const id='record-'+String(i).padStart(4,'0'),base=C.upgrade({id,member:value,memo:i?'':'original note',photos:[]});old.push(base);
  let next=C.upgrade({id,member:value,future:'retain',memo:i?'':'original note',photos:[]});next=C.setField(next,'member','current',{revisionId:'current:'+id,expectedHeads:C.view(next).fields.member.headIds,actor,at:1});
  if(!i)next=C.appendComment(next,'recent note',{commentId:'recent',revisionId:'recent-revision',actor,at:1});current.push(next);
 }
 const meta={id:'drawing',name:'Drawing'},snapshot=records=>({version:1,kind:'sentlog-app-project',localProjectId:'local',project:{id:'local',name:'Project',drawings:[copy(meta)]},drawings:[{meta:copy(meta),state:{shapes:copy(records),collabDeletedRecords:[],pageSettings:{1:{scale:100}}}}]});
 return {before:snapshot(current),backup:snapshot(old)};
}
async function environment(before,stored){
 let state=stored?copy(stored):{version:2,scope:copy(scope),cursor:0,outbox:[],records:await M.seed(before)},writes=0,attempts=0,failAt=Infinity;
 if(!stored)for(const drawing of before.drawings)for(const record of [...drawing.state.shapes,...drawing.state.collabDeletedRecords])state.records[D.keyOf(drawing.meta.id,record.id)]=copy(record);
 const store={read:async()=>copy(state),write:async next=>{if(++attempts===failAt)throw Error('simulated quota');state=copy(next);writes++;}},transport={online:()=>false,push:async()=>{throw Error('offline');},list:async()=>[],pushGroup:async()=>{throw Error('offline');},getCapabilities:()=>({atomicGroups:true,sharedMetadata:true})};
 const replica=D.createReplica({...scope,store,transport}),bridge=B.createBridge({replica,scope,localProjectId:'local',currentScope:()=>scope});
 return {replica,bridge,state:()=>copy(state),writes:()=>writes,failOn:n=>failAt=n,close(){bridge.close();replica.close();}};
}
function options(before,after,id,operation){let n=0;return {before,after,operation,actor,at:10,operationId:id,groupId:id+':group',idFactory:()=>id+':'+(++n),replay:true};}
let count=0;async function test(name,run){await run();count++;console.log('PASS '+name);}
(async()=>{
 await test('501-record backup restore authors requested fields and keeps omitted histories',async()=>{
  const {before,backup}=data(501),e=await environment(before);try{
   const plan=await e.bridge.prepare(options(before,backup,'restore-501','restore'));assert.equal(plan.ready,true,JSON.stringify(plan.issues));assert.equal(plan.decomposed,true);assert.equal(plan.changes.length,501);assert.equal(plan.segments.length,2);
   const receipt=await e.bridge.commit(plan);assert.equal(receipt.projection.drawings[0].state.shapes.length,501);assert(receipt.projection.drawings[0].state.shapes.every(r=>r.member==='old'&&r.future==='retain'));
   assert.equal(receipt.projection.drawings[0].state.shapes[0].memo,'original note\n\nrecent note');assert.equal(e.state().outbox.length,2);for(const group of e.state().outbox)D.validateGroup(group);
  }finally{e.close();}
 });
 await test('501-record drawing deletion publishes membership after complete tombstone segments',async()=>{
  const {before}=data(501),after=copy(before);after.project.drawings=[];after.drawings=[];const e=await environment(before);try{
   const plan=await e.bridge.prepare(options(before,after,'delete-501','delete'));assert.equal(plan.ready,true,JSON.stringify(plan.issues));assert.equal(plan.decomposed,true);const receipt=await e.bridge.commit(plan);
   assert.equal(receipt.projection.drawings.length,0);assert.equal(receipt.projection.project.deltaMetadata.retainedDrawings[0].state.collabDeletedRecords.length,501);
   const events=e.state().outbox.flatMap(D.eventsOf);assert.equal(events.length,502);assert(events.slice(0,501).every(e=>e.drawingId==='drawing'));assert.equal(events[501].drawingId,M.namespace);for(const group of e.state().outbox)D.validateGroup(group);
  }finally{e.close();}
 });
 await test('restart after the first committed restore segment resumes without duplicate events or lost intent',async()=>{
  const {before,backup}=data(501),e=await environment(before);let retained;
  try{e.failOn(2);const plan=await e.bridge.prepare(options(before,backup,'restore-crash','restore'));assert(plan.ready);await assert.rejects(()=>e.bridge.commit(plan),/simulated quota/);retained=e.state();assert.equal(retained.outbox.length,1);assert.equal(retained.outbox[0].events.length,500);}finally{e.close();}
  const resumed=await environment(before,retained);try{const plan=await resumed.bridge.prepare(options(before,backup,'restore-crash','restore'));assert.equal(plan.ready,true,JSON.stringify(plan.issues));assert.equal(plan.changes.length,1);const receipt=await resumed.bridge.commit(plan);
   assert(receipt.projection.drawings[0].state.shapes.every(r=>r.member==='old'));const events=resumed.state().outbox.flatMap(D.eventsOf);assert.equal(events.length,501);assert.equal(new Set(events.map(e=>e.eventId)).size,501);
  }finally{resumed.close();}
 });
 await test('a partially staged deletion keeps the drawing and all remaining records visible until retry finishes',async()=>{
  const {before}=data(501),after=copy(before);after.project.drawings=[];after.drawings=[];const e=await environment(before);let retained;
  try{e.failOn(2);const plan=await e.bridge.prepare(options(before,after,'delete-crash','delete'));assert(plan.ready);await assert.rejects(()=>e.bridge.commit(plan),/simulated quota/);retained=e.state();const partial=await M.project({records:retained.records,template:before});assert.equal(partial.drawings.length,1);assert.equal(partial.drawings[0].state.shapes.length,1);assert.equal(partial.drawings[0].state.collabDeletedRecords.length,500);}finally{e.close();}
  const resumed=await environment(before,retained);try{const plan=await resumed.bridge.prepare(options(before,after,'delete-crash','delete'));assert.equal(plan.ready,true,JSON.stringify(plan.issues));const receipt=await resumed.bridge.commit(plan);assert.equal(receipt.projection.drawings.length,0);assert.equal(resumed.state().outbox.flatMap(D.eventsOf).length,502);}finally{resumed.close();}
 });
 await test('restore over 4 MiB is divided by actual PostgreSQL group size before any write',async()=>{
  const value='L'.repeat(180*1024),{before,backup}=data(25,value),e=await environment(before);try{
   const plan=await e.bridge.prepare(options(before,backup,'restore-bytes','restore'));assert.equal(plan.ready,true,JSON.stringify(plan.issues));assert.equal(plan.decomposed,true);assert(plan.segments.length>1);assert.equal(e.writes(),0);
   const receipt=await e.bridge.commit(plan);assert(receipt.projection.drawings[0].state.shapes.every(r=>r.member===value));for(const group of e.state().outbox)D.validateGroup(group);
  }finally{e.close();}
 });
 await test('restoring a new drawing publishes its metadata before its 501 records',async()=>{
  const {backup}=data(501),before=copy(backup);before.project.drawings=[];before.drawings=[];const e=await environment(before);try{
   const plan=await e.bridge.prepare(options(before,backup,'restore-new-drawing','restore'));assert.equal(plan.ready,true,JSON.stringify(plan.issues));assert.equal(plan.decomposed,true);
   const receipt=await e.bridge.commit(plan),events=e.state().outbox.flatMap(D.eventsOf);assert.equal(receipt.projection.drawings[0].state.shapes.length,501);assert.equal(events.length,502);assert.equal(events[0].drawingId,M.namespace);assert(events.slice(1).every(e=>e.drawingId==='drawing'));
   const replay=await e.bridge.prepare(options(before,backup,'restore-new-drawing','restore'));assert.equal(replay.ready,true,JSON.stringify(replay.issues));assert.equal(replay.changes.length,0);await e.bridge.commit(replay);assert.equal(e.state().outbox.flatMap(D.eventsOf).length,502);
  }finally{e.close();}
 });
 await test('restoring a retained deleted drawing authors alive revisions and publishes membership first',async()=>{
  const {before,backup}=data(501),removed=copy(before);removed.project.drawings=[];removed.drawings=[];const e=await environment(before);let hidden,stored;
  try{const deletion=await e.bridge.prepare(options(before,removed,'before-hidden-restore','delete'));hidden=(await e.bridge.commit(deletion)).projection;stored=e.state();stored.outbox=[];}finally{e.close();}
  const restored=await environment(hidden,stored);try{
   const plan=await restored.bridge.prepare(options(hidden,backup,'restore-hidden-drawing','restore'));assert.equal(plan.ready,true,JSON.stringify(plan.issues));assert.equal(plan.decomposed,true);
   const receipt=await restored.bridge.commit(plan),events=restored.state().outbox.flatMap(D.eventsOf);assert.equal(receipt.projection.drawings[0].state.shapes.length,501);assert(receipt.projection.drawings[0].state.shapes.every(r=>r.member==='old'&&r.future==='retain'));assert.equal(events.length,502);assert.equal(events[0].drawingId,M.namespace);
   assert(receipt.projection.drawings[0].state.shapes.every(r=>r.collab.deletion.revisions.some(x=>x.deleted)&&r.collab.deletion.revisions.some(x=>!x.deleted&&x.parents.length)));
  }finally{restored.close();}
 });
 await test('an oversized PostgreSQL event in a later segment rejects the entire plan before any write',async()=>{
  const {before,backup}=data(501);backup.drawings[0].state.shapes[500].member=Array(3500).fill(1e-100);const e=await environment(before);try{
   const plan=await e.bridge.prepare(options(before,backup,'restore-invalid-tail','restore'));assert.equal(plan.ready,false);assert(plan.issues.some(i=>i.code==='DELTA_TOO_LARGE'));await assert.rejects(()=>e.bridge.commit(plan),{code:'BRIDGE_REVIEW'});assert.equal(e.writes(),0);assert.equal(e.state().outbox.length,0);
  }finally{e.close();}
 });
 await test('restore before deletion projection uses retained replica history and retries without overwriting later edits',async()=>{
  const {before,backup}=data(1),removed=copy(before);removed.project.drawings=[];removed.drawings=[];const e=await environment(before);try{
   const deletion=await e.bridge.prepare(options(before,removed,'queued-delete','delete')),deleted=await e.bridge.commit(deletion);
   assert.equal(deleted.normalizedAfter.drawings.length,0);const args=options(deleted.normalizedAfter,backup,'queued-restore','restore');
   const plan=await e.bridge.prepare(args);assert.equal(plan.ready,true,JSON.stringify(plan.issues));const receipt=await e.bridge.commit(plan),restored=receipt.projection.drawings[0].state.shapes[0];assert.equal(restored.member,'old');assert.equal(restored.future,'retain');assert(restored.collab.deletion.revisions.some(r=>r.id.startsWith('bridge-restore:')&&r.id.endsWith(':complete')));
   const canonical=e.state().records[D.keyOf('drawing',restored.id)],afterPeer=C.setField(canonical,'member','peer after restore',{revisionId:'after-restored-peer',expectedHeads:C.view(canonical).fields.member.headIds,actor:{deviceId:'peer',deviceName:'Peer'},at:11});
   await e.replica.change({drawingId:'drawing',before:canonical,after:afterPeer,eventId:'peer-after-restore-event'});const priorCount=e.state().outbox.flatMap(D.eventsOf).length;
   const replay=await e.bridge.prepare(options(deleted.normalizedAfter,backup,'queued-restore','restore'));assert.equal(replay.ready,true,JSON.stringify(replay.issues));assert.equal(replay.changes.length,0);const retried=await e.bridge.commit(replay);assert.equal(retried.projection.drawings[0].state.shapes[0].member,'peer after restore');assert.equal(e.state().outbox.flatMap(D.eventsOf).length,priorCount);
  }finally{e.close();}
 });
 await test('oversized cross-drawing moves remain wholly uncommitted rather than losing one half',async()=>{
  const {before}=data(251),target={id:'target',name:'Target'};before.project.drawings.push(target);before.drawings.push({meta:copy(target),state:{shapes:[],collabDeletedRecords:[]}});const after=copy(before);
  after.drawings[0].state.collabDeletedRecords=before.drawings[0].state.shapes.map(r=>C.markDeleted(r,{expectedToken:C.revisionToken(r),revisionId:'move-delete:'+r.id,actor,at:9}));after.drawings[0].state.shapes=[];
  after.drawings[1].state.shapes=before.drawings[0].state.shapes.map(r=>C.upgrade({id:'copy:'+r.id,member:r.member,memo:r.memo,photos:[],transferOrigin:{operation:'move',drawingId:'drawing',recordId:r.id}}));
  const e=await environment(before);try{const plan=await e.bridge.prepare(options(before,after,'large-move','move'));assert.equal(plan.ready,false);assert.equal(plan.segments,undefined);assert(plan.issues.some(i=>i.code==='BRIDGE_BATCH'));await assert.rejects(()=>e.bridge.commit(plan),{code:'BRIDGE_REVIEW'});assert.equal(e.writes(),0);assert.equal(e.state().outbox.length,0);}finally{e.close();}
 });
 console.log('PASS large application operations: '+count+' checks');
})().catch(error=>{console.error(error);process.exitCode=1;});

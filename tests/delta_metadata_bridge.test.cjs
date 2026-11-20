'use strict';
const assert=require('node:assert/strict');if(!globalThis.crypto)globalThis.crypto=require('node:crypto').webcrypto;
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js'),M=require('../sentlog/delta-sync-metadata.js'),B=require('../sentlog/delta-sync-app-bridge.js');
const copy=x=>structuredClone(x),scope={ownerId:'owner',projectId:'server-project',deviceId:'pc'},actor={deviceId:'pc',deviceName:'PC'};
function input(){const meta={id:'drawing',name:'Drawing'},record=C.upgrade({id:'record',member:'pier',memo:'note',photos:[]});return {version:1,kind:'sentlog-app-project',localProjectId:'local-project',project:{id:'local-project',name:'Project',drawings:[meta]},drawings:[{meta:copy(meta),state:{shapes:[record],pageSettings:{'1':{scale:100,rotation:0}}}}]};}
async function env(){const before=input(),records=await M.seed(before);for(const d of before.drawings)for(const r of d.state.shapes)records[D.keyOf(d.meta.id,r.id)]=r;
 let state={version:2,scope:copy(scope),records,cursor:0,outbox:[]},writes=0;
 const store={read:async()=>copy(state),write:async next=>{state=copy(next);writes++;}},transport={online:()=>false,push:async()=>{throw Error('offline');},list:async()=>[],pushGroup:async()=>{throw Error('offline');},getCapabilities:()=>({atomicGroups:true,sharedMetadata:true})};
 const replica=D.createReplica({...scope,store,transport}),bridge=B.createBridge({replica,scope,localProjectId:'local-project',currentScope:()=>scope});
 return {before,replica,bridge,state:()=>copy(state),writes:()=>writes,close(){bridge.close();replica.close();}};
}
function options(before,after,id,operation='edit'){let seq=0;return {before,after,operation,operationId:id,actor,at:10,groupId:'group:'+id,idFactory:()=>id+':'+(++seq)};}
async function save(e,before,mutate,id='edit',operation='edit'){const after=copy(before);mutate(after);const plan=await e.bridge.prepare(options(before,after,id,operation));assert.equal(plan.ready,true,JSON.stringify(plan.issues));return {plan,receipt:await e.bridge.commit(plan),after};}
let checks=0;async function test(name,fn){const e=await env();try{await fn(e);checks++;console.log('PASS '+name);}finally{e.close();}}
(async()=>{
 await test('real bridge saves scale, rotation and unknown metadata in immutable outbox',async e=>{
   const {receipt}=await save(e,e.before,s=>{s.drawings[0].state.pageSettings['1'].scale=150;s.drawings[0].state.future={nested:1};});assert.equal(receipt.projection.drawings[0].state.pageSettings['1'].scale,150);assert.equal(e.state().outbox.length,1);assert.equal(e.state().outbox[0].drawingId,M.namespace);assert(receipt.projection.metadataRecords);
 });
 await test('record and metadata change commit together in one atomic group',async e=>{
   const {plan,receipt}=await save(e,e.before,s=>{s.project.name='Changed';s.drawings[0].state.shapes[0].member='girder';});assert.equal(plan.atomicGroupRequired,true);assert.equal(e.writes(),1);assert.equal(e.state().outbox[0].kind,'atomic-group');assert.equal(e.state().outbox[0].events.length,2);assert.equal(receipt.projection.project.name,'Changed');assert.equal(receipt.projection.drawings[0].state.shapes[0].member,'girder');
 });
 await test('drawing removal atomically tombstones known records and retains complete backup history',async e=>{
   const {plan,receipt}=await save(e,e.before,s=>{s.project.drawings=[];s.drawings=[];},'delete','delete');assert.equal(plan.changes.length,2);assert.equal(receipt.projection.drawings.length,0);const kept=receipt.projection.project.deltaMetadata.retainedDrawings[0];assert.equal(kept.state.collabDeletedRecords[0].memo,'note');assert.equal(e.state().outbox[0].events.length,2);assert.deepEqual(await M.seed(receipt.projection),M.expandRecords(receipt.projection.metadataRecords));
 });
 await test('a concurrent record edit keeps a removed drawing visible with actionable membership candidates',async e=>{
   const key=D.keyOf('drawing','record'),base=e.state().records[key],peer=C.setField(base,'member','peer', {expectedHeads:C.view(base).fields.member.headIds,actor:{deviceId:'ipad',deviceName:'iPad'},at:20,revisionId:'peer-revision'});
   await e.replica.changeBatch({changes:[{drawingId:'drawing',before:base,after:peer,eventId:'peer-event'}]});
   const {receipt}=await save(e,e.before,s=>{s.project.drawings=[];s.drawings=[];},'delete','delete');assert.equal(receipt.projection.drawings.length,1);const conflict=receipt.projection.metadataConflicts.find(c=>c.kind==='metadata-membership');assert(conflict.expectedToken);assert.equal(conflict.recordIds[0],'record');
   const current=await e.replica.snapshotWithStatus(),resolved=await M.resolveMembership({records:current.snapshot.records,recordId:conflict.recordId,keep:true,expectedToken:conflict.expectedToken,actor,at:30,operationId:'keep'});
   await e.replica.changeBatch({changes:resolved.changes,expectedSnapshotToken:current.snapshotToken});const shown=await e.bridge.project(receipt.projection);assert.equal(shown.drawings.length,1);assert.equal(shown.metadataConflicts.some(c=>c.kind==='metadata-membership'),false);
 });
 await test('new drawing and first record become one sendable group and project without legacy metadata',async e=>{
   const {receipt}=await save(e,e.before,s=>{const meta={id:'new-drawing',name:'New'};s.project.drawings.push(meta);s.drawings.push({meta:copy(meta),state:{shapes:[{id:'new-record',memo:'new',photos:[]}],pageSettings:{'1':{scale:75}}}});},'create','create');
   assert.equal(receipt.projection.drawings.length,2);assert.equal(receipt.projection.drawings[1].state.shapes[0].memo,'new');assert.equal(e.state().outbox[0].kind,'atomic-group');
 });
 await test('metadata WAL replay after a committed operation emits no duplicate event',async e=>{
   const {after}=await save(e,e.before,s=>s.drawings[0].state.pageSettings['1'].scale=125,'stable');const beforeWrites=e.writes(),plan=await e.bridge.prepare({...options(e.before,after,'stable'),replay:true});assert.equal(plan.ready,true,JSON.stringify(plan.issues));assert.equal(plan.changes.length,0);await e.bridge.commit(plan);assert.equal(e.writes(),beforeWrites);
 });
 await test('backup restore omission retains current drawings and record histories',async e=>{
   const {receipt}=await save(e,e.before,s=>{s.project.drawings=[];s.drawings=[];},'restore','restore');assert.equal(receipt.projection.drawings.length,1);assert.equal(receipt.projection.drawings[0].state.shapes[0].memo,'note');assert.equal(e.writes(),0);
 });
 await test('membership delete selection rejects unobserved record edits and then groups exact confirmed tombstones',async e=>{
   const {receipt}=await save(e,e.before,s=>{s.project.drawings=[];s.drawings=[];},'delete','delete');
   const fresh=C.upgrade({id:'new-peer',memo:'keep proof',photos:[]});await e.replica.changeBatch({changes:[{drawingId:'drawing',before:null,after:fresh,eventId:'new-peer-event'}]});const view=await e.bridge.project(receipt.projection),conflict=view.metadataConflicts.find(c=>c.kind==='metadata-membership'),current=await e.replica.snapshotWithStatus();
   await assert.rejects(()=>M.resolveMembership({records:current.snapshot.records,recordId:conflict.recordId,keep:false,expectedToken:conflict.expectedToken,expectedRecordTokens:{},actor,at:30,operationId:'remove'}),{code:'METADATA_STALE'});
   const chosen=await M.resolveMembership({records:current.snapshot.records,recordId:conflict.recordId,keep:false,expectedToken:conflict.expectedToken,expectedRecordTokens:conflict.recordTokens,actor,at:30,operationId:'remove'});await e.replica.changeGroup({changes:chosen.changes,groupId:'confirmed-remove',expectedSnapshotToken:current.snapshotToken});const hidden=await e.bridge.project(view);assert.equal(hidden.drawings.length,0);assert.equal(hidden.project.deltaMetadata.retainedDrawings[0].state.collabDeletedRecords.length,2);
 });
 console.log('PASS metadata bridge: '+checks+' integration checks');
})().catch(error=>{console.error(error);process.exitCode=1;});

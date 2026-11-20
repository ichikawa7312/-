'use strict';
const assert=require('node:assert/strict');
if(!globalThis.crypto)globalThis.crypto=require('node:crypto').webcrypto;
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js'),M=require('../sentlog/delta-sync-metadata.js');
const copy=x=>structuredClone(x),actor={deviceId:'device-a',deviceName:'PC'},actorB={deviceId:'device-b',deviceName:'iPad'};
const key=id=>D.keyOf(M.namespace,id);let checks=0;
function initial(){const meta={id:'drawing-1',name:'図面 1',futureMeta:{a:1}};return {version:1,kind:'sentlog-app-project',localProjectId:'project-1',project:{id:'project-1',name:'現場',groups:[{id:'g1',name:'組'}],drawings:[meta]},drawings:[{meta:copy(meta),state:{shapes:[],pageSettings:{'1':{scale:100,rotation:0},'2':{scale:200}},custom:{empty:{},'__proto__':null},currentPage:2,width:100,height:200}}]};}
function merge(a,b){const out=copy(a);for(const [k,r]of Object.entries(b)){if(!out[k])out[k]=copy(r);else{const merged=C.mergeRecords(out[k],r);assert.equal(merged.ok,true,merged.reason);out[k]=merged.record;}}return out;}
async function change(before,mutate,records,id='operation-a',extra={}){const after=copy(before);mutate(after);return M.edit({before,after,currentRecords:records,operationId:id,actor,at:100,...extra});}
async function test(name,run){await run();checks++;console.log('PASS '+name);}
(async()=>{
await test('deterministic baseline carries empty drawings, nested unknown fields and independent settings',async()=>{
 const input=initial(),a=await M.seed(input),b=await M.seed(copy(input));assert.deepEqual(a,b);assert.equal(Object.keys(a).length,2);
 const output=await M.project({records:a,template:input});assert.deepEqual(M.shared(output),M.shared(input));assert.equal(output.drawings[0].state.currentPage,2);assert.equal(output.project.collaborationVersion,1);
 assert.deepEqual(await M.seed(output),a);assert.equal(output.metadataConflicts.length,0);
});
await test('scale, rotation, other pages, project name and unknown object leaves commute',async()=>{
 const before=initial(),base=await M.seed(before);
 const a=await change(before,s=>{s.drawings[0].state.pageSettings['1'].scale=125;s.project.name='新名称';},base,'op-a');
 const b=await change(before,s=>{s.drawings[0].state.pageSettings['1'].rotation=90;s.drawings[0].state.pageSettings['2'].scale=250;s.drawings[0].state.newUnknown={first:1};},base,'op-b',{actor:actorB});
 const result=await M.project({records:merge(a.records,b.records),template:before});assert.deepEqual(result.drawings[0].state.pageSettings,{'1':{scale:125,rotation:90},'2':{scale:250}});assert.equal(result.project.name,'新名称');assert.equal(result.drawings[0].state.newUnknown.first,1);assert.equal(result.metadataConflicts.length,0);
});
await test('stale raw edit rebases on observed ancestors without overwriting a concurrent field edit',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=125,base,'op-a');
 const b=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=150,a.records,'op-b',{actor:actorB});
 const result=await M.project({records:b.records,template:before});assert.equal(result.drawings[0].state.pageSettings['1'].scale,100);assert.equal(result.metadataConflicts.length,1);
 assert.deepEqual(result.metadataConflicts[0].candidates.map(c=>c.value.value).sort((a,b)=>a-b),[125,150]);
});
await test('explicit selection preserves both conflicting revisions and rejects stale candidates',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=125,base,'op-a'),b=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=150,a.records,'op-b',{actor:actorB});
 const view=await M.project({records:b.records,template:before}),conflict=view.metadataConflicts[0];
 await assert.rejects(()=>M.resolve({records:b.records,recordId:conflict.recordId,path:conflict.path,expectedHeads:[],value:125,operationId:'resolution-a',actor,at:200}),{code:'METADATA_STALE'});
 const resolved=await M.resolve({records:b.records,recordId:conflict.recordId,path:conflict.path,expectedHeads:conflict.headIds,value:125,operationId:'resolution-a',actor,at:200});
 const all={...b.records,[key(conflict.recordId)]:resolved.record},result=await M.project({records:all,template:before});assert.equal(result.drawings[0].state.pageSettings['1'].scale,125);assert.equal(result.metadataConflicts.length,0);assert.equal(resolved.record.collab.fields[conflict.key].revisions.length,4);
});
await test('unrelated metadata edits remain writable while a scale conflict awaits selection',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=125,base,'op-a'),b=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=150,a.records,'op-b',{actor:actorB});
 const view=await M.project({records:b.records,template:before}),next=await change(view,s=>s.drawings[0].state.pageSettings['1'].rotation=180,b.records,'op-c');assert.equal(next.changes.length,1);
 await assert.rejects(()=>change(view,s=>s.drawings[0].state.pageSettings['1'].scale=175,b.records,'op-d'),{code:'METADATA_RESOLUTION_REQUIRED'});
});
await test('object removal cannot hide an unseen concurrent descendant',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>delete s.drawings[0].state.pageSettings['1'],base,'op-delete'),b=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=125,base,'op-edit',{actor:actorB});
 const result=await M.project({records:merge(a.records,b.records),template:before});assert.equal(result.drawings[0].state.pageSettings['1'].scale,125);assert(result.metadataConflicts.some(c=>c.kind==='metadata-structure'));
 const deleted=await M.project({records:a.records,template:before});assert.equal(deleted.drawings[0].state.pageSettings['1'],undefined);assert.equal(deleted.metadataConflicts.length,0);
});
await test('scalar replacement retains concurrent object descendant edits',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>s.drawings[0].state.pageSettings['1']='automatic',base,'op-replace'),b=await change(before,s=>s.drawings[0].state.pageSettings['1'].rotation=90,base,'op-edit',{actor:actorB});
 const result=await M.project({records:merge(a.records,b.records),template:before});assert.equal(result.drawings[0].state.pageSettings['1'].rotation,90);assert(result.metadataConflicts.some(c=>c.kind==='metadata-structure'));
});
await test('object restore after a scalar replacement uses hidden observed history',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>s.drawings[0].state.pageSettings['1']='automatic',base,'op-replace');
 const display=await M.project({records:a.records,template:before}),b=await change(display,s=>s.drawings[0].state.pageSettings['1']={scale:175,rotation:180},a.records,'op-object');
 const result=await M.project({records:b.records,template:display});assert.deepEqual(result.drawings[0].state.pageSettings['1'],{scale:175,rotation:180});assert.equal(result.metadataConflicts.length,0);
});
await test('WAL replay is idempotent after another device has edited the same field',async()=>{
 const before=initial(),base=await M.seed(before),modify=s=>s.drawings[0].state.pageSettings['1'].scale=125,a=await change(before,modify,base,'op-a'),b=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=150,a.records,'op-b',{actor:actorB});
 const replay=await change(before,modify,b.records,'op-a');assert.equal(replay.changes.length,0);assert.deepEqual(replay.records,b.records);
 await assert.rejects(()=>change(before,s=>s.drawings[0].state.pageSettings['1'].scale=130,b.records,'op-a'),{code:'METADATA_OPERATION_COLLISION'});
});
await test('parallel creation of the same new property keeps both choices with an absent common ancestor',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>s.drawings[0].state.newSetting=1,base,'op-a'),b=await change(before,s=>s.drawings[0].state.newSetting=2,base,'op-b',{actor:actorB});
 const result=await M.project({records:merge(a.records,b.records),template:before});assert.equal(result.drawings[0].state.newSetting,undefined);assert.equal(result.metadataConflicts.length,1);
});
await test('drawing deletion retains metadata history and concurrent live records keep it visible',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>{s.project.drawings=[];s.drawings=[];},base,'op-remove',{operation:'delete'});
 const hidden=await M.project({records:a.records,template:before});assert.equal(hidden.drawings.length,0);assert.equal(hidden.project.deltaMetadata.retainedDrawings.length,1);assert.deepEqual(await M.seed(hidden),a.records);
 const live={...a.records,[D.keyOf('drawing-1','new-record')]:C.upgrade({id:'new-record',memo:'peer input'})};const shown=await M.project({records:live,template:hidden});assert.equal(shown.drawings.length,1);assert.equal(shown.drawings[0].state.shapes[0].memo,'peer input');assert(shown.metadataConflicts.some(c=>c.kind==='metadata-membership'));
});
await test('drawing deletion based on raw old settings leaves unseen metadata alive as a conflict',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>s.drawings[0].state.pageSettings['1'].scale=125,base,'op-peer');
 const deleted=await change(before,s=>{s.project.drawings=[];s.drawings=[];},a.records,'op-delete',{operation:'delete'}),view=await M.project({records:deleted.records,template:before});assert.equal(view.drawings.length,1);assert.equal(view.drawings[0].state.pageSettings['1'].scale,125);assert(view.metadataConflicts.some(c=>c.kind==='metadata-membership'));
});
await test('drawing order and names sync while independent drawing additions survive',async()=>{
 const before=initial();before.project.drawings.push({id:'drawing-2',name:'二'});before.drawings.push({meta:copy(before.project.drawings[1]),state:{shapes:[]}});const base=await M.seed(before);
 const a=await change(before,s=>{s.project.drawings.reverse();s.drawings.reverse();},base,'op-order');
 const b=await change(before,s=>{const meta={id:'drawing-3',name:'三'};s.project.drawings.push(meta);s.drawings.push({meta:copy(meta),state:{shapes:[],scale:50}});},base,'op-add',{actor:actorB});
 const view=await M.project({records:merge(a.records,b.records),template:before});assert.deepEqual(view.project.drawings.map(d=>d.id),['drawing-2','drawing-1','drawing-3']);assert.equal(view.drawings[2].state.scale,50);
});
await test('old backup restore appends changes and retains omitted drawing and field histories',async()=>{
 const before=initial(),base=await M.seed(before),a=await change(before,s=>{s.project.name='new';s.drawings[0].state.newSetting='keep';},base,'op-a');
 const current=await M.project({records:a.records,template:before}),restored=copy(before);delete restored.drawings[0].state.pageSettings['2'];
 const b=await M.edit({before:current,after:restored,currentRecords:a.records,operationId:'op-restore',actor,at:200,operation:'restore'}),view=await M.project({records:b.records,template:current});assert.equal(view.project.name,'現場');assert.equal(view.drawings[0].state.newSetting,'keep');assert.equal(view.drawings[0].state.pageSettings['2'].scale,200);assert(Object.values(view.metadataRecords.project.collab.fields).some(e=>e.revisions.length===3));
});
await test('long Unicode paths use bounded stable field IDs and special property names do not mutate prototypes',async()=>{
 const before=initial();Object.defineProperty(before.drawings[0].state,'__proto__',{value:{safe:1},enumerable:true,writable:true});before.drawings[0].state['日本語😀'.repeat(100)]={nested:'yes'};
 const base=await M.seed(before),view=await M.project({records:base,template:before});assert.deepEqual(M.shared(view),M.shared(before));assert.equal(Object.getPrototypeOf(view.drawings[0].state),Object.prototype);assert.equal(view.drawings[0].state.__proto__.safe,1);assert(Object.keys(Object.values(base)[1].collab.fields).every(k=>k.length<=66));
 assert.equal(M.pathKey(['日本','😀']),'6:日本4:😀');
});
await test('reserved namespace, altered identity/path and invalid envelope fail explicitly',async()=>{
 const before=initial(),base=await M.seed(before),id=await M.drawingRecordId('drawing-1');
 const bad=copy(base[key(id)]);bad.collab.fields.metaIdentity.revisions[0].value.drawingId='another';await assert.rejects(()=>M.validateDocument(bad),{code:'METADATA_IDENTITY'});
 const pathBad=copy(base[key(id)]),field=await M.fieldKey(['state','pageSettings','1','scale']);pathBad.collab.fields[field].revisions[0].value.path=['state','wrong'];await assert.rejects(()=>M.validateDocument(pathBad),{code:'METADATA_PATH_COLLISION'});
 const malformed=copy(before);malformed.project.deltaMetadata={future:true};await assert.rejects(()=>M.seed(malformed),{code:'METADATA_ENVELOPE'});
 const reserved=copy(before);reserved.project.drawings[0].id=M.namespace;reserved.drawings[0].meta.id=M.namespace;await assert.rejects(()=>M.seed(reserved),{code:'METADATA_IDENTITY'});
});
console.log('PASS metadata: '+checks+' checks');
})().catch(error=>{console.error(error);process.exitCode=1;});

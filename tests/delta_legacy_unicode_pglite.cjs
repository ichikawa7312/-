'use strict';
// A collaboration/1 record serialized by the old UTF-16 array normalizer.
// Its parent/observation array order is part of each immutable revision payload.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const B=require('../sentlog/delta-sync-app-bridge.js');
const copy=x=>structuredClone(x),actor={deviceId:'old-device',deviceName:'旧端末'};
const revision=(id,parents,payload)=>({id,parents,...payload,actor:copy(actor),at:1});
const pua='rev:\ue000',supplementary='rev:𐀀';
const old={id:'legacy-unicode',setting:'agreed',memo:'',photos:[],collab:{version:1,comments:{},photos:{},projection:{memo:''},fields:{
 geometry:{revisions:[revision('geometry',[],{value:{}})]},
 setting:{revisions:[revision('base',[],{value:'initial'}),revision('joined',[supplementary,pua],{value:'agreed'}),revision(pua,['base'],{value:'left'}),revision(supplementary,['base'],{value:'right'})]}
},deletion:{revisions:[revision('alive',[],{deleted:false,observed:[]}),revision('deleted',['alive'],{deleted:true,observed:['alive','base','geometry','joined',supplementary,pua]})]}}};
const context={eventId:'old-replay',projectId:'project',deviceId:'device',drawingId:'drawing'};
const fieldReplay={schema:1,...context,kind:'patch',recordId:old.id,patch:{fields:{setting:{revisions:[copy(old.collab.fields.setting.revisions[1])]}},comments:{},photos:{},deletion:[]}};
const deletionReplay={...copy(fieldReplay),eventId:'old-delete-replay',patch:{fields:{},comments:{},photos:{},deletion:[copy(old.collab.deletion.revisions[1])]}};
const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,'');
let checks=0;const pass=name=>{checks++;console.log('PASS '+name);};
(async()=>{
 const normalized=C.upgrade(old);
 assert.deepEqual(normalized.collab.fields.setting.revisions.find(r=>r.id==='joined'),old.collab.fields.setting.revisions[1]);
 assert.deepEqual(normalized.collab.deletion.revisions.find(r=>r.id==='deleted'),old.collab.deletion.revisions[1]);pass('upgrading legacy Unicode history preserves immutable parent and observed bytes');
 assert.deepEqual(D.combine(normalized,fieldReplay),normalized);assert.deepEqual(D.combine(normalized,deletionReplay),normalized);pass('previously accepted old Unicode events replay idempotently on the upgraded client');
 const restored=C.restore(normalized,{expectedToken:C.revisionToken(normalized),revisionId:'restored',actor,at:2});
 assert.deepEqual(restored.collab.deletion.revisions.find(r=>r.id==='restored').observed,[...restored.collab.deletion.revisions.find(r=>r.id==='restored').observed].sort());
 const left=C.setField(restored,'setting','left-new',{expectedHeads:C.view(restored).fields.setting.headIds,revisionId:'next:'+pua,actor,at:3}),right=C.setField(restored,'setting','right-new',{expectedHeads:C.view(restored).fields.setting.headIds,revisionId:'next:'+supplementary,actor,at:3});
 const merged=C.mergeRecords(left,right);assert(merged.ok);const resolved=C.resolveField(merged.record,'setting','resolved',{expectedHeads:C.view(merged.record).fields.setting.headIds,revisionId:'resolved',actor,at:4});
 assert.deepEqual(resolved.collab.fields.setting.revisions.find(r=>r.id==='resolved').parents,['next:'+supplementary,'next:'+pua]);pass('new generic revisions retain old-client UTF-16 parent encoding while head order is locale-independent');
 const tampered=copy(fieldReplay);tampered.patch.fields.setting.revisions[0].parents.reverse();assert.throws(()=>D.combine(normalized,tampered),{code:'DELTA_COLLISION'});pass('reordering an existing revision payload is still an immutable-history collision');
 const displayBase=C.upgrade({id:'record',member:'pier',memo:'',photos:[]});
 const first=C.appendComment(displayBase,'private-use note',{commentId:pua,revisionId:'comment:'+pua,actor,at:1});
 const second=C.appendComment(displayBase,'supplementary note',{commentId:supplementary,revisionId:'comment:'+supplementary,actor,at:1});
 let display=C.mergeRecords(first,second).record;
 for(const id of [pua,supplementary])display=C.addPhoto(display,{id,name:id},{revisionId:'photo:'+id,actor,at:1});
 display.photos.sort((a,b)=>a.id.localeCompare(b.id));display.memo=C.view(display).comments.sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)).map(r=>r.text).join('\n\n');display.collab.projection.memo=display.memo;
 assert.equal(C.matchesProjection(display),false);assert.equal(C.matchesProjection(display,{allowLegacyOrder:true}),true);
 const fakeMemo=copy(display);fakeMemo.memo+=' unrecorded';fakeMemo.collab.projection.memo=fakeMemo.memo;assert.equal(C.matchesProjection(fakeMemo,{allowLegacyOrder:true}),false);
 const fakeField=copy(display);fakeField.member='unrecorded';assert.equal(C.matchesProjection(fakeField,{allowLegacyOrder:true}),false);pass('legacy display ordering is accepted only when recomputable from unchanged immutable history');
 const meta={id:'drawing',name:'drawing'},before={version:1,kind:'sentlog-app-project',localProjectId:'local',project:{id:'local',name:'project',drawings:[meta]},drawings:[{meta:copy(meta),state:{shapes:[display]}}]},after=copy(before);after.drawings[0].state.shapes[0].member='edited';let seq=0;
 const plan=B.prepare({scope:{ownerId:'owner',projectId:'project',deviceId:'old-device'},localProjectId:'local',before,after,actor,at:2,operation:'edit',idFactory:()=>String(++seq)});assert.equal(plan.ready,true,JSON.stringify(plan.issues));assert.equal(plan.changes.length,1);assert.equal(Object.keys(plan.changes[0].after.collab.comments).length,2);assert.equal(plan.changes[0].after.member,'edited');pass('editing a legacy display normalizes its order without duplicating comments or losing the new field edit');
 const db=new PGlite();try{
  for(const file of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql','docs/sentlog-delta-semantic-validation-prototype.sql','docs/sentlog-delta-projection-prototype.sql'])await db.exec(read(file));
  for(const record of [old,restored,resolved]){const sql=(await db.query('SELECT sentlog_delta_private.project_record($1,$2::jsonb) AS result',[record.id,JSON.stringify(record.collab)])).rows[0].result;const view=C.view(record);assert.deepEqual(sql,{record:C.upgrade(record),deleted:view.deleted,pendingDelete:view.pendingDelete});}pass('SQL and JavaScript project old and subsequently edited Unicode histories identically');
  for(const event of [fieldReplay,deletionReplay]){const merged=(await db.query('SELECT sentlog_delta_private.merge_record_history($1::jsonb,$2::jsonb) AS result',[JSON.stringify(old.collab),JSON.stringify(event)])).rows[0].result;assert.deepEqual(merged,old.collab);}pass('SQL accepts duplicate original payloads without normalizing immutable arrays');
  const next=D.diffRecord(old,resolved,{...context,eventId:'new-edits'}),server=(await db.query('SELECT sentlog_delta_private.merge_record_history($1::jsonb,$2::jsonb) AS result',[JSON.stringify(old.collab),JSON.stringify(next)])).rows[0].result;assert.deepEqual(C.upgrade({id:old.id,collab:server}),resolved);pass('new client changes append to old server history without rewriting any original revision');
  await assert.rejects(db.query('SELECT sentlog_delta_private.merge_record_history($1::jsonb,$2::jsonb)',[JSON.stringify(old.collab),JSON.stringify(tampered)]),e=>e.code==='22023'&&e.message.includes('REVISION_REWRITE'));pass('SQL independently rejects changed parent-array bytes on a previously accepted revision');
 }finally{await db.close();}
 console.log('PASS legacy Unicode compatibility: '+checks+' checks');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const assert=require('node:assert/strict'),C=require('../sentlog/record-collaboration.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const record=()=>({id:'record-1',page:1,kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',member:'横桁',
  point:{x:10,y:20},points:[{x:10,y:20},{x:10,y:20}],memo:'以前の調査記録',photos:[{id:'existing-photo',name:'元写真.jpg',size:100}],crackWidthMm:0.2});
function options(device='A',extra={}){let n=0;return {actor:{deviceId:'device-'+device,deviceName:'端末'+device},at:device==='A'?20:10,idFactory:()=>device+'-'+(++n),...extra};}
const fieldHeads=(r,k)=>C.view(r).fields[k].headIds;
const commentHeads=(r,id)=>C.view(r).comments.find(c=>c.id===id).headIds;
const merge=(a,b,base)=>{const result=C.mergeRecords(a,b,{base});assert(result.ok,result.reason);return result.record;};
let passed=0;
function test(name,fn){try{fn();}catch(e){e.message=name+': '+e.message;throw e;}passed++;console.log('PASS '+name);}

test('legacy upgrade is deterministic, preserves values, and never invents an author',()=>{
  const raw=record(),saved=JSON.stringify(raw),a=C.upgrade(raw),b=C.upgrade(copy(raw));
  assert.deepEqual(a,b);assert.equal(JSON.stringify(raw),saved);assert.equal(a.memo,raw.memo);assert.deepEqual(a.point,raw.point);assert.deepEqual(a.photos,raw.photos);
  const v=C.view(a);assert.equal(v.comments.length,1);assert.deepEqual(v.comments[0].heads[0].actor,{deviceId:null,deviceName:'不明'});
  assert.equal(v.fields.crackWidthMm.value,0.2);assert.equal(v.fields.geometry.value.point.x,10);
  assert.deepEqual(C.upgrade(a),a,'reopening a migrated record creates no new history');
});

test('independent comments and both phones photos survive merge in either direction',()=>{
  const base=C.upgrade(record()),oa=options('A'),ob=options('B');
  let a=C.appendComment(base,'Aの近接調査',oa),b=C.appendComment(base,'Bの打音結果',ob);
  a=C.addPhoto(a,{id:'photo-a',name:'A.jpg',size:200},{...oa,revisionId:'capture-a'});
  b=C.addPhoto(b,{id:'photo-b',name:'B.jpg',size:300},{...ob,revisionId:'capture-b'});
  const saved=JSON.stringify([base,a,b]),ab=merge(a,b,base),ba=merge(b,a,base);
  assert(C.equal(ab,ba));assert(ab.memo.includes('Aの近接調査'));assert(ab.memo.includes('Bの打音結果'));assert(ab.memo.includes('以前の調査記録'));
  assert.deepEqual(new Set(ab.photos.map(p=>p.id)),new Set(['existing-photo','photo-a','photo-b']));assert.equal(C.view(ab).conflicts.length,0);
  assert.equal(JSON.stringify([base,a,b]),saved,'pure merge cannot mutate its inputs');
  assert(C.equal(merge(ab,a,base),ab),'repeated delivery does not duplicate comments/photos');
});

test('two distinct comments with identical text remain two entries',()=>{
  const base=C.upgrade(record());
  const a=C.appendComment(base,'異常なし',options('A')),b=C.appendComment(base,'異常なし',options('B'));
  const both=merge(a,b,base),rows=C.view(both).comments.filter(c=>c.text==='異常なし');
  assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
});

test('comment append order follows observed entries even when a device clock moves backwards',()=>{
  const base=C.upgrade(record()),a=C.appendComment(base,'先に追加',{...options('A'),at:900000});
  const later=C.appendComment(a,'後から追加',{...options('B'),at:1});
  assert.deepEqual(C.view(later).comments.map(r=>r.text),['以前の調査記録','先に追加','後から追加']);
  const bad=copy(later),id=C.view(later).comments[1].id;bad.collab.comments[id].order=99;
  assert.equal(C.mergeRecords(later,bad,{base}).code,'COLLAB_REVISION_COLLISION');
});

test('comment edits keep history and concurrent versions remain shareable alternatives',()=>{
  const base=C.upgrade(record()),id=C.view(base).comments[0].id,h=commentHeads(base,id);
  const a=C.editComment(base,id,'Aが修正',{...options('A'),expectedHeads:h}),b=C.editComment(base,id,'Bが修正',{...options('B'),expectedHeads:h});
  const both=merge(a,b,base),row=C.view(both).comments.find(c=>c.id===id);
  assert.equal(row.conflict,true);assert.equal(row.heads.length,2);assert(both.memo.includes('Aが修正')&&both.memo.includes('Bが修正'));
  assert.equal(both.collab.comments[id].revisions.length,3);assert(both.collab.comments[id].revisions.some(r=>r.text==='以前の調査記録'));
  assert.throws(()=>C.editComment(both,id,'見落とし',{...options('C'),expectedHeads:h}),e=>e.code==='COLLAB_STALE');
  assert.throws(()=>C.editComment(both,id,'暗黙に選択',{...options('C'),expectedHeads:row.headIds}),e=>e.code==='COLLAB_CONFLICT');
  const resolved=C.resolveComment(both,id,'確認して統合',{...options('C'),expectedHeads:row.headIds});
  assert.equal(C.view(resolved).comments.find(c=>c.id===id).conflict,false);assert.equal(resolved.memo,'確認して統合');assert.equal(resolved.collab.comments[id].revisions.length,4);
  assert.equal(merge(resolved,a,base).memo,'確認して統合','old deliveries cannot resurrect a resolved branch');
});

test('scalar conflicts retain candidates and project their common ancestor rather than a timestamp winner',()=>{
  const base=C.upgrade(record()),h=fieldHeads(base,'crackWidthMm');
  const a=C.setField(base,'crackWidthMm',0.35,{...options('A'),at:999999,expectedHeads:h});
  const b=C.setField(base,'crackWidthMm',0.55,{...options('B'),at:1,expectedHeads:h});
  const both=merge(a,b,base),f=C.view(both).fields.crackWidthMm;
  assert.equal(both.crackWidthMm,0.2);assert.equal(f.conflict,true);assert.deepEqual(new Set(f.heads.map(r=>r.value)),new Set([0.35,0.55]));
  assert.throws(()=>C.setField(both,'crackWidthMm',0.4,{...options('C'),expectedHeads:h}),e=>e.code==='COLLAB_STALE');
  assert.throws(()=>C.setField(both,'crackWidthMm',0.4,{...options('C'),expectedHeads:f.headIds}),e=>e.code==='COLLAB_CONFLICT');
  const result=C.resolveField(both,'crackWidthMm',0.4,{...options('C'),expectedHeads:f.headIds});
  assert.equal(result.crackWidthMm,0.4);assert.equal(C.view(result).fields.crackWidthMm.conflict,false);assert.equal(result.collab.fields.crackWidthMm.revisions.length,4);
});

test('independent fields combine and geometry stays one protected value',()=>{
  const base=C.upgrade(record());
  const a=C.setField(base,'member','主桁',{...options('A'),expectedHeads:fieldHeads(base,'member')});
  const b=C.setField(base,'type','腐食',{...options('B'),expectedHeads:fieldHeads(base,'type')});
  const joined=merge(a,b,base);assert.equal(joined.member,'主桁');assert.equal(joined.type,'腐食');assert.equal(C.view(joined).conflicts.length,0);
  const ga=copy(C.view(base).fields.geometry.value),gb=copy(ga);ga.point.x=50;ga.points[0].x=50;gb.point.y=80;gb.points[0].y=80;
  const left=C.setField(base,'geometry',ga,{...options('G1'),expectedHeads:fieldHeads(base,'geometry')});
  const right=C.setField(base,'geometry',gb,{...options('G2'),expectedHeads:fieldHeads(base,'geometry')});
  const conflicting=merge(left,right,base);assert.equal(C.view(conflicting).fields.geometry.conflict,true);
  assert.deepEqual(conflicting.point,{x:10,y:20});assert.deepEqual(conflicting.points,base.points,'never invent a geometry using one device x and the other y');
});

test('the most recent common ancestor is retained after earlier agreed edits',()=>{
  const base=C.upgrade(record()),first=C.setField(base,'crackWidthMm',0.25,{...options('First'),expectedHeads:fieldHeads(base,'crackWidthMm')});
  const a=C.setField(first,'crackWidthMm',0.3,{...options('A'),expectedHeads:fieldHeads(first,'crackWidthMm')});
  const b=C.setField(first,'crackWidthMm',0.4,{...options('B'),expectedHeads:fieldHeads(first,'crackWidthMm')});
  assert.equal(merge(a,b,base).crackWidthMm,0.25);
});

test('a stale generic editor adds a candidate without pretending to have observed a newer change',()=>{
  const base=C.upgrade(record()),latest=C.setField(base,'crackWidthMm',0.4,{...options('B'),expectedHeads:fieldHeads(base,'crackWidthMm')});
  const draft=copy(base);draft.crackWidthMm=0.3;
  const result=C.applyLocalEdit(latest,draft,options('A'));
  assert.equal(C.view(result).fields.crackWidthMm.conflict,true);assert.equal(result.crackWidthMm,0.2);
  assert.deepEqual(new Set(C.view(result).fields.crackWidthMm.heads.map(r=>r.value)),new Set([0.3,0.4]));
  const appended=C.appendComment(base,'明示APIの追記',options('Explicit'));
  const persisted=C.applyLocalEdit(base,appended,options('Persist'));
  assert.equal(C.view(persisted).comments.length,2,'persist must not append the entire memo projection a second time');
});

test('legacy textarea writes append unknown/new entries and implicit removals cannot erase prior content',()=>{
  const base=C.upgrade(record()),draft=copy(base);draft.memo='追加で記入';draft.photos=[];
  const result=C.applyLocalEdit(base,draft,options('A'));
  assert(result.memo.includes('以前の調査記録'));assert(result.memo.includes('追加で記入'));assert.equal(result.photos.length,1);
  const clear=copy(result);clear.memo='';const retained=C.applyLocalEdit(result,clear,options('Clear'));
  assert.equal(retained.memo,result.memo);
  const missing=merge(null,result,base);assert.equal(missing.memo,result.memo);assert.equal(missing.photos.length,1,'a missing snapshot record is not a delete command');
});

test('legacy upgrades from a common ancestor preserve both concurrent intent and unknown authors',()=>{
  const base=record(),a=copy(base),b=copy(base);a.memo='A旧版の追記';a.crackWidthMm=0.3;b.memo='B旧版の追記';b.crackWidthMm=0.4;
  const one=merge(a,b,base),two=merge(b,a,base);assert(C.equal(one,two));
  assert(one.memo.includes(base.memo)&&one.memo.includes(a.memo)&&one.memo.includes(b.memo));assert.equal(one.crackWidthMm,0.2);
  assert(C.view(one).comments.every(c=>c.heads.every(h=>h.actor.deviceId===null)));assert(C.equal(merge(one,a,base),one));
});

test('old-client raw edits beside an existing projection import once with stable unknown-author revisions',()=>{
  const base=C.upgrade(record()),raw=copy(base);raw.memo='旧版で入力した文章';raw.crackWidthMm=0.6;raw.photos.push({id:'old-client-photo',name:'旧版撮影.jpg'});
  const normalize=r=>C.applyLocalEdit(C.upgrade(r),r,{deterministic:true,recordId:r.id,actor:{deviceId:null,deviceName:'不明'},at:0});
  const once=normalize(raw);assert.deepEqual(normalize(raw),once);assert.deepEqual(normalize(once),once);
  assert(once.memo.includes(base.memo)&&once.memo.includes(raw.memo));assert.equal(once.crackWidthMm,0.6);assert.equal(once.photos.length,2);
  assert.equal(C.view(once).comments.at(-1).heads[0].actor.deviceId,null);
  const preview=copy(raw);preview.points[0].x=90;const later=C.applyLocalEdit(once,preview,options('Preview'));
  assert.equal(C.view(later).comments.filter(c=>c.text===raw.memo).length,1,'persisting a pre-normalization preview cannot import the same legacy comment twice');
  const originalId=C.view(base).comments[0].id,edited=C.editComment(base,originalId,'修正した文章',{...options('Edit'),expectedHeads:commentHeads(base,originalId)}),newIntent=copy(edited);newIntent.memo=base.memo;
  assert(C.applyLocalEdit(edited,newIntent,options('NewIntent')).memo.includes(base.memo),'a new raw edit can intentionally append wording that already occurs in known history');
});

test('stable operation IDs make repeated comment and photo saves idempotent',()=>{
  const base=C.upgrade(record()),o=options('A',{commentId:'stable-comment',revisionId:'stable-comment-revision',at:42});
  const once=C.appendComment(base,'再試行でも一件',o),again=C.appendComment(once,'再試行でも一件',o);assert.deepEqual(again,once);
  const photo={id:'stable-photo',name:'保存.jpg',size:99,localBlob:'cache',data:'data:cache'};
  const po=options('A',{revisionId:'capture:stable-photo',at:43});
  const p=C.addPhoto(again,photo,po);assert.deepEqual(C.addPhoto(p,photo,po),p);assert(!('localBlob' in p.photos.find(x=>x.id===photo.id)));
  assert.throws(()=>C.appendComment(once,'違う本文',o),e=>e.code==='COLLAB_REVISION_COLLISION');
});

test('same photo ID with divergent metadata is retained for review rather than silently overwritten',()=>{
  const base=C.upgrade(record());
  const a=C.addPhoto(base,{id:'collision',name:'A.jpg',size:10},options('A'));
  const b=C.addPhoto(base,{id:'collision',name:'B.jpg',size:20},options('B'));
  const result=merge(a,b,base),row=C.view(result).photos.find(x=>x.id==='collision');
  assert.equal(row.conflict,true);assert.equal(row.heads.length,2);assert.equal(row.metadata,null);assert.equal(result.photos.find(x=>x.id==='collision').collabConflict,true);
});

test('explicit comment/photo removals retain history and do not delete concurrent additions',()=>{
  const base=C.upgrade(record()),id=C.view(base).comments[0].id;
  const removed=C.removeComment(base,id,{...options('A'),expectedHeads:commentHeads(base,id)});
  const edited=C.editComment(base,id,'削除と同時に修正',{...options('B'),expectedHeads:commentHeads(base,id)});
  const both=merge(removed,edited,base);assert.equal(C.view(both).comments.find(x=>x.id===id).conflict,true);assert(both.memo.includes('削除と同時に修正'));
  const oldPhoto=C.view(base).photos[0],without=C.removePhoto(base,oldPhoto.id,{...options('Del'),expectedHeads:oldPhoto.headIds});
  const added=C.addPhoto(base,{id:'new-photo',name:'新しい写真.jpg'},options('Add'));
  const joined=merge(without,added,base);assert.deepEqual(joined.photos.map(p=>p.id),['new-photo']);
  assert.equal(joined.collab.photos[oldPhoto.id].revisions.length,2);assert(C.view(joined).photos.find(p=>p.id===oldPhoto.id).deleted);
});

test('explicit comment and photo deletion operations replay idempotently',()=>{
  const base=C.upgrade(record()),id=C.view(base).comments[0].id;
  const o={...options('CommentDelete'),expectedHeads:commentHeads(base,id),revisionId:'remove-comment'};
  const removed=C.removeComment(base,id,o);assert.deepEqual(C.removeComment(removed,id,o),removed);
  const p=C.view(base).photos[0],po={...options('PhotoDelete'),expectedHeads:p.headIds,revisionId:'remove-photo'};
  const without=C.removePhoto(base,p.id,po);assert.deepEqual(C.removePhoto(without,p.id,po),without);
  assert.throws(()=>C.addPhoto(without,p.metadata,options('CaptureRetry')),e=>e.code==='COLLAB_PHOTO_DELETED');
  const ro={...options('RestorePhoto'),expectedHeads:C.view(without).photos[0].headIds,revisionId:'restore-photo'};
  const restored=C.restorePhoto(without,p.id,ro);assert.deepEqual(restored.photos,base.photos);assert.deepEqual(C.restorePhoto(restored,p.id,ro),restored);
  assert.throws(()=>C.restorePhoto(restored,p.id,{...ro,revisionId:'stale-restore'}),e=>e.code==='COLLAB_STALE');
});

test('record deletion requires its exact observed revision and concurrent additions keep it visible',()=>{
  const base=C.upgrade(record()),o=options('Delete',{expectedToken:C.revisionToken(base),revisionId:'delete-op'}),deleted=C.markDeleted(base,o);
  assert(C.isDeleted(deleted));assert.equal(deleted.photos.length,base.photos.length,'a tombstone still contains every photo reference');
  assert.throws(()=>C.addPhoto(deleted,{id:'late',name:'late.jpg'},options('A')),e=>e.code==='COLLAB_RECORD_DELETED');
  const comment=C.appendComment(base,'削除と同時の新しい記録',options('A'));
  const photo=C.addPhoto(base,{id:'concurrent-photo',name:'撮影.jpg'},options('B'));
  for(const changed of [comment,photo])for(const [l,r] of [[deleted,changed],[changed,deleted]]){
    const both=merge(l,r,base);assert.equal(C.isDeleted(both),false);assert.equal(C.view(both).pendingDelete,true);
    assert.deepEqual(C.markDeleted(both,o),both,'replaying an earlier deletion never confirms newly arrived work');
    assert.throws(()=>C.markDeleted(both,{...o,revisionId:'new-delete-with-stale-token'}),e=>e.code==='COLLAB_STALE');
    const confirmed=C.markDeleted(both,{...options('Confirm'),expectedToken:C.revisionToken(both)});assert(C.isDeleted(confirmed));
    const restored=C.restore(confirmed,{...options('Restore'),expectedToken:C.revisionToken(confirmed)});assert.equal(C.isDeleted(restored),false);
    assert.equal(restored.memo,both.memo);assert.deepEqual(restored.photos,both.photos);
  }
});

test('malformed graphs and rewritten revision payloads fail closed without touching either input',()=>{
  const base=C.upgrade(record()),bad=copy(base),key=Object.keys(bad.collab.fields)[0];bad.collab.fields[key].revisions[0].at=900;
  const before=JSON.stringify([base,bad]),r=C.mergeRecords(base,bad,{base});assert.equal(r.ok,false);assert.equal(r.code,'COLLAB_REVISION_COLLISION');assert.equal(JSON.stringify([base,bad]),before);
  const cycle=copy(base),rev=cycle.collab.fields.geometry.revisions[0];rev.parents=[rev.id];assert.equal(C.mergeRecords(cycle,base).ok,false);
  const future=copy(base);future.collab.version=99;assert.equal(C.mergeRecords(future,base).code,'COLLAB_VERSION');
  const geometry=copy(base);geometry.collab.fields.geometry.revisions[0].value={id:'wrong'};assert.equal(C.mergeRecords(geometry,base).code,'COLLAB_INVALID');
});

console.log(passed+' collaborative record scenarios passed');

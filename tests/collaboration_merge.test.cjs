'use strict';
const assert=require('node:assert/strict'),C=require('../sentlog/record-collaboration.js'),M=require('../sentlog/sync-merge.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const record=()=>({id:'shared-record',type:'ひび割れ',kind:'polyline',page:1,points:[{x:1,y:2},{x:5,y:6}],memo:'従来コメント',photos:[],crackWidthMm:0.2});
const make=(shapes,deleted=[],version=1)=>{const meta={id:'drawing',name:'正面図',sourceType:null,fileName:'',updatedAt:1};return {project:{id:'project',name:'共同調査',updatedAt:1,drawings:[meta],...(version?{collaborationVersion:version}:{})},drawings:[{meta:copy(meta),state:{sourceType:null,fileName:'',pageCount:1,shapes:copy(shapes),...(deleted.length?{collabDeletedRecords:copy(deleted)}:{}),pageSettings:{},pageRotations:{},currentPage:1,width:100}}]};};
const opts=device=>{let n=0;return {actor:{deviceId:device,deviceName:device},at:device==='A'?9000:1,idFactory:()=>device+'-'+(++n)};};
const merged=(a,b,base,options={})=>{const r=M.merge(a,b,{base,now:100,...options});assert(r.ok,JSON.stringify(r.conflicts));assert.deepEqual(r.conflicts,[]);return r.payload;};
let passed=0;function test(name,fn){fn();passed++;console.log('PASS '+name);}

test('concurrent comments and both phones photos are shared in both snapshot orders',()=>{
  const r=C.upgrade(record()),base=make([r]),oa=opts('A'),ob=opts('B');
  const a=make([C.addPhoto(C.appendComment(r,'Aの追記',oa),{id:'a-photo',name:'A.jpg'},oa)]);
  const b=make([C.addPhoto(C.appendComment(r,'Bの追記',ob),{id:'b-photo',name:'B.jpg'},ob)]);
  const before=JSON.stringify([base,a,b]);
  for(const [l,z] of [[a,b],[b,a]]){
    const out=merged(l,z,base).drawings[0].state.shapes[0];assert.equal(C.view(out).comments.length,3);
    assert(out.memo.includes('Aの追記')&&out.memo.includes('Bの追記'));assert.deepEqual(out.photos.map(p=>p.id),['a-photo','b-photo']);
  }
  assert.equal(JSON.stringify([base,a,b]),before);
});

test('same-field and same-comment candidates remain shareable without halting the project',()=>{
  const r=C.upgrade(record()),base=make([r]),id=C.view(r).comments[0].id;
  function edit(device,width,text){const o=opts(device);return C.editComment(C.setField(r,'crackWidthMm',width,{...o,expectedHeads:C.view(r).fields.crackWidthMm.headIds}),id,text,{...o,expectedHeads:C.view(r).comments[0].headIds});}
  const a=make([edit('A',0.3,'Aの修正')]),b=make([edit('B',0.4,'Bの修正')]),out=merged(a,b,base);
  const s=out.drawings[0].state.shapes[0];assert.equal(s.crackWidthMm,0.2);assert.equal(C.view(s).conflicts.length,2);assert(s.memo.includes('Aの修正')&&s.memo.includes('Bの修正'));
  const again=merged(out,a,base);assert(C.equal(again.drawings[0].state.shapes[0].collab,s.collab));
});

test('confirmed deletion is a retained tombstone; concurrent new work reappears for confirmation',()=>{
  const r=C.upgrade(record()),base=make([r]),deleted=C.markDeleted(r,{...opts('Delete'),expectedToken:C.revisionToken(r)}),tombstone=make([],[deleted]);
  const confirmed=merged(tombstone,base,base).drawings[0].state;assert.equal(confirmed.shapes.length,0);assert.equal(confirmed.collabDeletedRecords.length,1);
  assert.equal(confirmed.collabDeletedRecords[0].memo,r.memo);
  const newPhoto=C.addPhoto(r,{id:'during-delete',name:'同時撮影.jpg'},opts('Photo'));
  for(const [a,b] of [[tombstone,make([newPhoto])],[make([newPhoto]),tombstone]]){
    const out=merged(a,b,base).drawings[0].state;assert.equal(out.shapes.length,1);assert.equal(out.collabDeletedRecords.length,0);
    assert(C.view(out.shapes[0]).pendingDelete);assert.equal(out.shapes[0].photos[0].id,'during-delete');
  }
});

test('snapshot absence never deletes a collaborative record, history, or whole drawing',()=>{
  const r=C.upgrade(record()),base=make([r]),missing=make([]),one=merged(missing,base,base);
  assert.equal(one.drawings[0].state.shapes[0].id,r.id);
  assert.equal(merged(missing,missing,base).drawings[0].state.shapes[0].id,r.id);
  const missingDrawing=make([]);missingDrawing.project.drawings=[];missingDrawing.drawings=[];
  assert.equal(merged(missingDrawing,base,base).drawings[0].state.shapes[0].id,r.id);
  assert.equal(merged(missingDrawing,missingDrawing,base).drawings[0].state.shapes[0].id,r.id);
});

test('common-base migration preserves legacy concurrent edits while opt-out keeps old behavior',()=>{
  const r=record(),base=make([r],[],0),a=make([{...r,memo:'Aが記入',crackWidthMm:0.3}],[],0),b=make([{...r,memo:'Bが記入',crackWidthMm:0.4}],[],0);
  assert.equal(M.merge(a,b,{base}).ok,false);
  const s=merged(a,b,base,{collaborative:true}).drawings[0].state.shapes[0];assert(s.memo.includes(r.memo)&&s.memo.includes('Aが記入')&&s.memo.includes('Bが記入'));
  assert.equal(s.crackWidthMm,0.2);assert(C.view(s).fields.crackWidthMm.conflict);
});

test('existing revision graphs merge without baseline; malformed rewrites remain blocked',()=>{
  const r=C.upgrade(record()),a=make([C.appendComment(r,'A',opts('A'))]),b=make([C.appendComment(r,'B',opts('B'))]);
  assert.equal(C.view(merged(a,b).drawings[0].state.shapes[0]).comments.length,3);
  const bad=copy(b),revision=bad.drawings[0].state.shapes[0].collab.fields.geometry.revisions[0];revision.at=999;
  assert.equal(M.merge(a,bad,{base:make([r])}).ok,false);
  const duplicate=make([r],[r]);assert.equal(M.merge(duplicate,a,{base:make([r])}).ok,false);
});

test('coordinate-frame and source-file guards remain active for collaborative projects',()=>{
  const base=make([C.upgrade(record())]),rotated=copy(base);rotated.drawings[0].state.pageRotations={'1':90};
  assert.equal(M.merge(rotated,base,{base}).ok,false);
  const scale=copy(base);scale.drawings[0].state.pageSettings={'1':{scaleDenom:100}};assert.equal(M.merge(scale,base,{base}).ok,false);
});

test('two offline 調査-1 records preserve both contents and receive stable numbers',()=>{
  const base=make([]),start=Date.parse('2026-11-19T10:00:00+09:00');
  const a=C.upgrade({id:'survey-phone-A',kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',
    recordNo:1,typeNo:1,autoLabel:'調査-1',createdAt:start,point:{x:2,y:3},memo:'Aの調査内容',photos:[{id:'a-photo',name:'A.jpg'}]});
  const b=C.upgrade({id:'survey-phone-B',kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',
    recordNo:1,typeNo:1,autoLabel:'調査-1',createdAt:start+300000,point:{x:22,y:33},memo:'Bの調査内容',photos:[{id:'b-photo',name:'B.jpg'}]});
  const before=JSON.stringify([a,b]);
  for(const [local,remote] of [[make([a]),make([b])],[make([b]),make([a])]]){
    const out=merged(local,remote,base).drawings[0].state.shapes;
    assert.deepEqual(out.map(s=>s.id),['survey-phone-A','survey-phone-B']);
    assert.deepEqual(out.map(s=>s.autoLabel),['調査-1','調査-2']);
    assert.deepEqual(out.map(s=>s.typeNo),[1,2]);
    assert.deepEqual(out.map(s=>s.recordNo),[1,2]);
    assert.deepEqual(out.map(s=>s.memo),['Aの調査内容','Bの調査内容']);
    assert.deepEqual(out.map(s=>s.photos[0].id),['a-photo','b-photo']);
    assert.deepEqual(out.map(s=>s.point),[{x:2,y:3},{x:22,y:33}]);
  }
  assert.equal(JSON.stringify([a,b]),before,'neither offline source may be mutated');
});
test('offline field numbering anchors existing records and identical times use stable IDs',()=>{
  const known=C.upgrade({id:'known',kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',
    recordNo:1,typeNo:1,createdAt:1,memo:'既存の調査',photos:[]});
  const base=make([known]);
  const a=C.upgrade({id:'a',kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',
    recordNo:2,typeNo:2,createdAt:1000,memo:'新規A',photos:[]});
  const b=C.upgrade({id:'b',kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',
    recordNo:2,typeNo:2,createdAt:1000,memo:'新規B',photos:[]});
  for(const [l,r] of [[make([known,a]),make([known,b])],[make([known,b]),make([known,a])]]){
    const first=merged(l,r,base),shapes=first.drawings[0].state.shapes;
    assert.deepEqual(shapes.map(s=>s.id),['known','a','b']);
    assert.deepEqual(shapes.map(s=>s.autoLabel),['調査-1','調査-2','調査-3']);
    assert.deepEqual(shapes.map(s=>s.recordNo),[1,2,3]);
    const second=merged(first,r,base);
    assert.deepEqual(second.drawings[0].state.shapes.map(s=>s.id),['known','a','b']);
  }
});
test('clock skew cannot duplicate survey numbers and photo records are numbered independently',()=>{
  const a=C.upgrade({id:'a',kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',
    createdAt:300000,recordNo:1,memo:'A',photos:[]});
  const b=C.upgrade({id:'b',kind:'field-record',recordKind:'field-record',recordType:'survey',type:'調査',
    createdAt:100,recordNo:1,memo:'B',photos:[]});
  const photo=C.upgrade({id:'p',kind:'field-record',recordKind:'field-record',recordType:'photo',type:'全景',
    createdAt:50,recordNo:1,memo:'全景',photos:[]});
  const out=merged(make([a,photo]),make([b]),make([])).drawings[0].state.shapes;
  assert.deepEqual(out.filter(s=>s.recordType==='survey').map(s=>s.autoLabel),['調査-1','調査-2']);
  assert.deepEqual(out.filter(s=>s.recordType==='photo').map(s=>s.autoLabel),['全景-1']);
  assert.deepEqual(new Set(out.map(s=>s.id)),new Set(['a','b','p']));
});
console.log(passed+' collaborative snapshot merge scenarios passed');
// Shared-model preflight is intentionally test-only; no production code changes.
require('./delta_sync_preflight.test.cjs');

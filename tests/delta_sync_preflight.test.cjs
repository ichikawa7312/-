'use strict';
// Pre-implementation gate: no database access, no user records or live uploads.
// Exercise the current immutable merge against realistic novice / expert usage,
// simultaneous edits, offline replay and malformed histories.
const assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js');
const M=require('../sentlog/sync-merge.js');
const clone=v=>JSON.parse(JSON.stringify(v));
const survey=(id='record-1',memo='既存コメント')=>({
  id,kind:'field-record',recordKind:'field-record',recordType:'survey',
  page:1,type:'調査',member:'横桁',point:{x:10,y:20},
  points:[{x:10,y:20},{x:10,y:20}],memo,photos:[{id:'p0',name:'元写真.jpg',size:10}],
  crackWidthMm:0.2,createdAt:1000,recordNo:1,typeNo:1,autoLabel:'調査-1'
});
const op=(device,action,at)=>{let i=0;return {
  actor:{deviceId:device,deviceName:device==='A'?'iPhone':'iPad'},
  at:at??(device==='A'?100000:100001),
  idFactory:()=>device+':'+action+':'+(++i)
}};
const head=(r,key)=>C.view(r).fields[key].headIds;
const commentId=r=>C.view(r).comments[0].id;
const chead=(r,id=commentId(r))=>C.view(r).comments.find(x=>x.id===id).headIds;
const phead=(r,id='p0')=>C.view(r).photos.find(x=>x.id===id).headIds;
const pack=(records,deleted=[])=>{
  const meta={id:'drawing',name:'正面図',sourceType:null,fileName:'',updatedAt:1};
  return {project:{id:'project',name:'事前検証',updatedAt:1,drawings:[meta],collaborationVersion:1},
    drawings:[{meta:clone(meta),state:{sourceType:null,fileName:'',pageCount:1,
    pageSettings:{},pageRotations:{},currentPage:1,width:100,
    shapes:clone(records),...(deleted.length?{collabDeletedRecords:clone(deleted)}:{})}}]};
};
let checks=0;
function check(name,fn){
  try{fn();checks++;console.log('PASS '+name);}
  catch(e){e.message='[PRE-FLIGHT] '+name+': '+e.message;throw e;}
}
const scenarios=[
 ['別々のコメントを同時追加',base=>[
   C.appendComment(base,'Aの近接所見',op('A','newcomment')),
   C.appendComment(base,'Bの外観所見',op('B','newcomment'))],
  (r)=>{assert(r.memo.includes('Aの近接所見')&&r.memo.includes('Bの外観所見'));assert.equal(C.view(r).comments.length,3);}],
 ['同じ文章を別々の端末から追加',base=>[
   C.appendComment(base,'異常なし',op('A','equal-text')),
   C.appendComment(base,'異常なし',op('B','equal-text'))],
  r=>assert.equal(C.view(r).comments.filter(x=>x.text==='異常なし').length,2)],
 ['異なる写真を同時追加',base=>[
   C.addPhoto(base,{id:'photo-A',name:'A.jpg',size:100},op('A','photo')),
   C.addPhoto(base,{id:'photo-B',name:'B.jpg',size:200},op('B','photo'))],
  r=>assert.deepEqual(new Set(r.photos.map(p=>p.id)),new Set(['p0','photo-A','photo-B']))],
 ['写真追加とコメント追記が同時',base=>[
   C.addPhoto(base,{id:'photo-A',name:'A.jpg',size:100},op('A','photo')),
   C.appendComment(base,'Bのコメント',op('B','comment'))],
  r=>{assert(r.memo.includes('Bのコメント'));assert(r.photos.some(p=>p.id==='photo-A'));}],
 ['違う項目の同時更新',base=>[
   C.setField(base,'member','主桁',{...op('A','member'),expectedHeads:head(base,'member')}),
   C.setField(base,'type','腐食',{...op('B','type'),expectedHeads:head(base,'type')})],
  r=>{assert.equal(r.member,'主桁');assert.equal(r.type,'腐食');assert.equal(C.view(r).conflicts.length,0);}],
 ['同じ項目を同じ値に変更',base=>[
   C.setField(base,'crackWidthMm',0.3,{...op('A','same-value'),expectedHeads:head(base,'crackWidthMm')}),
   C.setField(base,'crackWidthMm',0.3,{...op('B','same-value'),expectedHeads:head(base,'crackWidthMm')})],
  r=>{assert.equal(r.crackWidthMm,0.3);assert.equal(C.view(r).fields.crackWidthMm.conflict,false);}],
 ['同じ項目を異なる値に変更',base=>[
   C.setField(base,'crackWidthMm',0.3,{...op('A','diff-value'),expectedHeads:head(base,'crackWidthMm')}),
   C.setField(base,'crackWidthMm',0.4,{...op('B','diff-value'),expectedHeads:head(base,'crackWidthMm')})],
  r=>{assert.equal(r.crackWidthMm,0.2);assert(C.view(r).fields.crackWidthMm.conflict);}],
 ['ひび割れ幅0.1秒差の競合',base=>[
   C.setField(base,'crackWidthMm',0.3,{...op('A','100ms',100000),expectedHeads:head(base,'crackWidthMm')}),
   C.setField(base,'crackWidthMm',0.4,{...op('B','100ms',100100),expectedHeads:head(base,'crackWidthMm')})],
  r=>{assert(C.view(r).fields.crackWidthMm.conflict);assert.equal(r.crackWidthMm,0.2);}],
 ['端末時計が逆でも後勝ちにしない',base=>[
   C.setField(base,'crackWidthMm',0.3,{...op('A','clock',99999999),expectedHeads:head(base,'crackWidthMm')}),
   C.setField(base,'crackWidthMm',0.4,{...op('B','clock',1),expectedHeads:head(base,'crackWidthMm')})],
  r=>{assert(C.view(r).fields.crackWidthMm.conflict);assert.equal(r.crackWidthMm,0.2);}],
 ['同じコメントを別々に編集',base=>{
   const id=commentId(base);return [
   C.editComment(base,id,'Aの修正',{...op('A','edit'),expectedHeads:chead(base,id)}),
   C.editComment(base,id,'Bの修正',{...op('B','edit'),expectedHeads:chead(base,id)})];},
  r=>{assert(C.view(r).comments[0].conflict);assert(r.memo.includes('Aの修正')&&r.memo.includes('Bの修正'));}],
 ['同じコメントを同じ内容に編集',base=>{
   const id=commentId(base);return [
   C.editComment(base,id,'共同確認済み',{...op('A','equal-edit'),expectedHeads:chead(base,id)}),
   C.editComment(base,id,'共同確認済み',{...op('B','equal-edit'),expectedHeads:chead(base,id)})];},
  r=>{assert.equal(C.view(r).comments[0].conflict,false);assert.equal(r.memo,'共同確認済み');}],
 ['位置XとYを別端末で変更',base=>{
   const a=clone(C.view(base).fields.geometry.value),b=clone(a);a.point.x=30;b.point.y=40;
   return [C.setField(base,'geometry',a,{...op('A','geometry'),expectedHeads:head(base,'geometry')}),
           C.setField(base,'geometry',b,{...op('B','geometry'),expectedHeads:head(base,'geometry')})]},
  r=>{assert(C.view(r).fields.geometry.conflict);assert.deepEqual(r.point,{x:10,y:20});}],
 ['同じ写真IDで異なる画像を登録',base=>[
   C.addPhoto(base,{id:'same',name:'A.jpg',size:10},op('A','photo-collision')),
   C.addPhoto(base,{id:'same',name:'B.jpg',size:20},op('B','photo-collision'))],
  r=>{assert(C.view(r).photos.find(p=>p.id==='same').conflict);assert(r.photos.some(p=>p.collabConflict));}],
 ['同じ写真ID・同じ内容を再送',base=>[
   C.addPhoto(base,{id:'same',name:'same.jpg',size:10},op('A','photo-same')),
   C.addPhoto(base,{id:'same',name:'same.jpg',size:10},op('B','photo-same'))],
  r=>{assert.equal(r.photos.filter(p=>p.id==='same').length,1);assert.equal(C.view(r).photos.find(p=>p.id==='same').conflict,false);}],
 ['写真削除と別写真追加',base=>[
   C.removePhoto(base,'p0',{...op('A','delete-p'),expectedHeads:phead(base)}),
   C.addPhoto(base,{id:'new',name:'new.jpg',size:10},op('B','new-p'))],
  r=>{assert.deepEqual(r.photos.map(p=>p.id),['new']);assert.equal(C.view(r).photos.find(p=>p.id==='p0').deleted,true);}],
 ['既存コメント削除と同時編集',base=>{
   const id=commentId(base);return [
   C.removeComment(base,id,{...op('A','rm-comment'),expectedHeads:chead(base,id)}),
   C.editComment(base,id,'残すべき変更',{...op('B','ed-comment'),expectedHeads:chead(base,id)})]},
  r=>{assert(C.view(r).comments[0].conflict);assert(r.memo.includes('残すべき変更'));}],
 ['記録削除と写真追加',base=>[
   C.markDeleted(base,{...op('A','delete-rec'),expectedToken:C.revisionToken(base)}),
   C.addPhoto(base,{id:'new',name:'B.jpg'},op('B','photo-after-delete'))],
  r=>{assert.equal(C.isDeleted(r),false);assert(C.view(r).pendingDelete);assert(r.photos.some(p=>p.id==='new'));}],
 ['記録削除とコメント追記',base=>[
   C.markDeleted(base,{...op('A','delete-rec-comment'),expectedToken:C.revisionToken(base)}),
   C.appendComment(base,'削除中に追加',op('B','new-after-delete'))],
  r=>{assert.equal(C.isDeleted(r),false);assert(C.view(r).pendingDelete);assert(r.memo.includes('削除中に追加'));}],
 ['部材名の消去と別項目変更',base=>[
   C.setField(base,'member',undefined,{...op('A','unset'),unset:true,expectedHeads:head(base,'member')}),
   C.setField(base,'type','欠損',{...op('B','change-type'),expectedHeads:head(base,'type')})],
  r=>{assert.equal(r.member,undefined);assert.equal(r.type,'欠損');}],
 ['長文・日本語・絵文字と別の写真',base=>[
   C.appendComment(base,'コンクリートひび割れ＿'+('詳細所見。'.repeat(600))+'📷',op('A','long-jp')),
   C.addPhoto(base,{id:'long-text-photo',name:'写真📷.jpg',size:333},op('B','long-photo'))],
  r=>{assert(r.memo.includes('詳細所見。'.repeat(600)));assert(r.photos.some(p=>p.name==='写真📷.jpg'));}],
];
const base=C.upgrade(survey());
for(const [name,make,verify] of scenarios){
  const [left,right]=make(base),source=JSON.stringify([base,left,right]);
  for(const [a,b,order] of [[left,right,'A→B'],[right,left,'B→A']]){
    check(name+' / '+order,()=>{
      const joined=C.mergeRecords(a,b,{base});assert(joined.ok,joined.reason);
      const result=joined.record;verify(result);
      const again=C.mergeRecords(result,a,{base});assert(again.ok,again.reason);
      assert(C.equal(again.record,result),'a duplicated delivery must not mutate a committed merge');
      assert.equal(JSON.stringify([base,left,right]),source,'input snapshots may not be overwritten');
    });
  }
}
check('同じ変更IDの再試行は二重登録しない',()=>{
  const opts={...op('A','retry'),commentId:'comment-stable',revisionId:'rev-stable',at:100};
  const first=C.appendComment(base,'一回だけ',opts),second=C.appendComment(first,'一回だけ',opts);
  assert(C.equal(first,second));
  assert.throws(()=>C.appendComment(first,'不一致',opts),e=>e.code==='COLLAB_REVISION_COLLISION');
});
check('受信済み旧変更を送っても競合解決が戻らない',()=>{
  const id=commentId(base),h=chead(base,id);
  const a=C.editComment(base,id,'A',{...op('A','resolve-a'),expectedHeads:h});
  const b=C.editComment(base,id,'B',{...op('B','resolve-b'),expectedHeads:h});
  const conflicting=C.mergeRecords(a,b,{base}).record;
  const resolved=C.resolveComment(conflicting,id,'最終確認',{...op('C','resolved'),expectedHeads:chead(conflicting,id)});
  assert.equal(C.view(resolved).comments[0].conflict,false);
  assert.equal(C.mergeRecords(resolved,a,{base}).record.memo,'最終確認');
});
check('壊れた履歴・別の写真内容は安全側で拒否',()=>{
  const invalid=clone(base);
  invalid.collab.fields.geometry.revisions[0].at=555;
  const before=JSON.stringify([base,invalid]);
  assert.equal(C.mergeRecords(base,invalid,{base}).code,'COLLAB_REVISION_COLLISION');
  assert.equal(JSON.stringify([base,invalid]),before);
});
check('古い形式の記録は元の写真とコメントを維持',()=>{
  const raw=survey('legacy'),migrated=C.upgrade(raw);
  assert.equal(migrated.memo,raw.memo);assert.deepEqual(migrated.photos,raw.photos);
  assert.deepEqual(C.upgrade(migrated),migrated);
});
check('一般的な未編集値の空欄保存が既存コメントを消さない',()=>{
  const raw=clone(base);raw.memo='';raw.photos=[];
  const projected=C.applyLocalEdit(base,raw,op('A','accidental-clear'));
  assert(projected.memo.includes('既存コメント'));assert(projected.photos.some(p=>p.id==='p0'));
});
check('最後に受信した端末が同じ内容をもう一度同期しても安定',()=>{
  const a=C.appendComment(base,'A',op('A','repeat-A'));
  const b=C.addPhoto(base,{id:'repeat-photo',name:'B.jpg'},op('B','repeat-B'));
  const out=C.mergeRecords(a,b,{base});assert(out.ok);
  let result=out.record;
  for(let i=0;i<8;i++){
    const step=C.mergeRecords(result,i%2===0?a:b,{base});assert(step.ok);
    assert(C.equal(step.record,result));result=step.record;
  }
});
check('3台それぞれの独立した調査記録は全件保存され番号がユニーク',()=>{
  const records=Array.from({length:60},(_,i)=>C.upgrade({...survey('offline-'+i,'端末'+(i%3)+'記録'+i),
    type:'調査',recordNo:1,typeNo:1,createdAt:2000+(i*17)%401,photos:[{id:'photo-'+i,name:'撮影-'+i+'.jpg'}]}));
  const a=pack(records.filter((_,i)=>i%3===0));
  const b=pack(records.filter((_,i)=>i%3===1));
  const c=pack(records.filter((_,i)=>i%3===2));
  const blank=pack([]);
  const ab=M.merge(a,b,{base:blank});assert(ab.ok,JSON.stringify(ab.conflicts).slice(0,300));
  const abc=M.merge(ab.payload,c,{base:blank});assert(abc.ok,JSON.stringify(abc.conflicts).slice(0,300));
  const ba=M.merge(b,a,{base:blank});assert(ba.ok);
  const bac=M.merge(ba.payload,c,{base:blank});assert(bac.ok);
  const one=abc.payload.drawings[0].state.shapes;
  const two=bac.payload.drawings[0].state.shapes;
  assert.equal(one.length,60);assert.equal(new Set(one.map(s=>s.id)).size,60);
  assert.deepEqual(one.map(s=>s.id),two.map(s=>s.id));
  assert.deepEqual(one.map(s=>s.autoLabel),Array.from({length:60},(_,i)=>'調査-'+(i+1)));
  assert.equal(one.reduce((n,s)=>n+s.photos.length,0),60);
});
check('図面の回転と別端末の記録変更は自動採用しない',()=>{
  const left=pack([base]),right=pack([C.appendComment(base,'追記',op('B','rotation'))]);
  left.drawings[0].state.pageRotations={'1':90};
  assert.equal(M.merge(left,right,{base:pack([base])}).ok,false);
});
check('図面の縮尺と別端末の記録変更は自動採用しない',()=>{
  const left=pack([base]),right=pack([C.appendComment(base,'追記',op('B','scale'))]);
  left.drawings[0].state.pageSettings={'1':{scaleDenom:100}};
  assert.equal(M.merge(left,right,{base:pack([base])}).ok,false);
});
check('未確定の削除を旧スナップショット受信で実行しない',()=>{
  const deleted=C.markDeleted(base,{...op('A','deleted'),expectedToken:C.revisionToken(base)});
  const received=C.mergeRecords(deleted,C.appendComment(base,'別端末から追記',op('B','retained')),{base});
  assert(received.ok);assert(!C.isDeleted(received.record));assert(C.view(received.record).pendingDelete);
});
console.log('PREFLIGHT RESULT: '+checks+' independently asserted baseline scenarios passed;');
console.log('NOTE: delta event-log transport, offline replay cursor, network recovery, and new UX are NOT yet implemented and not certified by this suite.');

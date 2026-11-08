'use strict';
const assert=require('node:assert/strict'),M=require('../sentlog/sync-merge.js');
const clone=x=>JSON.parse(JSON.stringify(x));
const shape=(id,memo='')=>({id,type:'ひび割れ',kind:'polyline',points:[{x:1,y:2},{x:5,y:6}],no:'手入力-'+id,memo,photos:[]});
const make=(shapes,updatedAt=1)=>{const meta={id:'d',name:'正面図',sourceType:null,fileName:'',updatedAt};return {project:{id:'p',name:'試験',updatedAt,drawings:[meta]},drawings:[{meta:clone(meta),state:{sourceType:null,fileName:'',shapes:clone(shapes),pageSettings:{},pageRotations:{},width:100,currentPage:1}}]};};
const base=make([shape('common')]),local=make([shape('common'),shape('ipad')],2),remote=make([shape('common'),shape('phone')],3);
const before=JSON.stringify([base,local,remote]);
let r=M.merge(local,remote,{preserve:true,now:4});
assert(r.ok);assert.deepEqual(r.payload.drawings[0].state.shapes.map(s=>s.id),['common','phone','ipad']);
assert.deepEqual(r.payload.drawings[0].state.shapes.map(s=>s.no),['手入力-common','手入力-phone','手入力-ipad']);
assert.deepEqual(r.payload.drawings[0].state.shapes.map(s=>s.typeNo),[1,2,3]);
assert.equal(JSON.stringify([base,local,remote]),before,'inputs must remain unchanged');
assert(!M.merge(local,remote).ok,'no common ancestor must never silently infer deletions');
assert(M.merge(local,remote,{base}).ok,'independent new records merge with an ancestor');
r=M.merge(local,r.payload,{preserve:true});assert(r.ok);assert.equal(r.payload.drawings[0].state.shapes.length,3,'retry/other-device merge does not duplicate records');

const edited=clone(base);edited.drawings[0].state.shapes[0].memo='更新';
r=M.merge(edited,remote,{base});assert(r.ok);assert.equal(r.payload.drawings[0].state.shapes[0].memo,'更新');
const deleted=make([]);
r=M.merge(deleted,remote,{base});assert(r.ok);assert.deepEqual(r.payload.drawings[0].state.shapes.map(s=>s.id),['phone']);
assert(!M.merge(deleted,edited,{base}).ok,'delete/edit conflict must stop');
r=M.merge(deleted,edited,{preserve:true});assert(r.ok);assert.equal(r.payload.drawings[0].state.shapes[0].memo,'更新','explicit preserve retains one-sided records');
const otherEdit=clone(edited);otherEdit.drawings[0].state.shapes[0].memo='異なる更新';
assert(!M.merge(edited,otherEdit,{base}).ok);assert(!M.merge(edited,otherEdit,{preserve:true}).ok,'no latest-timestamp winner for same field');
const geometry=clone(base);geometry.drawings[0].state.shapes[0].points[0].x=99;
// Never invent a combined version of the same annotation, even for different fields.
assert(!M.merge(geometry,edited,{base}).ok);
const otherGeometry=clone(base);otherGeometry.drawings[0].state.shapes[0].points[1].y=99;
assert(!M.merge(geometry,otherGeometry,{base}).ok);

const pa=clone(base),pb=clone(base);pa.drawings[0].state.shapes[0].photos=[{id:'a',name:'a.jpg'}];pb.drawings[0].state.shapes[0].photos=[{id:'b',name:'b.jpg'}];
r=M.merge(pa,pb,{preserve:true});assert(r.ok);assert.deepEqual(r.payload.drawings[0].state.shapes[0].photos.map(p=>p.id),['b','a']);
pb.drawings[0].state.shapes[0].photos=[{id:'a',name:'different.jpg'}];assert(!M.merge(pa,pb,{preserve:true}).ok,'different metadata for the same photo is not ignored');
const photoBase=clone(pa),photoDeleted=clone(base),photoAdded=clone(pa);photoAdded.drawings[0].state.shapes[0].photos.push({id:'b',name:'b.jpg'});
r=M.merge(photoDeleted,photoAdded,{base:photoBase});assert(r.ok);assert.deepEqual(r.payload.drawings[0].state.shapes[0].photos.map(p=>p.id),['b']);

const scaled=clone(local);scaled.drawings[0].state.pageSettings={'1':{scaleDenom:100}};
assert(!M.merge(scaled,remote,{preserve:true}).ok,'unknown coordinate-frame changes require review');
assert(!M.merge(scaled,remote,{base}).ok,'a coordinate-frame change cannot reinterpret peer annotations');
const rotated=clone(local);rotated.drawings[0].state.pageRotations={'1':90};assert(!M.merge(rotated,remote,{preserve:true}).ok);
const view=clone(local);view.drawings[0].state.currentPage=5;view.drawings[0].state.width=2000;view.drawings[0].state.typeCounters={x:9};assert(M.merge(view,remote,{preserve:true}).ok);

const d2=make([shape('extra')]);d2.project.drawings[0].id='d2';d2.drawings[0].meta.id='d2';const multi=clone(local);multi.project.drawings.push(d2.project.drawings[0]);multi.drawings.push(d2.drawings[0]);
r=M.merge(multi,remote,{base});assert(r.ok);assert.equal(r.payload.drawings.length,2);
const noDrawings=clone(base);noDrawings.project.drawings=[];noDrawings.drawings=[];
assert(M.merge(noDrawings,base,{base}).ok);assert.equal(M.merge(noDrawings,base,{base}).payload.drawings.length,0);
assert(!M.merge(noDrawings,edited,{base}).ok);
const bad=clone(base);bad.project.id='different';assert(!M.merge(bad,base,{preserve:true}).ok);
const duplicate=clone(base);duplicate.drawings[0].state.shapes.push(shape('common'));assert(!M.merge(duplicate,base,{preserve:true}).ok);
const absent=clone(base);absent.drawings=[];assert(!M.merge(absent,base,{preserve:true}).ok);
const mismatched=clone(base);mismatched.drawings[0].meta.name='不一致';assert(!M.merge(mismatched,base,{preserve:true}).ok);
const nullValue=clone(local);nullValue.project.optional=null;
r=M.merge(nullValue,remote,{preserve:true});assert(r.ok);assert.equal(r.payload.project.optional,null);
const memo=shape('memo');memo.recordKind='drawing-memo';const dimension=shape('dimension');dimension.recordKind='dimension-line';
r=M.merge(make([shape('common'),memo,dimension]),remote,{base});assert(r.ok);assert.equal(r.payload.drawings[0].state.nextGlobalNo,3);assert.equal(r.payload.drawings[0].state.shapes.length,4);
console.log('PASS merge: independent additions, photos, repeat, three-way edits/deletions, conflicting geometry, malformed data, manual labels, immutable inputs');

// The reported seven-page PDF can carry a stale count from before it was opened.
function pdfPack(pack,count){
  const p=clone(pack);Object.assign(p.drawings[0].meta,{sourceType:'pdf',fileName:'16_操作台.pdf',pageCount:count});
  p.project.drawings[0]=clone(p.drawings[0].meta);Object.assign(p.drawings[0].state,{sourceType:'pdf',fileName:'16_操作台.pdf',pageCount:count});return p;
}
const pdfLocal=pdfPack(local,1),pdfRemote=pdfPack(remote,7),pdfBefore=JSON.stringify([pdfLocal,pdfRemote]);
pdfLocal.drawings[0].state.shapes[1].page=7;
assert(!M.merge(pdfLocal,pdfRemote,{preserve:true}).ok,'an unverified count mismatch must still stop');
const verified={preserve:true,verifiedPdfPageCounts:{d:7}};
r=M.merge(pdfLocal,pdfRemote,verified);assert(r.ok);assert.equal(r.payload.project.drawings[0].pageCount,7);assert.equal(r.payload.drawings[0].state.pageCount,7);
assert.equal(r.payload.drawings[0].state.shapes.find(s=>s.id==='ipad').page,7);
assert.equal(pdfLocal.drawings[0].state.pageCount,1);assert.equal(pdfRemote.drawings[0].state.pageCount,7);
const rotatedPdf=clone(pdfLocal);rotatedPdf.drawings[0].state.pageRotations={'1':90};assert(!M.merge(rotatedPdf,pdfRemote,verified).ok);
const scaledPdf=clone(pdfLocal);scaledPdf.drawings[0].state.pageSettings={'1':{scaleDenom:100}};assert(!M.merge(scaledPdf,pdfRemote,verified).ok);
const outside=clone(pdfLocal);outside.drawings[0].state.shapes[1].page=8;assert(!M.merge(outside,pdfRemote,verified).ok);
assert(!M.merge(pdfLocal,pdfRemote,{preserve:true,verifiedPdfPageCounts:{d:0}}).ok);
const pdfBase=pdfPack(base,1);assert(M.merge(pdfLocal,pdfRemote,{base:pdfBase,verifiedPdfPageCounts:{d:7}}).ok);
console.log('PASS verified PDF count: stale 1/7 reconciled, page-7 records retained, genuine rotation/scale and out-of-range pages blocked');

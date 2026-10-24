'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const T=require('../sentlog/record-transfer.js');
let n=0;const id=()=>String(++n);
const src={pageCount:2,shapes:[
  {id:'a',page:1,type:'調査',kind:'rect',x:10,y:20,w:30,h:40,labelPos:{x:15,y:25},memo:'保持',photos:[{id:'p1',name:'1.jpg'}]},
  {id:'b',page:1,type:'調査',kind:'line',points:[{x:1,y:2},{x:3,y:4}],photos:[]},
  {id:'c',page:2,type:'調査',kind:'line',points:[{x:5,y:6},{x:7,y:8}],photos:[]}
]};
const dst={pageCount:3,shapes:[{id:'z',page:1,type:'既存',kind:'line',points:[{x:0,y:0},{x:1,y:1}],photos:[]}]};
const before=JSON.stringify([src,dst]);
let p=T.makeTransferPlan(src,dst,['a','b'],{operation:'copy',targetPage:3,sx:2,sy:3,sourceDrawingId:'s',targetDrawingId:'t',idFactory:id,photoIdFactory:id});
assert.equal(JSON.stringify([src,dst]),before,'inputs unchanged');
assert.equal(p.sourceState.shapes.length,3);
assert.equal(p.targetState.shapes.length,3);
assert.equal(p.targetState.shapes[1].page,3);
assert.equal(p.targetState.shapes[1].x,20);
assert.equal(p.targetState.shapes[1].y,60);
assert.equal(p.targetState.shapes[1].w,60);
assert.equal(p.targetState.shapes[1].h,120);
assert.equal(p.targetState.shapes[1].memo,'保持');
assert.equal(p.targetState.shapes[1].photos.length,1);
assert.notEqual(p.targetState.shapes[1].photos[0].id,'p1');
assert.equal(p.photoJobs.length,1);
assert.equal(p.photoJobs[0].sourcePhotoId,'p1');
assert.equal(p.newIds.length,2);

n=0;p=T.makeTransferPlan(src,dst,['a'],{operation:'move',targetPage:2,sameDrawing:false,sourceDrawingId:'s',targetDrawingId:'t',idFactory:id,photoIdFactory:id});
assert(!p.sourceState.shapes.some(s=>s.id==='a'));
assert(src.shapes.some(s=>s.id==='a'),'source input retained');
assert(p.targetState.shapes.some(s=>s.page===2&&s.memo==='保持'));

n=0;p=T.makeTransferPlan(src,src,['a'],{operation:'move',targetPage:2,sameDrawing:true,sourceDrawingId:'s',targetDrawingId:'s',idFactory:id,photoIdFactory:id});
assert.equal(p.sourceState,p.targetState);
assert.equal(p.sourceState.shapes.length,3);
assert(!p.sourceState.shapes.some(s=>s.id==='a'));
assert(p.sourceState.shapes.some(s=>s.page===2&&s.memo==='保持'));

const code=fs.readFileSync('sentlog/record-transfer.js','utf8');
assert.match(code,/await copyPhotos\(plan\.photoJobs\)/);
assert.ok(code.indexOf('await copyPhotos(plan.photoJobs)')<code.indexOf('root.SentlogRecords.batch(writes)'),'photos verified before atomic record commit');
assert.match(code,/operation==='move'/);
assert.match(code,/記録をコピー／移動/);
assert.match(code,/このページを全部選択/);
assert.match(code,/移動先を開いています/);
const index=fs.readFileSync('sentlog/index.html','utf8');
assert.match(index,/record-transfer\.js\?v=199/);
console.log('PASS record transfer: multi-select copy/move, photo cloning, geometry mapping and atomic record commit');

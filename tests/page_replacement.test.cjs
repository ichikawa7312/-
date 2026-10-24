'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const P=require('../sentlog/page-replacement.js');

assert.equal(P.frameCompatible(
  {pageCount:8,rotation:0,wMm:420.158,hMm:297.039},
  {pageCount:1,rotation:0,wMm:420.160,hMm:297.040}
).ok,true);
assert.equal(P.frameCompatible(
  {pageCount:8,rotation:0,wMm:420,hMm:297},
  {pageCount:2,rotation:0,wMm:420,hMm:297}
).ok,false);
assert.equal(P.frameCompatible(
  {pageCount:8,rotation:0,wMm:420,hMm:297},
  {pageCount:1,rotation:90,wMm:420,hMm:297}
).ok,false);
assert.equal(P.frameCompatible(
  {pageCount:8,rotation:0,wMm:420,hMm:297},
  {pageCount:1,rotation:0,wMm:430,hMm:297}
).ok,false);

const stats=P.pageRecordStats([
  {page:3,kind:'rect',photos:[{},{}]},
  {page:3,recordKind:'drawing-memo',photos:[{}]},
  {page:3,recordKind:'dimension-line',kind:'dimension',photos:[]},
  {page:4,kind:'rect',photos:[{}]}
],3);
assert.deepEqual(stats,{damage:1,dimensions:1,memos:1,photos:3,total:3});

const first=P.nextMarker({},3,'3F.pdf',100,false);
const second=P.nextMarker(first,3,'restore',200,true);
assert.equal(first['3'].revision,1);
assert.equal(second['3'].revision,2);
assert.equal(second['3'].restored,true);

const source=fs.readFileSync('sentlog/page-replacement.js','utf8');
assert.match(source,/sourceDoc\.removePage\(pageNo-1\)/);
assert.match(source,/sourceDoc\.insertPage\(pageNo-1,newPage\)/);
assert.match(source,/page-replace-backup:/);
assert.match(source,/既存の記録・写真・コメントは保持されています/);
assert.ok(!source.includes('state.shapes=[]'),'page replacement must never clear shapes');
assert.ok(source.indexOf('writeFile(backupFileKey(),source)')<source.indexOf('await saveBackgroundFile(merged,activeDrawingId)'),'backup must be verified before replacement write');

const index=fs.readFileSync('sentlog/index.html','utf8');
assert.match(index,/page-replacement\.js\?v=198/);
console.log('PASS single-page PDF replacement preserves record model and has verified rollback');

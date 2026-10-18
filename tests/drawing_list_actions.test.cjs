const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const feature=require(path.join(root,'sentlog/drawing-list-actions.js'));

assert.equal(feature.cleanName('  下流面   詳細図  '),'下流面 詳細図');
assert.throws(()=>feature.cleanName('   '),/図面名/);
assert.throws(()=>feature.cleanName('a'.repeat(101)),/100文字/);
assert.equal(feature.belongsToDrawing('background:d1','d1'),true);
assert.equal(feature.belongsToDrawing('photo:d1:p1','d1'),true);
assert.equal(feature.belongsToDrawing('photo:d10:p1','d1'),false);
assert.equal(feature.belongsToDrawing('background:d2','d1'),false);

const files=[
  {key:'background:d1',value:new Blob(['pdf'])},
  {key:'photo:d1:p1',value:new Blob(['photo-one'])},
  {key:'photo:d2:p2',value:new Blob(['photo-two'])},
  {key:'not-a-blob',value:'x'}
];
assert.deepEqual(feature.deletionFiles(files,'d1').map(x=>x.key),['background:d1','photo:d1:p1']);

const ws={projects:[{id:'p1',name:'案件',updatedAt:1,drawings:[
  {id:'d1',name:'図面A',updatedAt:1},{id:'d2',name:'図面B',updatedAt:2}
]}]};
const renamed=feature.renameDrawingInWorkspace(ws,'p1','d1','図面A-改',10);
assert.equal(renamed.projects[0].drawings[0].name,'図面A-改');
assert.equal(renamed.projects[0].updatedAt,10);
assert.equal(ws.projects[0].drawings[0].name,'図面A','source workspace must stay immutable');
const removed=feature.removeDrawingFromWorkspace(ws,'p1','d2',11);
assert.deepEqual(removed.projects[0].drawings.map(x=>x.id),['d1']);
assert.deepEqual(ws.projects[0].drawings.map(x=>x.id),['d1','d2']);

const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
assert.match(index,/drawing-list-actions\.js\?v=169/);
assert.match(index,/SentlogDrawingListActions/);
assert.match(index,/original-photo-store\.js\?v=169/);
assert.match(index,/phone-runtime\.js\?v=169/);
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');
assert.match(sw,/sentlog-pwa-v180/);
assert.match(sw,/drawing-list-actions\.js/);
const source=fs.readFileSync(path.join(root,'sentlog/drawing-list-actions.js'),'utf8');
assert.match(source,/S\.archiveAtomic/);
assert.match(source,/原本写真 .*この操作では削除しません/);
assert.doesNotMatch(source,/SentlogOriginalPhotos\?\.deleteExported/,'drawing delete must not delete originals');
const originals=fs.readFileSync(path.join(root,'sentlog/original-photo-store.js'),'utf8');
assert.match(originals,/async function drawingStats\(drawingId\)/);
assert.match(originals,/async function renameDrawing\(drawingId,drawingName\)/);
const cloud=fs.readFileSync(path.join(root,'sentlog/cloud-sync.js'),'utf8');
assert.match(cloud,/allowedDrawingIds=new Set/);
assert.match(cloud,/!allowedDrawingIds\.has\(drawingId\)/);
console.log('PASS drawing list: rename, safe atomic delete, original-photo preservation, orphan cloud assets ignored');

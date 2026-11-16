const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const groups=require('../sentlog/drawing-groups.js');
const order=require('../sentlog/drawing-order.js');

const initial={projects:[{id:'p1',name:'測量案件',updatedAt:8,drawings:[
  {id:'s1',name:'平面図',sheetName:'平面図',groupId:'g1',groupName:'図面No.1',sheetOrder:1,
    fileName:'drawing-1.pdf',createdAt:1,updatedAt:3,shapeCount:4,photoCount:2},
  {id:'s2',name:'断面図',sheetName:'断面図',groupId:'g1',groupName:'図面No.1',sheetOrder:2,
    fileName:'drawing-2.pdf',createdAt:2,updatedAt:4,shapeCount:3,photoCount:5},
  {id:'s3',name:'立面図',sheetName:'立面図',groupId:'g2',groupName:'図面No.2',sheetOrder:1,
    fileName:'drawing-3.pdf',createdAt:3,updatedAt:6,shapeCount:0,photoCount:0}
]}]};
const original=JSON.parse(JSON.stringify(initial));
const sheet=(ws,id)=>ws.projects[0].drawings.find(x=>x.id===id);

// Only display metadata changes; fileName / drawing ID / recorded counts stay unchanged.
const renamed=groups.renameSheetInWorkspace(initial,'p1','s2','  下流側 断面図 ',100);
assert.deepEqual(initial,original,'rename never mutates caller records');
assert.equal(sheet(renamed,'s2').name,'下流側 断面図');
assert.equal(sheet(renamed,'s2').sheetName,'下流側 断面図');
assert.equal(sheet(renamed,'s2').id,'s2');
assert.equal(sheet(renamed,'s2').groupId,'g1');
assert.equal(sheet(renamed,'s2').fileName,'drawing-2.pdf');
assert.equal(sheet(renamed,'s2').photoCount,5);
assert.equal(sheet(renamed,'s2').shapeCount,3);
assert.equal(sheet(renamed,'s1').name,'平面図');
assert.deepEqual(groups.groupsForProject(renamed.projects[0]).find(g=>g.id==='g1').sheets.map(d=>d.id),['s1','s2']);
assert.throws(()=>groups.renameSheetInWorkspace(initial,'p1','s1','   '),/シート名/);
assert.throws(()=>groups.renameSheetInWorkspace(initial,'p1','s1','a'.repeat(101)),/100/);
assert.throws(()=>groups.renameSheetInWorkspace(initial,'p1','missing','A'),/見つかりません/);

const trashed=groups.trashSheetInWorkspace(renamed,'p1','s2',200);
assert.equal(sheet(trashed,'s2').deletedAt,200);
assert.deepEqual(groups.groupsForProject(trashed.projects[0]).find(g=>g.id==='g1').sheets.map(d=>d.id),['s1']);
assert.deepEqual(groups.trashedSheetsForProject(trashed.projects[0]).map(d=>d.id),['s2']);
assert.deepEqual(trashed.projects[0].drawings.map(d=>d.id),['s1','s2','s3'],'trash keeps metadata for synchronization');
assert.equal(sheet(trashed,'s2').fileName,'drawing-2.pdf','PDF reference retained');
assert.equal(sheet(trashed,'s2').photoCount,5,'photo references retained');
assert.equal(sheet(trashed,'s2').sheetName,'下流側 断面図');
assert.equal(groups.nextSheetOrder(trashed.projects[0],'g1'),3,'trash does not reuse sheet order');
assert.throws(()=>groups.trashSheetInWorkspace(trashed,'p1','s2',210),/既に/);
assert.throws(()=>groups.renameSheetInWorkspace(trashed,'p1','s2','A'),/復元/);

const restored=groups.restoreSheetInWorkspace(trashed,'p1','s2',300);
assert.equal(sheet(restored,'s2').deletedAt,undefined);
assert.equal(sheet(restored,'s2').id,'s2','restore keeps original ID for photos/records');
assert.equal(sheet(restored,'s2').name,'下流側 断面図');
assert.deepEqual(groups.groupsForProject(restored.projects[0]).find(g=>g.id==='g1').sheets.map(d=>d.id),['s1','s2']);
assert.equal(groups.trashedSheetsForProject(restored.projects[0]).length,0);
assert.throws(()=>groups.restoreSheetInWorkspace(restored,'p1','s2',301),/ありません/);

// A whole drawing number is reversible; other groups are unmodified.
const groupTrash=groups.trashGroupInWorkspace(restored,'p1','g1',400);
assert.deepEqual(groups.groupsForProject(groupTrash.projects[0]).map(g=>g.id),['g2']);
assert.deepEqual(groups.trashedSheetsForProject(groupTrash.projects[0]).map(d=>d.id),['s1','s2']);
assert.equal(sheet(groupTrash,'s3').deletedAt,undefined);
assert.equal(sheet(groupTrash,'s3').name,'立面図');
assert.throws(()=>groups.trashGroupInWorkspace(groupTrash,'p1','g1',401),/見つかりません/);
const back=groups.restoreSheetInWorkspace(groupTrash,'p1','s1',500);
assert.deepEqual(groups.groupsForProject(back.projects[0]).map(g=>g.id),['g1','g2']);
assert.deepEqual(groups.groupsForProject(back.projects[0]).find(g=>g.id==='g1').sheets.map(d=>d.id),['s1']);
assert.equal(sheet(back,'s2').deletedAt,400);

// The existing order control must work while sheets/groups are in trash.
const orderGroups=order.reorderGroups(groupTrash,'p1',['g2'],550);
assert.equal(sheet(orderGroups,'s3').groupOrder,1);
assert.equal(sheet(orderGroups,'s1').groupOrder,undefined,'trashed groups are not reordered');
const orderSheets=order.reorderSheets(trashed,'p1','g1',['s1'],560);
assert.equal(sheet(orderSheets,'s1').sheetOrder,1);
assert.equal(sheet(orderSheets,'s2').sheetOrder,2,'trashed sheet retains its sort index');

// A cloud JSON snapshot can transport the tombstone without losing the original entry.
const snapshot=JSON.parse(JSON.stringify({project:trashed.projects[0],drawings:[
  {meta:sheet(trashed,'s1'),state:{shapes:[{id:'damage1',photos:[{id:'photo1'}]}]}},
  {meta:sheet(trashed,'s2'),state:{shapes:[{id:'damage2',photos:[{id:'photo2'}]}]}},
  {meta:sheet(trashed,'s3'),state:{shapes:[]}}
]}));
assert.equal(snapshot.project.drawings.length,3);
assert.equal(snapshot.drawings[1].meta.deletedAt,200);
assert.equal(snapshot.drawings[1].state.shapes[0].photos[0].id,'photo2');

// Regression: the UI no longer invokes the legacy permanent-deletion operation.
const source=fs.readFileSync(path.join(root,'sentlog/drawing-groups.js'),'utf8');
assert.match(source,/sheet-nav-edit/);
assert.match(source,/root\.SentlogDrawingGroups=\{[^\n]*renameSheet,trashSheet,restoreSheet/);
assert.match(source,/writes:\[\[WORKSPACE_KEY,JSON\.stringify\(next\)\]\],deleteFiles:\[\]/);
const deleteBody=source.slice(source.indexOf('async function deleteGroup('),source.indexOf('function actionButton('));
assert.doesNotMatch(deleteBody,/removeGroupFromWorkspace|deleteFiles|drawingStorageKey/);
const header=fs.readFileSync(path.join(root,'sentlog/drawing-list-header.js'),'utf8');
assert.match(header,/sentlogSheetTrashOpen/);
const exporter=fs.readFileSync(path.join(root,'sentlog/drawing-export.js'),'utf8');
assert.match(exporter,/project\.drawings\.filter\(d=>!\(Number\(d\.deletedAt\)>0\)/);
console.log('PASS reversible sheet rename/trash/restore, group trash, offline data retention and ordering');

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const g=require(path.join(root,'sentlog/drawing-groups.js'));

const legacy={projects:[{id:'p1',name:'案件',drawings:[
  {id:'d1',name:'図面No.1',createdAt:1,updatedAt:2},
  {id:'d2',name:'図面No.2',createdAt:3,updatedAt:4}
]}]};
const n=g.normalizeWorkspace(legacy);
assert.equal(n.changed,true);
assert.equal(n.workspace.projects[0].drawings[0].groupId,'d1');
assert.equal(n.workspace.projects[0].drawings[0].groupName,'図面No.1');
assert.equal(n.workspace.projects[0].drawings[0].sheetName,'図面No.1');
assert.equal(legacy.projects[0].drawings[0].groupId,undefined,'legacy source is not mutated');

const project={id:'p1',drawings:[
  {id:'s1',name:'平面図',sheetName:'平面図',groupId:'g1',groupName:'図面No.1',sheetOrder:1,createdAt:1,updatedAt:5,shapeCount:2,photoCount:3},
  {id:'s2',name:'下流面',sheetName:'下流面',groupId:'g1',groupName:'図面No.1',sheetOrder:2,createdAt:2,updatedAt:7,shapeCount:4,photoCount:1},
  {id:'s3',name:'断面図',sheetName:'断面図',groupId:'g2',groupName:'図面No.2',sheetOrder:1,createdAt:3,updatedAt:6}
]};
const groups=g.groupsForProject(project);
assert.equal(groups.length,2);
assert.deepEqual(groups.find(x=>x.id==='g1').sheets.map(x=>x.id),['s1','s2']);
assert.equal(groups.find(x=>x.id==='g1').name,'図面No.1');
assert.equal(g.nextSheetOrder(project,'g1'),3);

const renamed=g.renameGroupInWorkspace({projects:[project]},'p1','g1','No.1 改',20);
assert.deepEqual(renamed.projects[0].drawings.filter(d=>d.groupId==='g1').map(d=>d.groupName),['No.1 改','No.1 改']);
assert.deepEqual(renamed.projects[0].drawings.filter(d=>d.groupId==='g1').map(d=>d.sheetName),['平面図','下流面']);
const removed=g.removeGroupFromWorkspace({projects:[project]},'p1','g1',21);
assert.deepEqual(removed.projects[0].drawings.map(d=>d.id),['s3']);

const files=[
 {key:'background:s1',value:new Blob(['a'])},{key:'photo:s1:p1',value:new Blob(['b'])},
 {key:'background:s2',value:new Blob(['cc'])},{key:'photo:s3:p3',value:new Blob(['ddd'])}
];
assert.deepEqual(g.filesForDrawingIds(files,['s1','s2']).map(x=>x.key),['background:s1','photo:s1:p1','background:s2']);

const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
assert.match(index,/drawing-groups\.js\?v=171/);
assert.match(index,/SentlogDrawingGroups/);
assert.match(index,/phone-runtime\.js\?v=171/);
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');
assert.match(sw,/sentlog-pwa-v182/);
assert.match(sw,/drawing-groups\.js/);
const source=fs.readFileSync(path.join(root,'sentlog/drawing-groups.js'),'utf8');
assert.match(source,/＋ この図面No\.に追加/);
assert.match(source,/＋ 新しい図面No\./);
assert.match(source,/この図面No\.内のシート名/);
assert.match(source,/図面No\.名を入力してください/);
assert.match(source,/このシートを差し替え/);
console.log('PASS drawing groups: legacy-safe one-sheet migration, grouped cards, nested sheet creation and group delete/rename helpers');

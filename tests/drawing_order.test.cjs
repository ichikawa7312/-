'use strict';
const assert=require('node:assert/strict');
const Order=require('../sentlog/drawing-order.js');
const Groups=require('../sentlog/drawing-groups.js');
const Merge=require('../sentlog/sync-merge.js');
const clone=x=>JSON.parse(JSON.stringify(x));

const names=['13-4_管理棟_屋根','13-3_管理棟_底版','13-2_管理棟_南側内壁','13-1_管理棟_西側外壁','12_放流工','11_護岸工','10_水位計ピット','09_沈砂池','08_魚道','07_サイホンマンホール','06_サイホン工','05_堰柱','04_取水口','03_護床工','02_堰堤','01_上流護岸','00_全景'];
const make=(name,i,id)=>{
 const meta={id,name,groupId:id,groupName:name,sheetName:name,sheetOrder:1,sourceType:null,fileName:'',updatedAt:1000+i,createdAt:1000+i};
 const state={sourceType:null,fileName:'',shapes:[{id:'shape-'+id,type:'ひび割れ',kind:'polyline',points:[{x:1,y:2},{x:3,y:4}],memo:'保持する記録',photos:[{id:'photo-'+id,name:'現場写真.jpg'}]}],pageSettings:{},pageRotations:{}};
 return {meta,state};
};
const items=names.map((n,i)=>make(n,i,'group-'+i));
const p={id:'u',name:'上田農水頭首工',updatedAt:1200,drawings:items.map(v=>clone(v.meta))};
const ws={projects:[p,{id:'other',drawings:[]}]};
const original=JSON.stringify(ws);
const asGroups=Groups.groupsForProject(p).sort((a,b)=>b.updatedAt-a.updatedAt);
assert.deepEqual(Order.orderGroups(asGroups).map(g=>g.name),names.slice().reverse(),'no manual order retains the existing latest-updated display');
const numbered=Order.byNumber(asGroups),namesSorted=numbered.map(g=>g.name);
assert(namesSorted[0].startsWith('00_')&&namesSorted.at(-1).startsWith('13-4'),'numeric sort handles leading zeros and hyphenated names');
assert.deepEqual(namesSorted.filter(x=>x.startsWith('13-')),['13-1_管理棟_西側外壁','13-2_管理棟_南側内壁','13-3_管理棟_底版','13-4_管理棟_屋根']);
const ids=numbered.map(x=>x.id);
const reordered=Order.reorderGroups(ws,'u',ids,9999);
assert.equal(JSON.stringify(ws),original,'pure reorder never mutates original local record');
assert.equal(reordered.projects[1].id,'other','another project remains untouched');
assert.deepEqual(reordered.projects[0].drawings.map(d=>d.id),p.drawings.map(d=>d.id),'drawing IDs and original list structure remain intact');
assert(reordered.projects[0].drawings.every(d=>d.groupOrder===ids.indexOf(d.groupId)+1));
assert.deepEqual(Order.orderGroups(Groups.groupsForProject(reordered.projects[0])).map(g=>g.name),namesSorted);
assert.equal(JSON.stringify(items),JSON.stringify(names.map((n,i)=>make(n,i,'group-'+i))),'separate drawing states and photos were untouched');
assert.throws(()=>Order.reorderGroups(ws,'u',ids.slice(1)),/順/);
assert.throws(()=>Order.reorderGroups(ws,'u',[ids[0],...ids.slice(0,-1)]),/順/);
assert.throws(()=>Order.reorderGroups(ws,'u',[...ids.slice(0,-1),'missing']),/順/);
// A newly added drawing should appear after the manually ordered groups without silently changing existing rank.
const extra={...make('14_追加図面',99,'new').meta};
const expanded=clone(reordered);expanded.projects[0].drawings.push(extra);
const expandedGroups=Groups.groupsForProject(expanded.projects[0]).sort((a,b)=>b.updatedAt-a.updatedAt);
assert.equal(Order.orderGroups(expandedGroups).at(-1).id,'new');
// Order metadata is ordinary shared drawing metadata. An independent annotation edit
// on the other device can be merged without losing any source record.
const basePack={project:clone(p),drawings:items.map(x=>clone(x))};
const localPack=clone(basePack);
localPack.drawings[5].state.shapes.push({id:'iphone-added',type:'漏水',kind:'polyline',points:[{x:7,y:8}],photos:[]});
const remotePack=clone(basePack);
remotePack.project=clone(reordered.projects[0]);
remotePack.drawings.forEach(d=>{d.meta=remotePack.project.drawings.find(x=>x.id===d.meta.id);});
const merged=Merge.merge(localPack,remotePack,{base:basePack});
assert(merged.ok,JSON.stringify(merged.conflicts));
assert(merged.payload.drawings[5].state.shapes.some(s=>s.id==='iphone-added'));
assert(merged.payload.project.drawings.every(d=>d.groupOrder===ids.indexOf(d.groupId)+1));
const different=clone(basePack);
different.project=Order.reorderGroups(ws,'u',[...ids].reverse(),30000).projects[0];
different.drawings.forEach(d=>{d.meta=different.project.drawings.find(x=>x.id===d.meta.id);});
assert(!Merge.merge(different,remotePack,{base:basePack}).ok,'two independent conflicting reorder operations remain protected');
// Moving sheets only changes sheetOrder; never the drawing ID, underlying PDF or shapes.
const withSheets=clone(ws);
withSheets.projects[0].drawings.push({...withSheets.projects[0].drawings[0],id:'second-sheet',name:'予備図面',sheetName:'予備図面',sheetOrder:2});
const sheetOrder=Order.reorderSheets(withSheets,'u','group-0',['second-sheet','group-0'],5432);
assert.equal(sheetOrder.projects[0].drawings[0].sheetOrder,2);
assert.equal(sheetOrder.projects[0].drawings.at(-1).sheetOrder,1);
assert.equal(sheetOrder.projects[0].drawings[1].sheetOrder,1);
assert.deepEqual(Groups.groupsForProject(sheetOrder.projects[0]).find(g=>g.id==='group-0').sheets.map(d=>d.id),['second-sheet','group-0']);
assert.throws(()=>Order.reorderSheets(ws,'u','group-0',['group-0','fake']),/順/);
// Modern browser entry points still use a compare-and-swap transaction; don't use localStorage writes for reordering.
const code=require('node:fs').readFileSync(__dirname+'/../sentlog/drawing-order.js','utf8');
assert(code.includes('S.archiveAtomic({writes:[[KEY,JSON.stringify(next)]],deleteFiles:[],expectedWorkspace:raw})'));
assert(code.includes("handle.addEventListener('pointerdown'"));
assert(code.includes("card.addEventListener('dragstart'"));
console.log('PASS drawing order: 17 No. natural sort, manual reorder, non-destructive group/sheet saves, new group append, safe merge and conflict protection');

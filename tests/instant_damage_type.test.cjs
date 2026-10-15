'use strict';
// Exercise the ACTUAL drawing category-change handler, original numbering logic,
// and undo/redo logic with synthetic data. Never access production files/cloud.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync('sentlog/part09.txt','utf8');
const editor=fs.readFileSync('sentlog/part04.txt','utf8');
const shared=fs.readFileSync('sentlog/part08.txt','utf8');
const section=(source,from,to)=>{
 const a=source.indexOf(from),b=source.indexOf(to,a+from.length);
 assert(a>=0&&b>a,from+' must be uniquely extractable');return source.slice(a,b);
};
const damageFns=section(code,'function rebuildNumberingState(){','function shapeAnchorPoint(s){');
const onchange=section(code,"$('applyBtn').onclick=()=>{","$('deleteBtn').onclick");
const autoLabelFns=section(shared,'function circledNo(n){','function formatGlobalNo(n){');
const historyFns=section(editor,'function cloneShapes(v){','const NS=');
const initial=[
 {id:'s1',kind:'freehand-line',page:1,type:'ひび割れ',typeNo:1,globalNo:1,strokeWidth:0.8,
  points:[{x:1,y:2},{x:10,y:12}],labelPos:{x:17,y:22},photos:[{id:'photo-a'}],no:'N1',memo:'original'},
 {id:'s2',kind:'polygon',page:2,type:'浮き',typeNo:1,globalNo:2,strokeWidth:1.2,
  points:[{x:2,y:2},{x:4,y:8},{x:6,y:2}],photos:[{id:'photo-b'}]},
 {id:'s3',kind:'line',page:1,type:'ひび割れ',typeNo:2,globalNo:3,strokeWidth:0.8,
  points:[{x:30,y:35},{x:50,y:60}],photos:[]},
 {id:'s4',kind:'rect',page:1,type:'浮き',typeNo:2,globalNo:4,strokeWidth:1.6,
  x:55,y:65,w:20,h:30,photos:[{id:'photo-c'}]}
];
const deepcopy=x=>JSON.parse(JSON.stringify(x));
const entries=['damageType','typeNo','damageNo','member','memo','lineWidth','globalNo']
 .map(k=>[k,{value:''}]);
const fields=Object.fromEntries(entries);
fields.damageType.value='ひび割れ';
fields.typeNo.value='ひび割れ①';
fields.damageNo.value='unedited draft';
fields.member.value='steel member pending apply';
fields.memo.value='draft memo pending apply';
fields.lineWidth.value='0.8';
const state={currentPage:1,shapes:deepcopy(initial),nextGlobalNo:5,typeCounters:{}};
let selected='s1',saves=0,renders=0,historyUpdates=0;
const ctx={
 console,state,selected,currentView:'editor',Math,JSON,Number,pageHistory:{},
 $:k=>fields[k],cloneShapes:deepcopy,
 updateHistoryButtons:()=>{historyUpdates++},
 setSelectionControls:()=>{},updateMeasureResult:()=>{},
 render:()=>{renders++},
 persist:()=>{saves++},
 selectShape:id=>{selected=id;ctx.selected=id;fields.damageType.value=state.shapes.find(s=>s.id===id).type},
};
ctx.window=ctx;
vm.createContext(ctx);
vm.runInContext(autoLabelFns+damageFns+historyFns+onchange,ctx);
ctx.rebuildNumberingState();
const original=deepcopy(state.shapes);
const typesBefore=state.shapes.map(s=>s.autoLabel);
assert.deepEqual(typesBefore,['ひび割れ①','浮き①','ひび割れ②','浮き②']);
assert.equal(typeof fields.damageType.onchange,'function');
const photosBefore=state.shapes.map(s=>JSON.stringify(s.photos));
fields.damageType.value='浮き';
fields.damageType.onchange();
assert.deepEqual(state.shapes.map(s=>s.autoLabel),['浮き①','浮き②','ひび割れ①','浮き③'],
 'all category numbers must update instantly across different PDF pages');
assert.equal(fields.typeNo.value,'浮き①','selected damage number must update immediately');
assert.equal(saves,1,'a category select triggers save without Apply button');
assert.equal(renders,1,'a category select redraws immediately');
assert.equal(ctx.historyFor().undo.length,1,'one option change makes one undo frame');
assert.deepEqual(state.shapes.map(s=>JSON.stringify(s.photos)),photosBefore);
assert.equal(JSON.stringify(state.shapes[0].points),JSON.stringify(original[0].points));
assert.equal(JSON.stringify(state.shapes[0].labelPos),JSON.stringify(original[0].labelPos));
assert.deepEqual(state.shapes.map(s=>s.id),original.map(s=>s.id),'stable IDs and page order');
for(const [key,value] of Object.entries({damageNo:'unedited draft',member:'steel member pending apply',memo:'draft memo pending apply'}))
 assert.equal(fields[key].value,value,'category change must not erase unsaved '+key);
fields.damageType.onchange();
assert.equal(saves,1,'selecting the same category must not generate saves or undo');
assert.equal(ctx.historyFor().undo.length,1);
ctx.undo();
assert.deepEqual(state.shapes,original,'Undo restores all categories, page order and numbering');
assert.equal(ctx.historyFor().redo.length,1);
ctx.redo();
assert.deepEqual(state.shapes.map(s=>s.autoLabel),['浮き①','浮き②','ひび割れ①','浮き③'],
 'Redo applies instant reclassification again');
assert.deepEqual(state.shapes.map(s=>s.id),original.map(s=>s.id),'Redo preserves IDs');
assert.deepEqual(state.shapes.map(s=>s.page),original.map(s=>s.page),'Redo preserves cross-page order');
const priorSaveCount=saves;
ctx.selected=null;fields.damageType.value='漏水';fields.damageType.onchange();
assert.equal(saves,priorSaveCount,'without selected damage, dropdown only sets new-drawing default');
assert.deepEqual(state.shapes.map(s=>s.autoLabel),['浮き①','浮き②','ひび割れ①','浮き③']);
ctx.selected='s1';ctx.currentView='projects';fields.damageType.value='ひび割れ';fields.damageType.onchange();
assert.equal(saves,priorSaveCount,'do not modify a hidden drawing from project overview');
ctx.currentView='editor';state.currentPage=2;fields.damageType.onchange();
assert.equal(saves,priorSaveCount,'do not modify selected damage from another page');
console.log('PASS v1.45 instant reclassification: no Apply, global cross-page numbering, stable geometry/photos/IDs/unsaved fields, one undo/redo, no-op guards');

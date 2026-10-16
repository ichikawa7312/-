'use strict';
// Actual pure formatting and numbering routines; synthetic immutable fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('sentlog/part08.txt','utf8');
const from=src.indexOf('function formatTypeNo(n){'),to=src.indexOf('function formatGlobalNo(n){');
assert(from>=0&&to>from);const code=src.slice(from,to),ctx={};vm.createContext(ctx);vm.runInContext(code,ctx);
assert(!/\b(?:persist|rebuildNumberingState|assignNumbers|setItem)\s*\(/.test(code));
assert(!src.includes('function circledNo('));
for(const n of [1,9,10,20,21,35,36,49,50,51,99,100,128,999,1000,10000,Number.MAX_SAFE_INTEGER]){
 const s=Object.freeze({id:'same-id',type:'腐食',typeNo:n,globalNo:n+1,autoLabel:n===50?'腐食㊿':`腐食(${n})`,no:'任意-①',photos:Object.freeze([{id:'photo-unchanged'}])});
 const before=JSON.stringify(s);assert.equal(ctx.autoLabelFor(s),'腐食-'+n);assert.equal(JSON.stringify(s),before);
 assert.equal(ctx.formatTypeNo(String(n)),String(n));
}
for(const n of [undefined,null,'',0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'①','abc',{},[],true])assert.equal(ctx.formatTypeNo(n),'');
assert.equal(ctx.autoLabelFor(null),'');
assert.equal(ctx.autoLabelFor({autoLabel:'既存の任意表記①'}),'既存の任意表記①');
assert.equal(ctx.autoLabelFor({no:'G1-FU'}),'G1-FU');
assert.equal(ctx.autoLabelFor({type:'補修①-再剥離',typeNo:'001'}),'補修①-再剥離-1','Never rewrite the name or arbitrary symbol');
assert.equal(ctx.autoLabelFor({type:'ひびわれ',typeNo:21}),'ひびわれ-21','Do not canonicalize names');
assert.equal(ctx.autoLabelFor({typeNo:3}),'変状-3');
const core=fs.readFileSync('sentlog/part09.txt','utf8');
const numbering=core.slice(core.indexOf('function rebuildNumberingState(){'),core.indexOf('function shapeAnchorPoint(s){'));
ctx.state={shapes:[],typeCounters:{},nextGlobalNo:1};vm.runInContext(numbering,ctx);
for(let i=1;i<=1001;i++){
 const s={id:'s'+i,type:'腐食',page:i%2+1,points:[{x:i,y:1}],photos:[{id:'p'+i}]};ctx.assignNumbers(s);ctx.state.shapes.push(s);
 assert.equal(s.typeNo,i);assert.equal(s.globalNo,i);assert.equal(s.autoLabel,'腐食-'+i);
}
const numeric=JSON.stringify(ctx.state.shapes.map(({id,typeNo,globalNo,page,points,photos})=>({id,typeNo,globalNo,page,points,photos})));
ctx.rebuildNumberingState();assert.equal(JSON.stringify(ctx.state.shapes.map(({id,typeNo,globalNo,page,points,photos})=>({id,typeNo,globalNo,page,points,photos}))),numeric);
assert.equal(ctx.state.typeCounters['腐食'],1001);assert.equal(ctx.state.nextGlobalNo,1002);
const s={id:'water',type:'漏水'};ctx.assignNumbers(s);assert.equal(s.typeNo,1);assert.equal(s.globalNo,1002);assert.equal(s.autoLabel,'漏水-1');
assert(core.includes('const label=autoLabelFor(s);'));
for(const file of ['inspector-interaction.js','label-settings.js','damage-catalog.js'])assert(fs.readFileSync('sentlog/'+file,'utf8').includes('autoLabelFor('));
const loader=fs.readFileSync('sentlog/index.html','utf8');
for(const token of ['function formatTypeNo(n){','const label=autoLabelFor(s);','inspector-interaction.js?v=155','label-settings.js?v=155','damage-catalog.js?v=155',"'v1.55'"])assert(loader.includes(token));
assert(fs.readFileSync('sentlog/sw.js','utf8').includes('sentlog-pwa-v166'));
console.log('PASS v1.55: 1–1001 numbering and 50/51/99/100/999/1000 boundaries, no padding/circles, immutable numeric/photo IDs, stale cache display, unchanged custom names and invalid-field fallback');

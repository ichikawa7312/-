'use strict';
// Synthetic data only; a missing damageNo mock catches obsolete dependencies.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const read=p=>fs.readFileSync(p,'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const parts=Array.from({length:9},(_,i)=>read('sentlog/part0'+(i+1)+'.txt')),html=parts.join('');
assert.ok(!html.includes('id="damageNo"'));
assert.ok(!html.includes('任意記号（必要時）'));
assert.match(html, /id="typeNo"[^>]*><\/div>\s*<!--[\s\S]*?-->\s*<div><label>部材<\/label>/);
for(const name of fs.readdirSync('sentlog').filter(p=>/\.(js|txt)$/.test(p))) {
 assert.ok(!read('sentlog/'+name).includes('damageNo'),name+': no runtime references to removed input');
}
const section=(source,from,to)=>{
 const a=source.indexOf(from),b=source.indexOf(to,a+from.length);
 assert.ok(a>=0&&b>a,from);return source.slice(a,b);
};
const numbering=section(parts[8],'function rebuildNumberingState(){','function shapeAnchorPoint(s){');
assert.equal(sha(numbering),'7e829b478d913a04321b319a9879ea3b373adcc5df0f5bb2472580ce1a9bd530');
assert.equal(sha(parts[5]),'b9ead633058149a8d06251e16423df2ff70bb9721ccbee74f71dea9864e028cf');
assert.equal(sha(read('sentlog/sync.js')),'017fa1aa7311ee6dce33c8c29a97ba1ffb458badbec7af9086108b2afa53a070');
const format=section(parts[7],'function formatTypeNo(n){','function formatGlobalNo(n){');
const apply=section(parts[8],"$('applyBtn').onclick=()=>{","// A change of damage category");
const add=section(parts[8],'function addShape(s){','\n');
const makeRecord=(id,no)=>({id,type:'腐食',typeNo:1,globalNo:1,page:1,kind:'rect',x:10,y:20,w:30,h:40,
 labelPos:{x:60,y:70},member:'before',memo:'before',strokeWidth:1.2,photos:[{id:'old-photo'}],...(no===undefined?{}:{no})});
for(const no of ['G1-① / A-3','',undefined,null]) {
 const s=makeRecord('legacy',no),original=JSON.parse(JSON.stringify(s));
 const fields={applyBtn:{},damageType:{value:'腐食'},member:{value:'G1 上フランジ'},memo:{value:'既往図面のA-3に対応'},lineWidth:{value:'1.6'}};
 const state={shapes:[s],typeCounters:{},currentPage:1};
 let history=0,saves=0;
 const ctx={state,selected:s.id,$:k=>fields[k],pushHistory:()=>history++,persist:()=>saves++,selectShape:()=>{},crypto:{randomUUID:()=> 'new-id'},console};
 vm.createContext(ctx);vm.runInContext(format+numbering+apply+add,ctx);
 fields.applyBtn.onclick();
 assert.equal(s.no,original.no);assert.equal(Object.hasOwn(s,'no'),Object.hasOwn(original,'no'));
 for(const key of ['id','page','kind','x','y','w','h','labelPos','photos'])assert.deepEqual(s[key],original[key]);
 assert.equal(s.memo,fields.memo.value);assert.equal(s.member,fields.member.value);assert.equal(history,1);assert.equal(saves,1);
 fields.damageType.value='漏水';fields.applyBtn.onclick();assert.equal(s.type,'漏水');assert.equal(s.no,original.no);
 ctx.addShape({kind:'line',points:[{x:1,y:1},{x:4,y:7}],no:'must-not-inherit'});
 assert.equal(state.shapes.at(-1).no,'');assert.equal(state.shapes[0].no,original.no);
 assert.equal(state.shapes.at(-1).autoLabel,'漏水-2');
}
// Retain the compatibility fallback for records with no numeric type number.
const pure={};vm.createContext(pure);vm.runInContext(format,pure);
assert.equal(pure.autoLabelFor({no:'旧記号①'}),'旧記号①');
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
new vm.Script(read('sentlog/inspector-interaction.js'));new vm.Script(read('sentlog/sync-view.js'));
const loader=read('sentlog/index.html');
for(const token of ['no-optional-symbol-v157','no-symbol-editor-v157','no-symbol-inspector-v157','no-symbol-draft-guard-v157',"'v1.57'",'inspector-interaction.js?v=157','sync-view.js?v=157'])assert.ok(loader.includes(token));
assert.ok(read('sentlog/sw.js').includes('sentlog-pwa-v168'));
console.log('PASS v1.57: optional symbol UI removed, old symbols preserved on Apply/reclassification, no inheritance, formatter/numbering/photo/sync compatibility, syntax and version gates');

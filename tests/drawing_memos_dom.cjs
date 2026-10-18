// DOM integration check. Run with linkedom@0.18.12 on NODE_PATH; no browser or user API access.
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const ROOT=require('path').resolve(__dirname,'..');
const html=Array.from({length:9},(_,i)=>fs.readFileSync(`${ROOT}/sentlog/part0${i+1}.txt`,'utf8')).join('');
const {window:dom,document}=parseHTML(html);
const context2d={clearRect(){},fillRect(){},drawImage(){},setTransform(){},save(){},restore(){},measureText(t){return {width:String(t).length*12}}};
dom.HTMLCanvasElement.prototype.getContext=()=>context2d;
dom.Element.prototype.getBoundingClientRect=function(){return {x:0,y:0,left:0,top:0,right:1000,bottom:700,width:1000,height:700}};
dom.Element.prototype.getClientRects=function(){return [this.getBoundingClientRect()]};
dom.Element.prototype.setPointerCapture=function(){};dom.Element.prototype.releasePointerCapture=function(){};dom.Element.prototype.hasPointerCapture=function(){return true};
const originalValue=Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype,'value');
Object.defineProperty(dom.HTMLSelectElement.prototype,'value',{get(){return this._value??originalValue.get.call(this)},set(v){this._value=String(v)},configurable:true});
const records=new Map(),events=new Map();
const localStorage={getItem:k=>records.get('local:'+k)||null,setItem:(k,v)=>records.set('local:'+k,v),removeItem:k=>records.delete('local:'+k)};
const sandbox={document,console,Blob,URL,Uint8Array,TextEncoder,crypto:require('crypto').webcrypto,structuredClone,localStorage,
 navigator:{userAgent:'DOM integration test'},location:{protocol:'file:',search:'',href:'https://example.invalid/sentlog/'},innerWidth:1200,innerHeight:900,
 getComputedStyle:()=>({font:'12px sans-serif',columnGap:'4',gap:'4',paddingLeft:'8',paddingRight:'8'}),
 MutationObserver:class{observe(){}},ResizeObserver:class{observe(){}},performance,
 requestAnimationFrame:f=>setTimeout(f,0),cancelAnimationFrame:clearTimeout,setTimeout,clearTimeout,queueMicrotask,
 alert:m=>{throw Error('Unexpected alert: '+m)},confirm:()=>true,
 addEventListener:(type,f)=>{if(!events.has(type))events.set(type,[]);events.get(type).push(f)},
 SentlogRecords:{init:async()=>{},getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),batch:map=>{for(const[k,v]of map)records.set(k,v)},flush:async()=>{},settled:async()=>{},assertSafe:()=>{}},
};sandbox.window=sandbox;sandbox.globalThis=sandbox;
const c=vm.createContext(sandbox),run=code=>vm.runInContext(code,c);
const core=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function freshDrawingState'));
(async()=>{
run(core);await sandbox.sentlogAppReady;
for(const name of ['field-records.js','dimension-lines.js','shape-dimensions.js','toolbar-icons.js','drawing-memos.js','sync-view.js']){
 try{run(fs.readFileSync(`${ROOT}/sentlog/${name}`,'utf8'))}catch(e){e.message=name+': '+e.message;throw e}
}
run(`workspace={projects:[{id:'p',name:'synthetic',drawings:[{id:'d',name:'plan',updatedAt:1}],updatedAt:1}]};activeProjectId='p';activeDrawingId='d';state=freshDrawingState();state.sourceType='image';state.width=1000;state.height=700;state.shapes=[{id:'damage',kind:'line',page:1,type:'ひび割れ',points:[{x:20,y:20},{x:80,y:20}],photos:[]}];currentView='editor';scale=1;tx=0;ty=0;rebuildNumberingState();render();persist();`);
const api=sandbox.SentlogDrawingMemos,wrap=document.getElementById('stageWrap');
function evt(type,x,y,target=wrap){const e=new dom.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{pointerId:1,pointerType:'mouse',button:0,clientX:x,clientY:y});target.dispatchEvent(e);return e}
function drag(type,x=100,y=100,x2=240,y2=180){api.setMode('memo');api.activate('memo-'+type);evt('pointerdown',x,y);evt('pointermove',x2,y2);evt('pointerup',x2,y2)}
function notes(){return JSON.parse(run('JSON.stringify(state.shapes.filter(window.SentlogDrawingMemos.isMemo))'))}
function submit(){const f=document.querySelector('.sl-memo-panel');assert(f);f.onsubmit({preventDefault(){}})}
function close(){const b=[...document.querySelectorAll('.sl-memo-panel button')].find(b=>b.textContent==='閉じる');b?.onclick()}
for(const t of ['line','rect','ellipse','freehand'])drag(t);
assert.equal(notes().length,4);assert.equal(run('getDrawingMeta().shapeCount'),1);assert.equal(run('state.shapes[0].typeNo'),1);
drag('text',300,200,300,200);assert.equal(notes().length,4);document.querySelector('.sl-memo-panel textarea').value='上流側\n調査対象外';submit();assert.equal(notes().length,5);assert.equal(notes().at(-1).text,'上流側\n調査対象外');
const htmlText=document.getElementById('svg').innerHTML;assert(htmlText.includes('上流側'));assert(htmlText.includes('調査対象外'));
drag('dimension',100,300,300,300);assert.equal(notes().length,6);
const dim=notes().at(-1),before=JSON.stringify(dim.points);document.querySelector('.sl-memo-panel input[inputmode=decimal]').value='0.800 m';submit();assert.equal(notes().at(-1).manualText,'0.800 m');assert.equal(JSON.stringify(notes().at(-1).points),before);
run('undo()');assert.equal(notes().at(-1).manualText,'');run('redo()');assert.equal(notes().at(-1).manualText,'0.800 m');
api.setMode('damage');assert.equal(notes().length,6);assert.equal(document.querySelector('.sl-memo-tools').hidden,true);
api.setMode('memo');assert.equal(document.querySelector('.sl-memo-tools').hidden,false);
// Tapping a memo selects the memo without opening damage details.
let hit=document.querySelector('[data-memo-id="'+notes()[0].id+'"] polyline[pointer-events=stroke]');assert(hit);
evt('pointerdown',150,130,hit);evt('pointerup',150,130);assert.equal(api.selectedId,notes()[0].id);assert.equal(run('selected'),null);assert(!document.getElementById('inspector').classList.contains('open'));
document.getElementById('memoEditBtn').onclick();const dup=[...document.querySelectorAll('.sl-memo-panel button')].find(b=>b.textContent==='複製');assert(dup);dup.onclick();assert.equal(notes().length,7);
document.getElementById('memoEditBtn').onclick();[...document.querySelectorAll('.sl-memo-panel button')].find(b=>b.textContent==='削除').onclick();assert.equal(notes().length,6);run('undo()');assert.equal(notes().length,7);run('redo()');assert.equal(notes().length,6);
// A pinch/cancel must discard draft drawing and keep the history unchanged.
const count=notes().length,hist=run('historyFor().undo.length');api.activate('memo-freehand');evt('pointerdown',100,400);evt('pointermove',150,420);run('cancelPointerDraft()');evt('pointerup',150,420);assert.equal(notes().length,count);assert.equal(run('historyFor().undo.length'),hist);
api.activate('memo-rect');evt('pointerdown',100,400);evt('pointermove',150,420);evt('pointercancel',150,420);assert.equal(notes().length,count);
// Stored snapshot preserves all six tools; loading and another damage keep numbering isolated.
const stored=records.get('surveyFieldNoteDrawingV1:d');assert.equal(JSON.parse(stored).shapes.filter(api.isMemo).length,6);
run(`state=JSON.parse(window.SentlogRecords.getItem(drawingStorageKey('d')));rebuildNumberingState();render();`);
api.setMode('damage');run(`$('damageType').value='ひび割れ';addShape({kind:'line',points:[{x:20,y:40},{x:100,y:40}]});`);
assert.equal(run('state.shapes.at(-1).typeNo'),2);assert.equal(run('getDrawingMeta().shapeCount'),2);
// Reconcile recorded dimension when scale becomes available, retain it across scale changes.
run("state.pageSettings['1']={paperSize:'custom',customW:1000,customH:700,scaleDenom:1};");api.reconcileManualDimensions(1);
assert(Math.abs(notes().find(n=>api.isDimension(n)).points[1].x-900)<1e-8);assert.equal(api.dimensionText(notes().find(n=>api.isDimension(n))),'0.800 m');
run("state.pageSettings['1'].scaleDenom=2");api.reconcileManualDimensions(1);assert(Math.abs(notes().find(n=>api.isDimension(n)).points[1].x-500)<1e-8);
// View visibility never modifies the record, and excludes every note including dimensions.
const saved=run('JSON.stringify(state.shapes)');document.getElementById('memoVisibilityBtn').onclick();assert.equal(document.querySelectorAll('#svg [data-memo-id]').length,0);assert.equal(run('JSON.stringify(state.shapes)'),saved);document.getElementById('memoVisibilityBtn').onclick();assert(document.querySelectorAll('#svg [data-memo-id]').length>0);
// Page scope reset closes the edit form and keeps notes on their original page.
api.setMode('memo');document.getElementById('memoEditBtn').onclick();assert(api.isEditing());run('state.currentPage=2;render()');assert(!api.isEditing());assert.equal(document.querySelectorAll('#svg [data-memo-id]').length,0);
console.log('PASS DOM integration: actual core + modules; six tools, text edit, history, number isolation, save/reload, duplication/deletion, gesture cancellation, scale priority, visibility, page isolation.');
})().catch(e=>{console.error(e);process.exitCode=1});

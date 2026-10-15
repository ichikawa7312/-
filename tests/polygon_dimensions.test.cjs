'use strict';
// Actual v1.49 dimension module, no real project, photo or cloud access.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('sentlog/polygon-dimensions.js','utf8');
assert.doesNotThrow(()=>new vm.Script(source));
const listeners=[];
let nextId=0,sets=new Map(),removed=0,persists=0;
function el(tag,attrs={}){
 const handlers=new Map();
 return {tag,attrs,dataset:{},style:{},children:[],textContent:'',value:'',className:'',
  append(...xs){this.children.push(...xs)},
  appendChild(x){this.children.push(x)},setAttribute(k,v){this.attrs[k]=v},
  remove(){removed++;},
  focus(){},select(){},
  addEventListener(t,fn){const a=handlers.get(t)||[];a.push(fn);handlers.set(t,a)},
  emit(t,e){for(const fn of handlers.get(t)||[])fn(e)}
 };
}
const wrap=el('div'),svg={children:[],appendChild(x){this.children.push(x)}};
wrap.getBoundingClientRect=()=>({left:0,top:0,width:800,height:700});
let draft={kind:'polygon',points:[{x:100,y:100},{x:300,y:100},{x:300,y:260},{x:180,y:260}]};
const ctx={
 window:null,console,Math,Number,Object,Array,JSON,
 $:id=>id==='stageWrap'?wrap:null,svg,makeEl:el,
 currentView:'editor',tool:'polygon',drawing:draft,
 polygonDraftCursor:null,scale:1,tx:0,ty:0,
 state:{sourceType:'pdf',width:1200,height:800,currentPage:1,
  pageSettings:{'1':{scaleDenom:100,paperSize:'custom',customW:300,customH:200}},shapes:[]},
 activeDrawingId:'drawing-1',gestureLock:false,
 activeTouches:new Map(),
 pageScaleDenom:()=>100,
 getPaperMm:()=>({w:300,h:200}),
 lineLengthMm:points=>points.slice(1).reduce((a,q,i)=>{
   const p=points[i];return a+Math.hypot((q.x-p.x)*25,(q.y-p.y)*25);
 },0),
 polygonAligned:(a,b)=>{
  const dx=Math.abs(a.x-b.x),dy=Math.abs(a.y-b.y);
  return dx<1e-6||dy<1e-6||Math.abs(dx-dy)<1e-6;
 },
 polygonSegmentsCross:()=>false,
 render:()=>{svg.children=[]},
 renderPreview:()=>{svg.children=[]},
 commitPolygonVertex:p=>{ctx.drawing.points.push({...p});ctx.polygonDraftCursor=null;ctx.renderPreview()},
 document:{body:{appendChild(){}},hidden:false,
  createElement:el,
  addEventListener(t,fn){listeners.push({t,fn})}},
 addEventListener(t,fn){listeners.push({t,fn})},
 setTimeout(fn,ms){const id=++nextId;sets.set(id,{fn,ms});return id},
 clearTimeout(id){sets.delete(id)},
 persist(){persists++},
 innerWidth:390,innerHeight:700
};
ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
const api=ctx.SentlogPolygonDimensions;
assert(api,'dimension integration should expose testable API');
assert.equal(api.calibrated,true);
assert.equal(api.labelText(1.25),'1.25m');
assert.equal(api.labelText(.008),'0.008m');
assert.equal(api.labelText(1.235,true),'1.235m');
assert.equal(api.meters(draft.points[0],draft.points[1]),5,'scale = 0.025m per world point');
ctx.renderPreview();
let targets=svg.children.filter(e=>e.dataset.dimensionLengthTarget==='true');
assert.equal(targets.length,3,'each confirmed long side has a dimension hold target');
const captions=svg.children.filter(e=>e.tag==='text').map(e=>e.textContent);
assert(captions.includes('5.00m')&&captions.includes('4.00m')&&captions.includes('3.00m'),'metre labels on every confirmed edge');
const transforms=svg.children.filter(e=>e.tag==='text').map(e=>e.attrs.transform);
assert(transforms.some(v=>v.startsWith('rotate(0 ')),'horizontal dimension text parallel');
assert(transforms.some(v=>v.startsWith('rotate(90 ')),'vertical dimension text parallel');
const snapshot=JSON.stringify(ctx.drawing.points);
const makeEvent=(pointerId=5)=>({pointerId,pointerType:'touch',clientX:280,clientY:94,button:0,
 preventDefault(){},stopPropagation(){}});
targets[0].emit('pointerdown',makeEvent());
assert.equal(api.holding,true);
for(const h of listeners.filter(x=>x.t==='pointerup'))h.fn(makeEvent());
assert.equal(api.holding,false);
assert.equal(api.editing,false,'ordinary tap must NEVER open a dimension input');
assert.equal(JSON.stringify(ctx.drawing.points),snapshot,'ordinary tap never places a vertex');
assert.equal(persists,0,'draft editing never saves to cloud');
targets[0].emit('pointerdown',makeEvent());
assert.equal([...sets.values()].some(x=>x.ms===500),true,'requires about half-second hold');
[...sets.values()].forEach(({fn})=>fn());
assert.equal(api.editing,true,'long press opens floating input');
assert.equal(api.holding,false,'long press timer cleared');
const bad=api.resizeEdge(0,0);
assert(bad.error,'reject zero input');
assert(api.resizeEdge(0,-1).error,'reject negatives');
assert(api.resizeEdge(0,1000).error,'reject coordinates beyond drawing');
assert(api.resizeEdge(0,NaN).error,'reject NaN');
const changed=api.resizeEdge(0,6);
assert.equal(changed.points[1].x,340,'first edge grows from 5m to 6m, +40 world units');
assert.equal(changed.points[2].x,340,'subsequent vertices translated');
assert.equal(changed.points[3].x,220,'all downstream points translate together');
assert.equal(changed.points[0].x,100,'preceding vertices stay fixed');
assert.equal(changed.points[1].y,100);
assert.equal(changed.points[2].y,260,'later edges retain orientation and length');
assert.equal(api.meters(changed.points[0],changed.points[1]),6);
assert.equal(JSON.stringify(ctx.drawing.points),snapshot,'resize validation must not mutate before confirmation');
assert.equal(api.applyLength(0,6).ok,true);
assert.equal(api.meters(ctx.drawing.points[0],ctx.drawing.points[1]),6);
assert.equal(ctx.drawing.points[2].y,260);
assert.equal(persists,0,'only finished polygon is persisted');
ctx.renderPreview();
assert(svg.children.some(x=>x.tag==='text'&&x.textContent==='6m'),'explicit numeric metres visible on edited edge');
// Uncalibrated drawing: no fictional m values and no editable labels.
ctx.getPaperMm=()=>null;
ctx.renderPreview();
assert.equal(api.calibrated,false);
assert.equal(svg.children.filter(e=>e.dataset.dimensionLengthTarget==='true').length,0);
assert(wrap.children.some(e=>e.className==='sentlog-polygon-dimension-hint'));
assert.equal(api.resizeEdge(0,2).error.includes('縮尺'),true);
ctx.getPaperMm=()=>({w:300,h:200});
// Preview length can be specified before a vertex is placed: no bottom toolbar.
ctx.polygonDraftCursor={closing:false,valid:true,
 points:[ctx.drawing.points.at(-1),{x:ctx.drawing.points.at(-1).x,y:ctx.drawing.points.at(-1).y+80}]};
ctx.renderPreview();
targets=svg.children.filter(e=>e.dataset.dimensionLengthTarget==='true');
assert.equal(targets.length,4,'next preview edge gets an editable length alongside three confirmed sides');
assert(svg.children.some(x=>x.tag==='text'&&x.attrs.fill==='#1d4ed8'),'next segment length blue');
const oldLen=ctx.drawing.points.length;
const previewChange=api.resizeEdge(oldLen-1,3,true);
assert.equal(previewChange.error,undefined);
assert.equal(api.applyLength(oldLen-1,3,true).ok,true);
assert.equal(ctx.drawing.points.length,oldLen+1,'preview input commits one snapped vertex');
assert.equal(api.meters(ctx.drawing.points[oldLen-1],ctx.drawing.points[oldLen]),3);
assert.equal(persists,0,'partial draft stays local');
ctx.renderPreview();
assert(svg.children.some(x=>x.tag==='text'&&x.textContent==='3m'),'precise preview length shown after confirmation');
// Cancel/ignore when not a polygon or drawing scale is absent.
ctx.tool='freehand-area';ctx.drawing={kind:'freehand-area',points:[{x:1,y:2},{x:100,y:30}]};
ctx.renderPreview();
assert.equal(svg.children.filter(e=>e.dataset.dimensionLengthTarget==='true').length,0,'freehand untouched');
assert.equal(api.editing,false);
console.log('PASS polygon metres: parallel edge labels, preview length, 500ms hold vs tap, 0.001m input, geometry translation, zoom-independent scale, no uncalibrated/fake dimensions, no draft/cloud persistence');

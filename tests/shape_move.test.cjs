'use strict';
// Execute the real shape-move module with a deterministic PointerEvents + SVG
// harness. No network, real account, actual project or PC backup is touched.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('sentlog/shape-move.js','utf8');
assert.doesNotThrow(()=>new vm.Script(source),'shape move syntax');
function clone(x){return JSON.parse(JSON.stringify(x))}
function element(tag,attrs={}){
 const listeners=new Map();
 return {tag,attrs,children:[],dataset:{},style:{},attributes:{},
  setAttribute(k,v){this.attributes[k]=v;},appendChild(x){this.children.push(x);},
  addEventListener(k,fn,options={}){const a=listeners.get(k)||[];a.push({fn,options});listeners.set(k,a);},
  emit(k,e){for(const h of listeners.get(k)||[])h.fn(e);},get listeners(){return listeners;}};
}
function env(){
 const timers=new Map();let nextTimer=0,historyRenders=0,persists=0,presses=0;
 const wrap=element('div');
 wrap.getBoundingClientRect=()=>({left:0,top:0,width:800,height:600});
 wrap.setPointerCapture=()=>{};wrap.releasePointerCapture=()=>{};
 const svg={children:[],appendChild(e){this.children.push(e);}};
 const h={undo:[],redo:[]},touches=new Map();
 let shapes=[{id:'line',kind:'line',page:1,type:'ひび割れ',globalNo:3,
  typeNo:3,autoLabel:'ひび割れ③',strokeWidth:0.8,
  points:[{x:100,y:100},{x:130,y:130}],labelPos:{x:165,y:80},
  photos:[{id:'photo_1'}],memo:'original notes'}];
 const context={
  console,Math,Date,JSON,Number,Array,Promise,
  window:null,document:{hidden:false,addEventListener(){}},
  $:id=>id==='stageWrap'?wrap:null,svg,scale:1,tx:0,ty:0,
  state:{shapes,currentPage:1,sourceType:'pdf',width:1200,height:900},
  currentView:'editor',activeProjectId:'site-1',activeDrawingId:'drawing-1',
  selected:null,tool:'pan',panStart:null,labelDrag:null,drawing:null,gestureLock:false,
  activeTouches:touches,
  cloneShapes:clone,
  currentShapes:()=>context.state.shapes.filter(x=>(x.page||1)===context.state.currentPage),
  point:e=>({x:e.clientX/context.scale,y:e.clientY/context.scale}),
  makeEl:element,
  snapshotPage:()=>clone(context.currentShapes()),
  historyFor:()=>h,
  updateHistoryButtons:()=>{historyRenders++},
  persist:()=>{persists++},
  updateMeasureResult:()=>{},
  setTimeout:(fn)=>{const id=++nextTimer;timers.set(id,fn);return id},
  clearTimeout:id=>timers.delete(id),
  render:()=>{
   svg.children=[];
   for(const shape of context.currentShapes()){
    const hit=element('polyline',{damageHit:true,shapeId:shape.id});
    context.bindHitTarget(hit,shape.id);svg.appendChild(hit);
    const label=element('rect',{labelHit:true,shapeId:shape.id});
    context.bindLabelTarget(label,shape.id);svg.appendChild(label);
   }
  },
  selectShape:id=>{context.selected=id;context.render();},
  clearSelection:()=>{context.selected=null;context.render();},
  bindHitTarget:(hit,id)=>{
    hit.addEventListener('pointerdown',e=>{
      if(context.tool!=='pan')return;e.preventDefault();e.stopPropagation();
      context.selectShape(id);
    });
  },
  bindLabelTarget:(hit,id)=>{
    hit.addEventListener('pointerdown',e=>{
      if(context.tool!=='pan')return;e.preventDefault();e.stopPropagation();
      context.selectShape(id);
      context.labelDrag={id,pointerId:e.pointerId};
    });
  },
  finishPointer:(e,cancelled)=>{if(e.pointerType==='touch')touches.delete(e.pointerId);},
  cancelPointerDraft:()=>{context.panStart=null;context.labelDrag=null;context.drawing=null;}
 };
 context.window=context;
 context.addEventListener=()=>{};
 vm.createContext(context);vm.runInContext(source,context);
 function ev(x=100,y=100,id=1,pointerType='touch'){
  return {clientX:x,clientY:y,pointerId:id,pointerType,button:0,cancelable:true,
   prevented:false,stopped:false,preventDefault(){this.prevented=true},
   stopPropagation(){this.stopped=true},stopImmediatePropagation(){this.stopped=true}};
 }
 function step(ms=500){const due=[...timers.values()];timers.clear();if(ms>=500)due.forEach(fn=>fn());}
 function hit(id){
  return svg.children.find(e=>e.attrs.damageHit&&e.attrs.shapeId===id);
 }
 function handle(){return svg.children.find(e=>e.dataset.shapeMoveHandle==='true');}
 function pressShape(id,x=100,y=100,pid=1,kind='touch'){
  if(kind==='touch')touches.set(pid,{x,y});
  hit(id).emit('pointerdown',ev(x,y,pid,kind));
 }
 function release(pid=1,kind='touch',cancel=false){
  context.finishPointer(ev(100,100,pid,kind),cancel);
 }
 function arm(id='line',x=100,y=100,pid=1){
  pressShape(id,x,y,pid);
  assert.equal(context.SentlogShapeMove.isEditing(),true,'stationary touch waiting for long press');
  step(500);
  assert.equal(context.SentlogShapeMove.active,true,'500ms hold reveals move handle');
  release(pid);
  assert(handle(),'visible move handle');
 }
 function move(dx=30,dy=20,pid=2,pointerType='touch'){
  const btn=handle();assert(btn);
  const x=btn.attrs.cx*context.scale,y=btn.attrs.cy*context.scale;
  if(pointerType==='touch')touches.set(pid,{x,y});
  btn.emit('pointerdown',ev(x,y,pid,pointerType));
  assert.equal(context.SentlogShapeMove.dragging,true);
  assert.equal(context.SentlogShapeMove.isEditing(),true);
  wrap.emit('pointermove',ev(x+dx,y+dy,pid,pointerType));
  release(pid,pointerType);
  assert.equal(context.SentlogShapeMove.dragging,false);
 }
 return {context,ev,step,wrap,svg,h,hit,handle,arm,move,pressShape,release,
   get saves(){return persists},get historyUpdates(){return historyRenders},
   timers};
}
function expectPos(shape,before,dx,dy){
 if(before.points)for(let i=0;i<before.points.length;i++){
  assert.equal(shape.points[i].x,before.points[i].x+dx);
  assert.equal(shape.points[i].y,before.points[i].y+dy);
 }
 if(Number.isFinite(before.x))assert.equal(shape.x,before.x+dx);
 if(Number.isFinite(before.y))assert.equal(shape.y,before.y+dy);
 if(before.labelPos){
  assert.equal(shape.labelPos.x,before.labelPos.x+dx);
  assert.equal(shape.labelPos.y,before.labelPos.y+dy);
 }else assert.equal(Object.prototype.hasOwnProperty.call(shape,'labelPos'),false);
 assert.equal(JSON.stringify(shape.photos),JSON.stringify(before.photos));
 for(const attr of ['id','page','type','globalNo','typeNo','autoLabel','strokeWidth','memo','w','h'])
  if(before[attr]!==undefined)assert.equal(shape[attr],before[attr],attr+' unchanged');
}
{
 const t=env(),{context:c}=t;
 t.pressShape('line');
 assert.equal(c.selected,'line','ordinary tap selects the shape');
 assert.equal(t.handle(),undefined,'move cursor must not appear before hold');
 t.release();assert.equal(t.timers.size,0);
 t.step();assert(!c.SentlogShapeMove.active,'tap alone does not arm group move');
 t.arm();
 const before=clone(c.state.shapes[0]),preWrites=t.saves;
 t.move(30,20);
 expectPos(c.state.shapes[0],before,30,20);
 assert.equal(t.h.undo.length,1,'one move = exactly one undo frame');
 assert.equal(t.h.redo.length,0);assert.equal(t.saves,preWrites+1,'save only after releasing');
 assert.equal(JSON.stringify(t.h.undo[0]),JSON.stringify([before]),'undo contains exact pre-move snapshot');
 assert(t.handle(),'handle remains for consecutive adjustments');
 // Mimic the app undo and verify the original label+geometry are both recoverable.
 c.state.shapes=clone(t.h.undo.pop());c.selected=null;c.render();
 assert.equal(JSON.stringify(c.state.shapes[0]),JSON.stringify(before),'undo restores every coordinate');
 assert.equal(t.handle(),undefined,'cursor hidden on deselection');
}
{
 const t=env(),c=t.context;
 for(const kind of ['rect','polygon','freehand','freehand-line','freehand-area']){
  c.state.shapes=[{id:kind,page:1,kind,type:'浮き',globalNo:1,typeNo:1,
   autoLabel:'浮き①',strokeWidth:1.2,photos:[{id:'img-1'}],
   ...(kind==='rect'?{x:80,y:110,w:55,h:25}:{points:[{x:75,y:115},{x:120,y:135},{x:95,y:155}]})}];
  c.selected=null;c.render();
  t.arm(kind,90,120);
  const before=clone(c.state.shapes[0]),saves=t.saves,undo=t.h.undo.length;
  t.move(16,-12);
  expectPos(c.state.shapes[0],before,16,-12);
  assert.equal(t.h.undo.length,undo+1,kind+' one undo frame');
  assert.equal(t.saves,saves+1,kind+' only saved once');
  c.clearSelection();
 }
}
{
 const t=env(),c=t.context;
 // A shaky contact must cancel the half-second arm, not move the canvas shape.
 t.pressShape('line');
 t.wrap.emit('pointermove',t.ev(110,100));
 t.step();assert.equal(t.handle(),undefined);
 t.release();
 // Beginning a pinch after cursor-down restores exactly the original coordinates.
 t.arm();const before=clone(c.state.shapes[0]);
 const btn=t.handle();const x=btn.attrs.cx,y=btn.attrs.cy;
 c.activeTouches.set(2,{x,y});btn.emit('pointerdown',t.ev(x,y,2));
 t.wrap.emit('pointermove',t.ev(x+12,y+15,2));
 assert.notEqual(JSON.stringify(c.state.shapes[0]),JSON.stringify(before),'uncommitted preview changed');
 const old=t.h.undo.length,saves=t.saves;
 c.cancelPointerDraft();
 assert.equal(JSON.stringify(c.state.shapes[0]),JSON.stringify(before),'pinch cancels draft');
 assert.equal(t.h.undo.length,old,'no spurious undo on cancel');
 assert.equal(t.saves,saves,'no database save on cancel');
 assert.equal(t.handle(),undefined,'cursor removed by gesture cancellation');
 c.activeTouches.clear();
 // No data mutation on pointer cancel/lost contact either.
 t.arm();const btn2=t.handle(),px=btn2.attrs.cx,py=btn2.attrs.cy;
 c.activeTouches.set(3,{x:px,y:py});btn2.emit('pointerdown',t.ev(px,py,3));
 t.wrap.emit('pointermove',t.ev(px+10,py+15,3));
 t.release(3,'touch',true);
 assert.equal(JSON.stringify(c.state.shapes[0]),JSON.stringify(before));
}
{
 const t=env(),c=t.context;
 // Label-only hit target does not start the long press move gesture.
 const label=t.svg.children.find(e=>e.attrs.labelHit);
 label.emit('pointerdown',t.ev(165,80,10,'mouse'));
 assert.equal(c.labelDrag.id,'line');
 t.step();assert.equal(t.handle(),undefined);
 // One tap on blank canvas clears the entire cursor.
 c.labelDrag=null;
 t.arm();c.clearSelection();
 assert.equal(t.handle(),undefined);
 assert.equal(c.SentlogShapeMove.active,false);
}
{
 const t=env(),c=t.context;
 // Drawing tool and page changes must never leave an actionable cursor.
 t.arm();
 c.tool='line';c.render();
 assert.equal(t.handle(),undefined);assert(!c.SentlogShapeMove.active);
 c.tool='pan';t.arm();
 c.state.currentPage=2;c.render();
 assert.equal(t.handle(),undefined);assert(!c.SentlogShapeMove.active);
}
console.log('PASS shape move: 500ms hold+cross drag; line/rect/polygon/freehand geometry+label; photos/IDs preserved; one undo & save; label-only unaffected; tap/pinch/cancel/page/tool safe');

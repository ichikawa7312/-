/* セントログ v1.44 — Long-press a damage shape, then drag the cross-handle to
   translate the shape, its label and photo badge together. No new stored fields.
   Existing direct label dragging, panning, pinch zoom and the undo stack stay intact. */
(function(){
 'use strict';
 if(typeof render!=='function'||typeof bindHitTarget!=='function'||
    typeof finishPointer!=='function'||typeof snapshotPage!=='function')throw Error('図面移動機能の読み込み順序が正しくありません。');
 const wrap=$('stageWrap');
 const HOLD_MS=500, HOLD_SLOP=9, COMMIT_SLOP=2;
 let holding=null,ready=null,drag=null;

 function stopHolding(){
   if(holding?.timer)clearTimeout(holding.timer);
   holding=null;
 }
 function sourceShape(id){
   return state.shapes.find(s=>s.id===id && (s.page||1)===state.currentPage)||null;
 }
 function validReady(){
   return ready && tool==='pan' && currentView==='editor' &&
     ready.drawingId===activeDrawingId && ready.page===state.currentPage &&
     selected===ready.id && !!sourceShape(ready.id);
 }
 // Move only spatial coordinates. Photo IDs, number, type, memo and all
 // remaining shape metadata are deliberately left untouched.
 function setPosition(shape,original,dx,dy){
   if(Array.isArray(original.points))
     shape.points=original.points.map(p=>({...p,x:p.x+dx,y:p.y+dy}));
   if(Number.isFinite(original.x))shape.x=original.x+dx;
   if(Number.isFinite(original.y))shape.y=original.y+dy;
   if(original.labelPos)shape.labelPos={...original.labelPos,
     x:original.labelPos.x+dx,y:original.labelPos.y+dy};
   else delete shape.labelPos;
 }
 function stopDrag(commit){
   if(!drag)return;
   const d=drag;drag=null;
   const valid=currentView==='editor'&&activeDrawingId===d.drawingId&&
     state.currentPage===d.page&&sourceShape(d.id);
   if(!valid)return;
   const shape=sourceShape(d.id);
   const moved=commit && Math.hypot(d.dx,d.dy)*Math.max(scale,.001)>=COMMIT_SLOP;
   if(!moved){
     setPosition(shape,d.original,0,0);
     if(ready?.id===d.id)ready.anchor={...d.anchor};
   }else{
     const h=historyFor(d.page);
     h.undo.push(d.before);
     if(h.undo.length>80)h.undo.shift();
     h.redo=[];
     updateHistoryButtons();
     persist();
     updateMeasureResult();
   }
   render();
 }
 function dismiss(){
   const wasVisible=!!ready||!!drag;
   stopHolding();
   if(drag)stopDrag(false);
   ready=null;
   if(wasVisible&&currentView==='editor')render();
 }
 function chooseHandlePoint(){
   const z=Math.max(scale,.001),r=wrap.getBoundingClientRect();
   const at=ready.anchor;
   const sx=at.x*z+tx,sy=at.y*z+ty;
   const gap=42,margin=25;
   const offsets=[[gap,gap],[-gap,gap],[gap,-gap],[-gap,-gap],
     [gap,0],[-gap,0],[0,gap],[0,-gap]];
   let x=sx+gap,y=sy+gap;
   const found=offsets.find(([ox,oy])=>sx+ox>=margin &&
     sx+ox<=r.width-margin && sy+oy>=margin && sy+oy<=r.height-margin);
   if(found){x=sx+found[0];y=sy+found[1];}
   else{x=Math.max(margin,Math.min(r.width-margin,x));
     y=Math.max(margin,Math.min(r.height-margin,y));}
   return {x:(x-tx)/z,y:(y-ty)/z};
 }
 function drawHandle(){
   if(!validReady()){
     ready=null;
     return;
   }
   const pos=chooseHandlePoint(),z=Math.max(scale,.001),u=9/z,v=5/z;
   const ring=makeEl('circle',{cx:pos.x,cy:pos.y,r:16/z,
     fill:'#fff',stroke:'#2563eb','stroke-width':1.5/z});
   ring.style.pointerEvents='none';
   const arrows=makeEl('path',{d:[
     `M ${pos.x-u} ${pos.y} H ${pos.x+u}`,
     `M ${pos.x} ${pos.y-u} V ${pos.y+u}`,
     `M ${pos.x-u+v} ${pos.y-v/2} L ${pos.x-u} ${pos.y} L ${pos.x-u+v} ${pos.y+v/2}`,
     `M ${pos.x+u-v} ${pos.y-v/2} L ${pos.x+u} ${pos.y} L ${pos.x+u-v} ${pos.y+v/2}`,
     `M ${pos.x-v/2} ${pos.y-u+v} L ${pos.x} ${pos.y-u} L ${pos.x+v/2} ${pos.y-u+v}`,
     `M ${pos.x-v/2} ${pos.y+u-v} L ${pos.x} ${pos.y+u} L ${pos.x+v/2} ${pos.y+u-v}`
   ].join(' '),fill:'none',stroke:'#2563eb',
     'stroke-width':1.7/z,'stroke-linecap':'round','stroke-linejoin':'round'});
   arrows.style.pointerEvents='none';
   const handle=makeEl('circle',{cx:pos.x,cy:pos.y,r:24/z,
     fill:'rgba(37,99,235,0.002)','pointer-events':'all'});
   handle.dataset.shapeMoveHandle='true';
   handle.setAttribute('aria-label','選択した変状と名称をまとめて移動');
   handle.style.cursor='move';
   handle.style.touchAction='none';
   handle.addEventListener('pointerdown',event=>{
     if(!validReady()||gestureLock||activeTouches.size>1||
        (event.pointerType==='mouse'&&event.button!==0))return;
     const shape=sourceShape(ready.id);if(!shape)return;
     event.preventDefault();event.stopPropagation();
     stopHolding();
     const start=point(event);
     drag={id:shape.id,pointerId:event.pointerId,original:cloneShapes(shape),
       before:snapshotPage(),start,dx:0,dy:0,
       anchor:{...ready.anchor},page:state.currentPage,drawingId:activeDrawingId};
     panStart=null;
     try{wrap.setPointerCapture(event.pointerId)}catch{}
   });
   svg.appendChild(ring);svg.appendChild(arrows);svg.appendChild(handle);
 }
 const originalRender=render;
 render=function(){
   if(ready && !validReady())ready=null;
   const result=originalRender.apply(this,arguments);
   if(ready)drawHandle();
   return result;
 };
 const originalHit=bindHitTarget;
 bindHitTarget=function(hit,id){
   // The existing hit target is retained, so selection and its touch tolerance
   // behave exactly as before. A stationary primary press only arms the handle.
   originalHit.call(this,hit,id);
   hit.addEventListener('pointerdown',event=>{
     if(tool!=='pan'||gestureLock||activeTouches.size>1||
        (event.pointerType==='mouse'&&event.button!==0))return;
     stopHolding();
     const wasVisible=!!ready;
     ready=null;
     if(wasVisible)render();
     const request={id,pointerId:event.pointerId,
       x:event.clientX,y:event.clientY,anchor:point(event),
       page:state.currentPage,drawingId:activeDrawingId,timer:null};
     holding=request;
     request.timer=setTimeout(()=>{
       if(holding!==request)return;
       holding=null;
       if(tool!=='pan'||gestureLock||activeTouches.size>1||
          labelDrag||drawing||panStart||currentView!=='editor'||
          state.currentPage!==request.page||
          activeDrawingId!==request.drawingId||
          selected!==id||!sourceShape(id))return;
       ready={id,page:request.page,drawingId:request.drawingId,anchor:request.anchor};
       render();
     },HOLD_MS);
   });
 };
 const originalSelect=selectShape;
 selectShape=function(id){
   if(ready?.id!==id){ready=null;stopHolding();}
   return originalSelect.call(this,id);
 };
 const originalClear=clearSelection;
 clearSelection=function(){
   dismiss();
   return originalClear.apply(this,arguments);
 };
 const originalLabel=bindLabelTarget;
 bindLabelTarget=function(hit,id){
   originalLabel.call(this,hit,id);
   hit.addEventListener('pointerdown',event=>{
     if(tool==='pan'&&!gestureLock){
       ready=null;stopHolding();
       // The original name-only drag is unchanged, including its undo.
     }
   });
 };
 // This is called by the existing pinch recognizer, pagehide and blur paths.
 // Cancel a preview without changing the undo stack or persisting anything.
 const originalCancelDraft=cancelPointerDraft;
 cancelPointerDraft=function(){
   dismiss();
   return originalCancelDraft.apply(this,arguments);
 };
 const originalFinish=finishPointer;
 finishPointer=function(event,cancelled=false){
   if(holding?.pointerId===event.pointerId)stopHolding();
   if(drag?.pointerId===event.pointerId){
     if(event.pointerType==='touch')activeTouches.delete(event.pointerId);
     const canCommit=!cancelled&&!gestureLock&&activeTouches.size<=1;
     stopDrag(canCommit);
     if(event.pointerType==='touch'&&!activeTouches.size)gestureLock=false;
     try{wrap.releasePointerCapture(event.pointerId)}catch{}
     return;
   }
   return originalFinish.call(this,event,cancelled);
 };
 // These capture listeners run after the existing pinch guards. When the
 // second touch arrives, the pinch guard cancels the movement preview first.
 wrap.addEventListener('pointermove',event=>{
   if(holding?.pointerId===event.pointerId &&
      Math.hypot(event.clientX-holding.x,event.clientY-holding.y)>HOLD_SLOP)stopHolding();
   if(!drag||drag.pointerId!==event.pointerId)return;
   if(gestureLock||activeTouches.size>1){stopDrag(false);ready=null;return;}
   if(event.cancelable)event.preventDefault();
   event.stopImmediatePropagation();
   if(currentView!=='editor'||activeDrawingId!==drag.drawingId||
      state.currentPage!==drag.page){stopDrag(false);ready=null;return;}
   const shape=sourceShape(drag.id);
   if(!shape){stopDrag(false);ready=null;return;}
   const p=point(event);
   drag.dx=p.x-drag.start.x;drag.dy=p.y-drag.start.y;
   setPosition(shape,drag.original,drag.dx,drag.dy);
   if(ready?.id===drag.id)ready.anchor={x:drag.anchor.x+drag.dx,y:drag.anchor.y+drag.dy};
   render();
 },{capture:true,passive:false});
 // The editor's original window listener already finishes touch gestures.
 // Mouse/pen can be released outside the stage when browser capture is lost.
 window.addEventListener('pointerup',event=>{
   if(event.pointerType!=='touch'&&
      (drag?.pointerId===event.pointerId||holding?.pointerId===event.pointerId))
     finishPointer(event,false);
 },{capture:true});
 window.addEventListener('pointercancel',event=>{
   if(event.pointerType!=='touch'&&
      (drag?.pointerId===event.pointerId||holding?.pointerId===event.pointerId))
     finishPointer(event,true);
 },{capture:true});
 wrap.addEventListener('lostpointercapture',event=>{
   if(drag?.pointerId===event.pointerId){stopDrag(false);ready=null;render();}
   if(holding?.pointerId===event.pointerId)stopHolding();
 });
 // A stopped or hidden editor can never leave a move preview half committed.
 window.addEventListener('pagehide',()=>{dismiss();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)dismiss();});
 window.SentlogShapeMove={
   isEditing:()=>!!holding||!!drag,
   dismiss:()=>{dismiss();render();},
   get active(){return !!ready;},
   get dragging(){return !!drag;}
 };
 if(currentView==='editor')render();
})();

/* v1.49: polygon segment dimensions in metres, alongside each 0/45/90 edge.
 * Only a deliberate 500ms press on a dimension label opens input; a tap does
 * nothing. Uncalibrated drawings never show fictional real-world distances.
 * No additional persistent UI bars, no new stored fields or cloud changes. */
(function(){
'use strict';
if(typeof renderPreview!=='function'||typeof lineLengthMm!=='function'||
   typeof polygonAligned!=='function'||typeof commitPolygonVertex!=='function')
  throw Error('多角形寸法機能の読み込み順序が正しくありません。');
const wrap=$('stageWrap');
const HOLD_MS=500,HOLD_SLOP=9;
let hold=null,popup=null,trackedDrawing=null,previewDepth=0;
const precise=new Set();
const z=()=>Math.max(scale,.001);
function currentDraft(){return currentView==='editor'&&tool==='polygon'&&drawing?.kind==='polygon'?drawing:null;}
function calibrated(){
 const paper=getPaperMm(state.currentPage),denom=pageScaleDenom(state.currentPage);
 return !!paper&&paper.w>0&&paper.h>0&&denom>0&&state.width>0&&state.height>0;
}
function meters(a,b){
 const mm=lineLengthMm([a,b],state.currentPage);
 return Number.isFinite(mm)&&mm>0?mm/1000:null;
}
function labelText(m,exact=false){
 if(!Number.isFinite(m))return '';
 if(exact)return Number(m.toFixed(3)).toString()+'m';
 return (m<.01?m.toFixed(3):m.toFixed(2))+'m';
}
function stopHold(){
 if(hold?.timer)clearTimeout(hold.timer);
 hold=null;
}
function closePopup(){
 if(popup){popup.remove();popup=null;}
}
function reset(){
 stopHold();closePopup();trackedDrawing=null;precise.clear();
}
function fitsDrawing(points){
 return points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=-1e-7&&p.y>=-1e-7&&
   p.x<=state.width+1e-7&&p.y<=state.height+1e-7);
}
function simpleOpenPath(points){
 for(let i=0;i<points.length-1;i++){
  if(Math.hypot(points[i+1].x-points[i].x,points[i+1].y-points[i].y)<1e-6)return false;
  if(!polygonAligned(points[i],points[i+1]))return false;
  for(let j=i+2;j<points.length-1;j++){
   if(polygonSegmentsCross(points[i],points[i+1],points[j],points[j+1]))return false;
  }
 }
 return true;
}
// Return the proposed coordinates, *without* touching the active draft.
function resizeEdge(index,newLengthM,isPreview=false){
 const d=currentDraft();
 if(!d||!calibrated())return {error:'図面設定で用紙サイズと縮尺を設定してください。'};
 if(!Number.isFinite(newLengthM)||newLengthM<.001||newLengthM>10000)
   return {error:'0.001m以上の長さを数値で入力してください。'};
 const points=d.points;
 let a,b;
 if(isPreview){
  const guide=polygonDraftCursor;
  if(!guide||guide.closing||guide.points.length!==2)
   return {error:'先に次の辺の方向をプレビューしてください。'};
  a=guide.points[0];b=guide.points[1];
 }else{
  if(!Number.isInteger(index)||index<0||index>=points.length-1)return {error:'対象の辺が見つかりません。'};
  a=points[index];b=points[index+1];
 }
 const old=meters(a,b);
 if(!old||Math.hypot(b.x-a.x,b.y-a.y)<1e-6)return {error:'辺の方向を指定してから入力してください。'};
 const factor=newLengthM/old;
 const newEnd={x:a.x+(b.x-a.x)*factor,y:a.y+(b.y-a.y)*factor};
 if(Math.hypot(newEnd.x-a.x,newEnd.y-a.y)*z()<6)
   return {error:'この図面倍率では短すぎます。少し拡大して入力してください。'};
 if(isPreview){
  if(!fitsDrawing([newEnd]))return {error:'指定した長さでは図面の外に出てしまいます。'};
  if(points.length>=3&&Math.hypot(newEnd.x-points[0].x,newEnd.y-points[0].y)*z()<=18)
   return {error:'始点に重なる寸法です。別の長さを入力してください。'};
  const draft=[...points,newEnd];
  if(!simpleOpenPath(draft))return {error:'ほかの辺と交差するため、この長さにはできません。'};
  return {preview:true,end:newEnd};
 }
 const diff={x:newEnd.x-b.x,y:newEnd.y-b.y};
 const changed=points.map((p,i)=>i<=index?{...p}:{...p,x:p.x+diff.x,y:p.y+diff.y});
 if(!fitsDrawing(changed))return {error:'指定した長さでは図面の外に出てしまいます。'};
 if(!simpleOpenPath(changed))return {error:'ほかの辺と交差するため、この長さにはできません。'};
 return {preview:false,points:changed};
}
function applyLength(index,newLengthM,isPreview=false){
 const result=resizeEdge(index,newLengthM,isPreview);
 if(result.error)return result;
 if(result.preview){
  const before=drawing.points.length;
  commitPolygonVertex(result.end);
  if(drawing?.points?.length===before+1)precise.add(before-1);
 }else{
  drawing.points=result.points;
  precise.add(index);
  polygonDraftCursor=null;
  renderPreview();
 }
 return {ok:true};
}
function inputPopup(index,isPreview,event,initialM){
 closePopup();
 const panel=document.createElement('form');
 panel.className='sentlog-polygon-dimension-editor';
 panel.setAttribute('role','dialog');
 panel.setAttribute('aria-label','多角形の辺の長さを編集');
 panel.style.cssText='position:fixed;z-index:9999;width:206px;max-width:calc(100vw - 18px);'+
  'background:#fff;border:1px solid #94a3b8;border-radius:12px;padding:12px;'+
  'box-shadow:0 6px 26px rgba(0,0,0,.22);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;';
 const title=document.createElement('label');
 title.textContent=isPreview?'次の辺の長さ':'辺の長さ';
 title.style.cssText='font-size:12px;font-weight:700;display:block;margin-bottom:6px;';
 const row=document.createElement('div');
 row.style.cssText='display:flex;align-items:center;gap:6px;';
 const input=document.createElement('input');
 input.type='number';input.inputMode='decimal';input.step='0.001';input.min='0.001';
 input.value=initialM.toFixed(3);
 input.setAttribute('aria-label','辺の長さ（m）');
 input.style.cssText='min-width:0;width:100%;height:42px;padding:7px 9px;font-size:16px;border:1px solid #94a3b8;border-radius:7px;';
 const unit=document.createElement('span');unit.textContent='m';unit.style.fontWeight='700';
 row.append(input,unit);
 const note=document.createElement('div');
 note.style.cssText='font-size:11px;color:#64748b;margin-top:6px;';
 note.textContent='縮尺から換算・0.001m単位で入力';
 const error=document.createElement('div');
 error.style.cssText='font-size:11px;color:#b91c1c;margin-top:5px;min-height:0;';
 error.setAttribute('role','alert');
 const buttons=document.createElement('div');
 buttons.style.cssText='display:flex;gap:8px;margin-top:10px;';
 const submit=document.createElement('button');submit.type='submit';submit.textContent='確定';
 const cancel=document.createElement('button');cancel.type='button';cancel.textContent='やめる';
 submit.style.cssText='flex:1;height:40px;border:0;background:#1d4ed8;color:white;border-radius:8px;font-weight:700;';
 cancel.style.cssText='flex:1;height:40px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;';
 buttons.append(submit,cancel);
 panel.append(title,row,note,error,buttons);
 const left=Math.max(9,Math.min(window.innerWidth-215,(event.clientX||window.innerWidth/2)-90));
 const top=Math.max(12,Math.min(window.innerHeight-160,(event.clientY||100)-155));
 panel.style.left=left+'px';panel.style.top=top+'px';
 const draft=drawing,project=activeDrawingId,page=state.currentPage;
 panel.addEventListener('pointerdown',e=>e.stopPropagation());
 cancel.onclick=()=>closePopup();
 panel.onsubmit=e=>{
  e.preventDefault();
  if(!popup||drawing!==draft||project!==activeDrawingId||page!==state.currentPage||!currentDraft()){
   error.textContent='図面が切り替わりました。もう一度指定してください。';return;
  }
  const parsed=Number(input.value);
  const result=input.value.trim()?applyLength(index,Math.round(parsed*1000)/1000,isPreview):{error:'辺の長さを入力してください。'};
  if(result.error){error.textContent=result.error;return;}
  closePopup();
 };
 document.body.appendChild(panel);popup=panel;
 input.focus();input.select();
}
function bindHold(hit,index,isPreview,m){
 hit.dataset.dimensionLengthTarget='true';
 hit.style.cursor='default';
 hit.addEventListener('pointerdown',e=>{
  if(!currentDraft()||!calibrated()||gestureLock||activeTouches.size>1||
    (e.pointerType==='mouse'&&e.button!==0))return;
  // Critical: this is NOT a tap-to-place-vertex target.
  e.preventDefault();e.stopPropagation();
  stopHold();
  hold={pointerId:e.pointerId,x:e.clientX,y:e.clientY,
    index,isPreview,m,drawing,page:state.currentPage,project:activeDrawingId,timer:null};
  const h=hold;
  h.timer=setTimeout(()=>{
   if(hold!==h)return;
   stopHold();
   if(!currentDraft()||drawing!==h.drawing||
      h.project!==activeDrawingId||h.page!==state.currentPage||
      gestureLock||activeTouches.size>1)return;
   inputPopup(h.index,h.isPreview,{clientX:h.x,clientY:h.y},h.m);
  },HOLD_MS);
 });
}
function drawLabel(a,b,m,index,preview=false){
 const length=Math.hypot(b.x-a.x,b.y-a.y),scaleNow=z();
 if(length*scaleNow<48||!Number.isFinite(m)||m<=0)return;
 let angle=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
 if(angle>90)angle-=180;
 if(angle< -90)angle+=180;
 const nx=-(b.y-a.y)/length,ny=(b.x-a.x)/length;
 let x=(a.x+b.x)/2-nx*13/scaleNow,y=(a.y+b.y)/2-ny*13/scaleNow;
 const text=labelText(m,precise.has(index)&&!preview),labelWidth=Math.max(47,text.length*7.1+12);
 const center=wrap.getBoundingClientRect();
 // Keep a long-press handle inside the visible stage where practical.
 const sx=x*scaleNow+tx,sy=y*scaleNow+ty;
 if(sx>0&&sx<center.width&&sy>0&&sy<center.height){
   x+=Math.max(0,Math.min(center.width-7,sx)-sx)/scaleNow;
   y+=Math.max(0,Math.min(center.height-7,sy)-sy)/scaleNow;
 }
 const rotation='rotate('+angle+' '+x+' '+y+')';
 const label=makeEl('text',{x,y,transform:rotation,
   'font-size':window.SentlogDimensionText?.fontSize()??10.5/scaleNow,'text-anchor':'middle',
   'dominant-baseline':'middle',fill:preview?'#1d4ed8':'#334155',
   'font-weight':'700','paint-order':'stroke',
   stroke:'#fff','stroke-width':2.2/scaleNow,'pointer-events':'none'});
 label.textContent=text;
 svg.appendChild(label);
 const hit=makeEl('rect',{x:x-labelWidth/(2*scaleNow),y:y-19/scaleNow,
   width:labelWidth/scaleNow,height:38/scaleNow,rx:7/scaleNow,ry:7/scaleNow,
   transform:rotation,fill:'rgba(37,99,235,0.001)','pointer-events':'all'});
 bindHold(hit,index,preview,m);
 svg.appendChild(hit);
}
const hint=document.createElement('div');
hint.className='sentlog-polygon-dimension-hint';
hint.style.cssText='position:absolute;right:8px;top:8px;z-index:2;'+
 'padding:6px 9px;border-radius:7px;background:rgba(255,255,255,.94);'+
 'box-shadow:0 1px 5px rgba(0,0,0,.1);font-size:11px;color:#475569;'+
 'pointer-events:none;display:none;max-width:230px;';
hint.textContent='寸法を表示するには「図面設定」で用紙と縮尺を指定してください';
wrap.appendChild(hint);
function drawDimensions(){
 if(trackedDrawing!==drawing){trackedDrawing=drawing;precise.clear();closePopup();stopHold();}
 const d=currentDraft();
 if(!d||!d.points?.length){
  hint.style.display='none';closePopup();stopHold();return;
 }
 if(!calibrated()){
  hint.style.display='block';closePopup();stopHold();return;
 }
 hint.style.display='none';
 for(let i=0;i<d.points.length-1;i++){
  const a=d.points[i],b=d.points[i+1];
  drawLabel(a,b,meters(a,b),i);
 }
 const guide=polygonDraftCursor;
 if(guide?.valid&&guide.points?.length>=2){
  const base=d.points.length-1;
  for(let i=0;i<guide.points.length-1;i++){
   const a=guide.points[i],b=guide.points[i+1];
   // Auto-closing routes can be displayed, but are not directly resized.
   const editable=!guide.closing&&guide.points.length===2;
   if(editable)drawLabel(a,b,meters(a,b),base,true);
   else{
     const m=meters(a,b);
     if(!m||Math.hypot(b.x-a.x,b.y-a.y)*z()<48)continue;
     const length=Math.hypot(b.x-a.x,b.y-a.y);
     let angle=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
     if(angle>90)angle-=180;if(angle< -90)angle+=180;
     const px=(a.x+b.x)/2+(b.y-a.y)/length*13/z();
     const py=(a.y+b.y)/2-(b.x-a.x)/length*13/z();
     const el=makeEl('text',{x:px,y:py,transform:'rotate('+angle+' '+px+' '+py+')',
       'font-size':window.SentlogDimensionText?.fontSize()??10.5/z(),'text-anchor':'middle','dominant-baseline':'middle',
       fill:'#15803d','font-weight':'700','paint-order':'stroke',stroke:'#fff',
       'stroke-width':2/z(),'pointer-events':'none'});
     el.textContent=labelText(m);svg.appendChild(el);
   }
  }
 }
}
const oldRenderPreview=renderPreview,oldRender=render;
renderPreview=function(){
 previewDepth++;
 let result;
 try{result=oldRenderPreview.apply(this,arguments);}finally{previewDepth--;}
 drawDimensions();
 return result;
};
render=function(){
 const result=oldRender.apply(this,arguments);
 if(!previewDepth)drawDimensions();
 return result;
};
// Pointer capture may transfer events to the stage, so track the intended
// pressed label from the window's capture phase, independent of its SVG node.
window.addEventListener('pointermove',e=>{
 if(hold?.pointerId===e.pointerId &&
   Math.hypot(e.clientX-hold.x,e.clientY-hold.y)>HOLD_SLOP)stopHold();
},{capture:true});
window.addEventListener('pointerup',e=>{if(hold?.pointerId===e.pointerId)stopHold();},{capture:true});
window.addEventListener('pointercancel',e=>{if(hold?.pointerId===e.pointerId)stopHold();},{capture:true});
window.addEventListener('blur',reset);
window.addEventListener('pagehide',reset);
document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
window.SentlogPolygonDimensions={
 isEditing:()=>!!hold||!!popup,
 get editing(){return !!popup;},
 get holding(){return !!hold;},
 get calibrated(){return calibrated();},
 meters, labelText, resizeEdge, applyLength
};
if(currentView==='editor')render();
})();

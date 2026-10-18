/* Sentlog v1.73: independent CAD-style dimension lines.
 * Dimension annotations live in the drawing state so Undo/Redo, backup and sync
 * keep them, but they are excluded from normal damage numbering/counts.
 * Unscaled drawings edit display text only. Scaled drawings show measured metres
 * and allow changing the measured length by moving the second reference point. */
(function(root){
'use strict';

function isDimension(s){
  return !!s&&s.kind==='dimension'&&s.recordKind==='dimension-line'&&Array.isArray(s.points)&&s.points.length>=2;
}
function normPoint(p){return {x:Number(p?.x)||0,y:Number(p?.y)||0};}
function dimensionBasis(a,b){
  a=normPoint(a);b=normPoint(b);
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
  if(!(len>1e-9))return null;
  const ux=dx/len,uy=dy/len;
  return {a,b,dx,dy,len,ux,uy,nx:-uy,ny:ux};
}
function dimensionGeometry(a,b,offset=0,arrow=8,overshoot=4){
  const q=dimensionBasis(a,b);if(!q)return null;
  const d1={x:q.a.x+q.nx*offset,y:q.a.y+q.ny*offset};
  const d2={x:q.b.x+q.nx*offset,y:q.b.y+q.ny*offset};
  const e1={x:d1.x+q.nx*overshoot,y:d1.y+q.ny*overshoot};
  const e2={x:d2.x+q.nx*overshoot,y:d2.y+q.ny*overshoot};
  const wing=arrow*.48;
  const arrow1=[d1,{x:d1.x+q.ux*arrow+q.nx*wing,y:d1.y+q.uy*arrow+q.ny*wing},{x:d1.x+q.ux*arrow-q.nx*wing,y:d1.y+q.uy*arrow-q.ny*wing}];
  const arrow2=[d2,{x:d2.x-q.ux*arrow+q.nx*wing,y:d2.y-q.uy*arrow+q.ny*wing},{x:d2.x-q.ux*arrow-q.nx*wing,y:d2.y-q.uy*arrow-q.ny*wing}];
  let angle=Math.atan2(q.dy,q.dx)*180/Math.PI;
  if(angle>90)angle-=180;if(angle<-90)angle+=180;
  return {...q,d1,d2,e1,e2,arrow1,arrow2,mid:{x:(d1.x+d2.x)/2,y:(d1.y+d2.y)/2},angle};
}
function formatMetresFromMm(mm){
  const v=Number(mm);if(!Number.isFinite(v)||v<0)return '';
  return (v/1000).toFixed(3)+' m';
}
function editBehavior(calibrated){return calibrated?'scaled-length':'manual-label';}
function resizedEnd(a,b,currentMm,targetM,bounds=null){
  a=normPoint(a);b=normPoint(b);
  currentMm=Number(currentMm);targetM=Number(targetM);
  if(!(currentMm>0)||!(targetM>=.001)||targetM>10000)return {error:'invalid'};
  const factor=(targetM*1000)/currentMm;
  const end={x:a.x+(b.x-a.x)*factor,y:a.y+(b.y-a.y)*factor};
  if(!Number.isFinite(end.x)||!Number.isFinite(end.y))return {error:'invalid'};
  if(bounds){
    const w=Number(bounds.width),h=Number(bounds.height);
    if(end.x<0||end.y<0||end.x>w||end.y>h)return {error:'outside'};
  }
  return {end,factor};
}
const pure={isDimension,normPoint,dimensionBasis,dimensionGeometry,formatMetresFromMm,editBehavior,resizedEnd};
if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
if(!root.document||root.SentlogDimensionLines)return;
if(typeof render!=='function'||typeof lineLengthMm!=='function'||typeof pushHistory!=='function')
  throw Error('寸法線機能の読み込み順序が正しくありません。');

const wrap=$('stageWrap'),svg=$('svg');
if(!wrap||!svg)return;
const z=()=>Math.max(.001,Number(scale)||1);
const DIM_OFFSET_PX=25,DIM_ARROW_PX=8,DIM_OVERSHOOT_PX=4,DIM_HIT_PX=24;
let tapAnchor=null,gesture=null,editor=null;

function calibrated(page=state.currentPage){
  const paper=getPaperMm(page),denom=pageScaleDenom(page);
  return !!paper&&paper.w>0&&paper.h>0&&denom>0&&state.width>0&&state.height>0;
}
function sourceDimension(id){
  const s=state.shapes.find(x=>x.id===id&&(x.page||1)===state.currentPage);
  return isDimension(s)?s:null;
}
function displayText(s){
  if(calibrated(s.page||1)){
    const mm=lineLengthMm(s.points,s.page||1);
    return Number.isFinite(mm)?formatMetresFromMm(mm):'寸法';
  }
  return String(s.manualText||'').trim()||'寸法値';
}
function cleanTransient(){gesture=null;tapAnchor=null;}
function closeEditor(){if(editor){editor.remove();editor=null;}}
function reset(){cleanTransient();closeEditor();if(typeof render==='function')render();}
function dimensionIdFromTarget(target){return target?.closest?.('[data-sentlog-dimension-id]')?.dataset?.sentlogDimensionId||null;}

function createDimension(a,b){
  a=normPoint(a);b=normPoint(b);
  if(Math.hypot(b.x-a.x,b.y-a.y)*z()<8)return null;
  pushHistory();
  const s={
    id:crypto.randomUUID?crypto.randomUUID():'dim-'+Date.now()+'-'+Math.random().toString(16).slice(2),
    page:state.currentPage,kind:'dimension',recordKind:'dimension-line',points:[a,b],manualText:''
  };
  state.shapes.push(s);persist();render();
  if(!calibrated(s.page))openEditor(s.id,true);
  return s;
}
function deleteDimension(s){
  if(!s)return;pushHistory();state.shapes=state.shapes.filter(x=>x.id!==s.id);closeEditor();persist();render();
}
function applyScaledLength(s,value){
  const currentMm=lineLengthMm(s.points,s.page||1);
  const result=resizedEnd(s.points[0],s.points[1],currentMm,value,{width:state.width,height:state.height});
  if(result.error)return result.error==='outside'?'指定した長さでは図面の外に出てしまいます。':'0.001m以上の長さを入力してください。';
  if(Math.hypot(result.end.x-s.points[0].x,result.end.y-s.points[0].y)*z()<8)return 'この図面倍率では短すぎます。少し拡大して入力してください。';
  pushHistory();s.points=[{...s.points[0]},result.end];persist();render();return null;
}
function applyManualText(s,value){
  const text=String(value||'').trim();if(!text)return '表示する寸法値を入力してください。';
  pushHistory();s.manualText=text;persist();render();return null;
}
function openEditor(id,focusInput=false,event=null){
  const s=sourceDimension(id);if(!s)return;closeEditor();
  const isScaled=calibrated(s.page||1);
  const panel=document.createElement('form');panel.className='sentlog-dimension-editor';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','寸法線を編集');
  panel.style.cssText='position:fixed;z-index:1200;width:230px;max-width:calc(100vw - 18px);background:#fff;border:1px solid #94a3b8;border-radius:12px;padding:12px;box-sizing:border-box;box-shadow:0 8px 28px rgba(0,0,0,.25);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;';
  const title=document.createElement('strong');title.textContent='寸法線';title.style.cssText='display:block;margin-bottom:8px;font-size:14px;';
  const label=document.createElement('label');label.style.cssText='display:block;font-size:12px;font-weight:700;margin-bottom:5px;';label.textContent=isScaled?'寸法長さ（m）':'表示する寸法値';
  const input=document.createElement('input');
  if(isScaled){const mm=lineLengthMm(s.points,s.page||1);input.type='number';input.inputMode='decimal';input.step='0.001';input.min='0.001';input.value=Number.isFinite(mm)?(mm/1000).toFixed(3):'';}
  else{input.type='text';input.inputMode='decimal';input.value=s.manualText||'';input.placeholder='例：1.200 m';}
  input.style.cssText='width:100%;height:42px;box-sizing:border-box;padding:7px 9px;font-size:16px;border:1px solid #94a3b8;border-radius:7px;';
  const note=document.createElement('div');note.style.cssText='font-size:11px;line-height:1.5;color:#64748b;margin-top:7px;';note.textContent=isScaled?'縮尺設定済み：数値を変えると終点が移動し、実寸がこの長さになります。':'縮尺未設定：表示文字だけ変更します。寸法線自体の長さは変わりません。';
  const error=document.createElement('div');error.setAttribute('role','alert');error.style.cssText='min-height:15px;margin-top:5px;font-size:11px;color:#b91c1c;';
  const row=document.createElement('div');row.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px;';
  const ok=document.createElement('button');ok.type='submit';ok.textContent='確定';ok.style.cssText='height:40px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;font-weight:700;';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='閉じる';cancel.style.cssText='height:40px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;';
  const del=document.createElement('button');del.type='button';del.textContent='この寸法線を削除';del.style.cssText='width:100%;height:38px;margin-top:8px;border:1px solid #fecaca;border-radius:8px;background:#fff;color:#b91c1c;font-weight:700;';
  row.append(ok,cancel);panel.append(title,label,input,note,error,row,del);
  panel.addEventListener('pointerdown',e=>e.stopPropagation());
  cancel.onclick=()=>closeEditor();del.onclick=()=>deleteDimension(sourceDimension(id));
  panel.onsubmit=e=>{e.preventDefault();const current=sourceDimension(id);if(!current){closeEditor();return;}const msg=isScaled?applyScaledLength(current,Number(input.value)):applyManualText(current,input.value);if(msg){error.textContent=msg;return;}closeEditor();};
  document.body.appendChild(panel);editor=panel;
  const vw=window.visualViewport?.width||innerWidth,vh=window.visualViewport?.height||innerHeight;
  const left=event?.clientX!=null?event.clientX-110:vw/2-115;const top=event?.clientY!=null?event.clientY-185:vh/2-150;
  panel.style.left=Math.max(9,Math.min(vw-239,left))+'px';panel.style.top=Math.max(9,Math.min(vh-250,top))+'px';
  if(focusInput){input.focus();input.select();}
}
function bindDimensionHit(el,id){
  el.dataset.sentlogDimensionId=id;el.style.cursor='pointer';
  el.addEventListener('pointerdown',e=>{
    if(tool!=='pan'&&tool!=='dimension')return;
    if(e.pointerType==='mouse'&&e.button!==0)return;
    e.preventDefault();e.stopPropagation();
  });
  el.addEventListener('pointerup',e=>{
    if(tool!=='pan'&&tool!=='dimension')return;
    if(e.pointerType==='mouse'&&e.button!==0)return;
    e.preventDefault();e.stopPropagation();openEditor(id,false,e);
  });
}
function svgEl(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs||{}))e.setAttribute(k,String(v));return e;}
function pointsAttr(points){return points.map(p=>p.x+','+p.y).join(' ');}
function drawOne(s,preview=false){
  const q=dimensionGeometry(s.points[0],s.points[1],DIM_OFFSET_PX/z(),DIM_ARROW_PX/z(),DIM_OVERSHOOT_PX/z());if(!q)return;
  const color=preview?'#2563eb':'#111827',thin=(preview?1.2:1)/z(),dash=preview?`${6/z()} ${4/z()}`:null;
  const ext1=svgEl('line',{x1:q.a.x,y1:q.a.y,x2:q.e1.x,y2:q.e1.y,stroke:color,'stroke-width':thin});
  const ext2=svgEl('line',{x1:q.b.x,y1:q.b.y,x2:q.e2.x,y2:q.e2.y,stroke:color,'stroke-width':thin});
  const line=svgEl('line',{x1:q.d1.x,y1:q.d1.y,x2:q.d2.x,y2:q.d2.y,stroke:color,'stroke-width':thin});
  if(dash){ext1.setAttribute('stroke-dasharray',dash);ext2.setAttribute('stroke-dasharray',dash);line.setAttribute('stroke-dasharray',dash);}
  for(const e of [ext1,ext2,line]){e.style.pointerEvents='none';svg.appendChild(e);}
  const a1=svgEl('polygon',{points:pointsAttr(q.arrow1),fill:color,stroke:color,'stroke-width':.5/z()});const a2=svgEl('polygon',{points:pointsAttr(q.arrow2),fill:color,stroke:color,'stroke-width':.5/z()});a1.style.pointerEvents='none';a2.style.pointerEvents='none';svg.append(a1,a2);
  const text=preview?(calibrated()?formatMetresFromMm(lineLengthMm(s.points,state.currentPage)):'寸法線'):displayText(s);
  const fs=11.5/z(),label=svgEl('text',{x:q.mid.x,y:q.mid.y-8/z(),transform:`rotate(${q.angle} ${q.mid.x} ${q.mid.y-8/z()})`,'font-size':fs,'text-anchor':'middle','dominant-baseline':'middle',fill:color,'font-weight':'700','paint-order':'stroke fill',stroke:'#fff','stroke-width':3/z(),'pointer-events':'none'});label.textContent=text;svg.appendChild(label);
  if(preview)return;
  const lineHit=svgEl('line',{x1:q.d1.x,y1:q.d1.y,x2:q.d2.x,y2:q.d2.y,stroke:'rgba(0,0,0,.001)','stroke-width':DIM_HIT_PX/z(),'pointer-events':'stroke'});bindDimensionHit(lineHit,s.id);svg.appendChild(lineHit);
  const width=Math.max(58,text.length*8+18)/z(),height=34/z();const labelHit=svgEl('rect',{x:q.mid.x-width/2,y:q.mid.y-8/z()-height/2,width,height,rx:6/z(),ry:6/z(),transform:`rotate(${q.angle} ${q.mid.x} ${q.mid.y-8/z()})`,fill:'rgba(0,0,0,.001)','pointer-events':'all'});bindDimensionHit(labelHit,s.id);svg.appendChild(labelHit);
}
function drawAll(dimensions){
  for(const s of dimensions)if((s.page||1)===state.currentPage)drawOne(s,false);
  if(tool==='dimension'){
    if(tapAnchor){const r=5/z(),m=svgEl('circle',{cx:tapAnchor.x,cy:tapAnchor.y,r,fill:'#fff',stroke:'#2563eb','stroke-width':2/z()});m.style.pointerEvents='none';svg.appendChild(m);}
    if(gesture&&gesture.b&&Math.hypot(gesture.b.x-gesture.a.x,gesture.b.y-gesture.a.y)*z()>=8)drawOne({page:state.currentPage,points:[gesture.a,gesture.b],manualText:''},true);
  }
}

const oldRender=render;
render=function(){
  if(tool!=='dimension'){gesture=null;tapAnchor=null;}
  const all=state.shapes||[],dimensions=all.filter(isDimension),normal=all.filter(s=>!isDimension(s));
  let result;state.shapes=normal;try{result=oldRender.apply(this,arguments);}finally{state.shapes=all;}
  drawAll(dimensions);return result;
};
const oldRebuild=rebuildNumberingState;
rebuildNumberingState=function(){
  const all=state.shapes||[],normal=all.filter(s=>!isDimension(s));if(normal.length===all.length)return oldRebuild.apply(this,arguments);
  state.shapes=normal;try{return oldRebuild.apply(this,arguments);}finally{state.shapes=all;}
};
const oldMeta=updateActiveMeta;
updateActiveMeta=function(){
  const all=state.shapes||[],normal=all.filter(s=>!isDimension(s));if(normal.length===all.length)return oldMeta.apply(this,arguments);
  state.shapes=normal;try{return oldMeta.apply(this,arguments);}finally{state.shapes=all;}
};

wrap.addEventListener('pointerdown',e=>{
  if(tool!=='dimension'||gestureLock||dimensionIdFromTarget(e.target))return;
  if(e.pointerType==='mouse'&&e.button!==0)return;
  e.preventDefault();e.stopPropagation();closeEditor();
  const p=point(e),usingAnchor=!!tapAnchor;
  gesture={pointerId:e.pointerId,a:usingAnchor?{...tapAnchor}:p,b:p,start:p,usingAnchor,moved:false};
  try{wrap.setPointerCapture(e.pointerId)}catch{}
  render();
});
wrap.addEventListener('pointermove',e=>{
  if(tool!=='dimension'||!gesture||gesture.pointerId!==e.pointerId||gestureLock)return;
  const p=point(e);gesture.b=p;if(Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)*z()>6)gesture.moved=true;render();
});
function finishDimensionGesture(e,cancelled=false){
  if(!gesture||gesture.pointerId!==e.pointerId)return;
  const g=gesture;gesture=null;
  try{wrap.releasePointerCapture(e.pointerId)}catch{}
  if(cancelled||gestureLock){render();return;}
  const end=point(e),distance=Math.hypot(end.x-g.a.x,end.y-g.a.y)*z();
  if(g.usingAnchor){tapAnchor=null;if(distance>=8)createDimension(g.a,end);else render();return;}
  if(g.moved&&distance>=8){tapAnchor=null;createDimension(g.a,end);return;}
  tapAnchor={...g.a};render();
}
wrap.addEventListener('pointerup',e=>{if(tool==='dimension')finishDimensionGesture(e,false);});
wrap.addEventListener('pointercancel',e=>finishDimensionGesture(e,true));
window.addEventListener('pointerdown',e=>{
  if(tool==='dimension'&&e.pointerType==='touch'&&activeTouches.size>=1&&(gesture||tapAnchor)){gesture=null;tapAnchor=null;queueMicrotask(()=>render());}
},{capture:true});
window.addEventListener('blur',reset);window.addEventListener('pagehide',reset);document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});

root.SentlogDimensionLines={version:'v1.73',...pure,calibrated,displayText,isEditing:()=>!!editor||!!gesture||!!tapAnchor};
if(currentView==='editor')render();
})(typeof window==='object'?window:globalThis);

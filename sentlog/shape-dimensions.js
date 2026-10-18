/* Sentlog v1.75: editable completed-shape dimensions.
 * - Uncalibrated drawings: edge dimensions can be entered as records, but geometry never moves.
 * - Calibrated drawings: measured dimensions are shown; editing a dimension changes real geometry.
 * - Rectangles show horizontal + vertical side values. Polygons show every edge in vertex order.
 * - Representative second-line labels remain separate from crack W=...mm notation.
 * Manual edge dimensions are stored inside the existing shape JSON as edgeDimensionsM.
 * No Supabase schema migration or new record type is introduced. */
(function(root){
'use strict';

function normPoint(p){return {x:Number(p?.x)||0,y:Number(p?.y)||0};}
function rectCorners(s){
  let x=Number(s?.x)||0,y=Number(s?.y)||0,w=Number(s?.w)||0,h=Number(s?.h)||0;
  if(w<0){x+=w;w=-w;}if(h<0){y+=h;h=-h;}
  return [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
}
function orderedEdges(points,closed=true){
  const pts=(Array.isArray(points)?points:[]).map(normPoint),out=[];
  for(let i=0;i<pts.length-1;i++)out.push({index:i,a:pts[i],b:pts[i+1]});
  if(closed&&pts.length>2)out.push({index:pts.length-1,a:pts[pts.length-1],b:pts[0]});
  return out;
}
function averagePoint(points){
  const pts=(Array.isArray(points)?points:[]).map(normPoint);
  if(!pts.length)return {x:0,y:0};
  return {x:pts.reduce((n,p)=>n+p.x,0)/pts.length,y:pts.reduce((n,p)=>n+p.y,0)/pts.length};
}
function edgeLabelPlacement(a,b,center,offset=12){
  a=normPoint(a);b=normPoint(b);center=normPoint(center);
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);if(!(len>1e-9))return null;
  const ux=dx/len,uy=dy/len,mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
  let nx=-uy,ny=ux;
  if(nx*(center.x-mid.x)+ny*(center.y-mid.y)>0){nx=-nx;ny=-ny;}
  let angle=Math.atan2(dy,dx)*180/Math.PI;
  if(angle>90)angle-=180;if(angle<-90)angle+=180;
  return {x:mid.x+nx*offset,y:mid.y+ny*offset,angle,len,nx,ny,mid};
}
function formatLengthMm(mm){
  const v=Number(mm);if(!Number.isFinite(v)||v<0)return '';
  return (v/1000).toFixed(3)+' m';
}
function formatLengthM(m){
  const v=Number(m);if(!Number.isFinite(v)||v<=0)return '';
  return v.toFixed(3)+' m';
}
function formatAreaMm2(mm2){
  const v=Number(mm2);if(!Number.isFinite(v)||v<0)return '';
  return (v/1e6).toFixed(3)+' m²';
}
function representativeFromMeasurements(kind,measure={}){
  if(kind==='rect'&&Number.isFinite(measure.widthMm)&&Number.isFinite(measure.heightMm))
    return (measure.widthMm/1000).toFixed(3)+' × '+(measure.heightMm/1000).toFixed(3)+' m';
  if((kind==='polygon'||kind==='freehand'||kind==='freehand-area')&&Number.isFinite(measure.areaMm2))
    return 'A='+(measure.areaMm2/1e6).toFixed(3)+' m²';
  if((kind==='line'||kind==='freehand-line')&&Number.isFinite(measure.lengthMm))
    return 'L='+(measure.lengthMm/1000).toFixed(3)+' m';
  return '';
}
function manualEdgeM(shape,index){
  const v=Number(shape?.edgeDimensionsM?.[String(index)]);
  return Number.isFinite(v)&&v>0?v:null;
}
function rectResizeGeometry(shape,index,factor,bounds=null){
  const pts=rectCorners(shape),w=pts[1].x-pts[0].x,h=pts[2].y-pts[1].y;
  if(!(factor>0)||!(w>0)||!(h>0)||![0,1].includes(Number(index)))return {error:'invalid'};
  const next={x:pts[0].x,y:pts[0].y,w:index===0?w*factor:w,h:index===1?h*factor:h};
  if(bounds){
    const bw=Number(bounds.width),bh=Number(bounds.height);
    if(next.x<0||next.y<0||next.x+next.w>bw||next.y+next.h>bh)return {error:'outside'};
  }
  return {geometry:next};
}
function polygonSimple(points,crossFn){
  const pts=(points||[]).map(normPoint),n=pts.length;if(n<3)return false;
  for(let i=0;i<n;i++){
    const a=pts[i],b=pts[(i+1)%n];
    if(Math.hypot(b.x-a.x,b.y-a.y)<1e-6)return false;
  }
  if(typeof crossFn!=='function')return true;
  for(let i=0;i<n;i++){
    const a=pts[i],b=pts[(i+1)%n];
    for(let j=i+1;j<n;j++){
      if(j===i||j===(i+1)%n||i===(j+1)%n)continue;
      const c=pts[j],d=pts[(j+1)%n];
      if(crossFn(a,b,c,d))return false;
    }
  }
  return true;
}
function octilinearDirection(a,b){
  a=normPoint(a);b=normPoint(b);
  const dx=b.x-a.x,dy=b.y-a.y;if(Math.hypot(dx,dy)<1e-9)return null;
  return ((Math.round(Math.atan2(dy,dx)/(Math.PI/4))%8)+8)%8;
}
function resizePolygonEdge(points,index,factor,bounds=null,alignedFn=null,crossFn=null){
  const pts=(Array.isArray(points)?points:[]).map(normPoint),n=pts.length;
  index=Number(index);
  if(n<3||!Number.isInteger(index)||index<0||index>=n||!(factor>0))return {error:'invalid'};
  const aIndex=index,bIndex=(index+1)%n,a=pts[aIndex],b=pts[bIndex];
  const dx=(b.x-a.x)*(factor-1),dy=(b.y-a.y)*(factor-1);
  const targetLen=Math.hypot((b.x+dx)-a.x,(b.y+dy)-a.y);
  if(targetLen<1e-6)return {error:'invalid'};
  const originalEdges=orderedEdges(pts,true);
  const originallyAligned=typeof alignedFn==='function'&&originalEdges.every(e=>alignedFn(e.a,e.b));
  const originalDirections=originallyAligned?originalEdges.map(e=>octilinearDirection(e.a,e.b)):null;
  const inside=c=>!bounds||c.every(p=>p.x>=-1e-7&&p.y>=-1e-7&&p.x<=Number(bounds.width)+1e-7&&p.y<=Number(bounds.height)+1e-7);
  const directionsPreserved=c=>!originalDirections||orderedEdges(c,true).every((e,i)=>alignedFn(e.a,e.b)&&octilinearDirection(e.a,e.b)===originalDirections[i]);
  const valid=c=>inside(c)&&polygonSimple(c,crossFn)&&directionsPreserved(c);
  const candidates=[];
  // Move a forward chain beginning at the edge end. Internal shifted edges retain direction.
  for(let count=1;count<n;count++){
    const c=pts.map(p=>({...p}));
    for(let k=0;k<count;k++){const idx=(bIndex+k)%n;c[idx].x+=dx;c[idx].y+=dy;}
    if(valid(c))candidates.push({points:c,moved:count,direction:'forward'});
  }
  // Or keep the edge end fixed and move a backward chain from the edge start.
  for(let count=1;count<n;count++){
    const c=pts.map(p=>({...p}));
    for(let k=0;k<count;k++){const idx=(aIndex-k+n)%n;c[idx].x-=dx;c[idx].y-=dy;}
    if(valid(c))candidates.push({points:c,moved:count,direction:'backward'});
  }
  if(!candidates.length)return {error:'geometry'};
  candidates.sort((x,y)=>x.moved-y.moved||(x.direction==='forward'?-1:1));
  return candidates[0];
}
const pure={normPoint,rectCorners,orderedEdges,averagePoint,edgeLabelPlacement,formatLengthMm,formatLengthM,formatAreaMm2,representativeFromMeasurements,manualEdgeM,rectResizeGeometry,polygonSimple,octilinearDirection,resizePolygonEdge};
if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
if(!root.document||root.SentlogShapeDimensions)return;
if(typeof render!=='function'||typeof lineLengthMm!=='function'||typeof polygonAreaMm2!=='function')
  throw Error('変状寸法表示機能の読み込み順序が正しくありません。');

const svg=$('svg');
if(!svg)return;
const z=()=>Math.max(.001,Number(scale)||1);
let previewDepth=0,editor=null;

function calibrated(page=state.currentPage){
  const paper=getPaperMm(page),denom=pageScaleDenom(page);
  return !!paper&&paper.w>0&&paper.h>0&&denom>0&&state.width>0&&state.height>0;
}
function isAuxiliary(s){
  return !s||s.recordKind==='field-record'||s.recordKind==='dimension-line'||s.kind==='dimension';
}
function isConcreteCrack(s){
  try{return !!root.SentlogCrackWidth?.isConcreteCrack?.(s);}catch(_){return false;}
}
function sourceShape(id){
  const s=state.shapes.find(x=>x.id===id&&(x.page||1)===state.currentPage);
  return s&&!isAuxiliary(s)?s:null;
}
function edgeColor(shape,preview=false,placeholder=false){
  if(preview)return '#2563eb';
  if(shape?.id===selected)return '#1d4ed8';
  return placeholder?'#64748b':'#374151';
}
function drawText(text,x,y,angle,color,attrs={}){
  if(!text)return null;
  const fs=(attrs.fontPx||10.5)/z();
  const t=makeEl('text',{x,y,transform:`rotate(${angle||0} ${x} ${y})`,
    'font-size':fs,'text-anchor':'middle','dominant-baseline':'middle',
    fill:color||'#374151','font-weight':attrs.weight||'700','paint-order':'stroke fill',
    stroke:'#fff','stroke-width':(attrs.haloPx||2.6)/z(),'stroke-linejoin':'round','pointer-events':'none'});
  if(attrs.className)t.setAttribute('class',attrs.className);
  if(attrs.shapeId)t.dataset.shapeDimensionId=attrs.shapeId;
  if(attrs.edgeIndex!=null)t.dataset.edgeIndex=String(attrs.edgeIndex);
  t.textContent=text;svg.appendChild(t);return t;
}
function edgeLengthText(shape,a,b,index){
  const page=shape?.page||state.currentPage;
  if(calibrated(page)){
    const mm=lineLengthMm([a,b],page);
    return {text:Number.isFinite(mm)?formatLengthMm(mm):'',placeholder:false};
  }
  const manual=manualEdgeM(shape,index);
  return {text:manual==null?'寸法':formatLengthM(manual),placeholder:manual==null};
}
function hitRectForLabel(place,text){
  const width=Math.max(58,String(text||'寸法').length*8+18)/z(),height=36/z();
  return makeEl('rect',{x:place.x-width/2,y:place.y-height/2,width,height,rx:6/z(),ry:6/z(),
    transform:`rotate(${place.angle} ${place.x} ${place.y})`,fill:'rgba(37,99,235,0.001)','pointer-events':'all'});
}
function closeEditor(){if(editor){editor.remove();editor=null;}}
function syncManualFromScale(s){
  if(!s||!calibrated(s.page||1))return;
  const values={};
  if(s.kind==='rect'){
    const d=rectangleDimensionData(s);
    if(Number.isFinite(d.widthMm))values['0']=d.widthMm/1000;
    if(Number.isFinite(d.heightMm))values['1']=d.heightMm/1000;
  }else if(s.kind==='polygon'){
    for(const e of orderedEdges(s.points,true)){
      const mm=lineLengthMm([e.a,e.b],s.page||1);
      if(Number.isFinite(mm)&&mm>0)values[String(e.index)]=mm/1000;
    }
  }
  s.edgeDimensionsM=values;
}
function applyManualEdge(s,index,value){
  const v=Number(value);if(!(v>=.001)||v>10000)return '0.001m以上10000m以下の寸法を入力してください。';
  pushHistory(s.page||state.currentPage);
  s.edgeDimensionsM={...(s.edgeDimensionsM||{}),[String(index)]:Number(v.toFixed(3))};
  persist();render();return null;
}
function clearManualEdge(s,index){
  if(!s||manualEdgeM(s,index)==null)return;
  pushHistory(s.page||state.currentPage);
  const next={...(s.edgeDimensionsM||{})};delete next[String(index)];
  if(Object.keys(next).length)s.edgeDimensionsM=next;else delete s.edgeDimensionsM;
  persist();render();
}
function applyScaledRect(s,index,targetM){
  const d=rectangleDimensionData(s),currentMm=index===0?d.widthMm:d.heightMm;
  if(!(Number.isFinite(currentMm)&&currentMm>0))return '現在の辺長を計算できません。';
  const factor=(Number(targetM)*1000)/currentMm;
  const result=rectResizeGeometry(s,index,factor,{width:state.width,height:state.height});
  if(result.error)return result.error==='outside'?'指定した長さでは図面の外に出てしまいます。':'0.001m以上の長さを入力してください。';
  const g=result.geometry;if(Math.min(g.w,g.h)*z()<8)return 'この図面倍率では短すぎます。少し拡大して入力してください。';
  pushHistory(s.page||state.currentPage);
  s.x=g.x;s.y=g.y;s.w=g.w;s.h=g.h;
  syncManualFromScale(s);persist();render();return null;
}
function applyScaledPolygon(s,index,targetM){
  const edges=orderedEdges(s.points,true),edge=edges.find(e=>e.index===Number(index));if(!edge)return '対象の辺が見つかりません。';
  const currentMm=lineLengthMm([edge.a,edge.b],s.page||1);
  if(!(Number.isFinite(currentMm)&&currentMm>0))return '現在の辺長を計算できません。';
  const factor=(Number(targetM)*1000)/currentMm;
  const result=resizePolygonEdge(s.points,index,factor,{width:state.width,height:state.height},
    typeof polygonAligned==='function'?polygonAligned:null,
    typeof polygonSegmentsCross==='function'?polygonSegmentsCross:null);
  if(result.error){
    if(result.error==='outside')return '指定した長さでは図面の外に出てしまいます。';
    if(result.error==='geometry')return 'この形状では、その辺だけを指定寸法に変更できません。別の辺または形状を調整してください。';
    return '0.001m以上の長さを入力してください。';
  }
  if(result.points.some((p,i,a)=>Math.hypot(a[(i+1)%a.length].x-p.x,a[(i+1)%a.length].y-p.y)*z()<8))
    return 'この図面倍率では短すぎる辺ができます。少し拡大して入力してください。';
  pushHistory(s.page||state.currentPage);s.points=result.points;syncManualFromScale(s);persist();render();return null;
}
function applyScaledEdge(s,index,value){
  const v=Number(value);if(!(v>=.001)||v>10000)return '0.001m以上10000m以下の長さを入力してください。';
  if(s.kind==='rect')return applyScaledRect(s,Number(index),v);
  if(s.kind==='polygon')return applyScaledPolygon(s,Number(index),v);
  return 'この変状では辺長変更できません。';
}
function openEdgeEditor(id,index,event=null){
  let s=sourceShape(id);if(!s||!['rect','polygon'].includes(s.kind))return;
  if(typeof selectShape==='function'&&selected!==id)selectShape(id);
  s=sourceShape(id);if(!s)return;
  closeEditor();
  const isScaled=calibrated(s.page||1),edges=s.kind==='rect'?[
    {index:0,a:rectCorners(s)[0],b:rectCorners(s)[1]},
    {index:1,a:rectCorners(s)[1],b:rectCorners(s)[2]}
  ]:orderedEdges(s.points,true);
  const edge=edges.find(e=>e.index===Number(index));if(!edge)return;
  const measuredMm=isScaled?lineLengthMm([edge.a,edge.b],s.page||1):null;
  const manual=manualEdgeM(s,index);
  const panel=document.createElement('form');panel.className='sentlog-shape-dimension-editor';
  panel.setAttribute('role','dialog');panel.setAttribute('aria-label','変状の辺寸法を編集');
  panel.style.cssText='position:fixed;z-index:1210;width:238px;max-width:calc(100vw - 18px);background:#fff;border:1px solid #94a3b8;border-radius:12px;padding:12px;box-sizing:border-box;box-shadow:0 8px 28px rgba(0,0,0,.25);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;';
  const title=document.createElement('strong');title.textContent=isScaled?'辺の実寸を変更':'辺の寸法を記録';title.style.cssText='display:block;margin-bottom:8px;font-size:14px;';
  const label=document.createElement('label');label.textContent=isScaled?'辺の長さ（m）':'記録寸法（m）';label.style.cssText='display:block;font-size:12px;font-weight:700;margin-bottom:5px;';
  const input=document.createElement('input');input.type='number';input.inputMode='decimal';input.step='0.001';input.min='0.001';
  input.value=isScaled&&Number.isFinite(measuredMm)?(measuredMm/1000).toFixed(3):(manual==null?'':manual.toFixed(3));
  input.placeholder='例：0.800';input.style.cssText='width:100%;height:42px;box-sizing:border-box;padding:7px 9px;font-size:16px;border:1px solid #94a3b8;border-radius:7px;';
  const note=document.createElement('div');note.style.cssText='font-size:11px;line-height:1.55;color:#64748b;margin-top:7px;';
  note.textContent=isScaled?'縮尺設定済み：確定すると、この辺が入力した実寸になるよう変状形状を変更します。':'縮尺未設定：寸法値だけを記録します。入力しても変状の形・辺の長さは変わりません。';
  const error=document.createElement('div');error.setAttribute('role','alert');error.style.cssText='min-height:15px;margin-top:5px;font-size:11px;color:#b91c1c;';
  const row=document.createElement('div');row.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px;';
  const ok=document.createElement('button');ok.type='submit';ok.textContent='確定';ok.style.cssText='height:40px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;font-weight:700;';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='閉じる';cancel.style.cssText='height:40px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;';
  row.append(ok,cancel);panel.append(title,label,input,note,error,row);
  if(!isScaled&&manual!=null){
    const clear=document.createElement('button');clear.type='button';clear.textContent='この寸法記録を消す';clear.style.cssText='width:100%;height:38px;margin-top:8px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#475569;';
    clear.onclick=()=>{const current=sourceShape(id);if(current){clearManualEdge(current,index);closeEditor();}};panel.append(clear);
  }
  panel.addEventListener('pointerdown',e=>e.stopPropagation());cancel.onclick=()=>closeEditor();
  panel.onsubmit=e=>{
    e.preventDefault();const current=sourceShape(id);if(!current){closeEditor();return;}
    const v=Number(input.value),msg=isScaled?applyScaledEdge(current,index,v):applyManualEdge(current,index,v);
    if(msg){error.textContent=msg;return;}closeEditor();
  };
  document.body.appendChild(panel);editor=panel;
  const vw=window.visualViewport?.width||innerWidth,vh=window.visualViewport?.height||innerHeight;
  const left=event?.clientX!=null?event.clientX-110:vw/2-119,top=event?.clientY!=null?event.clientY-185:vh/2-150;
  panel.style.left=Math.max(9,Math.min(vw-247,left))+'px';panel.style.top=Math.max(9,Math.min(vh-250,top))+'px';
  input.focus();input.select();
}
function bindEdgeHit(hit,shape,index){
  hit.dataset.shapeDimensionHitId=shape.id;hit.dataset.edgeIndex=String(index);hit.style.cursor='pointer';hit.style.touchAction='none';
  hit.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;e.preventDefault();e.stopPropagation();});
  hit.addEventListener('pointerup',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;e.preventDefault();e.stopPropagation();openEdgeEditor(shape.id,index,e);});
}
function drawEdgeLabel(shape,a,b,center,index,preview=false){
  const place=edgeLabelPlacement(a,b,center,(preview?13:12)/z());if(!place)return;
  const data=preview?{text:(calibrated()?formatLengthMm(lineLengthMm([a,b],shape?.page||state.currentPage)):'')||'',placeholder:false}:edgeLengthText(shape,a,b,index);
  if(!data.text)return;
  drawText(data.text,place.x,place.y,place.angle,edgeColor(shape,preview,data.placeholder),{
    fontPx:preview?11:10.5,haloPx:2.5,weight:preview?'700':data.placeholder?'600':'650',
    className:'sentlog-shape-edge-dimension',shapeId:shape?.id||'preview',edgeIndex:index
  });
  if(!preview&&shape?.id){
    const hit=hitRectForLabel(place,data.text);bindEdgeHit(hit,shape,index);svg.appendChild(hit);
  }
}
function rectangleDimensionData(s){
  const pts=rectCorners(s),page=s.page||state.currentPage;
  const widthMm=calibrated(page)?lineLengthMm([pts[0],pts[1]],page):null;
  const heightMm=calibrated(page)?lineLengthMm([pts[1],pts[2]],page):null;
  return {pts,widthMm,heightMm,center:averagePoint(pts)};
}
function drawRectEdges(s,preview=false){
  const d=rectangleDimensionData(s);
  drawEdgeLabel(s,d.pts[0],d.pts[1],d.center,0,preview);
  drawEdgeLabel(s,d.pts[1],d.pts[2],d.center,1,preview);
}
function drawPolygonEdges(s){
  const pts=(s.points||[]).map(normPoint);if(pts.length<3)return;
  const center=averagePoint(pts);
  for(const e of orderedEdges(pts,true))drawEdgeLabel(s,e.a,e.b,center,e.index,false);
}
function representativeText(s){
  const page=s.page||1;if(isAuxiliary(s))return '';
  if(isConcreteCrack(s))return '';
  if(s.kind==='rect'){
    if(calibrated(page)){
      const d=rectangleDimensionData(s);
      return representativeFromMeasurements('rect',{widthMm:d.widthMm,heightMm:d.heightMm});
    }
    const w=manualEdgeM(s,0),h=manualEdgeM(s,1);
    return w!=null&&h!=null?w.toFixed(3)+' × '+h.toFixed(3)+' m':'';
  }
  if(!calibrated(page))return '';
  if(s.kind==='polygon'||s.kind==='freehand'||s.kind==='freehand-area'){
    const areaMm2=polygonAreaMm2(s.points,page);
    return representativeFromMeasurements(s.kind,{areaMm2});
  }
  if(s.kind==='line'||s.kind==='freehand-line'){
    const lengthMm=lineLengthMm(s.points,page);
    return representativeFromMeasurements(s.kind,{lengthMm});
  }
  return '';
}
function labelPaint(shape){
  try{
    const mode=root.SentlogDamageStyles?.getMode?.()||'hatch';
    const st=root.SentlogLabelColors?.labelStyle?.(shape.type,getProject?.(),mode,scale);
    return {color:st?.color||'#111827',halo:Number(st?.halo)||2.2/z()};
  }catch(_){return {color:'#111827',halo:2.2/z()};}
}
function drawRepresentative(s){
  const text=representativeText(s);if(!text)return;
  const lp=getLabelPos(s),base=typeof labelFontSize==='function'?labelFontSize():18/z(),font=Math.max(10.5,base*.80),paint=labelPaint(s);
  const t=makeEl('text',{x:lp.x,y:lp.y+base*1.02,'font-size':font,'text-anchor':'middle','dominant-baseline':'middle',
    fill:paint.color,'font-weight':'700','paint-order':'stroke fill',stroke:'#fff','stroke-width':paint.halo,
    'stroke-linejoin':'round','pointer-events':'none'});
  t.dataset.shapeSummaryId=s.id;t.textContent=text;svg.appendChild(t);
}
function eligibleShapes(){
  return (typeof currentShapes==='function'?currentShapes():state.shapes.filter(s=>(s.page||1)===state.currentPage)).filter(s=>!isAuxiliary(s));
}
function drawCompleted(){
  for(const s of eligibleShapes()){
    if(s.kind==='rect')drawRectEdges(s,false);
    else if(s.kind==='polygon')drawPolygonEdges(s);
    drawRepresentative(s);
  }
}
function drawRectPreview(){
  if(!calibrated()||tool!=='rect'||drawing?.kind!=='rect')return;
  const s={...drawing,page:state.currentPage,id:'preview-rect'};
  if(Math.abs(Number(s.w)||0)*z()<4||Math.abs(Number(s.h)||0)*z()<4)return;
  drawRectEdges(s,true);
}

const oldRender=render;
render=function(){
  const result=oldRender.apply(this,arguments);
  if(!previewDepth)drawCompleted();
  return result;
};
if(typeof renderPreview==='function'){
  const oldPreview=renderPreview;
  renderPreview=function(){
    previewDepth++;
    let result;
    try{result=oldPreview.apply(this,arguments);}finally{previewDepth--;}
    drawCompleted();drawRectPreview();
    return result;
  };
}
window.addEventListener('blur',closeEditor);window.addEventListener('pagehide',closeEditor);
document.addEventListener('visibilitychange',()=>{if(document.hidden)closeEditor();});

root.SentlogShapeDimensions={version:'v1.75',...pure,calibrated,representativeText,isEditing:()=>!!editor,openEdgeEditor};
if(typeof currentView!=='undefined'&&currentView==='editor')render();
})(typeof window==='object'?window:globalThis);

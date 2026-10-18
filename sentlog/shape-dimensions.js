/* Sentlog v1.74: completed-shape edge dimensions and representative values.
 * - Rectangles: horizontal + vertical side lengths, written parallel to the sides.
 * - Polygons: every stored edge, in vertex order (last edge closes back to the first).
 * - Damage labels: a second line with representative size/area, while concrete cracks
 *   keep the existing W=...mm line from crack-width.js.
 * Real-world values are shown only when page size + drawing scale are calibrated.
 * This module does not add stored fields or renumber/mutate existing records. */
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
  // Pick the normal that points away from the shape's centre.
  if(nx*(center.x-mid.x)+ny*(center.y-mid.y)>0){nx=-nx;ny=-ny;}
  let angle=Math.atan2(dy,dx)*180/Math.PI;
  if(angle>90)angle-=180;if(angle<-90)angle+=180;
  return {x:mid.x+nx*offset,y:mid.y+ny*offset,angle,len,nx,ny,mid};
}
function formatLengthMm(mm){
  const v=Number(mm);if(!Number.isFinite(v)||v<0)return '';
  return (v/1000).toFixed(3)+' m';
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
const pure={normPoint,rectCorners,orderedEdges,averagePoint,edgeLabelPlacement,formatLengthMm,formatAreaMm2,representativeFromMeasurements};
if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
if(!root.document||root.SentlogShapeDimensions)return;
if(typeof render!=='function'||typeof lineLengthMm!=='function'||typeof polygonAreaMm2!=='function')
  throw Error('変状寸法表示機能の読み込み順序が正しくありません。');

const svg=$('svg');
if(!svg)return;
const z=()=>Math.max(.001,Number(scale)||1);
let previewDepth=0;

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
function edgeColor(shape,preview=false){
  if(preview)return '#2563eb';
  return shape?.id===selected?'#1d4ed8':'#374151';
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
function edgeLengthText(a,b,page){
  const mm=lineLengthMm([a,b],page);return Number.isFinite(mm)?formatLengthMm(mm):'';
}
function drawEdgeLabel(shape,a,b,center,index,preview=false){
  const place=edgeLabelPlacement(a,b,center,(preview?13:12)/z());if(!place)return;
  const text=edgeLengthText(a,b,shape?.page||state.currentPage);if(!text)return;
  drawText(text,place.x,place.y,place.angle,edgeColor(shape,preview),{
    fontPx:preview?11:10.5,haloPx:2.5,weight:preview?'700':'650',
    className:'sentlog-shape-edge-dimension',shapeId:shape?.id||'preview',edgeIndex:index
  });
}
function rectangleDimensionData(s){
  const pts=rectCorners(s),page=s.page||state.currentPage;
  const widthMm=lineLengthMm([pts[0],pts[1]],page),heightMm=lineLengthMm([pts[1],pts[2]],page);
  return {pts,widthMm,heightMm,center:averagePoint(pts)};
}
function drawRectEdges(s,preview=false){
  const d=rectangleDimensionData(s);
  // One horizontal and one vertical value only; no W/H prefix, avoiding crack-width notation.
  drawEdgeLabel(s,d.pts[0],d.pts[1],d.center,0,preview);
  drawEdgeLabel(s,d.pts[1],d.pts[2],d.center,1,preview);
}
function drawPolygonEdges(s){
  const pts=(s.points||[]).map(normPoint);if(pts.length<3)return;
  const center=averagePoint(pts);
  for(const e of orderedEdges(pts,true))drawEdgeLabel(s,e.a,e.b,center,e.index,false);
}
function representativeText(s){
  const page=s.page||1;if(!calibrated(page)||isAuxiliary(s))return '';
  if(isConcreteCrack(s))return ''; // Existing W=...mm remains the crack-specific second line.
  if(s.kind==='rect'){
    const d=rectangleDimensionData(s);
    return representativeFromMeasurements('rect',{widthMm:d.widthMm,heightMm:d.heightMm});
  }
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
  if(!calibrated())return;
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

root.SentlogShapeDimensions={version:'v1.74',...pure,calibrated,representativeText};
if(typeof currentView!=='undefined'&&currentView==='editor')render();
})(typeof window==='object'?window:globalThis);

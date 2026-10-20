/* Isolated use of the actual annotation renderers; no project writes or sync. */
(function(){'use strict';
const input=window.sentlogExportInput;if(!input)return;
const C=window.SentlogDrawingExportCore;
const makeBlob=(canvas,type='image/png')=>new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('図面を画像化できません。')),type));
let fontData='';
const fontReady=(async()=>{
 const response=await fetch('./vendor/dxf-font.woff');if(!response.ok)throw Error('日本語の出力用フォントを取得できません。');
 const blob=await response.blob();fontData=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});
 const font=new FontFace('SentlogExportJP','url('+fontData+')');await font.load();document.fonts.add(font);
 const style=document.createElement('style');style.textContent='svg text,svg tspan{font-family:SentlogExportJP,sans-serif!important}';document.head.append(style);
})();
persist=()=>{};saveWorkspace=()=>{};updateActiveMeta=()=>{};
getDBFile=async key=>key==='background:'+input.drawing.id?input.file:null;
renderSelectedPhotos=async()=>{};
pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/export-pdf.worker.min.js';
// Full-sheet image backing stays bounded; editor viewport crops are not exported.
renderImage=async function(file){
 const url=URL.createObjectURL(file),image=new Image();
 try{
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('元の画像を開けません。'));image.src=url;});
  state.width=input.state.width>0?input.state.width:image.naturalWidth;state.height=input.state.height>0?input.state.height:image.naturalHeight;
  const size=C.pixels(state.width,state.height,842,842*state.height/state.width);canvas.width=size.width;canvas.height=size.height;
  canvas.style.width=state.width+'px';canvas.style.height=state.height+'px';svg.setAttribute('width',state.width);svg.setAttribute('height',state.height);svg.setAttribute('viewBox',`0 0 ${state.width} ${state.height}`);
  ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  empty.style.display='none';fit();render();updateScaleStatus();
 }finally{image.src='';URL.revokeObjectURL(url);}
};
const prepared=(async()=>{
 await fontReady;
 workspace={projects:[JSON.parse(JSON.stringify(input.project))]};activeProjectId=input.project.id;activeDrawingId=input.drawing.id;
 state=JSON.parse(JSON.stringify(input.state));state.currentPage=1;state.shapes=state.shapes||[];
 state.pageSettings=state.pageSettings||{};state.pdfPageInfo=state.pdfPageInfo||{};state.pageRotations=state.pageRotations||{};
 showEditor();await openFile(new File([input.file],input.state.fileName||input.drawing.fileName||input.file.name,{type:input.file.type}),false);
 if(empty.style.display!=='none'||!state.sourceType)throw Error(document.getElementById('errorBanner').textContent||'元図を開けません。');
 if(state.sourceType==='pdf'&&state.pageCount!==pdfDoc.numPages)throw Error('PDFのページ数を確認できません。');
 const count=state.sourceType==='pdf'?pdfDoc.numPages:1;
 if(state.shapes.some(s=>!Number.isInteger(Number(s.page||1))||Number(s.page||1)<1||Number(s.page||1)>count))throw Error('元図にないページの記録があります。図面を確認してください。');
 return {count,type:state.sourceType};
})();
// All style values must accompany the SVG when it is decoded as an image.
function svgCopy(){
 return SentlogDrawingMemos.captureForExport(input.includeMemos,()=>{
  scale=1;tx=ty=0;applyTransform();render();
  const copy=svg.cloneNode(true),originals=[svg,...svg.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];
  const props=['fill','fill-opacity','stroke','stroke-width','stroke-opacity','stroke-dasharray','stroke-linecap','stroke-linejoin','opacity','font-family','font-size','font-weight','font-style','text-anchor','dominant-baseline','paint-order','visibility','display'];
  originals.forEach((e,i)=>{const style=getComputedStyle(e);for(const prop of props){let value=style.getPropertyValue(prop);value=value.replace(/url\(["']?[^)#]*#([^)'"\s]+)["']?\)/g,'url(#$1)');if(value)copies[i].style.setProperty(prop,value);}});
  copy.querySelectorAll('[data-memo-ui]').forEach(e=>e.remove());copy.setAttribute('xmlns','http://www.w3.org/2000/svg');
  copy.querySelectorAll('[data-dxf-photo-count-id]').forEach(e=>{e.textContent=e.textContent.replace('📷','写真');});
  const font=document.createElementNS('http://www.w3.org/2000/svg','style');font.textContent='@font-face{font-family:SentlogExportJP;src:url("'+fontData+'")}';copy.prepend(font);
  copy.setAttribute('width',state.width);copy.setAttribute('height',state.height);copy.setAttribute('viewBox',`0 0 ${state.width} ${state.height}`);
  copy.style.width=state.width+'px';copy.style.height=state.height+'px';copy.style.transform='none';copy.style.overflow='hidden';
  return new XMLSerializer().serializeToString(copy);
 });
}
async function page(number){
 await prepared;
 if(state.sourceType==='pdf')await renderPdfPage(number);else if(number!==1)throw Error('ページ番号を確認できません。');
 await document.fonts.ready;
 const paper=getPaperMm(),width=(paper?.w||297)*72/25.4,height=(paper?.h||297*state.height/state.width)*72/25.4;
 const size=C.pixels(state.width,state.height,width,height),out=document.createElement('canvas');out.width=size.width;out.height=size.height;
 let url=null;try{
  const source=svgCopy(),image=new Image();url=URL.createObjectURL(new Blob([source],{type:'image/svg+xml;charset=utf-8'}));
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('書き込みを画像化できません。'));image.src=url;});
  const context=out.getContext('2d');context.drawImage(image,0,0,out.width,out.height);const overlay=await makeBlob(out);
  let background=null,box=null,rotation=0;
  if(state.sourceType==='pdf'){const p=await pdfDoc.getPage(number);box=Array.from(p.view);rotation=normalizeRotation((p.rotate||0)+getPageRotation(number));}
  else {
   context.fillStyle='white';context.fillRect(0,0,out.width,out.height);
   if(state.sourceType==='dxf'){
    const data=SentlogDxf.pdfBackground(out.width,out.height),bg=new Image();await new Promise((resolve,reject)=>{bg.onload=resolve;bg.onerror=reject;bg.src=data;});context.drawImage(bg,0,0,out.width,out.height);
   }else context.drawImage(canvas,0,0,out.width,out.height);
   background=await makeBlob(out);
  }
  return {page:number,paper:{width,height},box,rotation,overlay,background,pixels:size};
 }finally{if(url)URL.revokeObjectURL(url);out.width=out.height=1;}
}
window.SentlogExportRenderer={ready:prepared,page};
})();

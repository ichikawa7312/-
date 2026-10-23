"""v1.91: skip unused PDF painting and trim transparent overlay pixels losslessly.
Runs after the existing v1.90 build. Does not access user data or change sync.
"""
from pathlib import Path
import os, shutil
ROOT=Path(__file__).resolve().parents[1]

def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Export speed integration mismatch: {path}: {old[:90]!r}: {s.count(old)}')
 p.write_text(s.replace(old,new))

# Optional regression baseline; never include it in the published app artifact.
if os.environ.get('SENTLOG_EXPORT_BASELINE_DIR'):
 target=Path(os.environ['SENTLOG_EXPORT_BASELINE_DIR']).resolve()
 if target==ROOT or ROOT in target.parents:raise RuntimeError('Baseline must be outside the repository')
 shutil.copytree(ROOT,target,ignore=shutil.ignore_patterns('.git','test-results','node_modules'),dirs_exist_ok=False)

p='sentlog/drawing-export-renderer.js'
change(p,"pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/export-pdf.worker.min.js';", """pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/export-pdf.worker.min.js';
// PDF backgrounds are embedded from the original PDF by the parent, not this
// canvas. Keep the exact editor coordinate system without painting a throwaway
// background or scheduling a zoom-detail render. The interactive editor is unchanged.
renderPdfPage=async function(pageNo){
 const doc=pdfDoc;if(!doc)throw Error('元PDFを確認できません。');
 pageNo=Number(pageNo);
 if(!Number.isInteger(pageNo)||pageNo<1||pageNo>doc.numPages)throw Error('ページ番号を確認できません。');
 const page=await doc.getPage(pageNo),intrinsic=normalizeRotation(page.rotate||0);
 const base=page.getViewport({scale:1,rotation:intrinsic});
 const targetScale=Math.min(2.2,Math.max(1.35,1800/base.width));
 const viewport=page.getViewport({scale:targetScale,rotation:normalizeRotation(intrinsic+getPageRotation(pageNo))});
 state.currentPage=pageNo;state.pdfPageInfo=state.pdfPageInfo||{};
 state.pdfPageInfo[String(pageNo)]={wMm:base.width*25.4/72,hMm:base.height*25.4/72};
 state.width=Math.max(1,Math.round(viewport.width));state.height=Math.max(1,Math.round(viewport.height));
 canvas.width=canvas.height=1;
 canvas.style.width=state.width+'px';canvas.style.height=state.height+'px';
 svg.setAttribute('width',state.width);svg.setAttribute('height',state.height);
 svg.setAttribute('viewBox',`0 0 ${state.width} ${state.height}`);
 empty.style.display='none';selected=null;drawing=null;fit();render();
 updatePageUI();updateScaleStatus();updateRotationUI();
};""")
# Trim actual nontransparent pixels, not geometry guesses: strokes, marker heads,
# Japanese glyphs and effects all remain intact. Pixel density never decreases.
change(p,"let fontData='';", """async function trimmedOverlay(canvas){
 const w=canvas.width,h=canvas.height,ctx=canvas.getContext('2d');
 const rgba=ctx.getImageData(0,0,w,h).data;
 let left=w,top=h,right=-1,bottom=-1;
 for(let y=0;y<h;y++)for(let x=0,i=(y*w)*4+3;x<w;x++,i+=4){
  if(rgba[i]!==0){if(x<left)left=x;if(x>right)right=x;if(y<top)top=y;if(y>bottom)bottom=y;}
 }
 if(right<left)return {overlay:null,overlayBounds:null};
 // Keep a transparent pixel border so interpolation at the crop boundary is unchanged.
 left=Math.max(0,left-2);top=Math.max(0,top-2);right=Math.min(w-1,right+2);bottom=Math.min(h-1,bottom+2);
 const bounds={x:left,y:top,width:right-left+1,height:bottom-top+1};
 if(bounds.width*bounds.height>=w*h*.9)return {overlay:await makeBlob(canvas),overlayBounds:null};
 const cropped=document.createElement('canvas');cropped.width=bounds.width;cropped.height=bounds.height;
 try{
  cropped.getContext('2d').putImageData(ctx.getImageData(left,top,bounds.width,bounds.height),0,0);
  return {overlay:await makeBlob(cropped),overlayBounds:bounds};
 }finally{cropped.width=cropped.height=1;}
}
let fontData='';""")
change(p,"  const copy=svg.cloneNode(true),originals=[svg,...svg.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];", """  // A genuinely empty annotation layer does not need font serialization or PNG encoding.
  // Unknown/complex graphic elements conservatively count as content.
  const paint=svg.querySelectorAll('path,rect,line,polyline,polygon,circle,ellipse,text,image,use,foreignObject');
  if(!Array.from(paint).some(e=>!e.closest('defs,marker,clipPath,mask,pattern,symbol')&&!e.closest('[data-memo-ui]')))return null;
  const copy=svg.cloneNode(true),originals=[svg,...svg.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];""")
change(p," if(state.sourceType==='pdf')await renderPdfPage(number);else if(number!==1)throw Error('ページ番号を確認できません。');", " if(state.sourceType==='pdf'){if(state.currentPage!==number)await renderPdfPage(number);}else if(number!==1)throw Error('ページ番号を確認できません。');")
old="""  const source=svgCopy(),image=new Image();url=URL.createObjectURL(new Blob([source],{type:'image/svg+xml;charset=utf-8'}));
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('書き込みを画像化できません。'));image.src=url;});
  const context=out.getContext('2d');context.drawImage(image,0,0,out.width,out.height);const overlay=await makeBlob(out);"""
new="""  const source=svgCopy(),context=out.getContext('2d');let overlay=null,overlayBounds=null;
  if(source){
   const image=new Image();url=URL.createObjectURL(new Blob([source],{type:'image/svg+xml;charset=utf-8'}));
   await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('書き込みを画像化できません。'));image.src=url;});
   context.drawImage(image,0,0,out.width,out.height);
   ({overlay,overlayBounds}=await trimmedOverlay(out));image.src='';
  }"""
change(p,old,new)
change(p,'rotation,overlay,background,pixels:size','rotation,overlay,overlayBounds,background,pixels:size')

p='sentlog/drawing-export-core.js'
old=" const overlay=await doc.embedPng(new Uint8Array(await info.overlay.arrayBuffer()));page.drawImage(overlay,{x:0,y:0,width:W,height:H});"
new=""" if(info.overlay){
  const image=await doc.embedPng(new Uint8Array(await info.overlay.arrayBuffer()));
  const b=info.overlayBounds,p=info.pixels;
  if(b){
   if(!p||![b.x,b.y,b.width,b.height,p.width,p.height].every(Number.isFinite)||b.x<0||b.y<0||b.width<=0||b.height<=0||p.width<=0||p.height<=0||b.x+b.width>p.width||b.y+b.height>p.height)throw Error('書き込み画像の位置を確認できません。');
   page.drawImage(image,{x:b.x/p.width*W,y:(p.height-b.y-b.height)/p.height*H,width:b.width/p.width*W,height:b.height/p.height*H});
  }else page.drawImage(image,{x:0,y:0,width:W,height:H});
 }"""
change(p,old,new)

# More useful progress during initialization and final PDF serialization.
p='sentlog/drawing-export.js'
change(p,'async function createPdf(item,onPage){','async function createPdf(item,onPage,onStage=()=>{}){')
change(p,' check();unchanged(item);\n const file='," check();unchanged(item);onStage('元図と書き込みを準備しています…');\n const file=")
change(p,"  unchanged(item);return {blob:new Blob([await doc.save()],{type:'application/pdf'}),pages:info.count};", "  unchanged(item);onStage('PDFをまとめています…');return {blob:new Blob([await doc.save()],{type:'application/pdf'}),pages:info.count};")
change(p,"const result=await createPdf(item,(page,count)=>onProgress(`${i+1}/${items.length} 図面：${item.drawing.name}（${page}/${count}ページ）`));", "const result=await createPdf(item,(page,count)=>onProgress(`${i+1}/${items.length} 図面：${item.drawing.name}（${page}/${count}ページ）`),stage=>onProgress(`${i+1}/${items.length} 図面：${item.drawing.name}：${stage}`));")
# Keep one isolated frame per drawing: sharing mutable editor state between
# drawings would risk mixing records. No changes to file verification or ZIP.
for name in ['sentlog/drawing-export.js','sentlog/drawing-export-core.js']:
 f=ROOT/name;s=f.read_text().replace('v1.88','v1.91').replace('drawing-export-view.html?v=188','drawing-export-view.html?v=191');f.write_text(s)
for name in ['sentlog/index.html','sentlog/drawing-export-view.html']:
 f=ROOT/name;s=f.read_text()
 for module in ['drawing-export','drawing-export-core','drawing-export-frame','drawing-export-renderer']:
  s=s.replace(module+'.js?v=188',module+'.js?v=191')
 s=s.replace('SentlogDrawingExport v1.88','SentlogDrawingExport v1.91')
 s=s.replace('phone-runtime.js?v=190','phone-runtime.js?v=191').replace("'v1.90'","'v1.91'")
 f.write_text(s)
for name in ['sentlog/phone-runtime.js','sentlog-pc/index.html']:
 f=ROOT/name;f.write_text(f.read_text().replace('v1.90','v1.91'))
change('sentlog/sw.js','sentlog-pwa-v201','sentlog-pwa-v202')
# Existing regression assertions retain their meaning; only release markers change.
for f in (ROOT/'tests').iterdir():
 if f.suffix not in ('.py','.cjs') or f.name.startswith('drawing_export_speed'):continue
 s=f.read_text().replace('v1.90','v1.91').replace('phone-runtime.js?v=190','phone-runtime.js?v=191').replace(r'phone-runtime\.js\?v=190',r'phone-runtime\.js\?v=191').replace('sentlog-pwa-v201','sentlog-pwa-v202')
 for module in ['drawing-export','drawing-export-core','drawing-export-frame','drawing-export-renderer']:
  s=s.replace(module+'.js?v=188',module+'.js?v=191')
 f.write_text(s)
print('Built v1.91: original PDF vectors, unchanged annotation resolution, lossless transparent trimming; no sync/data changes')

/* DXF referenced TIF/PNG/JPEG preview. Original DXF and annotations stay untouched. */
(function(root){'use strict';
const R=root.SentlogDxfImageRefs;
if(!R)throw Error('DXF image reference parser is missing');
const $=id=>document.getElementById(id);
const stage=$('stage'),wrap=$('stageWrap'),svg=stage.querySelector('svg');
let drawingId=null,refs=[],images=new Map(),overlay=null,modal=null,serial=0;
const key=(id,handle)=>'dxf-raster:'+id+':'+handle;
const active=()=>currentView==='editor'&&state.sourceType==='dxf'&&drawingId===activeDrawingId&&state.dxf?.frame;
const dom=(tag,value)=>{const e=document.createElement(tag);if(value!=null)e.textContent=value;return e;};
function clear(){serial++;drawingId=null;refs=[];images.clear();overlay?.remove();overlay=null;modal?.remove();modal=null;button.hidden=true;}
async function loadTif(){
 if(root.UTIF)return root.UTIF;
 await new Promise((resolve,reject)=>{const script=dom('script');script.src='./vendor/UTIF.js?v=310';script.onload=resolve;script.onerror=()=>reject(Error('TIF表示機能を読み込めません。オンラインで更新してください。'));document.head.append(script);});
 if(!root.UTIF)throw Error('TIFライブラリを利用できません。');
 return root.UTIF;
}
async function pngFor(file){
 const tiff=/\.(tif|tiff)$/i.test(file.name||'')||/tiff/i.test(file.type||'');
 if(!tiff){if(!/^image\/(png|jpeg|webp)$/i.test(file.type||'')&&!/\.(png|jpe?g|webp)$/i.test(file.name||''))throw Error('TIF、PNG、JPEG、WebPファイルを選択してください。');return file;}
 const UTIF=await loadTif(),buf=await file.arrayBuffer(),pages=UTIF.decode(buf);
 if(!pages.length)throw Error('TIFに画像がありません。');
 const page=pages[0];UTIF.decodeImage(buf,page);
 const w=page.width,h=page.height;
 if(!(w>0&&h>0)||w*h>40000000)throw Error('TIFが大きすぎます（4,000万画素以下にしてください）。');
 const canvas=dom('canvas');canvas.width=w;canvas.height=h;
 canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(page)),w,h),0,0);
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(v=>v?resolve(v):reject(Error('TIFを変換できませんでした。')),'image/png'));
 if(blob.size>25*1024*1024)throw Error('表示用画像が25MBを超えています。画像を分割してください。');
 return new File([blob],file.name.replace(/\.(tif|tiff)$/i,'.png'),{type:'image/png'});
}
async function drawable(blob){
 if(typeof createImageBitmap==='function')return createImageBitmap(blob);
 const url=URL.createObjectURL(blob);
 try{return await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('画像を開けませんでした。'));img.src=url;});}
 finally{URL.revokeObjectURL(url);}
}
function refresh(){
 if(!active()||!overlay)return;
 const frame=state.dxf.frame,rect=wrap.getBoundingClientRect(),k=frame.unitsPerPixel;
 if(!(rect.width>0&&rect.height>0&&k>0&&scale>0))return;
 const pixelRatio=Math.min(2,devicePixelRatio||1);
 overlay.style.width=rect.width+'px';overlay.style.height=rect.height+'px';
 const w=Math.round(rect.width*pixelRatio),h=Math.round(rect.height*pixelRatio);
 if(overlay.width!==w)overlay.width=w;if(overlay.height!==h)overlay.height=h;
 const ctx=overlay.getContext('2d');ctx.clearRect(0,0,w,h);
 for(const ref of refs){
  const img=images.get(ref.handle);if(!img||!ref.shown)continue;
  const originX=ref.insert.x+ref.v.x*ref.height,originY=ref.insert.y+ref.v.y*ref.height;
  const a=ref.u.x/k*scale,b=-ref.u.y/k*scale,c=-ref.v.x/k*scale,d=ref.v.y/k*scale;
  const e=(originX-frame.xMin)/k*scale+tx,f=(frame.yMax-originY)/k*scale+ty;
  ctx.save();ctx.setTransform(a*pixelRatio,b*pixelRatio,c*pixelRatio,d*pixelRatio,e*pixelRatio,f*pixelRatio);
  ctx.drawImage(img,0,0,ref.width,ref.height);ctx.restore();
 }
}
async function loadDrawing(file){
 clear();if(!file||state.sourceType!=='dxf')return;
 const token=serial,id=activeDrawingId;
 let found;
 try{found=R.references(new Uint8Array(await file.arrayBuffer()));}catch(e){console.warn('DXF reference parsing',e);return;}
 if(token!==serial||id!==activeDrawingId)return;
 drawingId=id;refs=found;button.hidden=!refs.length;
 if(!refs.length)return;
 overlay=dom('canvas');overlay.style.cssText='position:absolute;left:0;top:0;pointer-events:none;z-index:1';
 stage.insertBefore(overlay,svg);
 const metadata=state.dxf?.rasterRefs||{};
 for(const ref of refs){
  if(!metadata[ref.handle])continue;
  const blob=await getDBFile(key(id,ref.handle)).catch(()=>null);
  if(token!==serial)return;
  if(!(blob instanceof Blob))continue;
  try{images.set(ref.handle,await drawable(blob));}catch(e){console.warn('DXF raster image decode',e);}
 }
 refresh();
}
async function attach(ref,file){
 const id=drawingId,token=serial,converted=await pngFor(file);
 if(token!==serial||id!==activeDrawingId)throw Error('図面が切り替わりました。');
 await putDBFile(key(id,ref.handle),converted);
 const bitmap=await drawable(converted);
 if(token!==serial||id!==activeDrawingId)return;
 images.set(ref.handle,bitmap);
 state.dxf.rasterRefs={...(state.dxf.rasterRefs||{}),[ref.handle]:{name:file.name,fileName:converted.name,size:converted.size,mime:converted.type||'image/png'}};
 persist();refresh();openDialog();
}
function openDialog(){
 if(!active()||!refs.length)return;
 modal?.remove();modal=dom('div');modal.className='sl-dxf-modal';
 const card=dom('div');card.className='sl-dxf-card';card.append(dom('h2','DXF参照画像'));
 card.append(dom('p','画像を選択すると元CADの座標に重ねます。TIFは表示用PNGに変換し、元のDXFと損傷記録は変更しません。'));
 for(const ref of refs){
  const row=dom('div');row.style.cssText='border-top:1px solid #ddd;padding:10px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
  const title=dom('span',(ref.name||('参照 '+ref.handle))+'　'+(images.has(ref.handle)?'表示中':'未設定'));title.style.flex='1';row.append(title);
  const input=dom('input');input.type='file';input.accept='.tif,.tiff,.png,.jpg,.jpeg,.webp,image/tiff,image/png,image/jpeg,image/webp';input.hidden=true;
  const choose=dom('button',images.has(ref.handle)?'変更':'画像を選択');choose.onclick=()=>input.click();
  input.onchange=async()=>{const file=input.files?.[0];if(!file)return;choose.disabled=true;try{await attach(ref,file);}catch(e){alert('画像を設定できません：'+e.message);choose.disabled=false;}};
  row.append(choose,input);card.append(row);
 }
 const close=dom('button','閉じる');close.onclick=()=>{modal?.remove();modal=null;};
 card.append(close);modal.append(card);document.body.append(modal);
}
const button=dom('button','参照画像');button.id='dxfRasterBtn';button.hidden=true;
$('dxfInfoBtn')?.parentElement.append(button);button.onclick=openDialog;
const priorOpen=openFile;openFile=async function(){const result=await priorOpen.apply(this,arguments);if(state.sourceType==='dxf')await loadDrawing(arguments[0]);else clear();return result;};
const priorTransform=applyTransform;applyTransform=function(){const result=priorTransform.apply(this,arguments);refresh();return result;};
const priorProjects=showProjects;showProjects=function(){clear();return priorProjects.apply(this,arguments);};
const priorDrawings=showDrawings;showDrawings=function(){clear();return priorDrawings.apply(this,arguments);};
function collect(project){
 const output=[];
 for(const d of project?.drawings||[]){
  let s;try{s=JSON.parse(root.SentlogRecords.getItem(drawingStorageKey(d.id))||'null');}catch{}
  if(s?.sourceType!=='dxf')continue;
  for(const [handle,item] of Object.entries(s.dxf?.rasterRefs||{})){
   if(!/^[0-9a-f]+$/i.test(handle))continue;
   output.push({drawingId:d.id,handle,...item});
  }
 }
 return output;
}
function received(id,handle){
 if(drawingId!==id)return;
 getDBFile(key(id,handle)).then(async file=>{if(file instanceof Blob){images.set(handle,await drawable(file));refresh();}}).catch(e=>console.warn(e));
}
root.SentlogDxfRaster={version:1,collect,received,refresh};
})(window);

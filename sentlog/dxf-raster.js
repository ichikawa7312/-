/* CAD reference images: kept apart from source DXF and inspection annotations. */
(function(root){'use strict';
if(root.SentlogDxfRaster||!root.document)return;
const C=root.SentlogDxfRasterCore;
if(!C)throw Error('CAD画像座標ライブラリを読み込めません。');
const $=id=>document.getElementById(id);
const KEY=(id,handle)=>'dxf-raster:'+id+':'+handle;
const suffix=f=>String(f?.name||'').toLowerCase().split('.').pop();
const isTiff=f=>['tif','tiff'].includes(suffix(f))||/^image\/(?:x-)?tiff$/i.test(f?.type||'');
const supported=f=>['tif','tiff','png','jpg','jpeg','webp'].includes(suffix(f))||/^image\/(?:tiff|png|jpeg|webp)$/i.test(f?.type||'');
const imageType=f=>isTiff(f)?'image/tiff':({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'}[suffix(f)]||f?.type||'application/octet-stream');
const el=(tag,txt)=>{const e=document.createElement(tag);if(txt!=null)e.textContent=txt;return e;};
let active=null,canvas=null,viewport=null,raf=0,modal=null,importing=false;
const scripts=new Map();
function load(src){
 if(scripts.has(src))return scripts.get(src);
 const promise=new Promise((resolve,reject)=>{const s=el('script');s.src=src;s.onload=resolve;s.onerror=()=>{s.remove();reject(Error('TIF表示ライブラリを読み込めません。オンラインで画面を更新してください。'));};document.head.append(s);});
 scripts.set(src,promise);return promise;
}
async function decode(file){
 if(!(file instanceof Blob)||!supported(file))throw Error('TIF・PNG・JPEG・WebP画像を選択してください。');
 if(isTiff(file)){
   await load('./vendor/pako.min.js?v=1.0.11');
   await load('./vendor/UTIF.js?v=3.1.0');
   const data=await file.arrayBuffer(),pages=root.UTIF?.decode(data);
   if(!pages?.length)throw Error('TIFファイルを読み取れません。');
   const page=pages[0],width=Number(page.t256?.[0]),height=Number(page.t257?.[0]);
   if(!(width>0&&height>0&&width*height<=24000000))throw Error('TIF画像の画素数が上限を超えています（2400万画素）。');
   root.UTIF.decodeImage(data,page,pages);
   const rgba=root.UTIF.toRGBA8(page);
   if(rgba.length!==width*height*4)throw Error('TIFの画素情報が不完全です。');
   const image=el('canvas');image.width=width;image.height=height;
   image.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),width,height),0,0);
   return {image,width,height,dispose(){}};
 }
 if(root.createImageBitmap){
   const image=await root.createImageBitmap(file);
   if(image.width*image.height>24000000){image.close();throw Error('画像が大きすぎます。');}
   return {image,width:image.width,height:image.height,dispose(){image.close();}};
 }
 const url=URL.createObjectURL(file);
 try{
   const image=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('画像を開けません。'));i.src=url;});
   const width=image.naturalWidth,height=image.naturalHeight;
   if(width*height>24000000)throw Error('画像が大きすぎます。');
   return {image,width,height,dispose(){image.src='';}};
 }finally{URL.revokeObjectURL(url);}
}
function updateButton(){
 button.hidden=!active||!active.parsed.references.length;
 if(active){
   const count=active.parsed.references.length,ready=active.parsed.references.filter(r=>active.images.has(r.handle)).length;
   button.textContent='参照画像 '+ready+'/'+count;
 }
}
function closed(){
 if(raf)cancelAnimationFrame(raf);raf=0;
 for(const image of active?.images.values()||[])image.dispose();
 active=null;canvas?.remove();canvas=null;viewport=null;modal?.remove();modal=null;updateButton();
}
function draw(){
 raf=0;if(!active||!viewport||!canvas)return;
 const v=viewport,pixel=Math.max(0.75,Math.min(2,v.devicePixelRatio||1)),w=Math.round(v.width*pixel),h=Math.round(v.height*pixel);
 if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
 canvas.style.width=v.width+'px';canvas.style.height=v.height+'px';
 const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,w,h);
 for(const p of active.parsed.placements){
   if(!p.visible)continue;
   const image=active.images.get(p.handle);if(!image)continue;
   const m=C.imageTransform(p,active.frame,v,image.width,image.height);
   ctx.save();ctx.setTransform(pixel*m.a,pixel*m.b,pixel*m.c,pixel*m.d,pixel*m.e,pixel*m.f);
   if(p.clipEnabled&&p.clip.length>=2&&!p.clipOutside){
     const pts=p.clipType===1&&p.clip.length===2?
       [{x:p.clip[0].x,y:p.clip[0].y},{x:p.clip[1].x,y:p.clip[0].y},{x:p.clip[1].x,y:p.clip[1].y},{x:p.clip[0].x,y:p.clip[1].y}]:p.clip;
     ctx.beginPath();
     pts.forEach((q,i)=>{const x=(q.x+0.5)*image.width/p.width,y=image.height-(q.y+0.5)*image.height/p.height;if(!i)ctx.moveTo(x,y);else ctx.lineTo(x,y);});
     ctx.closePath();ctx.clip();
   }
   ctx.drawImage(image.image,0,0,image.width,image.height);
   ctx.restore();
 }
}
function redraw(){if(!raf)raf=requestAnimationFrame(draw);}
function viewChanged(v){viewport=v;redraw();}
async function refresh(id){
 const a=active;if(!a||a.id!==id)return;
 for(const ref of a.parsed.references){
   if(a!==active)return;
   if(a.images.has(ref.handle))continue;
   const file=await root.getDBFile(KEY(a.id,ref.handle));
   if(!(file instanceof Blob))continue;
   try{const image=await decode(file);if(a!==active){image.dispose();return;}a.images.set(ref.handle,image);a.errors.delete(ref.handle);}
   catch(e){a.errors.set(ref.handle,e.message);console.warn('DXF raster decode',ref.fileName,e);}
 }
 updateButton();redraw();
}
async function opened({drawingId,bytes,frame}){
 closed();if(!drawingId||!bytes)return;
 const parsed=C.parse(bytes);
 active={id:drawingId,frame,parsed,images:new Map(),errors:new Map()};
 if(parsed.references.length){
   canvas=el('canvas');canvas.style.cssText='position:absolute;top:0;left:0;pointer-events:none;';
   $('stage').insertBefore(canvas,$('svg'));
 }
 updateButton();await refresh(drawingId);
}
async function attach(ref,file){
 if(!active||!supported(file))throw Error('TIF・PNG・JPEG・WebP画像を選択してください。');
 if(file.size>25*1024*1024)throw Error('参照画像は25MB以下にしてください。');
 const id=active.id,key=KEY(id,ref.handle);
 const decoded=await decode(file); // Validate before any persistent write.
 if(active?.id!==id){decoded.dispose();throw Error('別の図面に切り替わりました。');}
 const old=await root.getDBFile(key);
 if(old instanceof Blob&&old.size&&!confirm('この参照画像を変更しますか？ 端末間で内容が異なる場合は自動上書きしません。')){decoded.dispose();return false;}
 const named=new File([file],C.basename(file.name)||ref.fileName,{type:imageType(file),lastModified:file.lastModified||Date.now()});
 try{
   await root.putDBFile(key,named);
   const stored=await root.getDBFile(key);
   if(!(stored instanceof Blob)||stored.size!==named.size)throw Error('端末保存の確認に失敗しました。');
 }catch(e){decoded.dispose();throw e;}
 if(active?.id===id){
   active.images.get(ref.handle)?.dispose();
   active.images.set(ref.handle,decoded);active.errors.delete(ref.handle);updateButton();redraw();
 }else decoded.dispose();
 return true;
}
function openModal(){
 const a=active;if(!a?.parsed.references.length)return;
 modal?.remove();modal=el('div');modal.className='sl-dxf-raster-modal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
 const content=el('section');content.className='sl-dxf-raster-card';
 content.append(el('h2','DXF参照画像'),el('p','TIFなどの画像はDXFとは別ファイルです。対応する画像を選ぶと、元のCAD座標・縮尺・角度で表示します。DXF・変状記録は変更しません。'));
 const summary=el('p');summary.setAttribute('role','status');summary.className='sl-dxf-raster-status';
 const bulk=el('input');bulk.type='file';bulk.multiple=true;bulk.accept='.tif,.tiff,.png,.jpg,.jpeg,.webp,image/tiff';bulk.style.maxWidth='100%';
 content.append(el('p','複数選択（CADの参照名と同じファイルを自動照合）'),bulk);
 const rows=el('div');rows.className='sl-dxf-raster-rows';
 async function add(files,only){
   if(importing)return;importing=true;summary.textContent='保存中…';let done=0,unmatched=[];
   try{
     for(const f of files){
       if(active!==a)throw Error('別の図面に切り替わりました。');
       const refs=only?[only]:a.parsed.references.filter(ref=>ref.fileName.toLocaleLowerCase()===C.basename(f.name).toLocaleLowerCase());
       if(!refs.length){unmatched.push(f.name);continue;}
       for(const ref of refs)if(await attach(ref,f))done++;
     }
     summary.textContent=done+'件保存しました。'+(unmatched.length?'参照名が違う画像：'+unmatched.join('、')+'。個別に指定してください。':'');
   }catch(e){summary.textContent='保存未完了：'+e.message;}
   finally{importing=false;bulk.value='';renderRows();}
 }
 function renderRows(){
   rows.replaceChildren();
   for(const ref of a.parsed.references){
     const row=el('div');row.className='sl-dxf-raster-row';
     const label=el('span',(a.images.has(ref.handle)?'✓ ':'未設定：')+(ref.fileName||'画像 '+ref.handle));
     const one=el('input');one.type='file';one.accept=bulk.accept;one.setAttribute('aria-label',ref.fileName+' の画像ファイル');
     one.onchange=async()=>{if(one.files?.[0])await add([one.files[0]],ref);};
     row.append(label,one);if(a.errors.has(ref.handle))row.append(el('small','表示エラー：'+a.errors.get(ref.handle)));
     rows.append(row);
   }
 }
 renderRows();bulk.onchange=async()=>add([...bulk.files],null);
 const done=el('button','閉じる');done.type='button';done.onclick=()=>{modal?.remove();modal=null;};
 content.append(rows,summary,done);modal.append(content);document.body.append(modal);
}
const button=el('button','参照画像');button.id='dxfRasterBtn';button.type='button';button.hidden=true;button.onclick=openModal;
$('memoPdfBtn')?.parentElement?.append(button);
const style=el('style');
style.textContent=[
'#sentlogDrawingToolbar #dxfRasterBtn{width:auto!important;min-width:110px;flex:0 0 auto;font-size:12px;padding:6px 9px}',
'.sl-dxf-raster-modal{position:fixed;inset:0;z-index:10030;background:#0008;display:grid;place-items:center;padding:16px}',
'.sl-dxf-raster-card{box-sizing:border-box;background:#fff;color:#111827;border-radius:14px;padding:20px;width:min(560px,100%);max-height:88vh;overflow:auto}',
'.sl-dxf-raster-card h2{font-size:18px}.sl-dxf-raster-card p{font-size:13px;line-height:1.6}',
'.sl-dxf-raster-rows{max-height:36vh;overflow:auto;border:1px solid #d1d5db;border-radius:10px}',
'.sl-dxf-raster-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;font-size:12px;overflow-wrap:anywhere;border-bottom:1px solid #eee}',
'.sl-dxf-raster-row input{max-width:200px}.sl-dxf-raster-row small,.sl-dxf-raster-status{color:#b91c1c}.sl-dxf-raster-card button{min-height:44px;padding:8px 14px}'
].join('');
document.head.append(style);
async function cloudSyncProject({project,cloudProject,deviceId,knownAssets,ops}){
 let count=0;
 for(const drawing of project.drawings||[]){
   if(drawing.sourceType!=='dxf'&&!/\.dxf$/i.test(drawing.fileName||''))continue;
   const source=await ops.dbGet('background:'+drawing.id);
   if(!(source instanceof Blob)||source.size>8*1024*1024)continue;
   const refs=C.parse(new Uint8Array(await source.arrayBuffer())).references;
   for(const ref of refs){
     const key=KEY(drawing.id,ref.handle),clientKey='cad-raster:'+drawing.id+':'+ref.handle;
     const remote=knownAssets.get(clientKey),local=await ops.dbGet(key);
     if(remote?.status==='storage_deleted')throw Error((ref.fileName||'画像')+'のクラウド原本が削除されています。');
     if(local instanceof Blob){
       const hash=(await ops.sha256Hex(local)).toLowerCase();
       if(remote){
         if(hash!==String(remote.sha256||'').toLowerCase()||local.size!==Number(remote.byte_size))
           throw Error((ref.fileName||'画像')+'が端末とクラウドで異なります。上書きを停止しました。');
         continue;
       }
       if(local.size>25*1024*1024)throw Error(ref.fileName+'は25MB超のため同期できません。');
       if(!supported(local))throw Error(ref.fileName+'の画像形式が不明です。');
       await ops.uploadAsset({cloudProject,deviceId,clientKey,kind:'other',fileName:local.name||ref.fileName||'cad-reference.tif',
         blob:local,storageFolder:'cad-references',
         metadata:{source_type:'cad-raster',drawing_id:drawing.id,drawing_name:drawing.name||'',dxf_image_handle:ref.handle}});
       count++;continue;
     }
     if(!remote)continue;
     let full=remote;
     if(!full.storage_path||!full.file_name||!full.mime_type){
       const all=await ops.readProjectAssets(cloudProject.id,'id,client_key,kind,file_name,storage_path,mime_type,byte_size,sha256,status,metadata');
       full=all.find(x=>x.client_key===clientKey);
     }
     if(!full?.storage_path)throw Error('参照画像のクラウド情報が不足しています。');
     const downloaded=await ops.downloadPrivateAsset(full);
     if(await ops.dbGet(key) instanceof Blob)continue; // Concurrent import wins.
     const named=new File([downloaded],full.file_name||ref.fileName||'cad-reference.tif',{type:full.mime_type||'image/tiff'});
     await ops.dbPut(key,named);
     const saved=await ops.dbGet(key);
     if(!(saved instanceof Blob)||saved.size!==downloaded.size||(await ops.sha256Hex(saved)).toLowerCase()!==String(full.sha256).toLowerCase())
       throw Error('参照画像を端末に保存できませんでした。');
     count++;refresh(drawing.id).catch(e=>console.warn('DXF raster refresh',e));
   }
 }
 return count;
}
root.SentlogDxfRaster={opened,closed,viewChanged,refresh,cloudSyncProject,isEditing:()=>importing||!!modal,
 get references(){return active?.parsed.references.map(r=>({handle:r.handle,fileName:r.fileName,ready:active.images.has(r.handle)}))||[];}};
updateButton();
})(window);
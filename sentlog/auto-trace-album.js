/* Sentlog automatic drawing source-photo album.
 * Standalone evidence in drawing.autoTracePhotos, never shape.photos until explicitly selected.
 * Only the source device retains original bytes; a lightweight copy uses the existing photo
 * IDB keys, project snapshot and verified cloud/PC photo pipeline.
 */
(function(root){
'use strict';
if(!root.document||root.SentlogAutoTraceAlbum)return;
const $=id=>document.getElementById(id);
const ALBUM='自動描写';
let dialog=null,preview=null,urls=[],captureBusy=false,styleAdded=false;
function el(tag,cls,txt){
 const node=document.createElement(tag);
 if(cls)node.className=cls;
 if(txt!==undefined)node.textContent=String(txt);
 return node;
}
function makeButton(text,fn,cls=''){
 const b=el('button',cls,text);b.type='button';b.onclick=fn;return b;
}
function id(){return typeof uid==='function'?uid():(root.crypto?.randomUUID?.()||'trace-photo-'+Date.now());}
function validPhoto(file){return file instanceof Blob && /^image\//.test(file.type||'');}
function listForDrawing(st){
 return Array.isArray(st?.autoTracePhotos)?st.autoTracePhotos.filter(p=>p&&typeof p.id==='string'&&p.id):[];
}
function readState(drawingId){
 if(drawingId===activeDrawingId&&currentView==='editor')return state;
 try{return JSON.parse(root.SentlogRecords?.getItem(drawingStorageKey(drawingId))||'null');}
 catch{return null;}
}
function projectPhotos(project){
 const groups=new Map();
 for(const d of project?.drawings||[]){
   const gid=String(d.groupId||d.id),name=String(d.groupName||d.name||'図面No.');
   if(!groups.has(gid))groups.set(gid,{id:gid,name,sheets:new Map(),count:0});
   const group=groups.get(gid);
   const rows=listForDrawing(readState(d.id));
   if(!rows.length)continue;
   group.sheets.set(d.id,{drawingId:d.id,name:d.sheetName||d.name||'シート',rows});
   group.count+=rows.length;
 }
 return [...groups.values()].filter(g=>g.count);
}
function countPhotos(project){return projectPhotos(project).reduce((sum,g)=>sum+g.count,0);}
function style(){
 if(styleAdded)return;styleAdded=true;
 const s=el('style');s.id='slAutoTraceAlbumStyle';s.textContent=[
 '.sl-album-actions{flex-wrap:wrap}',
 '.sl-album-actions .sl-album-action{color:#155e75;border-color:#99d5db;background:#effdfd}',
 '@media(max-width:520px){.sl-album-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.sl-album-actions button{width:100%!important;min-width:0!important;white-space:normal;padding:7px 4px}}',
 '.sl-album-backdrop{position:fixed;inset:0;z-index:1600;background:rgba(15,23,42,.8);display:flex;align-items:center;justify-content:center;padding:calc(max(12px,env(safe-area-inset-top,0px)) + 6px) 10px calc(max(12px,env(safe-area-inset-bottom,0px)) + 6px);box-sizing:border-box}',
 '.sl-album-modal{width:min(850px,100%);max-height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#0f172a;border-radius:12px;padding:12px;box-sizing:border-box;gap:8px;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
 '.sl-album-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex:0 0 auto}',
 '.sl-album-header strong{font-size:17px}',
 '.sl-album-header button,.sl-album-photo button{min-height:44px;padding:7px 10px}',
 '.sl-album-scroll{flex:1;min-height:80px;overflow:auto;overscroll-behavior:contain}',
 '.sl-album-group{border:1px solid #cbd5e1;border-radius:9px;margin:8px 0;padding:9px}',
 '.sl-album-group summary{font-weight:700;min-height:36px;cursor:pointer}',
 '.sl-album-sheet{font-size:13px;margin:9px 0 4px;color:#334155;font-weight:700}',
 '.sl-album-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}',
 '.sl-album-photo{display:flex;flex-direction:column;gap:5px;padding:7px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:9px;min-width:0}',
 '.sl-album-photo img{display:block;width:100%;height:120px;object-fit:contain;background:#d1d5db;border-radius:5px;cursor:zoom-in}',
 '.sl-album-photo small{font-size:11px;overflow-wrap:anywhere;color:#334155;line-height:1.4}',
 '.sl-album-note{font-size:12px;line-height:1.5;color:#475569}',
 '.sl-album-preview{position:fixed;inset:0;z-index:1610;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:calc(max(60px,env(safe-area-inset-top,0px)) + 6px) 12px calc(max(20px,env(safe-area-inset-bottom,0px)) + 6px);box-sizing:border-box;background:#0f172af5}',
 '.sl-album-preview img{max-width:100%;max-height:calc(100% - 110px);object-fit:contain}',
 '.sl-album-preview button{min-height:48px;min-width:120px}',
 '@media(max-width:520px){.sl-album-backdrop{padding:calc(max(56px,env(safe-area-inset-top,0px)) + 6px) 8px calc(max(12px,env(safe-area-inset-bottom,0px)) + 6px)}.sl-album-modal{padding:9px}.sl-album-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}'
 ].join('');
 document.head.appendChild(s);
}
function closePreview(){if(preview){preview.remove();preview=null;}}
function close(){
 closePreview();
 if(dialog){dialog.remove();dialog=null;}
 for(const url of urls)URL.revokeObjectURL(url);
 urls=[];
}
function showPreview(url,name){
 closePreview();preview=el('div','sl-album-preview');preview.setAttribute('role','dialog');preview.setAttribute('aria-label','撮影写真を拡大表示');
 const b=makeButton('← 写真一覧へ',closePreview);
 const img=el('img');img.src=url;img.alt=name||'自動描写の元写真';
 preview.append(b,img,el('small',null,name||''));document.body.appendChild(preview);
}
async function attachToSelected(drawingId,meta,notice){
 if(currentView!=='editor'||activeDrawingId!==drawingId||typeof selectedShape!=='function'){
   notice.textContent='写真を使う図面シートで変状を選択してください。';return;
 }
 const shape=selectedShape();
 if(!shape){notice.textContent='先に図面上で変状を選択してください。';return;}
 if((shape.photos||[]).some(p=>p.id===meta.id)){notice.textContent='この写真はすでに選択中の変状に添付されています。';return;}
 const blob=await getPhotoBlob(meta.id,drawingId);
 if(!(blob instanceof Blob)){notice.textContent='写真本体が未同期です。同期・再取得を確認してください。';return;}
 try{
   root.SentlogRecords?.assertSafe?.();
   if(typeof pushHistory==='function')pushHistory();
   shape.photos=shape.photos||[];
   shape.photos.push({id:meta.id,name:meta.name,createdAt:meta.createdAt,type:meta.type,size:meta.size});
   persist();
   await renderSelectedPhotos();
   notice.textContent='選択中の変状へ写真を添付しました。写真台帳の対象になります。';
 }catch(e){notice.textContent='写真を添付できませんでした：'+(e?.message||e);}
}
async function open(projectId=activeProjectId,targetGroupId=null){
 const p=typeof getProject==='function'?getProject(projectId):null;
 if(!p)return;
 style();close();
 // Group buttons show only the selected drawing No. (all its sheets).
 // The inspector's optional 'choose from auto trace' action can still show the whole project.
 const groupId=targetGroupId==null?null:String(targetGroupId);
 const groups=projectPhotos(p).filter(g=>groupId==null||g.id===groupId);
 const total=groups.reduce((n,g)=>n+g.count,0);
 const groupName=groupId==null?'':(root.SentlogDrawingGroups?.groupsForProject?.(p)?.find(g=>g.id===groupId)?.name||groups[0]?.name||'図面No.');
 dialog=el('div','sl-album-backdrop');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-label','自動描写の撮影写真');
 const pane=el('div','sl-album-modal');
 const top=el('div','sl-album-header');
 top.append(el('strong',null,'📷 自動描写'+(groupId==null?'':' / '+groupName)+'（'+total+'枚）'),makeButton('閉じる',close));
 const tip=el('div','sl-album-note','撮影写真はここで保管し、変状写真や写真台帳には自動追加しません。原本は撮影端末内、同期は軽量版です。');
 const notice=el('div','sl-album-note');notice.setAttribute('role','status');
 const body=el('div','sl-album-scroll');
 pane.append(top,tip,notice,body);dialog.appendChild(pane);document.body.appendChild(dialog);
 if(!total){body.append(el('p','sl-album-note','まだ撮影写真はありません。自動描写で撮影すると、このフォルダに保存されます。'));return;}
 for(const group of groups){
   const section=el('details','sl-album-group');section.open=true;
   section.append(el('summary',null,'📂 '+group.name+'（'+group.count+'枚）'));
   for(const sheet of group.sheets.values()){
     section.append(el('div','sl-album-sheet',sheet.name));
     const grid=el('div','sl-album-grid');
     for(const meta of sheet.rows){
       const item=el('div','sl-album-photo'),img=el('img'),name=el('small',null,meta.name||'撮影写真');
       img.alt=meta.name||'撮影写真';img.loading='lazy';img.title='タップして拡大';
       const when=el('small',null,new Date(meta.createdAt||0).toLocaleString('ja-JP'));
       item.append(img,name,when);
       if(currentView==='editor'&&activeDrawingId===sheet.drawingId){
         item.append(makeButton('選択中の変状に添付',()=>attachToSelected(sheet.drawingId,meta,notice)));
       }
       grid.append(item);
       try{
         const blob=await getPhotoBlob(meta.id,sheet.drawingId);
         if(!dialog?.isConnected)return;
         if(blob instanceof Blob){const url=URL.createObjectURL(blob);urls.push(url);img.src=url;img.onclick=()=>showPreview(url,meta.name);}
         else img.alt='未同期（写真を再取得してください）';
       }catch{img.alt='読み取りできませんでした';}
     }
     section.append(grid);
   }
   body.append(section);
 }
}
async function capture(file,ctx={}){
 if(!validPhoto(file))throw Error('自動描写の写真を読み取れません');
 if(captureBusy)throw Error('ほかの撮影写真を保存中です');
 if(!ctx.drawingId||!ctx.projectId)throw Error('保存先の案件・図面が未設定です');
 captureBusy=true;
 const drawingId=ctx.drawingId,projectId=ctx.projectId,photoId=id(),timestamp=Date.now();
 try{
   root.SentlogRecords?.assertSafe?.();
   const source= root.SentlogOriginalPhotos;
   if(!source?.saveOriginal||!source?.makeSharedPhoto)throw Error('原本写真の保存機能が利用できません');
   const project=getProject(projectId),drawing=project?.drawings?.find(d=>d.id===drawingId);
   if(!project||!drawing)throw Error('保存先の図面が見つかりません');
   const originalName=String(file.name||'自動描写写真.jpg');
   await source.saveOriginal(drawingId,photoId,file,{
     projectId,projectName:project.name,drawingId,drawingName:drawing.name,
     shapeId:'',shapeLabel:ALBUM,photoId,exportName:originalName,originalName,createdAt:timestamp
   });
   const shared=await source.makeSharedPhoto(file);
   if(!(shared instanceof Blob)||!shared.size)throw Error('共有用画像を作れません');
   await savePhotoBlob(photoId,shared,drawingId);
   const verified=await getPhotoBlob(photoId,drawingId);
   if(!(verified instanceof Blob)||verified.size!==shared.size)throw Error('撮影写真を端末へ保存できませんでした');
   if(activeDrawingId!==drawingId||activeProjectId!==projectId||currentView!=='editor')
     throw Error('保存中に図面が切り替わりました。原本は撮影端末に保管しています。');
   const meta={
     id:photoId,name:shared.type==='image/jpeg'&&/\.(png|webp|heic|heif)$/i.test(originalName)?originalName.replace(/\.[^.]+$/i,'.jpg'):originalName,
     createdAt:timestamp,type:shared.type||'image/jpeg',size:shared.size,page:Number(ctx.page)||state.currentPage
   };
   state.autoTracePhotos=Array.isArray(state.autoTracePhotos)?state.autoTracePhotos:[];
   if(!state.autoTracePhotos.some(p=>p.id===photoId))state.autoTracePhotos.push(meta);
   persist();
   return meta;
 }finally{captureBusy=false;}
}
function addGroupButtons(){
 const grid=$('drawingsGrid'),p=typeof getProject==='function'?getProject():null;
 if(!grid||!p)return;
 // Do not create a separate project-sized card; keep every action on its group card.
 grid.querySelectorAll('[data-sl-auto-album]').forEach(card=>card.remove());
 const counts=new Map(projectPhotos(p).map(g=>[g.id,g.count]));
 grid.querySelectorAll('.manager-card[data-drawing-group-id]').forEach(card=>{
   const groupId=card.dataset.drawingGroupId,actions=card.querySelector('.drawing-group-actions');
   if(!groupId||!actions)return;
   actions.classList.add('sl-album-actions');
   const count=counts.get(groupId)||0,label='📷 自動描写'+(count?'（'+count+'枚）':'');
   let button=actions.querySelector('[data-sl-auto-album-button]');
   if(!button){
     button=makeButton(label,e=>{e.preventDefault();e.stopPropagation();open(p.id,groupId);},'sl-album-action');
     button.dataset.slAutoAlbumButton='1';
     button.addEventListener('pointerdown',e=>e.stopPropagation());
     button.addEventListener('keydown',e=>e.stopPropagation());
     button.addEventListener('click',e=>e.stopPropagation());
     // Match the existing 写真台帳 / 名前変更 / 削除 controls.
     const ledger=actions.querySelector('[data-ledger-button]');
     if(ledger)ledger.after(button);else actions.prepend(button);
   }
   button.textContent=label;
   button.title='図面No.「'+(card.querySelector('.manager-card-title')?.textContent||groupId)+'」の自動描写写真 '+count+'枚';
   button.setAttribute('aria-label','この図面No.の自動描写写真を表示（'+count+'枚）');
 });
}
function setup(){
 style();
 if(typeof renderDrawings==='function'){
   const previous=renderDrawings;
   renderDrawings=function(){const r=previous.apply(this,arguments);addGroupButtons();return r;};
   if(currentView==='drawings')addGroupButtons();
 }
 const actions=$('photoGrid')?.closest('.photo-panel')?.querySelector('.photo-actions');
 if(actions&&!$('slAutoAlbumPick')){
   const pick=makeButton('📁 自動描写から選ぶ',()=>open(activeProjectId));
   pick.id='slAutoAlbumPick';pick.title='自動描写写真の保管場所から選択中の変状に添付';
   actions.parentElement.insertBefore(pick,actions.nextSibling);
 }
}
root.SentlogAutoTraceAlbum={capture,open,countPhotos,projectPhotos,listForDrawing,close};
Promise.resolve(root.sentlogAppReady).then(setup).catch(e=>console.warn('Auto trace photo album setup failed',e));
})(typeof window==='object'?window:globalThis);

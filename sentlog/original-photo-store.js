/* Sentlog v1.62: keep source photos on the capturing device and sync only lightweight copies. */
(function(root){
  'use strict';
  const SHARED_MAX_SIDE=1600, SHARED_JPEG_QUALITY=.78;
  const EXPORT_MAX_BYTES=400*1024*1024, EXPORT_MAX_FILES=250;
  const INVALID=/[<>:"/\\|?*\x00-\x1F]/g;
  const textEncoder=typeof TextEncoder!=='undefined'?new TextEncoder():null;

  function safeSegment(value,fallback='_'){
    let s=String(value||fallback).replace(INVALID,'_').replace(/[. ]+$/g,'').trim();
    if(!s)s=fallback;return s;
  }
  function splitName(name){
    const n=String(name||'photo.jpg');const i=n.lastIndexOf('.');
    return i>0?{stem:n.slice(0,i),ext:n.slice(i)}:{stem:n,ext:''};
  }
  function uniqueName(name,used){
    const taken=used instanceof Set?used:new Set(used||[]);let candidate=safeSegment(name,'photo.jpg');
    if(!taken.has(candidate))return candidate;
    const {stem,ext}=splitName(candidate);let i=2;
    while(taken.has(`${stem}_${i}${ext}`))i++;
    return `${stem}_${i}${ext}`;
  }
  function localDateKey(value){
    const d=value instanceof Date?value:new Date(value||Date.now());
    if(Number.isNaN(+d))return '';
    return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  }
  function buildPcPath(meta){
    const d=new Date(meta?.createdAt||Date.now());const year=String(Number.isNaN(+d)?new Date().getFullYear():d.getFullYear());
    return [year,safeSegment(meta?.projectName,'_案件未設定'),'写真',safeSegment(meta?.drawingName,'_図面未設定'),safeSegment(meta?.shapeLabel,'_変状未設定'),safeSegment(meta?.exportName||meta?.originalName,'photo.jpg')].join('/');
  }
  function planBatches(items,maxBytes=EXPORT_MAX_BYTES,maxFiles=EXPORT_MAX_FILES){
    const batches=[];let current=[],bytes=0;
    for(const item of items||[]){
      const size=Math.max(0,Number(item?.size)||0);
      if(current.length && (current.length>=maxFiles || bytes+size>maxBytes)){batches.push(current);current=[];bytes=0;}
      current.push(item);bytes+=size;
      if(current.length>=maxFiles || bytes>=maxBytes){batches.push(current);current=[];bytes=0;}
    }
    if(current.length)batches.push(current);return batches;
  }
  function crcTable(){
    const table=new Uint32Array(256);
    for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;table[n]=c>>>0;}
    return table;
  }
  const CRC_TABLE=crcTable();
  function crc32Bytes(bytes,seed=0xFFFFFFFF){
    let crc=seed>>>0;for(const b of bytes)crc=CRC_TABLE[(crc^b)&255]^(crc>>>8);return crc>>>0;
  }
  function finalizedCrc(crc){return (crc^0xFFFFFFFF)>>>0;}
  const pure={SHARED_MAX_SIDE,SHARED_JPEG_QUALITY,EXPORT_MAX_BYTES,EXPORT_MAX_FILES,safeSegment,uniqueName,localDateKey,buildPcPath,planBatches,crc32Bytes,finalizedCrc};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogOriginalPhotos)return;

  const DB='sentlog-original-photos-v1', VERSION=1, PHOTOS='photos', META='meta';
  let connection=null, ui=null, uiBusy=false;
  const keyFor=(drawingId,photoId)=>`${drawingId}:${photoId}`;
  function openDb(){
    if(connection)return Promise.resolve(connection);
    return new Promise((resolve,reject)=>{
      const q=indexedDB.open(DB,VERSION);
      q.onupgradeneeded=()=>{
        const db=q.result;
        if(!db.objectStoreNames.contains(PHOTOS))db.createObjectStore(PHOTOS);
        if(!db.objectStoreNames.contains(META)){const s=db.createObjectStore(META,{keyPath:'key'});s.createIndex('createdAt','createdAt');s.createIndex('exportedAt','exportedAt');s.createIndex('projectId','projectId');}
      };
      q.onsuccess=()=>{connection=q.result;connection.onversionchange=()=>{connection.close();connection=null;};resolve(connection);};
      q.onerror=()=>reject(q.error||Error('原本写真の保存領域を開けませんでした'));
      q.onblocked=()=>reject(Error('別のセントログ画面が原本写真の保存領域を使用中です'));
    });
  }
  function txDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('原本写真の保存が中断されました'));tx.onerror=()=>{};});}
  async function saveOriginal(drawingId,photoId,file,meta){
    if(!(file instanceof Blob))throw Error('原本写真を読み取れません');
    const db=await openDb(),key=keyFor(drawingId,photoId),tx=db.transaction([PHOTOS,META],'readwrite'),done=txDone(tx);
    tx.objectStore(PHOTOS).put(file,key);
    tx.objectStore(META).put({...meta,key,drawingId,photoId,size:file.size,type:file.type||'application/octet-stream',originalName:file.name||meta?.originalName||'photo',lastModified:Number(file.lastModified)||null,storedAt:Date.now(),exportedAt:null,packageName:null});
    await done;return key;
  }
  async function getOriginal(drawingId,photoId){
    const db=await openDb(),key=keyFor(drawingId,photoId);return new Promise((resolve,reject)=>{const q=db.transaction(PHOTOS,'readonly').objectStore(PHOTOS).get(key);q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>reject(q.error);});
  }
  async function listMeta(){
    const db=await openDb();return new Promise((resolve,reject)=>{const q=db.transaction(META,'readonly').objectStore(META).getAll();q.onsuccess=()=>resolve(q.result||[]);q.onerror=()=>reject(q.error);});
  }
  async function stats(){const rows=await listMeta();return {bytes:rows.reduce((n,m)=>n+(Number(m.size)||0),0),count:rows.length,unexportedBytes:rows.filter(m=>!m.exportedAt).reduce((n,m)=>n+(Number(m.size)||0),0),unexportedCount:rows.filter(m=>!m.exportedAt).length,exportedCount:rows.filter(m=>!!m.exportedAt).length};}
  async function drawingStats(drawingId){
    const rows=(await listMeta()).filter(m=>m.drawingId===drawingId);
    return {bytes:rows.reduce((n,m)=>n+(Number(m.size)||0),0),count:rows.length,
      unexportedBytes:rows.filter(m=>!m.exportedAt).reduce((n,m)=>n+(Number(m.size)||0),0),
      unexportedCount:rows.filter(m=>!m.exportedAt).length,exportedCount:rows.filter(m=>!!m.exportedAt).length};
  }
  async function renameDrawing(drawingId,drawingName){
    const name=String(drawingName||'').trim();if(!drawingId||!name)return 0;
    const db=await openDb(),tx=db.transaction(META,'readwrite'),done=txDone(tx),store=tx.objectStore(META);let changed=0;
    await new Promise((resolve,reject)=>{
      const q=store.openCursor();q.onsuccess=()=>{const c=q.result;if(!c){resolve();return;}const row=c.value;if(row?.drawingId===drawingId&&row.drawingName!==name){c.update({...row,drawingName:name});changed++;}c.continue();};q.onerror=()=>reject(q.error);
    });
    await done;return changed;
  }
  async function markExported(keys,packageName){
    const db=await openDb(),tx=db.transaction(META,'readwrite'),done=txDone(tx),s=tx.objectStore(META),when=Date.now();
    for(const key of keys){const q=s.get(key);q.onsuccess=()=>{if(q.result)s.put({...q.result,exportedAt:when,packageName});};}
    await done;
  }
  async function deleteExported(){
    const rows=await listMeta(),targets=rows.filter(m=>m.exportedAt);if(!targets.length)return {count:0,bytes:0};
    const db=await openDb(),tx=db.transaction([PHOTOS,META],'readwrite'),done=txDone(tx),p=tx.objectStore(PHOTOS),m=tx.objectStore(META);let bytes=0;
    for(const row of targets){p.delete(row.key);m.delete(row.key);bytes+=Number(row.size)||0;}await done;return {count:targets.length,bytes};
  }

  function currentContext(shape,file,photoId,exportName,createdAt){
    let project=null,drawing=null;
    try{project=typeof getProject==='function'?getProject():null;drawing=typeof getDrawingMeta==='function'?getDrawingMeta():null;}catch(_){}
    return {projectId:project?.id||'',projectName:project?.name||((typeof state!=='undefined'&&state.project)||'_案件未設定'),drawingId:(typeof activeDrawingId!=='undefined'&&activeDrawingId)||drawing?.id||'',drawingName:drawing?.name||'_図面未設定',shapeId:shape?.id||'',shapeLabel:shape?.autoLabel||((shape?.type||'変状')+'-'+(shape?.typeNo||'')),photoId,exportName,originalName:file?.name||exportName,createdAt};
  }
  function jpegName(name){const {stem}=splitName(safeSegment(name,'photo.jpg'));return stem+'.jpg';}
  async function makeSharedPhoto(file){
    if(!file||!String(file.type||'').startsWith('image/'))throw Error('画像ファイルではありません');
    const url=URL.createObjectURL(file);let img;
    try{
      img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('写真を確認用画像に変換できません'));im.src=url;});
      const naturalW=img.naturalWidth||img.width,naturalH=img.naturalHeight||img.height;
      const ratio=Math.min(1,SHARED_MAX_SIDE/Math.max(naturalW,naturalH));
      const w=Math.max(1,Math.round(naturalW*ratio)),h=Math.max(1,Math.round(naturalH*ratio));
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');if(!ctx)throw Error('確認用画像を作成できません');
      ctx.drawImage(img,0,0,w,h);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',SHARED_JPEG_QUALITY));if(!(blob instanceof Blob))throw Error('確認用画像を作成できません');return blob;
    }finally{URL.revokeObjectURL(url);if(img){img.onload=null;img.onerror=null;img.src='';}}
  }

  async function crc32Blob(blob){
    let crc=0xFFFFFFFF;
    if(blob.stream){const reader=blob.stream().getReader();try{while(true){const {done,value}=await reader.read();if(done)break;crc=crc32Bytes(value,crc);}}finally{reader.releaseLock?.();}}
    else crc=crc32Bytes(new Uint8Array(await blob.arrayBuffer()),crc);
    return finalizedCrc(crc);
  }
  function le16(n){return new Uint8Array([n&255,(n>>>8)&255]);}
  function le32(n){n=Number(n)>>>0;return new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]);}
  function dosTime(value){const d=new Date(value||Date.now()),year=Math.max(1980,d.getFullYear());return {time:((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|((Math.floor(d.getSeconds()/2))&31),date:(((year-1980)&127)<<9)|(((d.getMonth()+1)&15)<<5)|(d.getDate()&31)};}
  function header(parts){return new Blob(parts,{type:'application/octet-stream'});}
  async function makeZip(entries){
    if(!textEncoder)throw Error('このブラウザではZIPを書き出せません');
    const parts=[],central=[];let offset=0;
    for(const entry of entries){
      const blob=entry.blob,name=textEncoder.encode(entry.path),crc=await crc32Blob(blob),size=blob.size,{time,date}=dosTime(entry.modifiedAt);if(size>0xFFFFFFFF)throw Error('1ファイルがZIPの上限を超えています');
      const local=header([le32(0x04034b50),le16(20),le16(0x0800),le16(0),le16(time),le16(date),le32(crc),le32(size),le32(size),le16(name.length),le16(0),name]);
      parts.push(local,blob);
      central.push(header([le32(0x02014b50),le16(20),le16(20),le16(0x0800),le16(0),le16(time),le16(date),le32(crc),le32(size),le32(size),le16(name.length),le16(0),le16(0),le16(0),le16(0),le32(0),le32(offset),name]));
      offset+=local.size+size;
    }
    const centralStart=offset,centralSize=central.reduce((n,b)=>n+b.size,0);parts.push(...central,header([le32(0x06054b50),le16(0),le16(0),le16(entries.length),le16(entries.length),le32(centralSize),le32(centralStart),le16(0)]));
    return new Blob(parts,{type:'application/zip'});
  }
  function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function bytes(n){n=Number(n)||0;return n<1024**2?(n/1024).toFixed(1)+' KB':n<1024**3?(n/1024**2).toFixed(1)+' MB':(n/1024**3).toFixed(2)+' GB';}
  function projectOptions(){try{return (workspace?.projects||[]).map(p=>({id:p.id,name:p.name}));}catch(_){return [];}}
  async function rowsFor(mode,projectId){
    let rows=(await listMeta()).filter(m=>!m.exportedAt);
    if(mode==='today'){const today=localDateKey(Date.now());rows=rows.filter(m=>localDateKey(m.createdAt)===today);}
    if(projectId)rows=rows.filter(m=>m.projectId===projectId);
    return rows.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  }
  async function exportNext(mode,projectId){
    const rows=await rowsFor(mode,projectId);if(!rows.length){alert('書き出し待ちの原本写真はありません。');return;}
    const batch=planBatches(rows)[0],entries=[];
    for(const meta of batch){const blob=await getOriginal(meta.drawingId,meta.photoId);if(!(blob instanceof Blob))throw Error('原本写真が見つかりません：'+(meta.exportName||meta.originalName));entries.push({path:buildPcPath(meta),blob,modifiedAt:meta.lastModified||meta.createdAt});}
    const zip=await makeZip(entries),day=localDateKey(Date.now()).replaceAll('-',''),project=projectId?safeSegment(projectOptions().find(p=>p.id===projectId)?.name,'案件'):'全案件',name=`セントログ_原本写真_${project}_${day}_${String(Math.ceil((rows.length-batch.length+1)/EXPORT_MAX_FILES)).padStart(2,'0')}.zip`;
    download(zip,name);
    const ok=confirm(`${batch.length}枚（${bytes(batch.reduce((n,m)=>n+(Number(m.size)||0),0))}）を書き出しました。\n\n「ファイル」等に保存できたことを確認できた場合だけ「OK」を押してください。\n確認できない場合は「キャンセル」で未書き出しのまま残します。`);
    if(ok)await markExported(batch.map(x=>x.key),name);
    await refreshUI();
  }

  async function refreshUI(){
    if(!ui||uiBusy)return;uiBusy=true;try{
      const s=await stats();ui.total.textContent=`原本 ${s.count}枚 / ${bytes(s.bytes)}`;ui.pending.textContent=`未書き出し ${s.unexportedCount}枚 / ${bytes(s.unexportedBytes)}　・　書き出し確認済み ${s.exportedCount}枚`;
      const selected=ui.project.value;ui.project.replaceChildren(new Option('すべての案件',''));
      for(const p of projectOptions())ui.project.append(new Option(p.name,p.id));if([...ui.project.options].some(o=>o.value===selected))ui.project.value=selected;else if(typeof activeProjectId!=='undefined'&&activeProjectId&&[...ui.project.options].some(o=>o.value===activeProjectId))ui.project.value=activeProjectId;
      ui.cleanup.disabled=s.exportedCount===0;
    }catch(e){ui.message.textContent='原本写真の状態を確認できません：'+(e.message||e);}finally{uiBusy=false;}
  }
  function installUI(){
    if(ui||document.getElementById('sentlogOriginalPhotosSection'))return;
    const modal=document.querySelector('#sentlogSettingsModal .modal-card');if(!modal)return;
    const style=document.createElement('style');style.textContent=`#sentlogOriginalPhotosSection{border:1px solid var(--line);border-radius:10px;padding:0 14px;margin-bottom:12px;text-align:left}#sentlogOriginalPhotosSection summary{padding:12px 0;min-height:48px;font-size:14px;font-weight:600;cursor:pointer}#sentlogOriginalPhotosSection p{font-size:12px;line-height:1.65;margin:8px 0;color:#4b5563}#sentlogOriginalPhotosSection select,#sentlogOriginalPhotosSection button{min-height:44px;font-size:12px}#sentlogOriginalPhotosSection select{width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;background:#fff}#sentlogOriginalPhotosSection .sl-original-actions{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0}#sentlogOriginalPhotosSection button{width:auto;padding:8px 10px}#sentlogOriginalPhotosSection .sl-original-total{font-size:20px;font-weight:700;color:#111827}`;document.head.appendChild(style);
    const section=document.createElement('details');section.id='sentlogOriginalPhotosSection';section.innerHTML=`<summary>原本写真（この端末）</summary><p>撮影・追加した元写真はこの端末だけに残し、端末間の同期には軽い確認用画像を使います。原本はSupabaseへ通常送信しません。</p><div class="sl-original-total" data-role="total">確認中…</div><p data-role="pending"></p><label style="font-size:12px;color:#4b5563">案件<select data-role="project"></select></label><div class="sl-original-actions"><button type="button" data-role="today">今日の未書き出し原本</button><button type="button" data-role="projectExport">選択案件の未書き出し原本</button><button type="button" data-role="cleanup">書き出し確認済み原本を端末から削除</button></div><p data-role="message">1回の書き出しは最大250枚・約400MBです。残りがある場合は同じボタンでもう一度書き出してください。ZIPの中は会社PCと同じ「年 → 案件 → 写真 → 図面 → 変状」の構成です。</p><p>この機能追加前に登録した写真には原本はありません。未書き出し原本は容量整理では削除しません。</p>`;
    const storage=document.getElementById('sentlogStorageSection'),backup=modal.querySelector('#sentlogBackupSection');if(storage)storage.after(section);else if(backup)backup.before(section);else modal.appendChild(section);
    ui={section,total:section.querySelector('[data-role=total]'),pending:section.querySelector('[data-role=pending]'),project:section.querySelector('[data-role=project]'),message:section.querySelector('[data-role=message]'),cleanup:section.querySelector('[data-role=cleanup]')};
    section.addEventListener('toggle',()=>{if(section.open)refreshUI();});
    section.querySelector('[data-role=today]').onclick=()=>exportNext('today','').catch(e=>{ui.message.textContent='書き出しに失敗しました。原本は削除していません：'+(e.message||e);});
    section.querySelector('[data-role=projectExport]').onclick=()=>exportNext('all',ui.project.value).catch(e=>{ui.message.textContent='書き出しに失敗しました。原本は削除していません：'+(e.message||e);});
    ui.cleanup.onclick=async()=>{if(!confirm('書き出し確認済みの原本だけを、この端末から削除します。未書き出し原本は削除しません。よろしいですか？'))return;try{const r=await deleteExported();ui.message.textContent=`${r.count}枚（${bytes(r.bytes)}）の書き出し確認済み原本を端末から削除しました。`;await refreshUI();}catch(e){ui.message.textContent='削除できませんでした：'+(e.message||e);}};
    refreshUI();
  }

  async function registerPhotos(files){
    const s=typeof selectedShape==='function'?selectedShape():null;if(!s||!files?.length)return;const targetId=s.id,drawingId=typeof activeDrawingId!=='undefined'?activeDrawingId:null;if(!drawingId)return;
    const status=document.getElementById('photoStatus');if(status)status.textContent='原本と確認用写真を保存中…';if(typeof pushHistory==='function')pushHistory();s.photos=s.photos||[];let added=0;
    for(const file of files){let photoId=null,originalSaved=false;try{
      photoId=typeof uid==='function'?uid():crypto.randomUUID();const target=typeof state!=='undefined'?state.shapes.find(x=>x.id===targetId):null;if(!target)continue;target.photos=target.photos||[];
      const used=new Set(target.photos.map(p=>p.name).filter(Boolean));const exportName=uniqueName(file.name||`写真${target.photos.length+1}.jpg`,used),createdAt=Date.now();
      const meta=currentContext(target,file,photoId,exportName,createdAt);await saveOriginal(drawingId,photoId,file,meta);originalSaved=true;
      const shared=await makeSharedPhoto(file),sharedName=shared.type==='image/jpeg'&&/\.(heic|heif|png|webp)$/i.test(exportName)?jpegName(exportName):exportName;
      await savePhotoBlob(photoId,shared,drawingId);target.photos.push({id:photoId,name:sharedName,createdAt,type:shared.type||'image/jpeg',size:shared.size});added++;
    }catch(e){console.warn('original/shared photo save failed',e);if(status)status.textContent=originalSaved?'確認用画像を作れませんでした。原本はこの端末に残しています。':'写真を保存できませんでした。原本の保存領域と空き容量を確認してください。';}
    }
    if(typeof persist==='function')persist();if(status&&added)status.textContent=`${added}枚保存しました（原本はこの端末・共有は軽量版）`;setTimeout(()=>{if(status&&/保存しました/.test(status.textContent))status.textContent='';},1800);if(typeof selected!=='undefined'&&selected===targetId&&typeof renderSelectedPhotos==='function')renderSelectedPhotos();refreshUI();
  }

  const api={...pure,saveOriginal,getOriginal,listMeta,stats,drawingStats,renameDrawing,markExported,deleteExported,makeSharedPhoto,makeZip,refreshUI,exportNext};
  root.SentlogOriginalPhotos=api;
  try{if(typeof addPhotosToSelected==='function')addPhotosToSelected=registerPhotos;}catch(e){console.warn('Sentlog original photo hook',e);}
  setTimeout(installUI,0);
})(typeof globalThis!=='undefined'?globalThis:this);

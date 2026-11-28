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
  const SOURCE_FIELDS=['key','drawingId','photoId','projectId','projectName','drawingName','shapeId','shapeLabel','exportName','originalName','type','size','lastModified','createdAt','storedAt','originalRevision'];
  function sourceSignature(row){return JSON.stringify(SOURCE_FIELDS.map(key=>row?.[key]??null));}
  const pure={SHARED_MAX_SIDE,SHARED_JPEG_QUALITY,EXPORT_MAX_BYTES,EXPORT_MAX_FILES,safeSegment,uniqueName,localDateKey,buildPcPath,planBatches,crc32Bytes,finalizedCrc,sourceSignature};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogOriginalPhotos)return;

  const DB='sentlog-original-photos-v1', VERSION=1, PHOTOS='photos', META='meta';
  let connection=null, ui=null, uiBusy=false, uiRefreshRequested=false;
  const EXPORT_LOCK='sentlog-original-photo-export-source-v1',exportSessions=new WeakMap();
  let writeSequence=0;
  const originalRevision=()=>root.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+(++writeSequence)+'-'+Math.random().toString(36).slice(2);
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
    tx.objectStore(META).put({...meta,key,drawingId,photoId,size:file.size,type:file.type||'application/octet-stream',originalName:file.name||meta?.originalName||'photo',lastModified:Number(file.lastModified)||null,storedAt:Date.now(),originalRevision:originalRevision(),exportedAt:null,packageName:null});
    await done;return key;
  }
  async function getOriginal(drawingId,photoId){
    const db=await openDb(),key=keyFor(drawingId,photoId);return new Promise((resolve,reject)=>{const q=db.transaction(PHOTOS,'readonly').objectStore(PHOTOS).get(key);q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>reject(q.error);});
  }
  // Read one photo's immutable association without scanning unrelated iPhone
  // originals. Only the owning drawing/photo identity can be recovered.
  async function getOriginalMeta(drawingId,photoId){
    if(typeof drawingId!=='string'||!drawingId||typeof photoId!=='string'||!photoId)
      throw Error('原本写真の識別情報が必要です');
    const db=await openDb(),key=keyFor(drawingId,photoId);
    return new Promise((resolve,reject)=>{
      const q=db.transaction(META,'readonly').objectStore(META).get(key);
      q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>reject(q.error);
    });
  }
  // A capture may be retried after the page closes. Its original and pending
  // association share one transaction; an existing original is never replaced.
  async function stageOriginal(drawingId,photoId,file,meta){
    if(!(file instanceof Blob))throw Error('原本写真を読み取れません');
    const db=await openDb(),key=keyFor(drawingId,photoId),tx=db.transaction([PHOTOS,META],'readwrite'),done=txDone(tx);
    let row,blob,remaining=2,result,error;
    function finish(){
      if(--remaining)return;
      if(row||blob){
        if(!row||!(blob instanceof Blob)||row.photoAssociation?.operationId!==meta?.photoAssociation?.operationId){error=Error('保存済みの原本と撮影操作が一致しません。上書きせず保持しました。');tx.abort();return;}
        result=row;return;
      }
      result={...meta,key,drawingId,photoId,size:file.size,type:file.type||'application/octet-stream',originalName:file.name||meta?.originalName||'photo',lastModified:Number(file.lastModified)||null,storedAt:Date.now(),originalRevision:originalRevision(),exportedAt:null,packageName:null};
      tx.objectStore(PHOTOS).put(file,key);tx.objectStore(META).put(result);
    }
    const qr=tx.objectStore(META).get(key),qb=tx.objectStore(PHOTOS).get(key);
    qr.onsuccess=()=>{row=qr.result;finish();};qb.onsuccess=()=>{blob=qb.result;finish();};
    try{await done;}catch(e){throw error||e;}return result;
  }
  async function updatePhotoAssociation(drawingId,photoId,association){
    const db=await openDb(),key=keyFor(drawingId,photoId),tx=db.transaction(META,'readwrite'),done=txDone(tx),store=tx.objectStore(META);
    let result,error;const q=store.get(key);
    q.onsuccess=()=>{
      const row=q.result;
      if(!row||row.photoAssociation?.operationId!==association?.operationId){error=Error('撮影操作の保存記録を確認できません');tx.abort();return;}
      result={...row,photoAssociation:association};store.put(result);
    };
    try{await done;}catch(e){throw error||e;}return result;
  }
  // Only an explicitly reassigned, still-pending capture can change its key.
  // Moving bytes and metadata together keeps normal drawing/photo keys compatible.
  async function rebindPendingOriginal(fromDrawingId,toDrawingId,photoId,meta){
    const db=await openDb(),oldKey=keyFor(fromDrawingId,photoId),newKey=keyFor(toDrawingId,photoId);
    const tx=db.transaction([PHOTOS,META],'readwrite'),done=txDone(tx),photos=tx.objectStore(PHOTOS),metas=tx.objectStore(META);
    let oldRow,blob,existing,existingBlob,remaining=4,result,error;
    function finish(){
      if(--remaining)return;
      if(!oldRow||!(blob instanceof Blob)||oldRow.photoAssociation?.status==='attached'||oldRow.photoAssociation?.operationId!==meta?.photoAssociation?.operationId||
         (oldKey!==newKey&&(existing||existingBlob))){
        error=Error('保存待ちの原本を確認できません。元の写真は保持しています。');tx.abort();return;
      }
      result={...oldRow,...meta,key:newKey,drawingId:toDrawingId,photoId,size:oldRow.size,type:oldRow.type,originalName:oldRow.originalName,lastModified:oldRow.lastModified,storedAt:oldRow.storedAt,originalRevision:oldRow.originalRevision,exportedAt:oldRow.exportedAt,packageName:oldRow.packageName};
      photos.put(blob,newKey);metas.put(result);
      if(oldKey!==newKey){photos.delete(oldKey);metas.delete(oldKey);}
    }
    const qr=metas.get(oldKey),qb=photos.get(oldKey),qn=metas.get(newKey),qnb=photos.get(newKey);
    qr.onsuccess=()=>{oldRow=qr.result;finish();};qb.onsuccess=()=>{blob=qb.result;finish();};qn.onsuccess=()=>{existing=qn.result;finish();};qnb.onsuccess=()=>{existingBlob=qnb.result;finish();};
    try{await done;}catch(e){throw error||e;}return result;
  }
  async function listMeta(drawingId){
    // Existing keys are drawingId + ':' + photoId. A bounded read needs no
    // schema migration; the exact check excludes drawings sharing that prefix.
    const scoped=typeof drawingId==='string'&&drawingId.length>0;
    const range=scoped?IDBKeyRange.bound(drawingId+':',drawingId+';',false,true):undefined;
    const db=await openDb();return new Promise((resolve,reject)=>{
      const q=db.transaction(META,'readonly').objectStore(META).getAll(range);
      q.onsuccess=()=>resolve(scoped?(q.result||[]).filter(row=>row.drawingId===drawingId):(q.result||[]));
      q.onerror=()=>reject(q.error);
    });
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
  async function listProjectMeta(projectId){
    if(typeof projectId!=='string'||!projectId.trim())throw Error('元写真を保存する案件を選んでください。');
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const q=db.transaction(META,'readonly').objectStore(META).index('projectId').getAll(projectId);
      q.onsuccess=()=>resolve((q.result||[]).filter(row=>row.projectId===projectId)
        .sort((a,b)=>(Number(a.createdAt)||0)-(Number(b.createdAt)||0)||String(a.key).localeCompare(String(b.key))));
      q.onerror=()=>reject(q.error);
    });
  }
  // The lock spans preparation, explicit download and user confirmation. It
  // prevents another tab's cleanup from deleting source files during export.
  // Captures still work; version checks reject changed sources without marking
  // newer originals as saved. A closed/crashed page releases its Web Lock.
  async function beginExportSession(projectId){
    if(typeof projectId!=='string'||!projectId.trim())throw Error('元写真を保存する案件を選んでください。');
    if(typeof root.navigator?.locks?.request!=='function')throw Error('このブラウザーでは元写真をまとめて保存できません。最新版のブラウザーで開いてください。');
    return new Promise((resolve,reject)=>{
      root.navigator.locks.request(EXPORT_LOCK,{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock)throw Error('別の画面で元写真の保存・整理を行っています。その画面を閉じてからやり直してください。');
        const rows=await listProjectMeta(projectId);
        if(!rows.length)throw Error('この案件の元写真は、この端末にはありません。');
        let release;const untilReleased=new Promise(done=>{release=done;});
        const snapshot=structuredClone(rows),session=Object.freeze({projectId,rows:structuredClone(rows)});
        exportSessions.set(session,{projectId,rows:snapshot,release,active:true,confirmed:false});
        resolve(session);await untilReleased;
      }).catch(reject);
    });
  }
  async function confirmExportSession(session,packageName){
    const held=exportSessions.get(session);
    if(!held?.active||held.confirmed)throw Error('保存の確認画面を開き直してください。');
    if(typeof packageName!=='string'||!packageName.endsWith('.zip'))throw Error('保存したZIPを確認できません。');
    const db=await openDb(),tx=db.transaction([PHOTOS,META],'readwrite'),done=txDone(tx);
    const metas=tx.objectStore(META),photos=tx.objectStore(PHOTOS),when=Date.now();let problem;
    let position=0;
    function next(){
      if(position===held.rows.length)return;
      const expected=held.rows[position++];
      let current,blob,remaining=2;
      const check=()=>{
        if(--remaining||problem)return;
        if(!held.active||!current||current.projectId!==held.projectId||sourceSignature(current)!==sourceSignature(expected)||
          !(blob instanceof Blob)||blob.size!==Number(expected.size)){
          problem=Error('保存の準備後に元写真が更新されました。保存確認は付けていません。もう一度ZIPを作成してください。');tx.abort();return;
        }
        metas.put({...current,exportedAt:when,packageName});next();
      };
      const qm=metas.get(expected.key),qp=photos.get(expected.key);
      qm.onsuccess=()=>{current=qm.result;check();};qp.onsuccess=()=>{blob=qp.result;check();};
    }
    next();
    try{await done;}catch(error){throw problem||error;}
    held.confirmed=true;return {count:held.rows.length,bytes:held.rows.reduce((sum,row)=>sum+Number(row.size||0),0)};
  }
  function releaseExportSession(session){
    const held=exportSessions.get(session);if(!held?.active)return;
    held.active=false;held.release();exportSessions.delete(session);
  }
  async function deleteExported(){
    const remove=async()=>{
      const db=await openDb(),tx=db.transaction([PHOTOS,META],'readwrite'),done=txDone(tx),photos=tx.objectStore(PHOTOS),metas=tx.objectStore(META);let count=0,bytes=0;
      const q=metas.openCursor();q.onsuccess=()=>{const cursor=q.result;if(!cursor)return;const row=cursor.value;
        if(row.exportedAt&&(!row.photoAssociation||row.photoAssociation.status==='attached')){photos.delete(row.key);cursor.delete();count++;bytes+=Number(row.size)||0;}cursor.continue();};
      await done;return {count,bytes};
    };
    if(typeof root.navigator?.locks?.request!=='function')return remove();
    return root.navigator.locks.request(EXPORT_LOCK,{mode:'exclusive',ifAvailable:true},lock=>{
      if(!lock)throw Error('元写真のZIP保存画面を開いています。保存を終えて画面を閉じてから整理してください。');
      return remove();
    });
  }

  function currentContext(shape,file,photoId,exportName,createdAt){
    let project=null,drawing=null;
    try{project=typeof getProject==='function'?getProject():null;drawing=typeof getDrawingMeta==='function'?getDrawingMeta():null;}catch(_){}
    return {projectId:project?.id||'',projectName:project?.name||((typeof state!=='undefined'&&state.project)||'_案件未設定'),drawingId:(typeof activeDrawingId!=='undefined'&&activeDrawingId)||drawing?.id||'',drawingName:drawing?.name||'_図面未設定',shapeId:shape?.id||'',shapeLabel:shape?.autoLabel||((shape?.type||'変状')+'-'+(shape?.typeNo||'')),photoId,exportName,originalName:file?.name||exportName,createdAt};
  }
  function jpegName(name){const {stem}=splitName(safeSegment(name,'photo.jpg'));return stem+'.jpg';}
  async function makeSharedPhoto(file){
    if(!file||!String(file.type||'').startsWith('image/'))throw Error('画像ファイルではありません');
    const url=URL.createObjectURL(file);let img,canvas;
    try{
      img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('写真を確認用画像に変換できません'));im.src=url;});
      const naturalW=img.naturalWidth||img.width,naturalH=img.naturalHeight||img.height;
      const ratio=Math.min(1,SHARED_MAX_SIDE/Math.max(naturalW,naturalH));
      const w=Math.max(1,Math.round(naturalW*ratio)),h=Math.max(1,Math.round(naturalH*ratio));
      canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');if(!ctx)throw Error('確認用画像を作成できません');
      ctx.drawImage(img,0,0,w,h);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',SHARED_JPEG_QUALITY));if(!(blob instanceof Blob))throw Error('確認用画像を作成できません');return blob;
    }finally{if(canvas){canvas.width=1;canvas.height=1;}URL.revokeObjectURL(url);if(img){img.onload=null;img.onerror=null;img.src='';}}
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
  function bytes(n){n=Number(n)||0;return n<1024**2?(n/1024).toFixed(1)+' KB':n<1024**3?(n/1024**2).toFixed(1)+' MB':(n/1024**3).toFixed(2)+' GB';}
  function projectOptions(rows=[]){
    const projects=new Map();
    try{const ws=typeof workspace==='function'?workspace():workspace;for(const p of ws?.projects||[])if(p?.id)projects.set(p.id,{id:p.id,name:p.name||'案件'});}catch(_){}
    // Originals can outlive a project's shared files or its workspace entry.
    for(const row of rows)if(row.projectId&&!projects.has(row.projectId))projects.set(row.projectId,{id:row.projectId,name:row.projectName||'案件'});
    return [...projects.values()];
  }
  async function exportNext(mode,projectId){
    if(typeof projectId!=='string'||!projectId.trim())throw Error('元写真を保存する案件を選んでください。');
    if(!root.SentlogOriginalPhotoExport)throw Error('一括保存の準備ができていません。画面を読み込み直してください。');
    return root.SentlogOriginalPhotoExport.open(projectId);
  }

  async function refreshUI(){
    if(!ui||!ui.section.open||ui.section.closest('#sentlogSettingsModal')?.getAttribute('aria-hidden')==='true')return;
    if(uiBusy){uiRefreshRequested=true;return;}uiBusy=true;try{
      const rows=await listMeta(),totalBytes=rows.reduce((sum,row)=>sum+Number(row.size||0),0);
      ui.total.textContent=`この端末の元写真 ${rows.length}枚 / ${bytes(totalBytes)}`;
      const selected=ui.project.value;ui.project.replaceChildren(new Option('案件を選択してください',''));
      for(const p of projectOptions(rows))ui.project.append(new Option(p.name,p.id));
      if([...ui.project.options].some(o=>o.value===selected)&&selected)ui.project.value=selected;
      else if(typeof activeProjectId!=='undefined'&&activeProjectId&&[...ui.project.options].some(o=>o.value===activeProjectId))ui.project.value=activeProjectId;
      const chosen=rows.filter(row=>row.projectId===ui.project.value&&ui.project.value);
      ui.pending.textContent=ui.project.value?`選択案件：${chosen.length}枚 / ${bytes(chosen.reduce((sum,row)=>sum+Number(row.size||0),0))}（保存確認済みの写真も含む）`:'保存する案件を選んでください。';
      ui.start.disabled=!ui.project.value||!chosen.length||!!root.SentlogOriginalPhotoExport?.busy;
      ui.cleanup.disabled=!rows.some(row=>row.exportedAt)||!!root.SentlogOriginalPhotoExport?.busy;
    }catch(e){ui.message.textContent='元写真の状態を確認できません：'+(e.message||e);}finally{uiBusy=false;
      if(uiRefreshRequested){uiRefreshRequested=false;void refreshUI();}}
  }
  function installUI(){
    if(ui||document.getElementById('sentlogOriginalPhotosSection'))return;
    const modal=document.querySelector('#sentlogSettingsModal .modal-card');if(!modal)return;
    const style=document.createElement('style');style.textContent=`#sentlogOriginalPhotosSection{border:1px solid var(--line);border-radius:10px;padding:0 14px;margin-bottom:12px;text-align:left}#sentlogOriginalPhotosSection summary{padding:12px 0;min-height:48px;font-size:14px;font-weight:600;cursor:pointer}#sentlogOriginalPhotosSection p{font-size:12px;line-height:1.65;margin:8px 0;color:#4b5563}#sentlogOriginalPhotosSection select,#sentlogOriginalPhotosSection button{min-height:44px;font-size:12px}#sentlogOriginalPhotosSection select{width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;background:#fff}#sentlogOriginalPhotosSection .sl-original-actions{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0}#sentlogOriginalPhotosSection button{width:auto;padding:8px 10px}#sentlogOriginalPhotosSection .sl-original-total{font-size:18px;font-weight:700;color:#111827}`;document.head.appendChild(style);
    const section=document.createElement('details');section.id='sentlogOriginalPhotosSection';section.innerHTML=`<summary>元写真をまとめて保存（この端末）</summary><p>案件を選び、この端末にある元写真を1つのZIPにまとめて保存できます。保存確認済みの写真も含め、何度でも保存できます。元写真は端末に残ります。</p><div class="sl-original-total" data-role="total">確認中…</div><label style="font-size:12px;color:#4b5563">保存する案件<select data-role="project" required><option value="">案件を選択してください</option></select></label><p data-role="pending"></p><div class="sl-original-actions"><button type="button" data-role="projectExport" disabled>元写真をまとめて保存</button></div><p data-role="message">ZIPの中は会社PCと同じ「年 → 案件 → 写真 → 図面 → 変状」の構成です。写真を撮影・追加した端末で開いてください。</p><p>元写真の保存に対応する前に登録した写真や、別の端末で撮影した写真の原本は、この端末にはありません。</p><div class="sl-original-actions"><button type="button" data-role="cleanup">全案件の保存確認済み元写真を端末から削除</button></div><p>削除はこの端末の全案件が対象です。未書き出し原本は削除しません。</p>`;
    const storage=document.getElementById('sentlogStorageSection'),backup=modal.querySelector('#sentlogBackupSection');if(storage)storage.after(section);else if(backup)backup.before(section);else modal.appendChild(section);
    ui={section,total:section.querySelector('[data-role=total]'),pending:section.querySelector('[data-role=pending]'),project:section.querySelector('[data-role=project]'),message:section.querySelector('[data-role=message]'),cleanup:section.querySelector('[data-role=cleanup]'),start:section.querySelector('[data-role=projectExport]')};
    section.addEventListener('toggle',()=>{if(section.open)refreshUI();});ui.project.onchange=()=>refreshUI();
    const settings=section.closest('#sentlogSettingsModal');
    if(settings&&typeof MutationObserver==='function'){
      let visible=settings.getAttribute('aria-hidden')!=='true';
      new MutationObserver(()=>{
        const next=settings.getAttribute('aria-hidden')!=='true';
        if(next===visible)return;visible=next;
        if(visible&&section.open)void refreshUI();
      }).observe(settings,{attributes:true,attributeFilter:['aria-hidden','class']});
    }
    ui.start.onclick=()=>exportNext('project',ui.project.value).catch(e=>{ui.message.textContent=e.message||'一括保存を開けませんでした。';});
    ui.cleanup.onclick=async()=>{if(!confirm('この端末の全案件から、保存確認済みの元写真だけを削除します。未書き出し原本は削除しません。よろしいですか？'))return;try{const r=await deleteExported();ui.message.textContent=`${r.count}枚（${bytes(r.bytes)}）の保存確認済み原本を端末から削除しました。`;await refreshUI();}catch(e){ui.message.textContent='削除できませんでした：'+(e.message||e);}};
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

  const api={...pure,saveOriginal,getOriginal,getOriginalMeta,stageOriginal,updatePhotoAssociation,rebindPendingOriginal,listMeta,stats,drawingStats,renameDrawing,markExported,deleteExported,makeSharedPhoto,makeZip,refreshUI,exportNext,listProjectMeta,projectOptions,beginExportSession,confirmExportSession,releaseExportSession};
  root.SentlogOriginalPhotos=api;
  try{if(typeof addPhotosToSelected==='function')addPhotosToSelected=registerPhotos;}catch(e){console.warn('Sentlog original photo hook',e);}
  // app-settings.js inserts its dialog later in the document.write loader.
  // A one-shot timer can run before that script on reload, silently omitting
  // the original-photo controls. Attach exactly once when the dialog exists.
  // Observing DOM additions handles both immediate and delayed construction.
  if(typeof MutationObserver==='function'&&document.documentElement){
    let observer;
    const attach=()=>{
      installUI();
      if(ui||document.getElementById('sentlogOriginalPhotosSection')){
        observer?.disconnect();
        return true;
      }
      return false;
    };
    if(!attach()){
      observer=new MutationObserver(attach);
      observer.observe(document.documentElement,{childList:true,subtree:true});
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach,{once:true});
    }
  }else setTimeout(installUI,0);
})(typeof globalThis!=='undefined'?globalThis:this);

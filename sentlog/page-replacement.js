/* SentlogPageReplacement v1.98: replace exactly one PDF page while preserving all records. */
(function(root){
  'use strict';

  const VERSION=1;
  const MM_PER_PT=25.4/72;
  const TOLERANCE_MM=1.0;

  function normalizeRotation(value){
    const n=((Number(value)||0)%360+360)%360;
    return n===90||n===180||n===270?n:0;
  }
  function pageRecordStats(shapes,page){
    const list=(shapes||[]).filter(s=>(Number(s?.page)||1)===Number(page));
    let damage=0,dimensions=0,memos=0,photos=0;
    for(const s of list){
      photos+=Array.isArray(s?.photos)?s.photos.length:0;
      if(s?.recordKind==='drawing-memo')memos++;
      else if(s?.recordKind==='dimension-line'||s?.kind==='dimension')dimensions++;
      else damage++;
    }
    return {damage,dimensions,memos,photos,total:list.length};
  }
  function frameCompatible(source,replacement,tolerance=TOLERANCE_MM){
    if(Number(replacement?.pageCount)!==1)return {ok:false,reason:'差し替え用PDFは1ページにしてください。'};
    if(!source||!replacement)return {ok:false,reason:'PDFのページ情報を確認できません。'};
    if(normalizeRotation(source.rotation)!==normalizeRotation(replacement.rotation))
      return {ok:false,reason:'元ページと差し替えページのPDF回転方向が異なります。'};
    const dw=Math.abs(Number(source.wMm)-Number(replacement.wMm));
    const dh=Math.abs(Number(source.hMm)-Number(replacement.hMm));
    if(!Number.isFinite(dw)||!Number.isFinite(dh))return {ok:false,reason:'PDFの用紙寸法を確認できません。'};
    if(dw>tolerance||dh>tolerance)
      return {ok:false,reason:'元ページと差し替えページの用紙寸法が異なります。'};
    return {ok:true};
  }
  function nextMarker(markers,page,fileName,now=Date.now(),restored=false,pdfHash='',pdfSize=0){
    const all=markers&&typeof markers==='object'&&!Array.isArray(markers)?markers:{};
    const key=String(page),old=all[key]&&typeof all[key]==='object'?all[key]:{};
    const marker={
      revision:Math.max(0,Number(old.revision)||0)+1,
      updatedAt:Number(now)||Date.now(),
      fileName:String(fileName||''),
      preservedRecords:true,
      restored:!!restored
    };
    const normalizedHash=String(pdfHash||'').trim().toLowerCase();
    if(/^[0-9a-f]{64}$/.test(normalizedHash))marker.pdfHash=normalizedHash;
    const size=Number(pdfSize);
    if(Number.isFinite(size)&&size>0)marker.pdfSize=size;
    return {...all,[key]:marker};
  }

  const pure={VERSION,normalizeRotation,pageRecordStats,frameCompatible,nextMarker};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogPageReplacement)return;

  let library=null,busy=false;
  const byId=id=>document.getElementById(id);
  const backupFileKey=id=> 'page-replace-backup:'+id;
  const backupMetaKey=id=> 'page-replace-backup-meta:'+id;
  const openingSequence=()=>typeof drawingOpenSequence==='number'?drawingOpenSequence:null;
  const fileOpeningSequence=()=>typeof drawingFileOpenSequence==='number'?drawingFileOpenSequence:null;
  function changed(message='操作中に開いている図面が変わりました。処理を中止しました。'){
    return Object.assign(Error(message),{code:'PAGE_REPLACEMENT_CHANGED'});
  }
  function captureTarget(){
    const records=root.SentlogRecords,cap=records?.getFileWriteCapabilities?.();
    if(cap?.expectedFileStatesVersion!==1||cap.guarded!==true||typeof records.readFileStates!=='function'||typeof records.writerState!=='function')
      throw Error('安全なPDF差し替えの保存機能を読み込めません。画面を更新してください。');
    if(root.sentlogImporting)throw Error('別の取込み処理が進行しています。完了してから操作してください。');
    const id=activeDrawingId;
    return {records,projectId:activeProjectId,drawingId:id,state,opening:openingSequence(),fileOpening:fileOpeningSequence(),
      background:'background:'+id,backup:backupFileKey(id),meta:backupMetaKey(id),importing:false,markerWritten:false};
  }
  function sameTarget(target){
    return currentView==='editor'&&activeProjectId===target.projectId&&activeDrawingId===target.drawingId&&state===target.state&&
      openingSequence()===target.opening&&fileOpeningSequence()===target.fileOpening&&root.SentlogRecords===target.records;
  }
  function checkTarget(target,navigation=true){
    if(navigation&&!sameTarget(target))throw changed();
    target.records.assertSafe();
    for(const key of [target.background,target.backup,target.meta]){
      const writer=target.records.writerState(key,{ownerToken:target});
      if(writer.foreignPending||writer.failed)throw changed('対象図面のPDFを別の処理が保存しています。上書きせず停止しました。');
    }
    return true;
  }
  async function snapshot(target,key,navigation=true){
    checkTarget(target,navigation);
    const [before]=await target.records.readFileStates([key]);checkTarget(target,navigation);
    const value=await getDBFile(key);checkTarget(target,navigation);
    const sha256=value instanceof Blob?await hash(value):null;checkTarget(target,navigation);
    const [after]=await target.records.readFileStates([key]);checkTarget(target,navigation);
    if(before.sequence!==after.sequence)throw changed('確認中にPDFの保存内容が変わりました。上書きせず停止しました。');
    return {key,sequence:after.sequence,value,sha256,size:value instanceof Blob?value.size:0};
  }
  async function verify(target,expected,navigation=true){
    const current=await snapshot(target,expected.key,navigation);
    if(current.sequence!==expected.sequence||current.sha256!==expected.sha256||current.size!==expected.size)
      throw changed('確認したPDFの保存内容が変わりました。上書きせず停止しました。');
    return current;
  }
  async function guardedWrite(target,key,value,expected,navigation=true){
    checkTarget(target,navigation);
    const sha256=await hash(value);checkTarget(target,navigation);
    const result=await target.records.writeFile(key,value,{ownerToken:target,
      validate:()=>checkTarget(target,navigation),expectedFileStates:expected.map(x=>({key:x.key,sequence:x.sequence}))});
    if(!Number.isSafeInteger(result?.sequence)||result.sequence<0)throw Error('保存したPDFの世代を確認できません。');
    return {key,sequence:result.sequence,value,sha256,size:value.size};
  }
  async function showOwnedPdf(target,file){
    checkTarget(target);
    const opening=openFile(file,false);
    // The normal openFile and its PDF wrappers start their epoch synchronously.
    // Do not accept a later opening, including the same drawing opened again.
    target.fileOpening=fileOpeningSequence();
    await opening;checkTarget(target);
  }

  async function libs(){
    if(root.PDFLib)return root.PDFLib;
    if(!library)library=new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.src='./vendor/export-pdf-lib.min.js?v=1171';
      s.onload=()=>resolve(root.PDFLib);
      s.onerror=()=>{library=null;s.remove();reject(Error('PDFページ差し替え機能を読み込めません。通信を確認してください。'));};
      document.head.append(s);
    });
    return library;
  }
  async function hash(blob){
    const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function inspectPage(file,pageNo){
    if(!(file instanceof Blob)||!file.size)throw Error('PDFを読み取れません。');
    if(!root.pdfjsLib)throw Error('PDF表示エンジンを読み込めません。');
    const bytes=new Uint8Array(await file.arrayBuffer());
    const doc=await pdfjsLib.getDocument({data:bytes}).promise;
    try{
      const count=doc.numPages;
      if(pageNo<1||pageNo>count)throw Error('PDFのページ番号を確認できません。');
      const page=await doc.getPage(pageNo);
      const rotation=normalizeRotation(page.rotate||0);
      const viewport=page.getViewport({scale:1,rotation});
      return {pageCount:count,rotation,wMm:viewport.width*MM_PER_PT,hMm:viewport.height*MM_PER_PT};
    }finally{try{await doc.destroy?.();}catch{}}
  }
  async function compose(source,replacement,pageNo,fileName){
    const P=await libs();
    const sourceDoc=await P.PDFDocument.load(await source.arrayBuffer(),{updateMetadata:false});
    const donorDoc=await P.PDFDocument.load(await replacement.arrayBuffer(),{updateMetadata:false});
    if(sourceDoc.getPageCount()<pageNo)throw Error('元PDFの対象ページを確認できません。');
    if(donorDoc.getPageCount()!==1)throw Error('差し替え用PDFは1ページにしてください。');
    const [newPage]=await sourceDoc.copyPages(donorDoc,[0]);
    sourceDoc.removePage(pageNo-1);
    sourceDoc.insertPage(pageNo-1,newPage);
    const bytes=await sourceDoc.save();
    const name=source.name||fileName||'drawing.pdf';
    return new File([bytes],name,{type:'application/pdf',lastModified:Date.now()});
  }
  async function readMeta(id){
    const blob=await getDBFile(backupMetaKey(id));
    if(!(blob instanceof Blob)||!blob.size)return null;
    try{return JSON.parse(await blob.text());}catch{return null;}
  }
  function metaBlob(meta){return new Blob([JSON.stringify(meta)],{type:'application/json'});}
  function parseMeta(value){
    if(!(value instanceof Blob)||!value.size)return Promise.resolve(null);
    return value.text().then(text=>{try{return JSON.parse(text);}catch{return null;}});
  }
  async function waitForIdle(target){
    await target.records.settled();checkTarget(target);
    if(root.sentlogCloudIdle){await root.sentlogCloudIdle();checkTarget(target);}
    if(root.sentlogPdfRecoveryIdle){await root.sentlogPdfRecoveryIdle();checkTarget(target);}
  }
  function beginImport(target){
    checkTarget(target);
    if(root.sentlogImporting)throw Error('別の取込み処理が進行しています。完了してから操作してください。');
    target.importing=true;root.sentlogImporting=true;
  }
  async function applyPdf(target,{previous,next,backup,metaState,meta,page,name,restored}){
    await verify(target,previous);checkTarget(target);
    target.previous=previous;target.extra=[backup,metaState];
    target.writeAttempted=true;
    target.committed=await guardedWrite(target,target.background,next,[previous,backup,metaState]);
    await verify(target,target.committed);checkTarget(target);
    await showOwnedPdf(target,next);checkTarget(target);
    // Rendering may yield to navigation or another writer. Check both the UI
    // identity and the durable file before touching page markers or records.
    await verify(target,target.committed);checkTarget(target);
    state.currentPage=page;
    state.pageReplacements=nextMarker(state.pageReplacements,page,name,Date.now(),restored,target.committed.sha256,next.size);
    target.markerWritten=true;persist();await target.records.flush();checkTarget(target);
    const completedMeta=restored?meta:{...meta,replacementSequence:target.committed.sequence};
    await guardedWrite(target,target.meta,metaBlob(completedMeta),[target.committed,backup,metaState]);checkTarget(target);
    render();renderSelectedPhotos();updatePageUI();
  }
  async function handleFailure(target,error,undo=false){
    console.error(undo?'page replacement undo':'page replacement',error);
    let restored=false;
    // A navigation change may leave this operation's file on its original
    // drawing. Only that exact committed version may be rolled back; never
    // write through the now-active drawing, or guess after an ambiguous commit.
    if(target?.committed&&!target.markerWritten){
      try{
        await verify(target,target.committed,false);
        const restoredFile=await guardedWrite(target,target.background,target.previous.value,[target.committed,...target.extra],false);
        await verify(target,restoredFile,false);restored=true;
        if(sameTarget(target)){await showOwnedPdf(target,target.previous.value);checkTarget(target);persist();await target.records.flush();checkTarget(target);}
      }catch(restoreError){console.error('page replacement rollback',restoreError);}
    }
    const status=restored?'対象図面の操作前のPDFへ戻しました。':target?.writeAttempted?
      '処理の完了を確認できません。保存済みPDFと退避PDFを確認してください。':'PDFの置換前に処理を中止しました。';
    alert((undo?'元に戻す処理を完了できませんでした。':'ページ差し替えを中止しました。')+'\n'+status+'\n'+(error?.message||error));
  }
  function summaryText(stats){
    const parts=[];
    if(stats.damage)parts.push('変状 '+stats.damage+'件');
    if(stats.dimensions)parts.push('寸法 '+stats.dimensions+'件');
    if(stats.memos)parts.push('メモ '+stats.memos+'件');
    if(stats.photos)parts.push('写真 '+stats.photos+'枚');
    return parts.length?parts.join('、'):'このページに登録記録はありません';
  }
  async function updateUndoButton(){
    const b=byId('sentlogPageReplaceUndoBtn');if(!b)return;
    const id=activeDrawingId,opened=openingSequence(),model=state;
    try{
      const meta=await readMeta(id);
      if(id!==activeDrawingId||opened!==openingSequence()||model!==state){b.disabled=true;return;}
      b.disabled=busy||currentView!=='editor'||!meta?.applied||meta?.drawingId!==id;
      b.title=meta?.applied?'直前のページ差し替え前のPDF全体へ戻します。':'この端末に戻せるページ差し替えはありません。';
    }catch{b.disabled=true;}
  }
  async function replaceCurrentPage(file){
    if(busy)return;
    if(currentView!=='editor'||state?.sourceType!=='pdf'||!activeDrawingId){alert('PDF図面を開いてから操作してください。');return;}
    busy=true;let target;
    try{
      target=captureTarget();checkTarget(target);updateUndoButton();
      const page=Number(target.state.currentPage)||1,fileName=target.state.fileName;
      const previous=await snapshot(target,target.background),source=previous.value;
      if(!(source instanceof Blob)||!source.size)throw Error('元PDFがこの端末にありません。同期またはPDF再取得を確認してください。');
      const sourceInfo=await inspectPage(source,page);checkTarget(target);
      const replacementInfo=await inspectPage(file,1);checkTarget(target);
      if(replacementInfo.pageCount!==1){alert('差し替え用PDFは1ページにしてください。\n元のPDF全体は変更しません。');return;}
      if(sourceInfo.pageCount!==Number(state.pageCount||sourceInfo.pageCount)){
        alert('元PDFと記録上のページ数が一致しないため、差し替えを中止しました。記録は変更していません。');return;
      }
      const compatible=frameCompatible(sourceInfo,replacementInfo);
      if(!compatible.ok){
        alert('このページは安全に差し替えできません。\n\n'+compatible.reason+'\n\n既存の記録・写真・メモは変更していません。');return;
      }
      const stats=pageRecordStats(state.shapes,page);
      const name=file.name||'差し替えPDF';
      if(!confirm(
        page+'ページ目だけを「'+name+'」の1ページに差し替えます。\n\n'+
        'PDF全体の '+sourceInfo.pageCount+'ページ構成、ページ番号、他ページは変更しません。\n'+
        summaryText(stats)+' はそのまま保持します。\n'+
        '縮尺設定・写真リンク・コメントも削除しません。\n\n差し替えますか？'
      ))return;

      beginImport(target);await waitForIdle(target);
      await verify(target,previous);
      const oldBackup=await snapshot(target,target.backup),oldMeta=await snapshot(target,target.meta);
      const backup=await guardedWrite(target,target.backup,source,[previous,oldBackup,oldMeta]);
      await verify(target,backup);checkTarget(target);
      const meta={version:1,drawingId:target.drawingId,page,savedAt:new Date().toISOString(),sourceHash:previous.sha256,sourceSize:source.size,applied:false};
      const metaState=await guardedWrite(target,target.meta,metaBlob(meta),[previous,backup,oldMeta]);checkTarget(target);
      const merged=await compose(source,file,page,fileName);checkTarget(target);
      const mergedInfo=await inspectPage(merged,page);checkTarget(target);
      if(mergedInfo.pageCount!==sourceInfo.pageCount)throw Error('差し替え後PDFのページ数が変わっています。');
      const verified=frameCompatible(sourceInfo,{...mergedInfo,pageCount:1});
      if(!verified.ok)throw Error('差し替え後ページの照合に失敗しました。'+verified.reason);

      const mergedHash=await hash(merged);checkTarget(target);
      await applyPdf(target,{previous,next:merged,backup,metaState,page,name,restored:false,
        meta:{...meta,applied:true,replacementName:name,replacementHash:mergedHash,replacementSize:merged.size}});
      alert(page+'ページ目だけを差し替えました。\n既存の記録・写真・コメントは保持されています。');
    }catch(e){await handleFailure(target,e);
    }finally{
      if(target?.importing)root.sentlogImporting=false;busy=false;await updateUndoButton();
    }
  }
  async function undoLast(){
    if(busy)return;
    if(currentView!=='editor'||state?.sourceType!=='pdf'||!activeDrawingId){alert('PDF図面を開いてから操作してください。');return;}
    busy=true;let target;
    try{
      target=captureTarget();checkTarget(target);updateUndoButton();
      const metaState=await snapshot(target,target.meta),meta=await parseMeta(metaState.value);checkTarget(target);
      if(!meta?.applied||meta.drawingId!==target.drawingId)throw Error('この端末に戻せるページ差し替えはありません。');
      const backup=await snapshot(target,target.backup),previous=await snapshot(target,target.background);
      if(!(backup.value instanceof Blob)||!backup.size||backup.size!==Number(meta.sourceSize)||backup.sha256!==meta.sourceHash)
        throw Error('差し替え前PDFの照合に失敗したため、元に戻しません。');
      if(!meta.replacementHash||!meta.replacementSize||previous.sha256!==meta.replacementHash||previous.size!==Number(meta.replacementSize)||
        meta.replacementSequence!==undefined&&(!Number.isSafeInteger(meta.replacementSequence)||meta.replacementSequence!==previous.sequence))
        throw changed('差し替え後にPDFが変更されています。現在のPDFを上書きせず停止しました。');
      if(!confirm('直前のページ差し替え前のPDF全体へ戻します。\n変状・写真・コメントなどの記録は削除しません。\n\n元に戻しますか？'))return;
      beginImport(target);await waitForIdle(target);
      const page=Math.min(Math.max(1,Number(meta.page)||1),Number(state.pageCount)||1);
      await applyPdf(target,{previous,next:backup.value,backup,metaState,page,name:'差し替え前に復元',restored:true,
        meta:{...meta,applied:false,restoredAt:new Date().toISOString()}});
      alert('直前のページ差し替え前へ戻しました。記録は保持されています。');
    }catch(e){await handleFailure(target,e,true);}
    finally{if(target?.importing)root.sentlogImporting=false;busy=false;await updateUndoButton();}
  }
  function install(){
    const host=byId('sentlogPageManagementActions');
    if(!host||byId('sentlogPageReplaceBtn'))return;
    const input=document.createElement('input');input.id='sentlogPageReplaceInput';input.type='file';input.accept='application/pdf,.pdf';input.hidden=true;
    input.onchange=async e=>{const file=e.target.files?.[0];e.target.value='';if(file)await replaceCurrentPage(file);};
    const replace=document.createElement('button');replace.id='sentlogPageReplaceBtn';replace.type='button';replace.textContent='このページを差し替え';
    replace.onclick=()=>{if(state?.sourceType!=='pdf')return;input.click();};
    const undo=document.createElement('button');undo.id='sentlogPageReplaceUndoBtn';undo.type='button';undo.textContent='直前の差し替えを元に戻す';undo.onclick=undoLast;undo.disabled=true;
    host.append(replace,undo);document.body.append(input);
    const style=document.createElement('style');style.id='sentlogPageReplacementStyle';
    style.textContent='#sentlogPageReplaceBtn{border-color:#93c5fd;background:#eff6ff;color:#1d4ed8}#sentlogPageReplaceUndoBtn{border-color:#d1d5db;background:#fff;color:#374151}#sentlogPageReplaceUndoBtn:disabled{opacity:.45}';
    document.head.append(style);
    updateUndoButton();
  }

  root.SentlogPageReplacement={...pure,navigationGuardVersion:1,replaceCurrentPage,undoLast};
  Promise.resolve(root.sentlogAppReady).then(()=>queueMicrotask(install)).catch(()=>{});
})(typeof globalThis!=='undefined'?globalThis:this);

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
  const backupFileKey=()=> 'page-replace-backup:'+activeDrawingId;
  const backupMetaKey=()=> 'page-replace-backup-meta:'+activeDrawingId;

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
  async function compose(source,replacement,pageNo){
    const P=await libs();
    const sourceDoc=await P.PDFDocument.load(await source.arrayBuffer(),{updateMetadata:false});
    const donorDoc=await P.PDFDocument.load(await replacement.arrayBuffer(),{updateMetadata:false});
    if(sourceDoc.getPageCount()<pageNo)throw Error('元PDFの対象ページを確認できません。');
    if(donorDoc.getPageCount()!==1)throw Error('差し替え用PDFは1ページにしてください。');
    const [newPage]=await sourceDoc.copyPages(donorDoc,[0]);
    sourceDoc.removePage(pageNo-1);
    sourceDoc.insertPage(pageNo-1,newPage);
    const bytes=await sourceDoc.save();
    const name=source.name||state.fileName||'drawing.pdf';
    return new File([bytes],name,{type:'application/pdf',lastModified:Date.now()});
  }
  async function readMeta(){
    const blob=await getDBFile(backupMetaKey());
    if(!(blob instanceof Blob)||!blob.size)return null;
    try{return JSON.parse(await blob.text());}catch{return null;}
  }
  async function writeMeta(meta){
    await root.SentlogRecords.writeFile(backupMetaKey(),new Blob([JSON.stringify(meta)],{type:'application/json'}));
  }
  async function waitForIdle(){
    await root.SentlogRecords.settled();
    root.SentlogRecords.assertSafe();
    if(root.sentlogCloudIdle)await root.sentlogCloudIdle();
    if(root.sentlogPdfRecoveryIdle)await root.sentlogPdfRecoveryIdle();
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
    try{
      const meta=await readMeta();
      b.disabled=busy||!meta?.applied||meta?.drawingId!==activeDrawingId;
      b.title=meta?.applied?'直前のページ差し替え前のPDF全体へ戻します。':'この端末に戻せるページ差し替えはありません。';
    }catch{b.disabled=true;}
  }
  async function replaceCurrentPage(file){
    if(busy)return;
    if(state?.sourceType!=='pdf'||!activeDrawingId){alert('PDF図面を開いてから操作してください。');return;}
    const page=Number(state.currentPage)||1;
    const source=await getBackgroundFile(activeDrawingId);
    if(!(source instanceof Blob)||!source.size){alert('元PDFがこの端末にありません。同期またはPDF再取得を確認してください。');return;}
    let sourceInfo,replacementInfo;
    try{
      sourceInfo=await inspectPage(source,page);
      replacementInfo=await inspectPage(file,1);
    }catch(e){alert('差し替え用PDFを確認できません。\n'+(e?.message||e));return;}
    if(replacementInfo.pageCount!==1){alert('差し替え用PDFは1ページにしてください。\n元の8ページPDF全体は変更しません。');return;}
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

    busy=true;updateUndoButton();
    let changedBackground=false;
    root.sentlogImporting=true;
    try{
      await waitForIdle();
      const sourceHash=await hash(source);
      await root.SentlogRecords.writeFile(backupFileKey(),source);
      const backup=await getDBFile(backupFileKey());
      if(!(backup instanceof Blob)||backup.size!==source.size||await hash(backup)!==sourceHash)
        throw Error('差し替え前PDFの退避照合に失敗しました。');

      const meta={version:1,drawingId:activeDrawingId,page,savedAt:new Date().toISOString(),sourceHash,sourceSize:source.size,applied:false};
      await writeMeta(meta);

      const merged=await compose(source,file,page);
      const mergedInfo=await inspectPage(merged,page);
      if(mergedInfo.pageCount!==sourceInfo.pageCount)throw Error('差し替え後PDFのページ数が変わっています。');
      const verified=frameCompatible(sourceInfo,{...mergedInfo,pageCount:1});
      if(!verified.ok)throw Error('差し替え後ページの照合に失敗しました。'+verified.reason);

      await saveBackgroundFile(merged,activeDrawingId);
      changedBackground=true;
      const stored=await getBackgroundFile(activeDrawingId);
      const mergedHash=await hash(merged);
      if(!(stored instanceof Blob)||stored.size!==merged.size||await hash(stored)!==mergedHash)
        throw Error('差し替え後PDFの端末保存照合に失敗しました。');

      const keepPage=page;
      await openFile(merged,false);
      state.currentPage=keepPage;
      state.pageReplacements=nextMarker(state.pageReplacements,page,name,Date.now(),false,mergedHash,merged.size);
      persist();
      await root.SentlogRecords.flush();
      await writeMeta({...meta,applied:true,replacementName:name,replacementHash:mergedHash,replacementSize:merged.size});
      render();renderSelectedPhotos();updatePageUI();
      alert(page+'ページ目だけを差し替えました。\n既存の記録・写真・コメントは保持されています。');
    }catch(e){
      console.error('page replacement',e);
      if(changedBackground){
        try{
          await saveBackgroundFile(source,activeDrawingId);
          await openFile(source,false);
          persist();await root.SentlogRecords.flush();
        }catch(restoreError){console.error('page replacement rollback',restoreError);}
      }
      alert('ページ差し替えを中止しました。元PDFと記録を保持します。\n'+(e?.message||e));
    }finally{
      root.sentlogImporting=false;busy=false;await updateUndoButton();
    }
  }
  async function undoLast(){
    if(busy)return;
    const meta=await readMeta();
    if(!meta?.applied||meta.drawingId!==activeDrawingId){alert('この端末に戻せるページ差し替えはありません。');return;}
    const backup=await getDBFile(backupFileKey());
    if(!(backup instanceof Blob)||!backup.size){alert('差し替え前PDFの退避データが見つかりません。');return;}
    if(backup.size!==Number(meta.sourceSize)||await hash(backup)!==meta.sourceHash){alert('差し替え前PDFの照合に失敗したため、元に戻しません。');return;}
    if(!confirm('直前のページ差し替え前のPDF全体へ戻します。\n変状・写真・コメントなどの記録は削除しません。\n\n元に戻しますか？'))return;
    busy=true;updateUndoButton();root.sentlogImporting=true;
    try{
      await waitForIdle();
      await saveBackgroundFile(backup,activeDrawingId);
      const stored=await getBackgroundFile(activeDrawingId);
      if(!(stored instanceof Blob)||stored.size!==backup.size||await hash(stored)!==meta.sourceHash)throw Error('復元後PDFの照合に失敗しました。');
      const page=Math.min(Math.max(1,Number(meta.page)||1),Number(state.pageCount)||1);
      await openFile(backup,false);
      state.currentPage=page;
      state.pageReplacements=nextMarker(state.pageReplacements,page,'差し替え前に復元',Date.now(),true,meta.sourceHash,backup.size);
      persist();await root.SentlogRecords.flush();
      await writeMeta({...meta,applied:false,restoredAt:new Date().toISOString()});
      render();renderSelectedPhotos();updatePageUI();
      alert('直前のページ差し替え前へ戻しました。記録は保持されています。');
    }catch(e){console.error('page replacement undo',e);alert('元に戻す処理を完了できませんでした。\n'+(e?.message||e));}
    finally{root.sentlogImporting=false;busy=false;await updateUndoButton();}
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

  root.SentlogPageReplacement={...pure,replaceCurrentPage,undoLast};
  Promise.resolve(root.sentlogAppReady).then(()=>queueMicrotask(install)).catch(()=>{});
})(typeof globalThis!=='undefined'?globalThis:this);

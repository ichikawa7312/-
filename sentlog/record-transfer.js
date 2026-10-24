/* SentlogRecordTransfer v1.99: safe record copy/move across drawings and pages. */
(function(root){
  'use strict';

  const VERSION=1;
  const WS_KEY='surveyFieldNoteWorkspaceV1';
  const DRAW_KEY=id=>'surveyFieldNoteDrawingV1:'+id;
  const copy=x=>JSON.parse(JSON.stringify(x));

  function point(value,sx,sy){
    if(!value||typeof value!=='object')return value;
    if(!Number.isFinite(Number(value.x))||!Number.isFinite(Number(value.y)))return copy(value);
    return {...copy(value),x:Number(value.x)*sx,y:Number(value.y)*sy};
  }
  function transformShape(shape,{sx=1,sy=1,page=1,id,photoIds=[]}={}){
    const out=copy(shape);
    out.id=id||out.id;
    out.page=Number(page)||1;
    if(Array.isArray(out.points))out.points=out.points.map(p=>point(p,sx,sy));
    for(const key of ['labelPos','center','start','end','anchor','textPos','leaderPos','arrowStart','arrowEnd']){
      if(out[key]&&typeof out[key]==='object')out[key]=point(out[key],sx,sy);
    }
    if(Number.isFinite(Number(out.x)))out.x=Number(out.x)*sx;
    if(Number.isFinite(Number(out.y)))out.y=Number(out.y)*sy;
    if(Number.isFinite(Number(out.w)))out.w=Number(out.w)*sx;
    if(Number.isFinite(Number(out.h)))out.h=Number(out.h)*sy;
    if(Array.isArray(out.photos)){
      out.photos=out.photos.map((p,i)=>({...copy(p),id:photoIds[i]||p.id}));
    }
    return out;
  }
  function makeTransferPlan(sourceState,targetState,ids,options={}){
    const operation=options.operation==='move'?'move':'copy';
    const targetPage=Math.max(1,Number(options.targetPage)||1);
    const sameDrawing=options.sameDrawing===true;
    const sx=Number(options.sx)||1,sy=Number(options.sy)||1;
    const sourceId=String(options.sourceDrawingId||''),targetId=String(options.targetDrawingId||'');
    const idFactory=options.idFactory||(()=>crypto.randomUUID());
    const photoIdFactory=options.photoIdFactory||(()=>crypto.randomUUID());
    const wanted=new Set(ids||[]);
    const originals=(sourceState?.shapes||[]).filter(s=>wanted.has(s.id));
    if(!originals.length)throw Error('移動する記録が選択されていません。');
    if(originals.length!==wanted.size)throw Error('選択した記録をすべて確認できません。');

    const src=copy(sourceState),dst=sameDrawing?src:copy(targetState);
    if(!Array.isArray(src.shapes))src.shapes=[];
    if(!Array.isArray(dst.shapes))dst.shapes=[];
    if(operation==='move')src.shapes=src.shapes.filter(s=>!wanted.has(s.id));

    const photoJobs=[],newIds=[];
    for(const original of originals){
      const newId=idFactory(),newPhotoIds=(original.photos||[]).map(()=>photoIdFactory());
      const moved=transformShape(original,{sx,sy,page:targetPage,id:newId,photoIds:newPhotoIds});
      moved.transferOrigin={drawingId:sourceId,page:Number(original.page)||1,recordId:original.id,operation};
      dst.shapes.push(moved);newIds.push(newId);
      (original.photos||[]).forEach((photo,i)=>photoJobs.push({
        sourceDrawingId:sourceId,targetDrawingId:targetId,
        sourcePhotoId:photo.id,targetPhotoId:newPhotoIds[i],recordId:original.id,newRecordId:newId
      }));
    }
    return {sourceState:src,targetState:dst,newIds,photoJobs,originals:copy(originals),operation,sameDrawing};
  }
  function recordLabel(s){
    if(s?.recordKind==='drawing-memo')return '図面メモ';
    if(s?.recordKind==='dimension-line'||s?.kind==='dimension')return s?.manualText?'寸法 '+s.manualText:'寸法';
    return s?.autoLabel||s?.no||s?.type||'記録';
  }
  function recordStats(records){
    let photos=0;for(const s of records||[])photos+=(s?.photos||[]).length;
    return {records:(records||[]).length,photos};
  }

  const pure={VERSION,transformShape,makeTransferPlan,recordLabel,recordStats};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogRecordTransfer)return;

  let dialog=null,busy=false;
  const byId=id=>document.getElementById(id);
  const newId=()=>crypto.randomUUID?crypto.randomUUID():'transfer-'+Date.now()+'-'+Math.random().toString(16).slice(2);
  const parse=(value,fallback=null)=>{try{return JSON.parse(value||'');}catch{return fallback;}};

  async function sha(blob){
    const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function frame(file,pageNo,drawingState){
    if(!(file instanceof Blob)||!file.size)throw Error('図面ファイルがこの端末にありません。同期または再取得してください。');
    if(drawingState?.sourceType==='pdf'||file.type==='application/pdf'||/\.pdf$/i.test(file.name||drawingState?.fileName||'')){
      if(!root.pdfjsLib)throw Error('PDF表示エンジンを読み込めません。');
      const doc=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
      try{
        if(pageNo<1||pageNo>doc.numPages)throw Error('移動先ページを確認できません。');
        const p=await doc.getPage(pageNo),intrinsic=normalizeRotation(p.rotate||0);
        const base=p.getViewport({scale:1,rotation:intrinsic});
        const targetScale=Math.min(2.2,Math.max(1.35,1800/base.width));
        const rotation=normalizeRotation(intrinsic+Number(drawingState?.pageRotations?.[String(pageNo)]||0));
        const viewport=p.getViewport({scale:targetScale,rotation});
        return {width:viewport.width,height:viewport.height,ratio:viewport.width/viewport.height};
      }finally{try{await doc.destroy?.();}catch{}}
    }
    if(pageNo!==1)throw Error('画像図面は1ページのみです。');
    const url=URL.createObjectURL(file);
    try{
      return await new Promise((resolve,reject)=>{
        const img=new Image();
        img.onload=()=>resolve({width:img.naturalWidth,height:img.naturalHeight,ratio:img.naturalWidth/img.naturalHeight});
        img.onerror=()=>reject(Error('移動先画像を読み取れません。'));img.src=url;
      });
    }finally{URL.revokeObjectURL(url);}
  }
  function loadState(id){
    const raw=root.SentlogRecords.getItem(DRAW_KEY(id));
    const value=parse(raw,null);
    if(!value||!Array.isArray(value.shapes))throw Error('移動先図面の記録をこの端末で確認できません。同期してから再試行してください。');
    return {raw,state:value};
  }
  function visiblePages(st){
    const count=Math.max(1,Number(st?.pageCount)||1),out=[];
    for(let p=1;p<=count;p++)if(!st?.pageStates?.[String(p)]?.hidden)out.push(p);
    return out;
  }
  function renumber(st){
    const previous=state;
    try{state=st;rebuildNumberingState();}
    finally{state=previous;}
  }
  function counts(st){
    const shapes=st?.shapes||[];
    return {shapeCount:shapes.length,photoCount:shapes.reduce((n,s)=>n+(s?.photos?.length||0),0)};
  }
  function pageSetting(st,page){return st?.pageSettings?.[String(page)]||{};}
  function sameSetting(a,b){return JSON.stringify(a||{})===JSON.stringify(b||{});}
  function close(){dialog?.close?.();dialog?.remove();dialog=null;}
  function button(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;return b;}

  async function waitForIdle(){
    root.sentlogImporting=true;
    await root.SentlogRecords.settled();root.SentlogRecords.assertSafe();
    if(root.sentlogCloudIdle)await root.sentlogCloudIdle();
    if(root.sentlogPdfRecoveryIdle)await root.sentlogPdfRecoveryIdle();
  }
  async function copyPhotos(jobs){
    const prepared=[];
    for(const job of jobs){
      const source=await getDBFile('photo:'+job.sourceDrawingId+':'+job.sourcePhotoId);
      if(!(source instanceof Blob)||!source.size)throw Error('写真データをこの端末で確認できません。写真を再取得してから移動してください。');
      prepared.push({...job,blob:source,hash:await sha(source)});
    }
    for(const job of prepared){
      const key='photo:'+job.targetDrawingId+':'+job.targetPhotoId;
      await root.SentlogRecords.writeFile(key,job.blob);
      const stored=await getDBFile(key);
      if(!(stored instanceof Blob)||stored.size!==job.blob.size||await sha(stored)!==job.hash)
        throw Error('移動先への写真保存照合に失敗しました。元の記録は変更していません。');
    }
  }
  async function execute({ids,operation,targetDrawingId,targetPage}){
    if(busy)return;
    const projectId=activeProjectId,sourceDrawingId=activeDrawingId,sourcePage=Number(state.currentPage)||1;
    if(!projectId||!sourceDrawingId)throw Error('移動元の図面を確認できません。');
    if(sourceDrawingId===targetDrawingId&&sourcePage===targetPage)throw Error('同じページにはコピー／移動できません。');

    const p=getProject(projectId),targetMeta=p?.drawings?.find(d=>d.id===targetDrawingId);
    if(!p||!targetMeta)throw Error('移動先の図面を確認できません。');
    const sourceLoaded=loadState(sourceDrawingId),targetLoaded=sourceDrawingId===targetDrawingId?sourceLoaded:loadState(targetDrawingId);
    if(!visiblePages(targetLoaded.state).includes(Number(targetPage)))throw Error('非表示ページには移動できません。ページ管理で表示してから再試行してください。');

    const chosen=sourceLoaded.state.shapes.filter(s=>ids.includes(s.id));
    if(chosen.length!==ids.length)throw Error('選択した記録が変更されています。画面を開き直して再選択してください。');
    const sourceFile=await getBackgroundFile(sourceDrawingId),targetFile=sourceDrawingId===targetDrawingId?sourceFile:await getBackgroundFile(targetDrawingId);
    const sourceFrame=await frame(sourceFile,sourcePage,sourceLoaded.state),targetFrame=await frame(targetFile,targetPage,targetLoaded.state);
    const sx=targetFrame.width/sourceFrame.width,sy=targetFrame.height/sourceFrame.height;
    const aspectDiff=Math.abs(targetFrame.ratio-sourceFrame.ratio)/Math.max(.0001,sourceFrame.ratio);
    const scaleDiff=!sameSetting(pageSetting(sourceLoaded.state,sourcePage),pageSetting(targetLoaded.state,targetPage));
    const stat=recordStats(chosen),warnings=[];
    if(aspectDiff>.025)warnings.push('図面の縦横比が異なるため、相対位置で仮配置します。移動後に位置を確認してください。');
    if(scaleDiff)warnings.push('図面設定（用紙・縮尺）が異なります。寸法・数量表示は移動先の設定で再計算される場合があります。');
    const verb=operation==='move'?'移動':'コピー';
    if(!confirm(
      stat.records+'件の記録'+(stat.photos?'（写真 '+stat.photos+'枚を含む）':'')+'を\n'+
      '「'+targetMeta.name+'」 '+targetPage+'ページ目へ'+verb+'します。\n\n'+
      (warnings.length?warnings.join('\n')+'\n\n':'')+
      (operation==='move'?'移動先への写真保存を確認してから、元ページの記録を削除します。':'元ページの記録はそのまま残します。')+
      '\n\n実行しますか？'
    ))return;

    busy=true;let committed=false;
    const beforeWorkspaceRaw=root.SentlogRecords.getItem(WS_KEY);
    const beforeSourceRaw=sourceLoaded.raw,beforeTargetRaw=targetLoaded.raw;
    try{
      await waitForIdle();
      const plan=makeTransferPlan(sourceLoaded.state,targetLoaded.state,ids,{
        operation,targetPage,sameDrawing:sourceDrawingId===targetDrawingId,sx,sy,
        sourceDrawingId,targetDrawingId,idFactory:newId,photoIdFactory:newId
      });
      await copyPhotos(plan.photoJobs);
      renumber(plan.targetState);if(!plan.sameDrawing)renumber(plan.sourceState);

      const nextWorkspace=copy(workspace),np=nextWorkspace.projects.find(x=>x.id===projectId);
      if(!np)throw Error('案件情報が更新されています。');
      const now=Date.now(),sourceMeta=np.drawings.find(d=>d.id===sourceDrawingId),destMeta=np.drawings.find(d=>d.id===targetDrawingId);
      if(!sourceMeta||!destMeta)throw Error('図面情報が更新されています。');
      const sc=counts(plan.sourceState),tc=counts(plan.targetState);
      Object.assign(sourceMeta,sc,{updatedAt:now});
      Object.assign(destMeta,tc,{updatedAt:now});
      np.updatedAt=now;

      const writes=new Map();
      writes.set(DRAW_KEY(targetDrawingId),JSON.stringify(plan.targetState));
      if(!plan.sameDrawing)writes.set(DRAW_KEY(sourceDrawingId),JSON.stringify(plan.sourceState));
      writes.set(WS_KEY,JSON.stringify(nextWorkspace));
      root.SentlogRecords.batch(writes);await root.SentlogRecords.flush();committed=true;
      workspace=nextWorkspace;

      const savedTarget=loadState(targetDrawingId).state;
      if(!plan.newIds.every(id=>savedTarget.shapes.some(s=>s.id===id)))throw Error('移動先の記録保存を確認できません。');
      if(operation==='move'){
        const savedSource=loadState(sourceDrawingId).state;
        if(ids.some(id=>savedSource.shapes.some(s=>s.id===id)))throw Error('移動元の記録削除を確認できません。');
      }

      close();
      root.sentlogImporting=false;
      await openDrawing(projectId,targetDrawingId);
      if(state.sourceType==='pdf'&&Number(state.currentPage)!==Number(targetPage))await renderPdfPage(Number(targetPage));
      alert(verb+'しました。\n移動先を開いています。位置を確認し、必要に応じて通常の移動操作で調整してください。');
      return true;
    }catch(e){
      console.error('record transfer',e);
      if(committed){
        try{
          const restore=new Map([[WS_KEY,beforeWorkspaceRaw],[DRAW_KEY(sourceDrawingId),beforeSourceRaw]]);
          if(sourceDrawingId!==targetDrawingId)restore.set(DRAW_KEY(targetDrawingId),beforeTargetRaw);
          root.SentlogRecords.batch(restore);await root.SentlogRecords.flush();
          workspace=parse(beforeWorkspaceRaw,{projects:[]});
        }catch(re){console.error('record transfer rollback',re);}
      }
      throw e;
    }finally{
      root.sentlogImporting=false;busy=false;
    }
  }

  function open(){
    if(busy||currentView!=='editor'||!activeDrawingId)return;
    const sourcePage=Number(state.currentPage)||1,records=(state.shapes||[]).filter(s=>(Number(s.page)||1)===sourcePage);
    if(!records.length){alert('このページには移動・コピーできる記録がありません。');return;}
    close();
    dialog=document.createElement('dialog');dialog.className='sentlog-record-transfer';
    const title=document.createElement('h2');title.textContent='記録をコピー／移動';
    const note=document.createElement('p');note.textContent='変状・寸法・メモ・写真リンク・コメントなど、選んだ記録一式を同じ案件内の別図面／別ページへ移します。写真データも移動先へ複製して照合します。';

    const selectTools=document.createElement('div');selectTools.className='sentlog-transfer-tools';
    const all=button('このページを全部選択',()=>boxes.forEach(x=>x.checked=true));
    const none=button('選択解除',()=>boxes.forEach(x=>x.checked=false));selectTools.append(all,none);
    const list=document.createElement('div');list.className='sentlog-transfer-list';const boxes=[];
    for(const rec of records){
      const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=rec.id;box.checked=rec.id===selected;
      const photos=(rec.photos||[]).length,txt=document.createElement('span');txt.textContent=recordLabel(rec)+(photos?'　写真'+photos+'枚':'');
      label.append(box,txt);list.append(label);boxes.push(box);
    }
    if(!boxes.some(x=>x.checked)&&boxes.length===1)boxes[0].checked=true;

    const opLabel=document.createElement('label');opLabel.textContent='操作';
    const op=document.createElement('select');op.innerHTML='<option value="copy">コピー（元にも残す）</option><option value="move">移動（保存確認後に元から削除）</option>';opLabel.append(op);

    const drawingLabel=document.createElement('label');drawingLabel.textContent='移動先の図面';
    const drawing=document.createElement('select');
    const project=getProject();
    for(const d of project.drawings||[]){const o=document.createElement('option');o.value=d.id;o.textContent=d.name+(d.id===activeDrawingId?'（現在の図面）':'');drawing.append(o);}
    drawing.value=(project.drawings||[]).find(d=>d.id!==activeDrawingId)?.id||activeDrawingId;drawingLabel.append(drawing);

    const pageLabel=document.createElement('label');pageLabel.textContent='移動先ページ';
    const page=document.createElement('select');pageLabel.append(page);
    const fillPages=()=>{
      page.replaceChildren();
      try{
        const target=loadState(drawing.value).state;
        for(const n of visiblePages(target)){
          if(drawing.value===activeDrawingId&&n===sourcePage)continue;
          const o=document.createElement('option');o.value=String(n);o.textContent=n+'ページ目';page.append(o);
        }
      }catch{}
    };
    drawing.onchange=fillPages;fillPages();

    const status=document.createElement('p');status.className='sentlog-transfer-status';status.setAttribute('role','status');
    const actions=document.createElement('div');actions.className='sentlog-transfer-actions';
    const cancel=button('閉じる',close);
    const run=button('実行',async()=>{
      const ids=boxes.filter(x=>x.checked).map(x=>x.value);
      if(!ids.length){status.textContent='記録を1件以上選んでください。';return;}
      if(!page.value){status.textContent='移動先ページを選べません。別の図面または別ページを選んでください。';return;}
      for(const el of [run,cancel,all,none,op,drawing,page,...boxes])el.disabled=true;
      status.textContent='保存・照合しています…';
      try{await execute({ids,operation:op.value,targetDrawingId:drawing.value,targetPage:Number(page.value)});}
      catch(e){status.textContent=e?.message||String(e);for(const el of [run,cancel,all,none,op,drawing,page,...boxes])el.disabled=false;}
    });
    actions.append(run,cancel);
    dialog.append(title,note,selectTools,list,opLabel,drawingLabel,pageLabel,status,actions);
    dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    document.body.append(dialog);dialog.showModal();
  }

  function install(){
    if(byId('sentlogRecordTransferBtn'))return;
    const del=byId('deleteBtn');if(!del)return;
    const btn=button('記録をコピー／移動',open);btn.id='sentlogRecordTransferBtn';del.insertAdjacentElement('afterend',btn);
    const style=document.createElement('style');style.id='sentlogRecordTransferStyle';style.textContent=
      '.sentlog-record-transfer{box-sizing:border-box;width:min(560px,calc(100vw - 24px));max-height:90vh;overflow:auto;border:1px solid #cbd5e1;border-radius:14px;padding:18px;background:#fff;color:#111827;font:14px/1.55 system-ui}.sentlog-record-transfer::backdrop{background:#0008}.sentlog-record-transfer h2{margin:0 0 8px;font-size:18px}.sentlog-record-transfer p{font-size:12px;color:#475569}.sentlog-transfer-tools,.sentlog-transfer-actions{display:flex;gap:8px;margin:10px 0}.sentlog-transfer-tools button,.sentlog-transfer-actions button{min-height:42px}.sentlog-transfer-list{display:grid;gap:5px;max-height:230px;overflow:auto;border:1px solid #e2e8f0;border-radius:9px;padding:8px}.sentlog-transfer-list label{display:flex;align-items:center;gap:8px;min-height:38px;padding:4px 6px;border-radius:6px;background:#f8fafc}.sentlog-transfer-list input{width:19px;height:19px;flex:0 0 19px}.sentlog-record-transfer>label{display:grid;gap:5px;margin-top:10px;font-size:12px;font-weight:700}.sentlog-record-transfer select{width:100%;min-height:42px;font-size:14px}.sentlog-transfer-status{min-height:20px;color:#b91c1c!important}.sentlog-transfer-actions button:first-child{background:#1d4ed8;color:#fff;border-color:#1d4ed8;flex:1}#sentlogRecordTransferBtn{margin-top:8px;border-color:#93c5fd;background:#eff6ff;color:#1d4ed8}';
    document.head.append(style);
  }

  root.SentlogRecordTransfer={...pure,open};
  Promise.resolve(root.sentlogAppReady).then(install).catch(e=>console.error('record transfer install',e));
})(typeof globalThis!=='undefined'?globalThis:this);

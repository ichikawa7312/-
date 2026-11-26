/* SentlogDelta: explicit review of an unversioned shared PDF. Merely opening,
 * previewing, dismissing or refreshing this UI never writes application data. */
(function(root){
  'use strict';
  function create({document:doc=root.document,prepare,confirm,cancel,onResumed=()=>{},pdf=()=>root.pdfjsLib}={}){
    if(!doc||[prepare,confirm,cancel].some(fn=>typeof fn!=='function'))throw Error('図面の確認方法を読み込めません');
    const entries=new Map();let host,dialog,heading,body,message,accept,checked,back,active=null,serial=0;
    let loadingTask=null,pdfDocument=null,renderTask=null,url=null,notice='',noticeProject=null;
    const el=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    const button=(text,fn)=>{const node=el('button',text);node.type='button';node.onclick=fn;return node;};
    const keyOf=(id,key)=>JSON.stringify([id,key]);
    function setup(){
      if(!host){
        const details=doc.getElementById('sentlogCloudDetails');if(!details?.parentNode)return false;
        host=el('section');host.id='sentlogDrawingRecoveryNotice';host.hidden=true;
        host.style.cssText='margin-top:12px;padding:12px;border:1px solid #b7791f;border-radius:8px;background:#fffbeb;overflow-wrap:anywhere';
        host.setAttribute('aria-label','同期が止まっている図面');details.after(host);
      }
      if(!dialog){
        const style=el('style');style.textContent='#sentlogDrawingRecoveryDialog{width:min(760px,calc(100vw - 24px));max-height:90vh;box-sizing:border-box;border:1px solid #777;border-radius:12px;padding:18px;overflow:auto;color:#111827;background:#fff}#sentlogDrawingRecoveryDialog::backdrop{background:#0009}#sentlogDrawingRecoveryDialog button,#sentlogDrawingRecoveryNotice button{min-height:44px;padding:8px 12px;white-space:normal}#sentlogDrawingRecoveryDialog canvas{max-width:100%;height:auto;border:1px solid #ccc;background:white}#sentlogDrawingRecoveryDialog p{overflow-wrap:anywhere;line-height:1.6}';doc.head.append(style);
        dialog=el('dialog');dialog.id='sentlogDrawingRecoveryDialog';heading=el('h2','同期が止まっている図面を確認');heading.id='sentlogDrawingRecoveryTitle';
        dialog.setAttribute('aria-labelledby',heading.id);message=el('p');message.setAttribute('role','status');body=el('div');
        const actions=el('div');actions.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;justify-content:flex-end';
        back=button('今回は戻る',dismiss);back.id='sentlogDrawingRecoveryCancel';
        accept=button('この図面で同期を再開',commit);accept.id='sentlogDrawingRecoveryConfirm';accept.disabled=true;
        actions.append(back,accept);dialog.append(heading,message,body,actions);doc.body.append(dialog);
        dialog.addEventListener('cancel',event=>{event.preventDefault();if(active?.phase!=='committing')dismiss();});
        dialog.addEventListener('close',()=>{if(active&&active.phase!=='committing')dismiss();});
      }
      return true;
    }
    function freePreview(){
      try{renderTask?.cancel?.();}catch{}renderTask=null;
      try{const result=(pdfDocument||loadingTask)?.destroy?.();result?.catch?.(()=>{});}catch{}
      pdfDocument=loadingTask=null;
      if(url){root.URL.revokeObjectURL(url);url=null;}
    }
    function release(candidate){if(candidate)try{cancel(candidate);}catch{}}
    function dismiss(){
      if(active?.phase==='committing')return;
      const previous=active;active=null;serial++;freePreview();release(previous?.candidate);
      if(dialog?.open)dialog.close();refresh();
    }
    function refresh(){
      if(!setup())return;host.replaceChildren();host.hidden=!entries.size&&!notice;
      if(notice)host.append(el('p',notice));
      for(const entry of entries.values()){
        const box=el('div');box.style.cssText='margin:8px 0';
        box.append(el('strong',entry.projectName||'案件'),el('p',entry.issue.message));
        const open=button('図面を確認して復旧',()=>show(entry));open.disabled=!!active;box.append(open);host.append(box);
      }
    }
    async function preview(candidate,token){
      const link=el('a','PDFを別画面で開く');url=root.URL.createObjectURL(candidate.blob);
      link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.style.cssText='display:inline-block;padding:10px 0';body.append(link);
      const api=pdf();
      if(!api?.getDocument||candidate.blob.size>32*1024*1024){body.append(el('p','上のリンクからPDFの内容を確認できます。'));return;}
      const panel=el('div'),canvas=el('canvas'),navigation=el('div'),pageLabel=el('span');panel.append(canvas,navigation);body.append(panel);
      const showPreviewError=()=>{if(active?.token===token)panel.replaceChildren(el('p','この画面でプレビューを表示できませんでした。上のリンクからPDFを開いて確認してください。'));};
      try{
        const bytes=await candidate.blob.arrayBuffer();if(!active||active.token!==token)return;
        loadingTask=api.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,enableXfa:false});
        const document=await loadingTask.promise;
        if(!active||active.token!==token){await document.destroy();return;}
        pdfDocument=document;let pageNumber=1,pageSerial=0;
        const previous=button('前のページ',()=>{draw(pageNumber-1).catch(showPreviewError);}),next=button('次のページ',()=>{draw(pageNumber+1).catch(showPreviewError);});
        navigation.style.cssText='display:flex;align-items:center;justify-content:center;gap:12px;margin:8px 0';navigation.append(previous,pageLabel,next);
        async function draw(number){
          if(!active||active.token!==token||number<1||number>document.numPages)return;
          const own=++pageSerial;pageNumber=number;previous.disabled=next.disabled=true;
          try{renderTask?.cancel?.();}catch{}
          const page=await document.getPage(number);if(!active||active.token!==token||own!==pageSerial)return;
          const original=page.getViewport({scale:1});const scale=Math.min(1.5,1000/original.width,Math.sqrt(3000000/(original.width*original.height)));
          const viewport=page.getViewport({scale});canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
          canvas.setAttribute('aria-label','図面のプレビュー '+number+'ページ');pageLabel.textContent=number+' / '+document.numPages+' ページ';
          renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport});
          try{await renderTask.promise;}catch(error){if(error.name!=='RenderingCancelledException')throw error;}
          if(active?.token===token&&own===pageSerial){previous.disabled=number<=1;next.disabled=number>=document.numPages;}
        }
        await draw(1);
      }catch(error){showPreviewError();}
    }
    async function show(entry){
      if(active||!setup())return;notice='';noticeProject=null;const token=++serial;active={entry,token,phase:'loading',candidate:null};
      body.replaceChildren();checked=null;accept.disabled=true;back.disabled=false;message.textContent='クラウドの図面を取得し、内容を照合しています…';
      heading.textContent=(entry.projectName||'案件')+'の図面を確認';dialog.showModal();refresh();
      try{
        const candidate=await prepare(entry);
        if(!active||active.token!==token){release(candidate);return;}
        active.candidate=candidate;active.phase='review';
        body.append(el('p',candidate.fileName||candidate.drawingName||'図面PDF'));
        body.append(el('p','以前の図面と同じ内容か、自動では確認できません。下のPDFを使ってよいか確認してください。図面上の記録と写真の参照は保持します。'));
        body.append(el('p','ファイル容量：'+(candidate.blob.size/1024/1024).toFixed(2)+' MB'));
        const label=el('label');label.style.cssText='display:block;padding:12px 0;font-size:16px;line-height:1.6;font-weight:600;color:#111827';checked=el('input');checked.type='checkbox';checked.id='sentlogDrawingRecoveryChecked';
        checked.style.cssText='width:20px;height:20px;margin-right:8px;vertical-align:middle';checked.onchange=()=>{accept.disabled=active?.phase!=='review'||!checked.checked;};
        label.append(checked,doc.createTextNode('PDFの内容を確認し、この図面を使用します'));body.append(label);
        message.textContent='確認するだけでは、保存内容は変わりません。';await preview(candidate,token);
      }catch(error){if(active?.token===token){active.phase='error';message.textContent=error?.message||'図面を取得できませんでした。通信を確認して、もう一度お試しください。';accept.disabled=true;}}
    }
    async function commit(){
      if(active?.phase!=='review'||!checked?.checked)return;const selected=active;selected.phase='committing';accept.disabled=true;back.disabled=true;checked.disabled=true;
      message.textContent='図面が変更されていないことを再確認し、端末に保存しています…';
      try{
        await confirm(selected.candidate);
        if(active!==selected)return;
        entries.delete(keyOf(selected.entry.localProjectId,selected.entry.issue.key));active=null;serial++;freePreview();release(selected.candidate);
        noticeProject=selected.entry.localProjectId;
        notice='「'+(selected.entry.projectName||'案件')+'」の図面を保存しました。同期結果を確認しています。';dialog.close();refresh();
        try{await onResumed(selected.entry);}catch(error){noticeProject=selected.entry.localProjectId;notice='図面は保存済みです。同期の再開を確認できませんでした：'+(error?.message||error);refresh();}
      }catch(error){if(active===selected){selected.phase='error';back.disabled=false;message.textContent=error?.message||'復旧を完了できませんでした。元の記録を保持しています。';release(selected.candidate);selected.candidate=null;}}
    }
    return {refresh,
      update(detail){
        const current=new Map((detail.issues||[]).map(issue=>[issue.key,issue]));
        for(const [key,entry]of entries){
          if(entry.localProjectId!==detail.localProjectId)continue;
          const issue=current.get(entry.issue.key);
          // A bounded batch may not examine every remaining drawing. Keep an
          // existing review entry until that key clears or is examined again.
          if(entry.bindingId!==detail.bindingId||!issue||
            (issue.recovery&&issue.recovery.reason!=='RECOVERY_BATCH_LIMIT'))entries.delete(key);
        }
        for(const issue of detail.issues||[])if(issue.recovery?.reviewable===true)entries.set(keyOf(detail.localProjectId,issue.key),
          {...detail,issue:{...issue.recovery,key:issue.key}});
        refresh();
      },
      clear(localProjectId){
        for(const [key,entry]of entries)if(!localProjectId||entry.localProjectId===localProjectId)entries.delete(key);
        if(!localProjectId||noticeProject===localProjectId){notice='';noticeProject=null;}
        if(!localProjectId||(active?.entry.localProjectId===localProjectId&&active.phase!=='committing')){
          const previous=active;active=null;serial++;freePreview();release(previous?.candidate);if(dialog?.open)dialog.close();
        }
        refresh();
      }
    };
  }
  const api={version:1,create};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaDrawingReview=api;
})(typeof window!=='undefined'?window:globalThis);

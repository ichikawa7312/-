/* Shared record editor: independent durable drafts and revision-bound decisions. */
(function(root){
  'use strict';
  const M=root.SentlogRecordCollaboration;if(!M||!root.document)return;
  const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const same=(a,b)=>M.equal(a,b),id=()=>crypto.randomUUID(),now=()=>Date.now();
  const DRAFT='sentlogCollaborativeDraftV1:',DECISIONS='sentlogCollaborativeDecisionsV1';
  const histories=new Map();let managed=0,renderDepth=0,historyPlayback=false;
  let binding=null,draft=null,composing=false,finishingComposition=false,saveTimer=null,panel=null,list=null,input=null,note=null,conflicts=null;
  let dialog=null,decision=null,editingComment=null,decisionQueue=[],confirmation=null;
  let reviewButton=null,reviewDialog=null;const viewCache=new WeakMap(),decisionsMemory=new Map(),undurableDecisions=new Set();
  const scalarLabels={crackWidthMm:'ひび割れ幅',type:'変状名',member:'部材',lineLengthM:'長さ',manualText:'寸法の表示'};
  const guarded=new Set(['crackWidthMm','type','member','lineLengthM','manualText']);
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const selectedRecord=()=>typeof state!=='undefined'?state.shapes?.find(s=>s.id===selected):null;
  function accountId(){
    const shared=root.sentlogCollaborationAccountId;if(typeof shared==='function')return String(shared()||'');
    if(typeof shared==='string')return shared;
    try{return String(JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null')?.user?.id||'');}catch(_){return '';}
  }
  function draftDevice(){let value=localStorage.getItem('sentlogCollaborativeDraftDeviceV1');if(!value){value=id();localStorage.setItem('sentlogCollaborativeDraftDeviceV1',value);}return value;}
  function actor(){
    const registered=root.SentlogCollaborationDevice;
    let deviceId=registered?.id||localStorage.getItem('sentlogCloudDeviceV1');
    if(!deviceId)deviceId=draftDevice();
    const ua=navigator.userAgent||'',fallback=/iPhone/.test(ua)?'iPhone':(/iPad/.test(ua)||navigator.maxTouchPoints>1&&/Macintosh/.test(ua))?'iPad':'PC・ブラウザ';
    return {deviceId,deviceName:registered?.name||fallback};
  }
  const opts=extra=>({actor:actor(),at:now(),...extra});
  function readDrawing(drawingId){try{return JSON.parse(root.SentlogRecords.getItem(drawingStorageKey(drawingId))||'null');}catch(_){return null;}}
  function recordContext(recordId){return typeof activeDrawingId!=='undefined'&&activeDrawingId?{accountId:accountId(),projectId:activeProjectId,drawingId:activeDrawingId,recordId}:null;}
  function context(){return selected?recordContext(selected):null;}
  const key=c=>c?JSON.stringify([c.accountId||'',c.projectId,c.drawingId,c.recordId]):'';
  const historyKey=()=>JSON.stringify([accountId(),activeProjectId,activeDrawingId,state.currentPage]);
  const sameDrawing=c=>!!c&&(typeof currentView==='undefined'||currentView==='editor')&&accountId()===(c.accountId||'')&&activeProjectId===c.projectId&&activeDrawingId===c.drawingId;
  function presentation(record){
    if(record.collab&&String(record.memo??'')!==String(record.collab.projection?.memo??'')){
      const upgraded=M.upgrade(record);if(!M.isDeleted(upgraded))return M.applyLocalEdit(upgraded,record,{deterministic:true,recordId:record.id,actor:{deviceId:null,deviceName:'不明'},at:0});
    }
    return record;
  }
  function displayView(record){
    const shown=presentation(record);if(shown!==record||!record.collab)return M.view(shown);
    if(!viewCache.has(record.collab))viewCache.set(record.collab,M.view(record));return viewCache.get(record.collab);
  }
  function message(text,error=false){for(const target of [note,reviewDialog&&!reviewDialog.hidden?reviewDialog.querySelector('[data-review-status]'):null])if(target){target.textContent=text;target.style.color=error?'#b91c1c':'#475569';}}
  function writeDraft(){
    if(!binding||!draft)return;
    try{localStorage.setItem(DRAFT+draftDevice()+':'+key(binding),JSON.stringify(draft));}
    catch(e){message('入力途中の保存ができません。文章をコピーしてから空き容量を確認してください。',true);throw e;}
  }
  const blankDraft=()=>({text:'',commentId:id(),headIds:[],savedText:'',revisionId:null,editingComment:false,compositionPending:false});
  function readDraft(c){
    try{
      const d=JSON.parse(localStorage.getItem(DRAFT+draftDevice()+':'+key(c))||'null');
      if(d&&typeof d.text==='string'){
        const record=currentBound(),entry=record?.collab?.comments?.[d.commentId];
        const saved=Array.isArray(d.headIds)&&d.headIds.length>0&&d.headIds.every(head=>entry?.revisions?.some(r=>r.id===head&&r.text===d.savedText&&!r.deleted));
        // A completed composer belongs to its original editing session. Starting
        // another visit must append a new entry rather than silently edit it.
        // Keep an unconfirmed/failed draft if the saved record cannot prove that
        // its text reached immutable history, even when savedText was written.
        if(d.text===d.savedText&&!d.revisionId&&!d.compositionPending&&(!d.text||saved))return blankDraft();
        return d;
      }
    }catch(_){}
    return blankDraft();
  }
  function stopTimer(){if(saveTimer!==null)clearTimeout(saveTimer);saveTimer=null;}
  function bind(){
    const next=context();if(key(next)===key(binding))return;
    if(composing||finishingComposition){writeDraft();message('変換中の文章は元の記録の下書きに残しています。確定後に切り替わります。');return;}
    flushDraft();stopTimer();binding=next;draft=next?readDraft(next):null;editingComment=draft?.editingComment?draft.commentId:null;
    cancelConfirmation();if(dialog)dialog.hidden=true;decision=null;decisionQueue=[];
    if(input)input.value=draft?.text||'';
    if(draft?.text){
      const actual=currentBound(),entry=actual?M.view(actual).comments.find(x=>x.id===draft.commentId):null;
      if(!entry){draft.savedText='';draft.headIds=[];}
      if(draft.compositionPending)message('変換途中の下書きを復元しました。入力を続けるか「保存」で確定してください。');
      else if(draft.text!==draft.savedText)saveTimer=setTimeout(flushDraft,250);
    }
  }
  function currentBound(){
    if(!binding||accountId()!==(binding.accountId||'')||activeProjectId!==binding.projectId||activeDrawingId!==binding.drawingId)return null;
    return state.shapes.find(s=>s.id===binding.recordId)||null;
  }
  function replaceRecord(record){
    const index=state.shapes.findIndex(s=>s.id===record.id);if(index<0)throw Error('記録が削除または移動されています。入力は下書きに残しています。');
    state.shapes[index]=record;
  }
  function recordHistory(before,after){
    if(historyPlayback||same(before,after))return;
    const k=historyKey();
    if(!histories.has(k))histories.set(k,{undo:[],redo:[]});
    const h=histories.get(k);h.undo.push({before:copy(before),after:copy(after)});if(h.undo.length>80)h.undo.shift();h.redo=[];updateButtons();
  }
  function mutate(fn,afterPersist,{deferRender=false}={}){
    const before=copy(state),selection=selected;managed++;
    try{fn();rebuildNumberingState();persist();recordHistory(before,state);}
    catch(e){state=before;selected=selection;throw e;}
    finally{managed--;}
    if(afterPersist)afterPersist();
    if(!deferRender){render();renderSelectedPhotos();refresh();}
  }
  function flushDraft(){
    stopTimer();if(!draft||composing||finishingComposition||draft.compositionPending||draft.text===draft.savedText||(!draft.text.trim()&&!draft.headIds?.length))return false;
    const target=currentBound();if(!target){writeDraft();message('入力を下書きに残しました。記録の移動・削除を確認してください。',true);return false;}
    try{
      if(!draft.revisionId){draft.revisionId=id();draft.revisionAt=now();draft.revisionActor=actor();}writeDraft();
      const view=M.view(target),entry=view.comments.find(c=>c.id===draft.commentId);
      const operation={actor:draft.revisionActor,at:draft.revisionAt,revisionId:draft.revisionId};
      const next=entry?M.editComment(target,draft.commentId,draft.text,{...operation,expectedHeads:draft.headIds}):
        M.appendComment(target,draft.text,{...operation,commentId:draft.commentId});
      // A failed record write leaves the durable draft pending with the same
      // operation identity. A retry cannot create a second comment or revision.
      mutate(()=>replaceRecord(next),()=>{
        draft.headIds=M.view(next).comments.find(c=>c.id===draft.commentId).headIds;
        draft.savedText=draft.text;draft.revisionId=null;writeDraft();
      });message(navigator.onLine?'保存しました。共有を待っています。':'この端末に保存しました。接続後に共有します。');return true;
    }catch(e){
      message(e.code==='COLLAB_STALE'?'このコメントは別の端末でも変更されています。入力を残しています。「別のコメントとして追記」で保存できます。':e.message,true);
      refreshDraftActions();return false;
    }
  }
  function saveCurrentDraft(){
    if(composing||finishingComposition)return false;
    if(draft?.compositionPending){draft.compositionPending=false;writeDraft();}
    return flushDraft();
  }
  function startNext(){
    if(composing||finishingComposition)return;
    if(draft?.compositionPending){message('変換途中の下書きは、入力を続けるか「保存」で確定してください。');return;}
    if(draft?.text!==draft?.savedText&&(draft?.text.trim()||draft?.headIds?.length)&&!flushDraft())return;
    draft=blankDraft();editingComment=null;writeDraft();input.value='';refresh();input.focus();
  }
  function saveAsAppend(){
    if(!draft?.text.trim())return;
    draft={...draft,commentId:id(),headIds:[],savedText:'',revisionId:null,editingComment:false};editingComment=null;writeDraft();flushDraft();
  }
  function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;return b;}
  const who=r=>r?.actor?.deviceId?(r.actor.deviceName||'登録端末'):'既存の記録';
  const time=r=>r?.at?new Date(r.at).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
  const valueText=(key,value)=>value===undefined?'未設定':key==='crackWidthMm'?(value==null?'未測定':value+' mm'):typeof value==='string'?value:JSON.stringify(value);
  function currentTarget(d){
    if(accountId()!==(d.accountId||'')||activeProjectId!==d.projectId||activeDrawingId!==d.drawingId)return null;
    return state.shapes.find(s=>s.id===d.recordId)||(state.collabDeletedRecords||[]).find(s=>s.id===d.recordId)||null;
  }
  const decisionsKey=c=>DECISIONS+':'+draftDevice()+':'+key(c);
  const sameDecision=(a,b)=>a.kind===b.kind&&a.key===b.key&&a.commentId===b.commentId&&a.photoId===b.photoId;
  function savedDecisions(c){const k=decisionsKey(c);if(decisionsMemory.has(k))return copy(decisionsMemory.get(k));try{const values=JSON.parse(localStorage.getItem(k)||'[]');return Array.isArray(values)?values.filter(d=>key(d)===key(c)):[];}catch(_){return [];}}
  function saveDecisions(c,values){const k=decisionsKey(c);decisionsMemory.set(k,copy(values));try{if(values.length)localStorage.setItem(k,JSON.stringify(values));else localStorage.removeItem(k);undurableDecisions.delete(k);}catch(e){undurableDecisions.add(k);message('確認待ちの変更はこの画面に残しています。端末への保存ができないため、画面を閉じる前に内容を控えてください。',true);}}
  function enqueueDecisions(values){
    const groups=new Map();for(const d of values){const k=key(d);if(!groups.has(k))groups.set(k,{context:d,values:savedDecisions(d)});const group=groups.get(k).values,index=group.findIndex(x=>sameDecision(x,d));if(index<0)group.push(d);else group[index]=d;}
    for(const g of groups.values()){saveDecisions(g.context,g.values);if(decision&&key(decision)===key(g.context))decisionQueue=g.values.filter(d=>!sameDecision(d,decision));}
    queueMicrotask(()=>refresh());
  }
  function showDecision(d){
    if(!sameDrawing(d)){enqueueDecisions([d]);return;}
    if(!decision){const pending=savedDecisions(d);decisionQueue=pending.filter(x=>!sameDecision(x,d));}
    d.selectionAtOpen=selected;
    decision=d;
    saveDecisions(d,[d,...decisionQueue]);
    if(!dialog){
      dialog=document.createElement('div');dialog.className='sl-collab-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
      dialog.setAttribute('aria-labelledby','slCollabDecisionTitle');dialog.innerHTML='<section><h2 id="slCollabDecisionTitle">登録済みの内容を確認</h2><p data-summary></p><p data-status role="status"></p><div data-buttons></div></section>';
      document.body.append(dialog);
    }
    const t=currentTarget(d),v=t?M.view(t):null,field=v?.fields[d.key],photo=v?.photos.find(p=>p.id===d.photoId);
    dialog.querySelector('[data-status]').textContent='';
    dialog.querySelector('[data-summary]').textContent=d.kind==='delete'?'この記録を削除します。ほかの端末から新しいコメントや写真が届いている場合は、内容をもう一度確認します。':
      d.kind==='comment-edit'?'このコメントを修正します。修正前の文章も履歴に残ります。':
      d.kind==='photo-remove'?'写真「'+(photo?.metadata?.name||d.photoName||'選択した写真')+'」をこの記録から外します。写真の原本と変更履歴は残ります。':
      (scalarLabels[d.key]||d.key)+'\n登録：'+valueText(d.key,field?.value)+'（'+who(field?.heads[0])+'）\n変更：'+valueText(d.key,d.value);
    const actions=dialog.querySelector('[data-buttons]');actions.replaceChildren();
    actions.append(button('キャンセル',closeDecision),button(d.kind==='delete'?'削除する':d.kind==='comment-edit'?'修正する':d.kind==='photo-remove'?'写真を外す':'変更する',()=>confirmDecision()));
    // Explicit local intent: do not pretend to have verified the remote head.
    // Immutable field/delete revisions retain concurrent peer edits as conflicts
    // when the shared record is eventually reconciled.
    if(navigator.onLine&&(d.kind==='delete'||d.kind==='field'||d.kind==='photo-remove'))
      actions.append(button('通信せず端末に保存',()=>confirmDecision({localOnly:true})));
    dialog.hidden=false;
  }
  function cancelConfirmation(){const old=confirmation;confirmation=null;old?.controller.abort();}
  function closeDecision(){
    const old=decision;cancelConfirmation();if(dialog)dialog.hidden=true;decision=null;
    if(old)saveDecisions(old,decisionQueue);
    const next=decisionQueue.shift();if(next){showDecision(next);return;}
  }
  function localDecisionApplied(d,target){
    if(!d?.localRevisionId||!target?.collab)return false;
    const revisions=d.kind==='delete'?target.collab.deletion?.revisions:
      d.kind==='field'?target.collab.fields?.[d.key]?.revisions:
      d.kind==='photo-remove'?target.collab.photos?.[d.photoId]?.revisions:null;
    return Array.isArray(revisions)&&revisions.some(row=>row.id===d.localRevisionId);
  }
  async function confirmDecision({localOnly=!navigator.onLine}={}){
    const d=decision;if(!d||confirmation)return;
    const attempt={decision:d,controller:new AbortController()};confirmation=attempt;
    const status=dialog.querySelector('[data-status]'),buttons=dialog.querySelectorAll('button');buttons.forEach((b,index)=>b.disabled=index!==0);
    try{
      if(localOnly){
        if(d.kind!=='delete'&&d.kind!=='field'&&d.kind!=='photo-remove')throw Error('この操作の端末内保存には対応していません。');
        if(root.SentlogRecords?.ready===false)throw Error('端末内の保存先を確認できません。変更せず停止しました。');
        // Fail before touching a record if older uncommitted edits cannot
        // reach the native IndexedDB writer.
        if(typeof root.SentlogRecords?.flush==='function')await root.SentlogRecords.flush();
        else if(typeof root.SentlogRecords?.settled==='function')await root.SentlogRecords.settled();
        root.SentlogRecords?.assertSafe?.();
      }else{
        if(!navigator.onLine&&d.kind!=='comment-edit')throw Error('最新の共有記録を確認できません。端末内に変更を記録する場合は、下の「この端末に変更を保存」を選んでください。');
      }
      if(!localOnly&&navigator.onLine){
        if(typeof root.sentlogCollabRefresh!=='function')throw Error('最新の記録を確認する準備ができていません。少し待ってからお試しください。');
        status.textContent='最新の記録を確認しています…';const checked=await root.sentlogCollabRefresh(d.projectId,{signal:attempt.controller.signal});
        if(checked?.fresh!==true)throw Error('最新の記録をまだ確認できていません。変更内容を保持しています。');
      }
      if(decision!==d||confirmation!==attempt||attempt.controller.signal.aborted)return;
      // A rejected disk flush may leave a local mutation in memory. Retry
      // only the same exact recorded revision, never append another deletion.
      const alreadyApplied=localOnly&&localDecisionApplied(d,currentTarget(d));
      if(!sameDrawing(d)||(!alreadyApplied&&selected!==d.selectionAtOpen))
        throw Error('アカウントまたは選択中の記録が変わりました。変更内容を元の記録に残しています。');
      const target=currentTarget(d);if(!target)throw Error('記録が移動または削除されました。');
      if(alreadyApplied){
        if(typeof root.SentlogRecords?.flush==='function')await root.SentlogRecords.flush();
        else if(typeof root.SentlogRecords?.settled==='function')await root.SentlogRecords.settled();
        root.SentlogRecords?.assertSafe?.();
        saveDecisions(d,savedDecisions(d).filter(item=>!sameDecision(item,d)));
        closeDecision();render();renderSelectedPhotos();refresh();return;
      }
      const view=M.view(target);
      const photo=d.kind==='photo-remove'?view.photos.find(p=>p.id===d.photoId):null;
      if(d.kind==='photo-remove'&&(!photo||photo.deleted)){closeDecision();message('この写真は既に外されています。原本と変更履歴は残しています。');refresh();return;}
      const current=d.kind==='delete'?view.token:d.kind==='comment-edit'?view.comments.find(c=>c.id===d.commentId)?.headIds:d.kind==='photo-remove'?photo.headIds:view.fields[d.key]?.headIds||[];
      const expected=d.kind==='delete'?d.token:d.headIds;
      if(!same(current,expected)){
        if(d.kind==='delete')d.token=current;else d.headIds=current;
        showDecision(d);status.textContent='確認中に更新が届きました。最新の内容を見て、もう一度選んでください。';return;
      }
      if(d.kind==='comment-edit'){
        const entry=view.comments.find(c=>c.id===d.commentId);if(!entry||entry.conflict)throw Error('複数の修正があります。下の候補から確認してください。');
        if(composing||finishingComposition||draft?.compositionPending||draft?.text!==draft?.savedText&&!flushDraft())throw Error('入力中の文章を先に保存してください。下書きは残しています。');
        draft={text:entry.text,commentId:entry.id,headIds:entry.headIds,savedText:entry.text,revisionId:null,editingComment:true,compositionPending:false};editingComment=entry.id;writeDraft();input.value=draft.text;closeDecision();refresh();input.focus();return;
      }
      if(localOnly){
        d.localRevisionId=d.localRevisionId||id();
        saveDecisions(d,[d,...decisionQueue]);
      }
      mutate(()=>{
        if(d.kind==='delete'){
          const removed=M.markDeleted(target,opts({expectedToken:d.token,...(localOnly?{revisionId:d.localRevisionId}:{})}));
          state.shapes=state.shapes.filter(s=>s.id!==target.id);state.collabDeletedRecords=[...(state.collabDeletedRecords||[]).filter(s=>s.id!==target.id),removed];selected=null;
        }else if(d.kind==='photo-remove')replaceRecord(M.removePhoto(target,d.photoId,opts({expectedHeads:d.headIds,
          ...(localOnly?{revisionId:d.localRevisionId}:{})})));
        else replaceRecord(M.setField(target,d.key,d.value,opts({expectedHeads:d.headIds,unset:d.unset===true,
          ...(localOnly?{revisionId:d.localRevisionId}:{})})));
      },()=>{
        // A local-only intent is not confirmed until the native record writer
        // has flushed. Retain the decision if a storage failure is reported.
        if(!localOnly)saveDecisions(d,savedDecisions(d).filter(item=>!sameDecision(item,d)));
      },{deferRender:localOnly});
      if(localOnly){
        const store=root.SentlogRecords;
        if(typeof store?.flush==='function')await store.flush();
        else if(typeof store?.settled==='function')await store.settled();
        store?.assertSafe?.();
        if(!sameDrawing(d)||decision!==d)throw Error('保存中にアカウント・図面が変わりました。記録の控えを保持してください。');
        saveDecisions(d,savedDecisions(d).filter(item=>!sameDecision(item,d)));
        message('この端末に変更を保存しました。共有されるまでは他端末に反映されません。');
      }
      closeDecision();
      if(localOnly){render();renderSelectedPhotos();}
      refresh();
    }catch(e){if(decision===d&&confirmation===attempt)status.textContent=e.message;}
    finally{if(confirmation===attempt)confirmation=null;buttons.forEach(b=>b.disabled=false);}
  }
  function refreshDraftActions(){if(panel)panel.querySelector('[data-append-copy]').hidden=!(draft&&draft.text!==draft.savedText&&draft.headIds?.length);}
  function refresh(){
    if(renderDepth||!panel)return;renderDepth++;
    try{
      bind();updateReview();const s=selectedRecord();panel.hidden=!s||s.recordKind==='drawing-memo'||s.recordKind==='dimension-line';if(panel.hidden)return;
      const view=displayView(s);list.replaceChildren();
      for(const comment of view.comments){
        if(comment.deleted)continue;
        const card=document.createElement('article'),body=document.createElement('p'),meta=document.createElement('small');
        body.textContent=comment.text;meta.textContent=comment.heads.map(h=>[who(h),time(h)].filter(Boolean).join(' · ')).join(' / ');
        card.append(body,meta);
        if(comment.conflict){const label=document.createElement('p');label.textContent='別々の修正が届いています。両方を残して共有しています。';card.append(label);}
        else card.append(button('修正',()=>showDecision({...context(),kind:'comment-edit',commentId:comment.id,headIds:comment.headIds})));
        const revisions=s.collab?.comments?.[comment.id]?.revisions||[];
        if(revisions.length>1){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='修正履歴';details.append(summary);
          for(const r of revisions){const p=document.createElement('p');p.textContent=[who(r),time(r),r.deleted?'削除の記録':r.text].join('\n');details.append(p);}card.append(details);}
        if(comment.conflict)for(const candidate of comment.heads){card.append(button(candidate.deleted?'削除の案を採用':who(candidate)+'の文章を採用',()=>resolveConflict('comment',comment.id,candidate,comment.headIds)));}
        list.append(card);
      }
      conflicts.replaceChildren();
      for(const field of Object.values(view.fields).filter(f=>f.conflict)){
        const box=document.createElement('article'),p=document.createElement('p');p.textContent=(scalarLabels[field.key]||({geometry:'位置・形状',labelPos:'文字の位置'}[field.key])||field.key)+'に別々の変更があります。両方を保存しています。';box.append(p);
        const agreed=document.createElement('p');agreed.textContent='変更前の共通の内容：'+valueText(field.key,field.unset?undefined:field.value);box.append(agreed);
        for(const candidate of field.heads){const text=document.createElement('p');text.textContent=who(candidate)+'：'+valueText(field.key,candidate.value);box.append(text,button('この内容を採用',()=>resolveConflict('field',field.key,candidate,field.headIds)));}conflicts.append(box);
      }
      if(view.pendingDelete){const box=document.createElement('article');box.textContent='削除の操作と新しい記入が重なっています。記録を残して共有しています。';box.append(button('この記録を残す',()=>mutate(()=>replaceRecord(M.restore(selectedRecord(),opts({expectedToken:M.revisionToken(selectedRecord())}))))),button('内容を確認して削除',()=>showDecision({...context(),kind:'delete',token:M.revisionToken(selectedRecord())})));conflicts.append(box);}
      if(input.value!==draft.text&&!composing&&!finishingComposition)input.value=draft.text;
      panel.querySelector('[data-draft-label]').textContent=editingComment?'コメントを修正':'コメントを追記';
      refreshDraftActions();
      if(!decision){
        const saved=savedDecisions(context());if(saved.length){decisionQueue=saved.slice(1);showDecision(saved[0]);}
      }
    }catch(e){message(e.message,true);}finally{renderDepth--;}
  }
  async function resolveConflict(kind,keyName,candidate,expectedHeads,targetContext=context()){
    const c=targetContext,selection=selected;try{
      if(!navigator.onLine)throw Error('接続後に最新の候補を確認してください。');
      const checked=await root.sentlogCollabRefresh?.(c.projectId);if(checked?.fresh!==true)throw Error('最新の候補をまだ確認できていません。');if(!sameDrawing(c)||selected!==selection)throw Error('アカウントまたは選択中の記録が変わりました。');
      mutate(()=>{const s=currentTarget(c);if(!s)throw Error('記録が移動または削除されました。');replaceRecord(kind==='comment'?M.resolveComment(s,keyName,candidate.text,opts({expectedHeads,deleted:candidate.deleted})):M.resolveField(s,keyName,candidate.value,opts({expectedHeads,unset:candidate.unset===true})));});
    }catch(e){message(e.code==='COLLAB_STALE'?'新しい候補が届いています。内容を確認し直してください。':e.message,true);refresh();}
  }
  function reviewEntries(){
    if(typeof currentView!=='undefined'&&currentView!=='editor'||!activeDrawingId)return [];
    return [...(state.shapes||[]),...(state.collabDeletedRecords||[])].flatMap(record=>{
      const c=recordContext(record.id),pending=savedDecisions(c),view=displayView(record);
      return pending.length||view.conflicts.length?[{record,context:c,pending,view}]:[];
    });
  }
  function updateReview(){
    if(!reviewButton)return;const entries=reviewEntries(),count=entries.reduce((n,x)=>n+x.pending.length+x.view.conflicts.length,0);
    reviewButton.hidden=!count;reviewButton.textContent='共同編集の確認 '+count+'件';
    if(typeof currentView!=='undefined'&&currentView!=='editor'){if(reviewDialog)reviewDialog.hidden=true;if(dialog)dialog.hidden=true;return;}
    if(reviewDialog&&!reviewDialog.hidden)renderReview(entries);
  }
  function renderReview(entries=reviewEntries()){
    const content=reviewDialog.querySelector('[data-review-list]');content.replaceChildren();
    if(!entries.length){const p=document.createElement('p');p.textContent='確認待ちの変更はありません。';content.append(p);}
    for(const item of entries){
      const box=document.createElement('article'),title=document.createElement('h3');title.textContent=item.record.autoLabel||item.record.no||({ 'drawing-memo':'図面メモ','dimension-line':'寸法線'}[item.record.recordKind])||'記録';box.append(title);
      for(const d of item.pending){const p=document.createElement('p');p.textContent=d.kind==='delete'?'削除の確認待ち':d.kind==='photo-remove'?'写真「'+(d.photoName||'選択した写真')+'」を外す確認待ち':(scalarLabels[d.key]||d.key||'コメント')+'の変更待ち';box.append(p,button('変更内容を確認',()=>{reviewDialog.hidden=true;showDecision(d);}));}
      for(const field of Object.values(item.view.fields).filter(f=>f.conflict)){
        const p=document.createElement('p');p.textContent=(scalarLabels[field.key]||({geometry:'位置・形状',labelPos:'文字の位置'}[field.key])||field.key)+'：変更前の共通の内容は '+valueText(field.key,field.unset?undefined:field.value);box.append(p);
        for(const candidate of field.heads){const text=document.createElement('p');text.textContent=who(candidate)+'：'+valueText(field.key,candidate.unset?undefined:candidate.value);box.append(text,button('この内容を採用',()=>resolveConflict('field',field.key,candidate,field.headIds,item.context)));}
      }
      for(const comment of item.view.comments.filter(x=>x.conflict))for(const candidate of comment.heads){const text=document.createElement('p');text.textContent=who(candidate)+'：'+(candidate.deleted?'削除の候補':candidate.text);box.append(text,button(candidate.deleted?'削除の案を採用':'この文章を採用',()=>resolveConflict('comment',comment.id,candidate,comment.headIds,item.context)));}
      for(const photo of item.view.photos.filter(x=>x.conflict)){const text=document.createElement('p');text.textContent='写真の異なる内容を保持しています：'+photo.heads.map(h=>h.value.name||h.value.id).join(' / ');box.append(text);}
      if(item.view.pendingDelete){const p=document.createElement('p');p.textContent='削除と新しい記入が重なっています。記録を残して共有しています。';box.append(p,button('内容を確認して削除',()=>{reviewDialog.hidden=true;showDecision({...item.context,kind:'delete',token:item.view.token});}),button('この記録を残す',()=>{const target=currentTarget(item.context);if(target)mutate(()=>replaceRecord(M.restore(target,opts({expectedToken:item.view.token}))));}));}
      content.append(box);
    }
  }
  function openReview(){
    if(!reviewDialog){reviewDialog=document.createElement('div');reviewDialog.className='sl-collab-review';reviewDialog.setAttribute('role','dialog');reviewDialog.setAttribute('aria-modal','true');reviewDialog.setAttribute('aria-labelledby','slCollabReviewTitle');reviewDialog.innerHTML='<section><h2 id="slCollabReviewTitle">共同編集の確認</h2><p>入力や撮影を続けながら、必要な変更だけ確認できます。</p><p data-review-status role="status"></p><div data-review-list></div><div data-review-actions></div></section>';reviewDialog.querySelector('[data-review-actions]').append(button('閉じる',()=>{reviewDialog.hidden=true;}));document.body.append(reviewDialog);}
    renderReview();reviewDialog.hidden=false;
  }
  function install(){
    const style=document.createElement('style');style.textContent=`
#memo,#frRecordMemo,label[for=frRecordMemo]{display:none!important}#memo{visibility:hidden}
#slCollabComments[hidden],.sl-collab-dialog[hidden],.sl-collab-review[hidden],#slCollabReviewButton[hidden]{display:none!important}
#slCollabComments{margin:12px 0;border-top:1px solid #cbd5e1;padding-top:12px}#slCollabComments h3{margin:0 0 8px;font-size:15px}
#slCollabComments article{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:9px;margin:7px 0;overflow-wrap:anywhere}#slCollabComments p{white-space:pre-wrap;margin:5px 0;line-height:1.5}#slCollabComments small{display:block;color:#64748b}#slCollabComments button{min-height:40px;margin:5px 5px 0 0;font-size:12px}#slCollabComments textarea{width:100%;box-sizing:border-box;min-height:90px}#slCollabComments [role=status]{font-size:12px}
.sl-collab-dialog{position:fixed;inset:0;z-index:2400;background:#0006;display:grid;place-items:center;padding:16px}.sl-collab-dialog section{background:white;color:#111827;max-width:440px;width:100%;box-sizing:border-box;padding:20px;border-radius:14px;max-height:90dvh;overflow:auto}.sl-collab-dialog h2{font-size:18px}.sl-collab-dialog p{white-space:pre-wrap;line-height:1.7}.sl-collab-dialog button{min-height:44px;margin:5px}
#slCollabReviewButton{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:1300;min-height:44px;padding:8px 14px;border:1px solid #a16207;border-radius:10px;background:#fffbeb;color:#713f12;font-weight:700}
.sl-collab-review{position:fixed;inset:0;z-index:2350;background:#0006;display:grid;place-items:center;padding:16px}.sl-collab-review section{background:white;color:#111827;max-width:560px;width:100%;box-sizing:border-box;padding:20px;border-radius:14px;max-height:90dvh;overflow:auto}.sl-collab-review p{white-space:pre-wrap;overflow-wrap:anywhere}.sl-collab-review article{border-top:1px solid #cbd5e1;margin-top:12px}.sl-collab-review button{min-height:44px;margin:5px}
`;document.head.append(style);
    reviewButton=button('共同編集の確認',openReview);reviewButton.id='slCollabReviewButton';reviewButton.hidden=true;document.body.append(reviewButton);
    const memo=document.getElementById('memo');if(memo){memo.readOnly=true;memo.parentElement.hidden=true;}
    const fieldMemo=document.getElementById('frRecordMemo');if(fieldMemo)fieldMemo.readOnly=true;
    panel=document.createElement('section');panel.id='slCollabComments';panel.hidden=true;
    panel.innerHTML='<h3>コメント</h3><div data-list></div><div data-conflicts></div><label for="slCollabDraft" data-draft-label>コメントを追記</label><textarea id="slCollabDraft" placeholder="追記する内容を入力"></textarea><p role="status" data-note>入力は自動保存されます。既存コメントの下へ追記します。</p><div data-actions></div>';
    const photoPanel=document.querySelector('#inspector .photo-panel');photoPanel.before(panel);
    list=panel.querySelector('[data-list]');conflicts=panel.querySelector('[data-conflicts]');input=panel.querySelector('textarea');note=panel.querySelector('[data-note]');
    const actions=panel.querySelector('[data-actions]'),append=button('別のコメントとして追記',saveAsAppend);append.dataset.appendCopy='';append.hidden=true;
    actions.append(button('保存',saveCurrentDraft),button('次のコメント',startNext),append);
    input.addEventListener('input',e=>{if(!draft)return;draft.text=input.value;draft.revisionId=null;draft.compositionPending=composing||e.isComposing===true;writeDraft();stopTimer();if(!composing&&!finishingComposition&&!e.isComposing)saveTimer=setTimeout(flushDraft,650);});
    input.addEventListener('compositionstart',()=>{composing=true;stopTimer();if(draft){draft.compositionPending=true;writeDraft();}});
    input.addEventListener('compositionend',()=>{composing=false;finishingComposition=true;if(draft){draft.text=input.value;draft.revisionId=null;draft.compositionPending=false;writeDraft();}
      queueMicrotask(()=>{finishingComposition=false;if(key(context())!==key(binding)){flushDraft();bind();refresh();}else saveTimer=setTimeout(flushDraft,200);});});
    input.addEventListener('blur',()=>{if(composing||finishingComposition){if(draft){draft.text=input.value;writeDraft();}return;}flushDraft();});
    document.getElementById('deleteBtn').onclick=()=>{const s=selectedRecord();if(s)showDecision({...context(),kind:'delete',token:M.revisionToken(s)});};
  }
  const originalPersist=persist;
  persist=function(){
    if(managed||!activeDrawingId)return originalPersist.apply(this,arguments);
    const before=readDrawing(activeDrawingId)||{shapes:[]},oldById=new Map((before.shapes||[]).map(s=>[s.id,s]));
    const warnings=[];state.shapes=(state.shapes||[]).map(s=>{
      const previous=oldById.get(s.id);if(!previous)return M.applyLocalEdit({id:s.id,memo:'',photos:[]},s,opts());
      let after=copy(s),prior=M.upgrade(previous),observed=s.collab?M.upgrade(s):prior,view=M.view(observed);
      for(const field of guarded){
        const existing=observed[field];if(same(existing,after[field])&&own(observed,field)===own(after,field))continue;
        if(same(prior[field],after[field])&&own(prior,field)===own(after,field))continue;
        if((existing===undefined||existing===null||existing==='')&&(prior[field]===undefined||prior[field]===null||prior[field]===''))continue;
        // An offline edit is a normal local revision. Its observed parents
        // remain explicit; an unseen peer change becomes a merge conflict,
        // never an implicit overwrite. The writer still guards durable saves.
        if(!navigator.onLine)continue;
        const pending={accountId:accountId(),projectId:activeProjectId,drawingId:activeDrawingId,recordId:s.id,kind:'field',key:field,value:copy(after[field]),unset:!own(after,field),headIds:view.fields[field]?.headIds||[]};
        warnings.push(pending);if(own(observed,field))after[field]=copy(observed[field]);else delete after[field];
      }
      return M.applyLocalEdit(prior,after,opts());
    });
    // Removing a record is explicit and carries its history into tombstones.
    const retained=new Set([...state.shapes,...(state.collabDeletedRecords||[])].map(s=>s.id));
    for(const old of before.shapes||[])if(!retained.has(old.id)){
      state.shapes.push(copy(old));warnings.push({...recordContext(old.id),kind:'delete',token:M.revisionToken(old)});
    }
    const deleted=new Map([...(before.collabDeletedRecords||[]),...(state.collabDeletedRecords||[])].map(s=>[s.id,s]));
    state.collabDeletedRecords=[...deleted.values()];
    if(warnings.length)rebuildNumberingState();
    const result=originalPersist.apply(this,arguments);recordHistory(before,state);
    if(warnings.length){enqueueDecisions(warnings);queueMicrotask(()=>render());}
    return result;
  };
  function updateButtons(){
    if(typeof activeDrawingId==='undefined')return;
    const h=histories.get(historyKey()),u=document.getElementById('undoBtn'),r=document.getElementById('redoBtn');
    if(u)u.disabled=!h?.undo.length;if(r)r.disabled=!h?.redo.length;
  }
  function reverseRecord(current,from,to){
    let result=M.upgrade(current);const a=M.view(from),b=M.view(to);let changed=false;
    for(const [field,after] of Object.entries(a.fields)){
      const before=b.fields[field];if(same({value:after.value,unset:after.unset},{value:before?.value,unset:before?.unset??true}))continue;
      const latest=M.view(result).fields[field];if(!same(latest?.headIds,after.headIds))continue;
      result=M.setField(result,field,before?.value,opts({expectedHeads:latest.headIds,unset:before?.unset??true}));changed=true;
    }
    for(const after of a.comments){
      const before=b.comments.find(x=>x.id===after.id);if(before&&same({text:before.text,deleted:before.deleted},{text:after.text,deleted:after.deleted}))continue;
      const latest=M.view(result).comments.find(x=>x.id===after.id);if(!same(latest?.headIds,after.headIds)||latest?.conflict)continue;
      result=M.editComment(result,after.id,before?before.text:after.text,opts({expectedHeads:latest.headIds,deleted:!before||before.deleted}));changed=true;
    }
    for(const after of a.photos){
      const before=b.photos.find(x=>x.id===after.id);if(before&&same({metadata:before.metadata,deleted:before.deleted},{metadata:after.metadata,deleted:after.deleted}))continue;
      const latest=M.view(result).photos.find(x=>x.id===after.id);if(!same(latest?.headIds,after.headIds)||latest?.conflict)continue;
      result=!before||before.deleted?M.removePhoto(result,after.id,opts({expectedHeads:latest.headIds})):M.restorePhoto(result,after.id,opts({expectedHeads:latest.headIds,metadata:before.metadata}));changed=true;
    }
    return {record:result,changed};
  }
  function playback(direction){
    if(composing||finishingComposition||draft?.compositionPending)return;
    if(draft?.text!==draft?.savedText&&(draft?.text.trim()||draft?.headIds?.length)&&!flushDraft())return;
    const h=histories.get(historyKey());if(!h?.[direction].length)return;
    const action=h[direction].pop(),from=direction==='undo'?action.after:action.before,to=direction==='undo'?action.before:action.after;
    const currentBefore=copy(state),fromMap=new Map((from.shapes||[]).map(s=>[s.id,s])),toMap=new Map((to.shapes||[]).map(s=>[s.id,s]));let changed=false;
    historyPlayback=true;
    try{mutate(()=>{
      for(const [recordId,after] of fromMap){
        const current=state.shapes.find(s=>s.id===recordId);if(!current)continue;const before=toMap.get(recordId);
        if(!before){if(M.revisionToken(current)!==M.revisionToken(after))continue;const removed=M.markDeleted(current,opts({expectedToken:M.revisionToken(current)}));state.shapes=state.shapes.filter(s=>s.id!==recordId);state.collabDeletedRecords=[...(state.collabDeletedRecords||[]).filter(s=>s.id!==recordId),removed];changed=true;}
        else{const result=reverseRecord(current,after,before);if(result.changed){replaceRecord(result.record);changed=true;}}
      }
      for(const [recordId,before] of toMap){if(fromMap.has(recordId)||state.shapes.some(s=>s.id===recordId))continue;
        const old=(state.collabDeletedRecords||[]).find(s=>s.id===recordId),expected=(from.collabDeletedRecords||[]).find(s=>s.id===recordId);
        if(old&&expected&&M.revisionToken(old)===M.revisionToken(expected)){const restored=M.restore(old,opts({expectedToken:M.revisionToken(old)}));state.shapes.push(restored);state.collabDeletedRecords=state.collabDeletedRecords.filter(s=>s.id!==recordId);changed=true;}}
    });
    }finally{historyPlayback=false;}
    if(changed){const inverse=direction==='undo'?{before:copy(state),after:currentBefore}:{before:currentBefore,after:copy(state)};h[direction==='undo'?'redo':'undo'].push(inverse);}
    else message('ほかの端末で更新された内容を保護しました。該当項目の履歴から確認してください。',true);
    updateButtons();
  }
  const oldRender=render;render=function(){const result=oldRender.apply(this,arguments);refresh();updateButtons();return result;};
  const oldSelect=selectShape;selectShape=function(){flushDraft();const result=oldSelect.apply(this,arguments);refresh();return result;};
  const oldClear=clearAllHistory;clearAllHistory=function(){histories.clear();oldClear();updateButtons();};
  undo=()=>playback('undo');redo=()=>playback('redo');updateHistoryButtons=updateButtons;
  if(typeof removeSelectedPhoto==='function')removeSelectedPhoto=async function(photoId){
    const record=selectedRecord(),c=context();if(!record||!c)return;
    const photo=M.view(record).photos.find(p=>p.id===photoId);if(!photo||photo.deleted)return;
    // The existing thumbnail × keeps its public handler, but now records an
    // explicit, revision-bound unlink. Original bytes and peer additions stay.
    enqueueDecisions([{...c,kind:'photo-remove',photoId,photoName:photo.metadata?.name||'',headIds:photo.headIds}]);
    if(!decision)refresh();
  };
  document.getElementById('undoBtn').onclick=undo;document.getElementById('redoBtn').onclick=redo;
  for(const event of ['pagehide','blur'])window.addEventListener(event,()=>{if(draft)writeDraft();});
  function semanticRecord(record){
    if(!record)return record;const result=copy(record);
    for(const k of ['globalNo','typeNo','autoLabel','recordNo','labelPosEditedAt'])delete result[k];
    for(const photo of result.photos||[]){delete photo.localBlob;delete photo.data;}return result;
  }
  function afterStoredNormalization(writes,beforeRecords=[]){
    if(!activeDrawingId)return;const storageKey=drawingStorageKey(activeDrawingId),nextText=new Map(writes).get(storageKey),oldText=new Map(beforeRecords).get(storageKey);
    if(typeof nextText!=='string'||typeof oldText!=='string')return;
    const next=JSON.parse(nextText),before=JSON.parse(oldText),previous=new Map([...(before.shapes||[]),...(before.collabDeletedRecords||[])].map(r=>[r.id,r]));
    const incoming=new Map([...(next.shapes||[]),...(next.collabDeletedRecords||[])].map(r=>[r.id,r]));let changed=false;
    for(const field of ['shapes','collabDeletedRecords'])state[field]=(state[field]||[]).map(live=>{
      const old=previous.get(live.id),canonical=incoming.get(live.id);if(!old||!canonical||!same(semanticRecord(live),semanticRecord(old)))return live;
      changed=true;const out=copy(canonical);
      for(const k of ['globalNo','typeNo','autoLabel','recordNo','labelPosEditedAt'])if(own(live,k))out[k]=copy(live[k]);
      const photos=new Map((live.photos||[]).map(p=>[p.id,p]));for(const photo of out.photos||[])for(const k of ['localBlob','data'])if(own(photos.get(photo.id)||{},k))photo[k]=photos.get(photo.id)[k];return out;
    });
    if(changed){render();renderSelectedPhotos();refresh();}
  }
  root.SentlogCollaboration={offlineDamageDecisionsVersion:2,actor,flushDraft,refresh,recordHistory,afterStoredNormalization,
    requestPhotoRemoval(capture,photoId){
      const c={accountId:capture?.ownerId||'',projectId:capture?.projectId,drawingId:capture?.drawingId,recordId:capture?.recordId};
      if(!sameDrawing(c))throw Error('撮影先の図面を開いてから写真を外してください。');
      const control=root.SentlogArchive?.byLocal?.(c.projectId);
      if(control&&(control.status!=='active'||control.checking))throw Error('保管中・確認中の案件は変更できません。写真の原本は残っています。');
      const record=currentTarget(c),photo=record&&M.view(record).photos.find(p=>p.id===photoId);
      if(!photo||photo.deleted)throw Error('この写真は既に記録から外されています。原本は残っています。');
      showDecision({...c,kind:'photo-remove',photoId,photoName:photo.metadata?.name||'',headIds:photo.headIds});
    },
    hasPendingDraft:()=>composing||finishingComposition||!!draft?.compositionPending||!!draft&&(draft.text!==draft.savedText)&&(!!draft.text.trim()||!!draft.headIds?.length),
    isCapturedFieldDraft(element,record){
      const field={damageType:'type',member:'member'}[element?.id],c=context();
      if(!field||!c||record?.id!==c.recordId||undurableDecisions.has(decisionsKey(c)))return false;
      return savedDecisions(c).some(d=>d.kind==='field'&&d.key===field&&!d.unset&&String(d.value??'')===String(element.value??''));
    },
    captureEditor(){return {selection:selected,fields:Object.fromEntries(['damageType','member','lineWidth'].map(k=>[k,document.getElementById(k)?.value])),context:context()};},
    restoreEditor(saved){if(!saved||key(saved.context)!==key(context()))return;for(const [k,v] of Object.entries(saved.fields||{})){const el=document.getElementById(k);if(el&&v!==undefined&&document.activeElement===el)el.value=v;}refresh();},
    isDraftElement:el=>!!el&&!!el.closest?.('#slCollabComments,.sl-collab-dialog,.sl-collab-review'),
    onRemote(){refresh();updateButtons();},isManaged:()=>managed>0};
  install();refresh();
})(window);

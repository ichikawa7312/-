/* Sentlog v1.69: rename/delete actions on drawing-list cards.
 * Deleting a drawing removes the local drawing record, background and shared photos.
 * Device-local original photos are deliberately preserved for later export.
 */
(function(root){
  'use strict';
  const WORKSPACE_KEY='surveyFieldNoteWorkspaceV1';
  const MAX_NAME=100;

  function cleanName(value){
    const name=String(value??'').trim().replace(/\s+/g,' ');
    if(!name)throw Error('図面名を入力してください。');
    if(name.length>MAX_NAME)throw Error('図面名は100文字以内にしてください。');
    return name;
  }
  function belongsToDrawing(key,drawingId){
    const id=String(drawingId||'');
    return String(key||'')==='background:'+id || String(key||'').startsWith('photo:'+id+':');
  }
  function deletionFiles(files,drawingId){
    return (files||[]).filter(f=>f?.value instanceof Blob&&belongsToDrawing(f.key,drawingId))
      .map(f=>({key:String(f.key),size:f.value.size}));
  }
  function removeDrawingFromWorkspace(ws,projectId,drawingId,now=Date.now()){
    const next=JSON.parse(JSON.stringify(ws||{projects:[]}));
    const p=(next.projects||[]).find(x=>x.id===projectId);
    if(!p)throw Error('案件が見つかりません。');
    const index=(p.drawings||[]).findIndex(d=>d.id===drawingId);
    if(index<0)throw Error('図面が見つかりません。');
    p.drawings.splice(index,1);
    p.updatedAt=Math.max(Number(p.updatedAt)||0,Number(now)||Date.now());
    return next;
  }
  function renameDrawingInWorkspace(ws,projectId,drawingId,newName,now=Date.now()){
    const name=cleanName(newName),next=JSON.parse(JSON.stringify(ws||{projects:[]}));
    const p=(next.projects||[]).find(x=>x.id===projectId);
    if(!p)throw Error('案件が見つかりません。');
    const d=(p.drawings||[]).find(x=>x.id===drawingId);
    if(!d)throw Error('図面が見つかりません。');
    d.name=name;d.updatedAt=Math.max(Number(d.updatedAt)||0,Number(now)||Date.now());
    p.updatedAt=Math.max(Number(p.updatedAt)||0,d.updatedAt);
    return next;
  }
  const pure={WORKSPACE_KEY,MAX_NAME,cleanName,belongsToDrawing,deletionFiles,removeDrawingFromWorkspace,renameDrawingInWorkspace};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogDrawingListActions)return;
  if(typeof renderDrawings!=='function')throw Error('図面一覧の読み込み順序が正しくありません。');

  const S=root.SentlogRecords;
  if(!S)throw Error('図面一覧の保存機能を読み込めません。');

  function readWorkspace(){
    const raw=S.getItem(WORKSPACE_KEY);
    if(typeof raw!=='string')throw Error('案件一覧を確認できません。');
    const value=JSON.parse(raw);
    if(!value||!Array.isArray(value.projects))throw Error('案件一覧の形式を確認できません。');
    return {raw,value};
  }
  function drawingState(id){
    try{return JSON.parse(S.getItem(drawingStorageKey(id))||'null');}catch{return null;}
  }
  async function originalStats(drawingId){
    try{
      if(!root.SentlogOriginalPhotos?.drawingStats)return {count:0,unexportedCount:0,bytes:0,unexportedBytes:0};
      return await root.SentlogOriginalPhotos.drawingStats(drawingId);
    }catch(e){console.warn('drawing original stats',e);return {count:0,unexportedCount:0,bytes:0,unexportedBytes:0};}
  }
  function bytes(n){
    n=Number(n)||0;
    if(n<1024)return n+' B';
    if(n<1024**2)return (n/1024).toFixed(1)+' KB';
    if(n<1024**3)return (n/1024**2).toFixed(1)+' MB';
    return (n/1024**3).toFixed(2)+' GB';
  }
  function stopCardEvent(e){e.preventDefault();e.stopPropagation();}

  async function renameDrawing(projectId,drawingId){
    const {raw,value}=readWorkspace(),p=value.projects.find(x=>x.id===projectId),d=p?.drawings?.find(x=>x.id===drawingId);
    if(!p||!d)throw Error('図面が見つかりません。');
    const entered=prompt('図面名を変更してください。',d.name||'図面');
    if(entered===null)return false;
    const name=cleanName(entered);
    if(name===d.name)return false;
    const next=renameDrawingInWorkspace(value,projectId,drawingId,name,Date.now());
    if(typeof S.archiveAtomic!=='function')throw Error('安全な更新機能を読み込めません。画面を更新してから再試行してください。');
    await S.archiveAtomic({writes:[[WORKSPACE_KEY,JSON.stringify(next)]],deleteFiles:[],expectedWorkspace:raw});
    workspace=next;
    let originalWarning='';
    try{await root.SentlogOriginalPhotos?.renameDrawing?.(drawingId,name);}
    catch(e){console.warn('rename original metadata',e);originalWarning='\n原本写真の書き出し先名だけ更新できませんでした。原本写真自体は残っています。';}
    renderDrawings();
    root.SentlogOriginalPhotos?.refreshUI?.();
    if(originalWarning)alert('図面名は変更しました。'+originalWarning);
    return true;
  }

  async function deleteDrawing(projectId,drawingId){
    const {raw,value}=readWorkspace(),p=value.projects.find(x=>x.id===projectId),d=p?.drawings?.find(x=>x.id===drawingId);
    if(!p||!d)throw Error('図面が見つかりません。');
    const originals=await originalStats(drawingId);
    const st=drawingState(drawingId);
    const sharedPhotoCount=(st?.shapes||[]).reduce((n,s)=>n+(s.photos?.length||0),0);
    let message='「'+(d.name||'図面')+'」を削除しますか？\n\n'+
      'この端末の図面ファイル、変状・調査記録、共有用写真'+(sharedPhotoCount?'（'+sharedPhotoCount+'枚）':'')+'を削除します。\n'+
      '端末間同期後は、ほかの端末の図面一覧からも削除されます。';
    if(originals.count){
      message+='\n\n原本写真 '+originals.count+'枚はこの操作では削除しません。';
      if(originals.unexportedCount)message+='\nうち未書き出し '+originals.unexportedCount+'枚は「設定 → 原本写真」から後で書き出せます。';
    }
    message+='\n\nこの図面の削除は元に戻せません。';
    if(!confirm(message))return false;

    const allFiles=typeof getAllDBFiles==='function'?await getAllDBFiles():[];
    const deleteFiles=deletionFiles(allFiles,drawingId);
    const next=removeDrawingFromWorkspace(value,projectId,drawingId,Date.now());
    if(typeof S.archiveAtomic!=='function')throw Error('安全な削除機能を読み込めません。画面を更新してから再試行してください。');
    await S.archiveAtomic({
      writes:[[WORKSPACE_KEY,JSON.stringify(next)],[drawingStorageKey(drawingId),null]],
      deleteFiles,
      expectedWorkspace:raw
    });
    workspace=next;
    if(activeDrawingId===drawingId)activeDrawingId=null;
    renderDrawings();
    root.SentlogOriginalPhotos?.refreshUI?.();
    const removedBytes=deleteFiles.reduce((n,f)=>n+f.size,0);
    alert('図面を削除しました。'+(deleteFiles.length?'\n端末から '+deleteFiles.length+'ファイル／約'+bytes(removedBytes)+' を削除しました。':'')+
      (originals.count?'\n原本写真 '+originals.count+'枚は残しています。':''));
    return true;
  }

  function button(text,kind,action){
    const b=document.createElement('button');b.type='button';b.className='drawing-card-action '+kind;b.textContent=text;
    b.addEventListener('pointerdown',e=>e.stopPropagation());
    b.addEventListener('click',async e=>{stopCardEvent(e);b.disabled=true;try{await action();}catch(err){console.error(err);alert(err?.message||String(err));b.disabled=false;}});
    b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '||e.key==='Escape')e.stopPropagation();});
    return b;
  }
  function enhance(){
    const grid=document.getElementById('drawingsGrid'),p=typeof getProject==='function'?getProject():null;
    if(!grid||!p)return;
    const drawings=[...(p.drawings||[])].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    const cards=[...grid.children].filter(x=>x.classList?.contains('manager-card'));
    cards.forEach((card,i)=>{
      const d=drawings[i];if(!d||card.querySelector('.drawing-card-actions'))return;
      card.dataset.drawingId=d.id;
      const row=document.createElement('div');row.className='drawing-card-actions';row.setAttribute('aria-label',(d.name||'図面')+'の操作');
      row.append(
        button('名前変更','rename',()=>renameDrawing(p.id,d.id)),
        button('削除','delete',()=>deleteDrawing(p.id,d.id))
      );
      card.appendChild(row);
    });
  }
  const style=document.createElement('style');
  style.textContent='.drawing-card-actions{display:flex;gap:7px;justify-content:flex-end;margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb}.drawing-card-actions button{width:auto!important;min-width:76px;min-height:40px;padding:7px 11px;border-radius:8px;font-size:12px;line-height:1.2}.drawing-card-actions .rename{background:#fff;color:#374151;border:1px solid #cbd5e1}.drawing-card-actions .delete{background:#fff;color:#b91c1c;border:1px solid #fecaca}.drawing-card-actions button:disabled{opacity:.45}@media(max-width:480px){.drawing-card-actions{gap:8px}.drawing-card-actions button{min-height:44px;flex:1;min-width:0}}';
  document.head.appendChild(style);

  const oldRenderDrawings=renderDrawings;
  renderDrawings=function(){const result=oldRenderDrawings.apply(this,arguments);enhance();return result;};

  root.SentlogDrawingListActions={...pure,renameDrawing,deleteDrawing,enhance};
  if(typeof currentView!=='undefined'&&currentView==='drawings')enhance();
})(typeof globalThis!=='undefined'?globalThis:this);

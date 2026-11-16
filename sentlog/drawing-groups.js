/* Sentlog v1.71: drawing numbers (groups) containing multiple drawing sheets.
 * Existing drawings migrate in place to one-sheet groups without changing any
 * drawing IDs, saved annotations, PDFs or photos.
 */
(function(root){
  'use strict';

  const GROUP_VERSION=1;
  const WORKSPACE_KEY='surveyFieldNoteWorkspaceV1';
  let pendingGroupId=null;
  let sheetUi=null;

  function groupId(d){return String(d?.groupId||d?.id||'');}
  function groupName(d){return String(d?.groupName||d?.name||'図面');}
  function sheetName(d){return String(d?.sheetName||d?.name||d?.fileName||'図面');}
  const isTrashed=d=>Number(d?.deletedAt)>0;
  function sortSheets(items){
    return [...(items||[])].sort((a,b)=>(Number(a.sheetOrder)||999999)-(Number(b.sheetOrder)||999999)||
      (Number(a.createdAt)||0)-(Number(b.createdAt)||0)||String(a.id).localeCompare(String(b.id)));
  }
  function groupsForProject(project){
    const map=new Map();
    for(const d of project?.drawings||[]){
      if(isTrashed(d))continue;
      const id=groupId(d);if(!id)continue;
      let g=map.get(id);
      if(!g){g={id,name:groupName(d),sheets:[],updatedAt:0};map.set(id,g);}
      g.sheets.push(d);g.updatedAt=Math.max(g.updatedAt,Number(d.updatedAt)||0);
      if(d.groupName)g.name=d.groupName;
    }
    return [...map.values()].map(g=>({...g,sheets:sortSheets(g.sheets)}));
  }
  function normalizeWorkspace(input){
    const ws=JSON.parse(JSON.stringify(input||{projects:[]}));let changed=false;
    for(const p of ws.projects||[]){
      const counters=new Map();
      for(const d of p.drawings||[]){
        if(!d.groupId){d.groupId=d.id;changed=true;}
        if(!d.groupName){d.groupName=d.name||'図面';changed=true;}
        if(!d.sheetName){d.sheetName=d.name||d.fileName||'図面';changed=true;}
        d.name=d.sheetName;
        const gid=groupId(d),next=(counters.get(gid)||0)+1;counters.set(gid,next);
        if(!Number.isFinite(Number(d.sheetOrder))||Number(d.sheetOrder)<=0){d.sheetOrder=next;changed=true;}
      }
    }
    return {workspace:ws,changed};
  }
  function normalizeSnapshotPayload(input){
    const p=JSON.parse(JSON.stringify(input||{}));
    if(p.project){
      const wrapped=normalizeWorkspace({projects:[p.project]});
      p.project=wrapped.workspace.projects[0];
    }
    if(Array.isArray(p.drawings)){
      const metas=p.drawings.map(x=>x?.meta).filter(Boolean);
      if(metas.length){
        const wrapped=normalizeWorkspace({projects:[{id:'__sync__',drawings:metas}]});
        const byId=new Map((wrapped.workspace.projects[0].drawings||[]).map(d=>[d.id,d]));
        for(const item of p.drawings||[])if(item?.meta?.id&&byId.has(item.meta.id))item.meta=byId.get(item.meta.id);
      }
    }
    return p;
  }
  function renameGroupInWorkspace(input,projectId,targetGroupId,newName,now=Date.now()){
    const name=String(newName||'').trim().replace(/\s+/g,' ');
    if(!name)throw Error('図面No.名を入力してください。');
    if(name.length>100)throw Error('図面No.名は100文字以内にしてください。');
    const {workspace:ws}=normalizeWorkspace(input),p=(ws.projects||[]).find(x=>x.id===projectId);
    if(!p)throw Error('案件が見つかりません。');
    const sheets=(p.drawings||[]).filter(d=>groupId(d)===targetGroupId);
    if(!sheets.length)throw Error('図面No.が見つかりません。');
    const old=groupName(sheets[0]),single=sheets.length===1;
    for(const d of sheets){
      d.groupName=name;
      if(single&&sheetName(d)===old){d.sheetName=name;d.name=name;}
      d.updatedAt=Math.max(Number(d.updatedAt)||0,Number(now)||Date.now());
    }
    p.updatedAt=Math.max(Number(p.updatedAt)||0,...sheets.map(d=>Number(d.updatedAt)||0));
    return ws;
  }
  function removeGroupFromWorkspace(input,projectId,targetGroupId,now=Date.now()){
    const {workspace:ws}=normalizeWorkspace(input),p=(ws.projects||[]).find(x=>x.id===projectId);
    if(!p)throw Error('案件が見つかりません。');
    const before=(p.drawings||[]).length;
    p.drawings=(p.drawings||[]).filter(d=>groupId(d)!==targetGroupId);
    if(p.drawings.length===before)throw Error('図面No.が見つかりません。');
    p.updatedAt=Math.max(Number(p.updatedAt)||0,Number(now)||Date.now());
    return ws;
  }
  function nextSheetOrder(project,targetGroupId){
    const n=(project?.drawings||[]).filter(d=>groupId(d)===targetGroupId)
      .reduce((m,d)=>Math.max(m,Number(d.sheetOrder)||0),0);
    return n+1;
  }

  function trashedSheetsForProject(project){
    return (project?.drawings||[]).filter(isTrashed)
      .slice().sort((a,b)=>Number(b.deletedAt)-Number(a.deletedAt)||String(a.id).localeCompare(String(b.id)));
  }
  function mutateSheetInWorkspace(input,projectId,drawingId,edit,now=Date.now()){
    const {workspace:ws}=normalizeWorkspace(input),p=(ws.projects||[]).find(x=>x.id===projectId);
    if(!p)throw Error('案件が見つかりません。');
    const d=(p.drawings||[]).find(x=>x.id===drawingId);
    if(!d)throw Error('シートが見つかりません。');
    const stamp=Math.max(Number(now)||Date.now(),(Number(p.updatedAt)||0)+1,(Number(d.updatedAt)||0)+1);
    edit(d,stamp);
    d.updatedAt=stamp;p.updatedAt=stamp;
    return ws;
  }
  function renameSheetInWorkspace(input,projectId,drawingId,newName,now=Date.now()){
    const name=String(newName??'').trim().replace(/\s+/g,' ');
    if(!name)throw Error('シート名を入力してください。');
    if(name.length>100)throw Error('シート名は100文字以内にしてください。');
    return mutateSheetInWorkspace(input,projectId,drawingId,d=>{
      if(isTrashed(d))throw Error('ごみ箱内のシートは復元してから名前を変更してください。');
      d.sheetName=name;d.name=name;
    },now);
  }
  function trashSheetInWorkspace(input,projectId,drawingId,now=Date.now()){
    return mutateSheetInWorkspace(input,projectId,drawingId,(d,stamp)=>{
      if(isTrashed(d))throw Error('このシートは既にごみ箱にあります。');
      d.deletedAt=stamp;
    },now);
  }
  function restoreSheetInWorkspace(input,projectId,drawingId,now=Date.now()){
    return mutateSheetInWorkspace(input,projectId,drawingId,d=>{
      if(!isTrashed(d))throw Error('このシートはごみ箱にありません。');
      delete d.deletedAt;
    },now);
  }
  function trashGroupInWorkspace(input,projectId,targetGroupId,now=Date.now()){
    const {workspace:ws}=normalizeWorkspace(input),p=(ws.projects||[]).find(x=>x.id===projectId);
    if(!p)throw Error('案件が見つかりません。');
    const sheets=(p.drawings||[]).filter(d=>groupId(d)===targetGroupId&&!isTrashed(d));
    if(!sheets.length)throw Error('削除対象の図面No.が見つかりません。');
    const stamp=Math.max(Number(now)||Date.now(),(Number(p.updatedAt)||0)+1,
      ...sheets.map(d=>(Number(d.updatedAt)||0)+1));
    for(const d of sheets){d.deletedAt=stamp;d.updatedAt=stamp;}
    p.updatedAt=stamp;return ws;
  }

  function filesForDrawingIds(files,ids){
    const set=new Set(ids||[]);
    return (files||[]).filter(f=>{
      if(!(f?.value instanceof Blob))return false;
      const k=String(f.key||'');
      if(k.startsWith('background:'))return set.has(k.slice('background:'.length));
      if(k.startsWith('photo:'))return set.has(k.split(':')[1]);
      return false;
    }).map(f=>({key:String(f.key),size:f.value.size}));
  }

  const pure={GROUP_VERSION,groupId,groupName,sheetName,sortSheets,groupsForProject,normalizeWorkspace,normalizeSnapshotPayload,
    renameGroupInWorkspace,removeGroupFromWorkspace,nextSheetOrder,filesForDrawingIds,
    isTrashed,trashedSheetsForProject,renameSheetInWorkspace,trashSheetInWorkspace,restoreSheetInWorkspace,trashGroupInWorkspace};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogDrawingGroups)return;

  const $=id=>document.getElementById(id);
  const S=root.SentlogRecords;
  if(!S)throw Error('図面No.機能の保存先を読み込めません。');

  function normalized(){
    const r=normalizeWorkspace(workspace);
    if(r.changed){workspace=r.workspace;saveWorkspace();}
    return r.changed;
  }
  function currentDrawing(){return typeof getDrawingMeta==='function'?getDrawingMeta():null;}
  function currentGroup(){
    const p=typeof getProject==='function'?getProject():null,d=currentDrawing();
    if(!p||!d)return null;
    return groupsForProject(p).find(g=>g.id===groupId(d))||null;
  }
  function bytes(n){
    n=Number(n)||0;
    if(n<1024)return n+' B';
    if(n<1024**2)return (n/1024).toFixed(1)+' KB';
    if(n<1024**3)return (n/1024**2).toFixed(1)+' MB';
    return (n/1024**3).toFixed(2)+' GB';
  }
  async function originalStats(ids){
    const total={count:0,unexportedCount:0,bytes:0,unexportedBytes:0};
    for(const id of ids){
      try{
        const s=await root.SentlogOriginalPhotos?.drawingStats?.(id);
        if(!s)continue;
        for(const k of Object.keys(total))total[k]+=Number(s[k])||0;
      }catch(e){console.warn('group original stats',e);}
    }
    return total;
  }

  function installSheetUi(){
    if(sheetUi)return sheetUi;
    const stack=$('sidebar')?.querySelector('.stack');
    if(!stack)return null;
    const host=document.createElement('div');host.id='sentlogSheetNav';host.className='sheet-nav';
    host.innerHTML='<div class="sheet-nav-head"><strong data-role="group"></strong><span data-role="count"></span></div>'+
      '<label>図面No.内のシート<select data-role="select"></select></label>'+
      '<div class="sheet-nav-row"><button type="button" data-role="prev">◀ 前</button><button type="button" data-role="next">次 ▶</button></div>'+ 
      '<div class="sheet-nav-row sheet-nav-edit"><button type="button" data-role="rename">名前変更</button><button type="button" data-role="trash">削除</button></div>';
    const anchor=$('editorDrawingAddBtn')||$('fileInput')?.previousElementSibling;
    if(anchor&&anchor.parentElement===stack)stack.insertBefore(host,anchor);else stack.prepend(host);
    const select=host.querySelector('[data-role=select]'),prev=host.querySelector('[data-role=prev]'),next=host.querySelector('[data-role=next]');
    const go=async id=>{if(!id||id===activeDrawingId)return;if(activeDrawingId&&typeof persist==='function')persist();await openDrawing(activeProjectId,id);};
    select.onchange=()=>go(select.value);
    prev.onclick=()=>{const g=currentGroup();if(!g)return;const i=g.sheets.findIndex(d=>d.id===activeDrawingId);if(i>0)go(g.sheets[i-1].id);};
    next.onclick=()=>{const g=currentGroup();if(!g)return;const i=g.sheets.findIndex(d=>d.id===activeDrawingId);if(i>=0&&i<g.sheets.length-1)go(g.sheets[i+1].id);};
    host.querySelector('[data-role=rename]').onclick=()=>renameSheet(activeProjectId,activeDrawingId).catch(showActionError);
    host.querySelector('[data-role=trash]').onclick=()=>trashSheet(activeProjectId,activeDrawingId).catch(showActionError);
    const style=document.createElement('style');style.id='sentlogDrawingGroupsStyle';
    style.textContent='.sheet-nav{border:1px solid #d1d5db;border-radius:10px;padding:9px;background:#f8fafc;display:grid;gap:7px}.sheet-nav-head{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px}.sheet-nav-head strong{font-size:13px}.sheet-nav-head span{color:#6b7280}.sheet-nav label{margin:0}.sheet-nav select{margin-top:4px}.sheet-nav-row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.sheet-nav-row button{min-height:40px;padding:7px}.drawing-group-sheets{font-size:12px;color:#6b7280;line-height:1.5}.drawing-group-actions{display:flex;gap:7px;justify-content:flex-end;margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb}.drawing-group-actions button{width:auto!important;min-width:76px;min-height:40px;padding:7px 11px;border-radius:8px;font-size:12px}.drawing-group-actions .delete{color:#b91c1c;border-color:#fecaca;background:#fff}@media(max-width:480px){.sheet-nav-row button{min-height:44px}.drawing-group-actions button{min-height:44px;flex:1;min-width:0}.drawing-group-actions{gap:8px}}';
    style.textContent+='.sheet-nav-edit button:last-child{color:#b91c1c;border-color:#fecaca;background:#fff}.sl-sheet-trash-trigger{margin-left:auto;white-space:nowrap;min-height:40px;border:1px solid #cbd5e1;background:#fff;color:#374151}';
    document.head.appendChild(style);
    sheetUi={host,select,prev,next,group:host.querySelector('[data-role=group]'),count:host.querySelector('[data-role=count]')};
    return sheetUi;
  }

  function updateSheetUi(){
    normalized();
    const ui=installSheetUi(),p=getProject(),d=currentDrawing(),g=currentGroup();
    if(!ui||!p||!d||!g)return;
    const i=g.sheets.findIndex(x=>x.id===d.id);
    ui.group.textContent=g.name;ui.count.textContent=(i+1)+' / '+g.sheets.length;
    ui.select.replaceChildren(...g.sheets.map(x=>new Option(sheetName(x),x.id)));
    ui.select.value=d.id;ui.prev.disabled=i<=0;ui.next.disabled=i<0||i>=g.sheets.length-1;
    $('drawingNameView').textContent=g.name+' / '+sheetName(d);
    $('headerTitle').textContent=p.name+' / '+g.name+' / '+sheetName(d);
    const replace=$('fileInput')?.previousElementSibling;
    if(replace?.getAttribute('for')==='fileInput')replace.textContent='このシートを差し替え';
  }


  function showActionError(err){
    console.error('Sheet management',err);
    alert(err?.message||String(err));
  }
  async function saveSheetChange(transform){
    if(typeof S.archiveAtomic!=='function')throw Error('安全な保存機能を読み込めません。画面を更新してください。');
    await S.settled();S.assertSafe();
    const raw=S.getItem(WORKSPACE_KEY);
    if(typeof raw!=='string')throw Error('案件一覧の保存記録を確認できません。');
    const old=JSON.parse(raw),next=transform(old);
    // Only metadata is written. Original PDFs, damage records and photo Blobs are untouched.
    await S.archiveAtomic({writes:[[WORKSPACE_KEY,JSON.stringify(next)]],deleteFiles:[],expectedWorkspace:raw});
    workspace=next;
    return next;
  }
  function sheetStats(id){
    try{
      const st=JSON.parse(S.getItem(drawingStorageKey(id))||'null');
      const records=st?.shapes||[];
      return {records:records.length,photos:records.reduce((n,s)=>n+(s.photos?.length||0),0)};
    }catch{return {records:0,photos:0};}
  }
  async function renameSheet(projectId,drawingId){
    if(!projectId||!drawingId)return;
    const p=getProject(projectId),d=p?.drawings?.find(x=>x.id===drawingId);
    if(!d||isTrashed(d))throw Error('シートが見つかりません。');
    const value=prompt('この図面No.内のシート名を変更してください。',sheetName(d));
    if(value===null)return;
    const clean=String(value).trim().replace(/\s+/g,' ');
    if(clean===sheetName(d))return;
    if(currentView==='editor'&&activeDrawingId===drawingId)persist();
    await saveSheetChange(ws=>renameSheetInWorkspace(ws,projectId,drawingId,clean));
    if(currentView==='editor'&&activeDrawingId===drawingId)updateSheetUi();
    else if(currentView==='drawings')renderDrawings();
  }
  async function trashSheet(projectId,drawingId){
    if(!projectId||!drawingId)return;
    const p=getProject(projectId),d=p?.drawings?.find(x=>x.id===drawingId);
    if(!d||isTrashed(d))throw Error('シートが見つかりません。');
    const s=sheetStats(drawingId);
    const msg='シート「'+sheetName(d)+'」を削除しますか？\n\n'+
      'このシートだけ図面一覧から外します。\n'+
      '変状・調査記録 '+s.records+'件 / 写真 '+s.photos+'枚\n\n'+
      'PDF・写真・記録の実データは消去しません。\n図面一覧の「ごみ箱」から復元できます。\n'+
      '削除状態も他端末への同期対象です。';
    if(!confirm(msg))return;
    if(currentView==='editor'&&activeDrawingId===drawingId)persist();
    await saveSheetChange(ws=>trashSheetInWorkspace(ws,projectId,drawingId));
    if(currentView==='editor'&&activeDrawingId===drawingId){
      // Avoid showDrawings() persisting the now-trashed editor a second time.
      activeDrawingId=null;showDrawings(projectId);
      $('sidebar')?.classList.remove('open');
    }else if(currentView==='drawings')renderDrawings();
  }
  async function restoreSheet(projectId,drawingId){
    await saveSheetChange(ws=>restoreSheetInWorkspace(ws,projectId,drawingId));
    if(currentView==='drawings'&&activeProjectId===projectId)renderDrawings();
    refreshTrashModal();
  }
  let trashModal=null;
  function closeTrashModal(){trashModal?.remove();trashModal=null;}
  function refreshTrashModal(){
    if(!trashModal)return;
    const list=trashModal.querySelector('.sl-sheet-trash-list'),p=getProject();
    const items=trashedSheetsForProject(p);
    list.replaceChildren();
    if(!items.length){
      const empty=document.createElement('p');empty.textContent='ごみ箱は空です。';list.append(empty);
    }
    for(const d of items){
      const row=document.createElement('div');row.className='sl-sheet-trash-row';
      const info=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('span');
      title.textContent=sheetName(d);
      detail.textContent=groupName(d)+' / 削除 '+nowText(d.deletedAt)+' / 記録 '+(d.shapeCount||0)+'件・写真 '+(d.photoCount||0)+'枚';
      info.append(title,detail);
      const btn=document.createElement('button');btn.type='button';btn.textContent='復元';btn.onclick=async()=>{
        btn.disabled=true;try{await restoreSheet(p.id,d.id);}catch(e){showActionError(e);btn.disabled=false;}
      };
      row.append(info,btn);list.append(row);
    }
    installTrashButton();
  }
  function openTrashModal(){
    closeTrashModal();
    trashModal=document.createElement('div');trashModal.className='modal-backdrop open sl-sheet-trash-modal';
    trashModal.setAttribute('role','dialog');trashModal.setAttribute('aria-modal','true');
    const card=document.createElement('div');card.className='modal-card';
    const heading=document.createElement('div');heading.className='modal-title';
    const title=document.createElement('h2');title.textContent='図面・シートのごみ箱';
    const close=document.createElement('button');close.type='button';close.textContent='閉じる';close.onclick=closeTrashModal;
    heading.append(title,close);
    const note=document.createElement('p');note.className='meta';
    note.textContent='PDF、記録、写真は削除されず、元の図面IDのまま復元されます。';
    const list=document.createElement('div');list.className='sl-sheet-trash-list';
    card.append(heading,note,list);trashModal.append(card);
    trashModal.onclick=e=>{if(e.target===trashModal)closeTrashModal();};
    if(!$('slSheetTrashStyle')){
      const style=document.createElement('style');style.id='slSheetTrashStyle';
      style.textContent='.sl-sheet-trash-modal{z-index:75}.sl-sheet-trash-list{display:grid;gap:8px;margin-top:10px;max-height:60vh;overflow:auto}.sl-sheet-trash-row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:10px;border:1px solid #e5e7eb;border-radius:9px}.sl-sheet-trash-row>div{min-width:0;display:grid;gap:4px}.sl-sheet-trash-row strong{font-size:13px;overflow-wrap:anywhere}.sl-sheet-trash-row span{font-size:11px;color:#6b7280;line-height:1.5}.sl-sheet-trash-row button{flex:0 0 auto;min-height:42px}';
      document.head.append(style);
    }
    document.body.append(trashModal);refreshTrashModal();
  }
  function installTrashButton(){
    const bar=$('drawingsView')?.querySelector('.manager-subbar'),p=getProject();
    if(!bar||!p)return;
    let btn=$('sentlogSheetTrashOpen');
    if(!btn){btn=document.createElement('button');btn.id='sentlogSheetTrashOpen';btn.type='button';
      btn.className='small sl-sheet-trash-trigger';btn.onclick=openTrashModal;bar.append(btn);}
    const count=trashedSheetsForProject(p).length;
    btn.textContent='ごみ箱'+(count?' ('+count+')':'');
  }

  async function renameGroup(projectId,targetGroupId){
    const raw=S.getItem(WORKSPACE_KEY),ws=JSON.parse(raw||'{"projects":[]}'),p=ws.projects.find(x=>x.id===projectId);
    const g=groupsForProject(p).find(x=>x.id===targetGroupId);if(!g)throw Error('図面No.が見つかりません。');
    const value=prompt('図面No.名を変更してください。',g.name);if(value===null)return;
    const next=renameGroupInWorkspace(ws,projectId,targetGroupId,value,Date.now());
    if(typeof S.archiveAtomic!=='function')throw Error('安全な更新機能を読み込めません。');
    await S.archiveAtomic({writes:[[WORKSPACE_KEY,JSON.stringify(next)]],deleteFiles:[],expectedWorkspace:raw});
    workspace=next;renderDrawings();updateSheetUi();
  }

  async function deleteGroup(projectId,targetGroupId){
    const p=getProject(projectId),g=groupsForProject(p).find(x=>x.id===targetGroupId);
    if(!g)throw Error('図面No.が見つかりません。');
    const count=g.sheets.length;
    if(!confirm('図面No.「'+g.name+'」の '+count+'シートを削除しますか？\n\n'+
      'PDF・損傷記録・写真は消去しません。\n図面一覧の「ごみ箱」から1シートずつ復元できます。'))return;
    await saveSheetChange(ws=>trashGroupInWorkspace(ws,projectId,targetGroupId));
    renderDrawings();
  }

  function actionButton(text,kind,fn){
    const b=document.createElement('button');b.type='button';b.textContent=text;b.className=kind;
    b.onpointerdown=e=>e.stopPropagation();
    b.onclick=async e=>{e.preventDefault();e.stopPropagation();b.disabled=true;try{await fn();}catch(err){console.error(err);alert(err?.message||String(err));b.disabled=false;}};
    b.onkeydown=e=>e.stopPropagation();return b;
  }

  function renderGroupedDrawings(){
    normalized();
    const p=getProject();if(!p){showProjects();return;}
    const groups=groupsForProject(p).sort((a,b)=>b.updatedAt-a.updatedAt);
    $('drawingProjectTitle').textContent=p.name;
    $('drawingProjectSummary').textContent=p.name+'　図面No. '+groups.length+'件 / シート '+groups.reduce((n,g)=>n+g.sheets.length,0)+'枚';
    const grid=$('drawingsGrid');grid.innerHTML='';$('drawingsEmpty').classList.toggle('hidden',groups.length>0);
    installTrashButton();
    for(const g of groups){
      const sheets=g.sheets,first=sheets[0];
      const card=document.createElement('div');card.className='manager-card';card.tabIndex=0;card.dataset.drawingGroupId=g.id;
      const thumb=document.createElement('div');thumb.className='manager-drawing-thumb';thumb.textContent=sheets.some(d=>d.sourceType==='image')?'🗂️':'📑';
      const title=document.createElement('div');title.className='manager-card-title';title.textContent=g.name;
      const names=document.createElement('div');names.className='drawing-group-sheets';
      names.textContent=sheets.length+'シート：'+sheets.slice(0,4).map(sheetName).join(' / ')+(sheets.length>4?' ほか':'');
      const shapes=sheets.reduce((n,d)=>n+(Number(d.shapeCount)||0),0),photos=sheets.reduce((n,d)=>n+(Number(d.photoCount)||0),0);
      const bottom=document.createElement('div');bottom.className='manager-card-bottom';
      const badge=document.createElement('span');badge.className='manager-badge';badge.textContent='変状 '+shapes+'件 / 写真 '+photos+'枚';
      const updated=document.createElement('span');updated.className='manager-card-meta';updated.textContent=g.updatedAt?nowText(g.updatedAt):'';
      bottom.append(badge,updated);
      const actions=document.createElement('div');actions.className='drawing-group-actions';
      actions.append(actionButton('名前変更','rename',()=>renameGroup(p.id,g.id)),actionButton('削除','delete',()=>deleteGroup(p.id,g.id)));
      card.append(thumb,title,names,bottom,actions);
      card.onclick=()=>openDrawing(p.id,first.id);
      card.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&!e.target.closest('button'))card.click();};
      grid.appendChild(card);
    }
  }

  function updateProjectCounts(){
    const items=[...(workspace.projects||[])].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    const cards=[...$('projectsGrid')?.children||[]].filter(x=>x.classList?.contains('manager-card'));
    cards.forEach((card,i)=>{
      const p=items[i],meta=card.querySelector('.manager-card-meta');if(!p||!meta)return;
      const groups=groupsForProject(p);
      meta.textContent='図面No. '+groups.length+'件 / シート '+groups.reduce((n,g)=>n+g.sheets.length,0)+'枚'+(p.updatedAt?' / 更新 '+nowText(p.updatedAt):'');
    });
  }

  const oldRenderProjects=renderProjects;
  renderProjects=function(){normalized();const r=oldRenderProjects.apply(this,arguments);updateProjectCounts();return r;};
  renderDrawings=renderGroupedDrawings;

  const oldShowEditor=showEditor;
  showEditor=function(){const r=oldShowEditor.apply(this,arguments);updateSheetUi();return r;};

  const oldOpenDrawing=openDrawing;
  openDrawing=async function(){const r=await oldOpenDrawing.apply(this,arguments);updateSheetUi();return r;};

  // Replace v1.70's editor button so it means "add another sheet to this drawing number".
  function installAddBehavior(){
    const old=$('editorDrawingAddBtn'),addInput=$('drawingAddInput');if(!old||!addInput)return;
    const btn=old.cloneNode(true);old.replaceWith(btn);
    btn.textContent='＋ この図面No.に追加';btn.setAttribute('aria-label','現在の図面No.にシートを追加');
    btn.title='現在の図面No.の中に、別のPDFまたは画像を追加します';
    btn.onclick=()=>{
      if(currentView!=='editor'||!activeDrawingId)return;
      normalized();const d=currentDrawing();if(!d)return;
      persist();pendingGroupId=groupId(d);addInput.click();
    };
    const listAdd=$('drawingsView')?.querySelector('label[for="drawingAddInput"]');
    if(listAdd){listAdd.textContent='＋ 新しい図面No.';listAdd.addEventListener('click',()=>{pendingGroupId=null;},true);}
  }

  createDrawingFromFile=async function(file){
    const p=getProject();if(!p||!file)return;normalized();
    const base=(file.name||'図面').replace(/\.[^.]+$/,'')||'図面',target=pendingGroupId;pendingGroupId=null;
    const now=Date.now(),id=uid();let d;
    if(target){
      const g=groupsForProject(p).find(x=>x.id===target);if(!g)throw Error('追加先の図面No.が見つかりません。');
      const name=(prompt('この図面No.内のシート名を入力してください。',base)||'').trim();if(!name)return;
      d={id,name,sheetName:name,groupId:g.id,groupName:g.name,sheetOrder:nextSheetOrder(p,g.id),
        fileName:file.name||'',sourceType:(file.type==='application/pdf'||/\.pdf$/i.test(file.name||''))?'pdf':'image',
        pageCount:1,shapeCount:0,photoCount:0,createdAt:now,updatedAt:now};
    }else{
      const gname=(prompt('図面No.名を入力してください。',base)||'').trim();if(!gname)return;
      d={id,name:base,sheetName:base,groupId:id,groupName:gname,sheetOrder:1,
        fileName:file.name||'',sourceType:(file.type==='application/pdf'||/\.pdf$/i.test(file.name||''))?'pdf':'image',
        pageCount:1,shapeCount:0,photoCount:0,createdAt:now,updatedAt:now};
    }
    p.drawings.push(d);p.updatedAt=now;saveWorkspace();
    activeDrawingId=d.id;state=freshDrawingState(p.name);state.fileName=file.name||'';
    clearAllHistory();selected=null;drawing=null;pdfDoc=null;showEditor();
    await saveBackgroundFile(file,d.id);await openFile(file,false);persist();updateSheetUi();
  };

  installAddBehavior();
  const ready=Promise.resolve(root.sentlogAppReady).catch(()=>{});
  ready.then(()=>{const changed=normalized();installAddBehavior();installSheetUi();if(currentView==='drawings')renderDrawings();else if(currentView==='projects'){renderProjects();}else if(currentView==='editor')updateSheetUi();if(changed)root.SentlogOriginalPhotos?.refreshUI?.();});

  root.SentlogDrawingGroups={...pure,render:renderGroupedDrawings,updateSheetUi,renameGroup,deleteGroup,renameSheet,trashSheet,restoreSheet,openTrashModal};
})(typeof globalThis!=='undefined'?globalThis:this);

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
  function sortSheets(items){
    return [...(items||[])].sort((a,b)=>(Number(a.sheetOrder)||999999)-(Number(b.sheetOrder)||999999)||
      (Number(a.createdAt)||0)-(Number(b.createdAt)||0)||String(a.id).localeCompare(String(b.id)));
  }
  function groupsForProject(project){
    const map=new Map();
    for(const d of project?.drawings||[]){
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
    renameGroupInWorkspace,removeGroupFromWorkspace,nextSheetOrder,filesForDrawingIds};
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
      '<div class="sheet-nav-row"><button type="button" data-role="prev">◀ 前</button><button type="button" data-role="next">次 ▶</button></div>';
    const anchor=$('editorDrawingAddBtn')||$('fileInput')?.previousElementSibling;
    if(anchor&&anchor.parentElement===stack)stack.insertBefore(host,anchor);else stack.prepend(host);
    const select=host.querySelector('[data-role=select]'),prev=host.querySelector('[data-role=prev]'),next=host.querySelector('[data-role=next]');
    const go=async id=>{if(!id||id===activeDrawingId)return;if(activeDrawingId&&typeof persist==='function')persist();await openDrawing(activeProjectId,id);};
    select.onchange=()=>go(select.value);
    prev.onclick=()=>{const g=currentGroup();if(!g)return;const i=g.sheets.findIndex(d=>d.id===activeDrawingId);if(i>0)go(g.sheets[i-1].id);};
    next.onclick=()=>{const g=currentGroup();if(!g)return;const i=g.sheets.findIndex(d=>d.id===activeDrawingId);if(i>=0&&i<g.sheets.length-1)go(g.sheets[i+1].id);};
    const style=document.createElement('style');style.id='sentlogDrawingGroupsStyle';
    style.textContent='.sheet-nav{border:1px solid #d1d5db;border-radius:10px;padding:9px;background:#f8fafc;display:grid;gap:7px}.sheet-nav-head{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px}.sheet-nav-head strong{font-size:13px}.sheet-nav-head span{color:#6b7280}.sheet-nav label{margin:0}.sheet-nav select{margin-top:4px}.sheet-nav-row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.sheet-nav-row button{min-height:40px;padding:7px}.drawing-group-sheets{font-size:12px;color:#6b7280;line-height:1.5}.drawing-group-actions{display:flex;gap:7px;justify-content:flex-end;margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb}.drawing-group-actions button{width:auto!important;min-width:76px;min-height:40px;padding:7px 11px;border-radius:8px;font-size:12px}.drawing-group-actions .delete{color:#b91c1c;border-color:#fecaca;background:#fff}@media(max-width:480px){.sheet-nav-row button{min-height:44px}.drawing-group-actions button{min-height:44px;flex:1;min-width:0}.drawing-group-actions{gap:8px}}';
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
    const raw=S.getItem(WORKSPACE_KEY),ws=JSON.parse(raw||'{"projects":[]}'),p=ws.projects.find(x=>x.id===projectId);
    const g=groupsForProject(p).find(x=>x.id===targetGroupId);if(!g)throw Error('図面No.が見つかりません。');
    const ids=g.sheets.map(d=>d.id),originals=await originalStats(ids);
    let msg='「'+g.name+'」を図面No.ごと削除しますか？\n\n対象：'+g.sheets.length+'シート\n'+
      '各シートのPDF/画像、変状・調査記録、共有用写真を削除します。';
    if(originals.count){
      msg+='\n\n原本写真 '+originals.count+'枚は削除せず残します。';
      if(originals.unexportedCount)msg+='\n未書き出し '+originals.unexportedCount+'枚は設定の「原本写真」から後で書き出せます。';
    }
    msg+='\n\nこの操作は元に戻せません。';
    if(!confirm(msg))return;
    const allFiles=typeof getAllDBFiles==='function'?await getAllDBFiles():[],deleteFiles=filesForDrawingIds(allFiles,ids);
    const next=removeGroupFromWorkspace(ws,projectId,targetGroupId,Date.now());
    const writes=[[WORKSPACE_KEY,JSON.stringify(next)],...ids.map(id=>[drawingStorageKey(id),null])];
    if(typeof S.archiveAtomic!=='function')throw Error('安全な削除機能を読み込めません。');
    await S.archiveAtomic({writes,deleteFiles,expectedWorkspace:raw});
    workspace=next;if(ids.includes(activeDrawingId))activeDrawingId=null;
    renderDrawings();root.SentlogOriginalPhotos?.refreshUI?.();
    alert('図面No.「'+g.name+'」を削除しました。\n'+g.sheets.length+'シート'+
      (deleteFiles.length?' / '+deleteFiles.length+'ファイル（約'+bytes(deleteFiles.reduce((n,f)=>n+f.size,0))+'）':'')+
      (originals.count?'\n原本写真 '+originals.count+'枚は残しています。':''));
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
    $('drawingProjectSummary').textContent=p.name+'　図面No. '+groups.length+'件 / シート '+(p.drawings?.length||0)+'枚';
    const grid=$('drawingsGrid');grid.innerHTML='';$('drawingsEmpty').classList.toggle('hidden',groups.length>0);
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
      meta.textContent='図面No. '+groups.length+'件 / シート '+(p.drawings?.length||0)+'枚'+(p.updatedAt?' / 更新 '+nowText(p.updatedAt):'');
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

  root.SentlogDrawingGroups={...pure,render:renderGroupedDrawings,updateSheetUi,renameGroup,deleteGroup};
})(typeof globalThis!=='undefined'?globalThis:this);

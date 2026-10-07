/* v1.23: apply synchronization in place, never navigate away from the user's work. */
(function () {
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const read=id=>{try{return JSON.parse(localStorage.getItem(drawingStorageKey(id))||'null');}catch(_){return null;}};
  function content(value){
    if(!value)return value;
    const result={...value};
    // View state belongs to each device, not the shared annotations.
    for(const key of ['currentPage','width','height','pdfPageInfo'])delete result[key];
    return result;
  }
  function canonical(value){
    if(Array.isArray(value))return value.map(canonical);
    if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
    return value;
  }
  function snapshotText(payload){
    const p=clone(payload||{});
    if(p.project){delete p.project.updatedAt;for(const d of p.project.drawings||[])delete d.updatedAt;}
    for(const d of p.drawings||[]){if(d.meta)delete d.meta.updatedAt;if(d.state)d.state=content(d.state);}
    return JSON.stringify(canonical(p));
  }
  const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  let localOperation=0;
  // Do not let an incoming update change the selected shape while a photo is processing.
  const oldPhotos=addPhotosToSelected;
  addPhotosToSelected=async function(){localOperation++;try{return await oldPhotos.apply(this,arguments);}finally{localOperation--;}};
  // Page viewing alone should not create a shared edit or a synchronization loop.
  const oldPersist=persist;
  persist=function(){
    const before=activeDrawingId?read(activeDrawingId):null;
    const p=getProject(),d=getDrawingMeta();
    const unchanged=before && same(content(before),content(state));
    const pt=p?.updatedAt,dt=d?.updatedAt;
    const result=oldPersist.apply(this,arguments);
    if(unchanged && p && d){p.updatedAt=pt;d.updatedAt=dt;saveWorkspace();}
    return result;
  };
  function busy(){
    if(document.hidden || localOperation || drawing || panStart || labelDrag || activeTouches.size)return true;
    if(loading.style.display==='grid')return true;
    const focus=document.activeElement;
    if(focus && focus.matches('input,select,textarea,[contenteditable="true"]'))return true;
    if(document.querySelector('.modal-backdrop.open,.photo-viewer.open'))return true;
    const s=state.shapes.find(x=>x.id===selected);
    if(s){
      const expected={damageType:s.type||'腐食',damageNo:s.no||'',member:s.member||'',memo:s.memo||'',lineWidth:String(s.strokeWidth||1.2)};
      if(Object.entries(expected).some(([id,v])=>$(id) && $(id).value!==v))return true;
    }
    return false;
  }
  function localView(incoming,old){
    if(!incoming || !old)return incoming;
    return {...incoming,currentPage:Math.min(Math.max(1,old.currentPage||1),incoming.pageCount||1),
      width:old.width,height:old.height,pdfPageInfo:{...(incoming.pdfPageInfo||{}),...(old.pdfPageInfo||{})}};
  }
  function commit(cloudProject,snapshot,expectedLocal){
    const remote=snapshot?.payload?.project;
    if(!remote || remote.id && remote.id!==cloudProject.client_key)return {applied:false,reason:'invalid'};
    const id=cloudProject.client_key;
    // Read again immediately before a synchronous commit; network awaits may span local edits.
    let ws;try{ws=JSON.parse(localStorage.getItem(WORKSPACE_KEY)||'{"projects":[]}');}catch(_){return {applied:false,reason:'storage'};}
    const oldProject=ws.projects.find(p=>p.id===id);
    if(JSON.stringify(oldProject||null)!==expectedLocal)return {applied:false,reason:'local-edit'};
    const active=currentView==='editor' && activeProjectId===id;
    const incoming=(snapshot.payload.drawings||[]).find(d=>(d.meta?.id||d.state?.id)===activeDrawingId)?.state;
    if(active){
      if(busy())return {applied:false,reason:'editing'};
      // Replacing the viewed PDF/rotating its coordinate frame should wait until it is closed.
      if(!incoming || (incoming.pageCount||1)<state.currentPage || !(remote.drawings||[]).some(d=>d.id===activeDrawingId))return {applied:false,reason:'close-drawing'};
      if(incoming.sourceType!==state.sourceType || incoming.fileName!==state.fileName ||
        (incoming.pageRotations?.[String(state.currentPage)]||0)!==(state.pageRotations?.[String(state.currentPage)]||0))
        return {applied:false,reason:'close-drawing'};
    }
    const project=clone(remote);project.id=id;project.drawings=project.drawings||[];
    const index=ws.projects.findIndex(p=>p.id===id);
    if(index<0)ws.projects.push(project);else ws.projects[index]=project;
    const writes=new Map(),oldValues=new Map(),remoteIds=new Set();
    for(const d of snapshot.payload.drawings||[]){
      const did=d.meta?.id||d.state?.id;if(!did)continue;remoteIds.add(did);
      if(d.state)writes.set(drawingStorageKey(did),JSON.stringify(localView(d.state,read(did))));
    }
    for(const d of oldProject?.drawings||[])if(!remoteIds.has(d.id))writes.set(drawingStorageKey(d.id),null);
    writes.set(WORKSPACE_KEY,JSON.stringify(ws));
    try{
      for(const [key,value] of writes){oldValues.set(key,localStorage.getItem(key));if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}
    }catch(error){
      for(const [key,value] of oldValues){try{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}catch(_){}}
      throw error;
    }
    // Update the application's in-memory model as well as storage, without initApp/openDrawing.
    workspace=ws;
    if(active && incoming){
      const changed=!same(content(state),content(incoming));
      if(changed){
        const keep={page:state.currentPage,width:state.width,height:state.height,selection:selected};
        const inspectorOpen=$('inspector').classList.contains('open');
        state={...freshDrawingState(project.name),...clone(incoming),currentPage:keep.page,width:keep.width,height:keep.height,
          pdfPageInfo:{...(incoming.pdfPageInfo||{}),...(state.pdfPageInfo||{})}};
        // No fit(), scale assignment, PDF reload, or navigation here.
        clearAllHistory();
        if(keep.selection && state.shapes.some(s=>s.id===keep.selection))selectShape(keep.selection);
        else {selected=null;clearSelection();}
        $('inspector').classList.toggle('open',inspectorOpen);
        updatePageUI();render();renderSelectedPhotos();
      }
      $('headerTitle').textContent=project.name+' / '+(getDrawingMeta()?.name||'図面');
      $('projectNameView').textContent=project.name;
      $('drawingNameView').textContent=getDrawingMeta()?.name||'図面';
    }else if(currentView==='projects'){
      const host=$('projectsView'),scroll=host.scrollTop;renderProjects();host.scrollTop=scroll;
    }else if(currentView==='drawings'){
      const host=$('drawingsView'),scroll=host.scrollTop;renderDrawings();host.scrollTop=scroll;
    }
    return {applied:true};
  }
  window.sentlogSyncView={snapshotText,commit,
    canReplaceDrawing:id=>!(currentView==='editor' && activeDrawingId===id && state.sourceType && empty.style.display==='none'),
    photoReceived(id){if(currentView==='editor' && activeDrawingId===id)renderSelectedPhotos();},
    async fileReceived(id,file){
      if(currentView==='editor' && activeDrawingId===id && empty.style.display!=='none' && !busy())await window.sentlogRestoreDrawingView?.(id,file);
    }
  };
})();

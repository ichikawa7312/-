/* Restore only this tab's interrupted camera destination, without reopening its camera. */
(function(root){
  'use strict';
  const KEY='sentlogCameraReturnV1',VERSION=1,MAX_AGE_MS=12*60*60*1000;
  const SESSION='sentlogCloudSessionV1',WORKSPACE='surveyFieldNoteWorkspaceV1',DRAWING='surveyFieldNoteDrawingV1:';
  const id=value=>typeof value==='string'&&value.length>0&&value.length<=512;
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  function sessionOwner(raw){
    try{
      if(raw===null)return {known:true,id:''};
      const value=JSON.parse(raw);if(value===null)return {known:true,id:''};
      return id(value?.user?.id)?{known:true,id:value.user.id}:{known:false};
    }catch(_){return {known:false};}
  }
  function ownerTransition(oldRaw,newRaw){
    const before=sessionOwner(oldRaw),after=sessionOwner(newRaw);
    return !before.known||!after.known||!before.id||!after.id||before.id!==after.id;
  }
  function checkpoint(value,now=Date.now()){
    if(!value||value.version!==VERSION||!['projectId','drawingId','recordId'].every(k=>id(value[k]))||
       typeof value.ownerId!=='string'||value.ownerId.length>512||!finite(value.savedAt)||
       value.savedAt>now+60000||now-value.savedAt>MAX_AGE_MS||
       !Number.isSafeInteger(value.page)||value.page<1)return null;
    const out={version:VERSION,projectId:value.projectId,drawingId:value.drawingId,recordId:value.recordId,
      ownerId:value.ownerId,page:value.page,savedAt:value.savedAt,inspectorOpen:value.inspectorOpen===true};
    const v=value.viewport;
    if(v&&['scale','x','y','width','height','stageWidth','stageHeight'].every(k=>finite(v[k]))&&
       v.scale>=.05&&v.scale<=8&&v.width>0&&v.height>0&&v.stageWidth>0&&v.stageHeight>0&&
       Math.abs(v.x)<=1e7&&Math.abs(v.y)<=1e7)
      out.viewport=Object.fromEntries(['scale','x','y','width','height','stageWidth','stageHeight'].map(k=>[k,v[k]]));
    return out;
  }
  function targetAvailable(saved,{workspace,drawing,archive,model}={}){
    const project=workspace?.projects?.find(p=>p.id===saved.projectId);
    const meta=project?.drawings?.find(d=>d.id===saved.drawingId);
    const record=drawing?.shapes?.find(r=>r.id===saved.recordId);
    if(!project||Number(project.deletedAt)>0||!meta||Number(meta.deletedAt)>0||!record||
       Number(record.deletedAt)>0||record.deleted===true||model?.isDeleted?.(record)||
       (archive&&(archive.status!=='active'||archive.checking||archive.retired))||
       Number(record.page||1)!==saved.page||saved.page>Number(drawing.pageCount||1)||
       drawing.pageStates?.[String(saved.page)]?.hidden===true)return null;
    return {project,meta,record};
  }
  // No drawing/photo writes belong here. Adapters only open an existing view.
  function createController(options){
    const now=options.now||Date.now;
    let epoch=0,restoring=false,flight=null,observedOwner=options.owner();
    const claims=new WeakSet();
    function remove(){try{options.storage.removeItem(KEY);}catch(_){}}
    function cancel(){epoch++;restoring=false;remove();}
    function read(){
      try{
        const raw=options.storage.getItem(KEY);if(raw===null)return null;
        const saved=checkpoint(JSON.parse(raw),now());if(!saved)remove();return saved;
      }catch(_){return null;}
    }
    function remember(value){
      const owner=options.owner();epoch++;restoring=false;
      if(!owner.known){remove();return false;}
      observedOwner=owner;
      const saved=checkpoint({...value,version:VERSION,ownerId:owner.id,savedAt:now()},now());
      if(!saved){remove();return false;}
      try{options.storage.setItem(KEY,JSON.stringify(saved));return true;}
      catch(_){remove();return false;}
    }
    function accountChanged(next){
      const owner=next===undefined?options.owner():{known:true,id:next};
      if(owner.known&&observedOwner.known&&owner.id!==observedOwner.id)cancel();
      observedOwner=owner;
    }
    async function restore(){
      if(flight)return flight;
      const task=(async()=>{
        const saved=read();if(!saved)return {restored:false,reason:'no-checkpoint'};
        const owner=options.owner();if(!owner.known)return {restored:false,reason:'owner-unavailable'};
        observedOwner=owner;
        if(owner.id!==saved.ownerId||!options.canBegin()||!options.target(saved)){
          cancel();return {restored:false,reason:'unavailable'};
        }
        const start=epoch;
        const current=()=>{const owner=options.owner();return epoch===start&&owner.known&&owner.id===saved.ownerId;};
        const stopped=reason=>{if(epoch===start)cancel();return {restored:false,reason};};
        const claim={current};claims.add(claim);restoring=true;
        try{
          await options.open(saved,claim);
          if(!current()||!options.sameDrawing(saved)||!options.target(saved))return stopped('cancelled');
          if(options.page()!==saved.page){
            await options.showPage(saved,claim);
            if(!current()||!options.sameDrawing(saved)||!options.target(saved))return stopped('cancelled');
          }
          // Hidden/replaced PDF pages may be redirected by page management.
          if(options.page()!==saved.page)return stopped('page-changed');
          if(options.select(saved,claim)===false)return stopped('selection-unavailable');
          if(!current()||!options.sameDrawing(saved)||options.page()!==saved.page)return stopped('cancelled');
          options.applyView?.(saved,claim);
          return {restored:true};
        }catch(error){return stopped('open-failed');}
        finally{restoring=false;}
      })();
      flight=task;try{return await task;}finally{flight=null;}
    }
    return {remember,read,cancel,accountChanged,restore,owns:claim=>!!claim&&claims.has(claim),
      get restoring(){return restoring;}};
  }
  const pure={KEY,VERSION,MAX_AGE_MS,checkpoint,targetAvailable,createController,sessionOwner,ownerTransition};
  if(typeof module==='object'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogCameraReturn)return;

  function owner(){
    try{return sessionOwner(localStorage.getItem(SESSION));}catch(_){return {known:false};}
  }
  const storage={getItem:key=>root.sessionStorage.getItem(key),setItem:(key,value)=>root.sessionStorage.setItem(key,value),
    removeItem:key=>root.sessionStorage.removeItem(key)};
  const sameDrawing=saved=>typeof currentView!=='undefined'&&currentView==='editor'&&
    activeProjectId===saved.projectId&&activeDrawingId===saved.drawingId;
  function available(saved){
    try{
      const ws=JSON.parse(root.SentlogRecords.getItem(WORKSPACE)||'null');
      const drawing=JSON.parse(root.SentlogRecords.getItem(DRAWING+saved.drawingId)||'null');
      const controls=JSON.parse(localStorage.getItem('sentlogArchiveControlV1:'+saved.ownerId)||'[]');
      const stored=Array.isArray(controls)?controls.find(c=>c.client_key===saved.projectId):null;
      const live=root.SentlogArchive?.byLocal?.(saved.projectId);
      // Both the current UI and its owner-scoped saved control must allow it.
      for(const archive of [stored,live])if(archive&&(archive.status!=='active'||archive.checking||archive.retired))return null;
      return targetAvailable(saved,{workspace:ws,drawing,model:root.SentlogRecordCollaboration});
    }catch(_){return null;}
  }
  let ownNavigation=0,installed=false,lateInstalled=false;
  function own(callback){ownNavigation++;try{return callback();}finally{ownNavigation--;}}
  const controller=createController({storage,owner,
    canBegin:()=>typeof currentView!=='undefined'&&currentView==='projects'&&!activeProjectId&&!activeDrawingId,
    target:available,sameDrawing,page:()=>Number(state.currentPage||1),
    open:(saved,claim)=>root.openDrawing(saved.projectId,saved.drawingId,claim),
    showPage:(saved,claim)=>typeof renderPdfPage==='function'?renderPdfPage(saved.page,{persist:false,cameraReturnClaim:claim}):false,
    select:(saved,claim)=>own(()=>{
      if(!claim.current())return false;
      const record=state.shapes?.find(r=>r.id===saved.recordId);
      if(!record||Number(record.page||1)!==saved.page||record.deleted||Number(record.deletedAt)>0||
         root.SentlogRecordCollaboration?.isDeleted?.(record))return false;
      if(record.recordKind==='field-record'||record.kind==='field-record')root.SentlogFieldRecords?.selectRecord(saved.recordId);
      else root.selectShape(saved.recordId);
      return selected===saved.recordId;
    }),
    applyView:saved=>{
      const v=saved.viewport,stage=document.getElementById('stageWrap');
      if(v&&stage&&state.width===v.width&&state.height===v.height&&
         Math.abs(stage.clientWidth-v.stageWidth)<2&&Math.abs(stage.clientHeight-v.stageHeight)<2){
        scale=v.scale;tx=v.x;ty=v.y;if(typeof applyTransform==='function')applyTransform();
      }
      document.getElementById('inspector')?.classList.toggle('open',saved.inspectorOpen);
    }});
  function navigation(name,original){
    return function(...args){
      const claim=name==='openDrawing'?args[2]:null;
      if(controller.owns(claim)){if(!claim.current())return false;}
      else if(!ownNavigation){
        const saved=controller.read();
        const sameSelection=(name==='selectShape'||name==='selectRecord')&&saved&&sameDrawing(saved)&&
          args[0]===saved.recordId&&Number(state.currentPage||1)===saved.page;
        // Incoming sync legitimately reselects the current record. It must
        // not erase the camera checkpoint while repainting that same view.
        if(!sameSelection)controller.cancel();
      }
      return original.apply(this,args);
    };
  }
  function installNavigation(){
    if(installed)return;installed=true;
    for(const name of ['showProjects','showDrawings','openDrawing','createDrawingFromFile']){
      const original=root[name];if(typeof original==='function')root[name]=navigation(name,original);
    }
  }
  function installFinalNavigation(){
    if(lateInstalled)return;lateInstalled=true;
    // Outer fences act at the user's request, before an async sync-view gate.
    for(const name of ['showProjects','showDrawings','openDrawing','createDrawingFromFile','selectShape','clearSelection']){
      const original=root[name];if(typeof original==='function')root[name]=navigation(name,original);
    }
    const fields=root.SentlogFieldRecords;
    if(fields?.selectRecord)fields.selectRecord=navigation('selectRecord',fields.selectRecord);
    const page=root.renderPdfPage;
    if(typeof page==='function')root.renderPdfPage=function(number,options){
      const claim=options?.cameraReturnClaim;
      if(controller.owns(claim)){if(!claim.current())return false;}
      else if(options?.opening!==true&&!ownNavigation){
        const saved=controller.read();
        if(!saved||!sameDrawing(saved)||Number(number)!==saved.page)controller.cancel();
      }
      return page.apply(this,arguments);
    };
  }
  function beforeCapture(){
    if(typeof currentView==='undefined'||currentView!=='editor'||!activeDrawingId||!selected)return;
    // Use the existing IME/conflict-aware draft saver; never copy input fields
    // into records or serialize temporary gesture previews for this feature.
    root.SentlogCollaboration?.flushDraft?.();
    const saved=JSON.parse(root.SentlogRecords.getItem(DRAWING+activeDrawingId)||'null');
    if(state.shapes?.some(r=>r.id===selected)&&!saved?.shapes?.some(r=>r.id===selected)&&typeof persist==='function')persist();
  }
  function remember(target){
    try{
      if(!target||!sameDrawing(target)||selected!==target.recordId)return false;
      const account=owner();if(!account.known||account.id!==(target.ownerId||''))return false;
      const stage=document.getElementById('stageWrap');
      return controller.remember({...target,page:Number(state.currentPage||1),
        inspectorOpen:document.getElementById('inspector')?.classList.contains('open'),
        viewport:{scale,x:tx,y:ty,width:state.width,height:state.height,stageWidth:stage?.clientWidth,stageHeight:stage?.clientHeight}});
    }catch(_){return false;}
  }
  let startPromise=null,resolveReady;
  const readyPromise=new Promise(resolve=>{resolveReady=resolve;});
  function start(){
    if(startPromise)return startPromise;
    startPromise=Promise.resolve(root.sentlogAppReady).then(()=>{installFinalNavigation();return controller.restore();})
      .catch(()=>({restored:false,reason:'startup-failed'}));
    void startPromise.then(resolveReady);
    return startPromise;
  }
  root.SentlogCameraReturn={...pure,beforeCapture,remember,installNavigation,initialView:own,
    accountChanged:id=>controller.accountChanged(id),
    get ready(){return readyPromise;}};
  root.addEventListener('storage',event=>{
    // A logout/login in another tab must invalidate even an identical final ID.
    // Same-account token rotation is not a navigation/account boundary.
    if(event.key===null||event.key===SESSION&&ownerTransition(event.oldValue,event.newValue))controller.cancel();
  });
  root.addEventListener('focus',()=>controller.accountChanged());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)controller.accountChanged();});
  for(const type of ['pointerdown','keydown','input'])document.addEventListener(type,event=>{
    if(event.isTrusted&&controller.restoring)controller.cancel();
  },true);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>void start(),{once:true});
  else void start();
})(typeof window==='undefined'?globalThis:window);

/* Capture destinations survive native-camera round trips, redraws and retries. */
(function(root){
  'use strict';
  const VERSION=1,JOURNAL_KEY='sentlogPhotoCaptureIntentV1';
  const WORKSPACE='surveyFieldNoteWorkspaceV1',DRAWING='surveyFieldNoteDrawingV1:';
  const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const error=(code,message)=>Object.assign(Error(message),{code});
  const validTarget=t=>!!t&&['projectId','drawingId','recordId'].every(k=>typeof t[k]==='string'&&t[k]);
  const deleted=(record,model)=>!record||Number(record.deletedAt)>0||record.deleted===true||!!model?.isDeleted?.(record);
  const revisionOptions=entry=>({revisionId:'capture:'+entry.photoId,actor:entry.actor,at:entry.at});

  function addPhoto(record,photo,entry,model){
    if(deleted(record,model))throw error('TARGET_DELETED','追加先の記録が削除されています。写真は保存待ちに残しています。');
    if(model?.addPhoto)return model.addPhoto(record,photo,revisionOptions(entry));
    const next=clone(record);next.photos=next.photos||[];
    const previous=next.photos.find(p=>p.id===photo.id);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(photo))throw error('PHOTO_ID_CONFLICT','同じ写真IDに異なる登録内容があります。上書きせず保持しました。');
    if(!previous)next.photos.push(clone(photo));return next;
  }

  // Pure patch construction. Callers read the current records immediately
  // before this function and apply its result without an intervening await.
  function appendLatest(workspace,drawing,target,photo,entry,model,now=Date.now()){
    if(!validTarget(target))throw error('TARGET_UNKNOWN','写真の追加先を確認できません。記録を選んで関連付けてください。');
    const project=workspace?.projects?.find(p=>p.id===target.projectId);
    const meta=project?.drawings?.find(d=>d.id===target.drawingId&&!Number(d.deletedAt));
    if(!project||Number(project.deletedAt)||!meta||!drawing)
      throw error('TARGET_MISSING','追加先の案件・図面が見つかりません。写真は保存待ちに残しています。');
    const index=drawing.shapes?.findIndex(s=>s.id===target.recordId)??-1;
    if(index<0)throw error('TARGET_DELETED','追加先の記録が削除されています。写真は保存待ちに残しています。');
    const before=drawing.shapes[index],record=addPhoto(before,photo,entry,model);
    if(JSON.stringify(record)===JSON.stringify(before))return {workspace,drawing,record,changed:false};
    const nextDrawing=clone(drawing),nextWorkspace=clone(workspace);
    nextDrawing.shapes[index]=record;
    const nextProject=nextWorkspace.projects.find(p=>p.id===target.projectId);
    const nextMeta=nextProject.drawings.find(d=>d.id===target.drawingId);
    const stamp=Math.max(Number(now)||0,Number(nextProject.updatedAt||0)+1,Number(nextMeta.updatedAt||0)+1);
    nextMeta.shapeCount=nextDrawing.shapes.length;
    nextMeta.photoCount=nextDrawing.shapes.reduce((n,s)=>n+(s.photos?.length||0),0);
    nextMeta.updatedAt=stamp;nextProject.updatedAt=stamp;
    return {workspace:nextWorkspace,drawing:nextDrawing,record,changed:true};
  }

  function createService(options){
    const originals=options.originals,shared=options.shared,records=options.records;
    const uuid=options.uuid||(()=>crypto.randomUUID()),now=options.now||Date.now;
    let journal;try{journal=options.loadJournal();}catch(_){}
    if(journal?.version!==VERSION)journal={version:VERSION,inputs:{},operations:{},entries:{}};
    journal.inputs=journal.inputs||{};journal.operations=journal.operations||{};journal.entries=journal.entries||{};
    const files=new Map(),flights=new Map(),registrations=new Map();let queue=Promise.resolve();
    const changed=()=>options.onChange?.();
    function saveJournal(){
      try{options.saveJournal(clone(journal));return true;}
      catch(e){options.onJournalError?.(e);return false;}
    }
    function remember(entry){journal.entries[entry.photoId]=clone({...entry,updatedAt:now()});saveJournal();changed();}
    function forget(photoId){
      const entry=journal.entries[photoId];delete journal.entries[photoId];files.delete(photoId);
      if(entry){const op=journal.operations[entry.operationId];
        if(op&&!op.photoIds.some(id=>journal.entries[id]))delete journal.operations[entry.operationId];}
      saveJournal();changed();
    }
    function prepare(target,{inputId='programmatic',requireDurable=true}={}){
      if(target&&!validTarget(target))throw error('INVALID_TARGET','写真の追加先を確認できません');
      const previous=journal.operations[journal.inputs[inputId]];
      if(previous&&!previous.photoIds.length)delete journal.operations[previous.operationId];
      const intent={operationId:uuid(),inputId,target:clone(target),createdAt:now(),photoIds:[]};
      journal.operations[intent.operationId]=intent;
      if(inputId==='cameraInput'||inputId==='photoInput')journal.inputs[inputId]=intent.operationId;
      if(!saveJournal()&&requireDurable){delete journal.operations[intent.operationId];delete journal.inputs[inputId];
        throw error('INTENT_SAVE_FAILED','撮影先を保存できません。端末の保存領域を確認してから、もう一度開いてください。');}
      return clone(intent);
    }
    function consume(inputId){
      const id=journal.inputs[inputId],intent=journal.operations[id];
      delete journal.inputs[inputId];saveJournal();
      // A change without a real chooser intent must never use today's selection.
      return clone(intent)||prepare(null,{inputId:'unknown:'+inputId,requireDurable:false});
    }
    function cancel(inputId){
      const id=journal.inputs[inputId],intent=journal.operations[id];delete journal.inputs[inputId];
      if(intent&&!intent.photoIds.length)delete journal.operations[id];saveJournal();
    }
    function cancelCapture(intent){
      const id=intent?.operationId;
      if(typeof id!=='string'||!Object.prototype.hasOwnProperty.call(journal.operations,id))return false;
      const operation=journal.operations[id];
      // register() may be reading names before it allocates photo IDs. Once a
      // file has been submitted, only its normal save/retry path may own it.
      if(!operation||operation.photoIds.length||registrations.has(id)||
         Object.values(journal.entries).some(entry=>entry.operationId===id))return false;
      delete journal.operations[id];
      for(const inputId of Object.keys(journal.inputs))if(journal.inputs[inputId]===id)delete journal.inputs[inputId];
      saveJournal();return true;
    }
    const association=entry=>({...clone(entry),version:VERSION});
    function originalMetadata(entry){
      const t=entry.target||{};
      return {projectId:t.projectId||'',projectName:t.projectName||'_案件未設定',
        drawingName:t.drawingName||'_図面未設定',shapeId:t.recordId||'',shapeLabel:t.recordLabel||'_記録未設定',
        photoId:entry.photoId,exportName:entry.exportName,originalName:entry.originalName,
        createdAt:entry.at,photoAssociation:association(entry)};
    }
    function fromMeta(meta){
      const entry=meta?.photoAssociation;
      return entry?.version===VERSION&&entry.photoId===meta.photoId?
        {...clone(entry),storageDrawingId:meta.drawingId,originalSaved:true}:null;
    }
    async function hasSavedOriginal(entry){
      try{
        const [blob,metadata]=await Promise.all([
          originals.getOriginal(entry.storageDrawingId,entry.photoId),originals.listMeta()]);
        const meta=metadata.find(row=>row.drawingId===entry.storageDrawingId&&row.photoId===entry.photoId);
        const saved=fromMeta(meta);
        return blob instanceof Blob&&saved?.operationId===entry.operationId&&
          blob.size===Number(meta.size)&&blob.size===Number(entry.sourceSize)&&
          (blob.type||'')===(entry.sourceType||'');
      }catch(_){return false;}
    }
    async function refreshEntries(){
      const pending=new Map(Object.values(journal.entries).map(e=>[e.photoId,clone(e)]));
      let changed=false;
      for(const meta of await originals.listMeta()){
        const saved=meta?.photoAssociation;
        if(saved?.version===VERSION&&saved.photoId===meta.photoId&&saved.status==='attached'){
          pending.delete(meta.photoId);if(journal.entries[meta.photoId])forget(meta.photoId);continue;
        }
        const entry=fromMeta(meta);if(!entry)continue;
        if(entry.status==='attached'){pending.delete(entry.photoId);if(journal.entries[entry.photoId])forget(entry.photoId);}
        else {
          const local=journal.entries[entry.photoId];
          const recent=local&&local.operationId===entry.operationId&&local.updatedAt>Number(entry.updatedAt||0)?
            {...entry,lastError:local.lastError,errorCode:local.errorCode}:entry;
          pending.set(entry.photoId,recent);
          if(JSON.stringify(local)!==JSON.stringify(recent)){journal.entries[entry.photoId]=clone(recent);changed=true;}
        }
      }
      // Discovery must not broadcast an unchanged journal back to other tabs.
      // Otherwise storage-event discovery can keep two tabs waking each other.
      if(changed)saveJournal();return [...pending.values()].sort((a,b)=>a.at-b.at);
    }
    const pendingSnapshot=()=>Object.values(journal.entries).filter(e=>e.status!=='attached').map(clone).sort((a,b)=>a.at-b.at);
    async function stage(entry,file){
      const original=await originals.stageOriginal(entry.storageDrawingId,entry.photoId,file,originalMetadata(entry));
      const saved=fromMeta(original);if(!saved)throw error('STAGE_INVALID','保存した撮影操作を確認できません');
      remember(saved);files.delete(saved.photoId);return saved;
    }
    async function update(entry,values){
      const next={...entry,...values,updatedAt:now()};
      await originals.updatePhotoAssociation(next.storageDrawingId,next.photoId,association(next));
      remember(next);return next;
    }
    async function process(entry){
      let current=entry;
      try{
        if(!current.originalSaved){
          const file=files.get(current.photoId);
          if(!(file instanceof Blob))throw error('ORIGINAL_NOT_SAVED','元写真の保存が完了していません。元の写真を選び直してください。');
          current=await stage(current,file);
        }
        if(current.status==='attached'){forget(current.photoId);return {status:'attached',photoId:current.photoId,originalSaved:true};}
        if(!validTarget(current.target))throw error('TARGET_UNKNOWN','写真の追加先が未確認です。記録を選んで関連付けてください。');
        await records.checkTarget(current.target);
        let blob=await shared.get(current.photoId,current.target.drawingId);
        const existing=blob instanceof Blob;
        let photo=current.photo,blobHash;
        if(!photo||!existing){
          const original=await originals.getOriginal(current.storageDrawingId,current.photoId);
          if(!(original instanceof Blob))throw error('ORIGINAL_MISSING','保存済みの原本が見つかりません。保存領域を確認してください。');
          const prepared=await shared.make(original),sha256=await shared.digest(prepared);
          const name=prepared.type==='image/jpeg'&&/\.(heic|heif|png|webp)$/i.test(current.exportName)?
            current.exportName.replace(/\.[^.]+$/,'.jpg'):current.exportName;
          const expected={id:current.photoId,name,createdAt:current.at,type:prepared.type||'image/jpeg',size:prepared.size,sha256};
          if(photo&&JSON.stringify(photo)!==JSON.stringify(expected))
            throw error('SHARED_MISMATCH','再作成した確認用写真が保存記録と一致しません。原本を保持しています。');
          photo=photo||expected;
          if(!existing){blob=prepared;blobHash=sha256;}
        }
        // A generated Blob is immutable. Reuse its digest in this operation;
        // bytes read from persistent storage are still hashed independently.
        if(photo.id!==current.photoId||Number(photo.size)!==blob.size||photo.type!==(blob.type||'image/jpeg')||
          photo.sha256!==(blobHash===undefined?await shared.digest(blob):blobHash))
          throw error('SHARED_MISMATCH','保存済みの確認用写真が一致しません。上書きせず保持しました。');
        // Persist the expected bytes before the shared write. A crash in either
        // store can then retry this exact identity without trusting a stray blob.
        current=await update(current,{status:'prepared',photo,lastError:null,errorCode:null});
        if(!existing)await shared.put(current.photoId,blob,current.target.drawingId);
        const stored=await shared.get(current.photoId,current.target.drawingId);
        if(!(stored instanceof Blob)||stored.size!==photo.size||await shared.digest(stored)!==photo.sha256)
          throw error('SHARED_MISMATCH','確認用写真の保存を照合できません。原本を保持しています。');
        current=await update(current,{status:'shared',photo,lastError:null,errorCode:null});
        // The adapter reads latest records here, after every file/decode await.
        await records.attach(current.target,photo,current);
        current=await update(current,{status:'attached',attachedAt:now(),lastError:null,errorCode:null});
        forget(current.photoId);return {status:'attached',photoId:current.photoId,originalSaved:true};
      }catch(e){
        const originalSaved=await hasSavedOriginal(current);
        const pending={...current,status:'pending',originalSaved,updatedAt:now(),lastError:e?.message||String(e),errorCode:e?.code||'SAVE_FAILED'};
        if(pending.originalSaved){try{await originals.updatePhotoAssociation(pending.storageDrawingId,pending.photoId,association(pending));}catch(_){} }
        remember(pending);return {status:'pending',photoId:pending.photoId,originalSaved,error:pending.lastError};
      }
    }
    function enqueue(entry){
      if(flights.has(entry.photoId))return flights.get(entry.photoId);
      // Serialize image decodes across captures, avoiding multiple full-size
      // camera images in memory while keeping incoming record updates unlocked.
      const task=queue.then(()=>process(journal.entries[entry.photoId]||entry));
      queue=task.catch(()=>{});flights.set(entry.photoId,task);
      task.finally(()=>flights.delete(entry.photoId));return task;
    }
    async function registerFiles(fileList,intent){
      const incoming=Array.from(fileList||[]);if(!incoming.length)return [];
      if(!intent?.operationId)throw error('INTENT_REQUIRED','撮影操作が指定されていません');
      let op=journal.operations[intent.operationId];
      if(!op){
        const stored=(await originals.listMeta()).map(fromMeta).filter(e=>e?.operationId===intent.operationId).sort((a,b)=>a.index-b.index);
        if(stored.length===incoming.length&&stored.every(e=>e.status==='attached'))return stored.map(e=>({status:'attached',photoId:e.photoId,originalSaved:true}));
        if(!stored.length)throw error('INTENT_MISSING','撮影操作の保存記録が見つかりません');
        op={...clone(intent),photoIds:stored.map(e=>e.photoId)};journal.operations[op.operationId]=op;
        for(const entry of stored)journal.entries[entry.photoId]=entry;
      }
      if(op.photoIds.length&&op.photoIds.length!==incoming.length)
        throw error('CAPTURE_CHANGED','再試行する写真の枚数が元の操作と異なります');
      if(journal.inputs[op.inputId]===op.operationId)delete journal.inputs[op.inputId];
      const existingOriginals=op.photoIds.length?[]:await originals.listMeta(validTarget(op.target)?op.target.drawingId:undefined);
      // A duplicate callback may have allocated this operation during the read.
      if(op.photoIds.length&&op.photoIds.length!==incoming.length)
        throw error('CAPTURE_CHANGED','再試行する写真の枚数が元の操作と異なります');
      if(!op.photoIds.length){
        const names=new Set(op.target?.photoNames||[]);
        const sameTarget=target=>(!validTarget(target)&&!validTarget(op.target))||
          (target?.projectId===op.target?.projectId&&target?.drawingId===op.target?.drawingId&&target?.recordId===op.target?.recordId);
        for(const meta of existingOriginals){
          const target=meta.photoAssociation?.target||{projectId:meta.projectId,drawingId:meta.drawingId,recordId:meta.shapeId};
          if(sameTarget(target)&&meta.exportName)names.add(meta.exportName);
        }
        // Another operation may have reserved names while listMeta awaited.
        for(const entry of Object.values(journal.entries))if(sameTarget(entry.target))names.add(entry.exportName);
        for(const [index,file] of incoming.entries()){
          const photoId=uuid(),rawName=file.name||'写真.jpg';
          const exportName=options.uniqueName?options.uniqueName(rawName,names):rawName;names.add(exportName);
          let capturedActor=op.target?.actor;try{capturedActor=capturedActor||options.actor?.();}catch(_){}
          const target=clone(op.target);if(target)delete target.photoNames;
          const entry={version:VERSION,operationId:op.operationId,inputId:op.inputId,photoId,index,target,
            storageDrawingId:op.target?.drawingId||'unassigned-'+op.operationId,
            actor:clone(capturedActor||{deviceId:null,deviceName:'この端末'}),at:now(),exportName,originalName:rawName,
            sourceSize:file.size,sourceType:file.type||'',status:'received',originalSaved:false};
          op.photoIds.push(photoId);journal.entries[photoId]=entry;
        }
        if(op.target)delete op.target.photoNames;
        saveJournal();changed();
      }
      const staged=[];
      // Save all originals before waiting for conversion of a multi-file batch.
      for(let i=0;i<incoming.length;i++){
        const photoId=op.photoIds[i],entry=journal.entries[photoId];
        if(!entry)continue;files.set(photoId,incoming[i]);
        try{staged.push(await stage(entry,incoming[i]));}
        catch(e){remember({...entry,status:'pending',lastError:e.message||String(e),errorCode:'ORIGINAL_SAVE_FAILED'});staged.push(journal.entries[photoId]);}
      }
      return Promise.all(staged.map(enqueue));
    }
    async function register(fileList,intent){
      const id=intent?.operationId;
      if(id)registrations.set(id,(registrations.get(id)||0)+1);
      try{return await registerFiles(fileList,intent);}
      finally{if(id){const remaining=registrations.get(id)-1;
        if(remaining)registrations.set(id,remaining);else registrations.delete(id);}}
    }
    async function retryPending(photoId){
      const entries=(await refreshEntries()).filter(e=>!photoId||e.photoId===photoId);
      return Promise.all(entries.map(enqueue));
    }
    async function reassign(photoId,target){
      if(!validTarget(target))throw error('INVALID_TARGET','関連付ける記録を選んでください');
      if(flights.has(photoId))await flights.get(photoId);
      const current=(await refreshEntries()).find(e=>e.photoId===photoId);
      if(!current)throw error('PENDING_MISSING','この写真は保存待ちではありません');
      await records.checkTarget(target);
      const next={...current,target:clone(target),storageDrawingId:target.drawingId,status:'pending',
        photo:null,lastError:null,errorCode:null};
      if(current.originalSaved){
        const moved=await originals.rebindPendingOriginal(current.storageDrawingId,target.drawingId,photoId,originalMetadata(next));
        remember(fromMeta(moved));
      }else remember(next);
      return enqueue(journal.entries[photoId]);
    }
    async function supplyOriginal(photoId,file){
      const entry=(await refreshEntries()).find(e=>e.photoId===photoId);
      if(!entry||entry.originalSaved)throw error('ORIGINAL_PRESENT','原本が保存済みの写真は置き換えません');
      files.set(photoId,file);return enqueue(entry);
    }
    return {prepare,consume,cancel,cancelCapture,register,retryPending,listPending:refreshEntries,pendingSnapshot,reassign,supplyOriginal,
      get pendingCount(){return Object.keys(journal.entries).length;}};
  }

  const pure={VERSION,JOURNAL_KEY,validTarget,appendLatest,createService};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogCollaborationPhotos)return;
  const originals=root.SentlogOriginalPhotos;
  if(!originals?.stageOriginal||!root.SentlogRecords)throw Error('写真の保存機能の読み込み順序を確認してください');
  let committing=0,renderQueued=false,rendering=false,discoveryTimer=null,discoveryFlight=null,discoveryRequested=false;
  const pendingPanels=new Map();
  const currentOwner=()=>{try{return JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null')?.user?.id||'';}catch(_){return '';}};
  function actor(){
    const shared=root.SentlogCollaboration?.actor?.();if(shared)return clone(shared);
    let id=localStorage.getItem('sentlogCloudDeviceV1')||localStorage.getItem('sentlogPhotoLocalDeviceV1');
    if(!id){id=crypto.randomUUID();localStorage.setItem('sentlogPhotoLocalDeviceV1',id);}
    return {deviceId:id,deviceName:/iPhone/i.test(navigator.userAgent)?'iPhone':/iPad/i.test(navigator.userAgent)?'iPad':'この端末'};
  }
  function readTarget(target){
    const store=root.SentlogRecords;
    if(!validTarget(target))throw error('TARGET_UNKNOWN','写真の追加先を確認できません');
    if((target.ownerId||'')!==currentOwner())throw error('ACCOUNT_CHANGED','撮影時のアカウントで写真の保存を再開してください');
    const ws=JSON.parse(store.getItem(WORKSPACE)||'{"projects":[]}');
    const drawing=JSON.parse(store.getItem(DRAWING+target.drawingId)||'null');
    const project=ws.projects?.find(p=>p.id===target.projectId);
    const meta=project?.drawings?.find(d=>d.id===target.drawingId&&!Number(d.deletedAt));
    const record=drawing?.shapes?.find(s=>s.id===target.recordId);
    if(!project||Number(project.deletedAt)||!meta)throw error('TARGET_MISSING','追加先の案件・図面が見つかりません。写真は保存待ちに残しています。');
    if(deleted(record,root.SentlogRecordCollaboration))throw error('TARGET_DELETED','追加先の記録が削除されています。写真は保存待ちに残しています。');
    const control=root.SentlogArchive?.byLocal?.(target.projectId);
    if(control&&(control.status!=='active'||control.checking))throw error('TARGET_ARCHIVED','保管中・確認中の案件には追加せず、写真を保存待ちに残しています。');
    return {workspace:ws,drawing,project,meta,record};
  }
  function captureTarget(){
    if(typeof activeProjectId==='undefined'||typeof activeDrawingId==='undefined'||typeof selected==='undefined')return null;
    const base={projectId:activeProjectId,drawingId:activeDrawingId,recordId:selected,ownerId:currentOwner()};
    if(!validTarget(base))return null;
    const {project,meta,record}=readTarget(base);
    return {...base,projectName:project.name||'案件',drawingName:meta.name||'図面',
      recordLabel:record.autoLabel||record.type||'記録',photoNames:(record.photos||[]).map(p=>p.name).filter(Boolean),actor:actor()};
  }
  function status(message){const el=document.getElementById('photoStatus');if(el)el.textContent=message;}
  async function readyForWrite(){
    const store=root.SentlogRecords;await store.settled();store.assertSafe();
    if(!store.pending)return;
    // archiveAtomic has a short exclusive interval not included in settled().
    // Resume on a later task so its owner can update the visible record first.
    await new Promise((resolve,reject)=>{
      let unsubscribe=()=>{};
      const timeout=setTimeout(()=>{unsubscribe();reject(error('SAVE_BUSY','別の保存処理が続いています。写真は保存待ちに残しています。'));},5000);
      const check=()=>{if(!store.pending){clearTimeout(timeout);unsubscribe();setTimeout(resolve,0);}};
      unsubscribe=store.subscribe(check);check();
    });
    store.assertSafe();
  }
  function mirror(target,photo,entry,ws,savedRecord){
    if(typeof workspace!=='undefined')workspace=ws;
    if(typeof activeProjectId==='undefined'||typeof activeDrawingId==='undefined'||activeProjectId!==target.projectId||activeDrawingId!==target.drawingId)return;
    const live=typeof state==='undefined'?null:state.shapes?.find(s=>s.id===target.recordId);
    if(deleted(live,root.SentlogRecordCollaboration))return;
    // Apply the same operation to the current live object, preserving another
    // field's preview/IME draft and any live collaboration revisions.
    // A legacy live preview has no revision baseline yet. Seed it from the
    // saved record, not from the preview's temporary coordinates.
    const base=!live.collab&&savedRecord?.collab?{...live,collab:clone(savedRecord.collab)}:live;
    const updated=addPhoto(base,photo,entry,root.SentlogRecordCollaboration);
    live.photos=updated.photos;if(updated.collab)live.collab=updated.collab;
    // The full-screen camera covers the editor. Keep its model current now,
    // and paint the latest live view once when that camera is dismissed.
    const refresh=()=>{
      if(typeof activeProjectId==='undefined'||typeof activeDrawingId==='undefined'||
        activeProjectId!==target.projectId||activeDrawingId!==target.drawingId||
        typeof currentView!=='undefined'&&currentView!=='editor')return;
      if(typeof render==='function')render();
      if(typeof selected!=='undefined'&&selected===target.recordId&&typeof renderSelectedPhotos==='function')return renderSelectedPhotos();
    };
    if(root.SentlogContinuousCamera?.deferEditorRefresh?.(refresh)!==true)void refresh();
    root.dispatchEvent(new CustomEvent('sentlog-photo-attached',{detail:{projectId:target.projectId,drawingId:target.drawingId,recordId:target.recordId,photoId:photo.id}}));
  }
  async function attach(target,photo,entry){
    await readyForWrite();
    const latest=readTarget(target),patch=appendLatest(latest.workspace,latest.drawing,target,photo,entry,root.SentlogRecordCollaboration);
    committing++;
    try{
      if(patch.changed)root.SentlogRecords.batch([[DRAWING+target.drawingId,JSON.stringify(patch.drawing)],
        [WORKSPACE,JSON.stringify(patch.workspace)]],{origin:'local'});
      mirror(target,photo,entry,patch.workspace,patch.record);
      if(patch.changed&&typeof activeDrawingId!=='undefined'&&activeDrawingId===target.drawingId&&
         typeof activeProjectId!=='undefined'&&activeProjectId===target.projectId&&
         Number(state.currentPage||1)===Number(patch.record.page||1))
        root.SentlogCollaboration?.recordHistory?.(latest.drawing,patch.drawing);
    }finally{committing--;}
    await root.SentlogRecords.settled();root.SentlogRecords.assertSafe();
  }
  const service=createService({originals,
    shared:{get:(id,did)=>getPhotoBlob(id,did),put:(id,blob,did)=>savePhotoBlob(id,blob,did),make:file=>originals.makeSharedPhoto(file),
      digest:async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('')},
    records:{checkTarget:target=>readTarget(target),attach},actor,
    loadJournal:()=>JSON.parse(localStorage.getItem(JOURNAL_KEY)||'null'),
    saveJournal:value=>localStorage.setItem(JOURNAL_KEY,JSON.stringify(value)),uniqueName:originals.uniqueName,
    onChange:queueRender,onJournalError:()=>status('撮影操作の控えを保存できません。原本の保存状態を確認しています。')});

  function prepareInput(inputId){
    const target=captureTarget();if(!target)throw error('TARGET_REQUIRED','写真を追加する記録を選んでください');
    return service.prepare(target,{inputId});
  }
  function prepareCapture(target){
    // The camera session supplies its original target, never today's selection.
    // Recheck its ownership and current availability before every shutter.
    readTarget(target);
    return service.prepare(target,{inputId:'continuousCamera',requireDurable:true});
  }
  async function register(files,intent){
    if(!files?.length)return [];
    const prepared=intent?.operationId?intent:service.prepare(intent||captureTarget(),{requireDurable:false});
    status('原本と確認用写真を保存中…');
    const results=await service.register(files,prepared),count=results.filter(r=>r.status==='attached').length;
    status(results.some(r=>r.status==='pending')?`${count}枚を記録へ追加しました。保存待ちの写真を確認してください。`:
      `${count}枚保存しました（原本はこの端末・共有は軽量版）`);
    originals.refreshUI?.();queueRender();return results;
  }
  // Existing programmatic callers explicitly mean their current record at
  // call time. Native-input changes always supply a prepared (possibly
  // targetUnknown) intent and never take this deliberate-call fallback.
  addPhotosToSelected=function(files,intent){return register(files,intent);};
  for(const inputId of ['cameraInput','photoInput']){
    const input=document.getElementById(inputId);if(!input)continue;
    input.addEventListener('click',event=>{
      try{prepareInput(inputId);}catch(e){event.preventDefault();event.stopImmediatePropagation();status(e.message);}
    },true);
    input.addEventListener('cancel',()=>service.cancel(inputId));
    const received=async event=>{
      // The later archive input guard must not discard files already returned
      // by the camera. readTarget still forbids adding to an archived record.
      event.stopImmediatePropagation?.();
      const files=Array.from(event.target.files||[]);event.target.value='';
      if(!files.length){service.cancel(inputId);return;}
      const intent=service.consume(inputId);
      try{await register(files,intent);}catch(e){status('写真の保存を再開できません：'+(e.message||e));queueRender();}
    };
    // Window capture also precedes the archive guard on #inspector inputs.
    input.onchange=null;
    root.addEventListener('change',event=>{if(event.target===input)return received(event);},true);
  }

  function queueRender(){if(renderQueued)return;renderQueued=true;queueMicrotask(()=>{renderQueued=false;void renderPending();});}
  function refresh(){
    if(discoveryTimer!==null){clearTimeout(discoveryTimer);discoveryTimer=null;}
    discoveryRequested=true;
    if(discoveryFlight)return discoveryFlight;
    discoveryFlight=Promise.resolve().then(async()=>{
      do{discoveryRequested=false;await service.listPending();}while(discoveryRequested);
    }).finally(()=>{discoveryFlight=null;queueRender();});
    return discoveryFlight;
  }
  function queueDiscovery(){
    if(discoveryTimer!==null)return;
    discoveryTimer=setTimeout(()=>{discoveryTimer=null;void refresh().catch(e=>status('保存待ちの写真を確認できません：'+(e.message||e)));},0);
  }
  function button(text,action){const b=document.createElement('button');b.type='button';b.textContent=text;
    b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){status(e.message||String(e));}finally{b.disabled=false;queueRender();}};return b;}
  async function renderPending(){
    if(rendering)return;rendering=true;
    try{
      for(const [id,selector] of [['sentlogPendingPhotos','.photo-panel'],['sentlogPendingPhotosSettings','#sentlogSettingsModal .modal-card']]){
        if(pendingPanels.has(id))continue;
        const host=document.querySelector(selector);if(!host)continue;
        const panel=document.createElement('details');panel.id=id;
        panel.style.cssText='margin-top:10px;font-size:12px;line-height:1.6';host.appendChild(panel);pendingPanels.set(id,panel);
      }
      if(!pendingPanels.size)return;
      // Local phase changes already update the journal. Redrawing their status
      // must not scan every retained original or parse every record again.
      const rows=service.pendingSnapshot();
      let selectedTarget=null;
      if(rows.some(row=>!validTarget(row.target)||['TARGET_DELETED','TARGET_MISSING','ACCOUNT_CHANGED'].includes(row.errorCode)))
        try{selectedTarget=captureTarget();}catch(_){}
      if(selectedTarget)delete selectedTarget.photoNames;
      for(const pendingPanel of pendingPanels.values()){
        pendingPanel.hidden=!rows.length;
        const opened=pendingPanel.open;pendingPanel.replaceChildren();
        const title=document.createElement('summary');title.textContent=`保存待ちの写真 ${rows.length}枚`;pendingPanel.appendChild(title);pendingPanel.open=opened;
        for(const row of rows){
        const item=document.createElement('div');item.style.cssText='border-top:1px solid #d1d5db;padding:8px 0';
        const name=document.createElement('strong');name.textContent=row.originalName||'写真';
        const location=document.createElement('p');location.style.margin='3px 0';
        location.textContent=row.target?`${row.target.projectName||'案件'} / ${row.target.drawingName||'図面'} / ${row.target.recordLabel||'記録'}`:'追加先が未確認です';
        const message=document.createElement('p');message.style.margin='3px 0';message.textContent=row.lastError||(row.originalSaved?'原本を保持して追加処理を待っています。':'原本の保存を確認しています。');
        item.append(name,location,message,button('保存を再試行',()=>service.retryPending(row.photoId)));
        if(selectedTarget&&(!validTarget(row.target)||row.errorCode==='TARGET_DELETED'||row.errorCode==='TARGET_MISSING'||row.errorCode==='ACCOUNT_CHANGED')){
          const target=clone(selectedTarget);
          item.appendChild(button(`「${target.recordLabel}」へ追加`,()=>service.reassign(row.photoId,target)));
        }
        if(!row.originalSaved){
          const choose=document.createElement('input');choose.type='file';choose.accept='image/*';choose.hidden=true;
          choose.onchange=async()=>{const file=choose.files?.[0];choose.value='';
            try{if(file)await service.supplyOriginal(row.photoId,file);}catch(e){status(e.message||String(e));}finally{queueRender();}};
          item.append(choose,button('元の写真を選び直す',()=>choose.click()));
        }
        pendingPanel.appendChild(item);
        }
      }
    }catch(e){status('保存待ちの写真を確認できません：'+(e.message||e));}
    finally{rendering=false;}
  }
  root.SentlogCollaborationPhotos={...pure,prepareInput,prepareCapture,cancelCapture:intent=>service.cancelCapture(intent),captureTarget,register,
    retryPending:photoId=>service.retryPending(photoId),listPending:()=>service.listPending(),pendingSnapshot:()=>service.pendingSnapshot(),
    reassign:(photoId,target)=>service.reassign(photoId,target),refresh,afterIncoming:queueDiscovery,
    isCommitting:()=>committing>0,get ready(){return !!root.SentlogRecords?.ready;}};
  // Full discovery remains authoritative after a restart and at cross-tab or
  // resume boundaries, including originals whose localStorage intent was lost.
  root.addEventListener('focus',queueDiscovery);
  root.addEventListener('storage',event=>{if(event.key===JOURNAL_KEY||event.key===null)queueDiscovery();});
  document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='visible')queueDiscovery();});
  Promise.resolve(root.sentlogAppReady).then(()=>service.retryPending()).then(queueRender).catch(e=>status(e.message||String(e)));
  setTimeout(queueRender,0);
})(typeof window==='undefined'?globalThis:window);

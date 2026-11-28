/* Shared-photo bridge: immutable delta bytes -> guarded legacy file mirror ->
 * server receipt. The caller supplies the exact record snapshot token and the
 * current authenticated scope. Merely loading this module does no work.
 */
(function(root){
 'use strict';
 const A=root.SentlogDeltaAssets||(typeof module==='object'&&module.exports?require('./delta-sync-assets.js'):null);
 const T=root.SentlogDeltaAssetTransport||(typeof module==='object'&&module.exports?require('./delta-sync-asset-transport.js'):null);
 const D=root.SentlogDeltaSyncCore||(typeof module==='object'&&module.exports?require('./delta-sync-core.js'):null);
 const SCOPE=['ownerId','projectId','deviceId'];
 const MIME=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
 const valid=x=>typeof x==='string'&&x.length>0&&x.length<=512;
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),copy=x=>root.structuredClone(x);
 const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
 const sameScope=(a,b)=>object(a)&&object(b)&&SCOPE.every(k=>a[k]===b[k]);
 const target=x=>JSON.stringify([x.drawingId,x.photoId]),fileKey=x=>'photo:'+x.drawingId+':'+x.photoId;
 function error(code,message){return Object.assign(Error(message),{code});}
 function insist(ok,code,message){if(!ok)throw error(code,message);}
 function collectPhotos(input){
  insist(D&&object(input)&&object(input.scope),'ASSET_SNAPSHOT','共有写真の記録を確認できません');
  const snapshot=copy(input);D.validateState(snapshot,snapshot.scope,true);
  const photos=new Map(),keys=new Map();
  function observe(drawingId,record,value){
   insist(object(value)&&valid(value.id),'ASSET_PHOTO_METADATA','写真の識別情報を確認できません');
   insist(!value.variant||value.variant==='shared','ASSET_ORIGINAL_NOT_REQUESTED','原本写真は通常の共有写真同期に含められません');
   const photo={drawingId,photoId:value.id,variant:'shared',recordId:record.id};
   if(valid(value.name))photo.name=value.name;
   if(valid(record.autoLabel))photo.recordLabel=record.autoLabel;
   if(own(value,'sha256')){
    insist(typeof value.sha256==='string'&&/^[0-9a-f]{64}$/i.test(value.sha256),'ASSET_PHOTO_METADATA','写真の照合情報を確認できません');
    photo.sha256=value.sha256.toLowerCase();
   }
   for(const field of ['size','byte_size'])if(own(value,field)){
    const size=value[field];insist(Number.isSafeInteger(size)&&size>0,'ASSET_PHOTO_METADATA','写真のサイズを確認できません');
    insist(!own(photo,'size')||photo.size===size,'ASSET_COLLISION','同じ写真に異なるサイズの情報があります');photo.size=size;
   }
   for(const field of ['type','mimeType','mime_type'])if(value[field]!==undefined&&value[field]!==''){
    const mime=String(value[field]).toLowerCase();insist(MIME.has(mime),'ASSET_PHOTO_METADATA','共有写真の形式を確認できません');
    insist(!photo.mimeType||photo.mimeType===mime,'ASSET_COLLISION','同じ写真に異なる形式の情報があります');photo.mimeType=mime;
   }
   const id=target(photo),key=fileKey(photo),existing=photos.get(id);
   insist(!keys.has(key)||keys.get(key)===id,'ASSET_COLLISION','別の写真が同じ端末保存先を参照しています');keys.set(key,id);
   if(existing){
    for(const field of ['sha256','size','mimeType']){
     insist(!own(existing,field)||!own(photo,field)||existing[field]===photo[field],
      'ASSET_COLLISION','同じ写真IDに異なる内容の履歴があります。写真と履歴を保持しています');
     if(!own(existing,field)&&own(photo,field))existing[field]=photo[field];
    }
   }else photos.set(id,photo);
  }
  for(const [key,record]of Object.entries(snapshot.records)){
   const [drawingId]=JSON.parse(key);
   for(const photo of record.photos||[])observe(drawingId,record,photo);
   for(const [photoId,entry]of Object.entries(record.collab?.photos||{})){
    insist(object(entry)&&Array.isArray(entry.revisions),'ASSET_PHOTO_METADATA','写真の変更履歴を確認できません');
    for(const revision of entry.revisions){
     insist(revision?.value?.id===photoId,'ASSET_PHOTO_METADATA','写真と変更履歴の識別情報が一致しません');
     // Deleted photo and record history remains part of delivery. No bytes or
     // receipts are erased merely because the current projection hides them.
     observe(drawingId,record,revision.value);
    }
   }
  }
  return [...photos.values()].sort((a,b)=>target(a).localeCompare(target(b)));
 }
 function createRuntime({scope:inputScope,transport,store,localFiles,currentScope,currentSnapshotToken,
  authGeneration,subscribeAuth,onPhotoReceived=()=>{},timeoutMs=30000,maxBytes=22*1024*1024,allowArchivedRestore=false}={}){
  const scope=Object.freeze(Object.fromEntries(SCOPE.map(k=>[k,inputScope?.[k]])));
  const capabilities=localFiles?.getCapabilities?.();
  insist(A&&T&&SCOPE.every(k=>valid(scope[k]))&&sameScope(scope,transport?.getScope?.())&&sameScope(scope,store?.getScope?.())&&
   ['online','listPhotos','uploadPhoto','download','acknowledge'].every(k=>typeof transport?.[k]==='function')&&
   ['ensure','read','received','acknowledged'].every(k=>typeof store?.[k]==='function')&&
   ['read','write','withLock','getCapabilities','assertExclusive'].every(k=>typeof localFiles?.[k]==='function')&&
   [currentScope,currentSnapshotToken,authGeneration,subscribeAuth,onPhotoReceived].every(f=>typeof f==='function')&&
   capabilities?.guarded===true&&capabilities.onlyIfMissing===true&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&typeof allowArchivedRestore==='boolean',
   'ASSET_RUNTIME_CONFIG','写真の保存・認証・表示対象の確認方法が不足しています');
  let closed=false,pump=null,active=null;
  function alive(){
   insist(!closed,'ASSET_CLOSED','共有写真の同期を終了しました');
   insist(sameScope(scope,currentScope()),'ASSET_SCOPE','写真同期中に利用者・案件・端末が変わりました');
  }
  function cancel(code){if(active){active.reason=active.reason||error(code,'写真の対象が変わったため処理を中止しました。保存済みの内容を保持しています');active.controller.abort();active.queue?.close();}}
  const unsubscribe=subscribeAuth(()=>cancel('ASSET_AUTH_CHANGED'));
  const globalFailure=e=>['ASSET_CLOSED','ASSET_SCOPE','ASSET_AUTH_CHANGED','ASSET_SNAPSHOT_CHANGED','ASSET_ABORTED',
   'ASSET_LOGIN_REQUIRED','ASSET_PROJECT_FORBIDDEN','ASSET_DEVICE_FORBIDDEN','ASSET_FORBIDDEN','REAUTH_REQUIRED','AUTH_RETRY_LATER','SESSION_CHANGED'].includes(e?.code);
  async function run(snapshot,snapshotToken,signal){
   alive();const ctx={snapshotToken,controller:new AbortController(),queue:null,reason:null,generation:authGeneration()};active=ctx;
   const external=()=>cancel('ASSET_ABORTED');signal?.addEventListener('abort',external,{once:true});
   function checkFile(item){
    const exclusive=localFiles.assertExclusive(fileKey(item));
    if(exclusive&&typeof exclusive.then==='function')Promise.resolve(exclusive).catch(()=>{});
    insist(exclusive===true,'ASSET_LEGACY_WRITER_ACTIVE','旧同期の写真保存・再試行が残っています。写真を保持して切替を待っています');
   }
   function check(item=currentItem){
    alive();if(ctx.reason)throw ctx.reason;
    insist(!ctx.controller.signal.aborted&&!signal?.aborted,'ASSET_ABORTED','写真の同期を中止しました');
    insist(Number.isSafeInteger(ctx.generation)&&authGeneration()===ctx.generation,'ASSET_AUTH_CHANGED','写真同期中にログイン情報が変わりました');
    insist(object(snapshotToken)&&currentSnapshotToken()===snapshotToken,'ASSET_SNAPSHOT_CHANGED','写真同期中に記録が変わりました。現在の記録を再確認します');
    if(item)checkFile(item);
   }
   // Each byte operation owns only its current photo. Re-scanning every
   // unrelated photo at every network/IDB await makes a batch quadratic.
   // Fence all files at entry/completion; fence the active file at every await.
   // Other files are checked before their own work and their final readback.
   function checkAll(){check(null);for(const item of descriptors)checkFile(item);}
   const options={signal:ctx.controller.signal,validate:check};
   const issues=[],refs=[];let descriptors=[],currentItem=null;
   function issue(item,e){issues.push({drawingId:item?.drawingId||null,photoId:item?.photoId||null,
    code:typeof e?.code==='string'?e.code:e?.name==='QuotaExceededError'?'ASSET_QUOTA':'ASSET_LOCAL_FAILURE',
    message:typeof e?.code==='string'?String(e.message):'写真の保存・照合を完了できません。元の写真は保持しています'});}
   async function local(ref,allowMissing=true){
    check(ref);const value=await localFiles.read(fileKey(ref));check(ref);
    if(value===undefined&&allowMissing)return undefined;
    insist(value instanceof root.Blob,'ASSET_LOCAL_COLLISION','写真の端末保存先に別の内容があります。上書きを止めました');
    await A.verifyBlob(value,ref,{validate:()=>check(ref),signal:ctx.controller.signal});check(ref);return value;
   }
   async function mirror(ref,blob){
    const validate=()=>check(ref);
    await A.verifyBlob(blob,ref,{validate,signal:ctx.controller.signal});validate();
    await localFiles.withLock(fileKey(ref),async()=>{
     validate();let value=await local(ref);
     if(value===undefined){
      const saved=await localFiles.write(fileKey(ref),blob,{validate,onlyIfMissing:true,signal:ctx.controller.signal});validate();
      insist(object(saved)&&typeof saved.written==='boolean'&&saved.value instanceof root.Blob,
       'ASSET_LOCAL_COLLISION','端末へ保存された写真を確認できません');
      await A.verifyBlob(saved.value,ref,{validate,signal:ctx.controller.signal});validate();
     }
     await local(ref,false);validate();
    });validate();
   }
   const linked={online:()=>transport.online(),
    async download(ref,request){
     const validate=()=>check(ref);validate();let value;
     await localFiles.withLock(fileKey(ref),async()=>{value=await local(ref);});validate();
     return value===undefined?transport.download(ref,{...request,validate}):value;
    },
    async acknowledge(ref,request){
     const validate=()=>check(ref);validate();const row=await store.read(ref);validate();
     insist(row?.phase==='received'||row?.phase==='acknowledged','ASSET_NOT_DURABLE','受信した写真の保存を確認できません');
     await mirror(ref,row.blob);validate();
     const proof=await transport.acknowledge(ref,{...request,validate});validate();
     // A clear/import or another writer may have raced the network receipt.
     // Never promote that old result into a new local file state.
     await localFiles.withLock(fileKey(ref),()=>local(ref,false));validate();return proof;
    }};
   try{
    ctx.queue=A.createQueue({scope,store,transport:linked,currentScope,assertCurrent:check,timeoutMs,maxBytes,allowOriginals:false,allowArchivedRestore});
    check();descriptors=collectPhotos(snapshot);checkAll();let assets=[];
    if(descriptors.length){
     try{assets=await transport.listPhotos(options);check();}
     catch(e){check();if(globalFailure(e))throw e;issue(null,e);}
    }
    const byTarget=new Map();
    for(const asset of assets){
     const ref=T.referenceFromAsset(asset,scope),id=target(ref);
     insist(!byTarget.has(id),'ASSET_COLLISION','同じ共有写真に複数の登録があります。写真を保持して確認を待っています');byTarget.set(id,ref);
    }
    for(const item of descriptors){
     currentItem=item;
     check();try{
      let ref=byTarget.get(target(item));
      if(ref){
       for(const field of ['sha256','size','mimeType'])insist(!own(item,field)||item[field]===ref[field],
        'ASSET_COLLISION','記録とサーバーで同じ写真IDの内容が異なります。両方を保持しています');
      }else{
       let blob;await localFiles.withLock(fileKey(item),async()=>{check();blob=await localFiles.read(fileKey(item));check();});check();
       insist(blob!==undefined,'ASSET_REFERENCE_MISSING','共有写真の本体またはサーバー登録を取得待ちです');
       insist(blob instanceof root.Blob,'ASSET_LOCAL_COLLISION','写真の端末保存先に別の内容があります。上書きを止めました');
       const uploaded=await transport.uploadPhoto(item,blob,{...options,validate:()=>check(item)});check();ref=T.referenceFromAsset(uploaded.asset,scope);
       insist(target(ref)===target(item),'ASSET_BINDING','送信した写真と登録された対象が一致しません');
       for(const field of ['sha256','size','mimeType'])insist(!own(item,field)||item[field]===ref[field],
        'ASSET_COLLISION','送信した写真と登録された内容が異なります');
       await A.verifyBlob(blob,ref,{validate:()=>check(),signal:ctx.controller.signal});check();
      }
      refs.push(ref);
     }catch(e){check();if(globalFailure(e))throw e;issue(item,e);}
     finally{currentItem=null;}
    }
    refs.sort((a,b)=>a.assetId.localeCompare(b.assetId));
    await ctx.queue.ensure(refs);check();
    for(const ref of refs){
     currentItem=ref;
     check();try{
      const row=await store.read(ref);check();
      if(row?.phase!=='waiting'&&row?.blob)await mirror(ref,row.blob);
      await ctx.queue.sync([ref]);check();
      const persisted=await store.read(ref);check();
      if(persisted?.phase==='acknowledged'){
       await localFiles.withLock(fileKey(ref),()=>local(ref,false));check();
       try{onPhotoReceived({scope:copy(scope),snapshotToken,reference:copy(ref),key:fileKey(ref)});}catch{}
       check();
      }
     }catch(e){check();if(globalFailure(e))throw e;issue(ref,e);}
     finally{currentItem=null;}
    }
    const photoStatus=await ctx.queue.status(refs);check();
    // Recheck every mirror after the whole batch, including receipts restored
    // from a previous session. A cached receipt alone cannot certify this UI.
    for(const ref of refs){
     currentItem=ref;
     try{const row=await store.read(ref);check();if(row?.phase==='acknowledged')await localFiles.withLock(fileKey(ref),()=>local(ref,false));check();}
     catch(e){check();if(globalFailure(e))throw e;issue(ref,e);}
     finally{currentItem=null;}
    }
    const unresolved=descriptors.length-refs.length,issueTargets=new Set(issues.map(x=>JSON.stringify([x.drawingId,x.photoId])));
    const complete=unresolved===0&&issues.length===0&&photoStatus.complete;
    const pending=Math.max(photoStatus.pending+unresolved,issueTargets.size);
    const delivered={...photoStatus,scope:copy(scope),snapshotToken,total:descriptors.length,pending,complete,sharedOnly:true,
     message:complete?'共有写真の保存・受領確認が完了しました':'共有写真 '+pending+' 件を受信・確認待ちです'};
    // photoStatus is the fully gated status too: a caller must not mistake an
    // empty resolved queue for successful delivery of unresolved photographs.
    const result={...delivered,references:copy(refs),photoStatus:delivered,queueStatus:photoStatus,issues};
    checkAll();return result;
   }finally{
    ctx.queue?.close();signal?.removeEventListener('abort',external);if(active===ctx)active=null;
   }
  }
  return {
   getScope:()=>copy(scope),
   sync({snapshot,snapshotToken,signal}={}){
    alive();insist(sameScope(snapshot?.scope,scope),'ASSET_SCOPE','写真と記録の対象案件・端末が一致しません');
    insist(signal===undefined||typeof signal?.addEventListener==='function'&&typeof signal?.removeEventListener==='function'&&typeof signal.aborted==='boolean',
     'ASSET_RUNTIME_CONFIG','写真同期の中断通知を確認できません');
    if(pump){
     if(active?.snapshotToken===snapshotToken)return pump;
     cancel('ASSET_SNAPSHOT_CHANGED');return Promise.reject(error('ASSET_SNAPSHOT_CHANGED','記録が更新されました。前の写真処理が終わってから再確認します'));
    }
    const captured=copy(snapshot);pump=run(captured,snapshotToken,signal).finally(()=>{pump=null;});return pump;
   },
   close(){if(closed)return;closed=true;cancel('ASSET_CLOSED');if(typeof unsubscribe==='function')unsubscribe();}
  };
 }
 const api={version:1,createRuntime,collectPhotos};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaAssetRuntime=api;
})(typeof window!=='undefined'?window:globalThis);

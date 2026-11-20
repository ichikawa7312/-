/* Shared-photo adapter for the existing authenticated asset / PC-redelivery
 * protocol. Originals are deliberately excluded. Factories perform no work
 * until called; there are no embedded accounts, credentials or live endpoints.
 */
(function(root){
 'use strict';
 const A=root.SentlogDeltaAssets||(typeof module==='object'&&module.exports?require('./delta-sync-assets.js'):null);
 const SCOPE=['ownerId','projectId','deviceId'],IDENTITY=['ownerId','projectId','assetId','drawingId','photoId','variant','sha256','size','mimeType'];
 const MIME={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/heic':'.heic','image/heif':'.heif'};
 const FIELDS='id,owner_id,project_id,client_key,kind,file_name,storage_path,mime_type,byte_size,sha256,status,source_device_id,metadata';
 const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
 const valid=v=>typeof v==='string'&&v.length>0&&v.length<=512;
 const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const copy=v=>root.structuredClone(v),sameScope=(a,b)=>a&&b&&SCOPE.every(k=>a[k]===b[k]);
 const same=(a,b)=>a&&b&&IDENTITY.every(k=>a[k]===b[k]);
 const filter=value=>encodeURIComponent('"'+String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"');
 function error(code,message,status=0){return Object.assign(Error(message),{code,...(status?{status}:{}),retryable:[408,429].includes(status)||status>=500});}
 function insist(ok,code,message){if(!ok)throw error(code,message);}
 function referenceFromAsset(row,scope){
  insist(object(row)&&uuid(row.id)&&row.owner_id===scope.ownerId&&row.project_id===scope.projectId&&row.kind==='photo'&&
   ['uploaded','pc_verified','storage_deleted'].includes(row.status)&&valid(row.metadata?.drawing_id)&&valid(row.metadata?.photo_id)&&
   row.client_key==='photo:'+row.metadata.drawing_id+':'+row.metadata.photo_id&&
   (!row.metadata.variant||row.metadata.variant==='shared')&&(!row.metadata.photo_variant||row.metadata.photo_variant==='shared'),
   'ASSET_BINDING','共有写真と案件・図面・写真IDの対応を確認できません');
  const sha=typeof row.sha256==='string'?row.sha256.toLowerCase():'',mime=String(row.mime_type||'').toLowerCase(),size=Number(row.byte_size);
  insist(digest(sha)&&Object.prototype.hasOwnProperty.call(MIME,mime)&&Number.isSafeInteger(size)&&size>0,
   'ASSET_REFERENCE','写真のサイズ・形式・照合情報を確認できません');
  return {ownerId:scope.ownerId,projectId:scope.projectId,assetId:row.id,drawingId:row.metadata.drawing_id,
   photoId:row.metadata.photo_id,variant:'shared',sha256:sha,size,mimeType:mime};
 }
 function createTransport({url,key,scope:inputScope,localProjectId,session,ensureSession,subscribeAuth,authGeneration,currentScope,
  fetch:fetcher=root.fetch,online:network=()=>root.navigator?.onLine!==false,timeoutMs=30000,maxBytes=22*1024*1024,pageLimit=400}={}){
  let origin;try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&['','/'].includes(u.pathname))origin=u.origin;}catch{}
  const scope=Object.freeze(Object.fromEntries(SCOPE.map(k=>[k,inputScope?.[k]])));
  insist(A&&origin&&typeof key==='string'&&key.length>0&&!key.startsWith('sb_secret_')&&SCOPE.every(k=>uuid(scope[k]))&&valid(localProjectId)&&
   [session,ensureSession,subscribeAuth,authGeneration,currentScope,fetcher,network].every(f=>typeof f==='function')&&
   Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&Number.isSafeInteger(pageLimit)&&pageLimit>0&&pageLimit<=400,
   'ASSET_CONFIG','写真の認証・保存先・通信方法を確認できません');
  try{const parts=key.split('.');if(parts.length===3){const raw=parts[1].replace(/-/g,'+').replace(/_/g,'/');
   const payload=JSON.parse(root.atob?root.atob(raw):Buffer.from(raw,'base64').toString());
   insist(payload.role!=='service_role','ASSET_CONFIG','管理用秘密キーを端末の写真同期に使用できません');}}
  catch(e){if(e.code==='ASSET_CONFIG')throw e;}
  let closed=false,epoch=0,verified=null;const pending=new Set();
  const unsubscribe=subscribeAuth(()=>{epoch++;verified=null;for(const ticket of pending)if(ticket.phase!=='session')ticket.abort('ASSET_AUTH_CHANGED');});
  function alive(){insist(!closed,'ASSET_CLOSED','写真通信を終了しました');insist(sameScope(scope,currentScope()),'ASSET_SCOPE','写真通信中に利用者・案件・端末が変わりました');}
  function run(options,action,allowArchived=false){
   options=options||{};alive();const controller=new AbortController();let phase='session',timer,cancel;
   const cancelled=new Promise((resolve,reject)=>cancel=reject);
   const ticket={get phase(){return phase;},abort(code){controller.abort();cancel(error(code,'写真通信を中止しました。保存済みの写真は保持しています'));}};
   const external=()=>ticket.abort('ASSET_ABORTED');options.signal?.addEventListener('abort',external,{once:true});pending.add(ticket);
   timer=setTimeout(()=>ticket.abort('ASSET_TIMEOUT'),timeoutMs);
   const task=(async()=>{
    alive();if(options.signal?.aborted)external();insist(!controller.signal.aborted,'ASSET_ABORTED','写真通信を中止しました');
    await ensureSession();alive();const current=session(),generation=authGeneration(),startEpoch=epoch;
    insist(current?.user?.id===scope.ownerId&&typeof current.access_token==='string'&&current.access_token&&Number.isSafeInteger(generation),
     'ASSET_LOGIN_REQUIRED','写真を同期するログインを確認してください');
    const token=current.access_token;phase='authorized';
    function check(){
     alive();insist(!controller.signal.aborted,'ASSET_ABORTED','写真通信を中止しました');
     insist(epoch===startEpoch&&authGeneration()===generation&&session()?.access_token===token&&session()?.user?.id===scope.ownerId,
      'ASSET_AUTH_CHANGED','ログイン情報が変わりました。写真の処理を再確認します');
     const result=options.validate?.();if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
     insist(result!==false&&!(result&&typeof result.then==='function'),'ASSET_CONTEXT','写真の対象を同期的に確認できません');
    }
    const ctx={token,generation,startEpoch,signal:controller.signal,check};check();
    if(!verified||verified.token!==token||verified.generation!==generation){
     const user=await json('/auth/v1/user',{},ctx);check();insist(user?.id===scope.ownerId,'ASSET_LOGIN_REQUIRED','サーバーでログインを確認できません');
     verified={token,generation};
    }
    const [projects,devices]=await Promise.all([
     json('/rest/v1/sentlog_projects?id=eq.'+scope.projectId+'&owner_id=eq.'+scope.ownerId+'&select=id,owner_id,status,client_key',{},ctx),
     json('/rest/v1/sentlog_devices?id=eq.'+scope.deviceId+'&owner_id=eq.'+scope.ownerId+'&select=id,owner_id,active,device_type',{},ctx)]);check();
    insist(Array.isArray(projects)&&projects.length===1&&projects[0].id===scope.projectId&&projects[0].owner_id===scope.ownerId&&
     (projects[0].status==='active'||allowArchived&&projects[0].status==='archived')&&projects[0].client_key===localProjectId,'ASSET_PROJECT_FORBIDDEN','共有写真の対象案件を確認できません');
    insist(Array.isArray(devices)&&devices.length===1&&devices[0].id===scope.deviceId&&devices[0].owner_id===scope.ownerId&&devices[0].active===true,
     'ASSET_DEVICE_FORBIDDEN','写真を受け渡す登録端末を確認できません');
    ctx.projectStatus=projects[0].status;
    const value=await action(ctx);check();return value;
   })();
   return Promise.race([task,cancelled]).finally(()=>{clearTimeout(timer);pending.delete(ticket);options.signal?.removeEventListener('abort',external);});
  }
  async function response(path,options,ctx){
   ctx.check();insist(network(),'ASSET_OFFLINE','通信が戻るまで写真を保持しています');
   const r=await fetcher(origin+path,{method:options.method||'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:ctx.signal,
    headers:{apikey:key,Authorization:'Bearer '+ctx.token,...(options.headers||{})},...(options.body===undefined?{}:{body:options.body})});ctx.check();return r;
  }
  async function json(path,options,ctx){
   const r=await response(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})},
    ...(options.body===undefined?{}:{body:JSON.stringify(options.body)})},ctx);
   let value;try{value=await r.json();}catch{if(r.ok)throw error('ASSET_RESPONSE','写真同期の応答を確認できません');}ctx.check();
   if(!r.ok)throw error(r.status===401?'ASSET_LOGIN_REQUIRED':r.status===403?'ASSET_FORBIDDEN':'ASSET_HTTP_'+r.status,
    '写真の通信が完了していません。保存済みの内容を保持しています',r.status);
   return value;
  }
  function checkReference(input){
   insist(object(input)&&input.variant==='shared'&&input.ownerId===scope.ownerId&&input.projectId===scope.projectId&&uuid(input.assetId)&&
    valid(input.drawingId)&&valid(input.photoId)&&digest(input.sha256)&&Number.isSafeInteger(input.size)&&input.size>0&&Object.prototype.hasOwnProperty.call(MIME,input.mimeType),
    'ASSET_REFERENCE','対象の共有写真を確認できません');return copy(input);
  }
  async function asset(ref,ctx){
   const rows=await json('/rest/v1/sentlog_assets?id=eq.'+ref.assetId+'&project_id=eq.'+scope.projectId+'&owner_id=eq.'+scope.ownerId+'&select='+FIELDS,{},ctx);
   insist(Array.isArray(rows)&&rows.length===1,'ASSET_BINDING','共有写真の登録を一意に確認できません');
   insist(same(referenceFromAsset(rows[0],scope),ref),'ASSET_COLLISION','共有写真の登録内容が変わりました。両方の内容を保持して確認してください');return rows[0];
  }
  function pathOf(row){
   const parts=String(row.storage_path||'').split('/');
   insist(parts.length>=4&&parts[0]===scope.ownerId&&parts[1]===scope.projectId&&
    ['photos','redelivery','device-redelivery'].includes(parts[2])&&parts.every(p=>p&&p!=='.'&&p!=='..'&&!/[\\\u0000-\u001f]/.test(p)),
    'ASSET_PATH','写真の保存先が対象の案件と一致しません');
   if(parts[2]!=='photos')insist(parts.length===5&&parts[3]===row.id,'ASSET_PATH','写真の再供給先を確認できません');
   return parts.map(encodeURIComponent).join('/');
  }
  async function request(ref,ctx){
   insist(ctx.projectStatus==='active','ASSET_ARCHIVED_RESTORE_REQUIRED','保管済みの写真をPCから取り戻すには、保管フォルダの「PCからこの端末に復旧」を使ってください');
   const result=await json('/rest/v1/rpc/sentlog_request_photo',{method:'POST',body:{p_asset_id:ref.assetId,p_device_id:scope.deviceId}},ctx);
   insist(result?.requested===true&&result.asset_id===ref.assetId,'ASSET_REDELIVERY_UNAVAILABLE','PCまたは別端末の写真供給を確認できません。写真待ちの状態を保持しています');
   return {requested:true,assetId:ref.assetId,reference:copy(ref)};
  }
  async function findPhoto(drawingId,photoId,ctx){
   const rows=await json('/rest/v1/sentlog_assets?project_id=eq.'+scope.projectId+'&owner_id=eq.'+scope.ownerId+
    '&client_key=eq.'+filter('photo:'+drawingId+':'+photoId)+'&kind=eq.photo&select='+FIELDS+'&limit=2',{},ctx);
   insist(Array.isArray(rows)&&rows.length<=1,'ASSET_COLLISION','同じ写真の登録が重複しています');
   if(rows[0])referenceFromAsset(rows[0],scope);return rows[0]||null;
  }
  return {
   getScope:()=>copy(scope),online:()=>!closed&&network(),
   listPhotos(options){return run(options,async ctx=>{
    const out=[];let after='';
    for(;;){
     const rows=await json('/rest/v1/sentlog_assets?project_id=eq.'+scope.projectId+'&owner_id=eq.'+scope.ownerId+
      '&kind=eq.photo&select='+FIELDS+'&order=id.asc&limit='+pageLimit+(after?'&id=gt.'+after:''),{},ctx);
     insist(Array.isArray(rows)&&rows.length<=pageLimit,'ASSET_PAGING','写真一覧のページを確認できません');
     if(!rows.length)return out;
     for(const row of rows){insist(uuid(row.id)&&row.id>after,'ASSET_PAGING','写真一覧に欠落または重複があります');referenceFromAsset(row,scope);after=row.id;out.push(copy(row));}
     insist(out.length<=20000,'ASSET_PAGING','一度に確認する写真数の上限を超えています');
    }
   },true);},
   download(input,options){const ref=checkReference(input);return run(options,async ctx=>{
    insist(ref.size<=maxBytes,'ASSET_TOO_LARGE','写真の転送上限を超えています。元の写真は保持しています');const row=await asset(ref,ctx);
    if(row.status==='storage_deleted'){await request(ref,ctx);throw error('ASSET_REDELIVERY_WAIT','PCまたは別端末から共有写真を再取得しています');}
    const r=await response('/storage/v1/object/authenticated/sentlog-temp/'+pathOf(row),{},ctx);
    if(!r.ok){if(r.status===404){await request(ref,ctx);throw error('ASSET_REDELIVERY_WAIT','写真の再供給を確認しています');}
     throw error('ASSET_HTTP_'+r.status,'共有写真を取得できません。再取得待ちを保持しています',r.status);}
    const length=r.headers?.get?.('content-length');if(length!==null&&length!==undefined)insist(Number(length)===ref.size,'ASSET_CONTENT_MISMATCH','受信する写真のサイズが登録内容と異なります');
    const blob=await r.blob();ctx.check();await A.verifyBlob(blob,ref);ctx.check();await asset(ref,ctx);return blob;
   },true);},
   acknowledge(input,options){const ref=checkReference(input);return run(options,async ctx=>{
    insist(same(options?.receipt,ref)&&options.receipt.deviceId===scope.deviceId&&options.receipt.verified===true,
     'ASSET_NOT_DURABLE','端末への写真保存を確認する前に受領通知は送れません');
    await asset(ref,ctx);
    const result=await json('/rest/v1/rpc/sentlog_ack_photo',{method:'POST',body:{p_asset_id:ref.assetId,p_device_id:scope.deviceId,p_sha256:ref.sha256,p_byte_size:ref.size}},ctx);
    insist(result?.received===true,'ASSET_ACK_MISMATCH','写真の受領確認が完了していません');
    const rows=await json('/rest/v1/sentlog_asset_device_receipts?asset_id=eq.'+ref.assetId+'&device_id=eq.'+scope.deviceId+'&owner_id=eq.'+scope.ownerId+
     '&select=asset_id,owner_id,device_id,sha256,byte_size,received_at',{},ctx);
    insist(Array.isArray(rows)&&rows.length===1&&rows[0].asset_id===ref.assetId&&rows[0].owner_id===scope.ownerId&&rows[0].device_id===scope.deviceId&&
     String(rows[0].sha256).toLowerCase()===ref.sha256&&Number(rows[0].byte_size)===ref.size&&typeof rows[0].received_at==='string'&&Number.isFinite(Date.parse(rows[0].received_at)),
     'ASSET_ACK_MISMATCH','サーバーに保存された受領記録が対象の写真・端末と一致しません');
    await asset(ref,ctx);return {...copy(ref),deviceId:scope.deviceId,durable:true,serverReceivedAt:rows[0].received_at,source:'sentlog_asset_device_receipts'};
   },true);},
   requestPhoto(input,options){const ref=checkReference(input);return run(options,async ctx=>{await asset(ref,ctx);return request(ref,ctx);});},
   uploadPhoto(descriptor,blob,options){
    const item=copy(descriptor);insist(valid(item?.drawingId)&&valid(item?.photoId)&&(!item.variant||item.variant==='shared')&&blob instanceof root.Blob&&blob.size>0,
     'ASSET_REFERENCE','送信する共有写真の内容を確認できません');
    return run(options,async ctx=>{
     insist(blob.size<=maxBytes,'ASSET_TOO_LARGE','共有写真の送信上限を超えています');
     const sha=[...new Uint8Array(await root.crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');ctx.check();
     const mime=String(item.mimeType||blob.type||'').toLowerCase();
     insist(Object.prototype.hasOwnProperty.call(MIME,mime)&&(item.sha256===undefined||String(item.sha256).toLowerCase()===sha)&&(item.size===undefined||item.size===blob.size),
      'ASSET_CONTENT_MISMATCH','端末の共有写真が記録と一致しません。元の写真を保持しています');
     const matches=row=>{const ref=referenceFromAsset(row,scope);insist(ref.drawingId===item.drawingId&&ref.photoId===item.photoId&&ref.sha256===sha&&ref.size===blob.size&&ref.mimeType===mime,
      'ASSET_COLLISION','同じ写真IDに別の内容があります。共有写真を上書きしていません');return {asset:copy(row),reference:ref};};
     const existing=await findPhoto(item.drawingId,item.photoId,ctx);if(existing)return {...matches(existing),uploaded:false};
     const contentKey=[...new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([item.drawingId,item.photoId,sha]))))].map(x=>x.toString(16).padStart(2,'0')).join('');ctx.check();
     const storagePath=scope.ownerId+'/'+scope.projectId+'/photos/'+contentKey+MIME[mime];
     const r=await response('/storage/v1/object/sentlog-temp/'+storagePath,{method:'POST',headers:{'Content-Type':mime,'x-upsert':'false'},body:blob},ctx);
     if(!r.ok){
      let detail;try{detail=await r.json();}catch{}ctx.check();
      insist(r.status===409||r.status===400&&['Duplicate','ResourceAlreadyExists'].includes(detail?.error||detail?.code),
       'ASSET_UPLOAD','共有写真の送信が完了していません。端末の写真を保持しています');
      const saved=await response('/storage/v1/object/authenticated/sentlog-temp/'+storagePath,{},ctx);
      insist(saved.ok,'ASSET_UPLOAD','再試行先の写真を確認できません');const current=await saved.blob();ctx.check();await A.verifyBlob(current,{size:blob.size,sha256:sha});ctx.check();
     }
     const payload={owner_id:scope.ownerId,project_id:scope.projectId,source_device_id:scope.deviceId,
      client_key:'photo:'+item.drawingId+':'+item.photoId,kind:'photo',file_name:item.name||'photo'+MIME[mime],storage_path:storagePath,
      mime_type:mime,byte_size:blob.size,sha256:sha,status:'uploaded',captured_at:new Date().toISOString(),
      metadata:{local_project_key:localProjectId,drawing_id:item.drawingId,photo_id:item.photoId,photo_variant:'shared',
       ...(valid(item.drawingName)?{drawing_name:item.drawingName}:{}),...(valid(item.recordId)?{shape_id:item.recordId}:{}),...(valid(item.recordLabel)?{shape_label:item.recordLabel}:{})}};
     try{await json('/rest/v1/sentlog_assets',{method:'POST',headers:{Prefer:'return=representation'},body:payload},ctx);}
     catch(e){if(e.status!==409)throw e;}
     const row=await findPhoto(item.drawingId,item.photoId,ctx);insist(row,'ASSET_UPLOAD','共有写真の登録を確認できません');return {...matches(row),uploaded:true};
    });
   },
   close(){if(closed)return;closed=true;for(const ticket of pending)ticket.abort('ASSET_CLOSED');if(typeof unsubscribe==='function')unsubscribe();verified=null;}
  };
 }
 const api={version:1,createTransport,referenceFromAsset};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaAssetTransport=api;
})(typeof window!=='undefined'?window:globalThis);

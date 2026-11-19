/* Sentlog v1.41: safely redeliver missing photos from the verified company PC.
   Works for ACTIVE projects only. Never deletes a local image, archive or PC original. */
(function(){
 'use strict';
 const IS_PC=location.pathname.includes('/sentlog-pc/');
 const BASE='https://wiulvaqixphuobdielyy.supabase.co';
 const KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
 const BUCKET='sentlog-temp';
 const enc=s=>encodeURIComponent(String(s));
 const allowed=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
 const photoKey=(d,p)=>'photo:'+d+':'+p;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 let busy=false,message='',lastRequested=new Map();
 let pcRequestCursor=null,pcProvidedCursor=0,nextPcScan=0,pcFailureCount=0;
 function device(){return localStorage.getItem(IS_PC?'sentlogPcWebDeviceV1':'sentlogCloudDeviceV1');}
 function session(){try{return JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null')}catch{return null;}}
 function show(t){
  if(t===message)return;message=t;
  const e=document.getElementById('slPhotoRedeliveryStatus');
  if(e)e.textContent=t;
  if(IS_PC&&typeof window.log==='function')window.log('写真再取得：'+t);
 }
 function mount(){
  if(document.getElementById('slPhotoRedeliveryStatus'))return;
  const e=document.createElement('p');e.id='slPhotoRedeliveryStatus';e.setAttribute('role','status');
  e.style.cssText='font-size:12px;line-height:1.6;white-space:pre-wrap;color:#475569;margin:8px 0;';
  if(IS_PC){
   const main=document.querySelector('main');
   const card=document.createElement('section');card.className='card';
   const title=document.createElement('h2');title.textContent='写真の再取得（新しい端末向け）';
   const note=document.createElement('p');note.className='muted';
   note.textContent='別の端末に写真がない場合、PCに保存された原本を読み直し、完全一致した写真だけ一時送信します。元の保管ファイルは削除しません。';
   card.append(title,note,e);main?.prepend(card);
  }else{
   const target=document.querySelector('#projectsView .manager-shell');
   target?.prepend(e);
  }
 }
 async function api(path,body){
  const s=session();if(!s?.access_token)throw Error('ログインが必要です。');
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),30000);
  try{
   const options={cache:'no-store',signal:c.signal,headers:{apikey:KEY,Authorization:'Bearer '+s.access_token}};
   if(body!==undefined){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
   const r=await fetch(BASE+'/rest/v1/'+path,options);
   if(!r.ok){const error=await r.json().catch(()=>({}));throw Error(error.message||error.error||('通信エラー '+r.status));}
   return await r.json();
  }finally{clearTimeout(timer);}
 }
 const rpc=(fn,args)=>api('rpc/'+fn,args);
 async function digest(file){
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
 }
 async function matches(blob,asset){
  return blob instanceof Blob&&blob.size===Number(asset.byte_size)
   &&(await digest(blob))===String(asset.sha256).toLowerCase();
 }
 async function assetList(){
  const out=[];let after='';
  for(;;){
   const rows=await api('sentlog_assets?kind=eq.photo&select=id,project_id,status,file_name,mime_type,byte_size,sha256,storage_path,metadata&order=id.asc&limit=400'+(after?'&id=gt.'+enc(after):''));
   if(!Array.isArray(rows))throw Error('写真一覧を確認できません。');
   if(!rows.length)return out;
   for(const row of rows){
    if(typeof row.id!=='string'||!row.id||row.id<=after)throw Error('写真一覧を最後まで確認できません。');
    after=row.id;out.push(row);
   }
  }
 }
 function currentPhotoKeys(){
  const keys=new Set(),projects=new Set();
  const storage=window.SentlogRecords;
  if(!storage)return {keys,projects};
  let ws;try{ws=JSON.parse(storage.getItem('surveyFieldNoteWorkspaceV1')||'{"projects":[]}');}catch{return {keys,projects};}
  for(const p of ws.projects||[]){
   for(const d of p.drawings||[]){
    let state;try{state=JSON.parse(storage.getItem('surveyFieldNoteDrawingV1:'+d.id)||'null');}catch{continue;}
    if(!state)continue;
    for(const shape of state.shapes||[])for(const photo of shape.photos||[]){
     if(photo?.id)keys.add(photoKey(d.id,photo.id));
    }
   }
  }
  return {keys,projects};
 }
 async function activeProjectIds(){
  const rows=await api('sentlog_projects?status=eq.active&select=id');
  return new Set((rows||[]).map(p=>p.id));
 }
 async function localPhoto(key){
  const connection=await new Promise((resolve,reject)=>{
   const q=indexedDB.open('surveyFieldNoteDB',1);
   q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('files'))q.result.createObjectStore('files');};
   q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });
  try{return await new Promise((resolve,reject)=>{
   const q=connection.transaction('files','readonly').objectStore('files').get(key);
   q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });}finally{connection.close();}
 }
 async function downloaded(asset){
  const path=String(asset.storage_path).split('/').map(enc).join('/');
  const s=session(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
  try{
   const r=await fetch(BASE+'/storage/v1/object/authenticated/'+BUCKET+'/'+path,{
    cache:'no-store',signal:controller.signal,headers:{apikey:KEY,Authorization:'Bearer '+s.access_token}
   });
   if(!r.ok)throw Error('写真の受信に失敗しました（'+r.status+'）');
   const blob=await r.blob();if(!await matches(blob,asset))throw Error('写真の内容照合に失敗しました。');
   return blob;
  }finally{clearTimeout(timer);}
 }
 async function pcRoot(){
  const root=await window.idbGet?.('root');
  if(!root||typeof root.queryPermission!=='function')throw Error('PC保管フォルダが設定されていません。');
  const permission=await root.queryPermission({mode:'readwrite'});
  if(permission!=='granted')throw Error('会社PCの「保存許可を確認」を押してください。');
  return root;
 }
 async function pcPhoto(asset){
  const receipts=await api('sentlog_pc_receipts?asset_id=eq.'+enc(asset.id)+'&select=pc_path,sha256,byte_size&limit=1');
  const receipt=receipts?.[0];
  if(!receipt||String(receipt.sha256).toLowerCase()!==String(asset.sha256).toLowerCase()
      ||Number(receipt.byte_size)!==Number(asset.byte_size))throw Error('PCの写真保存記録が一致しません。');
  const root=await pcRoot();
  const parts=String(receipt.pc_path||'').split(/[\\/]+/);
  if(parts[0]!==root.name||parts.length<3||parts.some(x=>!x||x==='.'||x==='..'))
   throw Error('PCの保管場所が一致しません。');
  let d=root;
  try{
   for(const name of parts.slice(1,-1))d=await d.getDirectoryHandle(name);
   const file=await(await d.getFileHandle(parts.at(-1))).getFile();
   if(!await matches(file,asset))throw Error('会社PCの写真が保存時の内容と一致しません：'+asset.file_name);
   if(file.size>22*1024*1024)throw Error('22MBを超える写真はこの再送方式の対象外です：'+asset.file_name);
   return file;
  }catch(e){
   if(e?.name==='NotFoundError')throw Error('会社PCに写真の原本が見つかりません：'+asset.file_name);
   throw e;
  }
 }
 async function uploadPhoto(asset,id){
  const mime=String(asset.mime_type||'').toLowerCase();
  if(!allowed.has(mime))throw Error('登録された写真形式を確認できません：'+asset.file_name);
  // Before claiming, actually read the PC original and verify every byte.
  const file=await pcPhoto(asset);
  const claim=await rpc('sentlog_claim_photo_redelivery',{p_asset_id:asset.id,p_device_id:id,p_sha256:asset.sha256,p_byte_size:Number(asset.byte_size)});
  if(!claim?.claimed)return false;
  const path=String(claim.storage_path).split('/').map(enc).join('/');
  const s=session();
  const r=await fetch(BASE+'/storage/v1/object/'+BUCKET+'/'+path,{
   method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+s.access_token,'Content-Type':mime,'x-upsert':'false'},body:file
  });
  if(!r.ok){const data=await r.json().catch(()=>({}));
   throw Error('写真の再送に失敗しました（'+r.status+'）：'+(data.error||data.message||'保存形式を確認してください。'));
  }
  await rpc('sentlog_finish_photo_redelivery',{p_asset_id:asset.id,p_device_id:id,p_token:claim.token});
  return true;
 }
 async function receive(id){
  const refs=currentPhotoKeys().keys;
  if(!refs.size){show('');return;}
  const active=await activeProjectIds(),assets=await assetList();
  let seen=0,good=0,waiting=0,errors=[],newFiles=0;
  for(const a of assets||[]){
   if(!active.has(a.project_id))continue;
   const drawing=a.metadata?.drawing_id,photo=a.metadata?.photo_id;
   if(!drawing||!photo||!refs.has(photoKey(drawing,photo)))continue;
   seen++;
   const key=photoKey(drawing,photo),local=await localPhoto(key);
   if(await matches(local,a)){
    good++;if(a.status!=='storage_deleted')await rpc('sentlog_ack_photo',{p_asset_id:a.id,p_device_id:id,p_sha256:a.sha256,p_byte_size:Number(a.byte_size)});
    continue;
   }
   if(local instanceof Blob&&local.size>0){
    errors.push('内容が異なる写真があります。上書きせず停止しました：'+(a.file_name||'写真'));
    continue;
   }
   if(a.status!=='storage_deleted'){
    try{
     const blob=await downloaded(a);
     if(!window.SentlogRecords?.ready)throw Error('保存先が未準備です。');
     await window.SentlogRecords.writeFile(key,new File([blob],a.file_name||'photo.jpg',{type:a.mime_type||blob.type}));
     if(!await matches(await localPhoto(key),a))throw Error('端末内の写真照合に失敗しました。');
     await rpc('sentlog_ack_photo',{p_asset_id:a.id,p_device_id:id,p_sha256:a.sha256,p_byte_size:Number(a.byte_size)});
     good++;newFiles++;
     window.sentlogSyncView?.photoReceived?.(drawing);
     if(typeof window.renderSelectedPhotos==='function' && window.activeDrawingId===drawing)
       window.renderSelectedPhotos();
    }catch(e){errors.push((a.file_name||'写真')+'：'+e.message);}
   }else{
    waiting++;
    const last=lastRequested.get(a.id)||0;
    if(Date.now()-last>25000){
     try{
      const request=await rpc('sentlog_request_photo',{p_asset_id:a.id,p_device_id:id});
      if(!request?.requested)errors.push(request?.reason||'PCの写真保存を確認できません。');
      else lastRequested.set(a.id,Date.now());
     }catch(e){errors.push((a.file_name||'写真')+'：'+e.message);}
    }
   }
  }
  if(!seen){show('');return;}
  if(errors.length)show('写真の確認が必要です：'+errors.slice(0,3).join(' / ')+'（保存済み '+good+'/'+seen+' 件）');
  else if(waiting)show('写真 '+waiting+' 件を会社PCから再取得待ち。PC自動同期画面を開き、保存先の許可を確認してください。（確認済み '+good+'/'+seen+' 件）');
  else if(newFiles)show('写真 '+good+'/'+seen+' 件を保存・照合しました。図面を開くと確認できます。');
  else show('写真 '+good+'/'+seen+' 件を確認済み。');
 }
 async function provide(id){
  const requests=await pcPendingRequests();
  if(!(requests||[]).length){show('写真の再取得依頼はありません。');return;}
  // InPrivate browser registrations may outlive the browser by days. The server
  // allows temporary cloud files to expire after 15 minutes of inactivity;
  // never re-upload an archived original for those expired requests.
  // Use the same active / requested-at / last-seen check as the cloud deletion guard.
  const devices=await api('sentlog_devices?active=eq.true&select=id,last_seen_at&limit=5000');
  const activeDevices=new Map((devices||[]).map(d=>[d.id,d]));
  const cutoff=Date.now()-15*60*1000;
  const fresh=(requests||[]).filter(r=>{
    const d=activeDevices.get(r.device_id);
    return !!d&&(Date.parse(r.requested_at)>=cutoff||Date.parse(d.last_seen_at)>=cutoff);
  });
  const desired=new Set(fresh.map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));
  if(!desired.size){
    show('古い端末の未受信依頼は自動再送しません。新しい端末で再取得が必要になれば再開します。');
    return;
  }
  const assets=await requestedPhotoAssets(desired),active=await activeProjectIds();
  const pending=(assets||[]).filter(a=>active.has(a.project_id)&&a.status==='storage_deleted'
    &&desired.has(a.id+':'+String(a.sha256).toLowerCase()));
  let count=0,errors=[];
  const take=Math.min(8,pending.length),start=pending.length?pcProvidedCursor%pending.length:0;
  const batch=Array.from({length:take},(_,i)=>pending[(start+i)%pending.length]);
  pcProvidedCursor=pending.length?(start+take)%pending.length:0;
  for(const a of batch){
   try{if(await uploadPhoto(a,id))count++;}
   catch(e){errors.push((a.file_name||'写真')+'：'+e.message);}
  }
  if(errors.length)show('写真再取得エラー：'+errors.slice(0,3).join(' / '));
  else if(count)show('写真 '+count+' 件をPC原本から再送しました。受信端末の保存確認待ちです。');
  else if(pending.length)show('写真の再送確認待ちです。受信側セントログも開いてください。');
  else show('写真の再取得依頼はありません。');
 }
 // A newly registered device may leave thousands of pending receipts.
 // Walk them incrementally instead of repeatedly fetching 5,000 rows.
 async function pcPendingRequests(){
   const out=[];let last=pcRequestCursor,exhausted=false;
   for(let page=0;page<3;page++){
     const cursor=last?'&or='+enc('(asset_id.gt.'+last.asset_id+',and(asset_id.eq.'+last.asset_id+',device_id.gt.'+last.device_id+'))'):'';
     const rows=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,device_id,expected_sha256,requested_at&order=asset_id.asc,device_id.asc&limit=400'+cursor);
     if(!Array.isArray(rows))throw Error('写真の受信待ち一覧を確認できません。');
     if(!rows.length){exhausted=true;break;}
     for(const row of rows){
       if(!row.asset_id||!row.device_id||(last&&(row.asset_id<last.asset_id||(row.asset_id===last.asset_id&&row.device_id<=last.device_id))))throw Error('写真の受信待ち情報が重複しています。');
       last=row;out.push(row);
     }
     if(rows.length<400){exhausted=true;break;}
   }
   pcRequestCursor=exhausted?null:last;
   return out;
 }
 // Query only demanded photo IDs, not the entire historical asset catalog.
 async function requestedPhotoAssets(desired){
   const ids=[...new Set([...desired].map(v=>v.split(':')[0]))],out=[];
   for(let at=0;at<ids.length;at+=75){
     const chunk=ids.slice(at,at+75);
     if(!chunk.every(id=>/^[0-9a-f-]{36}$/i.test(id)))throw Error('写真の識別情報が不正です。');
     const rows=await api('sentlog_assets?kind=eq.photo&status=eq.storage_deleted&id=in.('+chunk.map(enc).join(',')+')&select=id,project_id,status,file_name,mime_type,byte_size,sha256,storage_path,metadata&limit=100');
     if(!Array.isArray(rows)||rows.some(a=>!chunk.includes(a.id)))throw Error('写真の再配信対象を確認できません。');
     out.push(...rows);
   }
   return out;
 }
 async function run(force=false){
  if(busy||!navigator.onLine||document.hidden||window.sentlogImporting||(!IS_PC&&!window.SentlogRecords?.ready))return;
  if(IS_PC&&force!==true&&Date.now()<nextPcScan)return;
  const s=session(),id=device();if(!s?.access_token||!id)return;
  if(s.expires_at&&s.expires_at*1000<Date.now()+5000)return;
  busy=true;
  try{
   if(IS_PC)await window.ensureSession?.();
   else await window.sentlogManagementSession?.();
   if(IS_PC)await provide(id);else await receive(id);
   if(IS_PC){pcFailureCount=0;nextPcScan=Date.now()+60000;}
  }catch(e){
   if(IS_PC){pcFailureCount=Math.min(5,pcFailureCount+1);nextPcScan=Date.now()+Math.min(600000,60000*Math.pow(2,pcFailureCount-1));}
   show('写真の再取得を確認できません：'+e.message);
  }
  finally{busy=false;}
 }
 const ready=IS_PC?Promise.resolve():Promise.resolve(window.sentlogAppReady);
 ready.then(()=>{mount();setTimeout(run,2500);setInterval(run,15000);}).catch(e=>console.warn('Photo recovery unavailable',e));
 window.addEventListener('online',run);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)run();});
 window.sentlogCheckPhotoRecovery=run;
})();

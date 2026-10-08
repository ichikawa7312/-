import { createSyncStatusView } from './sync-status.js?v=127';
const syncStatus=createSyncStatusView();
const SUPABASE_URL='https://wiulvaqixphuobdielyy.supabase.co';
const SUPABASE_KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
const SESSION_KEY='sentlogCloudSessionV1';
const DEVICE_KEY='sentlogCloudDeviceV1';
const WORKSPACE_KEY='surveyFieldNoteWorkspaceV1';
const DRAWING_KEY_PREFIX='surveyFieldNoteDrawingV1:';
const DB_NAME='surveyFieldNoteDB';
const BUCKET='sentlog-temp';
const SYNC_META_PREFIX='sentlogCloudProjectSyncV2:';
let session=null;
let syncing=false;
let syncTimer=null;

const enc=s=>encodeURIComponent(String(s));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const snapshotFingerprint=payload=>sha256Hex(new Blob([window.sentlogSyncView?.snapshotText(payload)||JSON.stringify(payload)]));
const headers=(extra={})=>({
  'apikey':SUPABASE_KEY,
  ...(session?.access_token?{'Authorization':'Bearer '+session.access_token}:{}),
  ...extra
});

function loadSession(){
  try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{session=null}
}
function saveSession(s){
  session=s||null;
  if(session)localStorage.setItem(SESSION_KEY,JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
  updateCloudUI();
}
function tokenExpired(){
  if(!session?.access_token)return true;
  const exp=session.expires_at||0;
  return Date.now()/1000 > exp-60;
}
async function refreshSession(){
  if(!session?.refresh_token)throw new Error('ログインが必要です');
  const r=await fetch(SUPABASE_URL+'/auth/v1/token?grant_type=refresh_token',{
    method:'POST',headers:{'apikey':SUPABASE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({refresh_token:session.refresh_token})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j?.msg||j?.message||'ログイン更新に失敗しました');
  j.expires_at=Math.floor(Date.now()/1000)+(j.expires_in||3600);
  saveSession(j);return j;
}
async function ensureSession(){
  if(!session)throw new Error('ログインが必要です');
  if(tokenExpired())await refreshSession();
  return session;
}
async function rest(path,opts={}){
  await ensureSession();
  const r=await fetch(SUPABASE_URL+path,{
    ...opts,
    headers:headers({'Content-Type':'application/json',...(opts.headers||{})})
  });
  const txt=await r.text();
  let data=null;try{data=txt?JSON.parse(txt):null}catch{data=txt}
  if(!r.ok)throw new Error(data?.message||data?.msg||data?.error_description||String(data||r.status));
  return data;
}
async function authPassword(email,password){
  const r=await fetch(SUPABASE_URL+'/auth/v1/token?grant_type=password',{
    method:'POST',headers:{'apikey':SUPABASE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j?.msg||j?.message||j?.error_description||'ログインできません');
  j.expires_at=Math.floor(Date.now()/1000)+(j.expires_in||3600);
  saveSession(j);return j;
}
async function authSignup(email,password){
  const r=await fetch(SUPABASE_URL+'/auth/v1/signup',{
    method:'POST',headers:{'apikey':SUPABASE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j?.msg||j?.message||'登録できません');
  if(j.access_token){
    j.expires_at=Math.floor(Date.now()/1000)+(j.expires_in||3600);
    saveSession(j);
  }
  return j;
}

function deviceType(){
  const ua=navigator.userAgent||'';
  if(/iPhone/i.test(ua))return 'iphone';
  if(/iPad/i.test(ua)||(/Macintosh/i.test(ua)&&navigator.maxTouchPoints>1))return 'ipad';
  return 'browser';
}
function deviceName(){
  const t=deviceType();
  return t==='ipad'?'iPad セントログ':t==='iphone'?'iPhone セントログ':'ブラウザ セントログ';
}
async function ensureDevice(){
  await ensureSession();
  let id=localStorage.getItem(DEVICE_KEY);
  if(id){
    try{
      const q=await rest('/rest/v1/sentlog_devices?id=eq.'+enc(id)+'&select=id,active');
      if(Array.isArray(q)&&q[0]?.active){
        await rest('/rest/v1/sentlog_devices?id=eq.'+enc(id),{
          method:'PATCH',headers:{'Prefer':'return=minimal'},
          body:JSON.stringify({last_seen_at:new Date().toISOString()})
        });
        return id;
      }
    }catch{}
  }
  const body={p_device_name:deviceName(),p_device_type:deviceType()};
  id=await rest('/rest/v1/rpc/sentlog_register_device',{method:'POST',body:JSON.stringify(body)});
  if(typeof id==='string')id=id.replace(/^"|"$/g,'');
  localStorage.setItem(DEVICE_KEY,id);return id;
}

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('files'))db.createObjectStore('files')};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
}
async function dbGet(key){
  const db=await openDB();
  const v=await new Promise((resolve,reject)=>{
    const tx=db.transaction('files','readonly'),q=tx.objectStore('files').get(key);
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });
  db.close();return v;
}
async function dbPut(key,value){return window.putDBFile(key,value);}
async function sha256Hex(blob){
  const buf=await blob.arrayBuffer();
  const hash=await crypto.subtle.digest('SHA-256',buf);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function workspace(){
  try{return JSON.parse(window.SentlogRecords.getItem(WORKSPACE_KEY)||'{"projects":[]}')}catch{return {projects:[]}}
}
function drawingState(id){
  try{return JSON.parse(window.SentlogRecords.getItem(DRAWING_KEY_PREFIX+id)||'null')}catch{return null}
}

async function ensureCloudProject(localProject){
  const query=await rest('/rest/v1/sentlog_projects?client_key=eq.'+enc(localProject.id)+'&select=id,name,status,client_key');
  if(Array.isArray(query)&&query[0])return query[0];
  const payload={owner_id:session.user.id,client_key:localProject.id,name:localProject.name||'案件',status:'active'};
  const made=await syncStatus.track('案件を送信中',()=>rest('/rest/v1/sentlog_projects',{method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify(payload)}));
  return made[0];
}

function saveWorkspace(ws){window.SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(ws))}
function getSyncMeta(projectId){
  try{return JSON.parse(window.SentlogRecords.getItem(SYNC_META_PREFIX+projectId)||'null')}catch{return null}
}
function setSyncMeta(projectId,meta){
  window.SentlogRecords.setItem(SYNC_META_PREFIX+projectId,JSON.stringify(meta||{}));
}
function projectSnapshot(localProject){
  const drawings=(localProject.drawings||[]).map(d=>{
    const st=drawingState(d.id);
    if(!st)return {meta:d,state:null};
    const safe=typeof structuredClone==='function'?structuredClone(st):JSON.parse(JSON.stringify(st));
    (safe.shapes||[]).forEach(s=>(s.photos||[]).forEach(p=>{delete p.localBlob;delete p.data}));
    return {meta:d,state:safe};
  });
  return {project:localProject,drawings};
}
async function upsertSnapshot(cloudProject,localProject,deviceId){
  const meta=getSyncMeta(localProject.id);
  const localUpdated=Number(localProject.updatedAt||0);
  if(meta && Number(meta.local_updated_at||0)===localUpdated)return {skipped:true,revision:Number(meta.revision||0)};
  const current=await rest('/rest/v1/sentlog_project_snapshots?project_id=eq.'+enc(cloudProject.id)+'&select=revision');
  const remoteRevision=Number(current?.[0]?.revision||0);
  if(remoteRevision>Number(meta?.revision||0))return {skipped:true,pending:true};
  const rev=remoteRevision+1;
  const updatedAt=new Date().toISOString();
  const payload={project_id:cloudProject.id,owner_id:session.user.id,revision:rev,payload:projectSnapshot(localProject),updated_by_device:deviceId,updated_at:updatedAt};
  const fingerprint=await snapshotFingerprint(payload.payload);
  const made=await syncStatus.track('変状データを送信中',()=>rest('/rest/v1/sentlog_project_snapshots?on_conflict=project_id',{
    method:'POST',
    headers:{'Prefer':'resolution=merge-duplicates,return=representation'},
    body:JSON.stringify(payload)
  }));
  setSyncMeta(localProject.id,{revision:rev,local_updated_at:localUpdated,remote_updated_at:made?.[0]?.updated_at||updatedAt,fingerprint});
  return {skipped:false,revision:rev};
}
function collectPhotos(localProject){
  const out=[];
  for(const d of localProject.drawings||[]){
    const st=drawingState(d.id);if(!st)continue;
    for(const sh of st.shapes||[]){
      for(const p of sh.photos||[]){
        out.push({drawingId:d.id,drawingName:d.name||'',shapeId:sh.id,shapeType:sh.type||'',shapeLabel:sh.autoLabel||'',photo:p});
      }
    }
  }
  return out;
}
function collectDrawings(localProject){
  return (localProject.drawings||[]).map(d=>({drawingId:d.id,drawingName:d.name||'',fileName:d.fileName||'',sourceType:d.sourceType||''}));
}
async function existingAsset(clientKey){
  const a=await rest('/rest/v1/sentlog_assets?client_key=eq.'+enc(clientKey)+'&select=id,status,sha256,byte_size,storage_path,kind');
  return a?.[0]||null;
}
function extForBlob(blob,fileName=''){
  const n=String(fileName||'').toLowerCase();
  if(n.endsWith('.pdf')||blob.type==='application/pdf')return '.pdf';
  if(n.endsWith('.png')||blob.type==='image/png')return '.png';
  if(n.endsWith('.webp')||blob.type==='image/webp')return '.webp';
  if(n.endsWith('.heic')||blob.type==='image/heic')return '.heic';
  if(n.endsWith('.heif')||blob.type==='image/heif')return '.heif';
  return '.jpg';
}
async function uploadAsset({cloudProject,deviceId,clientKey,kind,fileName,blob,storageFolder,metadata,capturedAt}){
  if(!(blob instanceof Blob))return {status:'missing'};
  const hash=await sha256Hex(blob);
  const existing=await existingAsset(clientKey);
  if(existing && String(existing.sha256).toLowerCase()===hash && Number(existing.byte_size)===blob.size){
    return {status:'exists',asset:existing};
  }
  const ext=extForBlob(blob,fileName);
  const storagePath=session.user.id+'/'+cloudProject.id+'/'+storageFolder+'/'+clientKey.replace(/[^a-zA-Z0-9:_-]/g,'_')+ext;
  const up=await syncStatus.track((kind==='drawing'?'PDF・図面':'写真')+'を送信中',()=>fetch(SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+storagePath,{
    method:'POST',headers:headers({'Content-Type':blob.type||'application/octet-stream','x-upsert':'true'}),body:blob
  }));
  if(!up.ok)throw new Error('ファイル送信に失敗: '+await up.text());

  const payload={
    owner_id:session.user.id,project_id:cloudProject.id,source_device_id:deviceId,
    client_key:clientKey,kind,file_name:fileName||('file'+ext),storage_path:storagePath,
    mime_type:blob.type||'application/octet-stream',byte_size:blob.size,sha256:hash,status:'uploaded',
    captured_at:capturedAt||new Date().toISOString(),metadata:metadata||{},updated_at:new Date().toISOString()
  };
  if(existing){
    const made=await rest('/rest/v1/sentlog_assets?id=eq.'+enc(existing.id),{
      method:'PATCH',headers:{'Prefer':'return=representation'},body:JSON.stringify(payload)
    });
    return {status:'uploaded',asset:made?.[0]};
  }
  try{
    const made=await rest('/rest/v1/sentlog_assets',{
      method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify(payload)
    });
    return {status:'uploaded',asset:made?.[0]};
  }catch(e){
    const dup=await existingAsset(clientKey).catch(()=>null);
    if(dup){
      if(dup.status==='storage_deleted'){
        try{await fetch(SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+storagePath,{method:'DELETE',headers:headers()})}catch{}
      }
      return {status:'exists',asset:dup};
    }
    throw e;
  }
}
async function uploadPhoto(cloudProject,deviceId,item){
  const p=item.photo;
  const blob=await dbGet('photo:'+item.drawingId+':'+p.id);
  return uploadAsset({
    cloudProject,deviceId,clientKey:'photo:'+item.drawingId+':'+p.id,kind:'photo',
    fileName:p.name||('photo-'+p.id+'.jpg'),blob,storageFolder:'photos',
    capturedAt:p.createdAt?new Date(p.createdAt).toISOString():new Date().toISOString(),
    metadata:{local_project_key:cloudProject.client_key||'',drawing_id:item.drawingId,drawing_name:item.drawingName,shape_id:item.shapeId,shape_type:item.shapeType,shape_label:item.shapeLabel,photo_id:p.id}
  });
}

// Drawing quality takes priority. Never rasterize or JPEG-recompress a PDF.
// The original bytes are uploaded as-is; larger files require explicit splitting.
const PDF_SYNC_LIMIT=22*1024*1024;
async function optimizePdfForSync(blob){
  if(!(blob instanceof Blob))throw new Error('PDFファイルを読み取れません');
  if(blob.size>PDF_SYNC_LIMIT)throw new Error('PDFが22MBを超えています。画質を守るため自動画像化はしません。元PDFを22MB以下に分割して追加してください。');
  return {blob,optimized:false,originalSize:blob.size};
}

async function uploadDrawing(cloudProject,deviceId,item){
  const key='background:'+item.drawingId;
  let blob=await dbGet(key);
  if(!(blob instanceof Blob))return {status:'missing'};
  const fileName=item.fileName||item.drawingName||('drawing-'+item.drawingId);
  let optimization={blob,optimized:false,originalSize:blob.size};
  const isPdf=item.sourceType==='pdf'||blob.type==='application/pdf'||/\.pdf$/i.test(fileName);
  if(isPdf)optimization=await optimizePdfForSync(blob);
  return uploadAsset({
    cloudProject,deviceId,clientKey:'drawing:'+item.drawingId,kind:'drawing',
    fileName,blob,storageFolder:'drawings',
    metadata:{
      local_project_key:cloudProject.client_key||'',drawing_id:item.drawingId,drawing_name:item.drawingName,
      source_type:item.sourceType,optimized_for_sync:false,pdf_quality_policy:'original-bytes-v122',
      original_byte_size:optimization.originalSize,sync_byte_size:blob.size
    }
  });
}
async function downloadPrivateAsset(asset){
  const parts=String(asset.storage_path||'').split('/').map(enc).join('/');
  const blob=await syncStatus.track((asset.kind==='drawing'?'PDF・図面':'写真')+'を受信中',async()=>{
    const r=await fetch(SUPABASE_URL+'/storage/v1/object/authenticated/'+BUCKET+'/'+parts,{headers:headers()});
    if(!r.ok)throw new Error('クラウドファイル取得失敗: '+r.status);
    return await r.blob();
  });
  if(Number(asset.byte_size)!==blob.size)throw new Error('クラウドファイルのサイズ照合NG');
  const hash=await sha256Hex(blob);
  if(hash.toLowerCase()!==String(asset.sha256||'').toLowerCase())throw new Error('クラウドファイルのSHA-256照合NG');
  return blob;
}
async function ackAsset(assetId,deviceId){
  await rest('/rest/v1/rpc/sentlog_ack_asset',{method:'POST',body:JSON.stringify({p_asset_id:assetId,p_device_id:deviceId})});
}
async function pullProjectAssets(cloudProject,deviceId){
  const fields=enc('id,kind,file_name,storage_path,mime_type,byte_size,sha256,status,source_device_id,metadata');
  const assets=await rest('/rest/v1/sentlog_assets?project_id=eq.'+enc(cloudProject.id)+'&status=neq.storage_deleted&select='+fields);
  let received=0;
  for(const a of assets||[]){
    try{
      if(a.kind==='drawing'){
        const drawingId=a.metadata?.drawing_id;if(!drawingId)continue;
        const key='background:'+drawingId;
        const local=await dbGet(key);
        let same=false;
        if(local instanceof Blob && local.size===Number(a.byte_size)){
          same=(await sha256Hex(local)).toLowerCase()===String(a.sha256).toLowerCase();
        }
        if(!same){
          if(local instanceof Blob && local.size && window.sentlogSyncView && !window.sentlogSyncView.canReplaceDrawing(drawingId))continue;
          const file=await downloadPrivateAsset(a);await dbPut(key,file);received++;
          await window.sentlogSyncView?.fileReceived(drawingId,file);
        }
        if(a.source_device_id!==deviceId)await ackAsset(a.id,deviceId);
      }else if(a.kind==='photo'){
        if(a.source_device_id===deviceId)continue;
        const drawingId=a.metadata?.drawing_id,photoId=a.metadata?.photo_id;
        if(!drawingId||!photoId)continue;
        const key='photo:'+drawingId+':'+photoId;
        const local=await dbGet(key);
        let same=false;
        if(local instanceof Blob && local.size===Number(a.byte_size)){
          same=(await sha256Hex(local)).toLowerCase()===String(a.sha256).toLowerCase();
        }
        if(!same){await dbPut(key,await downloadPrivateAsset(a));received++;window.sentlogSyncView?.photoReceived(drawingId);}
        await ackAsset(a.id,deviceId);
      }
    }catch(e){console.warn('asset pull failed',a?.id,e)}
  }
  return received;
}
async function pullRemoteProjects(deviceId){
  const cps=await rest('/rest/v1/sentlog_projects?status=eq.active&select=id,name,client_key,updated_at');
  const blocked=new Set();let changed=0,files=0,conflicts=0;
  for(const cp of cps||[]){
    if(!cp.client_key)continue;
    const snaps=await rest('/rest/v1/sentlog_project_snapshots?project_id=eq.'+enc(cp.id)+'&select=revision,payload,updated_at');
    const snap=snaps?.[0];if(!snap?.payload?.project)continue;
    // A prior request may have taken seconds; never reuse the workspace captured before it.
    const ws=workspace(),lp=(ws.projects||[]).find(p=>p.id===cp.client_key);
    const expectedLocal=JSON.stringify(lp||null),meta=getSyncMeta(cp.client_key);
    const remoteRev=Number(snap.revision||0);
    if(!lp || remoteRev>Number(meta?.revision||0) || !meta){
      const incomingFingerprint=await snapshotFingerprint(snap.payload);
      const localFingerprint=lp?await snapshotFingerprint(projectSnapshot(lp)):null;
      const localChanged=lp && meta && (meta.restored_backup || (meta.fingerprint?localFingerprint!==meta.fingerprint:Number(lp.updatedAt||0)!==Number(meta.local_updated_at||0)));
      if(localChanged && localFingerprint!==incomingFingerprint){
        // Do not resolve concurrent edits by silently replacing either device's work.
        blocked.add(cp.id);conflicts++;
      }else if(localFingerprint===incomingFingerprint){
        // Identical content can have different last-viewed pages and timestamps.
        if(JSON.stringify((workspace().projects||[]).find(p=>p.id===cp.client_key)||null)===expectedLocal)
          setSyncMeta(cp.client_key,{revision:remoteRev,local_updated_at:Number(lp.updatedAt||0),remote_updated_at:snap.updated_at,fingerprint:localFingerprint});
        else blocked.add(cp.id);
      }else{
        const result=await window.sentlogSyncView?.commit(cp,snap,expectedLocal);
        if(result?.applied){
          setSyncMeta(cp.client_key,{revision:remoteRev,local_updated_at:Number(snap.payload.project.updatedAt||0),remote_updated_at:snap.updated_at,fingerprint:incomingFingerprint});
          changed++;
        }else blocked.add(cp.id);
      }
    }
    // Do not change the underlying PDF while related metadata is waiting for a safe commit.
    if(!blocked.has(cp.id))files+=await pullProjectAssets(cp,deviceId);
  }
  return {changed,files,blocked,conflicts};
}

async function syncNow(){
  if(syncing||!navigator.onLine||!session||window.sentlogImporting)return;
  syncing=true;
  const statusCycle=syncStatus.begin();
  msg('');
  let remoteChanged=0;
  try{
    await window.sentlogAppReady;
    await window.SentlogRecords.flush();window.SentlogRecords.assertSafe();
    await ensureSession();
    const deviceId=await ensureDevice();
    const pulled=await pullRemoteProjects(deviceId);
    remoteChanged=pulled.changed;
    const ws=workspace();
    let uploaded=0;
    const drawingErrors=[];
    for(const lp of ws.projects||[]){
      const cp=await ensureCloudProject(lp);
      if(pulled.blocked.has(cp.id))continue;
      const snap=await upsertSnapshot(cp,lp,deviceId);
      if(snap.pending){pulled.blocked.add(cp.id);continue;}
      if(!snap.skipped)uploaded++;
      for(const item of collectDrawings(lp)){
        try{
          const r=await uploadDrawing(cp,deviceId,item);
          if(r.status==='uploaded')uploaded++;
        }catch(e){drawingErrors.push((item.fileName||item.drawingName||'PDF')+'：'+e.message)}
      }
      for(const item of collectPhotos(lp)){
        const r=await uploadPhoto(cp,deviceId,item);
        if(r.status==='uploaded')uploaded++;
      }
    }
    await window.SentlogRecords.flush();window.SentlogRecords.assertSafe();
    if(drawingErrors.length)syncStatus.finish(statusCycle,{level:'error',label:'PDF要確認',message:drawingErrors.join(' / ')});
    else if(pulled.conflicts)syncStatus.finish(statusCycle,{level:'error',label:'変更を要確認',message:'同じ案件がこの端末と別の端末で変更されています。どちらも自動では上書きしていません。'});
    else if(pulled.blocked.size)syncStatus.finish(statusCycle,{level:'pending',label:'作業後に反映',message:'操作中の変更は保留しています。入力・描画を終えると次の同期で反映します。PDFの差し替えや削除は図面を閉じた後に反映します。'});
    else syncStatus.finish(statusCycle,{level:'ok',message:(remoteChanged||pulled.files||uploaded?'変更の送受信が終了しました。':'変更の確認が終了しました。')+' PDFの保存・再取得状況は、PDF確認欄に表示します。'});
  }catch(e){
    console.warn('Sentlog cloud sync',e);
    syncStatus.finish(statusCycle,{level:'error',label:'同期を要確認',message:'同期は完了していません。'+(e?.message||String(e))});
  }finally{syncing=false}
}

function modalHtml(){
  return `<div id="sentlogCloudModal" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);align-items:center;justify-content:center;padding:18px">
    <div style="width:min(420px,100%);background:#fff;color:#111827;border-radius:14px;padding:18px;box-shadow:0 24px 70px rgba(0,0,0,.3)">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b style="font-size:18px">セントログ同期</b><button id="sentlogCloudClose" style="width:auto">閉じる</button></div>
      <p style="font-size:13px;color:#4b5563;line-height:1.6">案件・図面・変状をPC / iPad / iPhone間で双方向同期します。写真は端末にも残しつつ一時的にクラウドへ送り、会社PC保存とオンライン端末への配信確認後にクラウド写真を削除します。</p>
      <div id="sentlogCloudLoggedOut">
        <label style="font-size:12px;color:#6b7280">メールアドレス<input id="sentlogCloudEmail" type="email" autocomplete="username" style="margin-top:4px"></label>
        <label style="font-size:12px;color:#6b7280;margin-top:10px">パスワード<input id="sentlogCloudPassword" type="password" minlength="8" autocomplete="current-password" style="margin-top:4px"></label>
        <div style="display:flex;gap:8px;margin-top:12px"><button id="sentlogCloudLogin" style="flex:1;background:#111827;color:#fff">ログイン</button><button id="sentlogCloudSignup" style="flex:1">初回登録</button></div>
      </div>
      <div id="sentlogCloudLoggedIn" style="display:none">
        <div id="sentlogCloudWho" style="padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px"></div>
        <div style="display:flex;gap:8px;margin-top:12px"><button id="sentlogCloudSyncNow" style="flex:1;background:#111827;color:#fff">今すぐ同期</button><button id="sentlogCloudLogout" style="flex:1">ログアウト</button></div>
      </div>
      <div id="sentlogCloudDetails"></div>
      <div id="sentlogCloudMsg" style="min-height:20px;margin-top:10px;font-size:12px;color:#b91c1c"></div>
    </div></div>`;
}
function buildUI(){
  document.body.insertAdjacentHTML('beforeend',modalHtml());
  const header=document.querySelector('header');
  if(header){
    const b=document.createElement('button');
    b.id='sentlogCloudStatus';b.type='button';
    b.setAttribute('aria-haspopup','dialog');b.setAttribute('aria-controls','sentlogCloudModal');
    b.onclick=openModal;header.insertBefore(b,header.querySelector('.status'));
  }
  syncStatus.mount(document.getElementById('sentlogCloudStatus'),document.getElementById('sentlogCloudDetails'));
  document.getElementById('sentlogCloudClose').onclick=closeModal;
  document.getElementById('sentlogCloudLogin').onclick=doLogin;
  document.getElementById('sentlogCloudSignup').onclick=doSignup;
  document.getElementById('sentlogCloudLogout').onclick=()=>{saveSession(null);msg('');closeModal()};
  document.getElementById('sentlogCloudSyncNow').onclick=()=>{closeModal();syncNow()};
  updateCloudUI();
}
function openModal(){document.getElementById('sentlogCloudModal').style.display='flex';updateCloudUI();syncStatus.refresh()}
function closeModal(){document.getElementById('sentlogCloudModal').style.display='none'}
function msg(t,ok=false){const e=document.getElementById('sentlogCloudMsg');if(!e)return;e.textContent=t;e.style.color=ok?'#065f46':'#b91c1c'}
function updateCloudUI(){
  syncStatus.setAccount(session?.user?.id||'');
  syncStatus.setOnline(navigator.onLine);
  const out=document.getElementById('sentlogCloudLoggedOut'),inn=document.getElementById('sentlogCloudLoggedIn');
  if(!out||!inn)return;
  const logged=!!session?.user?.email;
  out.style.display=logged?'none':'block';inn.style.display=logged?'block':'none';
  if(logged)document.getElementById('sentlogCloudWho').textContent='ログイン中：'+session.user.email;
}
async function doLogin(){
  msg('ログイン中…',true);
  try{
    const e=document.getElementById('sentlogCloudEmail').value.trim();
    const p=document.getElementById('sentlogCloudPassword').value;
    await authPassword(e,p);await ensureDevice();msg('ログインしました。同期を開始します。',true);updateCloudUI();closeModal();syncNow();
  }catch(e){msg(e.message||String(e))}
}
async function doSignup(){
  msg('登録中…',true);
  try{
    const e=document.getElementById('sentlogCloudEmail').value.trim();
    const p=document.getElementById('sentlogCloudPassword').value;
    if(!e||p.length<8)throw new Error('メールアドレスと8文字以上のパスワードを入力してください');
    const j=await authSignup(e,p);
    if(j.access_token){await ensureDevice();msg('登録しました。同期を開始します。',true);closeModal();syncNow()}
    else msg('確認メールを送りました。メール内の確認後、「ログイン」を押してください。',true);
  }catch(e){msg(e.message||String(e))}
}

loadSession();
syncStatus.setAccount(session?.user?.id||'');
syncStatus.setOnline(navigator.onLine);
window.addEventListener('offline',()=>syncStatus.setOnline(false));
window.addEventListener('online',()=>{syncStatus.setOnline(true);syncNow()});
window.addEventListener('focus',()=>syncNow());
window.addEventListener('pageshow',()=>syncNow());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncNow()});
document.addEventListener('change',e=>{
  if(e.target?.id==='cameraInput'||e.target?.id==='photoInput')setTimeout(syncNow,2500);
},true);
setTimeout(()=>{buildUI();if(session&&navigator.onLine)syncNow()},800);
syncTimer=setInterval(()=>{if(session&&navigator.onLine)syncNow()},5000);
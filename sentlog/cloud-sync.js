const SUPABASE_URL='https://wiulvaqixphuobdielyy.supabase.co';
const SUPABASE_KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
const SESSION_KEY='sentlogCloudSessionV1';
const DEVICE_KEY='sentlogCloudDeviceV1';
const WORKSPACE_KEY='surveyFieldNoteWorkspaceV1';
const DRAWING_KEY_PREFIX='surveyFieldNoteDrawingV1:';
const DB_NAME='surveyFieldNoteDB';
const BUCKET='sentlog-temp';

let session=null;
let syncing=false;
let syncTimer=null;

const enc=s=>encodeURIComponent(String(s));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
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
      if(Array.isArray(q)&&q[0]?.active)return id;
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
async function sha256Hex(blob){
  const buf=await blob.arrayBuffer();
  const hash=await crypto.subtle.digest('SHA-256',buf);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function workspace(){
  try{return JSON.parse(localStorage.getItem(WORKSPACE_KEY)||'{"projects":[]}')}catch{return {projects:[]}}
}
function drawingState(id){
  try{return JSON.parse(localStorage.getItem(DRAWING_KEY_PREFIX+id)||'null')}catch{return null}
}

async function ensureCloudProject(localProject){
  const query=await rest('/rest/v1/sentlog_projects?client_key=eq.'+enc(localProject.id)+'&select=id,name,status,client_key');
  if(Array.isArray(query)&&query[0])return query[0];
  const payload={owner_id:session.user.id,client_key:localProject.id,name:localProject.name||'案件',status:'active'};
  const made=await rest('/rest/v1/sentlog_projects',{method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify(payload)});
  return made[0];
}

function projectSnapshot(localProject){
  const drawings=(localProject.drawings||[]).map(d=>{
    const st=drawingState(d.id);
    if(!st)return {meta:d,state:null};
    const safe=structuredClone?structuredClone(st):JSON.parse(JSON.stringify(st));
    (safe.shapes||[]).forEach(s=>(s.photos||[]).forEach(p=>{delete p.localBlob;delete p.data}));
    return {meta:d,state:safe};
  });
  return {project:localProject,drawings,exported_at:new Date().toISOString()};
}
async function upsertSnapshot(cloudProject,localProject,deviceId){
  const current=await rest('/rest/v1/sentlog_project_snapshots?project_id=eq.'+enc(cloudProject.id)+'&select=revision');
  const rev=(current?.[0]?.revision||0)+1;
  const payload={project_id:cloudProject.id,owner_id:session.user.id,revision:rev,payload:projectSnapshot(localProject),updated_by_device:deviceId,updated_at:new Date().toISOString()};
  await rest('/rest/v1/sentlog_project_snapshots?on_conflict=project_id',{
    method:'POST',
    headers:{'Prefer':'resolution=merge-duplicates,return=minimal'},
    body:JSON.stringify(payload)
  });
}
function collectPhotos(localProject){
  const out=[];
  for(const d of localProject.drawings||[]){
    const st=drawingState(d.id);if(!st)continue;
    for(const s of st.shapes||[]){
      for(const p of s.photos||[]){
        out.push({drawingId:d.id,drawingName:d.name||'',shapeId:s.id,shapeType:s.type||'',shapeLabel:s.autoLabel||'',photo:p});
      }
    }
  }
  return out;
}
async function existingAsset(clientKey){
  const a=await rest('/rest/v1/sentlog_assets?client_key=eq.'+enc(clientKey)+'&select=id,status,sha256,byte_size,storage_path');
  return a?.[0]||null;
}
async function uploadPhoto(cloudProject,deviceId,item){
  const p=item.photo;
  const clientKey='photo:'+item.drawingId+':'+p.id;
  const existing=await existingAsset(clientKey);
  if(existing)return {status:'exists',asset:existing};

  const blob=await dbGet('photo:'+item.drawingId+':'+p.id);
  if(!(blob instanceof Blob))throw new Error('端末内の写真データが見つかりません: '+(p.name||p.id));

  const hash=await sha256Hex(blob);
  const ext=(blob.type==='image/png'?'.png':blob.type==='image/webp'?'.webp':'.jpg');
  const storagePath=session.user.id+'/'+cloudProject.id+'/photos/'+item.drawingId+'/'+p.id+ext;
  const up=await fetch(SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+storagePath,{
    method:'POST',
    headers:headers({'Content-Type':blob.type||'image/jpeg','x-upsert':'true'}),
    body:blob
  });
  if(!up.ok){
    const msg=await up.text();throw new Error('写真送信に失敗: '+msg);
  }
  const payload={
    owner_id:session.user.id,project_id:cloudProject.id,source_device_id:deviceId,
    client_key:clientKey,kind:'photo',file_name:p.name||('photo-'+p.id+ext),
    storage_path:storagePath,mime_type:blob.type||'image/jpeg',byte_size:blob.size,
    sha256:hash,status:'uploaded',captured_at:p.createdAt?new Date(p.createdAt).toISOString():new Date().toISOString(),
    metadata:{local_project_key:localProjectKey(cloudProject),drawing_id:item.drawingId,drawing_name:item.drawingName,shape_id:item.shapeId,shape_type:item.shapeType,shape_label:item.shapeLabel,photo_id:p.id}
  };
  try{
    const made=await rest('/rest/v1/sentlog_assets',{method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify(payload)});
    return {status:'uploaded',asset:made?.[0]};
  }catch(e){
    try{await fetch(SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+storagePath,{method:'DELETE',headers:headers()})}catch{}
    throw e;
  }
}
function localProjectKey(cloudProject){return cloudProject.client_key||''}

function setStatus(text,kind=''){
  const el=document.getElementById('sentlogCloudStatus');
  if(!el)return;
  el.textContent=text;
  el.dataset.kind=kind;
  el.style.background=kind==='ok'?'#065f46':kind==='busy'?'#92400e':kind==='err'?'#991b1b':'#374151';
}
async function syncNow(){
  if(syncing||!navigator.onLine||!session)return;
  syncing=true;setStatus('☁ 同期中…','busy');
  try{
    await ensureSession();
    const deviceId=await ensureDevice();
    const ws=workspace();
    let uploaded=0,known=0;
    for(const lp of ws.projects||[]){
      const cp=await ensureCloudProject(lp);
      await upsertSnapshot(cp,lp,deviceId);
      for(const item of collectPhotos(lp)){
        const r=await uploadPhoto(cp,deviceId,item);
        if(r.status==='uploaded')uploaded++;else known++;
      }
    }
    setStatus(uploaded?('☁ '+uploaded+'枚送信済み'):'☁ 同期済み','ok');
  }catch(e){
    console.warn('Sentlog cloud sync',e);
    setStatus('☁ 同期待ち','err');
  }finally{syncing=false}
}

function modalHtml(){
  return `<div id="sentlogCloudModal" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);align-items:center;justify-content:center;padding:18px">
    <div style="width:min(420px,100%);background:#fff;color:#111827;border-radius:14px;padding:18px;box-shadow:0 24px 70px rgba(0,0,0,.3)">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b style="font-size:18px">セントログ同期</b><button id="sentlogCloudClose" style="width:auto">閉じる</button></div>
      <p style="font-size:13px;color:#4b5563;line-height:1.6">写真は端末にも残したまま、通信時だけ一時的にクラウドへ送ります。会社PCへの保存確認後、クラウド側の写真を削除する仕組みです。</p>
      <div id="sentlogCloudLoggedOut">
        <label style="font-size:12px;color:#6b7280">メールアドレス<input id="sentlogCloudEmail" type="email" autocomplete="username" style="margin-top:4px"></label>
        <label style="font-size:12px;color:#6b7280;margin-top:10px">パスワード<input id="sentlogCloudPassword" type="password" minlength="8" autocomplete="current-password" style="margin-top:4px"></label>
        <div style="display:flex;gap:8px;margin-top:12px"><button id="sentlogCloudLogin" style="flex:1;background:#111827;color:#fff">ログイン</button><button id="sentlogCloudSignup" style="flex:1">初回登録</button></div>
      </div>
      <div id="sentlogCloudLoggedIn" style="display:none">
        <div id="sentlogCloudWho" style="padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px"></div>
        <div style="display:flex;gap:8px;margin-top:12px"><button id="sentlogCloudSyncNow" style="flex:1;background:#111827;color:#fff">今すぐ同期</button><button id="sentlogCloudLogout" style="flex:1">ログアウト</button></div>
      </div>
      <div id="sentlogCloudMsg" style="min-height:20px;margin-top:10px;font-size:12px;color:#b91c1c"></div>
    </div></div>`;
}
function buildUI(){
  document.body.insertAdjacentHTML('beforeend',modalHtml());
  const header=document.querySelector('header');
  if(header){
    const b=document.createElement('button');
    b.id='sentlogCloudStatus';b.textContent='☁ 同期設定';
    b.style.cssText='width:auto;padding:7px 10px;border-radius:999px;background:#374151;color:#fff;border:1px solid #4b5563;font-size:12px;margin-left:4px';
    b.onclick=openModal;header.insertBefore(b,header.querySelector('.status'));
  }
  document.getElementById('sentlogCloudClose').onclick=closeModal;
  document.getElementById('sentlogCloudLogin').onclick=doLogin;
  document.getElementById('sentlogCloudSignup').onclick=doSignup;
  document.getElementById('sentlogCloudLogout').onclick=()=>{saveSession(null);closeModal();setStatus('☁ 同期設定')};
  document.getElementById('sentlogCloudSyncNow').onclick=()=>{closeModal();syncNow()};
  updateCloudUI();
}
function openModal(){document.getElementById('sentlogCloudModal').style.display='flex';updateCloudUI()}
function closeModal(){document.getElementById('sentlogCloudModal').style.display='none'}
function msg(t,ok=false){const e=document.getElementById('sentlogCloudMsg');e.textContent=t;e.style.color=ok?'#065f46':'#b91c1c'}
function updateCloudUI(){
  const out=document.getElementById('sentlogCloudLoggedOut'),inn=document.getElementById('sentlogCloudLoggedIn');
  if(!out||!inn)return;
  const logged=!!session?.user?.email;
  out.style.display=logged?'none':'block';inn.style.display=logged?'block':'none';
  if(logged){document.getElementById('sentlogCloudWho').textContent='ログイン中：'+session.user.email;setStatus('☁ 同期ON','ok')}
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
window.addEventListener('online',()=>syncNow());
document.addEventListener('change',e=>{
  if(e.target?.id==='cameraInput'||e.target?.id==='photoInput')setTimeout(syncNow,2500);
},true);
setTimeout(()=>{buildUI();if(session&&navigator.onLine)syncNow()},800);
syncTimer=setInterval(()=>{if(session&&navigator.onLine)syncNow()},15000);

/* PDF re-delivery v1.19. No file deletion and no session/token rewriting. */
const BASE='https://wiulvaqixphuobdielyy.supabase.co';
const KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
const BUCKET='sentlog-temp';
const IS_PC=location.pathname.includes('/sentlog-pc/');
const enc=encodeURIComponent;
let busy=false;
const acked=new Set();
let signature='';
const localHashes=new WeakMap();
function session(){try{return JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null')}catch{return null}}
function device(){return localStorage.getItem(IS_PC?'sentlogPcWebDeviceV1':'sentlogCloudDeviceV1')}
async function net(path,options={}){
  const s=session();
  if(!s?.access_token)throw new Error('同じセントログアカウントでログインしてください');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),options.body instanceof Blob?120000:30000);
  try{
    const r=await fetch(BASE+path,{...options,cache:'no-store',signal:controller.signal,headers:{apikey:KEY,Authorization:'Bearer '+s.access_token,...(options.headers||{})}});
    if(!r.ok){const data=await r.json().catch(()=>({}));const e=new Error(data.message||data.error||('通信エラー '+r.status));e.status=r.status;throw e}
    return r;
  }finally{clearTimeout(timeout)}
}
async function api(path,body){const r=await net('/rest/v1/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.status===204?null:r.json()}
const rpc=(name,body)=>api('rpc/'+name,body);
async function db(name,store,key,value){
  const connection=await new Promise((resolve,reject)=>{const q=indexedDB.open(name,1);q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains(store))q.result.createObjectStore(store)};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
  try{return await new Promise((resolve,reject)=>{const write=value!==undefined,tx=connection.transaction(store,write?'readwrite':'readonly'),q=write?tx.objectStore(store).put(value,key):tx.objectStore(store).get(key);let result;q.onsuccess=()=>{result=q.result};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('端末への保存が中断されました'))})}finally{connection.close()}
}
async function hash(blob){if(localHashes.has(blob))return localHashes.get(blob);const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());const h=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');localHashes.set(blob,h);return h}
async function matches(blob,a){return blob instanceof Blob && blob.size===Number(a.byte_size) && (await hash(blob))===String(a.sha256).toLowerCase()}
const fileKey=a=>'background:'+a.metadata.drawing_id;
async function localFile(a){return db('surveyFieldNoteDB','files',fileKey(a))}
async function pcFile(a){
  const root=await db('sentlog-pc-sync','kv','root');
  if(!root || await root.queryPermission({mode:'readwrite'})!=='granted')return null;
  const receipts=await api('sentlog_pc_receipts?asset_id=eq.'+enc(a.id)+'&select=pc_path,sha256,byte_size');
  const receipt=receipts?.[0];
  if(!receipt || receipt.sha256!==a.sha256)return null;
  const path=String(receipt.pc_path||'').split(/[\\/]/);
  // Browser archive paths start with the selected directory name. Never escape it.
  if(path[0]!==root.name || path.length<2 || path.some(p=>!p||p==='.'||p==='..'))return null;
  let folder=root;
  try{for(const segment of path.slice(1,-1))folder=await folder.getDirectoryHandle(segment);return (await folder.getFileHandle(path.at(-1))).getFile()}catch(e){if(e.name==='NotFoundError')return null;throw e}
}
function panels(){
  const parents=IS_PC?[document.querySelector('main')]:[document.querySelector('#projectsView .manager-shell'),document.querySelector('#drawingsView .manager-shell'),document.querySelector('#sidebar')];
  return parents.filter(Boolean).map((p,i)=>{const id='sentlogPdfRecoveryStatus'+i;let box=document.getElementById(id);if(!box){box=document.createElement('div');box.id=id;box.className='sentlog-pdf-status';box.setAttribute('role','status');p.prepend(box)}return box});
}
function status(text){
  if(signature===text && document.getElementById('sentlogPdfRecoveryStatus0'))return;
  signature=text;
  for(const box of panels()){box.replaceChildren();const label=document.createElement('div');label.textContent=text;box.append(label);if(/待ち|確認|失敗|エラー/.test(text)){const b=document.createElement('button');b.textContent='PDFを再確認';b.onclick=()=>run();box.append(b)}}
}
async function acknowledge(a,id){
  const k=[session()?.user?.id,id,a.id,a.sha256].join(':');
  if(acked.has(k))return;
  await rpc('sentlog_ack_pdf',{p_asset_id:a.id,p_device_id:id,p_sha256:a.sha256,p_byte_size:Number(a.byte_size)});
  acked.add(k);
}
async function supply(a,id){
  let blob=IS_PC?await pcFile(a):await localFile(a);
  if(!await matches(blob,a))return false;
  const claim=await rpc('sentlog_claim_pdf_redelivery',{p_asset_id:a.id,p_device_id:id,p_sha256:a.sha256,p_byte_size:blob.size});
  if(!claim?.claimed)return false;
  const path=claim.storage_path.split('/').map(enc).join('/');
  await net('/storage/v1/object/'+BUCKET+'/'+path,{method:'POST',headers:{'Content-Type':a.mime_type||'application/pdf','x-upsert':'false'},body:blob});
  await rpc('sentlog_finish_pdf_redelivery',{p_asset_id:a.id,p_device_id:id,p_token:claim.token});
  return true;
}
function drawingIds(){try{const ws=JSON.parse(localStorage.getItem('surveyFieldNoteWorkspaceV1')||'{"projects":[]}');return new Set(ws.projects.flatMap(p=>(p.drawings||[]).map(d=>d.id)))}catch{return new Set()}}
async function run(){
  if(busy || !navigator.onLine || document.hidden)return;
  const s=session(),id=device();
  if(!s?.access_token || !id)return;
  // The main app owns token refresh; do not race it from a second synchronizer.
  if(s.expires_at && s.expires_at*1000<Date.now()+5000)return;
  busy=true;
  try{
    const assets=await api('sentlog_assets?kind=eq.drawing&select=id,project_id,status,file_name,mime_type,byte_size,sha256,storage_path,metadata&limit=1000');
    const requests=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,expected_sha256&limit=1000');
    const needed=new Set((requests||[]).map(r=>r.asset_id));
    let supplied=0;
    for(const a of assets||[])if(a.metadata?.drawing_id && needed.has(a.id)){try{if(await supply(a,id))supplied++}catch(e){console.warn('PDF re-delivery',a.id,e.message)}}
    if(IS_PC){status(supplied?'PDFの再配信を行いました。受信側の確認を待っています。':'PDF再配信：この画面と保存先の許可を維持すると、保存済みPDFの再取得要求に応答します。');return}
    const ids=drawingIds();let available=0,missing=0,total=0,errors=0;
    for(const a of assets||[]){
      if(!a.metadata?.drawing_id || !ids.has(a.metadata.drawing_id))continue;
      total++;
      try{
        let blob=await localFile(a);
        if(await matches(blob,a)){
          available++;await acknowledge(a,id);
          if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(a.metadata.drawing_id,blob);
          continue;
        }
        // A different local PDF may be an unsent replacement. Never overwrite it.
        if(blob instanceof Blob && blob.size>0){missing++;continue}
        await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});
        if(a.status==='storage_deleted'){missing++;continue}
        const path=a.storage_path.split('/').map(enc).join('/');
        const downloaded=await(await net('/storage/v1/object/authenticated/'+BUCKET+'/'+path)).blob();
        if(!await matches(downloaded,a))throw new Error('PDFの内容照合に失敗しました');
        const named=new File([downloaded],a.file_name||'drawing.pdf',{type:a.mime_type||'application/pdf'});
        await db('surveyFieldNoteDB','files',fileKey(a),named);
        blob=await localFile(a);
        if(!await matches(blob,a))throw new Error('端末内PDFの保存照合に失敗しました');
        await acknowledge(a,id);available++;
        if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(a.metadata.drawing_id,blob);
      }catch(e){errors++;console.warn('PDF receive',a.id,e.message)}
    }
    if(errors)status('PDF受信の確認が必要です：保存済み '+available+' / '+total+' 件。通信を確認し「PDFを再確認」を押してください。');
    else if(missing)status('PDF '+missing+' 件の再取得待ちです。PDFが表示できるPC・iPadなどでセントログを開いたままにしてください。保存済み '+available+' / '+total+' 件。');
    else status(total?'PDF：この端末に '+available+' / '+total+' 件保存済み（内容照合済み）。':'PDF：同期対象の図面を確認しています。');
  }catch(e){status('PDF同期の確認が必要です：'+e.message)}finally{busy=false}
}
setTimeout(run,2500);
setInterval(run,10000);
window.addEventListener('online',()=>run());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)run()});
window.sentlogCheckPdfRecovery=run;

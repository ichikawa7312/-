"""Apply bounded PDF/photo recovery after all existing production builders.

Fail closed on changed integration points. No data formats, ACK guards,
storage deletion guards, local write paths or authorization are changed.
"""
from pathlib import Path
import re, subprocess

ROOT=Path(__file__).resolve().parents[1]
TOKEN='20261125-retain-media-5'
guard=(ROOT/'sentlog/recovery-throttle.js').read_text(encoding='utf-8').strip()
pending={}
def source(path):
    return pending.get(path,(ROOT/path).read_text(encoding='utf-8'))
def change(path,old,new,count=1):
    text=source(path)
    if text.count(old)!=count:
        raise RuntimeError(f'Recovery load integration changed: {path}: {old[:120]!r}: {text.count(old)}')
    pending[path]=text.replace(old,new)

p='sentlog/pdf-recovery.js'
change(p,'let busy=false;',guard+'\nconst deliveryGuard=createSentlogDeliveryGuard();\nlet busy=false;')
change(p,'  busy=true;\n  try{','  if(!deliveryGuard.begin(JSON.stringify([s.user?.id,id])))return;\n  busy=true;let cycleFailed=false;\n  try{')
# Only another device needs the local sender. Own requests still proceed
# through the existing durable hash verification and acknowledgement below.
change(p,"    const needed=new Set((requests||[]).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));",
         "    const needed=new Set((requests||[]).filter(r=>r.device_id!==id).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));")
change(p,'    for(const a of pending){','    for(const a of deliveryGuard.order(pending)){')
change(p,"      if(IS_PC && a.status!=='storage_deleted')continue;",
         "      if(IS_PC && a.status!=='storage_deleted')continue;\n      if(deliveryGuard.full())break;\n      if(!deliveryGuard.take(a))continue;")
change(p,"catch(e){supplyErrors.push((a.file_name||'図面PDF')+'：'+e.message);console.warn('PDF re-delivery',a.id,e.message)}",
         "catch(e){if(deliveryGuard.isTransient(e))throw e;supplyErrors.push((a.file_name||'図面PDF')+'：'+e.message);console.warn('PDF re-delivery',a.id,e.message)}")
change(p,"}catch(e){errors++;console.warn('PDF receive',a.id,e.message)}",
         "}catch(e){if(deliveryGuard.isTransient(e))throw e;errors++;console.warn('PDF receive',a.id,e.message)}")
change(p,"}catch(e){status('PDF同期の確認が必要です：'+e.message)}finally{busy=false}",
         "}catch(e){cycleFailed=true;deliveryGuard.fail(e);status('PDF同期の確認が必要です：'+e.message)}finally{if(!cycleFailed)deliveryGuard.complete();busy=false}")
# Do not rewrite an already outstanding request on every background poll.
# The original explicit recovery authorization and ACK path remain intact.
change(p,"          await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});\n          missing++;",
         "          if(!requestedForThisDevice.has(a.id+':'+String(a.sha256).toLowerCase()))await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});\n          missing++;")
p='sentlog/peer-photo-recovery.js'
change(p," let busy=false,message='',uploadedTotal=0;",
         guard+"\n const deliveryGuard=createSentlogDeliveryGuard();\n let busy=false,message='',uploadedTotal=0;")
change(p,"     if(!r.ok)throw Error(data.message||('通信エラー '+r.status));return data;",
         "     if(!r.ok){const error=Error(data.message||('通信エラー '+r.status));error.status=r.status;throw error;}return data;")
change(p,"     if(!r.ok)throw Error('写真の再送に失敗しました（'+r.status+'）。通信を確認して再試行してください。');",
         "     if(!r.ok){const error=Error('写真の再送に失敗しました（'+r.status+'）。通信を確認して再試行してください。');error.status=r.status;throw error;}")
change(p,"   busy=true;\n   try{",
         "   if(!deliveryGuard.begin(JSON.stringify([sessions()?.user?.id,id])))return;\n   busy=true;let cycleFailed=false;\n   try{")
change(p,"     const ids=[...desired.keys()];let sent=0,errors=[],checked=0;",
         "     const ids=deliveryGuard.order([...desired.keys()]);let sent=0,errors=[],checked=0;")
change(p,"       for(const a of assets){",
         "       for(const a of deliveryGuard.order(assets)){")
change(p,"||sent>=8)break outer;",
         "||sent>=8||deliveryGuard.full())break outer;")
change(p,"         checked++;",
         "         if(!deliveryGuard.take(a))continue;\n         checked++;")
change(p,"catch(e){errors.push(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message);}",
         "catch(e){if(deliveryGuard.isTransient(e))throw e;errors.push(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message);}")
change(p,"}catch(e){show('写真補完の確認：'+(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message));}",
         "}catch(e){cycleFailed=true;deliveryGuard.fail(e);show('写真補完の確認：'+(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message));}")
change(p,"   finally{busy=false;}",
         "   finally{if(!cycleFailed)deliveryGuard.complete();busy=false;}")

# Recovery inventory must not mix photo requests with drawing requests or drop
# the tail of the PostgREST result. Use the existing authorization and SHA checks.
queue=(ROOT/'sentlog/recovery-queue.js').read_text(encoding='utf-8').strip()
p='sentlog/pdf-recovery.js'
change(p,'const deliveryGuard=createSentlogDeliveryGuard();',queue+'\nconst deliveryGuard=createSentlogDeliveryGuard();')
asset_line="const assets=await api('sentlog_assets?kind=eq.drawing&select=id,project_id,status,file_name,mime_type,byte_size,sha256,storage_path,metadata&limit=1000');"
asset_replacement="const assets=await sentlogRecoveryRows(api,'sentlog_assets','kind=eq.drawing&select=id,project_id,status,file_name,mime_type,byte_size,sha256,storage_path,metadata',['id']);"
n=source(p).count(asset_line)
if not 1<=n<=2: raise RuntimeError('PDF asset paging integration changed: '+str(n))
change(p,asset_line,asset_replacement,n)
change(p,"const requests=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,device_id,expected_sha256&limit=1000');",
         "const requests=await sentlogRecoveryRequests(api,'drawing');")
change(p,"    const needed=new Set((requests||[]).filter(r=>r.device_id!==id).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));",
         "    const otherRequests=requests.filter(r=>r.device_id!==id);\n    const activeDevices=otherRequests.length?await sentlogRecoveryDevices(api):new Map();\n    const cutoff=Date.now()-15*60*1000;\n    const needed=new Set(otherRequests.filter(r=>sentlogFreshRecoveryRequest(r,activeDevices,cutoff)).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));")

p='sentlog/photo-recovery.js'
change(p," let busy=false,message='',lastRequested=new Map();",
       guard+"\n"+queue+"\n const deliveryGuard=createSentlogDeliveryGuard({maxPerCycle:24});\n let busy=false,message='',lastRequested=new Map();")
change(p,"   if(!r.ok){const error=await r.json().catch(()=>({}));throw Error(error.message||error.error||('通信エラー '+r.status));}",
       "   if(!r.ok){const error=await r.json().catch(()=>({}));const failure=Error(error.message||error.error||('通信エラー '+r.status));failure.status=r.status;throw failure;}")
# Receiver: when a matching outstanding request is already durable on the
# server, leave it intact. A new hash/version has an independent request.
change(p,"  const active=await activeProjectIds(),assets=await assetList();",
       "  const active=await activeProjectIds(),assets=await assetList();\n  let pendingRequestsPromise=null;")
change(p,"      const request=await rpc('sentlog_request_photo',{p_asset_id:a.id,p_device_id:id});\n      if(!request?.requested)throw Error(request?.reason||'PCの写真保存を確認できません。');\n      lastRequested.set(a.id,Date.now());",
       """      if(!pendingRequestsPromise)pendingRequestsPromise=sentlogRecoveryRequests(api,'photo',{deviceIds:[id],missingOnly:true}).then(rows=>new Set(rows.map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase())));
      const requests=await pendingRequestsPromise,requestKey=a.id+':'+String(a.sha256).toLowerCase();
      if(!requests.has(requestKey)){
       const request=await rpc('sentlog_request_photo',{p_asset_id:a.id,p_device_id:id});
       if(!request?.requested)throw Error(request?.reason||'PCの写真保存を確認できません。');
       requests.add(requestKey);
      }
      lastRequested.set(a.id,Date.now());""")
# PC: select only current, missing-photo requests, then only the referenced
# assets. Never scan every stored photo merely to find those requested files.
t=source(p)
start="  const requests=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,device_id,expected_sha256,requested_at&limit=5000');"
end="  const desired=new Set(fresh.map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));"
if t.count(start)!=1 or t.count(end)!=1: raise RuntimeError('PC recovery request integration changed')
a=t.index(start);b=t.index(end,a)
pending[p]=t[:a]+"""  const activeDevices=await sentlogRecoveryDevices(api),cutoff=Date.now()-15*60*1000;
  const fresh=await sentlogLiveRecoveryRequests(api,'photo',activeDevices,{self:id,cutoff,missingOnly:true});
"""+t[b:]
change(p,"  const assets=await assetList(),active=await activeProjectIds();",
       """  const active=await activeProjectIds(),assets=[];
  const requestedIds=deliveryGuard.order([...new Set(fresh.map(r=>r.asset_id))]);
  for(let offset=0;offset<requestedIds.length;offset+=50){
   const ids=requestedIds.slice(offset,offset+50);
   const allowed=new Set(ids);
   const rows=await api('sentlog_assets?kind=eq.photo&status=eq.storage_deleted&select=id,project_id,status,kind,file_name,mime_type,byte_size,sha256,storage_path,metadata&id=in.'+encodeURIComponent('('+ids.join(',')+')')+'&limit=50');
   if(!Array.isArray(rows)||rows.some(r=>!allowed.has(r.id)))throw Error('写真の再取得対象を確認できません。');
   assets.push(...rows);
  }""")
change(p,"  for(const a of pending){\n   try{if(await uploadPhoto(a,id,ownerId))count++;}\n   catch(e){if(e?.code==='PHOTO_SESSION_CHANGED')throw e;errors.push((a.file_name||'写真')+'：'+e.message);}\n  }",
       """  for(const a of deliveryGuard.order(pending)){
   if(deliveryGuard.full())break;
   if(!deliveryGuard.take(a))continue;
   try{if(await uploadPhoto(a,id,ownerId))count++;}
   catch(e){if(e?.code==='PHOTO_SESSION_CHANGED'||deliveryGuard.isTransient(e))throw e;errors.push((a.file_name||'写真')+'：'+e.message);}
  }""")
change(p,"  busy=true;\n  try{\n   if(IS_PC)await window.ensureSession?.();",
       "  if(IS_PC&&!deliveryGuard.begin(JSON.stringify([s.user?.id,id])))return;\n  busy=true;let cycleFailed=false;\n  try{\n   if(IS_PC)await window.ensureSession?.();")
change(p,"  }catch(e){show('写真の再取得を確認できません：'+e.message);}\n  finally{busy=false;}",
       "  }catch(e){cycleFailed=true;if(IS_PC)deliveryGuard.fail(e);show('写真の再取得を確認できません：'+e.message);}\n  finally{if(IS_PC&&!cycleFailed)deliveryGuard.complete();busy=false;}")
# Active media retention: PC remains an independently verified backup.
# Do not turn retained files into a cloud deletion queue. This stage runs
# after the legacy production builders, whose own tests remain intact.
p='sentlog-pc/index.html'
change(p,"let pcPendingRows=new Map(),pcInventoryTime='',pcRetainedDrawingCount=0;",
       "let pcPendingRows=new Map(),pcInventoryTime='',pcRetainedDrawingCount=0;\nlet pcRetainedPhotoCount=0;")
change(p,"const retained=inventory.filter(a=>a.kind==='drawing'&&a.status==='pc_verified'&&a.pcReceiptVerified);",
       """const retainedDrawings=inventory.filter(a=>a.kind==='drawing'&&a.status==='pc_verified'&&a.pcReceiptVerified);
 const retainedPhotos=inventory.filter(a=>a.kind==='photo'&&a.status==='pc_verified'&&a.pcReceiptVerified);
 const retained=[...retainedDrawings,...retainedPhotos];""")
change(p,"pcRetainedDrawingCount=retained.length;",
       "pcRetainedDrawingCount=retainedDrawings.length;pcRetainedPhotoCount=retainedPhotos.length;")
change(p,"+'件';\n const time=$('pendingTime')",
       "+'件 ／ 写真クラウド保持中（PC同期済み）：'+pcRetainedPhotoCount+'件';\n const time=$('pendingTime')")
# Keep the old delete function for legacy non-PC callers, but the PC inventory
# path must never request Storage removal for an active project's shared files.
# Re-read and verify any PC-verified row whose receipt does not match.
t=source(p)
start=t.index('async function syncOnce(){')
finish=t.index('function start(){',start)
body=t[start:finish]
if body.count("if(a.status==='uploaded')")!=1:
    raise RuntimeError('PC backup verification branch changed')
body=body.replace("if(a.status==='uploaded')","if(a.status==='uploaded'||!a.pcReceiptVerified)")
if body.count('await deleteVerified(a)')!=1:
    raise RuntimeError('PC cleanup call changed: '+repr([line for line in body.splitlines() if 'deleteVerified' in line]))
body=body.replace('await deleteVerified(a)','await retainActiveMedia(a)')
helper="""async function retainActiveMedia(a){
 const current=pcPendingRows.get(a.id);
 if(!['photo','drawing'].includes(a.kind)||!current?.pcReceiptVerified)
  throw Error('PC保存・内容照合が完了していません。クラウドファイルは保持します。');
 // A fresh inventory scan, not this local return value, confirms completion.
 // The server's active-media retention guard also protects old PC clients.
 return {ok:true,retained:true,asset_id:a.id};
}
"""
pending[p]=t[:start]+helper+body+t[finish:]


# Keep the registration guard assertion tied to the actual paginated query.
# This does not relax the invariant: both the old and new query must be gated.
p='tests/management.test.cjs'
change(p,'''  assert(pdf.indexOf('registration[0].active!==true')<pdf.indexOf("const assets=await api('sentlog_assets?"));''',
       '''  const registrationGuard=pdf.indexOf('registration[0].active!==true'),inventoryQuery=pdf.indexOf("const assets=await sentlogRecoveryRows(api,'sentlog_assets'");
  assert(registrationGuard>=0&&inventoryQuery>registrationGuard,'active registration checked before any PDF inventory query');''')

# The legacy read-only list remains available to older servers. On the
# new server, only pending rows plus summary counts cross the network.
p='sentlog-pc/index.html'
change(p,'let pcRetainedPhotoCount=0;',
       'let pcRetainedPhotoCount=0,pcCloudMissingCount=null,pcInventoryProtocol=null;')
change(p,"+pcRetainedPhotoCount+'件';\n const time=$('pendingTime')",
       "+pcRetainedPhotoCount+'件 ／ クラウド補完待ち：'+(pcCloudMissingCount===null?'未確認':pcCloudMissingCount+'件');\n const time=$('pendingTime')")
change(p,'async function pendingAssets(){','async function legacyPendingAssets(){')
inventory="""async function pendingAssets(){
 const owner=session?.user?.id,device=localStorage.getItem('sentlogPcWebDeviceV1');
 if(!owner||!device)throw Error('PCの同期対象を確認できません。');
 const scope=()=>{if(session?.user?.id!==owner||localStorage.getItem('sentlogPcWebDeviceV1')!==device)throw Error('同期中にログインまたは端末が変わりました。');};
 const key=owner+':'+device;
 if(pcInventoryProtocol?.key===key&&pcInventoryProtocol.legacy){pcCloudMissingCount=null;return legacyPendingAssets();}
 const states=await rest('/rest/v1/rpc/sentlog_archive_v1',{method:'POST',body:JSON.stringify({p_action:'list'})});scope();
 if(!Array.isArray(states))throw Error('案件の同期対象を確認できません。');
 const ids=[...new Set(states.filter(c=>c.status==='active'&&!c.checking&&!c.retired).map(c=>c.id))];
 const allowed=new Set(ids),uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
 if(ids.some(x=>!uuid(x)))throw Error('案件の識別情報を確認できません。');
 const all=[];let after=null,summary=null;
 const validCount=x=>Number.isSafeInteger(x)&&x>=0;
 for(;;){
  let page;
  try{page=await rest('/rest/v1/rpc/sentlog_pc_inventory_v1',{method:'POST',body:JSON.stringify({p_project_ids:ids,p_after:after,p_limit:200})});}
  catch(e){
   // Only the explicitly absent RPC permits a fallback. Outages and auth
   // errors must not trigger an expensive second full inventory scan.
   if(after===null&&/Could not find the function (?:public\\.)?sentlog_pc_inventory_v1\\b/i.test(String(e?.message||e))){
    scope();pcInventoryProtocol={key,legacy:true};pcCloudMissingCount=null;return legacyPendingAssets();
   }
   throw e;
  }
  scope();
  if(page?.schema!==1||!Array.isArray(page.rows)||page.rows.length>200||
     !['retainedDrawings','retainedPhotos','pendingBackups','cloudMissing','cloudMissingBytes','cloudMissingWithoutReceipt'].every(k=>validCount(page[k])))
    throw Error('クラウドの残件を確認できません。');
  summary=page;
  for(const a of page.rows){
   if(!uuid(a?.id)||(after!==null&&a.id<=after)||!allowed.has(a.project_id)||!['photo','drawing'].includes(a.kind)||
      !['uploaded','pc_verified'].includes(a.status)||typeof a.pcReceiptVerified!=='boolean'||
      (a.status==='pc_verified'&&a.pcReceiptVerified))throw Error('クラウドの残件一覧が一致しません。');
   all.push(a);after=a.id;
  }
  if(page.rows.length<200)break;
 }
 if(all.length!==summary.pendingBackups)throw Error('確認中に同期対象が変わりました。次回の同期で再確認します。');
 pcInventoryProtocol={key,legacy:false};pcRetainedDrawingCount=summary.retainedDrawings;
 pcRetainedPhotoCount=summary.retainedPhotos;pcCloudMissingCount=summary.cloudMissing;
 pcPendingRows=new Map(all.map(a=>[a.id,a]));
 pcInventoryTime=new Date().toLocaleTimeString('ja-JP');renderPcPending();
 return [...pcPendingRows.values()];
}
"""
change(p,'async function downloadAsset(a){',inventory+'async function downloadAsset(a){')
change(p,'PC同期完了：未処理データはありません','PC保管確認完了：写真・図面のクラウド補完は別途確認')

# Explicit one-time PC cloud repair. It is not a background polling task.
p='sentlog-pc/index.html'
repair_script="""<script src="../sentlog/active-media-restore.js?v=20261125-restore-1"></script>
<script>
SentlogActiveMediaRestore.mount({
 getScope:()=>({owner:session?.user?.id,device:localStorage.getItem('sentlogPcWebDeviceV1')}),
 getSession:()=>session,ensure:()=>ensureSession(),getRoot:()=>rootHandle,
 baseUrl:SUPABASE_URL,apiKey:API_KEY
});
</script>
"""
change(p,'</body>',repair_script+'</body>')

# Preserve all old nonempty PC files, including same-name different photos.
p='sentlog-pc/index.html'
change(p,'async function saveVerified(a){',
       """async function saveVerified(a){
  const originalRoot=rootHandle,originalOwner=session?.user?.id,originalDevice=localStorage.getItem(DEVICE_KEY);
  const assertBackupScope=()=>{if(!originalRoot||rootHandle!==originalRoot||!originalOwner||session?.user?.id!==originalOwner||!originalDevice||localStorage.getItem(DEVICE_KEY)!==originalDevice)throw Error('PC保管中に保存先・ログイン・端末が変更されました。');};
  assertBackupScope();""")
t=source(p)
start=t.index('async function saveVerified(a){')
end=t.index('async function deleteVerified(a){',start)
body=t[start:end]
a=body.index("  const name=safe(a.file_name,")
b=body.index('  const device=await ensureDevice();',a)
if a<0 or b<0 or 'createWritable()' not in body[a:b]:
    raise RuntimeError('PC file-write integration changed')
body=body[:a]+"""  const preferredName=safe(a.file_name,a.kind==='drawing'?'drawing.pdf':'photo.jpg');
  assertBackupScope();
  const saved=await SentlogPcSafeBackup.save({directory:d,preferredName,asset:a,download:()=>downloadAsset(a),hash:fileSha,locks:navigator.locks,assertCurrent:assertBackupScope});
  const {name,file:existing,sha256:hash}=saved;
"""+body[b:]
body=body.replace('let d=rootHandle;','let d=originalRoot;').replace('[rootHandle.name,','[originalRoot.name,')
body=body.replace('  const device=await ensureDevice();','  const device=await ensureDevice();assertBackupScope();if(device!==originalDevice)throw Error("PCの端末登録が変更されました。");')
body=body.replace("  await rest('/rest/v1/rpc/sentlog_mark_pc_verified'", "  const confirmation=await rest('/rest/v1/rpc/sentlog_mark_pc_verified'")
body=body.replace("  savedCount++;", "  assertBackupScope();if(confirmation?.verified!==true||confirmation.asset_id!==a.id)throw Error('PCの保存確認をサーバーへ登録できませんでした。');\n  savedCount++;")
if 'const confirmation=await rest' not in body or 'confirmation?.verified!==true' not in body:
    raise RuntimeError('PC verification receipt integration changed')
pending[p]=t[:start]+body+t[end:]
change(p,'<script src="../sentlog/active-media-restore.js?v=20261125-restore-1"></script>',
       '<script src="../sentlog/pc-safe-backup.js?v=20261125-safe-1"></script>\n<script src="../sentlog/active-media-restore.js?v=20261125-restore-1"></script>')

# In delta mode the old photo worker must not fetch or hash the same photo
# catalog. Legacy projects keep their existing receipt and recovery paths.
p='sentlog/photo-recovery.js'
t=source(p)
start=t.index(' async function assetList(){')
end=t.index(' function currentPhotoKeys(){',start)
if 'sentlog_assets?kind=eq.photo' not in t[start:end]:raise RuntimeError('legacy photo list integration changed')
pending[p]=t[:start]+""" async function assetList(projectIds){
  const ids=[...new Set(projectIds)],out=[];
  if(ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]+$/.test(id)))throw Error('写真の案件を確認できません。');
  for(let i=0;i<ids.length;i+=50){
   const selected=ids.slice(i,i+50),allowed=new Set(selected);
   let after='';
   for(;;){
    const rows=await api('sentlog_assets?kind=eq.photo&project_id=in.'+enc('('+selected.join(',')+')')+'&select=id,project_id,status,file_name,mime_type,byte_size,sha256,storage_path,metadata&order=id.asc&limit=400'+(after?'&id=gt.'+enc(after):''));
    if(!Array.isArray(rows))throw Error('写真一覧を確認できません。');
    if(!rows.length)break;
    for(const row of rows){
     if(typeof row.id!=='string'||!row.id||row.id<=after||!allowed.has(row.project_id))throw Error('写真一覧の案件・続きを確認できません。');
     after=row.id;out.push(row);
    }
   }
  }
  return out;
 }
"""+t[end:]
change(p,'  for(const p of ws.projects||[]){\n   for(const d of p.drawings||[]){',
       '  for(const p of ws.projects||[]){\n   if(window.sentlogDeltaOwnsProject?.(p.id))continue;\n   for(const d of p.drawings||[]){')
change(p,'  const active=await activeProjectIds(),assets=await assetList();\n  let pendingRequestsPromise=null;',
       "  const active=new Set([...await activeProjectIds()].filter(id=>!window.sentlogDeltaOwnsProject?.(id)));\n  if(!active.size){show('');return;}\n  const assets=await assetList(active);\n  let pendingRequestsPromise=null;")

# The same read-only source verifier can rescue exact surviving copies on
# iPhone/iPad/browser. No automatic migration starts merely by opening the app.
p='sentlog/index.html'
change(p,'const deps=[',"const deps=[['active-media-restore.js?v=20261125-restore-2','SentlogActiveMediaRestore'],")
change(p,'document.open();document.write(html);document.close()',
       """html=html.replace('</body>','<script src="./active-media-restore.js?v=20261125-restore-2"></'+'script></body>');document.open();document.write(html);document.close()""")
p='sentlog/cloud-sync.js'
change(p,'window.sentlogManagementSession=ensureSession;',
       """window.sentlogManagementSession=ensureSession;
Promise.resolve(window.sentlogAppReady).then(()=>{
  window.SentlogActiveMediaRestore?.mount({
    getScope:()=>({owner:session?.user?.id,device:localStorage.getItem(DEVICE_KEY)}),
    getSession:()=>session,
    ensure:async()=>{await window.SentlogRecords.settled();window.SentlogRecords.assertSafe();await ensureSession();},
    readSource:a=>window.SentlogActiveMediaRestore.readDeviceOriginal(a,dbGet),
    baseUrl:SUPABASE_URL,apiKey:SUPABASE_KEY,host:document.querySelector('#projectsView .manager-shell')
  });
}).catch(e=>console.warn('Device cloud repair unavailable',e));""")
p='sentlog-pc/index.html'
change(p,'active-media-restore.js?v=20261125-restore-1','active-media-restore.js?v=20261125-restore-2')
p='sentlog/sw.js'
change(p,"'photo-recovery.js'","'photo-recovery.js','active-media-restore.js'")

# Cancel fresh-state inspection with the existing confirmation lifecycle;
# don't start a new RPC if the network dropped while authentication was pending.
p='sentlog/cloud-sync.js'
change(p,'const mode=await delta.inspect(current);context.assertCurrent();',
       'const mode=await delta.inspect(current,{signal:controller.signal});context.assertCurrent();')
# Release marker: keep the new resource URLs and version label in sync.
p='sentlog/phone-runtime.js'
change(p,'v1.95','v1.96',4)
for p in ['sentlog/index.html','sentlog-pc/index.html']:
    v=source(p)
    pending[p]=v.replace('phone-runtime.js?v=195','phone-runtime.js?v=196').replace("'v1.95'","'v1.96'").replace('v1.95 · 同期通信の重複抑制','v1.96 · 共有ファイル保持・同期軽量化')

# Version every loader reference and corresponding existing test expectation.
versions=set()
for page in ['sentlog/index.html','sentlog-pc/index.html']:
    text=source(page)
    for name in ['pdf-recovery','peer-photo-recovery','photo-recovery','cloud-sync','delta-sync-transport','delta-sync-app-runtime']:
        pattern=r'(?<!peer-)'+re.escape(name)+r'\.js\?v=([A-Za-z0-9._-]+)'
        for old in re.findall(pattern,text):
            versions.add((name,old))
        text=re.sub(pattern,name+'.js?v='+TOKEN,text)
    pending[page]=text
worker=source('sentlog/sw.js')
old_cache=re.search(r'sentlog-pwa-v\d+',worker).group()
new_cache='sentlog-pwa-v'+str(int(old_cache.rsplit('v',1)[1])+1)
pending['sentlog/sw.js']=worker.replace(old_cache,new_cache)
for f in (ROOT/'tests').iterdir():
    if f.suffix not in ('.cjs','.py'):continue
    path=str(f.relative_to(ROOT));old=source(path);new=old.replace(old_cache,new_cache).replace("'v1.95'","'v1.96'").replace('phone-runtime.js?v=195','phone-runtime.js?v=196').replace('v1.95 · 同期通信の重複抑制','v1.96 · 共有ファイル保持・同期軽量化')
    for name,version in versions:
        new=new.replace(name+'.js?v='+version,name+'.js?v='+TOKEN)
        new=new.replace(name+r'\.js\?v='+version,name+r'\.js\?v='+TOKEN)
    if new!=old:pending[path]=new
for path,text in pending.items():
    (ROOT/path).write_text(text,encoding='utf-8')
for path in ['sentlog/pdf-recovery.js','sentlog/peer-photo-recovery.js','sentlog/photo-recovery.js','sentlog/recovery-throttle.js','sentlog/recovery-queue.js']:
    subprocess.run(['node','--check',path],cwd=ROOT,check=True)
subprocess.run(['node','tests/recovery_throttle.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','tests/recovery_queue.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','tests/active_media_pc_inventory.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/active-media-restore.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/active_media_restore.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/pc-safe-backup.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/pc_safe_backup.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','tests/legacy_photo_scope.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','tests/delta_transport.test.cjs'],cwd=ROOT,check=True)
print('Built bounded fair PDF/photo recovery; existing byte checks and data guards retained')

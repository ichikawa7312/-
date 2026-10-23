"""v1.90: stop duplicate ACKs and reduce unchanged-sync traffic. No user-data migration."""
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Sync traffic integration mismatch: {path}: {old[:90]!r}: {s.count(old)}')
 p.write_text(s.replace(old,new))
def section(path,start,end,new):
 p=ROOT/path;s=p.read_text()
 if s.count(start)!=1 or s.count(end)!=1:raise RuntimeError('Unknown sync traffic section: '+path)
 a=s.index(start);b=s.index(end,a);p.write_text(s[:a]+new+'\n'+s[b:])

p='sentlog/cloud-sync.js'
section(p,'async function ackAsset(','async function pullRemoteProjects(','''async function ackAsset(asset,deviceId,force=false){
  const kind=asset.kind==='photo'?'photo':'asset';
  return window.SentlogSyncTraffic.ack(kind,asset,deviceId,args=>rest('/rest/v1/rpc/sentlog_ack_'+kind,{method:'POST',body:JSON.stringify(args)}),{force});
}
async function pullProjectAssets(cloudProject,deviceId,cycleAssets=null){
  const ws=workspace(),localProject=(ws.projects||[]).find(p=>p.id===cloudProject.client_key);
  const allowedDrawingIds=new Set((localProject?.drawings||[]).map(d=>d.id));
  const fields='id,client_key,kind,file_name,storage_path,mime_type,byte_size,sha256,status,source_device_id,metadata';
  const assets=await readProjectAssets(cloudProject.id,fields);
  if(cycleAssets)cycleAssets.set(cloudProject.id,assets);
  let received=0;const errors=[];
  for(const a of assets||[]){
    if(a.status==='storage_deleted')continue;
    const drawingId=a.metadata?.drawing_id;
    if(!drawingId||!allowedDrawingIds.has(drawingId))continue;
    if(a.kind!=='drawing'&&a.kind!=='photo')continue;
    if(a.kind==='photo'&&(a.source_device_id===deviceId||!a.metadata?.photo_id))continue;
    const key=a.kind==='drawing'?'background:'+drawingId:'photo:'+drawingId+':'+a.metadata.photo_id;
    try{
      await window.SentlogSyncTraffic.withFileLock(key,async()=>{
        // Re-read after taking the lock: photo/PDF recovery may have just saved it.
        const local=await dbGet(key);
        const same=local instanceof Blob&&local.size===Number(a.byte_size)&&
          (await sha256Hex(local)).toLowerCase()===String(a.sha256).toLowerCase();
        if(!same){
          if(a.kind==='drawing'&&local instanceof Blob&&local.size&&window.sentlogSyncView&&!window.sentlogSyncView.canReplaceDrawing(drawingId))return;
          // A different photo may be an unsent edit. Never replace it on a stale read.
          if(a.kind==='photo'&&local instanceof Blob&&local.size)throw Error('端末内に内容が異なる写真があります。上書きせず保持しました。');
          const file=await downloadPrivateAsset(a);await dbPut(key,file);
          const saved=await dbGet(key);
          if(!(saved instanceof Blob)||saved.size!==Number(a.byte_size)||(await sha256Hex(saved)).toLowerCase()!==String(a.sha256).toLowerCase())
            throw Error('端末への保存照合が完了していません。');
          received++;
          if(a.kind==='drawing')await window.sentlogSyncView?.fileReceived(drawingId,file);
          else window.sentlogSyncView?.photoReceived(drawingId);
        }
        if(a.source_device_id!==deviceId)await ackAsset(a,deviceId,!same);
      });
    }catch(e){errors.push((a.file_name||'ファイル')+'：'+e.message);console.warn('asset pull failed',a?.id,e);}
  }
  if(errors.length)throw Error('図面・写真の受信確認が未完了です：'+errors.slice(0,3).join(' / '));
  return received;
}''')
change(p,'async function pullRemoteProjects(deviceId,manualProject=null){','async function pullRemoteProjects(deviceId,manualProject=null,cycleAssets=null){')
change(p,"    const snaps=await rest('/rest/v1/sentlog_project_snapshots?project_id=eq.'+enc(cp.id)+'&select=revision,payload,updated_at');", """    // Fetch the large record payload only when the revision/baseline needs it.
    const before=getSyncMeta(cp.client_key);
    const exists=(workspace().projects||[]).some(p=>p.id===cp.client_key);
    const heads=await rest('/rest/v1/sentlog_project_snapshots?project_id=eq.'+enc(cp.id)+'&select=revision,updated_at');
    if(exists&&before?.base_snapshot&&!before.restored_backup&&before.fingerprint&&Number(before.fingerprint_schema||0)>=SYNC_FINGERPRINT_SCHEMA&&heads?.[0]&&Number(heads[0].revision)===Number(before.revision)){
      files+=await pullProjectAssets(cp,deviceId,cycleAssets);continue;
    }
    const snaps=await rest('/rest/v1/sentlog_project_snapshots?project_id=eq.'+enc(cp.id)+'&select=revision,payload,updated_at');""")
change(p,'if(!blocked.has(cp.id))files+=await pullProjectAssets(cp,deviceId);','if(!blocked.has(cp.id))files+=await pullProjectAssets(cp,deviceId,cycleAssets);')
change(p,'let syncTimer=null;','let syncTimer=null;\nlet syncNotBefore=0;')
change(p,'if(syncing||mergeBusy||!navigator.onLine||!session||window.sentlogImporting)return;','if(syncing||mergeBusy||!navigator.onLine||!session||window.sentlogImporting||document.hidden)return;\n  if(!options?.force&&Date.now()<syncNotBefore)return;\n  syncNotBefore=Date.now()+10000;')
change(p,'    const pulled=await pullRemoteProjects(deviceId,manualProject);','    const cycleAssets=new Map();\n    const pulled=await pullRemoteProjects(deviceId,manualProject,cycleAssets);')
change(p,"const knownAssets=new Map((await readProjectAssets(cp.id,'client_key,kind,sha256,byte_size,status,storage_path')).map(a=>[a.client_key,a]));","const knownAssets=new Map((cycleAssets.get(cp.id)||await readProjectAssets(cp.id,'client_key,kind,sha256,byte_size,status,storage_path')).map(a=>[a.client_key,a]));")
change(p,"    console.warn('Sentlog cloud sync',e);","    syncNotBefore=Date.now()+30000;\n    console.warn('Sentlog cloud sync',e);")
change(p,"document.getElementById('sentlogCloudSyncNow').onclick=()=>{closeModal();syncNow()};","document.getElementById('sentlogCloudSyncNow').onclick=()=>{closeModal();syncNow({force:true})};")
# Explicit user operations bypass automatic debounce/backoff, not safety guards.
change(p,'window.sentlogArchiveSync=syncNow;','window.sentlogArchiveSync=options=>syncNow({...options,force:true});')
change(p,'if(done)await syncNow();','if(done)await syncNow({force:true});')
change(p,"syncTimer=setInterval(()=>{if(session&&navigator.onLine)syncNow()},5000);","syncTimer=setInterval(()=>{if(session&&navigator.onLine&&!document.hidden)syncNow()},15000);")

p='sentlog/photo-recovery.js'
section(p,' async function receive(id){',' async function provide(id){',''' async function acknowledgePhoto(a,id,force=false){
  return window.SentlogSyncTraffic.ack('photo',a,id,args=>rpc('sentlog_ack_photo',args),{force});
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
   seen++;const key=photoKey(drawing,photo);
   try{await window.SentlogSyncTraffic.withFileLock(key,async()=>{
    const local=await localPhoto(key);
    if(await matches(local,a)){
     if(a.status!=='storage_deleted')await acknowledgePhoto(a,id);
     good++;return;
    }
    if(local instanceof Blob&&local.size>0)throw Error('内容が異なる写真があります。上書きせず停止しました。');
    if(a.status!=='storage_deleted'){
     const blob=await downloaded(a);
     if(!window.SentlogRecords?.ready)throw Error('保存先が未準備です。');
     await window.SentlogRecords.writeFile(key,new File([blob],a.file_name||'photo.jpg',{type:a.mime_type||blob.type}));
     if(!await matches(await localPhoto(key),a))throw Error('端末内の写真照合に失敗しました。');
     await acknowledgePhoto(a,id,true);
     good++;newFiles++;
     window.sentlogSyncView?.photoReceived?.(drawing);
     if(typeof window.renderSelectedPhotos==='function'&&window.activeDrawingId===drawing)window.renderSelectedPhotos();
    }else{
     waiting++;
     if(Date.now()-(lastRequested.get(a.id)||0)>25000){
      // A genuinely missing file must be re-ACKed after a later redelivery.
      await window.SentlogSyncTraffic.forget('photo',a,id);
      const request=await rpc('sentlog_request_photo',{p_asset_id:a.id,p_device_id:id});
      if(!request?.requested)throw Error(request?.reason||'PCの写真保存を確認できません。');
      lastRequested.set(a.id,Date.now());
     }
    }
   });}catch(e){errors.push((a.file_name||'写真')+'：'+e.message);}
  }
  if(!seen){show('');return;}
  if(errors.length)show('写真の確認が必要です：'+errors.slice(0,3).join(' / ')+'（保存済み '+good+'/'+seen+' 件）');
  else if(waiting)show('写真 '+waiting+' 件を再取得待ち。写真が残っている端末でセントログを開いてください。会社PCからも再取得できます。（確認済み '+good+'/'+seen+' 件）');
  else if(newFiles)show('写真 '+good+'/'+seen+' 件を保存・照合しました。図面を開くと確認できます。');
  else show('写真 '+good+'/'+seen+' 件を確認済み。');
 }''')
change(p,'setInterval(run,15000)','setInterval(run,30000)')
# PDF confirmations use the same durable ledger but retain the existing SHA/size RPC.
p='sentlog/pdf-recovery.js'
change(p,'const acked=new Set();','// Receipt persistence is shared with the other synchronizers.')
section(p,'async function acknowledge(a,id){','async function supply(a,id){', '''async function acknowledge(a,id,force=false){
  return window.SentlogSyncTraffic.ack('pdf',a,id,args=>rpc('sentlog_ack_pdf',args),{force});
}''')
change(p,"        await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});", "        await window.SentlogSyncTraffic.forget('pdf',a,id);\n        await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});")
change(p,'        await acknowledge(a,id);available++;','        await acknowledge(a,id,true);available++;')
change(p,'setInterval(run,10000)','setInterval(run,30000)')

# Static boot dependencies are versioned together; no CacheStorage user API entries.
p='sentlog/index.html'
change(p,"const deps=[", "const deps=[['sync-traffic.js?v=190','SentlogSyncTraffic v1.90'],")
change(p,'<script src="./session-guard.js?v=189">','<script src="./sync-traffic.js?v=190"><\\/script><script src="./session-guard.js?v=189">')
change(p,'cloud-sync.js?v=20261022-auth-189','cloud-sync.js?v=20261023-traffic-190',2)
change(p,'photo-recovery.js?v=187','photo-recovery.js?v=190',4)
change(p,'pdf-recovery.js?v=141','pdf-recovery.js?v=190',2)
change(p,'phone-runtime.js?v=189','phone-runtime.js?v=190',2)
change(p,"['phone-runtime.js?v=190','v1.89']","['phone-runtime.js?v=190','v1.90']")
change('sentlog/phone-runtime.js','v1.89','v1.90',4)
p='sentlog-pc/index.html'
change(p,'<script src="../sentlog/session-guard.js?v=189">','<script src="../sentlog/sync-traffic.js?v=190"></script>\n<script src="../sentlog/session-guard.js?v=189">')
change(p,'photo-recovery.js?v=186','photo-recovery.js?v=190')
# PDF PC loader has its independent older query parameter.
s=(ROOT/p).read_text();import re
s,n=re.subn(r'pdf-recovery\.js\?v=\d+','pdf-recovery.js?v=190',s)
if n!=1:raise RuntimeError('Unknown PC PDF loader')
(ROOT/p).write_text(s)
change(p,'v1.89 · 同期状況の内訳・認証復旧','v1.90 · 同期通信の重複抑制')
change('sentlog/sw.js','sentlog-pwa-v200','sentlog-pwa-v201')
change('sentlog/sw.js',"'session-guard.js'","'session-guard.js','sync-traffic.js'")
# Update synthetic test fixtures for the new visibility gate and shared ACK service.
change('tests/integration.test.cjs','syncing:false,navigator:{onLine:true},','syncing:false,syncNotBefore:0,document:{hidden:false,getElementById:()=>null},navigator:{onLine:true},')
change('tests/integration.test.cjs',"rest:async path=>path.includes('sentlog_projects?')?controls:[{revision:1,payload:{project:{}}}],","rest:async path=>path.includes('sentlog_projects?')?controls:path.includes('sentlog_assets?')?[]:[{revision:1,payload:{project:{}}}],")
change('tests/image_recovery_view.test.cjs','  context.window=context;',"""  context.window=context;
  vm.runInContext(fs.readFileSync('sentlog/sync-traffic.js','utf8'),context);
  const receipts=new Map();
  context.SentlogSyncTraffic=context.SentlogSyncTraffic.create({store:{
    get:async k=>receipts.get(k),put:async(k,v)=>receipts.set(k,v),remove:async k=>receipts.delete(k)
  }});""")
change('tests/image_recovery_view.test.cjs','x.ms===10000','x.ms===30000')
change('tests/image_recovery_view.test.cjs','the real ten-second recovery timer','the real thirty-second recovery timer')
change('tests/image_recovery_view.test.cjs',"assert(f.requests.some(x=>x.includes('/rpc/sentlog_ack_pdf')),'verified-file acknowledgement still runs');","assert.equal(f.requests.filter(x=>x.includes('/rpc/sentlog_ack_pdf')).length,1,'verified-file acknowledgement runs once, not every poll');")
# Match the live ACK RPC contract in the synthetic network fixture.
change('tests/sync_merge_ui.py','respond(route,True);return',"respond(route,{'received':True});return",2)
# Preserve existing tests; only update their explicit release markers/URLs.
for file in (ROOT/'tests').iterdir():
 if file.suffix not in ('.py','.cjs') or file.name=='sync_traffic.test.cjs':continue
 s=file.read_text();u=s.replace("'v1.89'","'v1.90'").replace('sentlog-pwa-v200','sentlog-pwa-v201')
 for name,old,new in [('phone-runtime','189','190'),('cloud-sync','20261022-auth-189','20261023-traffic-190'),('photo-recovery','187','190'),('photo-recovery','186','190'),('pdf-recovery','141','190')]:
  u=u.replace(f'{name}.js?v={old}',f'{name}.js?v={new}').replace(rf'{name}\.js\?v={old}',rf'{name}\.js\?v={new}')
 u=u.replace('v1.89 · 同期状況の内訳・認証復旧','v1.90 · 同期通信の重複抑制')
 if u!=s:file.write_text(u)
for file in ['sentlog/sync-traffic.js','sentlog/cloud-sync.js','sentlog/photo-recovery.js','sentlog/pdf-recovery.js']:
 subprocess.run(['node','--check',file],cwd=ROOT,check=True)
subprocess.run(['node','tests/sync_traffic.test.cjs'],cwd=ROOT,check=True)
print('Built v1.90: durable content-scoped ACKs, file receive locks, revision-only polling, foreground throttle; user data unchanged')

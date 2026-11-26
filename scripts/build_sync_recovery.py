"""Version verified file recovery and explicit legacy PDF review as v2.01."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261126-drawing-recovery-201'
MARKER = 'sentlog-drawing-recovery-v201'
MODULES = ['record-store', 'cloud-sync', 'delta-sync-app-migration',
           'delta-sync-migration-recovery', 'delta-sync-drawing-review', 'delta-sync-asset-runtime', 'delta-sync-asset-transport',
           'delta-sync-legacy-source', 'delta-sync-migration', 'delta-sync-reconcile',
           'delta-sync-assets', 'delta-sync-transport', 'pdf-recovery', 'peer-photo-recovery', 'blob-sha256']

# The earlier archive/management builders bind exact historical source hashes.
# Keep their reviewed inputs intact and connect these two completed runtimes
# here, after those transformations, with exact integration-point guards.
HASH_CHANGES = {
    'sentlog/cloud-sync.js': (
        'async function sha256Hex(blob){',
        """async function sha256Hex(blob,options={}){
  if(window.SentlogBlobSha256?.digest)return window.SentlogBlobSha256.digest(blob,{crypto,...options});
  if(blob.size>2*1024*1024)throw Object.assign(Error('大きなファイルの内容照合機能を読み込めません。元の記録を保持しています'),{code:'BLOB_HASH_UPGRADE'});"""),
    'sentlog/pdf-recovery.js': (
        "async function hash(blob){if(localHashes.has(blob))return localHashes.get(blob);const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());const h=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');localHashes.set(blob,h);return h}",
        """async function hash(blob){
  if(localHashes.has(blob))return localHashes.get(blob);
  let h;
  if(window.SentlogBlobSha256?.digest)h=await window.SentlogBlobSha256.digest(blob,{crypto});
  else{
    if(blob.size>2*1024*1024)throw Object.assign(Error('大きな図面の内容照合機能を読み込めません。元の図面を保持しています'),{code:'BLOB_HASH_UPGRADE'});
    const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());h=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  }
  localHashes.set(blob,h);return h;
}""")
}

# The legacy timer and targeted opener share the same guarded receiver. This
# final integration deliberately leaves the historical PDF source/hash intact.
# Each replacement also serves as an exact production-function test fixture.
PDF_HANDOVER_HELPERS = r'''
const PDF_HANDOVER_STATUS='図面の確認待ちです。同期画面で図面の候補を確認してください。';
function legacyPdfBlocked(projectId){
  return !IS_PC&&(window.SentlogRecords?.deltaJournal?.listBindingStatesSync?.()||[])
    .some(binding=>binding.phase==='staging'&&binding.scope?.projectId===projectId);
}
function legacyPdfActor(s=session(),id=device()){return {ownerId:s?.user?.id,deviceId:id};}
function legacyPdfCheck(a,actor){
  if(!actor?.ownerId||!actor.deviceId||session()?.user?.id!==actor.ownerId||device()!==actor.deviceId||
    !session()?.access_token||!IS_PC&&!window.SentlogRecords?.ready)
    throw Object.assign(Error('受信中に利用者または保存先が変更されました。もう一度同期を確認してください。'),{code:'PDF_RECOVERY_CONTEXT'});
  if(legacyPdfBlocked(a.project_id))throw Object.assign(Error(PDF_HANDOVER_STATUS),{code:'JOURNAL_PDF_HANDOVER'});
  return true;
}
async function legacyPdfValidate(a,actor){
  legacyPdfCheck(a,actor);
  if(!IS_PC){
    const journal=window.SentlogRecords?.deltaJournal;
    if(typeof journal?.assertLegacyPdfReceive!=='function')
      throw Object.assign(Error('図面の保護機能を読み込めません。画面を更新して同期を確認してください。'),{code:'PDF_RECOVERY_CONTEXT'});
    await journal.assertLegacyPdfReceive({projectId:a.project_id,key:fileKey(a)});
  }
  return legacyPdfCheck(a,actor);
}
function legacyPdfDeferred(error){return error?.code==='JOURNAL_PDF_HANDOVER';}
'''
PDF_HANDOVER_REPLACEMENTS = [
    ("const localHashes=new WeakMap();", "const localHashes=new WeakMap();", 1),
    (r'''async function db(name,store,key,value){
  if(value!==undefined && name==='surveyFieldNoteDB' && window.SentlogRecords?.ready)return window.SentlogRecords.writeFile(key,value);''', r'''async function db(name,store,key,value,receive){
  if(value!==undefined&&name==='surveyFieldNoteDB'){
    if(!receive||!window.SentlogRecords?.ready||!window.SentlogRecords.writeFile)
      throw Object.assign(Error('図面を安全に保存する準備ができていません。同期を確認してください。'),{code:'PDF_RECOVERY_CONTEXT'});
    legacyPdfCheck(receive.asset,receive.actor);
    return window.SentlogRecords.writeFile(key,value,{operation:'legacy-pdf-receive',
      context:{projectId:receive.asset.project_id,ownerId:receive.actor.ownerId,deviceId:receive.actor.deviceId},
      validate:()=>legacyPdfCheck(receive.asset,receive.actor)});
  }''', 1),
    (r'''async function acknowledge(a,id,force=false){
  return waitPdfReceipt(window.SentlogSyncTraffic.ack('pdf',a,id,args=>rpc('sentlog_ack_pdf',args),{force}));
}
async function forgetPdfReceipt(a,id){
  return waitPdfReceipt(window.SentlogSyncTraffic.forget('pdf',a,id));
}''', r'''async function acknowledge(a,id,force=false,actor=legacyPdfActor(session(),id)){
  await legacyPdfValidate(a,actor);
  // The traffic queue may await a lock/cache read before invoking send. Check
  // durable ownership again inside that callback, not only at queue entry.
  return waitPdfReceipt(window.SentlogSyncTraffic.ack('pdf',a,id,async args=>{
    await legacyPdfValidate(a,actor);return rpc('sentlog_ack_pdf',args);
  },{force}));
}
async function forgetPdfReceipt(a,id,actor=legacyPdfActor(session(),id)){
  await legacyPdfValidate(a,actor);
  return waitPdfReceipt(window.SentlogSyncTraffic.forget('pdf',a,id));
}''', 1),
    (r'''async function supply(a,id){
  let blob=IS_PC?await pcFile(a):await localFile(a);
  if(!await matches(blob,a))return false;
  const claim=await rpc('sentlog_claim_pdf_redelivery',{p_asset_id:a.id,p_device_id:id,p_sha256:a.sha256,p_byte_size:blob.size});
  if(!claim?.claimed)return false;
  const path=claim.storage_path.split('/').map(enc).join('/');
  await net('/storage/v1/object/'+BUCKET+'/'+path,{method:'POST',headers:{'Content-Type':a.mime_type||'application/pdf','x-upsert':'false'},body:blob});
  await rpc('sentlog_finish_pdf_redelivery',{p_asset_id:a.id,p_device_id:id,p_token:claim.token});
  return true;
}''', r'''async function supply(a,id,actor){
  await legacyPdfValidate(a,actor);
  let blob=IS_PC?await pcFile(a):await localFile(a);
  if(!await matches(blob,a))return false;
  await legacyPdfValidate(a,actor);
  const claim=await rpc('sentlog_claim_pdf_redelivery',{p_asset_id:a.id,p_device_id:id,p_sha256:a.sha256,p_byte_size:blob.size});
  if(!claim?.claimed)return false;
  await legacyPdfValidate(a,actor);
  const path=claim.storage_path.split('/').map(enc).join('/');
  await net('/storage/v1/object/'+BUCKET+'/'+path,{method:'POST',headers:{'Content-Type':a.mime_type||'application/pdf','x-upsert':'false'},body:blob});
  await legacyPdfValidate(a,actor);
  await rpc('sentlog_finish_pdf_redelivery',{p_asset_id:a.id,p_device_id:id,p_token:claim.token});
  return true;
}''', 1),
    ("  const s=session(),id=device();", "  const s=session(),id=device(),receiveActor=legacyPdfActor(s,id);", 2),
    ("try{if(await supply(a,id))supplied++}", "try{if(await supply(a,id,receiveActor))supplied++}", 1),
    ("    const missingNames=[],differentNames=[];", "    const missingNames=[],differentNames=[],deferredNames=[];", 1),
    ("    for(const a of receiveGuard.order(receiveAssets)){", "    for(const a of receiveGuard.order(receiveAssets)){\n      if(legacyPdfBlocked(a.project_id)){deferredNames.push(a.file_name||'図面PDF');continue;}", 1),
    (r'''      try{
        let blob=await localFile(a);
        if(await matches(blob,a)){
          const requestKey=a.id+':'+String(a.sha256).toLowerCase();
          available++;await acknowledge(a,id,requestedForThisDevice.has(requestKey));
          if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(a.metadata.drawing_id,blob);
          continue;
        }''', r'''      try{
        await legacyPdfValidate(a,receiveActor);
        let blob=await localFile(a);
        if(await matches(blob,a)){
          const requestKey=a.id+':'+String(a.sha256).toLowerCase();
          await acknowledge(a,id,requestedForThisDevice.has(requestKey),receiveActor);
          await legacyPdfValidate(a,receiveActor);
          if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(a.metadata.drawing_id,blob);
          legacyPdfCheck(a,receiveActor);available++;
          continue;
        }
        await legacyPdfValidate(a,receiveActor);''', 1),
    ("          await forgetPdfReceipt(a,id);", "          await forgetPdfReceipt(a,id,receiveActor);\n          await legacyPdfValidate(a,receiveActor);", 1),
    (r'''        await db('surveyFieldNoteDB','files',fileKey(a),named);
        blob=await localFile(a);
        if(!await matches(blob,a))throw new Error('端末内PDFの保存照合に失敗しました');
        available++;await acknowledge(a,id,true);
        if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(a.metadata.drawing_id,blob);
      }catch(e){if(deliveryGuard.isTransient(e))throw e;errors++;console.warn('PDF receive',a.id,e.message)}''', r'''        await legacyPdfValidate(a,receiveActor);
        await db('surveyFieldNoteDB','files',fileKey(a),named,{asset:a,actor:receiveActor});
        blob=await localFile(a);
        if(!await matches(blob,a))throw new Error('端末内PDFの保存照合に失敗しました');
        await acknowledge(a,id,true,receiveActor);
        await legacyPdfValidate(a,receiveActor);
        if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(a.metadata.drawing_id,blob);
        legacyPdfCheck(a,receiveActor);available++;
      }catch(e){
        if(legacyPdfDeferred(e)){total--;deferredNames.push(a.file_name||'図面PDF');continue;}
        if(deliveryGuard.isTransient(e))throw e;errors++;console.warn('PDF receive',a.id,e.message);
      }''', 1),
    ("    else if(differentNames.length)status(", "    else if(deferredNames.length)status(PDF_HANDOVER_STATUS+' 対象 '+deferredNames.length+' 件。');\n    else if(differentNames.length)status(", 1),
    ("panel.hidden=!(errors||missing||differentNames.length);", "panel.hidden=!(errors||missing||differentNames.length||deferredNames.length);", 1),
    (r'''  if(!a)throw Error('この図面のクラウド登録を確認できません。');
  let blob=await localFile(a);
  if(await matches(blob,a)){
    if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(drawingId,blob);
    return true;
  }''', r'''  if(!a)throw Error('この図面のクラウド登録を確認できません。');
  await legacyPdfValidate(a,receiveActor);
  let blob=await localFile(a);
  if(await matches(blob,a)){
    await legacyPdfValidate(a,receiveActor);
    if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(drawingId,blob);
    legacyPdfCheck(a,receiveActor);return true;
  }
  await legacyPdfValidate(a,receiveActor);''', 1),
    (r'''  await db('surveyFieldNoteDB','files',fileKey(a),named);
  blob=await localFile(a);
  if(!await matches(blob,a))throw Error('端末内への図面保存照合に失敗しました。');
  if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(drawingId,blob);
  acknowledge(a,id,true).catch(()=>{});
  status('図面を再取得しました：'+(a.file_name||'図面'));''', r'''  await legacyPdfValidate(a,receiveActor);
  await db('surveyFieldNoteDB','files',fileKey(a),named,{asset:a,actor:receiveActor});
  blob=await localFile(a);
  if(!await matches(blob,a))throw Error('端末内への図面保存照合に失敗しました。');
  await legacyPdfValidate(a,receiveActor);
  if(window.sentlogRestoreDrawingView)await window.sentlogRestoreDrawingView(drawingId,blob);
  legacyPdfCheck(a,receiveActor);
  acknowledge(a,id,true,receiveActor).catch(()=>{});
  status('図面を再取得しました：'+(a.file_name||'図面'));''', 1),
    ("catch(e){console.warn('Targeted PDF recovery',e);status('図面再取得の確認が必要です：'+e.message);}", "catch(e){\n        if(legacyPdfDeferred(e)){status(PDF_HANDOVER_STATUS);return false;}\n        console.warn('Targeted PDF recovery',e);status('図面再取得の確認が必要です：'+e.message);\n        if(e?.code==='PDF_RECOVERY_CONTEXT')return false;\n      }", 1),
]

for filename, (old, new) in HASH_CHANGES.items():
    path = ROOT / filename
    source = path.read_text(encoding='utf-8')
    if source.count(old) != 1:
        raise RuntimeError('Bounded hashing integration changed: ' + filename)
    path.write_text(source.replace(old, new), encoding='utf-8')

path = ROOT / 'sentlog/pdf-recovery.js'
source = path.read_text(encoding='utf-8')
for old, new, count in PDF_HANDOVER_REPLACEMENTS:
    if source.count(old) != count:
        raise RuntimeError('PDF handover integration changed: ' + old[:100])
    source = source.replace(old, new)
source = source.replace('const localHashes=new WeakMap();',
                        'const localHashes=new WeakMap();\n' + PDF_HANDOVER_HELPERS, 1)
path.write_text(source, encoding='utf-8')

for name in MODULES:
    path = ROOT / 'sentlog' / (name + '.js')
    source = path.read_text(encoding='utf-8')
    if MARKER in source:
        raise RuntimeError('Sync recovery requires a pristine build')
    path.write_text('// ' + MARKER + '\n' + source, encoding='utf-8')

versions = set()
for filename in ['sentlog/index.html', 'sentlog-pc/index.html', 'sentlog/drawing-export-view.html']:
    path = ROOT / filename
    source = path.read_text(encoding='utf-8')
    prefix = '../sentlog/' if filename.startswith('sentlog-pc/') else './'
    if 'blob-sha256.js' in source:
        raise RuntimeError('Bounded blob hashing requires a pristine build')
    blob_script = '<script src="' + prefix + 'blob-sha256.js?v=' + TOKEN + '"></script>'
    if filename == 'sentlog/index.html':
        boot_store = re.search(r'<script src="\./record-store\.js[^\"]*">', source)
        if not boot_store:
            raise RuntimeError('Missing boot-time record store')
        source = source[:boot_store.start()] + blob_script + source[boot_store.start():]
    else:
        source = source.replace('</head>', blob_script + '</head>', 1)
    if filename == 'sentlog/index.html':
        if source.count('const deps=[') != 1:
            raise RuntimeError('Missing complete-release dependency list')
        source = source.replace('const deps=[', "const deps=[['blob-sha256.js?v=" + TOKEN + "','" + MARKER + "'],", 1)
    for name in MODULES:
        pattern = re.escape(name) + r'\.js\?v=([A-Za-z0-9._-]+)'
        versions.update((name, version) for version in re.findall(pattern, source))
        source = re.sub(pattern, name + '.js?v=' + TOKEN, source)
    source = source.replace('phone-runtime.js?v=198', 'phone-runtime.js?v=201')
    source = source.replace("'v1.98'", "'v2.01'")
    source = source.replace('v1.98 · 多角形の確定方向を安定化', 'v2.01 · 同期が止まった図面の確認・復旧')
    if filename == 'sentlog/index.html':
        for name in MODULES:
            pattern = r"\['" + re.escape(name) + r"\.js\?v=" + re.escape(TOKEN) + r"','[^']+'\]"
            if len(re.findall(pattern, source)) != 1:
                raise RuntimeError('Missing complete-release check for ' + name)
            source = re.sub(pattern, "['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']", source)
    path.write_text(source, encoding='utf-8')

path = ROOT / 'sentlog/phone-runtime.js'
source = path.read_text(encoding='utf-8')
if source.count('v1.98') != 4:
    raise RuntimeError('Unexpected preceding phone version')
path.write_text(source.replace('v1.98', 'v2.01'), encoding='utf-8')

path = ROOT / 'sentlog/sw.js'
source = path.read_text(encoding='utf-8')
old_cache = re.search(r'sentlog-pwa-v\d+', source).group()
# The same preceding build generated v2.00 with +2. This release needs its own
# cache generation and new URLs for every changed runtime module.
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 3)
source = source.replace(old_cache, new_cache)
if source.count('const FILES=[') != 1:
    raise RuntimeError('Missing offline file inventory')
source = source.replace('const FILES=[', "const FILES=['blob-sha256.js',", 1)
path.write_text(source, encoding='utf-8')

for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    old = path.read_text(encoding='utf-8')
    source = old.replace(old_cache, new_cache).replace("'v1.98'", "'v2.01'")
    source = source.replace('phone-runtime.js?v=198', 'phone-runtime.js?v=201')
    source = source.replace(r'phone-runtime\.js\?v=198', r'phone-runtime\.js\?v=201')
    source = source.replace('v1.98 · 多角形の確定方向を安定化', 'v2.01 · 同期が止まった図面の確認・復旧')
    for name, version in versions:
        source = source.replace(name + '.js?v=' + version, name + '.js?v=' + TOKEN)
        source = source.replace(name + r'\.js\?v=' + version, name + r'\.js\?v=' + TOKEN)
    source = source.replace("['peer-photo-recovery.js?v=" + TOKEN + "','sentlogCheckPeerPhotos']",
                            "['peer-photo-recovery.js?v=" + TOKEN + "','" + MARKER + "']")
    if source != old:
        path.write_text(source, encoding='utf-8')

for name in MODULES:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
subprocess.run(['node', 'tests/delta_migration_recovery.test.cjs'], cwd=ROOT, check=True)
print('Built v2.01 verified recovery, explicit legacy PDF review and bounded file work; ' + new_cache)

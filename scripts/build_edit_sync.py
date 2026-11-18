"""Install edit-triggered synchronization after the guarded production builders.

No database schema, user records or stored photos are migrated by this build.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261118-edit-sync'
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Edit sync integration changed: {path}: {old[:100]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


p = 'sentlog/cloud-sync.js'
change(p, 'let syncNotBefore=0;', 'let syncNotBefore=0;\nlet syncErrorNotBefore=0;')
change(p, 'async function pullRemoteProjects(deviceId,manualProject=null,cycleAssets=null){',
       'async function pullRemoteProjects(deviceId,manualProject=null,cycleAssets=null,projectIds=null,quick=false){')
change(p, '  const blocked=new Set();let changed=0,files=0,conflicts=0;syncConflicts.clear();',
       '  const blocked=new Set(),assetProjects=new Set();let changed=0,files=0,conflicts=0;\n'
       '  if(projectIds){for(const id of projectIds)syncConflicts.delete(id);}else syncConflicts.clear();\n'
       '  knownCloudProjects.clear();for(const cp of cps||[])knownCloudProjects.set(cp.id,cp);')
change(p, '    if(!cp.client_key||!archive.canSync(cp,manualProject))continue;',
       '    if(!cp.client_key||(projectIds&&!projectIds.has(cp.client_key))||!archive.canSync(cp,manualProject))continue;')
change(p, '    const exists=(workspace().projects||[]).some(p=>p.id===cp.client_key);',
       '    const existing=(workspace().projects||[]).find(p=>p.id===cp.client_key);\n'
       '    const exists=!!existing;\n'
       '    let needsFiles=!quick||projectFilesChanged(existing,before?.base_snapshot);')
change(p, '      files+=await pullProjectAssets(cp,deviceId,cycleAssets);continue;',
       '      if(needsFiles){assetProjects.add(cp.id);files+=await pullProjectAssets(cp,deviceId,cycleAssets);}continue;')
change(p, '    const snap=snaps?.[0];if(!snap?.payload?.project)continue;',
       '    const snap=snaps?.[0];if(!snap?.payload?.project)continue;\n'
       '    if(quick&&sharedFileText(before?.base_snapshot)!==sharedFileText(snap.payload))needsFiles=true;')
change(p, '    if(!blocked.has(cp.id))files+=await pullProjectAssets(cp,deviceId,cycleAssets);',
       '    if(!blocked.has(cp.id)&&needsFiles){assetProjects.add(cp.id);files+=await pullProjectAssets(cp,deviceId,cycleAssets);}')
change(p, '  return {changed,files,blocked,conflicts};', '  return {changed,files,blocked,conflicts:syncConflicts.size,assetProjects};')
change(p, '''  const manualProject=options?.manualProject||null;
  if(syncing||mergeBusy||!navigator.onLine||!session||window.sentlogImporting||document.hidden)return;
  if(!options?.force&&Date.now()<syncNotBefore)return;''', '''  const manualProject=options?.manualProject||null;
  const quick=!!options?.eventDriven&&syncErrorNotBefore===0;
  const projectIds=Array.isArray(options?.projectIds)&&options.projectIds.length?new Set(options.projectIds):null;
  if(syncing||mergeBusy||!navigator.onLine||!session||window.sentlogImporting||document.hidden)return {started:false};
  if(!options?.force&&Date.now()<syncErrorNotBefore)return {started:false,retryAt:syncErrorNotBefore};
  if(!options?.force&&!quick&&Date.now()<syncNotBefore)return {started:false,retryAt:syncNotBefore};''')
change(p, '  syncNotBefore=Date.now()+10000;', '  if(!quick)syncNotBefore=Date.now()+10000;')
change(p, '  let remoteChanged=0;', '  let remoteChanged=0,retryAt=0;')
change(p, '    const pulled=await pullRemoteProjects(deviceId,manualProject,cycleAssets);',
       '    const pulled=await pullRemoteProjects(deviceId,manualProject,cycleAssets,projectIds,quick);')
change(p, '      if(!archive.includeLocal(lp.id,manualProject))continue;',
       '      if((projectIds&&!projectIds.has(lp.id))||!archive.includeLocal(lp.id,manualProject))continue;')
change(p, '      const snap=await upsertSnapshot(cp,lp,deviceId);',
       '      const syncFiles=!quick||pulled.assetProjects.has(cp.id)||projectFilesChanged(lp,getSyncMeta(lp.id)?.base_snapshot);\n'
       '      const snap=await upsertSnapshot(cp,lp,deviceId);')
change(p, '      if(!snap.skipped)uploaded++;', '      if(!snap.skipped)uploaded++;\n      if(!syncFiles)continue;')
change(p, "    if(drawingErrors.length)syncStatus.finish(statusCycle,{level:'error',label:'PDF要確認',message:drawingErrors.join(' / ')});",
       "    // Only a complete automatic pass clears file-retry state; a successful\n"
       "    // scoped/manual pass cannot acknowledge another project's failed files.\n"
       "    if(drawingErrors.length){retryAt=syncErrorNotBefore=Date.now()+30000;}else if(!projectIds&&!manualProject)syncErrorNotBefore=0;\n"
       "    if(drawingErrors.length)syncStatus.finish(statusCycle,{level:'error',label:'PDF要確認',message:drawingErrors.join(' / ')});")
change(p, '    syncNotBefore=Date.now()+30000;', '    retryAt=syncErrorNotBefore=syncNotBefore=Date.now()+30000;')
change(p, '  }finally{syncing=false;refreshMergePanel()}\n}',
       '  }finally{syncing=false;refreshMergePanel();editSync.wake()}\n  return {started:true,...(retryAt?{retryAt}:{})};\n}')

# Remote commits never become outgoing edit notifications. Local edits made
# during an awaited network operation still retain their own queue entries.
change('sentlog/sync-view.js',
       'await window.SentlogRecords.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:mergeOptions.expectedRecords[0][1],expectedRecords:mergeOptions.expectedRecords});',
       "await window.SentlogRecords.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:mergeOptions.expectedRecords[0][1],expectedRecords:mergeOptions.expectedRecords,origin:'remote'});")
change('sentlog/sync-view.js', 'else window.SentlogRecords.batch(writes);',
       "else window.SentlogRecords.batch(writes,{origin:'remote'});")
change('sentlog/sync-view.js', 'window.sentlogSyncView={snapshotText,commit,',
       "window.sentlogSyncView={snapshotText,isBusy:()=>currentView==='editor'&&busy(),commit,")
change('sentlog/archive-capacity.js', 'await S.archiveAtomic({writes,deleteFiles:counter2.deletions,expectedWorkspace:before.raw});',
       "await S.archiveAtomic({writes,deleteFiles:counter2.deletions,expectedWorkspace:before.raw,origin:'device'});")
change('sentlog/archive-capacity.js', 'await S.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:wsText});',
       "await S.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:wsText,origin:'device'});")

runtime = (ROOT / 'sentlog/edit-sync-runtime.txt').read_text(encoding='utf-8')
change(p, '\nloadSession();\nsyncStatus.setAccount',
       '\n' + runtime + '\nloadSession();editSyncSessionChanged();\nsyncStatus.setAccount')
change(p, 'function updateCloudUI(){\n', 'function updateCloudUI(){\n  editSyncSessionChanged();\n')
change(p, "window.addEventListener('online',()=>{syncStatus.setOnline(true);syncNow()});",
       "window.addEventListener('online',()=>{syncStatus.setOnline(true);wakeEditSync();syncNow()});")
change(p, "window.addEventListener('focus',()=>syncNow());", "window.addEventListener('focus',()=>{wakeEditSync();syncNow()});")
change(p, "window.addEventListener('pageshow',()=>syncNow());", "window.addEventListener('pageshow',()=>{wakeEditSync();syncNow()});")
change(p, "document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncNow()});",
       "document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){wakeEditSync();syncNow()}});")

change('sentlog/index.html', 'const deps=[', "const deps=[['edit-sync.js?v=" + TOKEN + "','SentlogEditSync'],")
change('sentlog/index.html', '<script type="module" src="./cloud-sync.js?',
       '<script src="./edit-sync.js?v=' + TOKEN + '"><\\/script><script type="module" src="./cloud-sync.js?')
revisions = [('cloud-sync.js', '20261105-device-label-207'), ('sync-view.js', '20261118-memo'), ('archive-capacity.js', '140')]
for name, version in revisions:
    change('sentlog/index.html', name + '?v=' + version, name + '?v=' + TOKEN, 2)
change('sentlog/index.html', "['cloud-sync.js?v=" + TOKEN + "','sentlogRecordReview']",
       "['cloud-sync.js?v=" + TOKEN + "','edit-sync-v20261118']")
change('sentlog/sw.js', "'index.html'", "'index.html','edit-sync.js'")
worker = pending['sentlog/sw.js']
match = re.search(r'sentlog-pwa-v(\d+)', worker)
if not match:
    raise RuntimeError('Edit sync offline cache revision missing')
old_cache = match.group(0)
new_cache = 'sentlog-pwa-v' + str(int(match.group(1)) + 1)
pending['sentlog/sw.js'] = worker.replace(old_cache, new_cache)

for file in (ROOT / 'tests').iterdir():
    if file.suffix not in ('.cjs', '.py'):
        continue
    path = str(file.relative_to(ROOT))
    source = pending.get(path, file.read_text(encoding='utf-8'))
    revised = source.replace(old_cache, new_cache)
    for name, version in revisions:
        revised = revised.replace(name + '?v=' + version, name + '?v=' + TOKEN)
        revised = revised.replace(name.replace('.', r'\.') + r'\?v=' + version,
                                  name.replace('.', r'\.') + r'\?v=' + TOKEN)
    if revised != source:
        pending[path] = revised

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
for file in ('edit-sync.js', 'cloud-sync.js', 'sync-view.js'):
    subprocess.run(['node', '--check', 'sentlog/' + file], cwd=ROOT, check=True)
print('Built edit-triggered scoped synchronization, retained retry queue, revision-only receive checks and unchanged-file fast path')

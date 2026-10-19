"""v1.80: record merges with local checkpoints, after the v1.79 pipeline."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
pending={}
def change(path,old,new,count=1):
    text=pending.get(path,(ROOT/path).read_text())
    if text.count(old)!=count:raise RuntimeError(f'Sync merge integration mismatch: {path}: {old[:100]!r}')
    pending[path]=text.replace(old,new)

p='sentlog/record-store.js'
change(p,"const managed=k=>k===LOCAL_ARCH || k===WS ||", "const managed=k=>k.startsWith('sentlogSyncMergeCheckpointV1:') || k===LOCAL_ARCH || k===WS ||")
change(p,'async function archiveAtomic({writes=[],deleteFiles=[],expectedWorkspace}={}){',
       'async function archiveAtomic({writes=[],deleteFiles=[],expectedWorkspace,expectedRecords=[]}={}){')
change(p,'    const updates=[...writes],files=[...deleteFiles];',
       "    const updates=[...writes],files=[...deleteFiles];\n    const unchanged=()=>expectedRecords.every(([key,value])=>(memory.get(key)??null)===value);\n    if(!unchanged())throw Error('確認中に記録が変わりました。もう一度操作してください。');")
change(p,'Number(oldMeta.revision)!==revision||memory.get(WS)!==expectedWorkspace)',
       'Number(oldMeta.revision)!==revision||memory.get(WS)!==expectedWorkspace||!unchanged())')

p='sentlog/sync-view.js'
change(p,'async function commit(cloudProject,snapshot,expectedLocal){','async function commit(cloudProject,snapshot,expectedLocal,mergeOptions=null){')
change(p,'    const active=currentView===\'editor\' && activeProjectId===id;',
       "    if(mergeOptions && currentView==='editor')return {applied:false,reason:'close-drawing'};\n    const active=currentView==='editor' && activeProjectId===id;")
change(p,'    window.SentlogRecords.batch(writes);',
       "    if(mergeOptions){\n      for(const [k,v] of mergeOptions.extraWrites)writes.set(k,v);\n      await window.SentlogRecords.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:mergeOptions.expectedRecords[0][1],expectedRecords:mergeOptions.expectedRecords});\n    }else window.SentlogRecords.batch(writes);")
change(p,'  window.sentlogSyncView={snapshotText,commit,groupFingerprintSchema:2,',
       '  window.sentlogSyncView={snapshotText,commit,mergeCommit:(cp,snap,expected,options)=>commit(cp,snap,expected,options),groupFingerprintSchema:2,')

p='sentlog/cloud-sync.js'
change(p,'function setSyncMeta(projectId,meta){','function setSyncMeta(projectId,meta,baseline){')
change(p,'JSON.stringify({...meta,fingerprint_schema:SYNC_FINGERPRINT_SCHEMA})',
       'JSON.stringify({...meta,fingerprint_schema:SYNC_FINGERPRINT_SCHEMA,...(baseline?{base_snapshot:baseline}:{})})')
change(p,'remote_updated_at:made?.[0]?.updated_at||updatedAt,fingerprint});',
       'remote_updated_at:made?.[0]?.updated_at||updatedAt,fingerprint},payload.payload);')
change(p,'remote_updated_at:snap.updated_at,fingerprint:localFingerprint});',
       'remote_updated_at:snap.updated_at,fingerprint:localFingerprint},snap.payload);')
change(p,'remote_updated_at:snap.updated_at,fingerprint:incomingFingerprint});',
       'remote_updated_at:snap.updated_at,fingerprint:incomingFingerprint},snap.payload);')
change(p,' || !meta || (!!meta?.fingerprint', ' || !meta || !meta.base_snapshot || (!!meta?.fingerprint')
change(p,'const localChanged=lp && meta && (meta.restored_backup ||', 'const localChanged=lp && (!meta || meta.restored_backup ||')
change(p,'      if(localChanged && localFingerprint!==incomingFingerprint){',
       "      if(localChanged && currentFingerprint && incomingFingerprint===meta?.fingerprint){\n        setSyncMeta(cp.client_key,{...meta,revision:remoteRev,remote_updated_at:snap.updated_at},snap.payload);\n      }else if(localChanged && localFingerprint!==incomingFingerprint){")
# Never cache a stale project reference across network awaits. Also compare content,
# because two edits can legitimately have the same millisecond timestamp.
change(p,'  const meta=getSyncMeta(localProject.id);\n  const localUpdated=Number(localProject.updatedAt||0);\n  if(meta && Number(meta.local_updated_at||0)===localUpdated)return {skipped:true,revision:Number(meta.revision||0)};',
       "  localProject=workspace().projects.find(p=>p.id===localProject.id);\n  if(!localProject)return {skipped:true};\n  const meta=getSyncMeta(localProject.id);\n  const localUpdated=Number(localProject.updatedAt||0);\n  const captured=projectSnapshot(localProject);\n  const capturedFingerprint=await snapshotFingerprint(captured);\n  if(meta?.fingerprint===capturedFingerprint && Number(meta.fingerprint_schema||0)>=SYNC_FINGERPRINT_SCHEMA)return {skipped:true,revision:Number(meta.revision||0)};")
change(p,'revision:rev,payload:projectSnapshot(localProject),updated_by_device:',
       'revision:rev,payload:captured,updated_by_device:')
change(p,'  const blocked=new Set();let changed=0,files=0,conflicts=0;',
       '  const blocked=new Set();let changed=0,files=0,conflicts=0;syncConflicts.clear();')
change(p,'        blocked.add(cp.id);conflicts++;',
       "        let result=null;\n        if(meta?.base_snapshot){try{result=await tryMergeProject(cp,snap);}catch(e){result={applied:false,reason:e.message};}}\n        if(result?.applied)changed++;\n        else {blocked.add(cp.id);if(!result?.waiting){conflicts++;syncConflicts.set(cp.client_key,cp);}}")
change(p,'  if(syncing||!navigator.onLine||!session||window.sentlogImporting)return;',
       '  if(syncing||mergeBusy||!navigator.onLine||!session||window.sentlogImporting)return;')
change(p,'  }finally{syncing=false}', '  }finally{syncing=false;refreshMergePanel()}')
change(p,'\nfunction modalHtml(){','\n'+(ROOT/'sentlog/sync-merge-runtime.txt').read_text()+'\nfunction modalHtml(){')
change(p,'<div id="sentlogCloudDetails"></div>', '<div id="sentlogCloudDetails"></div><div id="sentlogMergePanel" hidden></div>')
change(p,'width:min(420px,100%);background:#fff;', 'width:min(420px,100%);max-height:90dvh;overflow-y:auto;background:#fff;')
change(p,"syncStatus.refresh()}","syncStatus.refresh();refreshMergePanel()}")
change(p,"  updateCloudUI();\n}\nfunction openModal()", "  updateCloudUI();installMergeHistory();\n}\nfunction openModal()")

p='sentlog/index.html'
change(p,"['dxf.js?v=179','SentlogDxf']", "['dxf.js?v=179','SentlogDxf'],['sync-merge.js?v=180','SentlogSyncMerge']")
change(p,'<script src="./sync-view.js?v=178">','<script src="./sync-merge.js?v=180"><\\/script><script src="./sync-view.js?v=178">')
for old,new in [('record-store.js?v=130','record-store.js?v=180'),('sync-view.js?v=178','sync-view.js?v=180'),('cloud-sync.js?v=20261018-dxf-178','cloud-sync.js?v=20261019-merge-180'),('phone-runtime.js?v=179','phone-runtime.js?v=180')]:
    change(p,old,new,1 if old.startswith('record-store') else 2)
change(p,"['phone-runtime.js?v=180','v1.79']","['phone-runtime.js?v=180','v1.80']")
change(p,"['cloud-sync.js?v=20261019-merge-180','archive-v133']","['cloud-sync.js?v=20261019-merge-180','mergeSelectedProject']")
change(p,"['sync-view.js?v=180','canRestoreDrawing']","['sync-view.js?v=180','mergeCommit'],['record-store.js?v=180','sentlogSyncMergeCheckpointV1:']")
change('sentlog/phone-runtime.js','v1.79','v1.80',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v190';","const CACHE='sentlog-pwa-v191';")
change('sentlog/sw.js',"'record-store.js','storage-ui.js'","'record-store.js','sync-merge.js','storage-ui.js'")
for path in (ROOT/'tests').iterdir():
    if path.suffix not in ('.py','.cjs'):continue
    text=path.read_text();updated=text.replace("SENTLOG_BUILD==='v1.79'","SENTLOG_BUILD==='v1.80'").replace('sentlog-pwa-v190','sentlog-pwa-v191')
    if path.name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):updated=updated.replace("'v1.79'","'v1.80'")
    updated=updated.replace(r'phone-runtime\.js\?v=179',r'phone-runtime\.js\?v=180').replace(r'sync-view\.js\?v=178',r'sync-view\.js\?v=180').replace('sync-view.js?v=178','sync-view.js?v=180').replace('20261018-dxf-178','20261019-merge-180')
    if updated!=text:pending[str(path.relative_to(ROOT))]=updated
for path,text in pending.items():(ROOT/path).write_text(text)
print('Built Sentlog v1.80: checkpointed record merge, explicit preserve-both for legacy conflicts, conservative three-way sync')

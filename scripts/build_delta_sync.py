"""Connect the verified delta journal to the actual production application.

Run last, after build_project_sync.py. Server rollout remains separately gated;
legacy projects retain their established path until a protected handover.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261121-interactions'
pending = {}


def source(path):
    return pending.get(path, (ROOT / path).read_text(encoding='utf-8'))


def change(path, old, new, count=1):
    value = source(path)
    if value.count(old) != count:
        raise RuntimeError(f'Delta application integration changed: {path}: {old[:100]!r}: {value.count(old)}')
    pending[path] = value.replace(old, new)


cloud = 'sentlog/cloud-sync.js'
if 'sentlog-delta-app-v1' in source(cloud):
    raise RuntimeError('Use a pristine production build; delta application is already connected')
if 'project-sync-controls-v1' not in source(cloud):
    raise RuntimeError('Build delta application after project synchronization')
runtime = source('sentlog/delta-sync-cloud-runtime.txt').strip()
change(cloud, 'async function collaborationMetadataRound(ids,context){', runtime + '\n\nasync function collaborationMetadataRound(ids,context){')
change(cloud, 'if(lp){collaborationNormalizeStored([id],context);await collaborationCheckSharedState(context);}',
       "if(lp&&!(window.SentlogRecords.deltaJournal.bindingStateFor?window.SentlogRecords.deltaJournal.bindingStateFor(id):window.SentlogRecords.deltaJournal.bindingFor(id))){collaborationNormalizeStored([id],context);await collaborationCheckSharedState(context);}")
change(cloud, "      stage='記録の受信';const read=await collaborationPullProject(cp,context);context.assertCurrent();changed+=read.changed;",
       """      stage='保存方式の確認';const deltaMode=await sentlogDeltaApp.inspect(cp);context.assertCurrent();
      const deltaBinding=window.SentlogRecords.deltaJournal.bindingStateFor?window.SentlogRecords.deltaJournal.bindingStateFor(id):window.SentlogRecords.deltaJournal.bindingFor(id);
      if(deltaMode.enabled||deltaBinding){
        if(!lp&&!deltaBinding){
          const initial=await collaborationPullProject(cp,context);context.assertCurrent();
          if(initial.deferred){defer(id,cp);continue;}
        }
        stage='変更履歴の保存・受信';const delta=await collaborationDeltaRound(cp,context);context.assertCurrent();
        collaborationMetadataFailures.delete(id);revisions[id]=delta.revision;
        if(delta.deferred){defer(id,cp);continue;}
        ready.add(id);needsFiles.add(id);changed+=delta.applied?1:0;continue;
      }
      stage='記録の受信';const read=await collaborationPullProject(cp,context);context.assertCurrent();changed+=read.changed;""")
change(cloud, '        if(!pushed.skipped)uploaded++;',
       """        if(!pushed.skipped)uploaded++;
        if(deltaMode.canActivate){
          stage='保存済み記録の引継ぎ';
          const activated=await sentlogDeltaApp.sync(cp,{activate:true,revision:read.revision});context.assertCurrent();
          if(activated.deferred){defer(id,cp);continue;}
          const checked=await collaborationDeltaRound(cp,context);context.assertCurrent();
          if(checked.deferred){defer(id,cp);continue;}
          read.revision=checked.revision;read.needsFiles=true;
        }""")
change(cloud, '    if(a.kind!==\'drawing\'&&a.kind!==\'photo\')continue;',
       "    if(a.kind!=='drawing'&&a.kind!=='photo')continue;\n    if(a.kind==='photo'&&window.sentlogDeltaOwnsProject(cloudProject.id))continue;")
change(cloud, "        stage='写真の送信';for(const item of collaborationCollectPhotos(latest)){",
       """        if(window.sentlogDeltaOwnsProject(cp.id)){
          stage='共有写真の保存・受領確認';const photos=await sentlogDeltaApp.photos(cp);context.assertCurrent();
          if(!photos.complete)throw Object.assign(Error(photos.message+(photos.issues.length?'：'+photos.issues[0].message:'')),{code:'DELTA_PHOTOS_PENDING'});
        }
        stage='写真の送信';for(const item of (window.sentlogDeltaOwnsProject(cp.id)?[]:collaborationCollectPhotos(latest))){""")
change(cloud, "        if(cp.status==='archived'){collaborationFileFailures.delete(id);continue;}",
       """        if(cp.status==='archived'){
          // archive.canSync has already required an explicit manual action.
          // Verified reads and device ACKs remain valid while edits/uploads
          // and ordinary active-project redelivery stay prohibited.
          if(window.sentlogDeltaOwnsProject(cp.id)){
            stage='保管済み写真の保存・受領確認';const photos=await sentlogDeltaApp.photos(cp);context.assertCurrent();
            if(!photos.complete)throw Object.assign(Error(photos.message+(photos.issues.length?'：'+photos.issues[0].message:'')),{code:'DELTA_PHOTOS_PENDING'});
          }
          collaborationFileFailures.delete(id);continue;
        }""")
change(cloud, 'function collaborationSessionChanged(){', 'function collaborationSessionChanged(){\n  sentlogDeltaApp.reset();sentlogDeltaStatuses.clear();sentlogDeltaCheckpointTimes.clear();')
change(cloud, 'function collaborationWake(){', 'function collaborationWake(){sentlogDeltaApp.wake();')

# The existing renderer continues to preserve inspector/IME drafts. Its storage
# commit now uses the journal CAS authority, never an ordinary remote batch.
view = 'sentlog/sync-view.js'
change(view, "isBusy:()=>currentView==='editor'&&busy(),",
       "isBusy:id=>currentView==='editor'&&(!id||activeProjectId===id)&&busy(),")
old = "      window.SentlogRecords.batch(writes,{origin:'remote'});"
new = """      if(mergeOptions.deltaProjection){
        const applied=await window.SentlogRecords.deltaJournal.applyProjection({...mergeOptions.deltaProjection,writes});
        if(!applied.applied||applied.deferredUI||window.SentlogRecords.pending||
          [...writes].some(([key,value])=>window.SentlogRecords.getItem(key)!==value))return {applied:false,deferred:true,reason:'local-edit'};
      }else window.SentlogRecords.batch(writes,{origin:'remote'});"""
change(view, old, new)

# Reader compatibility belongs to the base sources: partial DXF/photo builds
# also load the version-2 writer. The final build verifies that no earlier
# transform has reintroduced a fixed version-1 file reader.
for path in ['sentlog/part05.txt', 'sentlog/cloud-sync.js', 'sentlog/photo-recovery.js',
             'sentlog/peer-photo-recovery.js', 'sentlog/rescue.html']:
    value = source(path)
    if re.search(r"indexedDB\.open\((['\"]surveyFieldNoteDB['\"]|DB_NAME|DB),\s*1\)", value):
        raise RuntimeError('Fixed version-1 file reader reintroduced in ' + path)
    if path!='sentlog/rescue.html' and 'SentlogRecords.openFilesDatabase()' not in value:
        raise RuntimeError('Shared file reader missing in ' + path)
pdf_reader=source('sentlog/pdf-recovery.js')
if 'SentlogRecords.openFilesDatabase()' not in pdf_reader or "name==='surveyFieldNoteDB'?[]:[1]" not in pdf_reader:
    raise RuntimeError('PDF reader must share the app database version and preserve PC KV version 1')
part = 'sentlog/part05.txt'
value = source(part)
a = value.index('async function clearDBFiles(){')
b = value.index('\nfunction blobToDataURL(', a)
pending[part] = value[:a] + 'async function clearDBFiles(){return window.SentlogRecords.clearFiles({operation:"restore"});}\n' + value[b:]

# Old shared-photo receiving must not claim ACKs or overwrite a delta-owned
# photo after a delayed network response. PC re-delivery remains available.
photo = 'sentlog/photo-recovery.js'
change(photo, ' async function acknowledgePhoto(a,id,force=false){',
       " async function acknowledgePhoto(a,id,force=false){\n  if(!IS_PC&&window.sentlogDeltaOwnsPhoto?.(a.project_id,a.metadata?.drawing_id))return;")
change(photo, '   if(!active.has(a.project_id))continue;',
       "   if(!active.has(a.project_id)||(!IS_PC&&window.sentlogDeltaOwnsPhoto?.(a.project_id,a.metadata?.drawing_id)))continue;")
change(photo, "await window.SentlogRecords.writeFile(key,new File([blob],a.file_name||'photo.jpg',{type:a.mime_type||blob.type}));",
       "await window.SentlogRecords.writeFile(key,new File([blob],a.file_name||'photo.jpg',{type:a.mime_type||blob.type}),{onlyIfMissing:true,validate:()=>{if(window.sentlogDeltaOwnsPhoto?.(a.project_id,a.metadata?.drawing_id))throw Error('写真の受信を新しい保存処理へ引き継ぎました');}});")

# A delta archive uses the exact independently generated checkpoint. Local
# viewport/label sizes are not shared metadata and cannot block this proof.
archive = 'sentlog/archive.js'
change(archive, '  async function prove(job){',
       "  async function prove(job){\n    const deltaProof=job.delta_checkpoint?await window.sentlogDeltaArchiveProof(byCloud(job.project_id)||{id:job.project_id,client_key:job.payload.project.id},job):null;")
change(archive, '      return;\n    }\n    const before=C.snapshotText(localSnapshot(p));',
       '      if(deltaProof)await deltaProof.validate();return deltaProof;\n    }\n    const before=C.snapshotText(localSnapshot(p));')
change(archive, '    if(before!==C.snapshotText(job.payload))throw Error(',
       '    if(!deltaProof&&before!==C.snapshotText(job.payload))throw Error(')
change(archive, "    if(currentView==='editor'&&activeProjectId===pid||window.SentlogRecords.pending||window.SentlogRecords.failed||C.snapshotText(localSnapshot(getProject(pid)))!==before)throw Error('確認中に変更されました。もう一度確認します。');",
       "    if(currentView==='editor'&&activeProjectId===pid||window.SentlogRecords.pending||window.SentlogRecords.failed||C.snapshotText(localSnapshot(getProject(pid)))!==before)throw Error('確認中に変更されました。もう一度確認します。');\n    if(deltaProof)await deltaProof.validate();return deltaProof;")
change(archive, "    let clean=true,reason='未同期の変更なし';\n    try{await prove(job);}catch(e){clean=false;reason=e.message;}\n    await rpc('report',control.id,{job_id:job.id,catalog_hash:job.catalog_hash,clean,reason});",
       "    let clean=true,reason='未同期の変更なし',deltaProof=null;\n    try{deltaProof=await prove(job);}catch(e){clean=false;reason=e.message;}\n    const delta_proof=deltaProof?Object.fromEntries(Object.entries(deltaProof).filter(([,v])=>typeof v!=='function')):null;\n    await rpc('report',control.id,{job_id:job.id,catalog_hash:job.catalog_hash,clean,reason,...(delta_proof?{delta_proof}:{})});")
change(archive, "    const snapshots=await net('sentlog_project_snapshots?project_id=eq.'+encodeURIComponent(cp.id)+'&select=revision,payload');",
       "    const deltaCheckpoint=await window.sentlogDeltaCheckpoint(cp);\n    const snapshots=deltaCheckpoint?[{revision:deltaCheckpoint.revision,payload:deltaCheckpoint.payload}]:await net('sentlog_project_snapshots?project_id=eq.'+encodeURIComponent(cp.id)+'&select=revision,payload');")
change(archive, "    if(!local||!snapshot||C.snapshotText(localSnapshot(local))!==C.snapshotText(snapshot.payload))throw Error(",
       "    if(!local||!snapshot||(!deltaCheckpoint&&C.snapshotText(localSnapshot(local))!==C.snapshotText(snapshot.payload)))throw Error(")
capacity = 'sentlog/archive-capacity.js'
capacity_check = """  function freshRecordCheck(info,cp,mode){
    const raw=S.getItem(WORKSPACE);let ws;
    try{ws=JSON.parse(raw||'null');}catch{throw Error('案件一覧が読み取れません。');}
    if(!ws||!Array.isArray(ws.projects))throw Error('案件一覧を照合できません。');
    const p=ws.projects.find(x=>x.id===cp.client_key);
    if(!p)throw Error('この端末には案件の記録がありません。すでに端末から外している場合は復旧を選んでください。');
    if(C.snapshotText(canonicalSnapshot(p))!==C.snapshotText(info.job.payload))
      throw Error('この端末の変状記録が保管時と異なります。データを消さず中止しました。');
    if(isWholeRemoved(cp.id))throw Error('案件全体を端末から外しています。先に復旧してください。');
    return {raw,ws,p};
  }"""
change(capacity, capacity_check, """  async function freshRecordCheck(info,cp,mode,validateScope){
    if(!window.SentlogDeltaCapacity?.createProof)throw Error('容量整理の照合機能を読み込めません');
    return window.SentlogDeltaCapacity.createProof({records:S,cloudProject:cp,info,
      archiveProof:window.sentlogDeltaArchiveProof,getScope:()=>({ownerId:session()?.user?.id,deviceId:device()}),
      snapshotText:C.snapshotText,isWholeRemoved,validateScope,mode:mode==='restore-project'?'restore-project':'cleanup'});
  }""")
change(capacity, 'const local=freshRecordCheck(info,cp,mode),counter=await countLocal(info.files);',
       'const local=await freshRecordCheck(info,cp,mode),counter=await countLocal(info.files);await local.validate();')
change(capacity, '      freshRecordCheck(ready,cp,mode);', '      await freshRecordCheck(ready,cp,mode);')
change(capacity, 'const before=freshRecordCheck(currentInfo,cp,mode),counter2=await countLocal(currentInfo.files);',
       'const before=await freshRecordCheck(currentInfo,cp,mode),counter2=await countLocal(currentInfo.files);await before.validate();')
change(capacity, "for(const d of before.p.drawings||[])writes.push([PREFIX+d.id,null]);",
       "for(const [key,value] of before.expectedRecords)if(key.startsWith(PREFIX)&&value!==null)writes.push([key,null]);")
change(capacity, "await S.archiveAtomic({writes,deleteFiles:counter2.deletions,expectedWorkspace:before.raw,origin:'device'});",
       "await before.validate();\n          await S.archiveAtomic({writes,deleteFiles:counter2.deletions,expectedWorkspace:before.raw,expectedRecords:before.expectedRecords,expectedFileStates:before.expectedFileStates,validate:before.validateSync,origin:'device',operation:'archive-local',context:{localArchive:true,mode,projectId:cp.client_key,jobId:currentInfo.job.id,deltaCheckpoint:currentInfo.job.delta_checkpoint||null}});")
change(capacity, "if(restoreMode==='files')freshRecordCheck(info,cp,'files');",
       "if(restoreMode==='files')await freshRecordCheck(info,cp,'files',resumePhotos.validate);")
change(capacity, "      const wsText=S.getItem(WORKSPACE);\n      let ws=JSON.parse(wsText||'{\"projects\":[]}');",
       "      const restoreProof=await freshRecordCheck(info,cp,restoreMode==='project'?'restore-project':'files',resumePhotos.validate);\n      const restoredFiles=await countLocal(info.files);\n      if(restoredFiles.missing.length)throw Error('復旧後のファイルが不足しています。記録を変更せず停止しました');\n      await restoreProof.validate();\n      const wsText=restoreProof.raw;\n      let ws=restoreProof.ws;")
change(capacity, "      }else freshRecordCheck(info,cp,'files');", "      }")
change(capacity, "await S.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:wsText,origin:'device'});",
       "await restoreProof.validate();\n      await S.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:wsText,expectedRecords:restoreProof.expectedRecords,expectedFileStates:restoreProof.expectedFileStates,restorationProof:restoreProof.restorationProof,validate:()=>restoreProof.validateSync()&&resumePhotos.validate(),origin:'device',operation:'restore'});")

# A restore is tied to one authentication generation from its first request
# through the final record transaction. Only its exact certified file writes
# may be proven while a whole-project binding is detached.
change(capacity, 'if(active)return;active=true;let view,opId=null,finished=false;',
       'if(active)return;active=true;let view,opId=null,finished=false,resumePhotos=null;')
change(capacity, "      const mark=current(cp.id),wsStart=JSON.parse(S.getItem(WORKSPACE)||'{\"projects\":[]}');",
       "      resumePhotos=await window.sentlogDeltaSuspendPhotos(cp);\n      const mark=current(cp.id),wsStart=JSON.parse(S.getItem(WORKSPACE)||'{\"projects\":[]}');")
change(capacity, "      let received=0;\n      for(const f of info.files){",
       "      const fileOptions=window.SentlogDeltaCapacity.restoreFileOptions({cloudProject:cp,info,getScope:()=>({ownerId:session()?.user?.id,deviceId:device()}),validateScope:resumePhotos.validate});\n      let received=0;\n      for(const f of info.files){\n        resumePhotos.validate();")
change(capacity, '        await S.writeFile(f.key,named);',
       '        await S.writeFile(f.key,named,fileOptions);')
change(capacity, '    }finally{if(view)view.locked(false);active=false;}',
       '    }finally{resumePhotos?.();if(view)view.locked(false);active=false;}')

# Capacity cleanup releases only byte-identical, certified archived copies.
# Stop photograph tasks before taking the final proof so a delayed transfer
# cannot immediately recreate files or invalidate the deletion transaction.
confirmation = "          if(!window.confirm('会社PCに案件一式があることを再確認済みです。\\nこの端末から'+(mode==='files'?'PDF・写真だけを外しますか？':'案件の記録・PDF・写真を外しますか？')+'\\n会社PCやほかの端末の資料は変更しません。')){confirm.disabled=false;return;}"
change(capacity, confirmation + '\n', '')
change(capacity, '        confirm.disabled=true;view.locked(true);\n        try{',
       '        confirm.disabled=true;view.locked(true);let resumePhotos=null;\n        try{')
change(capacity, '          const currentInfo=await ensureServerArchive(cp,opId);',
       '          const currentInfo=await ensureServerArchive(cp,opId);\n' + confirmation +
       '\n          resumePhotos=await window.sentlogDeltaSuspendPhotos(cp);')
change(capacity, "await S.archiveAtomic({writes,deleteFiles:counter2.deletions,expectedWorkspace:before.raw,expectedRecords:before.expectedRecords,expectedFileStates:before.expectedFileStates,validate:before.validateSync,origin:'device',operation:'archive-local',context:{localArchive:true,mode,projectId:cp.client_key,jobId:currentInfo.job.id,deltaCheckpoint:currentInfo.job.delta_checkpoint||null}});",
       """const released=await window.SentlogDeltaCapacityGC.release({records:S,cloudProject:cp,info:currentInfo,proof:before,
            getScope:()=>({ownerId:session()?.user?.id,deviceId:device()}),validateScope:resumePhotos.validate,
            apply:retentionRelease=>S.archiveAtomic({writes,deleteFiles:counter2.deletions,expectedWorkspace:before.raw,
              expectedRecords:before.expectedRecords,expectedFileStates:before.expectedFileStates,
              validate:()=>before.validateSync()&&resumePhotos.validate(),retentionRelease,origin:'device',operation:'archive-local',
              context:{localArchive:true,mode,projectId:cp.client_key,jobId:currentInfo.job.id,deltaCheckpoint:currentInfo.job.delta_checkpoint||null}})});""")
change(capacity, "'件／合計'+bytes(counter2.bytes)+'。'+",
       "'件／合計'+bytes(counter2.bytes)+'。'+(released.releasedCopies?'同じ保管済みファイルの端末内コピーも整理しました。':'')+")
change(capacity, '        finally{view.locked(false);}',
       '        finally{resumePhotos?.();view.locked(false);}')

modules = ['delta-sync-core', 'delta-sync-indexeddb', 'delta-sync-legacy-preflight', 'delta-sync-legacy-source',
           'delta-sync-migration', 'delta-sync-metadata', 'delta-sync-reconcile', 'delta-sync-bootstrap',
           'delta-sync-transport', 'delta-sync-app-bridge', 'delta-sync-assets', 'delta-sync-asset-transport',
           'delta-sync-asset-runtime', 'delta-sync-app-journal', 'delta-sync-app-migration',
           'delta-sync-app-runtime', 'delta-sync-metadata-ui', 'delta-sync-capacity', 'delta-sync-capacity-gc']
index = 'sentlog/index.html'
deps = ','.join("['" + name + '.js?v=' + TOKEN + "','" + {
    'delta-sync-indexeddb': 'SentlogDeltaIndexedDB', 'delta-sync-core': 'SentlogDeltaSyncCore'
}.get(name, 'SentlogDelta') + "']" for name in modules)
change(index, 'const deps=[', 'const deps=[' + deps + ',')
scripts = ''.join('<script src="./' + name + '.js?v=' + TOKEN + '"></\'+\'script>' for name in modules)
change(index, 'document.open();document.write(html);document.close()',
       "html=html.replace('</body>','" + scripts + "</body>');document.open();document.write(html);document.close()")
version_changes = set()
for page in [index, 'sentlog-pc/index.html', 'sentlog/drawing-export-view.html']:
    value = source(page)
    for name in ['record-store','cloud-sync','sync-view','archive','archive-core','archive-capacity','photo-recovery',
                 'peer-photo-recovery','pdf-recovery','record-collaboration','session-guard','original-photo-store',
                 'collaboration-editor','pdf-quality','image-quality','page-management']:
        for prior in re.findall(r'(?<![A-Za-z-])' + re.escape(name) + r'\.js\?v=([A-Za-z0-9._-]+)', value):
            version_changes.add((name, prior))
        value = re.sub(r'(?<![A-Za-z-])' + re.escape(name) + r'\.js\?v=[A-Za-z0-9._-]+', name + '.js?v=' + TOKEN, value)
    if page == index:
        value = value.replace("'project-sync-controls-v1'", "'sentlog-delta-app-v1'")
    pending[page] = value
worker = source('sentlog/sw.js')
old_cache = re.search(r'sentlog-pwa-v\d+', worker).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v',1)[1]) + 3)
worker = worker.replace(old_cache,new_cache)
worker = worker.replace('const FILES=[', 'const FILES=[' + ','.join(repr(name+'.js') for name in modules) + ',')
pending['sentlog/sw.js'] = worker
# Existing tests pin the release URLs and cache generation. Move those exact
# expectations with the resources, while preserving every behavioral assertion.
for file in (ROOT / 'tests').iterdir():
    if file.suffix not in ('.cjs','.py'):
        continue
    value = source(str(file.relative_to(ROOT)))
    revised = value.replace(old_cache,new_cache)
    for name, prior in version_changes:
        revised = revised.replace(name + '.js?v=' + prior, name + '.js?v=' + TOKEN)
        revised = revised.replace(name + r'\.js\?v=' + prior, name + r'\.js\?v=' + TOKEN)
    if revised != value:
        pending[str(file.relative_to(ROOT))] = revised
for path, value in pending.items():
    (ROOT / path).write_text(value,encoding='utf-8')
for name in modules + ['cloud-sync','record-store','sync-view','archive','archive-capacity','photo-recovery']:
    subprocess.run(['node','--check','sentlog/'+name+'.js'],cwd=ROOT,check=True)
print('Connected durable application journal, metadata history, delta photos and certified PC archive')

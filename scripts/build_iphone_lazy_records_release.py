"""Keep iOS normal startup bounded: hydrate a drawing only before using it.

Generated output is edited after v2.17 assembly. Never change the record DB
schema, any existing bytes, or an unconfirmed remote/PC retention decision.
"""
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]
TOKEN='20261128-iphone-lazy-records-218'
MARKER='sentlog-iphone-lazy-records-v218'
OLD_TOKEN='20261128-iphone-stability-217'
OLD_MARKER='sentlog-iphone-stability-v217'
pending={}

def source(name):
    return pending.get(name,(ROOT/name).read_text(encoding='utf-8'))

def change(name,old,new,count=1):
    value=source(name)
    if value.count(old)!=count:
        raise RuntimeError(f'iPhone lazy storage boundary changed: {name}: {old[:130]!r} ({value.count(old)} != {count})')
    pending[name]=value.replace(old,new)

if re.findall(r'sentlog-pwa-v\d+',source('sentlog/sw.js'))!=['sentlog-pwa-v259']:
    raise RuntimeError('Expected canonical v2.17 source')
for name in ['record-store','delta-sync-app-runtime']:
    if not source('sentlog/'+name+'.js').startswith('// '+OLD_MARKER+'\n'):
        raise RuntimeError('Previous iPhone runtime differs: '+name)

lazy=r'''  // iOS WebKit keeps every IndexedDB cursor value in this JS process. A
  // normal startup must not clone all historical drawings into memory.
  const lazyRecordStartup=(()=>{try{return /iPhone|iPad|iPod/i.test(navigator.userAgent||'')||
    (/Macintosh/i.test(navigator.userAgent||'')&&Number(navigator.maxTouchPoints)>1)}catch{return false}})();
  let coldRecordKeys=new Set(),pinnedDrawingKeys=new Set(),recordLoads=new Map();
  function recordNotLoaded(key){return journalError('RECORD_NOT_LOADED',
    '端末内にある記録をまだ読み込んでいません。読み込み前の上書きは停止しました：'+key);}
  async function readColdStartup(){
    const tx=transaction('readonly'),done=complete(tx),s=tx.objectStore(STORE),map=new Map(),keys=new Set();
    let meta=null,archive=null,metaExists=false,archiveExists=false,journalCount=0,controlCount=0;
    const wanted=new Set([WS,'surveyFieldNoteV2']);
    for(let index=0;index<localStorage.length;index++){
      const key=localStorage.key(index);if(key&&managed(key))wanted.add(key);
    }
    s.get(META).onsuccess=e=>meta=e.target.result;
    s.count(META).onsuccess=e=>metaExists=e.target.result>0;
    s.count(ARCHIVE).onsuccess=e=>archiveExists=e.target.result>0;
    if(wanted.size>2)s.get(ARCHIVE).onsuccess=e=>archive=e.target.result;
    tx.objectStore(JOURNAL).count().onsuccess=e=>journalCount=e.target.result;
    tx.objectStore(CONTROL).count().onsuccess=e=>controlCount=e.target.result;
    for(const key of wanted)s.get(PREFIX+key).onsuccess=e=>{
      if(e.target.result!==undefined)map.set(key,e.target.result);
    };
    const q=s.openKeyCursor(IDBKeyRange.bound(PREFIX,PREFIX+'\uffff'));
    q.onsuccess=()=>{try{const item=q.result;if(!item)return;
      keys.add(String(item.key).slice(PREFIX.length));item.continue();
    }catch(error){tx.sentlogJournalError=error;tx.abort();}};
    await done;
    coldRecordKeys=new Set([...keys].filter(key=>!map.has(key)));
    return {meta,archive,metaExists,archiveExists,recordCount:keys.size,journalCount,controlCount,map};
  }
  async function ensureRecordLoaded(key){
    assertReady();if(!lazyRecordStartup||!coldRecordKeys.has(key))return memory.get(key)??null;
    if(recordLoads.has(key))return recordLoads.get(key);
    const task=(async()=>{
      if(failure||connectionFailure||exclusive)throw failure||connectionFailure||recordNotLoaded(key);
      // Existing changes to this key must win over the stored preimage.
      if(pending.has(key))throw recordNotLoaded(key);
      const tx=transaction('readonly'),done=complete(tx);let value;
      tx.objectStore(STORE).get(PREFIX+key).onsuccess=e=>value=e.target.result;
      await done;
      if(value===undefined)throw recordNotLoaded(key);
      validateStoredRecord(key,value);
      if(!coldRecordKeys.has(key))return memory.get(key)??null;
      if(pending.has(key)||failure||connectionFailure)throw recordNotLoaded(key);
      memory.set(key,value);durableMemory.set(key,value);coldRecordKeys.delete(key);
      return value;
    })();
    recordLoads.set(key,task);
    try{return await task;}finally{if(recordLoads.get(key)===task)recordLoads.delete(key);}
  }
  async function ensureDrawingLoaded(id){
    if(typeof id!=='string'||!id)throw recordNotLoaded('図面ID');
    const value=await ensureRecordLoaded(DRAW+id);
    // A missing drawing is NOT an empty drawing. Never let either the editor
    // or legacy snapshot publish an empty state for a referenced drawing.
    if(value===null)throw recordNotLoaded(DRAW+id);
    return value;
  }
  async function ensureProjectLoaded(localProjectId){
    assertReady();if(!lazyRecordStartup)return true;
    await ensureRecordLoaded(SYNC+localProjectId);
    const workspace=workspaceOf(memory.get(WS)),projects=workspace.projects.filter(p=>p.id===localProjectId);
    if(projects.length>1)throw recordNotLoaded('案件IDが重複');
    if(!projects.length)return false;
    for(const drawing of projects[0].drawings||[]){
      await ensureDrawingLoaded(drawing.id);
    }
    return true;
  }
  async function ensureAllLoaded(){
    assertReady();if(!lazyRecordStartup)return;
    for(const key of [...coldRecordKeys])await ensureRecordLoaded(key);
  }
  function evictProject(localProjectId){
    if(!lazyRecordStartup||failure||connectionFailure||exclusive||pending.size||flight||inFlight)return false;
    const project=workspaceOf(memory.get(WS)).projects.find(p=>p.id===localProjectId);
    if(!project)return false;
    if((project.drawings||[]).some(d=>pinnedDrawingKeys.has(DRAW+d.id)))return false;
    for(const drawing of project.drawings||[]){const key=DRAW+drawing.id;
      if(!recordLoads.has(key)&&memory.has(key)){
        memory.delete(key);durableMemory.delete(key);coldRecordKeys.add(key);
      }
    }
    const meta=SYNC+localProjectId;
    if(!recordLoads.has(meta)&&memory.has(meta)){
      memory.delete(meta);durableMemory.delete(meta);coldRecordKeys.add(meta);
    }
    return true;
  }
'''
change('sentlog/record-store.js','  async function readAll(){',lazy+'  async function readAll(){\n    if(lazyRecordStartup)return readColdStartup();')
change('sentlog/record-store.js',"    rejectOldRemote(entries,options);", "    for(const [key]of entries)if(coldRecordKeys.has(key))throw recordNotLoaded(key);\n    rejectOldRemote(entries,options);")
change('sentlog/record-store.js',"    async applyProjection({scope:inputScope,localProjectId,writes,expectedRecords,metadataRecords={},validate}={}){\n      assertReady();",
       "    async applyProjection({scope:inputScope,localProjectId,writes,expectedRecords,metadataRecords={},validate}={}){\n      assertReady();\n      if(lazyRecordStartup&&writes?.some(([key])=>coldRecordKeys.has(key)))throw recordNotLoaded('同期対象の図面');")
change('sentlog/record-store.js',"    getItem:k=>{assertReady();return memory.get(k)??null;},",
       "    getItem:k=>{assertReady();if(coldRecordKeys.has(k))throw recordNotLoaded(k);return memory.get(k)??null;},")
change('sentlog/record-store.js',"    setItem:(k,v,options)=>batch([[k,String(v)]],options),removeItem:(k,options)=>batch([[k,null]],options),keys:()=>[...memory.keys()],",
       "    setItem:(k,v,options)=>batch([[k,String(v)]],options),removeItem:(k,options)=>batch([[k,null]],options),\n    keys:()=>[...new Set([...memory.keys(),...coldRecordKeys])],\n    lazyStartup:lazyRecordStartup,lazyStartupVersion:1,ensureDrawingLoaded,ensureProjectLoaded,ensureAllLoaded,evictProject,\n    pinDrawing:id=>pinnedDrawingKeys.add(DRAW+id),unpinDrawing:id=>pinnedDrawingKeys.delete(DRAW+id),")
change('sentlog/record-store.js',"committedBindings(tx);revision++;memory=new Map(records);durableMemory=new Map(memory);failedFiles.clear();",
       "committedBindings(tx);revision++;memory=new Map(records);durableMemory=new Map(memory);coldRecordKeys.clear();failedFiles.clear();")

# Existing editor remains unchanged on desktop. On iOS only, hydrate and
# validate the real drawing before its synchronous editor ever sees the value.
part='sentlog/part07.txt'
change(part,"  activeProjectId=projectId;activeDrawingId=drawingId;const p=getProject(projectId),d=getDrawingMeta(projectId,drawingId);if(!p||!d)return;",
       "  const p=getProject(projectId),d=getDrawingMeta(projectId,drawingId);if(!p||!d)return;\n"
       "  if(window.SentlogRecords.lazyStartup){window.SentlogRecords.pinDrawing?.(drawingId);\n"
       "    try{await window.SentlogRecords.ensureDrawingLoaded(drawingId);}\n"
       "    catch(error){window.SentlogRecords.unpinDrawing?.(drawingId);console.warn('Protected drawing load',error);alert('端末内の図面記録を読み込めません。上書きせず停止しました。');return;}\n"
       "    if(opening!==drawingOpenSequence){window.SentlogRecords.unpinDrawing?.(drawingId);return;}}\n"
       "  activeProjectId=projectId;activeDrawingId=drawingId;")
change(part,"  try{const saved=JSON.parse(window.SentlogRecords.getItem(drawingStorageKey(drawingId))||'null');state={...freshDrawingState(p.name),...(saved||{})}}catch{state=freshDrawingState(p.name)}",
       "  try{const saved=JSON.parse(window.SentlogRecords.getItem(drawingStorageKey(drawingId))||'null');state={...freshDrawingState(p.name),...(saved||{})}}\n"
       "  catch(error){if(window.SentlogRecords.lazyStartup){window.SentlogRecords.unpinDrawing?.(drawingId);alert('図面の記録を確認できません。保存内容を保持して開くのを停止しました。');return;}state=freshDrawingState(p.name)}")
change(part,"if(currentView==='editor'&&activeDrawingId)persist();",
       "if(currentView==='editor'&&activeDrawingId){persist();window.SentlogRecords.unpinDrawing?.(activeDrawingId);}",2)
change('sentlog/part05.txt',"  const drawingStates={};\n  for(const p of workspace.projects||[])",
       "  if(window.SentlogRecords.lazyStartup)await window.SentlogRecords.ensureAllLoaded();\n  const drawingStates={};\n  for(const p of workspace.projects||[])")

runtime='sentlog/delta-sync-app-runtime.js'
change(runtime,"    async function openInner(c,{activate=false,revision,confirmation=false,localOnly=false}={}){\n      check(c);let local=await binding(c);",
       "    async function openInner(c,{activate=false,revision,confirmation=false,localOnly=false}={}){\n      check(c);\n      if(records.lazyStartup){await records.ensureProjectLoaded(c.localProjectId);check(c);}\n      let local=await binding(c);")
change('sentlog/delta-sync-app-journal.js',"        await records.settled();active();if(projectionDeferred())return {applied:false,deferred:true};\n        const template=observedSnapshot();",
       "        await records.settled();active();if(projectionDeferred())return {applied:false,deferred:true};\n        if(records.lazyStartup){await records.ensureProjectLoaded(localProjectId);active();}\n        const template=observedSnapshot();")

cloud='sentlog/cloud-sync.js'
change(cloud,"    try{\n      if(lp&&", "    try{\n      if(lp&&window.SentlogRecords.lazyStartup){await window.SentlogRecords.ensureProjectLoaded(id);context.assertCurrent();}\n      if(lp&&")
change(cloud,"      try{\n        context.assertCurrent();const cycleAssets=new Map();files+=await pullProjectAssets(cp,metadata.deviceId,cycleAssets);",
       "      try{\n        if(window.SentlogRecords.lazyStartup){await window.SentlogRecords.ensureProjectLoaded(id);context.assertCurrent();}\n        context.assertCurrent();const cycleAssets=new Map();files+=await pullProjectAssets(cp,metadata.deviceId,cycleAssets);")
for name in ['record-store','delta-sync-app-runtime','delta-sync-app-journal','cloud-sync','startup-storage-maintenance']:
    path='sentlog/'+name+'.js';pending[path]='// '+MARKER+'\n'+source(path)

index='sentlog/index.html'
for name in ['record-store','storage-maintenance-ui','sync-view','delta-sync-app-runtime','photo-thumbnails']:
    path='sentlog/'+name+'.js'
    if name not in ['record-store','delta-sync-app-runtime']:
        pending[path]='// '+MARKER+'\n'+source(path)
    change(index,name+'.js?v='+OLD_TOKEN,name+'.js?v='+TOKEN,2)
    change(index,"['"+name+'.js?v='+TOKEN+"','"+OLD_MARKER+"']",
           "['"+name+'.js?v='+TOKEN+"','"+MARKER+"']")
# The previous builder's earlier marker must remain available to all old
# behavioral tests, while this entry requires the new iOS lazy-load interface.
change(index,'if(window.SentlogRecords?.startupReadBudgetVersion!==1||',
       'if(window.SentlogRecords?.lazyStartupVersion!==1||window.SentlogRecords?.startupReadBudgetVersion!==1||')
change(index,'phone-runtime.js?v=217','phone-runtime.js?v=218',2)
change(index,"['phone-runtime.js?v=218','v2.17']","['phone-runtime.js?v=218','v2.18']")
change(index,'storage-maintenance.html?v='+OLD_TOKEN,'storage-maintenance.html?v='+TOKEN)
# Only two pinned references: dependency proof and module script in generated HTML.
old_cloud_versions=re.findall(r'cloud-sync\.js\?v=([A-Za-z0-9._-]+)',source(index))
if len(old_cloud_versions)!=2 or len(set(old_cloud_versions))!=1:
    raise RuntimeError('Unexpected cloud module version references')
change(index,'cloud-sync.js?v='+old_cloud_versions[0],'cloud-sync.js?v='+TOKEN,2)
old_proof=re.search(r"\['cloud-sync\.js\?v="+re.escape(TOKEN)+r"','([^']+)'\]",source(index))
if not old_proof:raise RuntimeError('Cloud module proof was not found')
change(index,"['cloud-sync.js?v="+TOKEN+"','"+old_proof.group(1)+"']",
       "['cloud-sync.js?v="+TOKEN+"','"+MARKER+"']")
change('sentlog/phone-runtime.js','v2.17','v2.18',4)
change('sentlog-pc/index.html','v2.17 · 起動と写真表示の負荷軽減','v2.18 · iPhoneの記録読込を分割')
change('sentlog/phone-runtime.js','v2.18 · 起動と写真表示の負荷軽減','v2.18 · iPhoneの記録読込を分割')
change('sentlog/sw.js','sentlog-pwa-v259','sentlog-pwa-v260')
change('sentlog/storage-maintenance.html',OLD_TOKEN,TOKEN,3)
# Every existing behavioral assertion remains; only release names/gates advance.
identities=[('sentlog-pwa-v259','sentlog-pwa-v260'),(OLD_TOKEN,TOKEN),(OLD_MARKER,MARKER),
 ('v2.17 · 起動と写真表示の負荷軽減','v2.18 · iPhoneの記録読込を分割'),
 ("'v2.17'","'v2.18'"),('phone-runtime.js?v=217','phone-runtime.js?v=218'),
 (r'phone-runtime\.js\?v=217',r'phone-runtime\.js\?v=218')]
for file in (ROOT/'tests').iterdir():
    if file.suffix not in ('.cjs','.py') or file.name=='iphone_lazy_records.test.cjs':continue
    name=str(file.relative_to(ROOT));value=source(name)
    for old,new in identities:value=value.replace(old,new)
    # Executed boot capability fixtures must include the new version.
    if file.name in {'startup_protection_release.test.cjs','storage_lifecycle_release.test.cjs',
        'recovery_retry_release.test.cjs','reliability_release.test.cjs',
        'capacity_maintenance_release.test.cjs','operation_memory_release.test.cjs'}:
        value=value.replace('const records={startupReadBudgetVersion:1,',
                            'const records={lazyStartupVersion:1,startupReadBudgetVersion:1,')
    if file.name=='startup_backup_recovery_release.test.cjs':
        value=value.replace('window:{SentlogRecords:{startupReadBudgetVersion:1,',
                            'window:{SentlogRecords:{lazyStartupVersion:1,startupReadBudgetVersion:1,')
    if file.name=='iphone_stability_release.test.cjs':
        value=value.replace('const records={startupReadBudgetVersion,maintenanceInitVersion:1,',
                            'const records={lazyStartupVersion:1,startupReadBudgetVersion,maintenanceInitVersion:1,')
    if file.name=='metadata_choice_release.test.cjs':
        value=value.replace('if(window.SentlogRecords?.startupReadBudgetVersion!==1||',
                            'if(window.SentlogRecords?.lazyStartupVersion!==1||window.SentlogRecords?.startupReadBudgetVersion!==1||')
    # The previous native test used the platform default UA: even its WebKit
    # branch did not exercise iOS cold-start behavior. Explicitly use iPhone UA
    # for the real persistent authenticated WebKit/Chromium sessions, while all
    # real user data remains out of the synthetic fixture.
    if file.name=='normal_startup_residency_ui.py':
        old='is_mobile=True, has_touch=True, service_workers="block", timeout=30000)'
        new=('is_mobile=True, has_touch=True, '
             'user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) '
             'AppleWebKit/605.1.15 Version/18.4 Mobile/15E148 Safari/604.1", '
             'service_workers="block", timeout=30000)')
        if value.count(old)!=1:raise RuntimeError('Native iOS test setup changed')
        value=value.replace(old,new)
        before='const h=__operationHelpers,all=await h.snapshot(),main=all.databases.surveyFieldNoteDB.stores;'
        after='const h=__operationHelpers;await SentlogRecords.ensureAllLoaded?.();const all=await h.snapshot(),main=all.databases.surveyFieldNoteDB.stores;'
        if value.count(before)!=1:raise RuntimeError('Native preservation oracle changed')
        value=value.replace(before,after)
        old_pending="const R=SentlogRecords,h=__operationHelpers,key='surveyFieldNoteDrawingV1:'+drawingId;"
        new_pending=old_pending+'\n  await R.ensureDrawingLoaded?.(drawingId);'
        if value.count(old_pending)!=1:raise RuntimeError('Pending-edit fixture changed')
        value=value.replace(old_pending,new_pending)
        # Native instrumentation must observe the cold mirror BEFORE any
        # intentionally materializing full-backup proof.
        hook='startup=page.evaluate("__normalResidency")'
        if hook not in value:raise RuntimeError('Native cold-start observation changed')
        value=value.replace(hook, 'assert page.evaluate("SentlogRecords.lazyStartup===true")\n                '+hook)
    if value!=source(name):pending[name]=value

for name,value in pending.items():(ROOT/name).write_text(value,encoding='utf-8')
for name in ['record-store','delta-sync-app-runtime','delta-sync-app-journal','cloud-sync','photo-thumbnails']:
    subprocess.run(['node','--check','sentlog/'+name+'.js'],cwd=ROOT,check=True)
print('Built v2.18 with iOS lazy records, guarded editor and migration/normal sync hydration')
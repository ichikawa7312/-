"""Fence asynchronous record projection against a drawing navigation race.
Do not change record format, database functions or asset transfers."""
from pathlib import Path
import re,subprocess
ROOT=Path(__file__).resolve().parents[1]
S=ROOT/'sentlog'
def change(s,a,b,count=1):
    if s.count(a)!=count:raise RuntimeError(f'projection guard anchor mismatch: {a[:90]} ({s.count(a)})')
    return s.replace(a,b)
p=S/'sync-view.js';s=p.read_text(encoding='utf-8')
s=change(s,'  async function commit(cloudProject,snapshot,expectedLocal,mergeOptions=null){','''  // A durable projection can finish after another sheet has been selected.
  // Serialize opening/creating a drawing with that short local transaction,
  // not with cloud requests or the whole synchronization cycle.
  let projectionNavigationBarrier=null,navigationSerial=0;
  function guardedNavigation(original){
    return function(...args){
      const request=++navigationSerial,receiver=this;
      if(!projectionNavigationBarrier)return original.apply(receiver,args);
      return (async()=>{
        while(projectionNavigationBarrier){
          await projectionNavigationBarrier;
          if(request!==navigationSerial)return false;
        }
        if(request!==navigationSerial)return false;
        return original.apply(receiver,args);
      })();
    };
  }
  function leaveNavigation(original){
    return function(...args){++navigationSerial;return original.apply(this,args);};
  }
  if(typeof openDrawing==='function')openDrawing=guardedNavigation(openDrawing);
  if(typeof createDrawingFromFile==='function')createDrawingFromFile=guardedNavigation(createDrawingFromFile);
  if(typeof showProjects==='function')showProjects=leaveNavigation(showProjects);
  if(typeof showDrawings==='function')showDrawings=leaveNavigation(showDrawings);

  async function commit(cloudProject,snapshot,expectedLocal,mergeOptions=null){
    if(projectionNavigationBarrier)return {applied:false,deferred:true,reason:'projection-busy'};
    if(!mergeOptions?.deltaProjection)return applyCommit(cloudProject,snapshot,expectedLocal,mergeOptions);
    let release;
    projectionNavigationBarrier=new Promise(resolve=>{release=resolve;});
    try{return await applyCommit(cloudProject,snapshot,expectedLocal,mergeOptions);}
    finally{projectionNavigationBarrier=null;release();}
  }
  async function applyCommit(cloudProject,snapshot,expectedLocal,mergeOptions=null){''')
s=change(s,"    const active=currentView==='editor' && activeProjectId===id;","""    const active=currentView==='editor' && activeProjectId===id;
    const editorDrawing=activeDrawingId,editorProject=activeProjectId;
    const sameEditor=()=>currentView==='editor'&&activeProjectId===editorProject&&activeDrawingId===editorDrawing;""")
s=change(s,"    const editorDraft=window.SentlogCollaboration?.captureEditor?.();","    let editorDraft=window.SentlogCollaboration?.captureEditor?.();")
s=change(s,"        const applied=await window.SentlogRecords.deltaJournal.applyProjection({...mergeOptions.deltaProjection,writes});","""        const originalValidate=mergeOptions.deltaProjection.validate;
        const validate=()=>originalValidate()&&(!(currentView==='editor'&&activeProjectId===id)||(active&&sameEditor()&&!busy()));
        const applied=await window.SentlogRecords.deltaJournal.applyProjection({...mergeOptions.deltaProjection,writes,validate});""")
s=change(s,'    if(active && incoming){','''    if(currentView==='editor'&&activeProjectId===id&&(!active||!sameEditor())){
      // Defensive check for an unexpected navigation path that bypassed the
      // gate. The durable per-drawing write is valid; never install the old
      // drawing's state in the editor under a different drawing ID.
      return {applied:false,deferred:true,reason:'view-changed'};
    }
    if(active && incoming && sameEditor()){
      if(mergeOptions?.deltaProjection)editorDraft=window.SentlogCollaboration?.captureEditor?.();''')
p.write_text(s,encoding='utf-8')
# Version the changed script on every loader and advance the service worker.
TOKEN='20261126-view-fence'
versions=set()
for path in ['sentlog/index.html','sentlog-pc/index.html']:
    p=ROOT/path;s=p.read_text(encoding='utf-8')
    versions.update(re.findall(r'sync-view\.js\?v=([A-Za-z0-9._-]+)',s))
    s=re.sub(r'sync-view\.js\?v=[A-Za-z0-9._-]+','sync-view.js?v='+TOKEN,s)
    p.write_text(s,encoding='utf-8')
p=S/'sw.js';s=p.read_text(encoding='utf-8')
old=re.search(r'sentlog-pwa-v\d+',s).group();new='sentlog-pwa-v'+str(int(old.rsplit('v',1)[1])+1)
p.write_text(s.replace(old,new),encoding='utf-8')
for path in (ROOT/'tests').iterdir():
    if path.suffix not in ('.cjs','.py'):continue
    s=path.read_text(encoding='utf-8');v=s.replace(old,new)
    for version in versions:
        v=v.replace('sync-view.js?v='+version,'sync-view.js?v='+TOKEN)
        v=v.replace(r'sync-view\.js\?v='+version,r'sync-view\.js\?v='+TOKEN)
    if v!=s:path.write_text(v,encoding='utf-8')
subprocess.run(['node','--check','sentlog/sync-view.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/sync_projection_navigation.test.cjs'],cwd=ROOT,check=True)
print('Built navigation fence for asynchronous durable projection; exact-byte media and record schema unchanged')

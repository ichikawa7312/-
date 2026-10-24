"""Sentlog v1.93: safe drawing replacement and record-loss sync guard.

The browser page-management module owns safe replacement for recorded drawings.
This build stage adds the durable pre-replacement state slot, peer-device loss
guard, and release/cache markers. Source PDFs are not modified by this stage.
"""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

def change(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:
        raise RuntimeError(f'Safe-replace integration mismatch: {path}: {old[:100]!r}: {s.count(old)}')
    p.write_text(s.replace(old,new))

# One-deep durable state backup per drawing, written before a recorded background replacement.
p='sentlog/record-store.js'
change(p,
       "const managed=k=>k.startsWith('sentlogSyncMergeCheckpointV1:') ||",
       "const managed=k=>k.startsWith('sentlogReplaceBackupV1:') || k.startsWith('sentlogSyncMergeCheckpointV1:') ||")

# An intact peer device must not accept a cloud PDF replacement that also drops records/photos.
p='sentlog/sync-view.js'
old="""    const oldProject=ws.projects.find(p=>p.id===id);"""
new=old+"""
    const incomingDrawings=snapshot.payload.drawings||[];
    for(const oldMeta of oldProject?.drawings||[]){
      const before=read(oldMeta.id),incomingItem=incomingDrawings.find(d=>(d.meta?.id||d.state?.id)===oldMeta.id),after=incomingItem?.state;
      if(!before||!after)continue;
      const beforeShapes=Array.isArray(before.shapes)?before.shapes:[],afterShapes=Array.isArray(after.shapes)?after.shapes:[];
      const beforePhotos=beforeShapes.reduce((n,s)=>n+(s.photos?.length||0),0),afterPhotos=afterShapes.reduce((n,s)=>n+(s.photos?.length||0),0);
      const frameChanged=before.sourceType!==after.sourceType||before.fileName!==after.fileName||Number(before.pageCount||1)!==Number(after.pageCount||1);
      if(frameChanged&&(afterShapes.length<beforeShapes.length||afterPhotos<beforePhotos))
        return {applied:false,reason:'record-loss-guard'};
    }"""
change(p,old,new)

# Cache-bust page-management itself because it now owns safe replacement.
p='sentlog/index.html'
change(p,'page-management.js?v=192','page-management.js?v=193',2)
change(p,"['page-management.js?v=193','SentlogPageManagement v1.92']","['page-management.js?v=193','SentlogPageManagement v1.93']")
change(p,'phone-runtime.js?v=192','phone-runtime.js?v=193',2)
change(p,"['phone-runtime.js?v=193','v1.92']","['phone-runtime.js?v=193','v1.93']")
change('sentlog/phone-runtime.js','v1.92','v1.93',4)
change('sentlog-pc/index.html','v1.92','v1.93',1)
change('sentlog/sw.js','sentlog-pwa-v203','sentlog-pwa-v204')
change('sentlog/sw.js',"'page-management.js'","'page-management.js'")

for f in (ROOT/'tests').iterdir():
    if f.suffix not in ('.py','.cjs'):continue
    s=f.read_text()
    u=s.replace("'v1.92'","'v1.93'").replace('phone-runtime.js?v=192','phone-runtime.js?v=193').replace(r'phone-runtime\.js\?v=192',r'phone-runtime\.js\?v=193').replace('page-management.js?v=192','page-management.js?v=193').replace('sentlog-pwa-v203','sentlog-pwa-v204')
    if u!=s:f.write_text(u)

subprocess.run(['node','--check','sentlog/page-management.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/sync-view.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/safe_replace.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v1.93: recorded drawing replacement preserves records/photos and guards peer devices')

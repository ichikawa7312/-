"""Integrate automatic chalk tracing after all existing Sentlog build steps.

No database migration: results use the existing manual freehand damage shapes.
"""
from pathlib import Path
import re
import subprocess
ROOT=Path(__file__).resolve().parents[1]
for asset in ('auto-trace-core.js','auto-trace-album.js','auto-trace.js'):
    if not (ROOT/'sentlog'/asset).is_file():raise RuntimeError('Missing auto-trace asset: '+asset)
file=ROOT/'sentlog/index.html'
html=file.read_text(encoding='utf-8')
anchor='document.open();document.write(html);document.close()'
if html.count(anchor)!=1 or 'auto-trace-core.js' in html:raise RuntimeError('Dynamic bootstrap has changed')
loader="""html=html.replace('</body>','<script src="./auto-trace-core.js?v=231"></'+'script><script src="./auto-trace-album.js?v=231"></'+'script><script src="./auto-trace.js?v=231"></'+'script></body>');"""
file.write_text(html.replace(anchor,loader+anchor,1),encoding='utf-8')
file=ROOT/'sentlog/sw.js'
worker=file.read_text(encoding='utf-8')
anchor="'index.html'"
if worker.count(anchor)!=1 or "'auto-trace-core.js'" in worker:raise RuntimeError('PWA asset list has changed')
worker=worker.replace(anchor,anchor+",'auto-trace-core.js','auto-trace-album.js','auto-trace.js'",1)
match=re.search(r'sentlog-pwa-v(\d+)',worker)
if not match:raise RuntimeError('PWA cache version not found')
old=match.group(0)
new='sentlog-pwa-v'+str(int(match.group(1))+1)
file.write_text(worker.replace(old,new),encoding='utf-8')

# Apply optional source-photo album hooks only AFTER all guarded legacy builders
# have verified their original code checksums. This keeps sync/PDF protections intact.
def hook(path,old,new):
    p=ROOT/path
    value=p.read_text(encoding='utf-8')
    count=value.count(old)
    if count!=1:
        raise RuntimeError(f'Auto-trace album integration point changed: {path}: {old[:95]!r} (matches={count})')
    p.write_text(value.replace(old,new,1),encoding='utf-8')

hook('sentlog/cloud-sync.js',"""function collectPhotos(localProject){
  const out=[];
  for(const d of localProject.drawings||[]){
    const st=drawingState(d.id);if(!st)continue;
    for(const sh of st.shapes||[]){
      for(const p of sh.photos||[]){
        out.push({drawingId:d.id,drawingName:d.name||'',shapeId:sh.id,shapeType:sh.type||'',shapeLabel:sh.autoLabel||'',photo:p});
      }
    }
  }
  return out;
}""","""function collectPhotos(localProject){
  const out=[],seen=new Set();
  for(const d of localProject.drawings||[]){
    const st=drawingState(d.id);if(!st)continue;
    // The source-photo album uses the same hash-checked cloud pipeline as ordinary photos.
    for(const photo of st.autoTracePhotos||[]){
      if(!photo?.id||seen.has(d.id+':'+photo.id))continue;
      seen.add(d.id+':'+photo.id);
      out.push({drawingId:d.id,drawingName:d.name||'',drawingGroup:d.groupName||d.name||'図面No.',shapeId:'',shapeType:'',shapeLabel:'自動描写',album:'auto-trace',photo});
    }
    for(const sh of st.shapes||[]){
      for(const photo of sh.photos||[]){
        if(!photo?.id||seen.has(d.id+':'+photo.id))continue;
        seen.add(d.id+':'+photo.id);
        out.push({drawingId:d.id,drawingName:d.name||'',shapeId:sh.id,shapeType:sh.type||'',shapeLabel:sh.autoLabel||'',photo});
      }
    }
  }
  return out;
}""")

hook('sentlog/cloud-sync.js',
     "metadata:{local_project_key:cloudProject.client_key||'',drawing_id:item.drawingId,drawing_name:item.drawingName,shape_id:item.shapeId,shape_type:item.shapeType,shape_label:item.shapeLabel,photo_id:p.id}",
     "metadata:{local_project_key:cloudProject.client_key||'',drawing_id:item.drawingId,drawing_name:item.drawingName,shape_id:item.shapeId,shape_type:item.shapeType,shape_label:item.shapeLabel,photo_id:p.id,...(item.album?{photo_album:item.album,drawing_group:item.drawingGroup||item.drawingName}:{})}")

hook('sentlog/photo-recovery.js',"""    for(const shape of state.shapes||[])for(const photo of shape.photos||[]){
     if(photo?.id)keys.add(photoKey(d.id,photo.id));
    }""","""    for(const shape of state.shapes||[])for(const photo of shape.photos||[]){
     if(photo?.id)keys.add(photoKey(d.id,photo.id));
    }
    // Allow verified PC redelivery even if no defect explicitly uses the source photo.
    for(const photo of state.autoTracePhotos||[]){
     if(photo?.id)keys.add(photoKey(d.id,photo.id));
    }""")

hook('sentlog/sync-merge.js',"""      const st=properties(l.state,r.state,b?.state,path+' / 用紙・縮尺',['shapes',...viewKeys]);
      st.shapes=entities(l.state.shapes||[],r.state.shapes||[],b?.state?.shapes||[],path,shapeValue,(a,z,ancestor,label)=>shape(a,z,ancestor,label,l.meta.id));
      for(const k of viewKeys)if(l.state[k]!==undefined)st[k]=copy(l.state[k]);""","""      const st=properties(l.state,r.state,b?.state,path+' / 用紙・縮尺',['shapes','autoTracePhotos',...viewKeys]);
      st.shapes=entities(l.state.shapes||[],r.state.shapes||[],b?.state?.shapes||[],path,shapeValue,(a,z,ancestor,label)=>shape(a,z,ancestor,label,l.meta.id));
      // Keep simultaneous captures from two devices; never silently discard an image.
      if(l.state.autoTracePhotos||r.state.autoTracePhotos||b?.state?.autoTracePhotos){
        st.autoTracePhotos=entities(l.state.autoTracePhotos||[],r.state.autoTracePhotos||[],b?.state?.autoTracePhotos||[],path+' / 自動描写写真',x=>x,photo);
      }
      for(const k of viewKeys)if(l.state[k]!==undefined)st[k]=copy(l.state[k]);""")

hook('sentlog/sync-merge.js',"""        for(const s of d.state.shapes)map(s.photos||[],label+' / 写真');""","""        for(const s of d.state.shapes)map(s.photos||[],label+' / 写真');
        if(d.state.autoTracePhotos!==undefined)map(d.state.autoTracePhotos,label+' / 自動描写写真');""")

hook('sentlog-pc/index.html',"""  if(a.kind==='drawing'){
    d=await subdir(d,'図面');
    logicalParts.push('図面');
  }else{
    d=await subdir(d,'写真');d=await subdir(d,drawing);d=await subdir(d,label);
    logicalParts.push('写真',safe(drawing),safe(label));
  }""","""  if(a.kind==='drawing'){
    d=await subdir(d,'図面');
    logicalParts.push('図面');
  }else if(a.metadata?.photo_album==='auto-trace'){
    const group=a.metadata?.drawing_group||drawing;
    d=await subdir(d,'自動描写');d=await subdir(d,group);d=await subdir(d,drawing);
    logicalParts.push('自動描写',safe(group),safe(drawing));
  }else{
    d=await subdir(d,'写真');d=await subdir(d,drawing);d=await subdir(d,label);
    logicalParts.push('写真',safe(drawing),safe(label));
  }""")

for file in (ROOT/'tests').iterdir():
    if file.name=='auto_trace.test.cjs' or file.suffix not in ('.cjs','.py'):continue
    content=file.read_text(encoding='utf-8')
    if old in content:file.write_text(content.replace(old,new),encoding='utf-8')
subprocess.run(['node','--check','sentlog/auto-trace-core.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/auto-trace-album.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/auto-trace.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/auto_trace.test.cjs'],cwd=ROOT,check=True)
print('Built offline auto-trace: evidence album, no automatic ledger attachment, safe original/photo sync')

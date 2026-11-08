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

# Merge source-photo lists by ID even if previous builders changed the field list
# in the drawing function (e.g. PDF page-count safety extensions).
merge_path=ROOT/'sentlog/sync-merge.js'
merge_code=merge_path.read_text(encoding='utf-8')
start=merge_code.index('function drawing(l,r,b,path){')
stop=merge_code.index('function validate(',start)
drawing_fn=merge_code[start:stop]
line=re.search(r'(?m)^ *const st=properties\([^\n;]+;',drawing_fn)
if not line or "['shapes'" not in line.group(0):
    raise RuntimeError('Cannot identify drawing field merge and protect autoTracePhotos')
fixed=line.group(0).replace("['shapes'","['shapes','autoTracePhotos'",1)
drawing_fn=drawing_fn[:line.start()]+fixed+drawing_fn[line.end():]
append_point="      for(const k of viewKeys)if(l.state[k]!==undefined)st[k]=copy(l.state[k]);"
if drawing_fn.count(append_point)!=1:
    raise RuntimeError('Missing drawing field merge insertion point')
drawing_fn=drawing_fn.replace(append_point,
"""      // Preserve captures from separate devices; do not place them in shape.photos.
      if(l.state.autoTracePhotos||r.state.autoTracePhotos||b?.state?.autoTracePhotos){
        st.autoTracePhotos=entities(l.state.autoTracePhotos||[],r.state.autoTracePhotos||[],b?.state?.autoTracePhotos||[],path+' / 自動描写写真',x=>x,photo);
      }
"""+append_point,1)
merge_code=merge_code[:start]+drawing_fn+merge_code[stop:]
old_validate="        for(const s of d.state.shapes)map(s.photos||[],label+' / 写真');"
if merge_code.count(old_validate)!=1:
    raise RuntimeError('Missing photo registry validation insertion point')
merge_code=merge_code.replace(old_validate,old_validate+
"\n        if(d.state.autoTracePhotos!==undefined)map(d.state.autoTracePhotos,label+' / 自動描写写真');",1)
merge_path.write_text(merge_code,encoding='utf-8')

# Insert the album path as an extra branch; preserve the existing PC folder
# logic (which other build steps may have extended for verified drawing PDFs).
pc_path=ROOT/'sentlog-pc/index.html'
pc_code=pc_path.read_text(encoding='utf-8')
pc_start=pc_code.index('async function saveVerified(a){')
pc_end=pc_code.index('async function deleteVerified(',pc_start)
pc_block=pc_code[pc_start:pc_end]
# The final PC builder may reformat this procedure while retaining these
# structural anchors. Report generated source on mismatch rather than guessing.
pc_name=pc_block.find('  const name=safe(a.file_name')
if pc_name<0:
    raise RuntimeError('PC archive filename marker changed: '+repr(pc_block[:2800]))
pc_block=pc_block[:pc_name]+"""  if(a.kind==='photo'&&a.metadata?.photo_album==='auto-trace'){
    // Isolate source evidence from ordinary submitted/ledger photographs.
    const albumGroup=a.metadata?.drawing_group||drawing;
    d=rootHandle;
    d=await subdir(d,year);d=await subdir(d,project);
    d=await subdir(d,'自動描写');d=await subdir(d,albumGroup);d=await subdir(d,drawing);
    logicalParts=[rootHandle.name,year,safe(project),'自動描写',safe(albumGroup),safe(drawing)];
  }
"""+pc_block[pc_name:]
pc_code=pc_code[:pc_start]+pc_block+pc_code[pc_end:]

pc_path.write_text(pc_code,encoding='utf-8')

for file in (ROOT/'tests').iterdir():
    if file.name=='auto_trace.test.cjs' or file.suffix not in ('.cjs','.py'):continue
    content=file.read_text(encoding='utf-8')
    if old in content:file.write_text(content.replace(old,new),encoding='utf-8')
subprocess.run(['node','--check','sentlog/auto-trace-core.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/auto-trace-album.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/auto-trace.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/auto_trace.test.cjs'],cwd=ROOT,check=True)
print('Built offline auto-trace: evidence album, no automatic ledger attachment, safe original/photo sync')

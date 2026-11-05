"""Integrate CAD reference-image support after all guarded production build stages.
No existing drawing or annotation file is edited in the repository baseline.
"""
from pathlib import Path
import re,subprocess

ROOT=Path(__file__).resolve().parents[1]
def edit(path,old,new,count=1):
    p=ROOT/path
    s=p.read_text()
    if s.count(old)!=count:
        raise RuntimeError('DXF raster integration mismatch '+path+' '+repr(old[:90])+' count='+str(s.count(old)))
    p.write_text(s.replace(old,new,count))

dxf='sentlog/dxf.js'
edit(dxf,
     "function clear(){serial++;cancelAnimationFrame(raf);",
     "function clear(){root.SentlogDxfRaster?.closed();serial++;cancelAnimationFrame(raf);")
edit(dxf,
     "v.frame=C.makeFrame(viewer.GetBounds());viewer.controls?.dispose();",
     "v.frame=C.makeFrame(root.SentlogDxfRasterCore?.includeBounds(viewer.GetBounds(),root.SentlogDxfRasterCore.parse(bytes))||viewer.GetBounds());viewer.controls?.dispose();")
edit(dxf,
     " wrap.dataset.dxf='ready';wrap.dataset.dxfPixels=String(pw*ph);",
     "  wrap.dataset.dxf='ready';wrap.dataset.dxfPixels=String(pw*ph);\n"
     "  root.SentlogDxfRaster?.viewChanged({drawingId:activeDrawingId,scale,tx,ty,width:r.width,height:r.height,devicePixelRatio:d});")
edit(dxf,
     "active=v;stage.insertBefore(v.host,svg);empty.style.display='none';$('fileName').textContent=state.fileName;updatePageUI();fit();viewport();render();persist();updateUI();",
     "active=v;stage.insertBefore(v.host,svg);empty.style.display='none';$('fileName').textContent=state.fileName;updatePageUI();fit();viewport();render();persist();updateUI();\n"
     "   Promise.resolve(root.SentlogDxfRaster?.opened({drawingId:id,bytes:v.bytes,frame})).then(()=>{if(active?.id===id)viewport();}).catch(e=>console.warn('CAD raster opening failed',e));")

# The loader is composed by 20+ earlier builders. Find only the two DXF tags
# emitted by the official DXF build; never patch its checked source baseline.
p=ROOT/'sentlog/index.html'
html=p.read_text()
pattern=r'(<script src="./dxf-core\.js\?v=[0-9]+"><\\/script>)(<script src="./dxf\.js\?v=[0-9]+"><\\/script>)'
new=(
    r'\1<script src="./dxf-raster-core.js?v=204"><\/script>'
    r'\2<script src="./dxf-raster.js?v=204"><\/script>'
)
html,n=re.subn(pattern,lambda m:m.group(1)+'<script src="./dxf-raster-core.js?v=204"><\\/script>'+m.group(2)+'<script src="./dxf-raster.js?v=204"><\\/script>',html)
if n!=1:raise RuntimeError('DXF runtime loader not found: '+str(n))
# Include new source in the existing upfront availability validation.
pos="['dxf.js?"
i=html.find(pos)
if i<0:raise RuntimeError('DXF preflight missing')
html=html[:i]+"['dxf-raster-core.js?v=204','SentlogDxfRasterCore'],['dxf-raster.js?v=204','SentlogDxfRaster'],"+html[i:]
p.write_text(html)

# Persist original TIF names and MIME; don't reinterpret them as JPEG photos.
edit('sentlog/cloud-sync.js',
 "  if(n.endsWith('.pdf')||blob.type==='application/pdf')return '.pdf';",
 "  if(n.endsWith('.tif')||n.endsWith('.tiff')||blob.type==='image/tiff')return n.endsWith('.tiff')?'.tiff':'.tif';\n"
 "  if(n.endsWith('.pdf')||blob.type==='application/pdf')return '.pdf';")
p=ROOT/'sentlog/cloud-sync.js'
s=p.read_text()
anchor='      for(const item of collectPhotos(lp)){'
start=s.find(anchor)
if start<0 or s.count(anchor)!=1:raise RuntimeError('photo upload loop not found')
end=s.find('\n    }\n    await window.SentlogRecords.settled();',start)
if end<0 or 'knownAssets' not in s[max(0,start-10000):start+300]:raise RuntimeError('drawing asset loop layout changed')
inject="""
      // These images are linked CAD files, not inspection photos; they are
      // independently SHA-verified and never overwrite a different original.
      try{
        uploaded+=await window.SentlogDxfRaster?.cloudSyncProject?.({
          project:lp,cloudProject:cp,deviceId,knownAssets,
          ops:{dbGet,dbPut,sha256Hex,uploadAsset,downloadPrivateAsset,readProjectAssets}
        })||0;
      }catch(e){drawingErrors.push('CAD参照画像：'+e.message);}
"""
s=s[:end]+inject+s[end:]
p.write_text(s)

# Preserve linked TIFF files on cloud after a verified local PC backup so a
# newly registered iPad can download them later. Other assets keep their
# existing verified-delete retention policy.
pc='sentlog-pc/index.html'
p=ROOT/pc;s=p.read_text()
if s.count('kind=in.(photo,drawing)')!=1:raise RuntimeError('PC asset query layout changed')
s=s.replace('kind=in.(photo,drawing)','kind=in.(photo,drawing,other)',1)
# Other asset types are left untouched. CAD references are handled once,
# and pc_verified reference images remain in cloud for future iPad delivery.
old="    for(const a of list){"
new="    for(const a of list){\n      if(a.kind==='other'&&(a.metadata?.source_type!=='cad-raster'||a.status!=='uploaded'))continue;"
if s.count(old)!=1:
    pos=s.find('async function syncOnce')
    raise RuntimeError('PC processing loop layout changed: '+repr(s[pos:pos+2400]))
s=s.replace(old,new,1)
old="  if(a.kind==='drawing'){\n    d=await subdir(d,'図面');"
new="""  if(a.kind==='other'&&a.metadata?.source_type==='cad-raster'){
    d=await subdir(d,'CAD参照画像');d=await subdir(d,drawing);
    logicalParts.push('CAD参照画像',safe(drawing));
  }else if(a.kind==='drawing'){
    d=await subdir(d,'図面');"""
if s.count(old)!=1:raise RuntimeError('PC folder layout changed')
s=s.replace(old,new,1)
if s.count('        await deleteVerified(a);')!=1:raise RuntimeError('PC deletion guard missing')
s=s.replace('        await deleteVerified(a);',"        if(a.kind!=='other')await deleteVerified(a);",1)
p.write_text(s)

# Cache the TIFF decoder for offline iPads. Bump the PWA cache once.
p=ROOT/'sentlog/sw.js';s=p.read_text()
marker="'dxf-core.js','dxf.js'"
if marker not in s:raise RuntimeError('DXF PWA resources missing')
s=s.replace(marker,"'dxf-core.js','dxf-raster-core.js','dxf.js','dxf-raster.js','vendor/pako.min.js','vendor/UTIF.js'",1)
m=re.search(r'sentlog-pwa-v(\d+)',s)
if not m:raise RuntimeError('PWA cache marker missing')
s=s.replace(m.group(0),'sentlog-pwa-v'+str(int(m.group(1))+1))
p.write_text(s)

for name in ('sentlog/dxf-raster-core.js','sentlog/dxf-raster.js','sentlog/dxf.js','sentlog/cloud-sync.js'):
    subprocess.run(['node','--check',name],cwd=ROOT,check=True)
subprocess.run(['node','tests/dxf_raster.test.cjs'],cwd=ROOT,check=True)
print('CAD raster: DXF IMAGE references, TIFF offline decoder, safe PC/cloud sync and overlay loaded')

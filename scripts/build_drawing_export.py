"""v1.88 after build_peer_photos.py: isolated complete-drawing PDF export."""
from pathlib import Path
import hashlib,re,urllib.request
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Drawing export integration mismatch: {path}: {old[:70]}')
 p.write_text(s.replace(old,new))
vendor=ROOT/'sentlog/vendor';vendor.mkdir(exist_ok=True)
assets=[
 ('export-pdf-lib.min.js','https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js','0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f'),
 ('export-pdf.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946'),
 ('export-pdf.worker.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js','feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b')]
for name,url,sha in assets:
 target=vendor/name
 if not target.exists():
  with urllib.request.urlopen(url,timeout=45) as response:target.write_bytes(response.read())
 if hashlib.sha256(target.read_bytes()).hexdigest()!=sha:raise RuntimeError('Export asset checksum mismatch: '+name)
(vendor/'export-NOTICE.txt').write_text('PDF-LIB 1.17.1\n'+(ROOT/'tools/drawing-export/pdf-lib-LICENSE.txt').read_text()+'\nPDF.js 3.11.174\n'+(ROOT/'tools/drawing-export/pdfjs-LICENSE.txt').read_text())
# A separate document reuses the drawing renderers, with memory-only records.
index=(ROOT/'sentlog/index.html').read_text()
html=''.join((ROOT/f'sentlog/part{i:02d}.txt').read_text() for i in range(1,10))
assert html.count('window.sentlogAppReady=initApp();')==1
html=html.replace('window.sentlogAppReady=initApp();','window.sentlogAppReady=Promise.resolve();')
html=html.replace("if('serviceWorker' in navigator&&location.protocol!=='file:'){","if(false){")
html=html.replace('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','./vendor/export-pdf.min.js')
html=html.replace('<head>','<head><script src="./drawing-export-frame.js?v=188"></script>')
modules=['pdf-quality.js','dimension-text.js','crack-width.js','field-records.js','dimension-lines.js','shape-dimensions.js','line-lengths.js','polygon-dimensions.js','damage-catalog.js','toolbar-icons.js','damage-styles.js','label-colors.js','label-settings.js','drawing-memos.js','dxf-core.js','dxf.js']
scripts=[]
for module in modules:
 match=re.search(r'src="\./('+re.escape(module)+r'\?v=[^"]+)"',index)
 if not match:raise RuntimeError('Export dependency missing: '+module)
 scripts.append('<script src="./'+match[1]+'"></script>')
scripts.extend(['<script src="./drawing-export-core.js?v=188"></script>','<script src="./drawing-export-renderer.js?v=188"></script>'])
html=html.replace('</body>',''.join(scripts)+'</body>')
(ROOT/'sentlog/drawing-export-view.html').write_text(html)
# Full-frame DXF capture is independent of the screen's pan/zoom.
change('sentlog/dxf.js',"root.SentlogDxf={version:'v1.79',", "root.SentlogDxf={version:'v1.79',pdfBackground:(w,h)=>{if(!current())throw Error('DXFを開いてください。');const f=state.dxf.frame;try{view(active,f.xMin+f.width*f.unitsPerPixel/2,f.yMax-f.height*f.unitsPerPixel/2,f.width*f.unitsPerPixel,w,h);return active.viewer.GetCanvas().toDataURL('image/png');}finally{viewport();}},")
change('sentlog/index.html',"['dxf.js?v=179','SentlogDxf']","['dxf.js?v=188','SentlogDxf'],['drawing-export-core.js?v=188','SentlogDrawingExportCore'],['drawing-export.js?v=188','SentlogDrawingExport v1.88']")
change('sentlog/index.html','src="./dxf.js?v=179"','src="./dxf.js?v=188"><\\/script><script src="./drawing-export-core.js?v=188"><\\/script><script src="./drawing-export.js?v=188"')
change('sentlog/index.html','phone-runtime.js?v=187','phone-runtime.js?v=188',2)
change('sentlog/index.html',"['phone-runtime.js?v=188','v1.87']","['phone-runtime.js?v=188','v1.88']")
change('sentlog/phone-runtime.js','v1.87','v1.88',4)
change('sentlog/sw.js','sentlog-pwa-v198','sentlog-pwa-v199')
extra=['drawing-export-core.js','drawing-export.js','drawing-export-frame.js','drawing-export-renderer.js','drawing-export-view.html']+[f'vendor/{n}' for n,_,_ in assets]
change('sentlog/sw.js',"'dxf-core.js'",','.join(repr(n) for n in extra)+",'dxf-core.js'")
for p in (ROOT/'tests').iterdir():
 if p.suffix not in ('.py','.cjs'):continue
 s=p.read_text();u=s.replace("'v1.87'","'v1.88'").replace('phone-runtime.js?v=187','phone-runtime.js?v=188').replace(r'phone-runtime\.js\?v=187',r'phone-runtime\.js\?v=188').replace('sentlog-pwa-v198','sentlog-pwa-v199')
 if s!=u:p.write_text(u)
print('Built v1.88: per-drawing multi-page PDF, ZIP and verified folder save')

# Keep the existing reviewed build order; apply v1.89 only after all v1.88 inputs exist.
import runpy
runpy.run_path(str(ROOT/'scripts/build_sync_reliability.py'),run_name='__main__')

# v1.90 is applied after the complete v1.89 output exists.
runpy.run_path(str(ROOT/'scripts/build_sync_traffic.py'),run_name='__main__')

# Bind synthetic ACKs to their actual originating test profile. The merge suite
# also creates conflict/PDF/pagination profiles; a two-name allowlist rejects
# those valid fixtures and leaves Playwright network callbacks unresolved.
change('tests/sync_merge_ui.py',
 'assets={};blobs={};writes=[];unexpected=[];fail_write=False;race_write=False;captured_uploads={};asset_key_reads=[]',
 'assets={};blobs={};writes=[];unexpected=[];fail_write=False;race_write=False;captured_uploads={};asset_key_reads=[];fixture_devices={}')
change('tests/sync_merge_ui.py',
 "    context.expose_binding('sentlogTestCaptureUpload',capture_upload)",
 "    fixture_devices[context]=name\n    context.expose_binding('sentlogTestCaptureUpload',capture_upload)")
change('tests/sync_merge_ui.py',
 "assert req.method=='POST' and body['p_device_id'] in ('ipad','phone'),body",
 "assert req.method=='POST' and body['p_device_id']==fixture_devices.get(req.frame.page.context),body")

# v1.91 changes only the isolated PDF export path and its release markers.
runpy.run_path(str(ROOT/'scripts/build_export_speed.py'),run_name='__main__')
import subprocess
subprocess.run(['node','tests/drawing_export_speed.test.cjs'],cwd=ROOT,check=True)

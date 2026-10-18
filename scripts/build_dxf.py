"""Integrate v1.78 after drawing memos, and build pinned offline DXF assets."""
from pathlib import Path
import hashlib, subprocess, urllib.request, shutil
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT=Path(__file__).resolve().parents[1]
pending={}
def change(path,old,new,count=1):
 text=pending.get(path,(ROOT/path).read_text())
 if text.count(old)!=count:raise RuntimeError(f'DXF integration mismatch: {path}: {old[:90]!r}: {text.count(old)} != {count}')
 pending[path]=text.replace(old,new)

change('sentlog/index.html',"['drawing-memos.js?v=177','SentlogDrawingMemos']","['drawing-memos.js?v=178','SentlogDrawingMemos'],['dxf-core.js?v=178','SentlogDxfCore'],['dxf.js?v=178','SentlogDxf']")
change('sentlog/index.html','<script src="./drawing-memos.js?v=177"><\\/script>','<script src="./drawing-memos.js?v=178"><\\/script><script src="./dxf-core.js?v=178"><\\/script><script src="./dxf.js?v=178"><\\/script>')
change('sentlog/index.html','phone-runtime.js?v=177','phone-runtime.js?v=178',2)
change('sentlog/index.html',"['phone-runtime.js?v=178','v1.77']","['phone-runtime.js?v=178','v1.78']")
change('sentlog/phone-runtime.js','v1.77','v1.78',4)
change('sentlog/index.html','cloud-sync.js?v=20261018-group-sync-172','cloud-sync.js?v=20261018-dxf-178',2)
change('sentlog/index.html','sync-view.js?v=172','sync-view.js?v=178',2)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v188';","const CACHE='sentlog-pwa-v189';")
change('sentlog/sw.js',"'drawing-memos.js','sync-view.js'","'drawing-memos.js','dxf-core.js','dxf.js','vendor/dxf-engine.js','vendor/dxf-worker.js','vendor/dxf-font.woff','sync-view.js'")
change('sentlog/cloud-sync.js',"  if(n.endsWith('.pdf')||blob.type==='application/pdf')return '.pdf';","  if(n.endsWith('.dxf')||/^(application|image)\\/(x-)?dxf$/i.test(blob.type))return '.dxf';\n  if(n.endsWith('.pdf')||blob.type==='application/pdf')return '.pdf';")
change('sentlog/sync-view.js','window.SentlogDrawingMemos?.isEditing?.()','window.SentlogDrawingMemos?.isEditing?.() || window.SentlogDxf?.isEditing?.()')
change('sentlog/sync-view.js','incoming.fileName!==state.fileName ||','incoming.fileName!==state.fileName || (state.sourceType===\'dxf\' && !same(incoming.dxf,state.dxf)) ||')
for path in (ROOT/'tests').iterdir():
 if path.suffix not in ('.py','.cjs'):continue
 text=path.read_text();updated=text.replace("SENTLOG_BUILD==='v1.77'","SENTLOG_BUILD==='v1.78'").replace('sentlog-pwa-v188','sentlog-pwa-v189')
 if path.name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):updated=updated.replace("'v1.77'","'v1.78'")
 updated=updated.replace(r'phone-runtime\.js\?v=177',r'phone-runtime\.js\?v=178')
 updated=updated.replace(r'drawing-memos\.js\?v=177',r'drawing-memos\.js\?v=178').replace(r'sync-view\.js\?v=172',r'sync-view\.js\?v=178').replace('sync-view.js?v=172','sync-view.js?v=178').replace('20261018-group-sync-172','20261018-dxf-178')
 if updated!=text:pending[str(path.relative_to(ROOT))]=updated

tool=ROOT/'tools/dxf-engine';vendor=ROOT/'sentlog/vendor';vendor.mkdir(exist_ok=True)
subprocess.run(['npm','ci','--prefix',str(tool),'--no-audit','--no-fund'],check=True)
# CFF/OpenType glyphs lack TrueType xMin/yMin properties. Compute bounds from
# their outline, otherwise ordinary TEXT/ATTRIB geometry becomes NaN.
renderer=tool/'node_modules/dxf-viewer/src/TextRenderer.js'
renderer_text=renderer.read_text()
old="""        return {advance: glyph.advanceWidth * scale, path,
                bounds: {xMin: glyph.xMin * scale, xMax: glyph.xMax * scale,
                         yMin: glyph.yMin * scale, yMax: glyph.yMax * scale}}"""
new="""        const box = glyph.getBoundingBox()
        return {advance: glyph.advanceWidth * scale, path,
                bounds: {xMin: box.x1 * scale, xMax: box.x2 * scale,
                         yMin: box.y1 * scale, yMax: box.y2 * scale}}"""
if renderer_text.count(old)!=1:raise RuntimeError('DXF CFF font integration mismatch')
renderer_text=renderer_text.replace(old,new);renderer.write_text(renderer_text)
(vendor/'dxf-text-renderer-source.js').write_text(renderer_text)
esbuild=tool/'node_modules/.bin/esbuild'
for name in ('main','worker'):
 target='dxf-engine.js' if name=='main' else 'dxf-worker.js'
 subprocess.run([str(esbuild),str(tool/f'{name}.js'),'--bundle','--format=iife','--minify','--legal-comments=inline',f'--outfile={vendor/target}'],check=True)
font=tool/'NotoSansCJKjp-Regular.otf'
if not font.exists():
 with urllib.request.urlopen('https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf',timeout=60) as r:font.write_bytes(r.read())
if hashlib.sha256(font.read_bytes()).hexdigest()!='68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5':raise RuntimeError('DXF font checksum mismatch')
chars=set(range(0x400))|set(range(0x2000,0x2700))|set(range(0xff00,0xfff0))
for a in range(256):
 for b in range(256):
  try:
   s=bytes([a,b]).decode('cp932')
   if len(s)==1:chars.add(ord(s))
  except UnicodeError:pass
options=subset.Options();options.layout_features=[]
f=TTFont(font);s=subset.Subsetter(options=options);s.populate(unicodes=chars);s.subset(f);f.flavor='woff';f.save(vendor/'dxf-font.woff')
licenses=[]
for package in ('dxf-viewer','three','opentype.js','earcut','loglevel'):
 folder=tool/'node_modules'/package
 for file in list(folder.glob('LICENSE*'))[:1]:licenses.append(package+'\n'+file.read_text())
licenses.append((tool/'NOTICE.md').read_text())
with urllib.request.urlopen('https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE',timeout=30) as r:licenses.append(r.read().decode())
(vendor/'dxf-licenses.txt').write_text('\n\n'.join(licenses))
shutil.rmtree(tool/'node_modules');font.unlink()
for path,text in pending.items():(ROOT/path).write_text(text)
print('Built Sentlog v1.78: DXF import, offline hatch/text renderer, retained originals and layered CAD export')

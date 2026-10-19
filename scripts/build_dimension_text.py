"""v1.83: use shared dimension typography in every drawing renderer."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def replace(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:raise RuntimeError(f'Dimension-text integration mismatch: {path}: {old}')
    p.write_text(s.replace(old,new))
modules=[('crack-width',163,'SentlogCrackWidth'),('dimension-lines',173,'SentlogDimensionLines'),
         ('shape-dimensions',182,'SentlogShapeDimensions v1.82'),('line-lengths',182,'SentlogLineLengths'),
         ('polygon-dimensions',149,'window.SentlogPolygonDimensions'),('drawing-memos',178,'SentlogDrawingMemos')]
for name,version,token in modules:
    marker=token.replace(' v1.82','')+' v1.83'
    replace('sentlog/index.html',f"['{name}.js?v={version}','{token}']",f"['{name}.js?v=183','{marker}']")
    replace('sentlog/index.html',f'{name}.js?v={version}',f'{name}.js?v=183')
    path=ROOT/f'sentlog/{name}.js';source=path.read_text()
    if 'SentlogDimensionText?.fontSize()' not in source:raise RuntimeError(f'Missing shared font: {name}')
    path.write_text(f'/* {marker} */\n'+source)
replace('sentlog/index.html',"['crack-width.js?v=183'","['dimension-text.js?v=183','SentlogDimensionText v1.83'],['crack-width.js?v=183'")
replace('sentlog/index.html','<script src="./crack-width.js?v=183">','<script src="./dimension-text.js?v=183"><\\/script><script src="./crack-width.js?v=183">')
replace('sentlog/index.html','phone-runtime.js?v=182','phone-runtime.js?v=183',2)
replace('sentlog/index.html',"['phone-runtime.js?v=183','v1.82']","['phone-runtime.js?v=183','v1.83']")
replace('sentlog/phone-runtime.js','v1.82','v1.83',4)
replace('sentlog/sw.js','sentlog-pwa-v193','sentlog-pwa-v194')
replace('sentlog/sw.js',"'crack-width.js'","'dimension-text.js','crack-width.js'")
for p in (ROOT/'tests').iterdir():
    if p.suffix not in ('.py','.cjs'):continue
    s=p.read_text();updated=s.replace("SENTLOG_BUILD==='v1.82'","SENTLOG_BUILD==='v1.83'").replace("'v1.82'","'v1.83'").replace('sentlog-pwa-v193','sentlog-pwa-v194')
    for name,version,*_ in modules+[('phone-runtime',182)]:
        updated=updated.replace(f'{name}.js?v={version}',f'{name}.js?v=183').replace(rf'{name}\.js\?v={version}',rf'{name}\.js\?v=183')
    if updated!=s:p.write_text(updated)
print('Built Sentlog v1.83: consistent dimension text across tools and zoom levels')

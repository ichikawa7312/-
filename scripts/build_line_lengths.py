"""v1.82 integration after v1.81: recorded straight/freehand damage lengths."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def replace(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:raise RuntimeError(f'Line-length integration mismatch: {path}: {old}')
    p.write_text(s.replace(old,new))
replace('sentlog/index.html',"['shape-dimensions.js?v=176','SentlogShapeDimensions']","['shape-dimensions.js?v=182','SentlogShapeDimensions v1.82'],['line-lengths.js?v=182','SentlogLineLengths']")
replace('sentlog/index.html','<script src="./shape-dimensions.js?v=176"><\\/script>','<script src="./shape-dimensions.js?v=182"><\\/script><script src="./line-lengths.js?v=182"><\\/script>')
replace('sentlog/index.html','phone-runtime.js?v=181','phone-runtime.js?v=182',2)
replace('sentlog/index.html',"['phone-runtime.js?v=182','v1.81']","['phone-runtime.js?v=182','v1.82']")
replace('sentlog/phone-runtime.js','v1.81','v1.82',4)
replace('sentlog/sw.js','sentlog-pwa-v192','sentlog-pwa-v193')
replace('sentlog/sw.js',"'shape-dimensions.js'","'shape-dimensions.js','line-lengths.js'")
for p in (ROOT/'tests').iterdir():
    if p.suffix not in ('.py','.cjs'):continue
    s=p.read_text();updated=s.replace("SENTLOG_BUILD==='v1.81'","SENTLOG_BUILD==='v1.82'").replace("'v1.81'","'v1.82'").replace('sentlog-pwa-v192','sentlog-pwa-v193')
    updated=updated.replace(r'phone-runtime\.js\?v=181',r'phone-runtime\.js\?v=182').replace('phone-runtime.js?v=181','phone-runtime.js?v=182')
    updated=updated.replace(r'shape-dimensions\.js\?v=176',r'shape-dimensions\.js\?v=182').replace('shape-dimensions.js?v=176','shape-dimensions.js?v=182')
    if updated!=s:p.write_text(updated)
print('Built Sentlog v1.82: straight/freehand line lengths, manual metre records, scale-aware geometry')

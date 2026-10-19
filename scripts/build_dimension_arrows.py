"""v1.84: consistent dimension arrows, strokes and extension overshoot."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def replace(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:raise RuntimeError(f'Dimension-arrow integration mismatch: {path}: {old}')
    p.write_text(s.replace(old,new))
source=(ROOT/'sentlog/drawing-memos.js').read_text()
if "styleUnit=type==='dimension'?1/z():unit" not in source or '8*styleUnit,4*styleUnit' not in source:
    raise RuntimeError('Dimension arrow screen sizing is missing')
replace('sentlog/drawing-memos.js','/* SentlogDrawingMemos v1.83 */','/* SentlogDrawingMemos v1.84 */')
replace('sentlog/index.html','drawing-memos.js?v=183','drawing-memos.js?v=184',2)
replace('sentlog/index.html','SentlogDrawingMemos v1.83','SentlogDrawingMemos v1.84')
replace('sentlog/index.html','phone-runtime.js?v=183','phone-runtime.js?v=184',2)
replace('sentlog/index.html',"['phone-runtime.js?v=184','v1.83']","['phone-runtime.js?v=184','v1.84']")
replace('sentlog/phone-runtime.js','v1.83','v1.84',4)
replace('sentlog/sw.js','sentlog-pwa-v194','sentlog-pwa-v195')
for p in (ROOT/'tests').iterdir():
    if p.suffix not in ('.py','.cjs'):continue
    s=p.read_text();updated=s.replace("SENTLOG_BUILD==='v1.83'","SENTLOG_BUILD==='v1.84'").replace("'v1.83'","'v1.84'").replace('sentlog-pwa-v194','sentlog-pwa-v195')
    for name in ['drawing-memos','phone-runtime']:
        updated=updated.replace(f'{name}.js?v=183',f'{name}.js?v=184').replace(rf'{name}\.js\?v=183',rf'{name}\.js\?v=184')
    if updated!=s:p.write_text(updated)
print('Built Sentlog v1.84: screen-sized dimension arrows and strokes; existing offsets and records retained')

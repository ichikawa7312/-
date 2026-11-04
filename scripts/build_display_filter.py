"""Integrate the temporary drawing visibility filter and direct filtered PDF output.

Run after build_photo_ledger.py. It never reads or changes any user data and
changes only the publication artifact and read-only export renderer.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def change(path, old, new):
    p = ROOT / path
    value = p.read_text(encoding='utf-8')
    if value.count(old) != 1:
        raise RuntimeError(f'Display filter integration mismatch in {path}: {old[:100]!r}: {value.count(old)}')
    p.write_text(value.replace(old, new, 1), encoding='utf-8')

for module in ('display-filter-core.js', 'display-filter.js'):
    if not (ROOT / 'sentlog' / module).is_file():
        raise RuntimeError(f'Missing display-filter module: {module}')

# Reuse the existing verified exporter and preserve original PDF vectors.
# The existing page-management build already sets 'pages' after hiding pages.
# Narrow only that list for a one-page export; do not bypass hidden-page rules.
change(
    'sentlog/drawing-export.js',
    '  const pages=Array.from({length:info.count},(_,i)=>i+1).filter(n=>!item.state.pageStates?.[String(n)]?.hidden);',
    """  if(item.onlyPage!=null&&(!Number.isInteger(Number(item.onlyPage))||Number(item.onlyPage)<1||Number(item.onlyPage)>info.count))throw Error('出力ページの番号を確認できません。');
  const pages=Array.from({length:info.count},(_,i)=>i+1).filter(n=>!item.state.pageStates?.[String(n)]?.hidden&&(item.onlyPage==null||n===Number(item.onlyPage)));""",
)
# Filter only during the iframe's render; keep the complete shape list
# throughout initialization so that original damage numbers never change.
change(
    'sentlog/drawing-export-renderer.js',
    'const C=window.SentlogDrawingExportCore;',
    '''const C=window.SentlogDrawingExportCore;
const F=window.SentlogDisplayFilterCore;
if(input.filter){
 if(!F)throw Error('表示フィルターを読み込めません。');
 const originalRender=render;
 render=function(){
  const all=state.shapes||[];
  state.shapes=all.filter(s=>F.isVisible(s,input.filter));
  try{return originalRender.apply(this,arguments);}finally{state.shapes=all;}
 };
}''',
)

# Load the core before the renderer inside the isolated export document.
change(
    'sentlog/drawing-export-view.html',
    '<script src="./drawing-export-renderer.js?v=191"></script>',
    '<script src="./display-filter-core.js?v=211"></script><script src="./drawing-export-renderer.js?v=191"></script>',
)

# Load after all existing render wrappers. No changes to persistence or sync.
bootstrap = ROOT / 'sentlog/index.html'
value = bootstrap.read_text(encoding='utf-8')
anchor = 'document.open();document.write(html);document.close()'
if value.count(anchor) != 1:
    raise RuntimeError('Display filter bootstrap anchor missing')
if 'display-filter.js?v=211' in value:
    raise RuntimeError('Display filter is already integrated')
injection = r'''html=html.replace('</body>','<script src=\"./display-filter-core.js?v=211\"><\/script><script src=\"./display-filter.js?v=211\"><\/script></body>');'''
bootstrap.write_text(value.replace(anchor, injection + anchor, 1), encoding='utf-8')

# Offline mode: preload both scripts, retaining the existing SW safeguards.
sw = ROOT / 'sentlog/sw.js'
value = sw.read_text(encoding='utf-8')
for module in ('display-filter-core.js', 'display-filter.js'):
    if "'" + module + "'" in value:
        raise RuntimeError(f'Duplicate SW cache item: {module}')
value = value.replace('const FILES=[', "const FILES=['display-filter-core.js','display-filter.js',", 1)
match = re.search(r'sentlog-pwa-v\d+', value)
if not match:
    raise RuntimeError('Missing SW cache version')
old = match.group(0)
new = 'sentlog-pwa-v' + str(int(old.rsplit('v', 1)[-1]) + 1)
value = value.replace(old, new, 1)
sw.write_text(value, encoding='utf-8')
for test in (ROOT / 'tests').iterdir():
    if test.suffix not in ('.cjs', '.py'):
        continue
    test_value = test.read_text(encoding='utf-8')
    if old in test_value:
        test.write_text(test_value.replace(old, new), encoding='utf-8')
print('Display filter integrated: types, record IDs, current/all-page PDF')

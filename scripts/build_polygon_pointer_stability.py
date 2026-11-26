"""Keep a displayed polygon candidate stable during a small touch/pen release.

Run after the complete v1.97 build. Only the input path for a new polygon is
changed; stored geometry, dimension editing and the snap rules stay intact.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MARKER = 'sentlog-polygon-pointer-stability-v1'


def change(text, old, new, count=1):
    found = text.count(old)
    if found != count:
        raise RuntimeError(f'Polygon pointer integration changed: {old[:100]!r}: {found}, expected {count}')
    return text.replace(old, new)


path = ROOT / 'sentlog/part09.txt'
source = path.read_text(encoding='utf-8')
if MARKER in source:
    raise RuntimeError('Polygon pointer stability requires a pristine production build')
helpers = r'''// sentlog-polygon-pointer-stability-v1
// A tiny movement when lifting a finger must not change the already displayed
// edge to a different 45-degree direction. This tolerance is in screen pixels
// and applies only to the same live touch/pen candidate, never dimension input.
const POLYGON_RELEASE_SLOP=6;
function rememberPolygonPointer(e,raw){
  const pts=drawing?.kind==='polygon'?drawing.points:null,last=pts?.[pts.length-1];
  return {pointerId:e.pointerId,pointerType:e.pointerType,raw:{x:raw.x,y:raw.y},
    draft:drawing,count:pts?.length||0,anchor:last?{x:last.x,y:last.y}:null,
    preview:polygonDraftCursor,scale,tx,ty,project:activeProjectId,
    drawingId:activeDrawingId,page:state.currentPage};
}
function polygonPointerRelease(e){
  const raw=point(e),sample=polygonTouch;
  const pts=drawing?.kind==='polygon'?drawing.points:null,last=pts?.[pts.length-1];
  if(!sample||!sample.preview||sample.pointerId!==e.pointerId||sample.pointerType!==e.pointerType||
     (e.pointerType!=='touch'&&e.pointerType!=='pen')||currentView!=='editor'||
     sample.draft!==drawing||sample.count!==pts?.length||!last||!sample.anchor||
     sample.anchor.x!==last.x||sample.anchor.y!==last.y||sample.preview!==polygonDraftCursor||
     sample.scale!==scale||sample.tx!==tx||sample.ty!==ty||sample.project!==activeProjectId||
     sample.drawingId!==activeDrawingId||sample.page!==state.currentPage||
     ![raw.x,raw.y,sample.raw.x,sample.raw.y].every(Number.isFinite))return raw;
  const distance=Math.hypot(raw.x-sample.raw.x,raw.y-sample.raw.y)*Math.max(scale,.001);
  return distance<=POLYGON_RELEASE_SLOP?{...sample.raw}:raw;
}

'''
source = change(source, '// Keep each live contact until its own up/cancel event.',
                helpers + '// Keep each live contact until its own up/cancel event.')
source = change(source,
                '      polygonTouch={pointerId:e.pointerId};\n      polygonDraftCursor=polygonPreviewAt(p);',
                '      polygonDraftCursor=polygonPreviewAt(p);\n      polygonTouch=rememberPolygonPointer(e,p);')
source = change(source,
                '    polygonDraftCursor=polygonPreviewAt(p);\n    renderPreview();return;',
                '    polygonDraftCursor=polygonPreviewAt(p);\n    if(polygonTouch)polygonTouch=rememberPolygonPointer(e,p);\n    renderPreview();return;')
source = change(source,
                "  if(polygonTouch && e.pointerId===polygonTouch.pointerId){\n    polygonTouch=null;\n    if(!cancelled&&tool==='polygon')commitPolygonVertex(point(e));",
                "  if(polygonTouch && e.pointerId===polygonTouch.pointerId){\n    const releasedPoint=cancelled?null:polygonPointerRelease(e);\n    polygonTouch=null;\n    if(!cancelled&&tool==='polygon')commitPolygonVertex(releasedPoint);")
path.write_text(source, encoding='utf-8')

# Reject a stale offline fragment before running any application code.
for filename in ['sentlog/index.html', 'sentlog-pc/index.html']:
    path = ROOT / filename
    text = path.read_text(encoding='utf-8')
    if filename == 'sentlog/index.html':
        text = change(text, 'for(const [i,token] of [', "for(const [i,token] of [[8,'" + MARKER + "'],")
    text = text.replace('phone-runtime.js?v=197', 'phone-runtime.js?v=198')
    text = text.replace("'v1.97'", "'v1.98'")
    text = text.replace('v1.97 · 写真の撮影順・撮影後の画面復帰', 'v1.98 · 多角形の確定方向を安定化')
    path.write_text(text, encoding='utf-8')

path = ROOT / 'sentlog/phone-runtime.js'
path.write_text(change(path.read_text(encoding='utf-8'), 'v1.97', 'v1.98', 4), encoding='utf-8')

path = ROOT / 'sentlog/sw.js'
text = path.read_text(encoding='utf-8')
old_cache = re.search(r'sentlog-pwa-v\d+', text).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 1)
path.write_text(text.replace(old_cache, new_cache), encoding='utf-8')

for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    old = path.read_text(encoding='utf-8')
    text = old.replace(old_cache, new_cache)
    text = text.replace("'v1.97'", "'v1.98'")
    text = text.replace('phone-runtime.js?v=197', 'phone-runtime.js?v=198')
    text = text.replace(r'phone-runtime\.js\?v=197', r'phone-runtime\.js\?v=198')
    text = text.replace('v1.97 · 写真の撮影順・撮影後の画面復帰', 'v1.98 · 多角形の確定方向を安定化')
    if path.name == 'polygon_snap.test.cjs':
        text = change(text,
                      "if(!cancelled&&tool==='polygon')commitPolygonVertex(point(e))",
                      "if(!cancelled&&tool==='polygon')commitPolygonVertex(releasedPoint)")
    if text != old:
        path.write_text(text, encoding='utf-8')

html = ''.join((ROOT / 'sentlog' / f'part{i:02d}.txt').read_text(encoding='utf-8') for i in range(1, 10))
for label, document in [('joined application', html), ('application loader', (ROOT / 'sentlog/index.html').read_text(encoding='utf-8'))]:
    inline = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script\s*>', document, re.S | re.I)
    if not inline:
        raise RuntimeError(label + ' has no inline script')
    for script in inline:
        subprocess.run(['node', '--check'], input=script, text=True, cwd=ROOT, check=True)
subprocess.run(['node', '--check', 'sentlog/phone-runtime.js'], cwd=ROOT, check=True)
subprocess.run(['node', 'tests/polygon_pointer.test.cjs'], cwd=ROOT, check=True)
print('Built v1.98 stable polygon touch/pen release; ' + new_cache)

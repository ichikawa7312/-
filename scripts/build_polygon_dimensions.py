"""Guarded v1.49 metre dimensions build after v1.48 angle-snap polygon.
No user project, photos, Supabase records or PC backup files are modified.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Polygon dimensions integration mismatch {path}: expected {count} {old[:75]!r}; saw {s.count(old)}')
 p.write_text(s.replace(old,new))
p='sentlog/index.html'
change(p,"['shape-move.js?v=144','window.SentlogShapeMove']",
 "['shape-move.js?v=144','window.SentlogShapeMove'],['polygon-dimensions.js?v=149','window.SentlogPolygonDimensions']")
change(p,'<script src="./shape-move.js?v=144"><\\/script>',
 '<script src="./shape-move.js?v=144"><\\/script><script src="./polygon-dimensions.js?v=149"><\\/script>')
change(p,"'v1.48'","'v1.49'")
change(p,'phone-runtime.js?v=148','phone-runtime.js?v=149',2)
change('sentlog/phone-runtime.js','v1.48','v1.49',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v159';","const CACHE='sentlog-pwa-v160';")
change('sentlog/sw.js',"'shape-move.js','record-store.js'","'shape-move.js','polygon-dimensions.js','record-store.js'")
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py',
             'instant_damage_type_ui.py','overview_labels_ui.py','polygon_snap_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.48'","window.SENTLOG_BUILD==='v1.49'")
change('tests/capacity.test.cjs',"'v1.48'","'v1.49'")
change('tests/resilience.test.cjs',"'v1.48'","'v1.49'",1)
print('Built Sentlog v1.49: parallel metre edge lengths, hold to input, no added drawing toolbar')

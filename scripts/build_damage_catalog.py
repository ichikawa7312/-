"""Guarded v1.50 catalog integration after the v1.49 polygon dimensions build.
Only static application/test files are changed. No user records or databases.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:
  raise RuntimeError(f'Damage catalog integration mismatch {path}: expected {count} of {old[:80]!r}, saw {s.count(old)}')
 p.write_text(s.replace(old,new))
p='sentlog/index.html'
change(p,"['polygon-dimensions.js?v=149','window.SentlogPolygonDimensions']",
 "['polygon-dimensions.js?v=149','window.SentlogPolygonDimensions'],['damage-catalog.js?v=150','SentlogDamageCatalog']")
change(p,'<script src="./polygon-dimensions.js?v=149"><\\/script>',
 '<script src="./polygon-dimensions.js?v=149"><\\/script><script src="./damage-catalog.js?v=150"><\\/script>')
change(p,"'v1.49'","'v1.50'")
change(p,'phone-runtime.js?v=149','phone-runtime.js?v=150',2)
change('sentlog/phone-runtime.js','v1.49','v1.50',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v160';","const CACHE='sentlog-pwa-v161';")
change('sentlog/sw.js',"'polygon-dimensions.js','record-store.js'","'polygon-dimensions.js','damage-catalog.js','record-store.js'")
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py',
             'instant_damage_type_ui.py','overview_labels_ui.py','polygon_snap_ui.py','polygon_dimensions_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.49'","window.SENTLOG_BUILD==='v1.50'")
change('tests/capacity.test.cjs',"'v1.49'","'v1.50'")
change('tests/resilience.test.cjs',"'v1.49'","'v1.50'")
print('Built Sentlog v1.50: unified material catalog, source editions, offline project-specific names; no record migration')

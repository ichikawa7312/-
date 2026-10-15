"""Integrate presentation-only toolbar after the v1.50 build. No record migration."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Toolbar integration mismatch: {path}, expected {count} of {old[:70]!r}, saw {s.count(old)}')
 p.write_text(s.replace(old,new))
p='sentlog/index.html'
change(p,"['damage-catalog.js?v=150','SentlogDamageCatalog']", "['damage-catalog.js?v=150','SentlogDamageCatalog'],['toolbar-icons.js?v=151','SentlogToolbarIcons']")
change(p,'<script src="./damage-catalog.js?v=150"><\\/script>', '<script src="./damage-catalog.js?v=150"><\\/script><script src="./toolbar-icons.js?v=151"><\\/script>')
change(p,"'v1.50'","'v1.51'")
change(p,'phone-runtime.js?v=150','phone-runtime.js?v=151',2)
change('sentlog/phone-runtime.js','v1.50','v1.51',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v161';","const CACHE='sentlog-pwa-v162';")
change('sentlog/sw.js',"'damage-catalog.js','record-store.js'","'damage-catalog.js','toolbar-icons.js','record-store.js'")
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py','instant_damage_type_ui.py','overview_labels_ui.py','polygon_snap_ui.py','polygon_dimensions_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.50'","window.SENTLOG_BUILD==='v1.51'")
change('tests/damage_catalog_ui.py',"window.SENTLOG_BUILD==='v1.50'","window.SENTLOG_BUILD==='v1.51'",2)
change('tests/capacity.test.cjs',"'v1.50'","'v1.51'")
change('tests/resilience.test.cjs',"'v1.50'","'v1.51'")
change('tests/polygon_snap_ui.py',"page.locator('[data-tool=\"polygon\"]').inner_text()=='多角形（45°/90°）'", "page.locator('[data-tool=\"polygon\"]').get_attribute('aria-label')=='多角形（45°/90°）'")
print('Built Sentlog v1.51: seven responsive SVG tool buttons, touch-hold help, keyboard access; no drawing/state changes')

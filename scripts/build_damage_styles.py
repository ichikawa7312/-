"""Integrate v1.53 after v1.52. Static files only; no user data migration."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Damage style integration mismatch: {path}, expected {count} of {old[:90]!r}, saw {s.count(old)}')
 p.write_text(s.replace(old,new))
p='sentlog/index.html'
change(p,"['toolbar-icons.js?v=152','SentlogToolbarIcons']", "['toolbar-icons.js?v=152','SentlogToolbarIcons'],['damage-styles.js?v=153','SentlogDamageStyles']")
change(p,'<script src="./toolbar-icons.js?v=152"><\\/script>','<script src="./toolbar-icons.js?v=152"><\\/script><script src="./damage-styles.js?v=153"><\\/script>')
change(p,'damage-catalog.js?v=150','damage-catalog.js?v=153',2)
change(p,'sync-view.js?v=130','sync-view.js?v=153',2)
change(p,"'v1.52'","'v1.53'")
change(p,'phone-runtime.js?v=152','phone-runtime.js?v=153',2)
change('sentlog/phone-runtime.js','v1.52','v1.53',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v163';","const CACHE='sentlog-pwa-v164';")
change('sentlog/sw.js',"'toolbar-icons.js','record-store.js'","'toolbar-icons.js','damage-styles.js','record-store.js'")
# Newly entered names can store one optional display family in the existing project snapshot.
change('sentlog/damage-catalog.js',"material:customMaterial.value,createdAt:Date.now()", "material:customMaterial.value,displayGroup:root.SentlogDamageStyles?.newNameGroup?.()||'other',createdAt:Date.now()")
change('sentlog/sync-view.js','window.SentlogPolygonDimensions?.isEditing?.())','window.SentlogPolygonDimensions?.isEditing?.() || window.SentlogDamageStyles?.isEditing?.())')
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py','instant_damage_type_ui.py','overview_labels_ui.py','polygon_snap_ui.py','polygon_dimensions_ui.py','toolbar_icons_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.52'","window.SENTLOG_BUILD==='v1.53'")
change('tests/damage_catalog_ui.py',"window.SENTLOG_BUILD==='v1.52'","window.SENTLOG_BUILD==='v1.53'",2)
# The help tests use one version check per browser case.
p='tests/toolbar_help_ui.py'
s=(ROOT/p).read_text();n=s.count("window.SENTLOG_BUILD==='v1.52'")
if not n:raise RuntimeError('Missing toolbar-help test version')
change(p,"window.SENTLOG_BUILD==='v1.52'","window.SENTLOG_BUILD==='v1.53'",n)
for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs'):
 change('tests/'+name,"'v1.52'","'v1.53'")
change('tests/toolbar_icons.test.cjs','sentlog-pwa-v163','sentlog-pwa-v164')
print('Built Sentlog v1.53: 6 display families, zoom-stable hatch, offline custom-name family and view-only modes')

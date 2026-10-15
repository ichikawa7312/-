"""Guarded v1.47 label overview scaling release (after v1.46 build).
Change only versioned static app and regression-test expected version.
No cloud database, stored photos, or drawing geometry are modified.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path
 s=p.read_text()
 if s.count(old)!=count:
  raise RuntimeError(f'Overview label build mismatch: {path}: expected {count} of {old[:70]!r}, got {s.count(old)}')
 p.write_text(s.replace(old,new))
change('sentlog/index.html',"'v1.46'","'v1.47'")
change('sentlog/index.html','phone-runtime.js?v=146','phone-runtime.js?v=147',2)
change('sentlog/index.html','label-settings.js?v=146','label-settings.js?v=147')
change('sentlog/phone-runtime.js','v1.46','v1.47',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v157';","const CACHE='sentlog-pwa-v158';")
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py','instant_damage_type_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.46'","window.SENTLOG_BUILD==='v1.47'")
change('tests/capacity.test.cjs',"'v1.46'","'v1.47'")
change('tests/resilience.test.cjs',"'v1.46'","'v1.47'",1)
print('Built Sentlog v1.47: smaller labels at whole-page zoom; 100%+ unchanged')

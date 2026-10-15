"""Guarded v1.48 octilinear polygon build, after the verified v1.47 build.
Static UI update only; no project, PC backup, or Supabase changes.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Octilinear polygon build mismatch: {path} expected {count} {old[:65]!r}, got {s.count(old)}')
 p.write_text(s.replace(old,new))
change('sentlog/index.html',"'v1.47'","'v1.48'")
change('sentlog/index.html','phone-runtime.js?v=147','phone-runtime.js?v=148',2)
change('sentlog/phone-runtime.js','v1.47','v1.48',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v158';","const CACHE='sentlog-pwa-v159';")
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py','instant_damage_type_ui.py','overview_labels_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.47'","window.SENTLOG_BUILD==='v1.48'")
change('tests/capacity.test.cjs',"'v1.47'","'v1.48'")
change('tests/resilience.test.cjs',"'v1.47'","'v1.48'",1)
print('Built Sentlog v1.48: 0/45/90 polygon snap and live directional/closure preview')

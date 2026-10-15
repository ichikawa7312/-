"""Release compact annotations after the guarded v1.45 build."""
from pathlib import Path
root=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=root/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'compact text build mismatch {path}: {old[:75]} found {s.count(old)}')
 p.write_text(s.replace(old,new))
change('sentlog/index.html',"'v1.45'","'v1.46'")
change('sentlog/index.html','phone-runtime.js?v=145','phone-runtime.js?v=146',2)
change('sentlog/index.html','label-settings.js?v=125','label-settings.js?v=146',1)
change('sentlog/phone-runtime.js','v1.45','v1.46',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v156';","const CACHE='sentlog-pwa-v157';")
for t in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py','instant_damage_type_ui.py'):
 change('tests/'+t,"window.SENTLOG_BUILD==='v1.45'","window.SENTLOG_BUILD==='v1.46'")
change('tests/capacity.test.cjs',"'v1.45'","'v1.46'")
change('tests/resilience.test.cjs',"'v1.45'","'v1.46'",1)
print('Built Sentlog v1.46 compact zoom labels')
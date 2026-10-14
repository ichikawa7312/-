"""Add long-press damage group movement after existing Sentlog v1.41 build.
Static integration only: touches no user projects, cloud rows or PC backups.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path
 text=p.read_text()
 if text.count(old)!=count:
  raise RuntimeError(f'Shape-move integration mismatch: {path}: expected {count} of {old[:85]!r}, saw {text.count(old)}')
 p.write_text(text.replace(old,new))

p='sentlog/index.html'
change(p,"['photo-recovery.js?v=141','sentlogCheckPhotoRecovery']",
 "['photo-recovery.js?v=141','sentlogCheckPhotoRecovery'],['shape-move.js?v=144','window.SentlogShapeMove']")
# Install AFTER existing inspector and label-size scripts (which override render,
# selection and hit targets) and BEFORE the sync-view busy guard is loaded.
change(p,'<script src="./label-settings.js?v=125"><\\/script>',
 '<script src="./label-settings.js?v=125"><\\/script><script src="./shape-move.js?v=144"><\\/script>')
change(p,"'v1.41'","'v1.44'")
change(p,'phone-runtime.js?v=141','phone-runtime.js?v=144',2)
p='sentlog/phone-runtime.js'
change(p,'v1.41','v1.44',4)
p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v154';","const CACHE='sentlog-pwa-v155';")
change(p,"'photo-recovery.js','record-store.js'","'photo-recovery.js','shape-move.js','record-store.js'")
change('tests/full_management.py',"window.SENTLOG_BUILD==='v1.41'","window.SENTLOG_BUILD==='v1.44'")
change('tests/full_archive_click.py',"window.SENTLOG_BUILD==='v1.41'","window.SENTLOG_BUILD==='v1.44'")
change('tests/capacity_ui.py',"window.SENTLOG_BUILD==='v1.41'","window.SENTLOG_BUILD==='v1.44'")
change('tests/capacity.test.cjs',"'v1.41'","'v1.44'")
change('tests/resilience.test.cjs',"'v1.41'","'v1.44'",1)
print('Built Sentlog v1.44: long press damage -> cross cursor -> move shape + label')

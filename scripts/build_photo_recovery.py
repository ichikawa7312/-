"""Guarded Sentlog v1.41 photo redelivery integration (after v1.40 build).
Only static app code/versioning is patched. No real user data is touched.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:
  raise RuntimeError(f'Photo integration mismatch: {path}: expected {count} {old[:75]!r}, got {s.count(old)}')
 p.write_text(s.replace(old,new))

p='sentlog/index.html'
change(p,"['capacity-details.js?v=140','SentlogDetails']",
  "['capacity-details.js?v=140','SentlogDetails'],['photo-recovery.js?v=141','sentlogCheckPhotoRecovery']")
change(p,'pdf-recovery.js?v=135','pdf-recovery.js?v=141',2)
change(p,'<script type="module" src="./pdf-recovery.js?v=141"><\\/script>',
  '<script type="module" src="./pdf-recovery.js?v=141"><\\/script><script type="module" src="./photo-recovery.js?v=141"><\\/script>')
change(p,"'v1.40'","'v1.41'")
change(p,'phone-runtime.js?v=140','phone-runtime.js?v=141',2)

p='sentlog/phone-runtime.js'
change(p,'v1.40','v1.41',4)
p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v153';","const CACHE='sentlog-pwa-v154';")
change(p,"'capacity-details.js','record-store.js'","'capacity-details.js','photo-recovery.js','record-store.js'")

p='sentlog-pc/index.html'
change(p,'pdf-recovery.js?v=135','pdf-recovery.js?v=141')
change(p,'<script type="module" src="../sentlog/pdf-recovery.js?v=141"></script>',
  '<script type="module" src="../sentlog/pdf-recovery.js?v=141"></script>\n<script type="module" src="../sentlog/photo-recovery.js?v=141"></script>')
change(p,'v1.40 · 容量整理・新端末復旧','v1.41 · 写真の再取得対応')

change('tests/full_management.py',"window.SENTLOG_BUILD==='v1.40'","window.SENTLOG_BUILD==='v1.41'")
change('tests/full_archive_click.py',"window.SENTLOG_BUILD==='v1.40'","window.SENTLOG_BUILD==='v1.41'")
change('tests/capacity_ui.py',"window.SENTLOG_BUILD==='v1.40'","window.SENTLOG_BUILD==='v1.41'")
change('tests/capacity.test.cjs',"archive-capacity.js?v=140","archive-capacity.js?v=140")
# unchanged v1.40 URLs are still valid; only the app build marker changes.
change('tests/capacity.test.cjs',"'v1.40'","'v1.41'")
change('tests/resilience.test.cjs',"'v1.40'","'v1.41'",1)
print('Built Sentlog v1.41: authenticated photo redelivery from PC without overwrites')

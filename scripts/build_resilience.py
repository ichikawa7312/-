"""Guarded v1.40 integration: new-device restore, audit UI, chunk transfer.
Runs only after build_archive -> build_management -> build_capacity.
No user files are read/modified and no project is automatically deleted.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:
  raise RuntimeError(f'v1.40 integration mismatch: {path}: expected {count} for {old[:90]!r}, got {s.count(old)}')
 p.write_text(s.replace(old,new))

p='sentlog/archive.js'
change(p,"if(window.SentlogCapacity?.isCleared(cp.id))throw Error('この端末への復旧を終えてから使用中に戻してください。');",
         "if(window.SentlogCapacity?.isCleared(cp.id))throw Error('この端末への復旧を終えてから使用中に戻してください。');if(!getProject(cp.client_key))throw Error('この端末に案件がありません。PCから復旧してから使用中に戻してください。');")
change(p,"await rpc('reopen',cp.id);",
         "await net('rpc/sentlog_reopen_v2',{p_project_id:cp.id,p_device_id:device()});")
# Never suggest a legacy manual sync for a remotely archived project absent locally;
# only restore via a PC-verified immutable backup (capacity restore handles this).
change(p,"await manual(cp);}showDrawings(p.id)",
         "throw Error('この端末に案件がありません。保管フォルダの「PCからこの端末に復旧」を使ってください。');}showDrawings(p.id)")

p='sentlog/index.html'
change(p,"archive-capacity.js?v=138","archive-capacity.js?v=140",2)
change(p,"['archive-capacity.js?v=140','SentlogCapacity']",
         "['archive-capacity.js?v=140','SentlogCapacity'],['capacity-details.js?v=140','SentlogDetails']")
change(p,'<script src="./archive-capacity.js?v=140"><\\/script>',
         '<script src="./archive-capacity.js?v=140"><\\/script><script src="./capacity-details.js?v=140"><\\/script>')
change(p,"'v1.38'","'v1.40'")
change(p,'phone-runtime.js?v=138','phone-runtime.js?v=140',2)
p='sentlog/phone-runtime.js'
change(p,'v1.38','v1.40',4)
p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v151';","const CACHE='sentlog-pwa-v153';")
change(p,"'archive-capacity.js','record-store.js'","'archive-capacity.js','capacity-details.js','record-store.js'")

p='sentlog-pc/index.html'
change(p,'archive-restore-pc.js?v=138','archive-restore-pc.js?v=140')
change(p,'v1.38 · 復旧・容量整理対応','v1.40 · 容量整理・新端末復旧')

change('tests/full_management.py',"window.SENTLOG_BUILD==='v1.38'","window.SENTLOG_BUILD==='v1.40'")
change('tests/full_archive_click.py',"window.SENTLOG_BUILD==='v1.38'","window.SENTLOG_BUILD==='v1.40'")
change('tests/capacity_ui.py',"window.SENTLOG_BUILD==='v1.38'","window.SENTLOG_BUILD==='v1.40'")
change('tests/capacity.test.cjs',"archive-capacity.js?v=138","archive-capacity.js?v=140")
change('tests/capacity.test.cjs',"archive-restore-pc.js?v=138","archive-restore-pc.js?v=140")
change('tests/capacity.test.cjs',"'v1.38'","'v1.40'")
print('Built Sentlog v1.40: backup audit + fresh-device restore + multipart transfers + savings')

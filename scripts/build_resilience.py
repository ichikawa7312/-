"""Guarded v1.39 integration: new-device restore, audit UI, chunk transfer.
Runs only after build_archive -> build_management -> build_capacity.
No user files are read/modified and no project is automatically deleted.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:
  raise RuntimeError(f'v1.39 integration mismatch: {path}: expected {count} for {old[:90]!r}, got {s.count(old)}')
 p.write_text(s.replace(old,new))

p='sentlog/archive.js'
change(p,"await rpc('reopen',cp.id);",
         "await net('rpc/sentlog_reopen_v2',{p_project_id:cp.id,p_device_id:device()});")
# Never suggest a legacy manual sync for a remotely archived project absent locally;
# only restore via a PC-verified immutable backup (capacity restore handles this).
change(p,"await manual(cp);}showDrawings(p.id)",
         "throw Error('この端末に案件がありません。保管フォルダの「PCからこの端末に復旧」を使ってください。');}showDrawings(p.id)")
change(p,"'保管中・自動同期停止。この段階では閲覧のみです。'",
         "'保管中・自動同期停止。閲覧・復旧は保管フォルダで行います。'")
change(p,"'保管中は自動同期を停止します。この版では端末のデータは削除しません。'",
         "'保管中は自動同期を停止します。容量整理・復旧は保管済み案件だけ操作できます。'")

p='sentlog/index.html'
change(p,"archive-capacity.js?v=138","archive-capacity.js?v=139",2)
change(p,"['archive-capacity.js?v=139','SentlogCapacity']",
         "['archive-capacity.js?v=139','SentlogCapacity'],['capacity-details.js?v=139','SentlogDetails']")
change(p,'<script src="./archive-capacity.js?v=139"><\\/script>',
         '<script src="./archive-capacity.js?v=139"><\\/script><script src="./capacity-details.js?v=139"><\\/script>')
change(p,"'v1.38'","'v1.39'")
change(p,'phone-runtime.js?v=138','phone-runtime.js?v=139',2)
p='sentlog/phone-runtime.js'
change(p,'v1.38','v1.39',4)
p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v151';","const CACHE='sentlog-pwa-v152';")
change(p,"'archive-capacity.js','record-store.js'","'archive-capacity.js','capacity-details.js','record-store.js'")

p='sentlog-pc/index.html'
change(p,'archive-restore-pc.js?v=138','archive-restore-pc.js?v=139')
change(p,'v1.38 · 復旧・容量整理対応','v1.39 · 容量整理・新端末復旧')

change('tests/full_management.py',"window.SENTLOG_BUILD==='v1.38'","window.SENTLOG_BUILD==='v1.39'")
change('tests/full_archive_click.py',"window.SENTLOG_BUILD==='v1.38'","window.SENTLOG_BUILD==='v1.39'")
change('tests/capacity_ui.py',"window.SENTLOG_BUILD==='v1.38'","window.SENTLOG_BUILD==='v1.39'")
change('tests/capacity.test.cjs',"archive-capacity.js?v=138","archive-capacity.js?v=139")
change('tests/capacity.test.cjs',"archive-restore-pc.js?v=138","archive-restore-pc.js?v=139")
change('tests/capacity.test.cjs',"'v1.38'","'v1.39'")
print('Built Sentlog v1.39: backup audit + fresh-device restore + multipart transfers + savings')

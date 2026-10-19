"""v1.81 cache/version integration after the v1.80 pipeline."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def replace(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:raise RuntimeError(f'Page-count integration mismatch: {path}: {old}')
    p.write_text(s.replace(old,new))
replace('sentlog/index.html','sync-merge.js?v=180','sync-merge.js?v=181',2)
replace('sentlog/index.html','cloud-sync.js?v=20261019-merge-180','cloud-sync.js?v=20261019-pages-181',2)
replace('sentlog/index.html','phone-runtime.js?v=180','phone-runtime.js?v=181',2)
replace('sentlog/index.html',"['sync-merge.js?v=181','SentlogSyncMerge']","['sync-merge.js?v=181','verifiedPdfPageCounts']")
replace('sentlog/index.html',"['cloud-sync.js?v=20261019-pages-181','mergeSelectedProject']","['cloud-sync.js?v=20261019-pages-181','verifiedPdfPageCounts']")
replace('sentlog/index.html',"['phone-runtime.js?v=181','v1.80']","['phone-runtime.js?v=181','v1.81']")
replace('sentlog/phone-runtime.js','v1.80','v1.81',4)
replace('sentlog/sw.js','sentlog-pwa-v191','sentlog-pwa-v192')
for p in (ROOT/'tests').iterdir():
    if p.suffix not in ('.py','.cjs'):continue
    s=p.read_text();updated=s.replace("SENTLOG_BUILD==='v1.80'","SENTLOG_BUILD==='v1.81'").replace("'v1.80'","'v1.81'").replace('sentlog-pwa-v191','sentlog-pwa-v192')
    updated=updated.replace(r'phone-runtime\.js\?v=180',r'phone-runtime\.js\?v=181').replace('phone-runtime.js?v=180','phone-runtime.js?v=181').replace('20261019-merge-180','20261019-pages-181')
    if updated!=s:p.write_text(updated)
print('Built Sentlog v1.81: reconcile PDF page counts only after original-byte verification and PDF.js parsing')

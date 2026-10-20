"""v1.87: relay matching local photos to active peers without a company PC."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def replace(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:raise RuntimeError(f'Peer photo integration mismatch: {path}: {old[:80]}')
    p.write_text(s.replace(old,new))
replace('sentlog/index.html',"['photo-recovery.js?v=186','sentlogCheckPhotoRecovery']", "['photo-recovery.js?v=187','sentlogCheckPhotoRecovery'],['peer-photo-recovery.js?v=187','sentlogCheckPeerPhotos']")
replace('sentlog/index.html','src="./photo-recovery.js?v=186"','src="./peer-photo-recovery.js?v=187"><\\/script><script type="module" src="./photo-recovery.js?v=187"')
replace('sentlog/index.html','phone-runtime.js?v=186','phone-runtime.js?v=187',2)
replace('sentlog/index.html',"['phone-runtime.js?v=187','v1.86']","['phone-runtime.js?v=187','v1.87']")
replace('sentlog/phone-runtime.js','v1.86','v1.87',4)
replace('sentlog/photo-recovery.js',"'写真 '+waiting+' 件を会社PCから再取得待ち。PC自動同期画面を開き、保存先の許可を確認してください。（確認済み '","'写真 '+waiting+' 件を再取得待ち。写真が残っている端末でセントログを開いてください。会社PCからも再取得できます。（確認済み '")
replace('sentlog/sw.js',"'photo-recovery.js'","'photo-recovery.js','peer-photo-recovery.js'")
replace('sentlog/sw.js','sentlog-pwa-v197','sentlog-pwa-v198')
for p in (ROOT/'tests').iterdir():
    if p.suffix not in ('.py','.cjs'):continue
    s=p.read_text();u=s.replace("'v1.86'","'v1.87'").replace('phone-runtime.js?v=186','phone-runtime.js?v=187').replace(r'phone-runtime\.js\?v=186',r'phone-runtime\.js\?v=187').replace('sentlog-pwa-v197','sentlog-pwa-v198')
    if u!=s:p.write_text(u)
print('Built v1.87: verified local-photo relay, with existing records and PC recovery preserved')

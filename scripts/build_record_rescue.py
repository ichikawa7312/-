"""Sentlog v1.94: emergency record-only backup for iPhone/PWA rescue.

Runs after v1.93. It adds a local-only share/export module; no cloud/database writes.
"""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

def change(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:
        raise RuntimeError(f'Record-rescue integration mismatch: {path}: {old[:100]!r}: {s.count(old)}')
    p.write_text(s.replace(old,new))

p='sentlog/index.html'
change(p,
       "['page-management.js?v=193','SentlogPageManagement v1.93']",
       "['page-management.js?v=193','SentlogPageManagement v1.93'],['record-rescue.js?v=194','SentlogRecordRescue']")
change(p,
       '<script src="./page-management.js?v=193"><\\/script>',
       '<script src="./page-management.js?v=193"><\\/script><script src="./record-rescue.js?v=194"><\\/script>')
change(p,'phone-runtime.js?v=193','phone-runtime.js?v=194',2)
change(p,"['phone-runtime.js?v=194','v1.93']","['phone-runtime.js?v=194','v1.94']")
change('sentlog/phone-runtime.js','v1.93','v1.94',4)
change('sentlog-pc/index.html','v1.93','v1.94',1)
change('sentlog/sw.js','sentlog-pwa-v204','sentlog-pwa-v205')
change('sentlog/sw.js',"'page-management.js'","'page-management.js','record-rescue.js'")

for f in (ROOT/'tests').iterdir():
    if f.suffix not in ('.py','.cjs'):continue
    s=f.read_text()
    u=s.replace('v1.93','v1.94').replace('phone-runtime.js?v=193','phone-runtime.js?v=194').replace(r'phone-runtime\.js\?v=193',r'phone-runtime\.js\?v=194').replace('sentlog-pwa-v204','sentlog-pwa-v205')
    if u!=s:f.write_text(u)

subprocess.run(['node','--check','sentlog/record-rescue.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/record_rescue.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v1.94: local-only emergency record backup via iOS share sheet')

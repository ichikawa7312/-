"""Sentlog v2.01: move emergency rescue from project body into the header."""
from pathlib import Path
import re, subprocess

ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'sentlog/index.html';s=p.read_text()
s,n=re.subn(r'record-rescue\.js\?v=195','record-rescue.js?v=201',s)
if n!=2: raise RuntimeError('rescue loader count mismatch: '+str(n))
p.write_text(s)

sw=ROOT/'sentlog/sw.js';w=sw.read_text()
m=re.search(r'sentlog-pwa-v(\d+)',w)
if not m: raise RuntimeError('SW cache version missing')
old=m.group(0);new='sentlog-pwa-v'+str(int(m.group(1))+1)
w=w.replace(old,new);sw.write_text(w)
for t in (ROOT/'tests').iterdir():
    if t.suffix not in ('.cjs','.py') or t.name=='rescue_header.test.cjs':continue
    x=t.read_text();y=x.replace(old,new)
    if y!=x:t.write_text(y)

subprocess.run(['node','--check','sentlog/record-rescue.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/rescue_header.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v2.01: emergency rescue is a compact project-list header action')

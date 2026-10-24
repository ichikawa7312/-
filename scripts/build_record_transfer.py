"""Sentlog v1.99: copy/move selected records across drawings/pages without losing photos."""
from pathlib import Path
import re, subprocess

ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'sentlog/index.html';s=p.read_text()
if 'record-transfer.js?v=199' not in s:
    dep="['page-replacement.js?v=198','SentlogPageReplacement v1.98']"
    if s.count(dep)!=1: raise RuntimeError('record transfer dependency marker mismatch: '+str(s.count(dep)))
    s=s.replace(dep,dep+",['record-transfer.js?v=199','SentlogRecordTransfer v1.99']")
    tag='<script src="./page-replacement.js?v=198"><\\/script>'
    if s.count(tag)!=1: raise RuntimeError('record transfer script marker mismatch: '+str(s.count(tag)))
    s=s.replace(tag,tag+'<script src="./record-transfer.js?v=199"><\\/script>')
p.write_text(s)

sw=ROOT/'sentlog/sw.js';w=sw.read_text()
if "'record-transfer.js'" not in w:
    marker="'page-replacement.js'"
    if marker not in w: raise RuntimeError('record transfer SW marker missing')
    w=w.replace(marker,marker+",'record-transfer.js'",1)
m=re.search(r'sentlog-pwa-v(\d+)',w)
if not m: raise RuntimeError('SW cache version missing')
old=m.group(0);new='sentlog-pwa-v'+str(int(m.group(1))+1);w=w.replace(old,new);sw.write_text(w)
for t in (ROOT/'tests').iterdir():
    if t.suffix not in ('.cjs','.py'):continue
    x=t.read_text();y=x.replace(old,new)
    if y!=x:t.write_text(y)
subprocess.run(['node','--check','sentlog/record-transfer.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/record_transfer.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v1.99: safe multi-record copy/move across drawings/pages')

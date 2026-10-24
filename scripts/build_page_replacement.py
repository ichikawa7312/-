"""Sentlog v1.98: safe single-page PDF replacement with record preservation."""
from pathlib import Path
import re, subprocess

ROOT=Path(__file__).resolve().parents[1]

p=ROOT/'sentlog/index.html'
s=p.read_text()
if 'page-replacement.js?v=198' not in s:
    needle="['page-management.js?v=193','SentlogPageManagement v1.93']"
    if s.count(needle)!=1:
        raise RuntimeError('page replacement dependency marker mismatch: '+str(s.count(needle)))
    s=s.replace(needle,needle+",['page-replacement.js?v=198','SentlogPageReplacement v1.98']")
    script='<script src="./page-management.js?v=193"><\\/script>'
    if s.count(script)!=1:
        raise RuntimeError('page replacement script marker mismatch: '+str(s.count(script)))
    s=s.replace(script,script+'<script src="./page-replacement.js?v=198"><\\/script>')
p.write_text(s)

sw=ROOT/'sentlog/sw.js'
w=sw.read_text()
if "'page-replacement.js'" not in w:
    marker="'page-management.js'"
    if marker not in w: raise RuntimeError('service worker page manager marker missing')
    w=w.replace(marker,marker+",'page-replacement.js'",1)
m=re.search(r'sentlog-pwa-v(\d+)',w)
if not m: raise RuntimeError('service worker cache version missing')
old=m.group(0);new='sentlog-pwa-v'+str(int(m.group(1))+1)
w=w.replace(old,new)
sw.write_text(w)

# Existing tests may pin the final service-worker cache version. Move those
# expectations forward only after all previous build stages have completed.
for t in (ROOT/'tests').iterdir():
    if t.suffix not in ('.cjs','.py'): continue
    x=t.read_text()
    y=x.replace(old,new)
    if y!=x:t.write_text(y)

subprocess.run(['node','--check','sentlog/page-replacement.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/page_replacement.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog v1.98: replace one PDF page only; all records/photos/comments retained')

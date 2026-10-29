"""Add read-only photo ledger after v2.03, without modifying records or sync code."""
from pathlib import Path
import re
ROOT=Path(__file__).resolve().parents[1]
index=ROOT/'sentlog/index.html'
s=index.read_text(encoding='utf-8')
if "photo-ledger.js?v=206" not in s:
    # Load as an optional enhancement: a missing photo-ledger asset must never
    # prevent the existing drawing/editor/sync screens from starting.
    anchor='document.open();document.write(html);document.close()'
    assert s.count(anchor)==1, 'photo ledger: document anchor missing'
    s=s.replace(anchor,"html=html.replace('</body>','<script src=\"./photo-ledger.js?v=206\"><\\/script></body>');"+anchor,1)
    index.write_text(s,encoding='utf-8')
sw=ROOT/'sentlog/sw.js'
w=sw.read_text(encoding='utf-8')
if "'photo-ledger.js'" not in w:
    anchor='const FILES=['
    assert w.count(anchor)==1, 'photo ledger: SW asset anchor missing'
    w=w.replace(anchor,"const FILES=['photo-ledger.js',",1)
    old=re.search(r'sentlog-pwa-v\d+',w)
    assert old, 'photo ledger: SW version missing'
    old=old.group(0)
    new='sentlog-pwa-v'+str(int(old.rsplit('v',1)[-1])+1)
    w=w.replace(old,new)
    sw.write_text(w,encoding='utf-8')
    for t in (ROOT/'tests').iterdir():
        if t.suffix not in ('.cjs','.py'):continue
        x=t.read_text(encoding='utf-8')
        if old in x:t.write_text(x.replace(old,new),encoding='utf-8')
print('Photo ledger feature integrated: Excel A4 portrait 3 photos/page, grouped across all PDFs')
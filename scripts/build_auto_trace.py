"""Integrate automatic chalk tracing after all existing Sentlog build steps.

No database migration: results use the existing manual freehand damage shapes.
"""
from pathlib import Path
import re
import subprocess
ROOT=Path(__file__).resolve().parents[1]
for asset in ('auto-trace-core.js','auto-trace.js'):
    if not (ROOT/'sentlog'/asset).is_file():raise RuntimeError('Missing auto-trace asset: '+asset)
file=ROOT/'sentlog/index.html'
html=file.read_text(encoding='utf-8')
anchor='document.open();document.write(html);document.close()'
if html.count(anchor)!=1 or 'auto-trace-core.js' in html:raise RuntimeError('Dynamic bootstrap has changed')
loader="""html=html.replace('</body>','<script src="./auto-trace-core.js?v=221"></'+'script><script src="./auto-trace.js?v=221"></'+'script></body>');"""
file.write_text(html.replace(anchor,loader+anchor,1),encoding='utf-8')
file=ROOT/'sentlog/sw.js'
worker=file.read_text(encoding='utf-8')
anchor="'index.html'"
if worker.count(anchor)!=1 or "'auto-trace-core.js'" in worker:raise RuntimeError('PWA asset list has changed')
worker=worker.replace(anchor,anchor+",'auto-trace-core.js','auto-trace.js'",1)
match=re.search(r'sentlog-pwa-v(\d+)',worker)
if not match:raise RuntimeError('PWA cache version not found')
old=match.group(0)
new='sentlog-pwa-v'+str(int(match.group(1))+1)
file.write_text(worker.replace(old,new),encoding='utf-8')
for file in (ROOT/'tests').iterdir():
    if file.name=='auto_trace.test.cjs' or file.suffix not in ('.cjs','.py'):continue
    content=file.read_text(encoding='utf-8')
    if old in content:file.write_text(content.replace(old,new),encoding='utf-8')
subprocess.run(['node','--check','sentlog/auto-trace-core.js'],cwd=ROOT,check=True)
subprocess.run(['node','--check','sentlog/auto-trace.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/auto_trace.test.cjs'],cwd=ROOT,check=True)
print('Built offline auto-trace: stronger chalk recognition, collapsed candidates and adjustable sensitivity/ROI')

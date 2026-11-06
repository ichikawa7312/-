"""Finish integration of DXF solid-hatch transparency after existing build steps.

No migration or editing of DXF/PDF/photo/record data. Only asset version and
offline cache change, to force the patched engine onto iPad/iPhone/PC.
"""
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]
html_file=ROOT/'sentlog/index.html'
html=html_file.read_text(encoding='utf-8')
old='dxf.js?v=205'
if html.count(old)!=2:raise RuntimeError('DXF loader versions changed; expected two references')
html=html.replace(old,'dxf.js?v=210')
html_file.write_text(html,encoding='utf-8')

sw_file=ROOT/'sentlog/sw.js'
worker=sw_file.read_text(encoding='utf-8')
if "'vendor/dxf-engine.js'" not in worker:
 raise RuntimeError('Patched DXF viewer is absent from the offline cache list')
match=re.search(r'sentlog-pwa-v(\d+)',worker)
if not match:raise RuntimeError('DXF offline cache revision missing')
old_cache=match.group(0)
new_cache='sentlog-pwa-v'+str(int(match.group(1))+1)
sw_file.write_text(worker.replace(old_cache,new_cache),encoding='utf-8')

for test in (ROOT/'tests').iterdir():
 if test.suffix not in ('.py','.cjs'):continue
 text=test.read_text(encoding='utf-8')
 changed=(text.replace(old,'dxf.js?v=210')
               .replace(r'dxf\.js\?v=205',r'dxf\.js\?v=210')
               .replace(old_cache,new_cache))
 if changed!=text:test.write_text(changed,encoding='utf-8')
subprocess.run(['node','--check','sentlog/dxf.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/dxf_hatch_transparency.test.cjs'],cwd=ROOT,check=True)
print('DXF display: solid-fill transparency slider; per-device preference and PDF background preview; engine v210')

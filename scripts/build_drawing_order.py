"""Integrate guarded drawing number/sheet reordering after existing release builders.

This changes only shared drawing order metadata and UI code, with no database
migration, deletion or modification to original PDFs, TIFFs, photos or records.
"""
from pathlib import Path
import re,subprocess
ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'sentlog/index.html'
html=p.read_text(encoding='utf-8')
match=re.findall(r'drawing-groups\.js\?v=([0-9A-Za-z._-]+)',html)
if len(match)!=2 or len(set(match))!=1:
    raise RuntimeError('Drawing group bootstrap version mismatch: '+str(match))
version=match[0]
preflight=f"['drawing-groups.js?v={version}','SentlogDrawingGroups']"
if html.count(preflight)!=1:
    raise RuntimeError('Drawing group preflight changed')
html=html.replace(preflight,preflight+",['drawing-order.js?v=208','SentlogDrawingOrder']",1)
# The new module must run after all drawing view/recovery wrappers.
# It is appended to the generated page immediately before the closing body.
end='document.open();document.write(html);document.close()'
if html.count(end)!=1:
    raise RuntimeError('Sentlog dynamic document boot anchor changed')
html=html.replace(end,
    """html=html.replace('</body>','<script src="./drawing-order.js?v=208"></'+'script></body>');"""+end,1)
p.write_text(html,encoding='utf-8')
sw=ROOT/'sentlog/sw.js'
content=sw.read_text(encoding='utf-8')
anchor="'drawing-groups.js'"
if content.count(anchor)!=1:raise RuntimeError('PWA drawing group resource changed')
content=content.replace(anchor,anchor+",'drawing-order.js'",1)
m=re.search(r'sentlog-pwa-v(\d+)',content)
if not m:raise RuntimeError('Service worker cache key missing')
old=m.group(0);new='sentlog-pwa-v'+str(int(m.group(1))+1)
sw.write_text(content.replace(old,new),encoding='utf-8')
# Keep legacy test expectations aligned to the new static resource cache.
for file in (ROOT/'tests').iterdir():
    if file.suffix not in ('.py','.cjs'):continue
    source=file.read_text(encoding='utf-8')
    if old in source:file.write_text(source.replace(old,new),encoding='utf-8')

subprocess.run(['node','--check','sentlog/drawing-order.js'],cwd=ROOT,check=True)
subprocess.run(['node','tests/drawing_order.test.cjs'],cwd=ROOT,check=True)
print('Built Sentlog: persistent drawing No. and sheet ordering; drag, touch, numeric sort and safe atomic save')

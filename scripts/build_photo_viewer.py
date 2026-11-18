"""Install the bounded photo viewer after the guarded production builders.

Only application resources and their offline cache revision change. Photo blobs,
record schemas, drawing coordinates and all synchronization code are unchanged.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ASSET = 'photo-viewer.js'
TOKEN = '20261118'
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Photo viewer integration changed: {path}: {old[:90]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


subprocess.run(['node', '--check', 'sentlog/' + ASSET], cwd=ROOT, check=True)
change('sentlog/index.html', 'const deps=[',
       "const deps=[['photo-viewer.js?v=" + TOKEN + "','photoViewerVersion'],")
anchor = 'document.open();document.write(html);document.close()'
loader = "html=html.replace('</body>','<script src=\"./photo-viewer.js?v=" + TOKEN + "\"></'+'script></body>');"
change('sentlog/index.html', anchor, loader + anchor)
change('sentlog/sw.js', "'index.html'", "'index.html','photo-viewer.js'")
worker = pending['sentlog/sw.js']
match = re.search(r'sentlog-pwa-v(\d+)', worker)
if not match:
    raise RuntimeError('Photo viewer offline cache revision missing')
old = match.group(0)
new = 'sentlog-pwa-v' + str(int(match.group(1)) + 1)
pending['sentlog/sw.js'] = worker.replace(old, new)

# Existing release assertions follow the final cache revision, as in the other
# builders. Their behavioral checks remain intact.
for file in (ROOT / 'tests').iterdir():
    if file.suffix not in ('.cjs', '.py'):
        continue
    content = file.read_text(encoding='utf-8')
    if old in content:
        pending[str(file.relative_to(ROOT))] = content.replace(old, new)

for path, content in pending.items():
    (ROOT / path).write_text(content, encoding='utf-8')
print('Built photo-only pinch/pan: bounded viewport, stable finger release, read-only photos and drawing state')

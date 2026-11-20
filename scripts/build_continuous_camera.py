"""Install continuous capture after the collaborative production builders.

Only static application resources and their cache revision change. Photo saves
continue through the existing durable, fixed-destination collaboration service.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ASSET = 'continuous-camera.js'
TOKEN = '20261121-camera-orientation'
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Continuous camera integration changed: {path}: {old[:100]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


index = (ROOT / 'sentlog/index.html').read_text(encoding='utf-8')
if ASSET in index:
    raise RuntimeError('Continuous camera is already built; use a pristine production build')
if not all(name in index for name in ('collaboration-photos.js', 'collaboration-editor.js')):
    raise RuntimeError('Build continuous capture after collaboration photos and editor')

subprocess.run(['node', '--check', 'sentlog/' + ASSET], cwd=ROOT, check=True)
# Older photo/editor services must not satisfy bootstrap after an interrupted
# update. Both references use the release token and check the required new API.
revisions = []
for asset, previous_marker, required_api in (
    ('collaboration-photos.js', 'SentlogCollaborationPhotos', 'prepareCapture'),
    ('collaboration-editor.js', 'SentlogCollaboration', 'requestPhotoRemoval'),
):
    subprocess.run(['node', '--check', 'sentlog/' + asset], cwd=ROOT, check=True)
    if required_api not in (ROOT / 'sentlog' / asset).read_text(encoding='utf-8'):
        raise RuntimeError('Continuous capture requires ' + asset + ': ' + required_api)
    versions = re.findall(re.escape(asset) + r'\?v=([A-Za-z0-9_-]+)', index)
    if len(versions) != 2 or len(set(versions)) != 1:
        raise RuntimeError('Collaboration loader references changed: ' + asset)
    previous_token = versions[0]
    revisions.append((asset, previous_token))
    change('sentlog/index.html', asset + '?v=' + previous_token, asset + '?v=' + TOKEN, 2)
    change('sentlog/index.html',
           "['" + asset + "?v=" + TOKEN + "','" + previous_marker + "']",
           "['" + asset + "?v=" + TOKEN + "','" + required_api + "']")
change('sentlog/index.html', 'const deps=[',
       "const deps=[['" + ASSET + "?v=" + TOKEN + "','prefersVideoFrame'],")

# Earlier final-pass builders append their scripts by replacing </body> before
# document.write. Appending this replacement last keeps the camera after both
# the photo service and the collaboration editor without wrapping sync methods.
anchor = 'document.open();document.write(html);document.close()'
loader = "html=html.replace('</body>','<script src=\"./" + ASSET + "?v=" + TOKEN + "\"></'+'script></body>');"
change('sentlog/index.html', anchor, loader + anchor)
change('sentlog/sw.js', "'index.html'", "'index.html','" + ASSET + "'")
worker = pending['sentlog/sw.js']
match = re.search(r'sentlog-pwa-v(\d+)', worker)
if not match:
    raise RuntimeError('Continuous camera offline cache revision missing')
old_cache = match.group(0)
# Advance beyond the already published camera generation so installed PWAs
# refresh the camera implementation as part of the complete static resource set.
new_cache = 'sentlog-pwa-v' + str(int(match.group(1)) + 2)
pending['sentlog/sw.js'] = worker.replace(old_cache, new_cache)

# Existing release assertions follow the final generated cache/resource names.
# Their behavioral checks and all stored data formats remain unchanged.
for file in (ROOT / 'tests').iterdir():
    if file.suffix not in ('.cjs', '.py'):
        continue
    source = file.read_text(encoding='utf-8')
    revised = source.replace(old_cache, new_cache)
    for asset, previous_token in revisions:
        revised = revised.replace(asset + '?v=' + previous_token, asset + '?v=' + TOKEN)
        pattern_name = asset.replace('.', r'\.')
        revised = revised.replace(pattern_name + r'\?v=' + previous_token,
                                  pattern_name + r'\?v=' + TOKEN)
    if revised != source:
        pending[str(file.relative_to(ROOT))] = revised

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built continuous camera with per-photo durable saves, optional review and offline resources')

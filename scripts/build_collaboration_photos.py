"""Last-stage safe photo capture integration; existing photo/original keys remain compatible."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261118-collaboration-photos'
index = (ROOT / 'sentlog/index.html').read_text(encoding='utf-8')
worker = (ROOT / 'sentlog/sw.js').read_text(encoding='utf-8')
if 'collaboration-photos.js' in index:
    raise RuntimeError('Safe photo capture is already built; use a pristine production build')

# The model may be inserted by the final collaboration builder. Load after
# both it and the original store, while retaining sync-view's wrapper order.
original = re.findall(r'original-photo-store\.js\?v=[A-Za-z0-9_-]+', index)
if len(original) != 2 or len(set(original)) != 1:
    raise RuntimeError('Original photo bootstrap/dependency references changed')
index = index.replace(original[0], 'original-photo-store.js?v=' + TOKEN)
expected = r'/original-photo-store\.js\?v=' + original[0].split('?v=', 1)[1] + '/'
original_test = ROOT / 'tests/original_photo_store.test.cjs'
if original_test.read_text(encoding='utf-8').count(expected) != 1:
    raise RuntimeError('Original photo version assertion changed')
test_updates = {}
for test_path in (ROOT / 'tests').glob('*.test.cjs'):
    test = test_path.read_text(encoding='utf-8')
    if expected in test:
        test_updates[test_path] = test.replace(expected, r'/original-photo-store\.js\?v=' + TOKEN + '/')
if index.count('const deps=[') != 1:
    raise RuntimeError('Photo dependency bootstrap changed')
index = index.replace('const deps=[', "const deps=[['collaboration-photos.js?v=" + TOKEN + "','SentlogCollaborationPhotos'],")

scripts = list(re.finditer(r'<script src="\./([^"?]+)\?[^"<>]+"><\\/script>', index))
by_name = {match.group(1): match for match in scripts}
if 'original-photo-store.js' not in by_name or 'sync-view.js' not in by_name:
    raise RuntimeError('Expected original-photo/sync-view script order is missing')
anchor = by_name['original-photo-store.js']
if 'record-collaboration.js' in by_name:
    anchor = max(anchor, by_name['record-collaboration.js'], key=lambda match: match.end())
if anchor.end() > by_name['sync-view.js'].start():
    raise RuntimeError('Load the photo dependencies before sync-view')
index = index[:anchor.end()] + '<script src="./collaboration-photos.js?v=' + TOKEN + '"><\\/script>' + index[anchor.end():]
if worker.count("'original-photo-store.js'") != 1:
    raise RuntimeError('Original photo offline entry changed')
worker = worker.replace("'original-photo-store.js'", "'original-photo-store.js','collaboration-photos.js'")

for name in ('original-photo-store.js', 'collaboration-photos.js'):
    subprocess.run(['node', '--check', str(ROOT / 'sentlog' / name)], check=True)
(ROOT / 'sentlog/index.html').write_text(index, encoding='utf-8')
(ROOT / 'sentlog/sw.js').write_text(worker, encoding='utf-8')
for test_path, test in test_updates.items():
    test_path.write_text(test, encoding='utf-8')
print('Built fixed capture targets, durable pending originals and current-record photo append; release builder owns the cache revision')

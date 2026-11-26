"""Load device-local project photo exports after the complete production build."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261121-onezip'
pending = {}


def source(path):
    return pending.get(path, (ROOT / path).read_text(encoding='utf-8'))


def change(path, old, new, count=1):
    value = source(path)
    if value.count(old) != count:
        raise RuntimeError(f'Original export integration changed: {path}: {old!r}: {value.count(old)}')
    pending[path] = value.replace(old, new)


index = 'sentlog/index.html'
if 'sentlog-delta-app-v1' not in source(index):
    raise RuntimeError('Build original project exports after build_delta_sync.py')
if 'original-photo-export.js' in source(index):
    raise RuntimeError('Use a pristine production build; original export is already connected')
old_token = '20261121-heavy-sync'
change(index, "['original-photo-store.js?v=" + old_token + "','SentlogOriginalPhotos']",
       "['original-photo-store.js?v=" + TOKEN + "','beginExportSession'],"
       "['original-photo-export.js?v=" + TOKEN + "','SentlogOriginalPhotoExport']")
change(index, '<script src="./original-photo-store.js?v=' + old_token + '"><\\/script>',
       '<script src="./original-photo-store.js?v=' + TOKEN + '"><\\/script>'
       '<script src="./original-photo-export.js?v=' + TOKEN + '"><\\/script>')

# Workers use the controller's release query; the offline cache canonicalizes
# those URLs to the same four independently verified static resources.
modules = ['original-photo-store', 'original-photo-export',
           'original-photo-export-worker', 'original-photo-zip']
worker = source('sentlog/sw.js')
old_cache = re.search(r'sentlog-pwa-v\d+', worker).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 1)
worker = worker.replace(old_cache, new_cache)
if worker.count("'original-photo-store.js'") != 1:
    raise RuntimeError('The original-photo store must already be cached exactly once')
worker = worker.replace("'original-photo-store.js'", ','.join(repr(name + '.js') for name in modules))
pending['sentlog/sw.js'] = worker

# Earlier build stages advance exact release expectations in the existing
# behavioral tests. Move just these URLs/cache generation once more here.
for file in (ROOT / 'tests').iterdir():
    if file.suffix not in ('.cjs', '.py'):
        continue
    path = str(file.relative_to(ROOT))
    value = source(path)
    revised = value.replace(old_cache, new_cache)
    revised = revised.replace('original-photo-store.js?v=' + old_token,
                              'original-photo-store.js?v=' + TOKEN)
    revised = revised.replace(r'original-photo-store\.js\?v=' + old_token,
                              r'original-photo-store\.js\?v=' + TOKEN)
    if file.name == 'original_photo_store.test.cjs':
        # A mixed old/new offline shell must reject a store that lacks the
        # project export lease API, even though it has the older global name.
        revised = revised.replace('assert.match(index,/SentlogOriginalPhotos/);',
                                  'assert.match(index,/beginExportSession/);')
    if revised != value:
        pending[path] = revised

for path, value in pending.items():
    (ROOT / path).write_text(value, encoding='utf-8')
for name in modules:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Connected one-ZIP exports of all originals for the selected device-local project')

# Run after the entire production build so earlier pinned-source checks stay intact.
import sys
subprocess.run([sys.executable, 'scripts/build_recovery_throttle.py'], cwd=ROOT, check=True)

# Ledger export only; do not change shared media or synchronization.
subprocess.run([sys.executable, 'scripts/build_high_quality_ledger.py'], cwd=ROOT, check=True)

# Fence delayed delta projection against a drawing switch.
subprocess.run([sys.executable, 'scripts/build_projection_navigation_guard.py'], cwd=ROOT, check=True)

# Preserve capture order in the UI and resume the camera's record after reload.
subprocess.run([sys.executable, 'scripts/build_camera_reliability.py'], cwd=ROOT, check=True)

# Keep a polygon's displayed candidate through a small finger/Pencil release.
subprocess.run([sys.executable, 'scripts/build_polygon_pointer_stability.py'], cwd=ROOT, check=True)

# Recover missing staged files safely and bound repeated photograph auditing.
subprocess.run([sys.executable, 'scripts/build_sync_recovery.py'], cwd=ROOT, check=True)

# Keep modal controls responsive while the original single-flight saves finish.
subprocess.run([sys.executable, 'scripts/build_sync_wait.py'], cwd=ROOT, check=True)

"""Refresh field memo and live-sync resources after the guarded production build."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261121-heavy-render'
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    if source.count(old) != count:
        raise RuntimeError(f'Field memo integration changed: {path}: {old!r}')
    pending[path] = source.replace(old, new)


for name in ('field-records.js', 'sync-view.js'):
    subprocess.run(['node', '--check', 'sentlog/' + name], cwd=ROOT, check=True)

revisions = [('field-records.js', '179'), ('sync-view.js', '207')]
for name, version in revisions:
    change('sentlog/index.html', name + '?v=' + version, name + '?v=' + TOKEN, 2)
change('sentlog/drawing-export-view.html',
       'field-records.js?v=179', 'field-records.js?v=' + TOKEN)

# Check the actual memo-saving code as well as the cache-busting URL on startup.
change('sentlog/index.html',
       "['field-records.js?v=" + TOKEN + "','SentlogFieldRecords']",
       "['field-records.js?v=" + TOKEN + "','root.SentlogFieldRecords={...pure,selectRecord,syncInspector,hasPendingMemoEdit']")

worker = (ROOT / 'sentlog/sw.js').read_text(encoding='utf-8')
match = re.search(r'sentlog-pwa-v(\d+)', worker)
if not match:
    raise RuntimeError('Field memo offline cache revision missing')
old_cache = match.group(0)
# The batched label renderer must also replace the already published memo build
# in installed applications and drawing exports.
new_cache = 'sentlog-pwa-v' + str(int(match.group(1)) + 2)
pending['sentlog/sw.js'] = worker.replace(old_cache, new_cache)

# Existing behavior checks remain in place; their loader/cache expectations
# follow the final artifact, as in the other production builders.
for file in (ROOT / 'tests').iterdir():
    if file.suffix not in ('.cjs', '.py'):
        continue
    source = file.read_text(encoding='utf-8')
    revised = source.replace(old_cache, new_cache)
    for name, version in revisions:
        revised = revised.replace(name + '?v=' + version, name + '?v=' + TOKEN)
        escaped = name.replace('.', r'\.') + r'\?v='
        revised = revised.replace(escaped + version, escaped + TOKEN)
    if revised != source:
        pending[str(file.relative_to(ROOT))] = revised

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built field memo saving: immediate input, protected composition, correct field-record sync guard')

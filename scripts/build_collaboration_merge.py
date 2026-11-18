"""Load immutable record collaboration before the snapshot merger.

Run after build_edit_sync.py. This only integrates static code; no records,
database data, authentication state, or stored assets are changed by this build.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261118-collaboration'
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    if source.count(old) != count:
        raise RuntimeError(f'Collaboration merge integration changed: {path}: {old[:100]!r}: {source.count(old)}')
    pending[path] = source.replace(old, new)


change('sentlog/index.html', 'const deps=[',
       "const deps=[['record-collaboration.js?v=" + TOKEN + "','SentlogRecordCollaboration'],")
references = re.findall(r'sync-merge\.js\?v=[A-Za-z0-9_-]+', pending['sentlog/index.html'])
if len(references) != 2 or len(set(references)) != 1:
    raise RuntimeError('Expected one matching merge dependency and script reference')
change('sentlog/index.html', '<script src="./' + references[0] + '">',
       '<script src="./record-collaboration.js?v=' + TOKEN + '"><\\/script><script src="./' + references[0] + '">')
change('sentlog/index.html', references[0], 'sync-merge.js?v=' + TOKEN, 2)
change('sentlog/index.html', "['sync-merge.js?v=" + TOKEN + "','recordChoiceKey']",
       "['sync-merge.js?v=" + TOKEN + "','collabDeletedRecords']")
change('sentlog/sw.js', "'sync-merge.js'", "'record-collaboration.js','sync-merge.js'")

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
for file in ('record-collaboration.js', 'sync-merge.js'):
    subprocess.run(['node', '--check', 'sentlog/' + file], cwd=ROOT, check=True)
print('Built immutable collaborative record merge, retained alternatives and complete deletion history')

"""Version the optional ledger modules after build_photo_ledger.py.

The reviewed JavaScript files are used directly; no source records or Excel
templates are transformed. The main collaboration build owns the PWA cache
revision, so this stage only updates the two optional script URLs.
"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261118-collaboration-ledger'
modules = (
    ('photo-ledger.js', '216', 'COMMENT_DRAFT_VERSION=2'),
    ('photo-ledger-visual3.js', '221', 'MAX_FIELD_LENGTH=300'),
)
index = ROOT / 'sentlog/index.html'
html = index.read_text(encoding='utf-8')
for name, old_version, marker in modules:
    source = (ROOT / 'sentlog' / name).read_text(encoding='utf-8')
    if marker not in source:
        raise RuntimeError(f'Collaboration ledger module is missing: {name}')
    previous = name + '?v=' + old_version
    revised = name + '?v=' + TOKEN
    if html.count(revised) == 1 and previous not in html:
        continue
    if html.count(previous) != 1 or revised in html:
        raise RuntimeError(f'Collaboration ledger loader anchor changed: {name}')
    html = html.replace(previous, revised)
for name, _, _ in modules:
    subprocess.run(['node', '--check', str(ROOT / 'sentlog' / name)], check=True)
index.write_text(html, encoding='utf-8')
print('Built source-aware ledger drafts and explicit visual-three-up text validation')

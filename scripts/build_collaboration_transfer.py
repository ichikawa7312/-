"""Finalize record transfer against immutable collaboration history.

Run after build_collaboration_editor.py. Data and stored photo files are never
rewritten by this static build integration.
"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261118-collaboration'
p = ROOT / 'sentlog/index.html'
source = p.read_text(encoding='utf-8')
old = 'record-transfer.js?v=199'
if source.count(old) != 2:
    raise RuntimeError('Collaborative transfer loader marker changed')
source = source.replace(old, 'record-transfer.js?v=' + TOKEN)
old_marker = "['record-transfer.js?v=" + TOKEN + "','SentlogRecordTransfer v1.99']"
if source.count(old_marker) != 1:
    raise RuntimeError('Collaborative transfer dependency marker changed')
source = source.replace(old_marker, "['record-transfer.js?v=" + TOKEN + "','TRANSFER_CHANGED']")
p.write_text(source, encoding='utf-8')
test = ROOT / 'tests/record_transfer.test.cjs'
original = test.read_text(encoding='utf-8')
test.write_text(original.replace(r'record-transfer\.js\?v=199', r'record-transfer\.js\?v=' + TOKEN), encoding='utf-8')
subprocess.run(['node', '--check', 'sentlog/record-transfer.js'], cwd=ROOT, check=True)
print('Built collaborative record transfer with source tombstones, copied attribution and revision-checked atomic commit')

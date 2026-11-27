"""Observe main-record save failures throughout shared photo transfers.

Run after the complete v2.11 build and before the v2.12 release builder. The
coordinator's existing photo checks already fence the guarded write and ACK.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MARKER = 'sentlog-delta-save-failure-gate-v212'
RUNTIME = ROOT / 'sentlog/delta-sync-app-runtime.js'


def read(name):
    return (ROOT / name).read_text(encoding='utf-8')


source = RUNTIME.read_text(encoding='utf-8')
if ("['phone-runtime.js?v=211','v2.11']" not in read('sentlog/index.html')
        or 'sentlog-pdf-save-failure-gate-v211' not in read('sentlog/pdf-recovery.js')
        or not read('sentlog/record-store.js').startswith('// sentlog-storage-lifecycle-v210\n')
        or re.findall(r'sentlog-pwa-v\d+', read('sentlog/sw.js')) != ['sentlog-pwa-v253']
        or not source.startswith('// sentlog-file-journal-wake-v207\n')
        or MARKER in source):
    raise RuntimeError('Delta save-failure gate requires a fresh complete v2.11 build')

old = "const checkPhotos=()=>{check(c);insist(currentPhotos(),'DELTA_PHOTOS_PAUSED','容量整理のため写真の同期を停止しています');};"
new = "const checkPhotos=()=>{check(c);insist(currentPhotos(),'DELTA_PHOTOS_PAUSED','容量整理のため写真の同期を停止しています');records.assertSafe();};"
if source.count(old) != 1:
    raise RuntimeError('Delta photo validation integration changed')
source = '// ' + MARKER + '\n' + source.replace(old, new)
subprocess.run(['node', '--check', '--input-type=module'], input=source,
               text=True, cwd=ROOT, check=True, capture_output=True)
RUNTIME.write_text(source, encoding='utf-8')
print('Built shared photo gate for known record-save failures')

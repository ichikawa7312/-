"""Version the reviewed storage, PC archive and PDF-context safety fixes."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD_LABEL = 'v2.13 · 同期中の設定選択を改善'
LABEL = 'v2.14 · 記録保存と原本保護を改善'
OLD_CACHE, CACHE = 'sentlog-pwa-v255', 'sentlog-pwa-v256'
WRITER_TOKEN, WRITER_MARKER = '20261127-record-safety-214', 'sentlog-record-safety-v214'
HISTORY_TOKEN, HISTORY_MARKER = '20261127-failure-history-214', 'sentlog-failure-history-v214'
PAGE_TOKEN, PAGE_MARKER = '20261127-page-context-214', 'sentlog-page-context-v214'
PC_TOKEN, PC_MARKER = '20261127-pc-archive-preserve-214', 'sentlog-pc-archive-preserve-v214'
SAFE_PC_TOKEN, SAFE_PC_MARKER = '20261127-pc-acquisition-214', 'sentlog-pc-acquisition-v214'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Reliability release integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
if ("['phone-runtime.js?v=213','v2.13']" not in index
        or re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != [OLD_CACHE]):
    raise RuntimeError('Reliability release requires the complete v2.13 build')
for name, patterns in {
    'record-store': ['recordBatchNoopVersion:1', 'recordFailureHistoryVersion:1', 'expectedFileStatesVersion:1',
                     'recordChanges:changes', 'get recordFailureHistory()'],
    'storage-ui': ['recordFailureHistory'],
    'page-replacement': ['navigationGuardVersion:1'],
    'archive-pc': ['async function preserveFile(', "mode:'exclusive'", 'PC_ARCHIVE_COLLISION',
                   'PC_ARCHIVE_ROOT_CHANGED', 'rest.sentlogArchiveSendGuardVersion!==1'],
    'pc-safe-backup': ['const locked=await handle.getFile();', "mode:'exclusive'", 'PC_BACKUP_COLLISION'],
}.items():
    value = source('sentlog/' + name + '.js')
    if not all(pattern in value for pattern in patterns):
        raise RuntimeError('Required reviewed implementation is absent: ' + name)

modules = [
    ('record-store', '20261127-cutoff-resume-212', WRITER_TOKEN,
     'sentlog-cutoff-resume-v212', WRITER_MARKER, 2, 0),
    ('storage-ui', '20261127-storage-recovery-204', HISTORY_TOKEN,
     'sentlog-storage-recovery-v204', HISTORY_MARKER, 2, 0),
    ('page-replacement', '198', PAGE_TOKEN,
     'SentlogPageReplacement v1.98', PAGE_MARKER, 2, 0),
    ('archive-pc', '133', PC_TOKEN, None, PC_MARKER, 0, 1),
    ('pc-safe-backup', '20261125-safe-1', SAFE_PC_TOKEN, None, SAFE_PC_MARKER, 0, 1),
]
for name, old_token, token, old_marker, marker, main_count, pc_count in modules:
    path = 'sentlog/' + name + '.js'
    if marker in source(path):
        raise RuntimeError('Reliability release was already applied: ' + name)
    pending[path] = '// ' + marker + '\n' + source(path)
    old_url, url = name + '.js?v=' + old_token, name + '.js?v=' + token
    for page, count in [('sentlog/index.html', main_count), ('sentlog-pc/index.html', pc_count),
                        ('sentlog/drawing-export-view.html', 0)]:
        refs = re.findall(r'(?<![A-Za-z0-9_.-])' + re.escape(name) + r'\.js\?v=[A-Za-z0-9._-]+', source(page))
        if refs != [old_url] * count:
            raise RuntimeError('Unexpected resource references: ' + page + ': ' + name)
        if count:
            change(page, old_url, url, count)
    if main_count:
        change('sentlog/index.html', "['" + url + "','" + old_marker + "']",
               "['" + url + "','" + marker + "']")

old_guard = 'if(window.SentlogRecords?.cutoffResumeVersion!==1||'
new_guard = ('if(window.SentlogRecords?.recordBatchNoopVersion!==1||'
             'window.SentlogRecords?.recordFailureHistoryVersion!==1||'
             'window.SentlogRecords?.getFileWriteCapabilities?.()?.expectedFileStatesVersion!==1||'
             'window.SentlogRecords?.cutoffResumeVersion!==1||')
change('sentlog/index.html', old_guard, new_guard)
change('sentlog/index.html', 'phone-runtime.js?v=213', 'phone-runtime.js?v=214', 2)
change('sentlog/index.html', "'v2.13'", "'v2.14'")
change('sentlog/phone-runtime.js', 'v2.13', 'v2.14', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.13', 'v2.14'), LABEL)
change('sentlog-pc/index.html', OLD_LABEL, LABEL)
change('sentlog/sw.js', OLD_CACHE, CACHE)

# Keep the historical PC shell and earlier builder boundaries intact. The new
# archive module requires this executed capability before touching a folder.
# Validate after the shared session wait and synchronously before fetch; the
# callback is a separate argument and never enters RequestInit or the RPC body.
change('sentlog-pc/index.html', 'async function rest(path,opt={}){\n  await ensureSession();',
       'async function rest(path,opt={},validate=null){\n  await ensureSession();validate?.();')
change('sentlog-pc/index.html', '\nasync function login(){',
       '\nrest.sentlogArchiveSendGuardVersion=1;\nasync function login(){')

# The account-check page intentionally stays outside the service worker's
# static cache. Opening it while records are protected must not write caches.
for name in ['cloud-check.html', 'cloud-check.js', 'cloud-check-auth.js']:
    if not (ROOT / 'sentlog' / name).is_file() or "'" + name + "'" in source('sentlog/sw.js'):
        raise RuntimeError('Account-check cache isolation is missing: ' + name)
if 'cloud-check.html' not in source('sentlog/index.html'):
    raise RuntimeError('Protected-startup account-check link is absent')

# Earlier release checks remain behavioral checks of the final package. Move
# only their literal release identities and supply the two new capabilities
# in fixtures whose existing capability matrices must remain unchanged.
tests = ['storage_recovery_release', 'startup_protection_release', 'file_journal_wake_release',
         'startup_backup_recovery_release', 'cloud_normalization_release', 'storage_lifecycle_release',
         'pdf_save_failure_release', 'recovery_retry_release', 'metadata_choice_release']
identities = [(OLD_CACHE, CACHE), ("'v2.13'", "'v2.14'"),
              ('phone-runtime.js?v=213', 'phone-runtime.js?v=214'), (OLD_LABEL, LABEL),
              ('20261127-cutoff-resume-212', WRITER_TOKEN), ('sentlog-cutoff-resume-v212', WRITER_MARKER)]
for name in tests:
    path = 'tests/' + name + '.test.cjs'
    value = source(path)
    for old, new in identities:
        value = value.replace(old, new)
    if name in ['startup_protection_release', 'storage_lifecycle_release', 'recovery_retry_release']:
        if value.count('const records={') != 1:
            raise RuntimeError('Executed-writer fixture boundary changed: ' + name)
        value = value.replace('const records={', 'const records={recordBatchNoopVersion:1,recordFailureHistoryVersion:1,')
    if name == 'startup_backup_recovery_release':
        if value.count('window:{SentlogRecords:{') != 1:
            raise RuntimeError('Recovery-link fixture boundary changed')
        value = value.replace('window:{SentlogRecords:{', 'window:{SentlogRecords:{recordBatchNoopVersion:1,recordFailureHistoryVersion:1,')
    if name in ['startup_protection_release', 'storage_lifecycle_release', 'recovery_retry_release', 'startup_backup_recovery_release']:
        if value.count('getFileWriteCapabilities:()=>({') != 1:
            raise RuntimeError('Executed-writer file capability fixture changed: ' + name)
        value = value.replace('getFileWriteCapabilities:()=>({', 'getFileWriteCapabilities:()=>({expectedFileStatesVersion:1,')
    if name == 'metadata_choice_release':
        value = value.replace(old_guard, new_guard)
    if name == 'storage_recovery_release':
        value = value.replace("module==='record-store'?", "module==='storage-ui'?'" + HISTORY_TOKEN + "':module==='record-store'?", 1)
        marker_needle = "module==='record-store'?'" + WRITER_MARKER + "'"
        if value.count(marker_needle) != 1:
            raise RuntimeError('Storage recovery marker fixture changed')
        value = value.replace(marker_needle, "module==='storage-ui'?'" + HISTORY_MARKER + "':" + marker_needle)
    pending[path] = value
change('tests/drawing_export_ui.py', "'v2.13'", "'v2.14'")
for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name, *_ in modules:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.14: guarded record batches, verified PC originals, PDF context and account-check isolation; ' + CACHE)

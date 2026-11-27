"""Version resumable cutoff materialization and failed-record photo receiving."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WRITER_TOKEN = '20261127-cutoff-resume-212'
WRITER_MARKER = 'sentlog-cutoff-resume-v212'
PHOTO_TOKEN = '20261127-photo-save-failure-gate-212'
PHOTO_MARKER = 'sentlog-photo-save-failure-gate-v212'
DELTA_TOKEN = '20261127-delta-save-failure-gate-212'
DELTA_MARKER = 'sentlog-delta-save-failure-gate-v212'
OLD_DELTA_TOKEN = '20261127-file-journal-wake-207'
OLD_DELTA_MARKER = 'sentlog-file-journal-wake-v207'
CLOUD_TOKEN = '20261127-cloud-asset-save-failure-gate-212'
CLOUD_MARKER = 'sentlog-cloud-asset-save-failure-gate-v212'
OLD_CLOUD_TOKEN = '20261127-normalization-noop-209'
OLD_CLOUD_MARKER = 'sentlog-normalization-noop-v209'
OLD_WRITER_TOKEN = '20261127-storage-lifecycle-210'
OLD_WRITER_MARKER = 'sentlog-storage-lifecycle-v210'
OLD_PHOTO_TOKEN = '20261127-storage-recovery-204'
OLD_PHOTO_MARKER = 'sentlog-storage-recovery-v204'
OLD_LABEL = 'v2.11 · 保存失敗中のPDF受信を待機'
NEW_LABEL = 'v2.12 · 添付の再試行と写真受信を改善'
OLD_CACHE = 'sentlog-pwa-v253'
NEW_CACHE = 'sentlog-pwa-v254'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Recovery retry integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
writer = source('sentlog/record-store.js')
if ("['phone-runtime.js?v=211','v2.11']" not in index
        or not writer.startswith('// ' + OLD_WRITER_MARKER + '\n')
        or writer.count('cutoffResumeVersion:1') != 1
        or not source('sentlog/cloud-sync.js').startswith('// ' + OLD_CLOUD_MARKER + '\n')
        or WRITER_MARKER in writer
        or re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != [OLD_CACHE]):
    raise RuntimeError('Recovery retry release requires a fresh complete v2.11 and the resumable writer')

subprocess.run([sys.executable, 'scripts/build_photo_save_failure_gate.py'], cwd=ROOT, check=True)
subprocess.run([sys.executable, 'scripts/build_delta_save_failure_gate.py'], cwd=ROOT, check=True)
subprocess.run([sys.executable, 'scripts/build_cloud_asset_save_failure_gate.py'], cwd=ROOT, check=True)
if not source('sentlog/photo-recovery.js').startswith('// ' + PHOTO_MARKER + '\n'):
    raise RuntimeError('Photo failure gate product marker is missing')
if not source('sentlog/delta-sync-app-runtime.js').startswith('// ' + DELTA_MARKER + '\n'):
    raise RuntimeError('Delta failure gate product marker is missing')
if not source('sentlog/cloud-sync.js').startswith('// ' + CLOUD_MARKER + '\n'):
    raise RuntimeError('Cloud asset failure gate product marker is missing')
pending['sentlog/record-store.js'] = '// ' + WRITER_MARKER + '\n' + writer

for module, old_token, new_token, old_marker, new_marker in [
        ('record-store', OLD_WRITER_TOKEN, WRITER_TOKEN, OLD_WRITER_MARKER, WRITER_MARKER),
        ('photo-recovery', OLD_PHOTO_TOKEN, PHOTO_TOKEN, OLD_PHOTO_MARKER, PHOTO_MARKER),
        ('delta-sync-app-runtime', OLD_DELTA_TOKEN, DELTA_TOKEN, OLD_DELTA_MARKER, DELTA_MARKER),
        ('cloud-sync', OLD_CLOUD_TOKEN, CLOUD_TOKEN, OLD_CLOUD_MARKER, CLOUD_MARKER)]:
    old_url = module + '.js?v=' + old_token
    new_url = module + '.js?v=' + new_token
    for page, count in [('sentlog/index.html', 2),
                        ('sentlog-pc/index.html', 1 if module == 'photo-recovery' else 0),
                        ('sentlog/drawing-export-view.html', 0)]:
        # A photo-recovery suffix also occurs in peer-photo-recovery. Match
        # complete module names so the peer sender keeps its own identity.
        boundary = r'(?<![A-Za-z0-9_.-])'
        references = re.findall(boundary + re.escape(module) + r'\.js\?v=[A-Za-z0-9._-]+', source(page))
        if references != [old_url] * count:
            raise RuntimeError('Unexpected recovery retry references: ' + page + ': ' + module)
        if count:
            value, replacements = re.subn(boundary + re.escape(old_url), new_url, source(page))
            if replacements != count:
                raise RuntimeError('Unexpected recovery retry URL count: ' + page + ': ' + module)
            pending[page] = value
    change('sentlog/index.html', "['" + new_url + "','" + old_marker + "']",
           "['" + new_url + "','" + new_marker + "']")

# Check the writer that actually executed in the head before init(), including
# a mixed offline shell whose later dependency fetch could return newer bytes.
change('sentlog/index.html',
       'if(window.SentlogRecords?.storageLifecycleVersion!==1||',
       'if(window.SentlogRecords?.cutoffResumeVersion!==1||window.SentlogRecords?.storageLifecycleVersion!==1||')
change('sentlog/index.html', 'phone-runtime.js?v=211', 'phone-runtime.js?v=212', 2)
change('sentlog/index.html', "'v2.11'", "'v2.12'")
change('sentlog-pc/index.html', OLD_LABEL, NEW_LABEL)
change('sentlog/phone-runtime.js', 'v2.11', 'v2.12', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.11', 'v2.12'), NEW_LABEL)
change('sentlog/sw.js', OLD_CACHE, NEW_CACHE)

# Keep earlier behavior assertions; update only the identities they expect.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(OLD_CACHE, NEW_CACHE).replace("'v2.11'", "'v2.12'")
    value = value.replace('phone-runtime.js?v=211', 'phone-runtime.js?v=212')
    value = value.replace(r'phone-runtime\.js\?v=211', r'phone-runtime\.js\?v=212')
    value = value.replace(OLD_LABEL, NEW_LABEL)
    value = value.replace(OLD_CLOUD_TOKEN, CLOUD_TOKEN).replace(OLD_CLOUD_MARKER, CLOUD_MARKER)
    value = value.replace('record-store.js?v=' + OLD_WRITER_TOKEN,
                          'record-store.js?v=' + WRITER_TOKEN)
    value = value.replace("['record-store','" + OLD_WRITER_TOKEN + "','" + OLD_WRITER_MARKER + "']",
                          "['record-store','" + WRITER_TOKEN + "','" + WRITER_MARKER + "']")
    value = value.replace("['record-store.js?v=" + WRITER_TOKEN + "','" + OLD_WRITER_MARKER + "']",
                          "['record-store.js?v=" + WRITER_TOKEN + "','" + WRITER_MARKER + "']")
    value = value.replace("['delta-sync-app-runtime','" + OLD_DELTA_TOKEN + "','" + OLD_DELTA_MARKER + "']",
                          "['delta-sync-app-runtime','" + DELTA_TOKEN + "','" + DELTA_MARKER + "']")
    if value != old:
        pending[name] = value

change('tests/startup_protection_release.test.cjs',
       "const token='" + OLD_WRITER_TOKEN + "',marker='" + OLD_WRITER_MARKER + "';",
       "const token='" + WRITER_TOKEN + "',marker='" + WRITER_MARKER + "';")
change('tests/file_journal_wake_release.test.cjs',
       "const token='" + OLD_DELTA_TOKEN + "',marker='" + OLD_DELTA_MARKER + "';",
       "const token='" + DELTA_TOKEN + "',marker='" + DELTA_MARKER + "';")
change('tests/cloud_normalization_release.test.cjs',
       "assert(cloud.startsWith('// '+marker+'\\n// sentlog-file-journal-wake-v207\\n'));",
       "assert(cloud.startsWith('// '+marker+'\\n// " + OLD_CLOUD_MARKER + "\\n// sentlog-file-journal-wake-v207\\n'));")
change('tests/storage_recovery_release.test.cjs',
       "module==='record-store'?'" + OLD_WRITER_TOKEN + "':",
       "module==='record-store'?'" + WRITER_TOKEN + "':module==='photo-recovery'?'" + PHOTO_TOKEN + "':")
change('tests/storage_recovery_release.test.cjs',
       "module==='record-store'?'" + OLD_WRITER_MARKER + "':",
       "module==='record-store'?'" + WRITER_MARKER + "':module==='photo-recovery'?'" + PHOTO_MARKER + "':")
change('tests/storage_recovery_release.test.cjs',
       "assert(pc.includes('../sentlog/photo-recovery.js?v='+token));",
       "assert(pc.includes('../sentlog/photo-recovery.js?v=" + PHOTO_TOKEN + "'));")
change('tests/photo_recovery_pc.test.cjs',
       "pcPage.includes('photo-recovery.js?v=" + OLD_PHOTO_TOKEN + "')",
       "pcPage.includes('photo-recovery.js?v=" + PHOTO_TOKEN + "')")
change('tests/storage_lifecycle_release.test.cjs',
       "  const url=name+'.js?v='+token;",
       "  const currentToken=name==='record-store'?'" + WRITER_TOKEN + "':token;\n"
       "  const currentMarker=name==='record-store'?'" + WRITER_MARKER + "':marker;\n"
       "  const url=name+'.js?v='+currentToken;")
change('tests/storage_lifecycle_release.test.cjs',
       "assert(index.includes(\"['\"+url+\"','\"+marker+\"']\"));",
       "assert(index.includes(\"['\"+url+\"','\"+currentMarker+\"']\"));")
change('tests/storage_lifecycle_release.test.cjs',
       ".startsWith('// '+marker+'\\n')", ".startsWith('// '+currentMarker+'\\n')")

# Historical tests retain their original axes; the new release gate below
# exercises every combination of all four executed-writer capabilities.
change('tests/startup_protection_release.test.cjs',
       'const records={startupProtectionVersion,storageLifecycleVersion:1,',
       'const records={startupProtectionVersion,storageLifecycleVersion:1,cutoffResumeVersion:1,')
change('tests/storage_lifecycle_release.test.cjs',
       'const records={storageLifecycleVersion,startupProtectionVersion,',
       'const records={storageLifecycleVersion,startupProtectionVersion,cutoffResumeVersion:1,')
change('tests/startup_backup_recovery_release.test.cjs',
       'SentlogRecords:{startupProtectionVersion:1,storageLifecycleVersion:1,',
       'SentlogRecords:{startupProtectionVersion:1,storageLifecycleVersion:1,cutoffResumeVersion:1,')

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for module in ['record-store', 'phone-runtime', 'cloud-sync', 'delta-sync-app-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + module + '.js'], cwd=ROOT, check=True)
print('Built v2.12: reuse verified partial cutoffs and resume photo receiving after save recovery; ' + NEW_CACHE)

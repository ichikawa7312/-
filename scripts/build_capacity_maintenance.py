"""Ship bounded local maintenance and eliminate repeated unchanged projections."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD_LABEL = 'v2.14 · 記録保存と原本保護を改善'
LABEL = 'v2.15 · 保存の重複抑制と容量整理'
OLD_CACHE, CACHE = 'sentlog-pwa-v256', 'sentlog-pwa-v257'
OLD_TOKEN, TOKEN = '20261127-record-safety-214', '20261128-storage-maintenance-215'
OLD_MARKER, MARKER = 'sentlog-record-safety-v214', 'sentlog-storage-maintenance-v215'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Capacity maintenance integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


if ("['phone-runtime.js?v=214','v2.14']" not in source('sentlog/index.html')
        or re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != [OLD_CACHE]):
    raise RuntimeError('Capacity maintenance requires the complete v2.14 build')
for pattern in ['compactRedundantRecords(', 'compactRedundantFiles(', 'compactRedundantPageBackups(',
                'storageMaintenanceVersion:1', 'projectionNoopVersion:1']:
    if pattern not in source('sentlog/record-store.js'):
        raise RuntimeError('The reviewed maintenance writer is incomplete: ' + pattern)
if 'SentlogStorageMaintenanceUI' not in source('sentlog/storage-maintenance-ui.js'):
    raise RuntimeError('The device-local maintenance controls are missing')

change('sentlog/sync-view.js',
       '[...writes].some(([key,value])=>window.SentlogRecords.getItem(key)!==value)',
       '[...(applied.committedRecords||writes)].some(([key,value])=>window.SentlogRecords.getItem(key)!==value)')
pending['sentlog/sync-view.js'] = '// ' + MARKER + '\n' + source('sentlog/sync-view.js')
change('sentlog/index.html', 'sync-view.js?v=20261126-view-fence', 'sync-view.js?v=' + TOKEN, 2)
change('sentlog/index.html', "['sync-view.js?v=" + TOKEN + "','mergeCommit']",
       "['sync-view.js?v=" + TOKEN + "','" + MARKER + "']")
pending['sentlog/record-store.js'] = '// ' + MARKER + '\n' + source('sentlog/record-store.js')
pending['sentlog/storage-maintenance-ui.js'] = '// ' + MARKER + '\n' + source('sentlog/storage-maintenance-ui.js')
change('sentlog/index.html', 'record-store.js?v=' + OLD_TOKEN, 'record-store.js?v=' + TOKEN, 2)
change('sentlog/index.html', "['record-store.js?v=" + TOKEN + "','" + OLD_MARKER + "']",
       "['record-store.js?v=" + TOKEN + "','" + MARKER + "']")
script = '<script src="./storage-maintenance-ui.js?v=' + TOKEN + '"><\\/script>'
anchor = '<script src="./storage-diagnostics-ui.js?v=20261127-storage-lifecycle-210"><\\/script>'
change('sentlog/index.html', anchor, anchor + script)
change('sentlog/index.html', 'const deps=[', "const deps=[['storage-maintenance-ui.js?v=" + TOKEN + "','" + MARKER + "'],")
change('sentlog/sw.js', 'const FILES=[', "const FILES=['storage-maintenance-ui.js',")

old_guard = 'if(window.SentlogRecords?.recordBatchNoopVersion!==1||'
new_guard = ('if(window.SentlogRecords?.storageMaintenanceVersion!==1||'
             'window.SentlogRecords?.projectionNoopVersion!==1||'
             'window.SentlogRecords?.recordBatchNoopVersion!==1||')
change('sentlog/index.html', old_guard, new_guard)
change('sentlog/index.html', 'phone-runtime.js?v=214', 'phone-runtime.js?v=215', 2)
change('sentlog/index.html', "'v2.14'", "'v2.15'")
change('sentlog/phone-runtime.js', 'v2.14', 'v2.15', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.14', 'v2.15'), LABEL)
change('sentlog-pc/index.html', OLD_LABEL, LABEL)
change('sentlog/sw.js', OLD_CACHE, CACHE)

# Old release suites remain tests of the final build. Advance resource identity
# literals and make their existing capability matrices independent of the new
# two-capability matrix exercised by capacity_maintenance_release.test.cjs.
identities = [(OLD_CACHE, CACHE), ("'v2.14'", "'v2.15'"), (OLD_LABEL, LABEL),
              ('phone-runtime.js?v=214', 'phone-runtime.js?v=215'),
              (r'phone-runtime\.js\?v=214', r'phone-runtime\.js\?v=215'),
              (OLD_TOKEN, TOKEN), (OLD_MARKER, MARKER)]
fixture_names = {'startup_protection_release.test.cjs', 'storage_lifecycle_release.test.cjs',
                 'recovery_retry_release.test.cjs', 'reliability_release.test.cjs'}
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py') or path.name == 'capacity_maintenance_release.test.cjs':
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old
    for before, after in identities:
        value = value.replace(before, after)
    if path.name in fixture_names:
        if value.count('const records={') != 1:
            raise RuntimeError('Writer fixture changed: ' + name)
        value = value.replace('const records={', 'const records={storageMaintenanceVersion:1,projectionNoopVersion:1,')
    if path.name == 'startup_backup_recovery_release.test.cjs':
        if value.count('window:{SentlogRecords:{') != 1:
            raise RuntimeError('Recovery fixture changed')
        value = value.replace('window:{SentlogRecords:{', 'window:{SentlogRecords:{storageMaintenanceVersion:1,projectionNoopVersion:1,')
    if path.name == 'metadata_choice_release.test.cjs':
        value = value.replace(old_guard, new_guard)
    if value != old:
        pending[name] = value

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in ['record-store', 'storage-maintenance-ui', 'sync-view']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.15: bounded redundant-history maintenance and unchanged-projection suppression; ' + CACHE)

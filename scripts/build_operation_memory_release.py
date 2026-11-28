"""Ship scoped journal reads and an independent, deliberately opened maintenance page."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD_LABEL = 'v2.15 · 保存の重複抑制と容量整理'
LABEL = 'v2.16 · 操作時の負荷軽減と容量整理'
OLD_CACHE, CACHE = 'sentlog-pwa-v257', 'sentlog-pwa-v258'
OLD_TOKEN, TOKEN = '20261128-storage-maintenance-215', '20261128-operation-memory-216'
OLD_MARKER, MARKER = 'sentlog-storage-maintenance-v215', 'sentlog-operation-memory-v216'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Operation memory release boundary changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


if ("['phone-runtime.js?v=215','v2.15']" not in source('sentlog/index.html')
        or re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != [OLD_CACHE]):
    raise RuntimeError('Operation memory release requires the complete v2.15 build')
for text in ['maintenanceInitVersion:1', 'journalReadBudgetVersion:1', 'initForMaintenance']:
    if text not in source('sentlog/record-store.js'):
        raise RuntimeError('The reviewed bounded reader is missing: ' + text)
for name in ['storage-maintenance.html', 'startup-storage-maintenance.js']:
    if not (ROOT / 'sentlog' / name).is_file():
        raise RuntimeError('The independent maintenance entry is missing: ' + name)

for name in ['record-store', 'storage-maintenance-ui', 'sync-view']:
    path = 'sentlog/' + name + '.js'
    if not source(path).startswith('// ' + OLD_MARKER + '\n'):
        raise RuntimeError('Unexpected prior resource identity: ' + name)
    pending[path] = '// ' + MARKER + '\n' + source(path)
    change('sentlog/index.html', name + '.js?v=' + OLD_TOKEN, name + '.js?v=' + TOKEN, 2)
    change('sentlog/index.html', "['" + name + '.js?v=' + TOKEN + "','" + OLD_MARKER + "']",
           "['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']")
pending['sentlog/startup-storage-maintenance.js'] = '// ' + MARKER + '\n' + source('sentlog/startup-storage-maintenance.js')

old_guard = 'if(window.SentlogRecords?.storageMaintenanceVersion!==1||'
new_guard = ('if(window.SentlogRecords?.maintenanceInitVersion!==1||'
             'window.SentlogRecords?.journalReadBudgetVersion!==1||'
             'window.SentlogRecords?.storageMaintenanceVersion!==1||')
change('sentlog/index.html', old_guard, new_guard)
change('sentlog/index.html', 'phone-runtime.js?v=215', 'phone-runtime.js?v=216', 2)
change('sentlog/index.html', "'v2.15'", "'v2.16'")
change('sentlog/phone-runtime.js', 'v2.15', 'v2.16', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.15', 'v2.16'), LABEL)
change('sentlog-pc/index.html', OLD_LABEL, LABEL)
change('sentlog/sw.js', OLD_CACHE, CACHE)
change('sentlog/sw.js', 'const FILES=[', "const FILES=['storage-maintenance.html','startup-storage-maintenance.js',")

# A failed ordinary boot still exposes the independent entry. This link does
# not initialize the editor, fetch account data, or delete a cache/database.
change('sentlog/index.html', 'box.append(title,message,retry,storageCheck,storageRestore,cloudCheck);',
       "const storageMaintenance=document.createElement('a');"
       "storageMaintenance.href='./storage-maintenance.html?v=" + TOKEN + "';"
       "storageMaintenance.textContent='軽い画面で容量を整理';"
       "storageMaintenance.style.cssText=storageCheck.style.cssText;"
       'box.append(title,message,retry,storageMaintenance,storageCheck,storageRestore,cloudCheck);')

# Keep earlier behavioral release gates on the final package. Only advance
# resource identities and supply new capabilities to their unchanged matrices.
identities = [(OLD_CACHE, CACHE), ("'v2.15'", "'v2.16'"), (OLD_LABEL, LABEL),
              ('phone-runtime.js?v=215', 'phone-runtime.js?v=216'),
              (r'phone-runtime\.js\?v=215', r'phone-runtime\.js\?v=216'),
              (OLD_TOKEN, TOKEN), (OLD_MARKER, MARKER)]
fixtures = {'startup_protection_release.test.cjs', 'storage_lifecycle_release.test.cjs',
            'recovery_retry_release.test.cjs', 'reliability_release.test.cjs',
            'capacity_maintenance_release.test.cjs'}
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py') or path.name == 'operation_memory_release.test.cjs':
        continue
    name = str(path.relative_to(ROOT))
    before = source(name)
    value = before
    for old, new in identities:
        value = value.replace(old, new)
    if path.name in fixtures:
        if value.count('const records={') != 1:
            raise RuntimeError('Executed-writer fixture changed: ' + name)
        value = value.replace('const records={', 'const records={maintenanceInitVersion:1,journalReadBudgetVersion:1,')
    if path.name == 'startup_backup_recovery_release.test.cjs':
        if value.count('window:{SentlogRecords:{') != 1:
            raise RuntimeError('Recovery-link fixture changed')
        value = value.replace('window:{SentlogRecords:{', 'window:{SentlogRecords:{maintenanceInitVersion:1,journalReadBudgetVersion:1,')
    if path.name == 'metadata_choice_release.test.cjs':
        value = value.replace(old_guard, new_guard)
    if value != before:
        pending[name] = value

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in ['record-store', 'storage-maintenance-ui', 'startup-storage-maintenance', 'sync-view']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.16: scoped operation reads and independent protected maintenance; ' + CACHE)

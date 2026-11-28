"""Ship normal-workflow memory reductions without a separate work mode."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD_LABEL = 'v2.16 · 操作時の負荷軽減と容量整理'
LABEL = 'v2.17 · 起動と写真表示の負荷軽減'
OLD_CACHE, CACHE = 'sentlog-pwa-v258', 'sentlog-pwa-v259'
OLD_TOKEN, TOKEN = '20261128-operation-memory-216', '20261128-iphone-stability-217'
OLD_MARKER, MARKER = 'sentlog-operation-memory-v216', 'sentlog-iphone-stability-v217'
RUNTIME_TOKEN = '20261127-delta-save-failure-gate-212'
RUNTIME_MARKER = 'sentlog-delta-save-failure-gate-v212'
ASSETS_TOKEN = '20261126-drawing-recovery-201'
ASSETS_MARKER = 'sentlog-drawing-recovery-v201'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'iPhone stability release boundary changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


if ("['phone-runtime.js?v=216','v2.16']" not in source('sentlog/index.html')
        or re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != [OLD_CACHE]):
    raise RuntimeError('iPhone stability release requires the complete v2.16 build')
if 'startupReadBudgetVersion:1' not in source('sentlog/record-store.js'):
    raise RuntimeError('The normal startup reader is missing')
for name, required in [('delta-sync-app-runtime', 'function park(c)'),
                       ('delta-sync-assets', 'byteBackedBlobVersion:1'),
                       ('delta-sync-asset-runtime', 'unreadableCacheRepairVersion:1'),
                       ('photo-thumbnails', 'SentlogPhotoThumbnails')]:
    if required not in source('sentlog/' + name + '.js'):
        raise RuntimeError('The reviewed normal runtime is missing: ' + name)

for name in ['record-store', 'storage-maintenance-ui', 'sync-view']:
    path = 'sentlog/' + name + '.js'
    if not source(path).startswith('// ' + OLD_MARKER + '\n'):
        raise RuntimeError('Unexpected prior resource identity: ' + name)
    pending[path] = '// ' + MARKER + '\n' + source(path)
    change('sentlog/index.html', name + '.js?v=' + OLD_TOKEN, name + '.js?v=' + TOKEN, 2)
    change('sentlog/index.html', "['" + name + '.js?v=' + TOKEN + "','" + OLD_MARKER + "']",
           "['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']")
for name in ['startup-storage-maintenance', 'delta-sync-app-runtime', 'delta-sync-assets', 'delta-sync-asset-runtime', 'photo-thumbnails']:
    path = 'sentlog/' + name + '.js'
    pending[path] = '// ' + MARKER + '\n' + source(path)
change('sentlog/index.html', 'delta-sync-app-runtime.js?v=' + RUNTIME_TOKEN,
       'delta-sync-app-runtime.js?v=' + TOKEN, 2)
change('sentlog/index.html', "['delta-sync-app-runtime.js?v=" + TOKEN + "','" + RUNTIME_MARKER + "']",
       "['delta-sync-app-runtime.js?v=" + TOKEN + "','" + MARKER + "']")
for name in ['delta-sync-assets', 'delta-sync-asset-runtime']:
    change('sentlog/index.html', name + '.js?v=' + ASSETS_TOKEN, name + '.js?v=' + TOKEN, 2)
    change('sentlog/index.html', "['" + name + '.js?v=' + TOKEN + "','" + ASSETS_MARKER + "']",
           "['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']")

old_guard = 'if(window.SentlogRecords?.maintenanceInitVersion!==1||'
new_guard = 'if(window.SentlogRecords?.startupReadBudgetVersion!==1||window.SentlogRecords?.maintenanceInitVersion!==1||'
change('sentlog/index.html', old_guard, new_guard)
change('sentlog/index.html', 'const deps=[', "const deps=[['photo-thumbnails.js?v=" + TOKEN + "','" + MARKER + "'],")
# Install after every existing renderer/field wrapper; the original parts are unchanged.
change('sentlog/index.html', 'document.open();document.write(html);document.close()',
       "html=html.replace('</body>','<script src=\"./photo-thumbnails.js?v=" + TOKEN +
       "\"></'+'script></body>');document.open();document.write(html);document.close()")
change('sentlog/index.html', 'phone-runtime.js?v=216', 'phone-runtime.js?v=217', 2)
change('sentlog/index.html', "'v2.16'", "'v2.17'")
change('sentlog/index.html', 'storage-maintenance.html?v=' + OLD_TOKEN, 'storage-maintenance.html?v=' + TOKEN)
change('sentlog/storage-maintenance.html', OLD_TOKEN, TOKEN, 3)
change('sentlog/phone-runtime.js', 'v2.16', 'v2.17', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.16', 'v2.17'), LABEL)
change('sentlog-pc/index.html', OLD_LABEL, LABEL)
change('sentlog/sw.js', OLD_CACHE, CACHE)
change('sentlog/sw.js', 'const FILES=[', "const FILES=['photo-thumbnails.js',")

# Advance identities and mock capabilities in prior behavioral gates. Their
# matrices and assertions are kept, including all save/restore failure guards.
identities = [(OLD_CACHE, CACHE), ("'v2.16'", "'v2.17'"), (OLD_LABEL, LABEL),
              ('phone-runtime.js?v=216', 'phone-runtime.js?v=217'),
              (r'phone-runtime\.js\?v=216', r'phone-runtime\.js\?v=217'),
              (OLD_TOKEN, TOKEN), (OLD_MARKER, MARKER),
              (RUNTIME_TOKEN, TOKEN), (RUNTIME_MARKER, MARKER)]
fixtures = {'startup_protection_release.test.cjs', 'storage_lifecycle_release.test.cjs',
            'recovery_retry_release.test.cjs', 'reliability_release.test.cjs',
            'capacity_maintenance_release.test.cjs', 'operation_memory_release.test.cjs'}
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py') or path.name == 'iphone_stability_release.test.cjs':
        continue
    name = str(path.relative_to(ROOT))
    before = source(name)
    value = before
    for old, new in identities:
        value = value.replace(old, new)
    if path.name in fixtures:
        if value.count('const records={') != 1:
            raise RuntimeError('Executed-writer fixture changed: ' + name)
        value = value.replace('const records={', 'const records={startupReadBudgetVersion:1,')
    if path.name == 'startup_backup_recovery_release.test.cjs':
        if value.count('window:{SentlogRecords:{') != 1:
            raise RuntimeError('Recovery-link fixture changed')
        value = value.replace('window:{SentlogRecords:{', 'window:{SentlogRecords:{startupReadBudgetVersion:1,')
    if path.name == 'metadata_choice_release.test.cjs':
        value = value.replace(old_guard, new_guard)
    if value != before:
        pending[name] = value

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in ['record-store', 'delta-sync-app-runtime', 'delta-sync-assets', 'delta-sync-asset-runtime', 'photo-thumbnails', 'storage-maintenance-ui', 'sync-view']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.17: normal startup, idle sync residency, durable asset bytes and visible photo previews; ' + CACHE)

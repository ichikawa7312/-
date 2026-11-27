"""Version closed-connection protection and incomplete storage diagnosis."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-storage-lifecycle-210'
MARKER = 'sentlog-storage-lifecycle-v210'
OLD_LABEL = 'v2.09 · 同じ記録の不要な再保存を抑制'
NEW_LABEL = 'v2.10 · 保存先の異常検知と診断表示'
OLD_CACHE = 'sentlog-pwa-v251'
NEW_CACHE = 'sentlog-pwa-v252'
MODULES = [
    ('record-store', '20261127-startup-protection-206', 'sentlog-startup-protection-v206'),
    ('storage-diagnostics', '20261127-startup-storage-205', 'sentlog-startup-storage-v205'),
    ('storage-diagnostics-ui', '20261127-storage-203', 'sentlog-storage-review-v203'),
]
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Storage lifecycle integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
if ("['phone-runtime.js?v=209','v2.09']" not in index
        or 'sentlog-normalization-noop-v209' not in index
        or 'storageLifecycleVersion:1' not in source('sentlog/record-store.js')
        or 'startupProtectionVersion:1' not in source('sentlog/record-store.js')
        or MARKER in index
        or re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != [OLD_CACHE]):
    raise RuntimeError('Storage lifecycle requires a fresh complete v2.09 and the guarded writer')

for module, old_token, old_marker in MODULES:
    name = 'sentlog/' + module + '.js'
    value = source(name)
    if not value.startswith('// ' + old_marker + '\n') or MARKER in value:
        raise RuntimeError('Unexpected lifecycle module version: ' + module)
    pending[name] = '// ' + MARKER + '\n' + value
    old_url, new_url = module + '.js?v=' + old_token, module + '.js?v=' + TOKEN
    for page, count in [('sentlog/index.html', 2),
                        ('sentlog-pc/index.html', 0 if module == 'record-store' else 1),
                        ('sentlog/drawing-export-view.html', 0)]:
        references = re.findall(re.escape(module) + r'\.js\?v=[A-Za-z0-9._-]+', source(page))
        if references != [old_url] * count:
            raise RuntimeError('Unexpected lifecycle references: ' + page + ': ' + module)
        if count:
            change(page, old_url, new_url, count)
    change('sentlog/index.html', "['" + new_url + "','" + old_marker + "']",
           "['" + new_url + "','" + MARKER + "']")

# The script in the document head executes before the dependency fetch. Refuse
# a stale executed writer before init(), even if a newer fetch would succeed.
change('sentlog/index.html',
       'if(window.SentlogRecords?.startupProtectionVersion!==1||window.SentlogRecords?.getFileWriteCapabilities?.()?.fileWriteDedupVersion!==1)',
       'if(window.SentlogRecords?.storageLifecycleVersion!==1||window.SentlogRecords?.startupProtectionVersion!==1||window.SentlogRecords?.getFileWriteCapabilities?.()?.fileWriteDedupVersion!==1)')
change('sentlog/index.html', 'phone-runtime.js?v=209', 'phone-runtime.js?v=210', 2)
change('sentlog/index.html', "'v2.09'", "'v2.10'")
change('sentlog-pc/index.html', OLD_LABEL, NEW_LABEL)
change('sentlog/phone-runtime.js', 'v2.09', 'v2.10', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.09', 'v2.10'), NEW_LABEL)
change('sentlog/sw.js', OLD_CACHE, NEW_CACHE)

# Advance resource identities, retaining each earlier safety assertion.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(OLD_CACHE, NEW_CACHE).replace("'v2.09'", "'v2.10'")
    value = value.replace('phone-runtime.js?v=209', 'phone-runtime.js?v=210')
    value = value.replace(r'phone-runtime\.js\?v=209', r'phone-runtime\.js\?v=210')
    value = value.replace(OLD_LABEL, NEW_LABEL)
    for module, old_token, old_marker in MODULES:
        value = value.replace(old_token, TOKEN).replace(old_marker, MARKER)
    if value != old:
        pending[name] = value

# The historical startup test still exercises its original two axes, with the
# new capability present. The new lifecycle release gate checks all 27 states.
change('tests/startup_protection_release.test.cjs',
       'const records={startupProtectionVersion,getFileWriteCapabilities:',
       'const records={startupProtectionVersion,storageLifecycleVersion:1,getFileWriteCapabilities:')
change('tests/startup_backup_recovery_release.test.cjs',
       'SentlogRecords:{startupProtectionVersion:1,getFileWriteDedupVersion:',
       'SentlogRecords:{startupProtectionVersion:1,storageLifecycleVersion:1,getFileWriteDedupVersion:')

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for module in [name for name, _, _ in MODULES] + ['phone-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + module + '.js'], cwd=ROOT, check=True)
print('Built v2.10: preserve records after abnormal connection closure and disclose unmeasured storage; ' + NEW_CACHE)

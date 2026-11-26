"""Add the independent, add-only backup recovery page after a fresh v2.07."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-startup-backup-recovery-208'
MARKER = 'sentlog-startup-backup-recovery-v208'
OLD_LABEL = 'v2.07 · 記録受信・写真同期の待機を改善'
NEW_LABEL = 'v2.08 · 起動停止時のバックアップ復旧'
OLD_CACHE = 'sentlog-pwa-v249'
NEW_CACHE = 'sentlog-pwa-v250'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Startup backup recovery integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
worker = source('sentlog/sw.js')
if ("['phone-runtime.js?v=207','v2.07']" not in index
        or 'sentlog-startup-protection-v206' not in index
        or 'sentlog-bounded-receive-v207' not in index
        or 'sentlog-file-journal-wake-v207' not in index
        or index.count('await window.SentlogRecords.init();') != 1
        or index.count('box.append(title,message,retry,storageCheck);') != 1
        or MARKER in index
        or re.findall(r'sentlog-pwa-v\d+', worker) != [OLD_CACHE]):
    raise RuntimeError('Startup backup recovery requires one complete, fresh v2.07 build')

# Like the independent diagnostic page, recovery must not depend on an app
# worker installation or load the editor/authentication/synchronization stack.
for name in ['backup-format.js', 'startup-backup-recovery.js', 'storage-restore.html']:
    value = source('sentlog/' + name)
    if MARKER in value or name in worker:
        raise RuntimeError('Recovery resources must be fresh and outside the app worker: ' + name)
for name in ['backup-format', 'startup-backup-recovery']:
    filename = 'sentlog/' + name + '.js'
    pending[filename] = '// ' + MARKER + '\n' + source(filename)
    change('sentlog/storage-restore.html', name + '.js?v=1', name + '.js?v=' + TOKEN)
change('sentlog/storage-restore.html', '<!doctype html>', '<!doctype html>\n<!-- ' + MARKER + ' -->')

# Normal same-tab navigation releases the failed app's writer lock. The new
# page checks its own empty-storage and backup proof before enabling startup.
change('sentlog/index.html', 'box.append(title,message,retry,storageCheck);',
       "const storageRestore=document.createElement('a');"
       "storageRestore.href='./storage-restore.html?v=" + TOKEN + "';"
       "storageRestore.textContent='バックアップから復旧';"
       "storageRestore.style.cssText=storageCheck.style.cssText;"
       'box.append(title,message,retry,storageCheck,storageRestore);')
change('sentlog/index.html', 'phone-runtime.js?v=207', 'phone-runtime.js?v=208', 2)
change('sentlog/index.html', "'v2.07'", "'v2.08'")
change('sentlog-pc/index.html', OLD_LABEL, NEW_LABEL)
change('sentlog/phone-runtime.js', 'v2.07', 'v2.08', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.07', 'v2.08'), NEW_LABEL)
change('sentlog/sw.js', OLD_CACHE, NEW_CACHE)

# Preserve all behavioral assertions while advancing only the shell's release
# expectations. Normal backup import and all database/sync writers are intact.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(OLD_CACHE, NEW_CACHE).replace("'v2.07'", "'v2.08'")
    value = value.replace('phone-runtime.js?v=207', 'phone-runtime.js?v=208')
    value = value.replace(r'phone-runtime\.js\?v=207', r'phone-runtime\.js\?v=208')
    value = value.replace(OLD_LABEL, NEW_LABEL)
    if value != old:
        pending[name] = value

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in ['backup-format', 'startup-backup-recovery', 'phone-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.08: independent add-only backup recovery with protected startup; ' + NEW_CACHE)

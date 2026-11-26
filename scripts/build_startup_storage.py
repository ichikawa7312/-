"""Release the standalone startup-storage entry point after a fresh v2.04 build.

Only static resources and their release assertions change here. The standalone
page remains outside the service worker's application resource list.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-startup-storage-205'
MARKER = 'sentlog-startup-storage-v205'
OLD_TOKEN = '20261127-storage-203'
OLD_MARKER = 'sentlog-storage-review-v203'
OLD_LABEL = 'v2.04 · 保存失敗時の救出・受信保護'
NEW_LABEL = 'v2.05 · 起動前の保存状態確認'
OLD_CACHE = 'sentlog-pwa-v246'
NEW_CACHE = 'sentlog-pwa-v247'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Startup storage integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
core = source('sentlog/storage-diagnostics.js')
worker = source('sentlog/sw.js')
if ('sentlog-storage-recovery-v204' not in index
        or "['phone-runtime.js?v=204','v2.04']" not in index
        or MARKER in index or MARKER in core
        or not core.startswith('// ' + OLD_MARKER + '\n')
        or re.findall(r'sentlog-pwa-v\d+', worker) != [OLD_CACHE]):
    raise RuntimeError('Startup storage requires one complete, fresh v2.04 build')
for name in ['storage-check.html', 'startup-storage-diagnostics.js']:
    if not (ROOT / 'sentlog' / name).is_file() or name in worker:
        raise RuntimeError('Startup diagnostics must exist outside the app worker: ' + name)

pending['sentlog/storage-diagnostics.js'] = '// ' + MARKER + '\n' + core
old_url = 'storage-diagnostics.js?v=' + OLD_TOKEN
new_url = 'storage-diagnostics.js?v=' + TOKEN
# Check all three real consumers. The drawing-export viewer currently has no
# storage-diagnostics dependency and must retain its existing resources.
for filename, count in [('sentlog/index.html', 2), ('sentlog-pc/index.html', 1),
                        ('sentlog/drawing-export-view.html', 0)]:
    value = source(filename)
    references = re.findall(r'storage-diagnostics\.js\?v=[A-Za-z0-9._-]+', value)
    if references != [old_url] * count:
        raise RuntimeError('Unexpected storage diagnostics references: ' + filename)
    if count:
        change(filename, old_url, new_url, count)
change('sentlog/index.html', "['" + new_url + "','" + OLD_MARKER + "']",
       "['" + new_url + "','" + MARKER + "']")

change('sentlog/index.html', 'phone-runtime.js?v=204', 'phone-runtime.js?v=205', 2)
change('sentlog/index.html', "'v2.04'", "'v2.05'")
change('sentlog-pc/index.html', OLD_LABEL, NEW_LABEL)
change('sentlog/phone-runtime.js', 'v2.04', 'v2.05', 4)
change('sentlog/phone-runtime.js',
       'v2.05 · 図面上の選択・文字移動／変状情報は手動で開閉', NEW_LABEL)

# Keep the failed-init guard and retry handler intact. A normal same-tab link
# opens the independent, read-only page without starting the app or recovery.
if (index.count('await window.SentlogRecords.init();') != 1
        or index.count("title.textContent='セントログを開始できませんでした';") != 1):
    raise RuntimeError('The protected startup-error screen changed')
change('sentlog/index.html', 'box.append(title,message,retry);',
       "const storageCheck=document.createElement('a');"
       "storageCheck.href='./storage-check.html';"
       "storageCheck.textContent='保存領域の確認';"
       "storageCheck.style.cssText='display:block;margin-top:16px;text-decoration:underline;color:inherit;';"
       'box.append(title,message,retry,storageCheck);')
change('sentlog/sw.js', OLD_CACHE, NEW_CACHE)

# As in preceding release builders, keep exact test expectations aligned with
# the final generation. Unchanged runtime modules retain their v204 tokens.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(OLD_CACHE, NEW_CACHE).replace("'v2.04'", "'v2.05'")
    value = value.replace('phone-runtime.js?v=204', 'phone-runtime.js?v=205')
    value = value.replace(r'phone-runtime\.js\?v=204', r'phone-runtime\.js\?v=205')
    value = value.replace(OLD_LABEL, NEW_LABEL)
    value = value.replace(old_url, new_url)
    value = value.replace(r'storage-diagnostics\.js\?v=' + OLD_TOKEN,
                          r'storage-diagnostics\.js\?v=' + TOKEN)
    value = value.replace('PASS v2.04 loader,', 'PASS v2.05 loader,')
    if value != old:
        pending[name] = value

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in ['storage-diagnostics', 'phone-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.05: startup storage diagnostics link and stable diagnostic timeout reasons; ' + NEW_CACHE)

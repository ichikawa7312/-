"""Version PDF recovery that waits for known local record-save failures."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-pdf-save-failure-gate-211'
MARKER = 'sentlog-pdf-save-failure-gate-v211'
OLD_TOKEN = '20261126-drawing-recovery-201'
OLD_MARKER = 'sentlog-drawing-recovery-v201'
OLD_LABEL = 'v2.10 · 保存先の異常検知と診断表示'
NEW_LABEL = 'v2.11 · 保存失敗中のPDF受信を待機'
OLD_CACHE = 'sentlog-pwa-v252'
NEW_CACHE = 'sentlog-pwa-v253'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'PDF failure release integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
if ("['phone-runtime.js?v=210','v2.10']" not in index
        or 'sentlog-storage-lifecycle-v210' not in index
        or MARKER in index
        or re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != [OLD_CACHE]):
    raise RuntimeError('PDF failure release requires a fresh complete v2.10')

subprocess.run([sys.executable, 'scripts/build_pdf_save_failure_gate.py'], cwd=ROOT, check=True)
if not source('sentlog/pdf-recovery.js').startswith('// ' + MARKER + '\n'):
    raise RuntimeError('PDF failure gate product marker is missing')

old_url = 'pdf-recovery.js?v=' + OLD_TOKEN
new_url = 'pdf-recovery.js?v=' + TOKEN
for page, count in [('sentlog/index.html', 2), ('sentlog-pc/index.html', 1),
                    ('sentlog/drawing-export-view.html', 0)]:
    references = re.findall(r'pdf-recovery\.js\?v=[A-Za-z0-9._-]+', source(page))
    if references != [old_url] * count:
        raise RuntimeError('Unexpected PDF recovery references: ' + page)
    if count:
        change(page, old_url, new_url, count)
change('sentlog/index.html', "['" + new_url + "','" + OLD_MARKER + "']",
       "['" + new_url + "','" + MARKER + "']")
change('sentlog/index.html', 'phone-runtime.js?v=210', 'phone-runtime.js?v=211', 2)
change('sentlog/index.html', "'v2.10'", "'v2.11'")
change('sentlog-pc/index.html', OLD_LABEL, NEW_LABEL)
change('sentlog/phone-runtime.js', 'v2.10', 'v2.11', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.10', 'v2.11'), NEW_LABEL)
change('sentlog/sw.js', OLD_CACHE, NEW_CACHE)

# Advance only historical release identities; retain their behavior assertions.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(OLD_CACHE, NEW_CACHE).replace("'v2.10'", "'v2.11'")
    value = value.replace('phone-runtime.js?v=210', 'phone-runtime.js?v=211')
    value = value.replace(r'phone-runtime\.js\?v=210', r'phone-runtime\.js\?v=211')
    value = value.replace(OLD_LABEL, NEW_LABEL)
    if value != old:
        pending[name] = value

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for module in ['pdf-recovery', 'phone-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + module + '.js'], cwd=ROOT, check=True)
print('Built v2.11: pause PDF recovery during known record-save failures; ' + NEW_CACHE)

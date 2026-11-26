"""Add the phone-only compact editor after the complete v1.98 production build."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261126-phone-space-1'
MARKER = 'sentlog-phone-editor-space-v1'


def change(text, old, new, count=1):
    found = text.count(old)
    if found != count:
        raise RuntimeError(f'Phone editor integration changed: {old[:100]!r}: {found}, expected {count}')
    return text.replace(old, new)


path = ROOT / 'sentlog/index.html'
source = path.read_text(encoding='utf-8')
if 'sentlog-polygon-pointer-stability-v1' not in source or 'phone-editor-space.js' in source:
    raise RuntimeError('Phone editor layout requires a pristine completed v1.98 build')
source = change(source, 'const deps=[',
                "const deps=[['phone-editor-space.js?v=" + TOKEN + "','" + MARKER + "'],")
# Last script, after every established control installer; its app-ready microtask
# runs after page replacement and keeps the original nodes/listeners intact.
source = change(source, 'document.open();document.write(html);',
                "html=html.replace('</body>','<script src=\"./phone-editor-space.js?v=" + TOKEN + "\"></'+'script></body>');document.open();document.write(html);")
path.write_text(source, encoding='utf-8')

for filename in ['sentlog/index.html', 'sentlog-pc/index.html']:
    path = ROOT / filename
    source = path.read_text(encoding='utf-8')
    source = source.replace('phone-runtime.js?v=198', 'phone-runtime.js?v=199')
    source = source.replace("'v1.98'", "'v1.99'")
    source = source.replace('v1.98 · 多角形の確定方向を安定化', 'v1.99 · スマートフォンの図面表示を拡大')
    path.write_text(source, encoding='utf-8')

path = ROOT / 'sentlog/phone-runtime.js'
path.write_text(change(path.read_text(encoding='utf-8'), 'v1.98', 'v1.99', 4), encoding='utf-8')

path = ROOT / 'sentlog/sw.js'
source = path.read_text(encoding='utf-8')
old_cache = re.search(r'sentlog-pwa-v\d+', source).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 1)
source = change(source, "'phone-runtime.js'", "'phone-runtime.js','phone-editor-space.js'")
path.write_text(source.replace(old_cache, new_cache), encoding='utf-8')

for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    old = path.read_text(encoding='utf-8')
    source = old.replace(old_cache, new_cache)
    source = source.replace("'v1.98'", "'v1.99'")
    source = source.replace('phone-runtime.js?v=198', 'phone-runtime.js?v=199')
    source = source.replace(r'phone-runtime\.js\?v=198', r'phone-runtime\.js\?v=199')
    source = source.replace('v1.98 · 多角形の確定方向を安定化', 'v1.99 · スマートフォンの図面表示を拡大')
    if source != old:
        path.write_text(source, encoding='utf-8')

module = ROOT / 'sentlog/phone-editor-space.js'
if MARKER not in module.read_text(encoding='utf-8'):
    raise RuntimeError('Phone editor module marker is missing')
for name in ['sentlog/phone-editor-space.js', 'sentlog/phone-runtime.js']:
    subprocess.run(['node', '--check', name], cwd=ROOT, check=True)
for script in re.findall(r'<script(?:\s[^>]*)?>(.*?)</script\s*>', (ROOT / 'sentlog/index.html').read_text(encoding='utf-8'), re.S | re.I):
    subprocess.run(['node', '--check'], input=script, text=True, cwd=ROOT, check=True)
print('Built v1.99 compact phone editor; ' + new_cache)

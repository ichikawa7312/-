"""Integrate camera ordering and return recovery after the production build.

Keep the collaboration projection/schema and media bytes unchanged. These
patches run last so earlier pinned build stages retain their original inputs.
"""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261126-camera-order-return-1'
MARKER = 'sentlog-camera-order-return-v1'


def change(text, old, new, count=1):
    if text.count(old) != count:
        raise RuntimeError(f'Camera reliability integration changed: {old[:90]!r}: {text.count(old)}')
    return text.replace(old, new)


subprocess.run([sys.executable, 'scripts/build_photo_display_order.py'], cwd=ROOT, check=True)
subprocess.run([sys.executable, 'scripts/build_camera_return.py'], cwd=ROOT, check=True)

modules = ['collaboration-photos', 'continuous-camera', 'photo-ledger', 'cloud-sync']
for name in modules:
    path = ROOT / 'sentlog' / (name + '.js')
    text = path.read_text(encoding='utf-8')
    if MARKER in text:
        raise RuntimeError('Camera reliability requires a pristine production build')
    path.write_text('\n// ' + MARKER + '\n' + text, encoding='utf-8')

# The legacy HTML is split at byte boundaries, including inside identifiers.
# Place inline markers at known statement boundaries, never at a part's start.
for name, anchor in [('part06', 'async function renderSelectedPhotos(){'), ('part07', 'async function initApp(){')]:
    path = ROOT / 'sentlog' / (name + '.txt')
    text = change(path.read_text(encoding='utf-8'), anchor, '// ' + MARKER + '\n' + anchor)
    path.write_text(text, encoding='utf-8')

versions = set()
for filename in ['sentlog/index.html', 'sentlog-pc/index.html']:
    path = ROOT / filename
    text = path.read_text(encoding='utf-8')
    for name in modules:
        pattern = re.escape(name) + r'\.js\?v=([A-Za-z0-9._-]+)'
        versions.update((name, version) for version in re.findall(pattern, text))
        text = re.sub(pattern, name + '.js?v=' + TOKEN, text)
    text = text.replace('phone-runtime.js?v=196', 'phone-runtime.js?v=197')
    text = text.replace("'v1.96'", "'v1.97'")
    text = text.replace('v1.96 · 共有ファイル保持・同期軽量化', 'v1.97 · 写真の撮影順・撮影後の画面復帰')
    if filename == 'sentlog/index.html':
        # Detect a partially updated offline shell before running any app code.
        text = change(text, "for(const [i,token] of [", "for(const [i,token] of [[5,'" + MARKER + "'],[6,'" + MARKER + "'],")
        for name, previous in [('collaboration-photos', 'prepareCapture'), ('continuous-camera', 'prefersVideoFrame'), ('cloud-sync', 'sentlog-delta-app-v1')]:
            text = change(text, "['" + name + '.js?v=' + TOKEN + "','" + previous + "']",
                          "['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']")
        text = change(text, 'const deps=[', "const deps=[['photo-ledger.js?v=" + TOKEN + "','" + MARKER + "'],")
    path.write_text(text, encoding='utf-8')

path = ROOT / 'sentlog/phone-runtime.js'
text = change(path.read_text(encoding='utf-8'), 'v1.96', 'v1.97', 4)
path.write_text(text, encoding='utf-8')

path = ROOT / 'sentlog/sw.js'
text = path.read_text(encoding='utf-8')
old_cache = re.search(r'sentlog-pwa-v\d+', text).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 1)
path.write_text(text.replace(old_cache, new_cache), encoding='utf-8')

for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    old = path.read_text(encoding='utf-8')
    text = old.replace(old_cache, new_cache)
    text = text.replace("'v1.96'", "'v1.97'")
    text = text.replace('phone-runtime.js?v=196', 'phone-runtime.js?v=197')
    text = text.replace(r'phone-runtime\.js\?v=196', r'phone-runtime\.js\?v=197')
    text = text.replace('v1.96 · 共有ファイル保持・同期軽量化', 'v1.97 · 写真の撮影順・撮影後の画面復帰')
    for name, version in versions:
        text = text.replace(name + '.js?v=' + version, name + '.js?v=' + TOKEN)
        text = text.replace(name + r'\.js\?v=' + version, name + r'\.js\?v=' + TOKEN)
    if text != old:
        path.write_text(text, encoding='utf-8')

for name in modules + ['photo-display-order', 'camera-return']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
# Check the joined application as the browser parses it, including fragment
# boundaries. Do not execute it or create any records during this check.
html = ''.join((ROOT / 'sentlog' / f'part{i:02d}.txt').read_text(encoding='utf-8') for i in range(1, 10))
for label, document in [('joined application', html), ('application loader', (ROOT / 'sentlog/index.html').read_text(encoding='utf-8'))]:
    inline = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script\s*>', document, re.S | re.I)
    if not inline:
        raise RuntimeError(label + ' has no inline script')
    for script in inline:
        subprocess.run(['node', '--check'], input=script, text=True, cwd=ROOT, check=True)
for name in ['photo_display_order', 'camera_return']:
    subprocess.run(['node', 'tests/' + name + '.test.cjs'], cwd=ROOT, check=True)
print('Built v1.97 camera ordering and return recovery; ' + new_cache)

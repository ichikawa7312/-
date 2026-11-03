"""Build both photo ledger formats as optional read-only export features.

The damage-format JavaScript and Excel bytes are stored as lossless compressed
build assets. The SHA-256 checks make truncated/copied assets fail the build
rather than shipping an altered drawing template or a broken exporter.
"""
from pathlib import Path
import base64
import gzip
import hashlib
import re

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'scripts' / 'assets'

def unpack(parts, destination, expected_sha256):
    encoded = ''.join((ASSETS / filename).read_text(encoding='ascii').strip() for filename in parts)
    raw = gzip.decompress(base64.b64decode(encoded, validate=True))
    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected_sha256:
        raise RuntimeError(f'Photo ledger build asset integrity check failed: {destination.name} {digest}')
    destination.write_bytes(raw)

unpack(
    ['photo-ledger-damage.js.gz.b64'],
    ROOT / 'sentlog' / 'photo-ledger-damage.js',
    '436011317c5aa746c0623105dee3f2999fcd01dc04aca27ea1627b40175ad033',
)
unpack(
    [f'damage-ledger-template-{i}.b64' for i in range(1, 6)],
    ROOT / 'sentlog' / 'damage-ledger-template.xlsx',
    '061bf49068d08e9b1542dce3ad0135682a22a5e3b318faa002a5983e7a4929b1',
)

index = ROOT / 'sentlog' / 'index.html'
s = index.read_text(encoding='utf-8')
anchor = 'document.open();document.write(html);document.close()'
assert s.count(anchor) == 1, 'photo ledger: document anchor missing'

if "photo-ledger.js?v=208" not in s:
    inject = "html=html.replace('</body>','<script src=\\\"./photo-ledger.js?v=208\\\"><\\/script></body>');"
    s = s.replace(anchor, inject + anchor, 1)
if "photo-ledger-damage.js?v=209" not in s:
    inject = "html=html.replace('</body>','<script src=\\\"./photo-ledger-damage.js?v=209\\\"><\\/script></body>');"
    s = s.replace(anchor, inject + anchor, 1)
index.write_text(s, encoding='utf-8')

sw = ROOT / 'sentlog' / 'sw.js'
w = sw.read_text(encoding='utf-8')
missing = [
    name for name in ['photo-ledger.js', 'photo-ledger-damage.js', 'damage-ledger-template.xlsx']
    if f"'{name}'" not in w
]
if missing:
    flag = 'const FILES=['
    assert w.count(flag) == 1, 'photo ledger: SW asset anchor missing'
    w = w.replace(flag, "const FILES=[" + ''.join(f"'{name}'," for name in missing), 1)
    match = re.search(r'sentlog-pwa-v\d+', w)
    assert match, 'photo ledger: SW version missing'
    old = match.group(0)
    new = 'sentlog-pwa-v' + str(int(old.rsplit('v', 1)[-1]) + 1)
    w = w.replace(old, new)
    sw.write_text(w, encoding='utf-8')
    for path in (ROOT / 'tests').iterdir():
        if path.suffix not in ('.cjs', '.py'):
            continue
        data = path.read_text(encoding='utf-8')
        if old in data:
            path.write_text(data.replace(old, new), encoding='utf-8')

print('Photo ledger integrated: 標準 (unchanged) / 損傷用 (exact Excel template), A4 portrait')

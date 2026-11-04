"""Build both photo ledger formats as optional read-only export features.

The damage-format Excel bytes are stored in lossless compressed build assets.
The JavaScript module is checked in directly for code review and tests. The
SHA-256 check rejects altered or truncated original workbook template bytes.
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

assert (ROOT / 'sentlog' / 'photo-ledger-damage.js').is_file(), 'photo-ledger-damage.js source missing'
unpack(
    [f'damage-ledger-template-{i}.b64' for i in range(1, 6)],
    ROOT / 'sentlog' / 'damage-ledger-template.xlsx',
    '061bf49068d08e9b1542dce3ad0135682a22a5e3b318faa002a5983e7a4929b1',
)

index = ROOT / 'sentlog' / 'index.html'
s = index.read_text(encoding='utf-8')
anchor = 'document.open();document.write(html);document.close()'
assert s.count(anchor) == 1, 'photo ledger: document anchor missing'

if "photo-ledger.js?v=212" not in s:
    inject = "html=html.replace('</body>','<script src=\\\"./photo-ledger.js?v=212\\\"><\\/script></body>');"
    s = s.replace(anchor, inject + anchor, 1)
if "photo-ledger-damage.js?v=209" not in s:
    inject = "html=html.replace('</body>','<script src=\\\"./photo-ledger-damage.js?v=209\\\"><\\/script></body>');"
    s = s.replace(anchor, inject + anchor, 1)
if "photo-ledger-tensile.js?v=210" not in s:
    inject = "html=html.replace('</body>','<script src=\\\"./photo-ledger-tensile.js?v=210\\\"><\\/script></body>');"
    s = s.replace(anchor, inject + anchor, 1)
index.write_text(s, encoding='utf-8')

sw = ROOT / 'sentlog' / 'sw.js'
w = sw.read_text(encoding='utf-8')
missing = [
    name for name in ['photo-ledger.js', 'photo-ledger-damage.js', 'damage-ledger-template.xlsx', 'photo-ledger-tensile.js', 'tensile-ledger-template.b64']
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

import base64
tensile_asset=(ROOT / 'sentlog' / 'tensile-ledger-template.b64').read_text(encoding='ascii')
tensile_bytes=base64.b64decode(''.join(tensile_asset.split()),validate=True)
assert hashlib.sha256(tensile_bytes).hexdigest() == '3b9b4334e0fa2e369aaf305cbd51447003823028a582affd24cb2fd515fdfac1', 'Tensile Excel template integrity mismatch'
assert (ROOT / 'sentlog' / 'photo-ledger-tensile.js').is_file(), 'tensile photo ledger module missing'
print('Photo ledger integrated: 標準 / 損傷用 / 引張試験用 (A4 portrait original Excel layout)')

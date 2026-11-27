"""Add the isolated cloud-check link after the complete protected-startup build.

No release labels, service-worker lists, record stores or sync modules change.
The auth helper is a byte-identical copy under an uncached, independent name.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKER = 'sentlog-cloud-check-v1'
TOKEN = '20261127-cloud-check-1'
path = ROOT / 'sentlog/index.html'
value = path.read_text(encoding='utf-8')
before = 'box.append(title,message,retry,storageCheck,storageRestore);'
if (value.count(before) != 1 or value.count('await window.SentlogRecords.init();') != 1
        or value.count("title.textContent='セントログを開始できませんでした';") != 1
        or MARKER in value or 'cloud-check.html' in value):
    raise RuntimeError('Cloud check requires one complete, fresh protected-startup build')
worker = (ROOT / 'sentlog/sw.js').read_text(encoding='utf-8')
for name in ('cloud-check.html', 'cloud-check.js', 'cloud-check-auth.js'):
    if name in worker:
        raise RuntimeError('The independent cloud check must remain outside the app cache: ' + name)
auth = (ROOT / 'sentlog/session-guard.js').read_bytes()
if b'SentlogSessionGuard' not in auth or b'authGeneration' not in auth:
    raise RuntimeError('The verified session guard is missing')
after = ("/* " + MARKER + " */const cloudCheck=document.createElement('a');"
         "cloudCheck.href='./cloud-check.html?v=" + TOKEN + "';"
         "cloudCheck.textContent='アカウントとクラウドの保存状況を確認';"
         "cloudCheck.style.cssText=storageCheck.style.cssText;"
         'box.append(title,message,retry,storageCheck,storageRestore,cloudCheck);')
(ROOT / 'sentlog/cloud-check-auth.js').write_bytes(auth)
path.write_text(value.replace(before, after), encoding='utf-8')
print('Built independent cloud check: protected startup unchanged; no app-cache or sync changes')

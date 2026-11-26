"""Version startup-record protection after the complete v2.05 build."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-startup-protection-206'
MARKER = 'sentlog-startup-protection-v206'
PROOF_TOKEN = '20261127-durable-proof-read-206'
PROOF_MARKER = 'sentlog-durable-proof-read-v206'
OLD_TOKEN = '20261127-storage-recovery-204'
OLD_MARKER = 'sentlog-storage-recovery-v204'
OLD_LABEL = 'v2.05 · 起動前の保存状態確認'
NEW_LABEL = 'v2.06 · 記録保護・写真表示の安定化'
OLD_CACHE = 'sentlog-pwa-v247'
NEW_CACHE = 'sentlog-pwa-v248'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Startup protection integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
writer = source('sentlog/record-store.js')
adapter = source('sentlog/delta-sync-indexeddb.js')
worker = source('sentlog/sw.js')
if ('sentlog-startup-storage-v205' not in index
        or "['phone-runtime.js?v=205','v2.05']" not in index
        or MARKER in index or MARKER in writer
        or not writer.startswith('// ' + OLD_MARKER + '\n')
        or 'startupProtectionVersion:1' not in writer
        or 'readForVerification' not in writer or 'readForVerification' not in adapter
        or PROOF_MARKER in adapter
        or re.findall(r'sentlog-pwa-v\d+', worker) != [OLD_CACHE]):
    raise RuntimeError('Startup protection requires one complete, fresh v2.05 build and the protected writer')

pending['sentlog/record-store.js'] = '// ' + MARKER + '\n' + writer
pending['sentlog/delta-sync-indexeddb.js'] = '// ' + PROOF_MARKER + '\n' + adapter
old_url = 'record-store.js?v=' + OLD_TOKEN
new_url = 'record-store.js?v=' + TOKEN
for filename, count in [('sentlog/index.html', 2), ('sentlog-pc/index.html', 0),
                        ('sentlog/drawing-export-view.html', 0)]:
    references = re.findall(r'record-store\.js\?v=[A-Za-z0-9._-]+', source(filename))
    if references != [old_url] * count:
        raise RuntimeError('Unexpected record-store references: ' + filename)
    if count:
        change(filename, old_url, new_url, count)
change('sentlog/index.html', "['" + new_url + "','" + OLD_MARKER + "']",
       "['" + new_url + "','" + MARKER + "']")
old_proof_url = 'delta-sync-indexeddb.js?v=20261121-heavy-sync'
new_proof_url = 'delta-sync-indexeddb.js?v=' + PROOF_TOKEN
for filename, count in [('sentlog/index.html', 2), ('sentlog-pc/index.html', 0),
                        ('sentlog/drawing-export-view.html', 0)]:
    references = re.findall(r'delta-sync-indexeddb\.js\?v=[A-Za-z0-9._-]+', source(filename))
    if references != [old_proof_url] * count:
        raise RuntimeError('Unexpected delta adapter references: ' + filename)
    if count:
        change(filename, old_proof_url, new_proof_url, count)
change('sentlog/index.html', "['" + new_proof_url + "','SentlogDeltaIndexedDB']",
       "['" + new_proof_url + "','" + PROOF_MARKER + "']")
# The executed writer is checked before init(), which precedes the loader's
# dependency fetch. A stale cached writer must not touch partial records.
change('sentlog/index.html',
       'if(window.SentlogRecords?.getFileWriteCapabilities?.()?.fileWriteDedupVersion!==1)',
       'if(window.SentlogRecords?.startupProtectionVersion!==1||window.SentlogRecords?.getFileWriteCapabilities?.()?.fileWriteDedupVersion!==1)')
change('sentlog/index.html', 'phone-runtime.js?v=205', 'phone-runtime.js?v=206', 2)
change('sentlog/index.html', "'v2.05'", "'v2.06'")
change('sentlog-pc/index.html', OLD_LABEL, NEW_LABEL)
change('sentlog/phone-runtime.js', 'v2.05', 'v2.06', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.05', 'v2.06'), NEW_LABEL)
change('sentlog/sw.js', OLD_CACHE, NEW_CACHE)

for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(OLD_CACHE, NEW_CACHE).replace("'v2.05'", "'v2.06'")
    value = value.replace('phone-runtime.js?v=205', 'phone-runtime.js?v=206')
    value = value.replace(r'phone-runtime\.js\?v=205', r'phone-runtime\.js\?v=206')
    value = value.replace(OLD_LABEL, NEW_LABEL).replace(old_url, new_url)
    value = value.replace(r'record-store\.js\?v=' + OLD_TOKEN,
                          r'record-store\.js\?v=' + TOKEN)
    value = value.replace(old_proof_url, new_proof_url)
    value = value.replace(r'delta-sync-indexeddb\.js\?v=20261121-heavy-sync',
                          r'delta-sync-indexeddb\.js\?v=' + PROOF_TOKEN)
    value = value.replace('PASS v2.05 loader,', 'PASS v2.06 loader,')
    if value != old:
        pending[name] = value

# Keep the earlier multi-module release assertions, using the new writer's
# token/marker while all unrelated v2.04 modules retain their own versions.
test_name = 'tests/storage_recovery_release.test.cjs'
change(test_name,
       "for(const module of ['record-store','storage-ui','record-rescue','cloud-sync','photo-recovery']){",
       "for(const module of ['record-store','storage-ui','record-rescue','cloud-sync','photo-recovery']){\n"
       "  const currentToken=module==='record-store'?'" + TOKEN + "':token;\n"
       "  const currentMarker=module==='record-store'?'" + MARKER + "':marker;")
change(test_name, "module+'.js?v='+token+\"','\"+marker", "module+'.js?v='+currentToken+\"','\"+currentMarker")
change(test_name, "'./'+module+'.js?v='+token", "'./'+module+'.js?v='+currentToken")
change(test_name, "startsWith('// '+marker+'\\n')", "startsWith('// '+currentMarker+'\\n')")

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in ['record-store', 'delta-sync-indexeddb', 'phone-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.06: preserve partial records and stale-writer protection during verification; ' + NEW_CACHE)

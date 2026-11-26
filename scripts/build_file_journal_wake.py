"""Version bounded receive persistence and photo-file wake after v2.06."""
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-file-journal-wake-207'
MARKER = 'sentlog-file-journal-wake-v207'
RECEIVE_TOKEN = '20261127-bounded-receive-207'
RECEIVE_MARKER = 'sentlog-bounded-receive-v207'
OLD_LABEL = 'v2.06 · 記録保護・写真表示の安定化'
NEW_LABEL = 'v2.07 · 記録受信・写真同期の待機を改善'
OLD_CACHE = 'sentlog-pwa-v248'
NEW_CACHE = 'sentlog-pwa-v249'
OLD_URLS = {
    'delta-sync-app-runtime': '20261125-retain-media-5',
    'cloud-sync': '20261127-storage-recovery-204',
    'delta-sync-core': '20261121-heavy-sync',
}
OLD_MARKERS = {
    'delta-sync-app-runtime': 'SentlogDelta',
    'cloud-sync': 'sentlog-storage-recovery-v204',
    'delta-sync-core': 'SentlogDeltaSyncCore',
}
NEW_TOKENS = {module: RECEIVE_TOKEN if module == 'delta-sync-core' else TOKEN for module in OLD_URLS}
NEW_MARKERS = {module: RECEIVE_MARKER if module == 'delta-sync-core' else MARKER for module in OLD_URLS}
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'File-journal wake integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
runtime = source('sentlog/delta-sync-app-runtime.js')
cloud = source('sentlog/cloud-sync.js')
worker = source('sentlog/sw.js')
if ('sentlog-startup-protection-v206' not in index
        or "[5,'sentlog-photo-grid-layout-v1']" not in index
        or "['phone-runtime.js?v=206','v2.06']" not in index
        or 'onFileJournaled' not in runtime
        or 'onFileJournaled:({localProjectId})=>editSync.request([localProjectId])' not in cloud
        or MARKER in index or MARKER in runtime or MARKER in cloud
        or re.findall(r'sentlog-pwa-v\d+', worker) != [OLD_CACHE]):
    raise RuntimeError('File-journal wake requires one complete, fresh v2.06 build and its scoped callback')

for module, old_token in OLD_URLS.items():
    filename = 'sentlog/' + module + '.js'
    marker = NEW_MARKERS[module]
    pending[filename] = '// ' + marker + '\n' + source(filename)
    old_url, new_url = module + '.js?v=' + old_token, module + '.js?v=' + NEW_TOKENS[module]
    for page, count in [('sentlog/index.html', 2), ('sentlog-pc/index.html', 0),
                        ('sentlog/drawing-export-view.html', 0)]:
        references = re.findall(re.escape(module) + r'\.js\?v=[A-Za-z0-9._-]+', source(page))
        if references != [old_url] * count:
            raise RuntimeError('Unexpected file-journal wake references: ' + page + ': ' + module)
        if count:
            change(page, old_url, new_url, count)
    change('sentlog/index.html', "['" + new_url + "','" + OLD_MARKERS[module] + "']",
           "['" + new_url + "','" + marker + "']")

change('sentlog/index.html', 'phone-runtime.js?v=206', 'phone-runtime.js?v=207', 2)
change('sentlog/index.html', "'v2.06'", "'v2.07'")
change('sentlog-pc/index.html', OLD_LABEL, NEW_LABEL)
change('sentlog/phone-runtime.js', 'v2.06', 'v2.07', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.06', 'v2.07'), NEW_LABEL)
change('sentlog/sw.js', OLD_CACHE, NEW_CACHE)

# Advance only pinned release references, leaving every behavioral assertion
# and scheduler timing unchanged. Earlier safety-release checks still apply.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(OLD_CACHE, NEW_CACHE).replace("'v2.06'", "'v2.07'")
    value = value.replace('phone-runtime.js?v=206', 'phone-runtime.js?v=207')
    value = value.replace(r'phone-runtime\.js\?v=206', r'phone-runtime\.js\?v=207')
    value = value.replace(OLD_LABEL, NEW_LABEL)
    value = value.replace('PASS v2.06 loader,', 'PASS v2.07 loader,')
    for module, old_token in OLD_URLS.items():
        value = value.replace(module + '.js?v=' + old_token, module + '.js?v=' + NEW_TOKENS[module])
        value = value.replace(module + r'\.js\?v=' + old_token, module + r'\.js\?v=' + NEW_TOKENS[module])
    if value != old:
        pending[name] = value

test_name = 'tests/storage_recovery_release.test.cjs'
change(test_name,
       "const currentToken=module==='record-store'?'20261127-startup-protection-206':token;",
       "const currentToken=module==='record-store'?'20261127-startup-protection-206':module==='cloud-sync'?'" + TOKEN + "':token;")
change(test_name,
       "const currentMarker=module==='record-store'?'sentlog-startup-protection-v206':marker;",
       "const currentMarker=module==='record-store'?'sentlog-startup-protection-v206':module==='cloud-sync'?'" + MARKER + "':marker;")

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in ['delta-sync-app-runtime', 'cloud-sync', 'delta-sync-core', 'phone-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.07: persist bounded receive pages and wake changed photo-file journals; ' + NEW_CACHE)

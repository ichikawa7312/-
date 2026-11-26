"""Version the narrow semantic no-op guard after a complete v2.08 build."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-normalization-noop-209'
MARKER = 'sentlog-normalization-noop-v209'
OLD_TOKEN = '20261127-file-journal-wake-207'
OLD_MARKER = 'sentlog-file-journal-wake-v207'
OLD_LABEL = 'v2.08 · 起動停止時のバックアップ復旧'
NEW_LABEL = 'v2.09 · 同じ記録の不要な再保存を抑制'
OLD_CACHE = 'sentlog-pwa-v250'
NEW_CACHE = 'sentlog-pwa-v251'
GUARD = 'if(next!==text&&!window.SentlogRecordCollaboration.equal(JSON.parse(text),st))'
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Normalization no-op integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
cloud = source('sentlog/cloud-sync.js')
worker = source('sentlog/sw.js')
if ("['phone-runtime.js?v=208','v2.08']" not in index
        or '20261127-startup-backup-recovery-208' not in index
        or 'sentlog-startup-protection-v206' not in index
        or 'sentlog-bounded-receive-v207' not in index
        or not cloud.startswith('// ' + OLD_MARKER + '\n')
        or cloud.count(GUARD) != 1
        or MARKER in index or MARKER in cloud
        or re.findall(r'sentlog-pwa-v\d+', worker) != [OLD_CACHE]):
    raise RuntimeError('Normalization no-op requires a fresh complete v2.08 and the semantic guard')

pending['sentlog/cloud-sync.js'] = '// ' + MARKER + '\n' + cloud
old_url, new_url = 'cloud-sync.js?v=' + OLD_TOKEN, 'cloud-sync.js?v=' + TOKEN
for page, count in [('sentlog/index.html', 2), ('sentlog-pc/index.html', 0),
                    ('sentlog/drawing-export-view.html', 0)]:
    references = re.findall(r'cloud-sync\.js\?v=[A-Za-z0-9._-]+', source(page))
    if references != [old_url] * count:
        raise RuntimeError('Unexpected normalization runtime references: ' + page)
    if count:
        change(page, old_url, new_url, count)
change('sentlog/index.html', "['" + new_url + "','" + OLD_MARKER + "']",
       "['" + new_url + "','" + MARKER + "']")
change('sentlog/index.html', 'phone-runtime.js?v=208', 'phone-runtime.js?v=209', 2)
change('sentlog/index.html', "'v2.08'", "'v2.09'")
change('sentlog-pc/index.html', OLD_LABEL, NEW_LABEL)
change('sentlog/phone-runtime.js', 'v2.08', 'v2.09', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.08', 'v2.09'), NEW_LABEL)
change('sentlog/sw.js', OLD_CACHE, NEW_CACHE)

# Only the shell and cloud resource advance. The record writer, byte proof,
# CAS, receive batching, file wake callback and recovery page remain pinned.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(OLD_CACHE, NEW_CACHE).replace("'v2.08'", "'v2.09'")
    value = value.replace('phone-runtime.js?v=208', 'phone-runtime.js?v=209')
    value = value.replace(r'phone-runtime\.js\?v=208', r'phone-runtime\.js\?v=209')
    value = value.replace(OLD_LABEL, NEW_LABEL)
    value = value.replace(old_url, new_url)
    value = value.replace(r'cloud-sync\.js\?v=' + OLD_TOKEN, r'cloud-sync\.js\?v=' + TOKEN)
    if value != old:
        pending[name] = value

test = 'tests/file_journal_wake_release.test.cjs'
change(test, "  const url=module+'.js?v='+token;",
       "  const currentToken=module==='cloud-sync'?'" + TOKEN + "':token,"
       "currentMarker=module==='cloud-sync'?'" + MARKER + "':marker;\n"
       "  const url=module+'.js?v='+currentToken;")
change(test, '+marker+', '+currentMarker+', 2)
test = 'tests/storage_recovery_release.test.cjs'
change(test, "module==='cloud-sync'?'" + OLD_TOKEN + "':token",
       "module==='cloud-sync'?'" + TOKEN + "':token")
change(test, "module==='cloud-sync'?'" + OLD_MARKER + "':marker",
       "module==='cloud-sync'?'" + MARKER + "':marker")
change('tests/startup_backup_recovery_release.test.cjs',
       "['cloud-sync','" + OLD_TOKEN + "','" + OLD_MARKER + "']",
       "['cloud-sync','" + TOKEN + "','" + MARKER + "']")

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in ['cloud-sync', 'phone-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.09: preserve durable JSON bytes for semantically unchanged normalization; ' + NEW_CACHE)

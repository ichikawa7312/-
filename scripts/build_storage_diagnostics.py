"""Connect storage-growth guards and an on-demand inventory after the full build."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-storage-203'
MARKER = 'sentlog-storage-review-v203'
MODULES = ['record-store', 'storage-ui',
           'storage-diagnostics', 'storage-diagnostics-ui']
NEW_MODULES = ['storage-diagnostics', 'storage-diagnostics-ui']
WRITER_BOOT_CHECK = "if(window.SentlogRecords?.getFileWriteCapabilities?.()?.fileWriteDedupVersion!==1)throw Error('保存処理の最新版を読み込めませんでした。保存済みデータを変更せず起動を止めています。通信できる場所で、もう一度開いてください。');"
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Storage diagnosis integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index_name = 'sentlog/index.html'
if 'sentlog-sync-wait-v202' not in source(index_name):
    raise RuntimeError('Build storage diagnosis after build_sync_wait.py')
if MARKER in source(index_name):
    raise RuntimeError('Storage diagnosis requires a pristine production build')

# A separate dependency fetch cannot prove which cached writer executed in the
# head. Check that live API before init can migrate or update any local data.
change(index_name, 'await window.SentlogRecords.init();',
       WRITER_BOOT_CHECK + 'await window.SentlogRecords.init();')

# The existing lightweight panel does not measure the durable journal or the
# migration store. Keep its measurements and clearly disclose their scope.
change('sentlog/storage-ui.js',
       '<ul id="sentlogStorageLegend"',
       '<p>「セントログ内の集計」には、同期移行の控えやファイル履歴の全体は含まれていません。'
       '下の「内部の保存データを詳しく確認」で、これらの保存先も確認できます。</p>\n'
       '<ul id="sentlogStorageLegend"')

for name in MODULES:
    path = 'sentlog/' + name + '.js'
    if MARKER in source(path):
        raise RuntimeError('Storage module is already versioned: ' + name)
    pending[path] = '// ' + MARKER + '\n' + source(path)

versions = set()
for filename in ['sentlog/index.html', 'sentlog-pc/index.html', 'sentlog/drawing-export-view.html']:
    value = source(filename)
    prefix = '../sentlog/' if filename.startswith('sentlog-pc/') else './'
    if filename == index_name:
        scripts = ''.join('<script src="./' + name + '.js?v=' + TOKEN + '"><\\/script>'
                          for name in NEW_MODULES)
        match = re.search(r'<script src="\./storage-ui\.js[^\"]*"><\\/script>', value)
        if not match:
            raise RuntimeError('Missing settings storage integration')
        value = value[:match.end()] + scripts + value[match.end():]
        dependencies = ','.join("['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']"
                                for name in NEW_MODULES)
        if value.count('const deps=[') != 1:
            raise RuntimeError('Missing complete-release dependency list')
        value = value.replace('const deps=[', 'const deps=[' + dependencies + ',', 1)
    elif filename == 'sentlog-pc/index.html':
        if value.count('</body>') != 1:
            raise RuntimeError('Missing PC body integration')
        scripts = ''.join('<script src="' + prefix + name + '.js?v=' + TOKEN + '"></script>'
                          for name in NEW_MODULES)
        value = value.replace('</body>', scripts + '</body>', 1)
    for name in MODULES:
        pattern = re.escape(name) + r'\.js\?v=([A-Za-z0-9._-]+)'
        versions.update((name, version) for version in re.findall(pattern, value))
        value = re.sub(pattern, name + '.js?v=' + TOKEN, value)
        if filename == index_name:
            pattern = r"\['" + re.escape(name) + r"\.js\?v=" + re.escape(TOKEN) + r"','[^']+'\]"
            if len(re.findall(pattern, value)) != 1:
                raise RuntimeError('Missing complete-release check for ' + name)
            value = re.sub(pattern, "['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']", value)
    value = value.replace('phone-runtime.js?v=202', 'phone-runtime.js?v=203')
    value = value.replace("'v2.02'", "'v2.03'")
    value = value.replace('v2.02 · 同期の待機状況・進行表示', 'v2.03 · 保存データの増加対策と確認')
    pending[filename] = value

change('sentlog/phone-runtime.js', 'v2.02', 'v2.03', 4)
worker = source('sentlog/sw.js')
old_cache = re.search(r'sentlog-pwa-v\d+', worker).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 1)
worker = worker.replace(old_cache, new_cache)
if worker.count('const FILES=[') != 1:
    raise RuntimeError('Missing offline file inventory')
worker = worker.replace('const FILES=[', 'const FILES=[' +
                        ','.join(repr(name + '.js') for name in NEW_MODULES) + ',', 1)
pending['sentlog/sw.js'] = worker

# Earlier build steps deliberately update exact release expectations. Advance
# those same assertions for the final cache generation and module URLs.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(old_cache, new_cache).replace("'v2.02'", "'v2.03'")
    value = value.replace('phone-runtime.js?v=202', 'phone-runtime.js?v=203')
    value = value.replace(r'phone-runtime\.js\?v=202', r'phone-runtime\.js\?v=203')
    value = value.replace('v2.02 · 同期の待機状況・進行表示', 'v2.03 · 保存データの増加対策と確認')
    for module, version in versions:
        value = value.replace(module + '.js?v=' + version, module + '.js?v=' + TOKEN)
        value = value.replace(module + r'\.js\?v=' + version, module + r'\.js\?v=' + TOKEN)
    if value != old:
        pending[name] = value

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for name in MODULES:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
print('Built v2.03 storage-growth guards and manual, read-only storage diagnosis; ' + new_cache)

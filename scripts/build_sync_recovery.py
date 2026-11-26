"""Version the verified migration recovery and bounded photo audit as v1.99."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261126-sync-recovery-199'
MARKER = 'sentlog-migration-recovery-v199'
MODULES = ['record-store', 'cloud-sync', 'delta-sync-app-migration',
           'delta-sync-migration-recovery', 'delta-sync-asset-runtime', 'delta-sync-asset-transport']

for name in MODULES:
    path = ROOT / 'sentlog' / (name + '.js')
    source = path.read_text(encoding='utf-8')
    if MARKER in source:
        raise RuntimeError('Sync recovery requires a pristine build')
    path.write_text('// ' + MARKER + '\n' + source, encoding='utf-8')

versions = set()
for filename in ['sentlog/index.html', 'sentlog-pc/index.html', 'sentlog/drawing-export-view.html']:
    path = ROOT / filename
    source = path.read_text(encoding='utf-8')
    for name in MODULES:
        pattern = re.escape(name) + r'\.js\?v=([A-Za-z0-9._-]+)'
        versions.update((name, version) for version in re.findall(pattern, source))
        source = re.sub(pattern, name + '.js?v=' + TOKEN, source)
    source = source.replace('phone-runtime.js?v=198', 'phone-runtime.js?v=199')
    source = source.replace("'v1.98'", "'v1.99'")
    source = source.replace('v1.98 · 多角形の確定方向を安定化', 'v1.99 · 同期開始・不足ファイル復旧を修正')
    if filename == 'sentlog/index.html':
        for name in MODULES:
            pattern = r"\['" + re.escape(name) + r"\.js\?v=" + re.escape(TOKEN) + r"','[^']+'\]"
            if len(re.findall(pattern, source)) != 1:
                raise RuntimeError('Missing complete-release check for ' + name)
            source = re.sub(pattern, "['" + name + '.js?v=' + TOKEN + "','" + MARKER + "']", source)
    path.write_text(source, encoding='utf-8')

path = ROOT / 'sentlog/phone-runtime.js'
source = path.read_text(encoding='utf-8')
if source.count('v1.98') != 4:
    raise RuntimeError('Unexpected preceding phone version')
path.write_text(source.replace('v1.98', 'v1.99'), encoding='utf-8')

path = ROOT / 'sentlog/sw.js'
source = path.read_text(encoding='utf-8')
old_cache = re.search(r'sentlog-pwa-v\d+', source).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 1)
path.write_text(source.replace(old_cache, new_cache), encoding='utf-8')

for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    old = path.read_text(encoding='utf-8')
    source = old.replace(old_cache, new_cache).replace("'v1.98'", "'v1.99'")
    source = source.replace('phone-runtime.js?v=198', 'phone-runtime.js?v=199')
    source = source.replace(r'phone-runtime\.js\?v=198', r'phone-runtime\.js\?v=199')
    source = source.replace('v1.98 · 多角形の確定方向を安定化', 'v1.99 · 同期開始・不足ファイル復旧を修正')
    for name, version in versions:
        source = source.replace(name + '.js?v=' + version, name + '.js?v=' + TOKEN)
        source = source.replace(name + r'\.js\?v=' + version, name + r'\.js\?v=' + TOKEN)
    if source != old:
        path.write_text(source, encoding='utf-8')

for name in MODULES:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
subprocess.run(['node', 'tests/delta_migration_recovery.test.cjs'], cwd=ROOT, check=True)
print('Built v1.99 protected migration recovery, bounded photo audit; ' + new_cache)

"""Version the verified rescue and legacy receive fixes after the v2.03 build.

This changes static application resources only. No database, records, files,
authentication settings or cloud schema are migrated by this build step.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261127-storage-recovery-204'
MARKER = 'sentlog-storage-recovery-v204'
MODULES = ['record-store', 'storage-ui', 'record-rescue', 'project-rescue',
           'cloud-sync', 'photo-recovery']
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Storage recovery integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
if 'sentlog-storage-review-v203' not in index or MARKER in index:
    raise RuntimeError('Storage recovery requires one complete, fresh v2.03 build')

for module in MODULES:
    name = 'sentlog/' + module + '.js'
    pending[name] = '// ' + MARKER + '\n' + source(name)

versions = set()
for filename in ['sentlog/index.html', 'sentlog-pc/index.html', 'sentlog/drawing-export-view.html']:
    value = source(filename)
    for module in MODULES:
        pattern = re.escape(module) + r'\.js\?v=([A-Za-z0-9._-]+)'
        versions.update((module, version) for version in re.findall(pattern, value))
        value = re.sub(pattern, module + '.js?v=' + TOKEN, value)
        if filename == 'sentlog/index.html' and module != 'project-rescue':
            dependency = r"\['" + re.escape(module) + r"\.js\?v=" + re.escape(TOKEN) + r"','[^']+'\]"
            if len(re.findall(dependency, value)) != 1:
                raise RuntimeError('Missing complete-release dependency for ' + module)
            value = re.sub(dependency, "['" + module + '.js?v=' + TOKEN + "','" + MARKER + "']", value)
    value = value.replace('phone-runtime.js?v=203', 'phone-runtime.js?v=204')
    value = value.replace("'v2.03'", "'v2.04'")
    value = value.replace('v2.03 · 保存データの増加対策と確認', 'v2.04 · 保存失敗時の救出・受信保護')
    pending[filename] = value

change('sentlog/phone-runtime.js', 'v2.03', 'v2.04', 4)
# Earlier builders verify the historical worker's full hash. Apply this fetch
# correction only after those checks; keep install/activate requirements intact.
change('sentlog/sw.js', r'''    const cache=await caches.open(CACHE);
    try{const r=await fetch(event.request,{cache:'no-store'});if(!r.ok)throw new Error('Network response '+r.status);await cache.put(canonical,r.clone());return r}
    catch(e){const stored=await cache.match(canonical);if(stored)return stored;throw e}''', r'''    let response;
    try{response=await fetch(event.request,{cache:'no-store'});if(!response.ok)throw new Error('Network response '+response.status);}
    catch(error){
      try{const cache=await caches.open(CACHE),stored=await cache.match(canonical);if(stored)return stored;}catch{}
      throw error;
    }
    // Cache failure must not hide a successful online response behind stale
    // code. Installation still requires the complete static resource set.
    try{const cache=await caches.open(CACHE);await cache.put(canonical,response.clone());}catch{}
    return response;''')
worker = source('sentlog/sw.js')
old_cache = re.search(r'sentlog-pwa-v\d+', worker).group()
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 1)
pending['sentlog/sw.js'] = worker.replace(old_cache, new_cache)

# Retain the exact URL/cache assertions as the final generation advances.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    name = str(path.relative_to(ROOT))
    old = source(name)
    value = old.replace(old_cache, new_cache).replace("'v2.03'", "'v2.04'")
    value = value.replace('phone-runtime.js?v=203', 'phone-runtime.js?v=204')
    value = value.replace(r'phone-runtime\.js\?v=203', r'phone-runtime\.js\?v=204')
    value = value.replace('v2.03 · 保存データの増加対策と確認', 'v2.04 · 保存失敗時の救出・受信保護')
    for module, version in versions:
        value = value.replace(module + '.js?v=' + version, module + '.js?v=' + TOKEN)
        value = value.replace(module + r'\.js\?v=' + version, module + r'\.js\?v=' + TOKEN)
    if value != old:
        pending[name] = value

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for module in MODULES:
    subprocess.run(['node', '--check', 'sentlog/' + module + '.js'], cwd=ROOT, check=True)
print('Built v2.04: read-only emergency rescue, storage failure details and scoped legacy receiving; ' + new_cache)

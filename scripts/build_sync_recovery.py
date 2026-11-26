"""Version verified file recovery and explicit legacy PDF review as v2.01."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261126-drawing-recovery-201'
MARKER = 'sentlog-drawing-recovery-v201'
MODULES = ['record-store', 'cloud-sync', 'delta-sync-app-migration',
           'delta-sync-migration-recovery', 'delta-sync-drawing-review', 'delta-sync-asset-runtime', 'delta-sync-asset-transport',
           'delta-sync-legacy-source', 'delta-sync-migration', 'delta-sync-reconcile',
           'delta-sync-assets', 'delta-sync-transport', 'pdf-recovery', 'peer-photo-recovery', 'blob-sha256']

# The earlier archive/management builders bind exact historical source hashes.
# Keep their reviewed inputs intact and connect these two completed runtimes
# here, after those transformations, with exact integration-point guards.
HASH_CHANGES = {
    'sentlog/cloud-sync.js': (
        'async function sha256Hex(blob){',
        """async function sha256Hex(blob,options={}){
  if(window.SentlogBlobSha256?.digest)return window.SentlogBlobSha256.digest(blob,{crypto,...options});
  if(blob.size>2*1024*1024)throw Object.assign(Error('大きなファイルの内容照合機能を読み込めません。元の記録を保持しています'),{code:'BLOB_HASH_UPGRADE'});"""),
    'sentlog/pdf-recovery.js': (
        "async function hash(blob){if(localHashes.has(blob))return localHashes.get(blob);const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());const h=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');localHashes.set(blob,h);return h}",
        """async function hash(blob){
  if(localHashes.has(blob))return localHashes.get(blob);
  let h;
  if(window.SentlogBlobSha256?.digest)h=await window.SentlogBlobSha256.digest(blob,{crypto});
  else{
    if(blob.size>2*1024*1024)throw Object.assign(Error('大きな図面の内容照合機能を読み込めません。元の図面を保持しています'),{code:'BLOB_HASH_UPGRADE'});
    const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());h=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  }
  localHashes.set(blob,h);return h;
}""")
}
for filename, (old, new) in HASH_CHANGES.items():
    path = ROOT / filename
    source = path.read_text(encoding='utf-8')
    if source.count(old) != 1:
        raise RuntimeError('Bounded hashing integration changed: ' + filename)
    path.write_text(source.replace(old, new), encoding='utf-8')

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
    prefix = '../sentlog/' if filename.startswith('sentlog-pc/') else './'
    if 'blob-sha256.js' in source:
        raise RuntimeError('Bounded blob hashing requires a pristine build')
    blob_script = '<script src="' + prefix + 'blob-sha256.js?v=' + TOKEN + '"></script>'
    if filename == 'sentlog/index.html':
        boot_store = re.search(r'<script src="\./record-store\.js[^\"]*">', source)
        if not boot_store:
            raise RuntimeError('Missing boot-time record store')
        source = source[:boot_store.start()] + blob_script + source[boot_store.start():]
    else:
        source = source.replace('</head>', blob_script + '</head>', 1)
    if filename == 'sentlog/index.html':
        if source.count('const deps=[') != 1:
            raise RuntimeError('Missing complete-release dependency list')
        source = source.replace('const deps=[', "const deps=[['blob-sha256.js?v=" + TOKEN + "','" + MARKER + "'],", 1)
    for name in MODULES:
        pattern = re.escape(name) + r'\.js\?v=([A-Za-z0-9._-]+)'
        versions.update((name, version) for version in re.findall(pattern, source))
        source = re.sub(pattern, name + '.js?v=' + TOKEN, source)
    source = source.replace('phone-runtime.js?v=198', 'phone-runtime.js?v=201')
    source = source.replace("'v1.98'", "'v2.01'")
    source = source.replace('v1.98 · 多角形の確定方向を安定化', 'v2.01 · 同期が止まった図面の確認・復旧')
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
path.write_text(source.replace('v1.98', 'v2.01'), encoding='utf-8')

path = ROOT / 'sentlog/sw.js'
source = path.read_text(encoding='utf-8')
old_cache = re.search(r'sentlog-pwa-v\d+', source).group()
# The same preceding build generated v2.00 with +2. This release needs its own
# cache generation and new URLs for every changed runtime module.
new_cache = 'sentlog-pwa-v' + str(int(old_cache.rsplit('v', 1)[1]) + 3)
source = source.replace(old_cache, new_cache)
if source.count('const FILES=[') != 1:
    raise RuntimeError('Missing offline file inventory')
source = source.replace('const FILES=[', "const FILES=['blob-sha256.js',", 1)
path.write_text(source, encoding='utf-8')

for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.cjs', '.py'):
        continue
    old = path.read_text(encoding='utf-8')
    source = old.replace(old_cache, new_cache).replace("'v1.98'", "'v2.01'")
    source = source.replace('phone-runtime.js?v=198', 'phone-runtime.js?v=201')
    source = source.replace(r'phone-runtime\.js\?v=198', r'phone-runtime\.js\?v=201')
    source = source.replace('v1.98 · 多角形の確定方向を安定化', 'v2.01 · 同期が止まった図面の確認・復旧')
    for name, version in versions:
        source = source.replace(name + '.js?v=' + version, name + '.js?v=' + TOKEN)
        source = source.replace(name + r'\.js\?v=' + version, name + r'\.js\?v=' + TOKEN)
    source = source.replace("['peer-photo-recovery.js?v=" + TOKEN + "','sentlogCheckPeerPhotos']",
                            "['peer-photo-recovery.js?v=" + TOKEN + "','" + MARKER + "']")
    if source != old:
        path.write_text(source, encoding='utf-8')

for name in MODULES:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
subprocess.run(['node', 'tests/delta_migration_recovery.test.cjs'], cwd=ROOT, check=True)
print('Built v2.01 verified recovery, explicit legacy PDF review and bounded file work; ' + new_cache)

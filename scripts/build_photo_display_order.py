"""Apply photo presentation order after the production build, without protocol edits."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261126-camera-order-return-1'
pending = {}


def change(path, old, new, count=1):
    text = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    if text.count(old) != count:
        raise RuntimeError(f'Photo display order anchor mismatch: {path}: {old[:90]!r}')
    pending[path] = text.replace(old, new)


# Render a copy, never reorder the canonical record or its immutable revisions.
change('sentlog/part06.txt', 'const photos=s?.photos||[];',
       'const photos=window.SentlogPhotoDisplayOrder?.ordered(s?.photos||[])||(s?.photos||[]).slice();')
change('sentlog/photo-ledger.js',
       '''        declaredPhotos+=s.photos.length;
        for(let photoOrder=0;photoOrder<s.photos.length;photoOrder++){
          const photo=s.photos[photoOrder];''',
       '''        declaredPhotos+=s.photos.length;
        const orderedPhotos=root.SentlogPhotoDisplayOrder?.ordered(s.photos)||s.photos.slice();
        for(let photoOrder=0;photoOrder<orderedPhotos.length;photoOrder++){
          const photo=orderedPhotos[photoOrder];''')

# Reserve capture order alongside the photo identity, before any original or
# shared-image write. Persisted pending operations keep the same order on retry.
change('sentlog/collaboration-photos.js',
       'const entry={version:VERSION,operationId:op.operationId,inputId:op.inputId,photoId,index,target,',
       '''const entry={version:VERSION,operationId:op.operationId,inputId:op.inputId,photoId,index,target,
            captureDisplayOrder:{at:op.createdAt,batch:op.operationId,index},''')
change('sentlog/collaboration-photos.js',
       "const expected={id:current.photoId,name,createdAt:current.at,type:prepared.type||'image/jpeg',size:prepared.size,sha256};",
       """// Existing pending captures have no captureDisplayOrder. Do not add
          // metadata to those immutable retries or change their expected bytes.
          const expected={id:current.photoId,name,createdAt:current.at,type:prepared.type||'image/jpeg',size:prepared.size,sha256,
            ...(current.captureDisplayOrder?{captureDisplayOrder:clone(current.captureDisplayOrder)}:{})};""")

# The production loader verifies the helper payload before running the app.
# Standalone older test fixtures can still render with the original array order.
change('sentlog/index.html', 'const deps=[',
       "const deps=[['photo-display-order.js?v=" + TOKEN + "','SentlogPhotoDisplayOrder'],")
path = 'sentlog/index.html'
text = pending[path]
pattern = r'(<script src="\./record-collaboration\.js\?v=[^"]+"><\\/script>)'
text, count = re.subn(pattern, lambda m:
                     '<script src="./photo-display-order.js?v=' + TOKEN + '"><\\/script>' + m[1], text)
if count != 1:
    raise RuntimeError('Photo display order loader script anchor mismatch')
pending[path] = text
change('sentlog/sw.js', "'photo-ledger-stream.js'", "'photo-display-order.js','photo-ledger-stream.js'")

for path, text in pending.items():
    (ROOT / path).write_text(text, encoding='utf-8')
for name in ['photo-display-order', 'photo-ledger', 'collaboration-photos']:
    subprocess.run(['node', '--check', 'sentlog/' + name + '.js'], cwd=ROOT, check=True)
subprocess.run(['node', 'tests/photo_display_order.test.cjs'], cwd=ROOT, check=True)
print('Built photo display order: capture order in grid/default ledger, canonical records and manual drafts preserved')

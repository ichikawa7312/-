"""Add a tab-scoped camera return checkpoint after the production builders.

This late patch leaves record/Blob formats unchanged. The final release builder
owns shared script tokens and the service-worker cache revision.
"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261126-camera-order-return-1'
ASSET = 'camera-return.js'
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    found = source.count(old)
    if found != count:
        raise RuntimeError(f'Camera return integration changed: {path}: {old[:100]!r}; expected {count}, found {found}')
    pending[path] = source.replace(old, new)


index = (ROOT / 'sentlog/index.html').read_text(encoding='utf-8')
if ASSET in index:
    raise RuntimeError('Camera return is already built; use a pristine production build')
if not all(asset in index for asset in ('continuous-camera.js', 'collaboration-photos.js', 'sync-view.js')):
    raise RuntimeError('Build camera return after continuous capture and collaboration')

change('sentlog/index.html', 'const deps=[',
       "const deps=[['" + ASSET + "?v=" + TOKEN + "','sentlogCameraReturnV1'],")
# The API exists before initApp can finish. Navigation hooks are installed only
# after the base functions are declared, immediately before initApp starts.
change('sentlog/index.html', "let html=parts.join('');",
       "let html=parts.join('');html=html.replace('</head>','<script src=\"./" + ASSET +
       "?v=" + TOKEN + "\"></'+'script></head>');")
change('sentlog/part09.txt', 'window.sentlogAppReady=initApp();',
       'window.SentlogCameraReturn?.installNavigation();window.sentlogAppReady=initApp();')
change('sentlog/part07.txt', 'await migrateLegacyIfNeeded();renderSelectedPhotos();showProjects();',
       'await migrateLegacyIfNeeded();renderSelectedPhotos();if(window.SentlogCameraReturn)window.SentlogCameraReturn.initialView(showProjects);else showProjects();')

change('sentlog/continuous-camera.js',
       "      const target=photos().captureTarget();if(!target)throw Error('写真を追加する記録を選んでください。');",
       "      root.SentlogCameraReturn?.beforeCapture();\n"
       "      const target=photos().captureTarget();if(!target)throw Error('写真を追加する記録を選んでください。');\n"
       "      root.SentlogCameraReturn?.remember(target);")
change('sentlog/collaboration-photos.js',
       "  function prepareInput(inputId){\n    const target=captureTarget();if(!target)throw error('TARGET_REQUIRED','写真を追加する記録を選んでください');",
       "  function prepareInput(inputId){\n    root.SentlogCameraReturn?.beforeCapture();\n"
       "    const target=captureTarget();if(!target)throw error('TARGET_REQUIRED','写真を追加する記録を選んでください');\n"
       "    root.SentlogCameraReturn?.remember(target);")
# SessionGuard invokes onChange synchronously after account changes, including
# logout -> login to the same ID. Token refresh within one account preserves it.
change('sentlog/cloud-sync.js',
       'onChange:(s,required)=>{session=s;authNeedsLogin=required;updateCloudUI();}',
       "onChange:(s,required)=>{session=s;authNeedsLogin=required;window.SentlogCameraReturn?.accountChanged(s?.user?.id||'');updateCloudUI();}")
change('sentlog/sw.js', "'index.html'", "'index.html','" + ASSET + "'")

subprocess.run(['node', '--check', 'sentlog/' + ASSET], cwd=ROOT, check=True)
for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
subprocess.run(['node', 'tests/camera_return.test.cjs'], cwd=ROOT, check=True)
print('Built tab-scoped camera return with startup, navigation, selection, page and account fences')

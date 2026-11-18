"""Install the collaboration editor after the established production builders."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '20261118-collaboration'
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Collaboration editor integration changed: {path}: {old[:100]!r}; expected {count}, got {actual}')
    pending[path] = source.replace(old, new)


path = 'sentlog/sync-view.js'
change(path,
       'addPhotosToSelected=async function(){localOperation++;try{return await oldPhotos.apply(this,arguments);}finally{localOperation--;}};',
       'addPhotosToSelected=async function(){if(window.SentlogCollaborationPhotos)return oldPhotos.apply(this,arguments);localOperation++;try{return await oldPhotos.apply(this,arguments);}finally{localOperation--;}};')
change(path, 'if(document.hidden || localOperation || drawing',
       'if(document.hidden || localOperation || window.SentlogCollaborationPhotos?.isCommitting?.() || drawing')
change(path, "if(focus && focus.matches('input,select,textarea,[contenteditable=\"true\"]')){",
       "if(focus && !window.SentlogCollaboration?.isDraftElement?.(focus) && focus.matches('input,select,textarea,[contenteditable=\"true\"]')){")
change(path, "if(document.querySelector('.modal-backdrop.open,.photo-viewer.open'))return true;",
       "if(!window.SentlogCollaboration && document.querySelector('.modal-backdrop.open,.photo-viewer.open'))return true;")
change(path, "if(Object.entries(expected).some(([id,v])=>$(id) && $(id).value!==v))return true;",
       "if(Object.entries(expected).some(([id,v])=>{\n"
       "        const field=$(id);if(!field||field.value===v)return false;\n"
       "        const collaboration=window.SentlogCollaboration;\n"
       "        if(collaboration&&(id==='memo'||id==='frRecordMemo')&&field.readOnly===true)return false;\n"
       "        if((id==='member'||id==='damageType')&&collaboration?.isCapturedFieldDraft?.(field,s))return false;\n"
       "        return true;\n"
       "      }))return true;")
change(path, '      if(selected){\n        const oldRecord=',
       '      if(selected && !window.SentlogCollaboration){\n        const oldRecord=')
change(path, '    const project=clone(remote);project.id=id;',
       '    const editorDraft=window.SentlogCollaboration?.captureEditor?.();\n    const project=clone(remote);project.id=id;')
change(path,
       "      await window.SentlogRecords.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:mergeOptions.expectedRecords[0][1],expectedRecords:mergeOptions.expectedRecords,origin:'remote'});",
       "      // These are metadata-only writes. Validate and commit them in the same\n"
       "      // synchronous turn so a camera/input callback cannot race a state swap.\n"
       "      if(!mergeOptions.expectedRecords.every(([key,value])=>(window.SentlogRecords.getItem(key)??null)===value))return {applied:false,reason:'local-edit'};\n"
       "      window.SentlogRecords.batch(writes,{origin:'remote'});")
change(path, '        clearAllHistory();',
       '        if(window.SentlogCollaboration)window.SentlogCollaboration.onRemote();else clearAllHistory();')
change(path, "        updatePageUI();render();renderSelectedPhotos();",
       "        window.SentlogCollaboration?.restoreEditor?.(editorDraft);\n        updatePageUI();render();renderSelectedPhotos();")

change('sentlog/index.html', 'const deps=[',
       "const deps=[['collaboration-editor.js?v=" + TOKEN + "','SentlogCollaboration'],['collaboration-channel.js?v=" + TOKEN + "','SentlogCollaborationChannel'],")
anchor = 'document.open();document.write(html);document.close()'
loader = "html=html.replace('</body>','<script src=\"./collaboration-editor.js?v=" + TOKEN + "\"></'+'script></body>');"
change('sentlog/index.html', anchor, loader + anchor)
source = pending['sentlog/index.html']
cloud_script = '<script type="module" src="./cloud-sync.js?'
if source.count(cloud_script) != 1:
    raise RuntimeError('Cloud entry point changed')
source = source.replace(cloud_script,
                        '<script src="./collaboration-channel.js?v=' + TOKEN + '"><\\/script>' + cloud_script)
view_versions = re.findall(r'sync-view\.js\?v=([A-Za-z0-9_-]+)', source)
if len(view_versions) != 2 or len(set(view_versions)) != 1:
    raise RuntimeError('Collaboration sync-view loader references changed')
source = re.sub(r'sync-view\.js\?v=[A-Za-z0-9_-]+', 'sync-view.js?v=' + TOKEN, source)
pending['sentlog/index.html'] = source
change('sentlog/sw.js', "'index.html'", "'index.html','collaboration-editor.js','collaboration-channel.js'")
worker = pending['sentlog/sw.js']
match = re.search(r'sentlog-pwa-v(\d+)', worker)
if not match:
    raise RuntimeError('Offline cache revision missing')
old = match.group(0)
new = 'sentlog-pwa-v' + str(int(match.group(1)) + 1)
pending['sentlog/sw.js'] = worker.replace(old, new)
for file in (ROOT / 'tests').iterdir():
    if file.suffix not in ('.cjs', '.py'):
        continue
    content = file.read_text(encoding='utf-8')
    revised = content.replace(old, new)
    for version in set(view_versions):
        revised = revised.replace('sync-view.js?v=' + version, 'sync-view.js?v=' + TOKEN)
        revised = revised.replace(r'sync-view\.js\?v=' + version, r'sync-view\.js\?v=' + TOKEN)
    if revised != content:
        pending[str(file.relative_to(ROOT))] = revised
for name, content in pending.items():
    (ROOT / name).write_text(content, encoding='utf-8')
for name in ['collaboration-editor.js', 'collaboration-channel.js', 'sync-view.js']:
    subprocess.run(['node', '--check', 'sentlog/' + name], cwd=ROOT, check=True)
print('Built independent comment drafts, scalar confirmations, safe incoming commits and scoped undo')

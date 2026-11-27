"""Pause independent photo recovery during a known main-record save failure.

Run after the complete v2.11 build. This changes only the assembled photo module;
the release builder owns page references, versions and worker caches.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MARKER = 'sentlog-photo-save-failure-gate-v212'
PHOTO_PATH = ROOT / 'sentlog/photo-recovery.js'


def read(name):
    return (ROOT / name).read_text(encoding='utf-8')


source = PHOTO_PATH.read_text(encoding='utf-8')
writer = read('sentlog/record-store.js')
index = read('sentlog/index.html')
if ("['phone-runtime.js?v=211','v2.11']" not in index
        or 'sentlog-pdf-save-failure-gate-v211' not in read('sentlog/pdf-recovery.js')
        or not writer.startswith('// sentlog-storage-lifecycle-v210\n')
        or writer.count('storageLifecycleVersion:1') != 1
        or re.findall(r'sentlog-pwa-v\d+', read('sentlog/sw.js')) != ['sentlog-pwa-v253']
        or not source.startswith('// sentlog-storage-recovery-v204\n')
        or MARKER in source):
    raise RuntimeError('Photo save-failure gate requires a fresh complete v2.11 build')


def change(old, new, count=1):
    global source
    if source.count(old) != count:
        raise RuntimeError('Photo save-failure integration changed: ' + repr(old))
    source = source.replace(old, new)


# Keep the scope helper alongside the receive/ACK functions. Every existing
# validation point, including the transaction and queued receipt, must observe a
# newly failed record commit. Healthy pending records do not trip this check.
change(" async function receive(id){", """ function legacyPhotoStorageCheck(){
  // No separate pause latch: the original timer resumes after Records.retry().
  // PC redelivery does not use the main app's record store.
  if(!IS_PC&&window.SentlogRecords?.failed)
   throw Object.assign(Error('端末への保存エラーがあるため、写真の受信を停止しています。画面を閉じたり更新したりせず、まず記録の控えを書き出し、保存状態を確認してください。'),{code:'PHOTO_RECOVERY_STORAGE_FAILED'});
 }
 function captureLegacyPhotoReceiveScope(id){
  legacyPhotoStorageCheck();
  const scope=window.sentlogCaptureAssetReceiveScope(id);
  const validate=()=>{legacyPhotoStorageCheck();scope();};
  validate();return validate;
 }
 async function receive(id){""")

change("  const validate=window.sentlogCaptureAssetReceiveScope(id);",
       "  const validate=captureLegacyPhotoReceiveScope(id);", count=2)

change("  if(!active.size){show('');return;}",
       "  validate();\n  if(!active.size){show('');return;}")

# Storage failure is a cycle-wide prerequisite failure, not a single bad photo.
change("}catch(e){if(e?.code==='FILE_RECEIVE_SCOPE_CHANGED')throw e;errors.push",
       "}catch(e){if(e?.code==='FILE_RECEIVE_SCOPE_CHANGED'||e?.code==='PHOTO_RECOVERY_STORAGE_FAILED')throw e;errors.push")

change("  if(busy||!navigator.onLine||document.hidden||window.sentlogImporting||(!IS_PC&&!window.SentlogRecords?.ready))return;",
       "  if(busy||!navigator.onLine||document.hidden||window.sentlogImporting||(!IS_PC&&!window.SentlogRecords?.ready))return;\n  try{legacyPhotoStorageCheck();}catch(error){show(error.message);return;}")

source = '// ' + MARKER + '\n' + source
subprocess.run(['node', '--check', '--input-type=module'], input=source,
               text=True, cwd=ROOT, check=True, capture_output=True)
PHOTO_PATH.write_text(source, encoding='utf-8')
print('Built photo recovery gate for known local save failures')

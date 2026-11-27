"""Stop independent PDF recovery while the main app has a known save failure.

Run after the complete v2.10 build. This changes only the assembled PDF module;
the following release builder owns page references, versions and worker caches.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MARKER = 'sentlog-pdf-save-failure-gate-v211'
PDF_PATH = ROOT / 'sentlog/pdf-recovery.js'


def read(name):
    return (ROOT / name).read_text(encoding='utf-8')


source = PDF_PATH.read_text(encoding='utf-8')
writer = read('sentlog/record-store.js')
index = read('sentlog/index.html')
if ("['phone-runtime.js?v=210','v2.10']" not in index
        or 'sentlog-storage-lifecycle-v210' not in index
        or not writer.startswith('// sentlog-storage-lifecycle-v210\n')
        or writer.count('storageLifecycleVersion:1') != 1
        or re.findall(r'sentlog-pwa-v\d+', read('sentlog/sw.js')) != ['sentlog-pwa-v252']
        or not source.startswith('// sentlog-drawing-recovery-v201\n')
        or MARKER in source):
    raise RuntimeError('PDF save-failure gate requires a fresh complete v2.10 build')


def change(old, new, count=1):
    global source
    if source.count(old) != count:
        raise RuntimeError('PDF save-failure integration changed: ' + repr(old))
    source = source.replace(old, new)


change("const PDF_HANDOVER_STATUS=", """const PDF_STORAGE_FAILED_STATUS='端末への保存エラーがあるため、PDFの受信・再送を停止しています。画面を閉じたり更新したりせず、まず記録の控えを書き出し、保存状態を確認してください。';
function legacyPdfStorageCheck(){
  // A normal pending save is not a failure. Do not create another pause latch:
  // the existing scheduler can resume when the record-store retry succeeds.
  // The PC sender does not use the main app's Records store.
  if(!IS_PC&&window.SentlogRecords?.failed)
    throw Object.assign(Error(PDF_STORAGE_FAILED_STATUS),{code:'PDF_RECOVERY_STORAGE_FAILED'});
}
const PDF_HANDOVER_STATUS=""")

# The same check runs inside the existing writeFile.validate callback, not just
# before its awaits. A save failure during enqueue still aborts that file tx.
change("  if(legacyPdfBlocked(a.project_id))throw Object.assign(Error(PDF_HANDOVER_STATUS),{code:'JOURNAL_PDF_HANDOVER'});",
       "  legacyPdfStorageCheck();\n  if(legacyPdfBlocked(a.project_id))throw Object.assign(Error(PDF_HANDOVER_STATUS),{code:'JOURNAL_PDF_HANDOVER'});")

change("  if(busy || !navigator.onLine || document.hidden || window.sentlogImporting || (!IS_PC && !window.SentlogRecords?.ready))return;",
       "  if(busy || !navigator.onLine || document.hidden || window.sentlogImporting || (!IS_PC && !window.SentlogRecords?.ready))return;\n  try{legacyPdfStorageCheck();}catch(error){status(error.message);return;}")

# Inventory reads may span a newly failed record commit. Stop before either the
# supply loop or the receive loop begins, even if all assets would be deferred.
change("    const states=IS_PC?await api('rpc/sentlog_archive_v1',{p_action:'list'}):null;",
       "    const states=IS_PC?await api('rpc/sentlog_archive_v1',{p_action:'list'}):null;\n    legacyPdfStorageCheck();")

change("try{if(await supply(a,id,receiveActor))supplied++}catch(e){if(deliveryGuard.isTransient(e))throw e;",
       "try{if(await supply(a,id,receiveActor))supplied++}catch(e){if(e?.code==='PDF_RECOVERY_STORAGE_FAILED'||deliveryGuard.isTransient(e))throw e;")

change("      }catch(e){\n        if(legacyPdfDeferred(e)){total--;deferredNames.push(a.file_name||'図面PDF');continue;}",
       "      }catch(e){\n        if(e?.code==='PDF_RECOVERY_STORAGE_FAILED')throw e;\n        if(legacyPdfDeferred(e)){total--;deferredNames.push(a.file_name||'図面PDF');continue;}")

change("async function recoverDrawingNow(drawingId){\n  if(!drawingId||!navigator.onLine)return false;",
       "async function recoverDrawingNow(drawingId){\n  if(!drawingId||!navigator.onLine)return false;\n  legacyPdfStorageCheck();")

# A known main-store failure cannot be repaired by the targeted 2.5-second PDF
# retry loop. End this attempt; its existing finally releases the drawing slot.
change("      try{if(await recoverDrawingNow(drawingId))return true;}catch(e){\n        if(legacyPdfDeferred(e)){status(PDF_HANDOVER_STATUS);return false;}",
       "      try{if(await recoverDrawingNow(drawingId))return true;}catch(e){\n        if(e?.code==='PDF_RECOVERY_STORAGE_FAILED'){status(e.message);return false;}\n        if(legacyPdfDeferred(e)){status(PDF_HANDOVER_STATUS);return false;}")

source = '// ' + MARKER + '\n' + source
# Validate the complete module before writing any assembled resource.
subprocess.run(['node', '--check', '--input-type=module'], input=source,
               text=True, cwd=ROOT, check=True, capture_output=True)
PDF_PATH.write_text(source, encoding='utf-8')
print('Built PDF recovery gate for known local save failures')

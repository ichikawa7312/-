"""v1.58 after v1.57: ship the image restoration guard with fresh cache URLs.
Only static app resources and build-version assertions are changed.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path)
    if source is None:
        source = (ROOT / path).read_text(encoding='utf-8')
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Image recovery view mismatch: {path}: {old[:70]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


# The original runtime is hash-guarded by earlier build stages; apply the fix
# only after those stages have validated and assembled the current release.
change('sentlog/phone-runtime.js', '''  window.sentlogRestoreDrawingView = async function (id, file) {
    if (typeof activeDrawingId !== 'undefined' && activeDrawingId === id && typeof pdfDoc !== 'undefined' && !pdfDoc && typeof openFile === 'function') {
      await openFile(file, false);
    }
  };''', '''  // image-restore-guard-v158: pdfDoc is null for a successfully displayed image.
  // Restore only an empty editor; periodic file verification must never refit it.
  let restoringDrawing=false;
  window.sentlogRestoreDrawingView = async function (id, file) {
    if (restoringDrawing || typeof currentView==='undefined' || currentView!=='editor' ||
        typeof activeDrawingId==='undefined' || activeDrawingId!==id || !file ||
        typeof empty==='undefined' || empty.style.display==='none' ||
        (typeof loading!=='undefined' && loading.style.display==='grid') ||
        typeof openFile!=='function' || window.sentlogSyncView?.canRestoreDrawing?.(id)===false) return;
    restoringDrawing=true;
    try { await openFile(file, false); }
    finally { restoringDrawing=false; }
  };''')
change('sentlog/sync-view.js', '  window.sentlogSyncView={snapshotText,commit,', '''  function canRestoreDrawing(id){
    return currentView==='editor' && activeDrawingId===id && empty.style.display!=='none' && !busy();
  }
  window.sentlogSyncView={snapshotText,commit,canRestoreDrawing,''')
change('sentlog/sync-view.js',
       "if(currentView==='editor' && activeDrawingId===id && empty.style.display!=='none' && !busy())await window.sentlogRestoreDrawingView?.(id,file);",
       "if(canRestoreDrawing(id))await window.sentlogRestoreDrawingView?.(id,file);")

p = 'sentlog/index.html'
change(p, 'phone-runtime.js?v=157', 'phone-runtime.js?v=158', 2)
change(p, "['phone-runtime.js?v=158','v1.57']",
       "['phone-runtime.js?v=158','v1.58']")
change(p, 'sync-view.js?v=157', 'sync-view.js?v=158', 2)
change(p, "['sync-view.js?v=158','no-symbol-draft-guard-v157']",
       "['sync-view.js?v=158','canRestoreDrawing']")
change('sentlog/phone-runtime.js', 'v1.57', 'v1.58', 4)
change('sentlog/sw.js', "const CACHE='sentlog-pwa-v168';", "const CACHE='sentlog-pwa-v169';")

# Earlier builders advance the assertions along with each historic build.
# Keep existing behavioral tests pointed at the final deployed version.
for name, count in {
    'full_management.py': 1, 'full_archive_click.py': 1, 'capacity_ui.py': 1,
    'shape_move_ui.py': 1, 'instant_damage_type_ui.py': 1, 'overview_labels_ui.py': 1,
    'polygon_snap_ui.py': 1, 'polygon_dimensions_ui.py': 1, 'toolbar_icons_ui.py': 1,
    'damage_catalog_ui.py': 2, 'damage_styles_ui.py': 2, 'label_colors_ui.py': 2,
    'toolbar_help_ui.py': 1, 'plain_numbers_ui.py': 2, 'single_number_ui.py': 2,
    'optional_symbol_ui.py': 2,
}.items():
    change('tests/' + name, "window.SENTLOG_BUILD==='v1.57'", "window.SENTLOG_BUILD==='v1.58'", count)
for name in ('capacity.test.cjs', 'resilience.test.cjs', 'toolbar_icons.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, "'v1.57'", "'v1.58'")
for name in ('toolbar_icons.test.cjs', 'damage_styles.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, 'sentlog-pwa-v168', 'sentlog-pwa-v169')
change('tests/optional_symbol_ui.test.cjs', 'sync-view.js?v=157', 'sync-view.js?v=158')
change('tests/optional_symbol_ui.test.cjs', "'no-symbol-draft-guard-v157'", "'canRestoreDrawing'")

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built Sentlog v1.58: verified image backgrounds stay displayed without resetting zoom or pan')

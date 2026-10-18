"""Sentlog v1.70 after v1.69: add new drawings directly from the editor sidebar."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
pending={}

def change(path,old,new,count=1):
    source=pending.get(path)
    if source is None:
        source=(ROOT/path).read_text(encoding='utf-8')
    actual=source.count(old)
    if actual!=count:
        raise RuntimeError(f'Editor-drawing-add build mismatch: {path}: {old[:100]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)

p='sentlog/index.html'
change(p,
       "['drawing-list-actions.js?v=169','SentlogDrawingListActions']",
       "['drawing-list-actions.js?v=169','SentlogDrawingListActions'],['editor-drawing-add.js?v=170','SentlogEditorDrawingAdd']")
change(p,
       '<script src="./drawing-list-actions.js?v=169"><\/script>',
       '<script src="./drawing-list-actions.js?v=169"><\/script><script src="./editor-drawing-add.js?v=170"><\/script>')
change(p,'phone-runtime.js?v=169','phone-runtime.js?v=170',2)
change(p,"['phone-runtime.js?v=170','v1.69']","['phone-runtime.js?v=170','v1.70']")
change('sentlog/phone-runtime.js','v1.69','v1.70',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v180';","const CACHE='sentlog-pwa-v181';")
change(p,
       "'drawing-list-actions.js','sync-view.js'",
       "'drawing-list-actions.js','editor-drawing-add.js','sync-view.js'")

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.69'","window.SENTLOG_BUILD==='v1.70'",count)
change('tests/image_memory_ui.py',"window.SENTLOG_BUILD==='v1.69'","window.SENTLOG_BUILD==='v1.70'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.69'","'v1.70'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v180','sentlog-pwa-v181')

change('tests/original_photo_store.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=169/);",
       "assert.match(index,/phone-runtime\\.js\\?v=170/);")
change('tests/original_photo_store.test.cjs',
       "assert.match(sw,/sentlog-pwa-v180/);",
       "assert.match(sw,/sentlog-pwa-v181/);")
change('tests/crack_width.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=169/);",
       "assert.match(index,/phone-runtime\\.js\\?v=170/);")
change('tests/crack_width.test.cjs',
       "assert.match(sw,/sentlog-pwa-v180/);",
       "assert.match(sw,/sentlog-pwa-v181/);")
change('tests/field_records.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=169/);",
       "assert.match(index,/phone-runtime\\.js\\?v=170/);")
change('tests/field_records.test.cjs',
       "assert.match(sw,/sentlog-pwa-v180/);",
       "assert.match(sw,/sentlog-pwa-v181/);")
change('tests/drawing_list_actions.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=169/);",
       "assert.match(index,/phone-runtime\\.js\\?v=170/);")
change('tests/drawing_list_actions.test.cjs',
       "assert.match(sw,/sentlog-pwa-v180/);",
       "assert.match(sw,/sentlog-pwa-v181/);")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.70: add drawing from editor sidebar without replacing current drawing')

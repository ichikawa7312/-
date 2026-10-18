"""Sentlog v1.71 after v1.70: drawing numbers contain multiple drawing sheets."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
pending={}

def change(path,old,new,count=1):
    source=pending.get(path)
    if source is None:
        source=(ROOT/path).read_text(encoding='utf-8')
    actual=source.count(old)
    if actual!=count:
        raise RuntimeError(f'Drawing-group build mismatch: {path}: {old[:100]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)

p='sentlog/index.html'
change(p,
       "['editor-drawing-add.js?v=170','SentlogEditorDrawingAdd']",
       "['editor-drawing-add.js?v=170','SentlogEditorDrawingAdd'],['drawing-groups.js?v=171','SentlogDrawingGroups']")
change(p,
       '<script src="./editor-drawing-add.js?v=170"><\/script>',
       '<script src="./editor-drawing-add.js?v=170"><\/script><script src="./drawing-groups.js?v=171"><\/script>')
change(p,'phone-runtime.js?v=170','phone-runtime.js?v=171',2)
change(p,"['phone-runtime.js?v=171','v1.70']","['phone-runtime.js?v=171','v1.71']")
change('sentlog/phone-runtime.js','v1.70','v1.71',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v181';","const CACHE='sentlog-pwa-v182';")
change(p,
       "'editor-drawing-add.js','sync-view.js'",
       "'editor-drawing-add.js','drawing-groups.js','sync-view.js'")

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.70'","window.SENTLOG_BUILD==='v1.71'",count)
change('tests/image_memory_ui.py',"window.SENTLOG_BUILD==='v1.70'","window.SENTLOG_BUILD==='v1.71'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.70'","'v1.71'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v181','sentlog-pwa-v182')

for name in ('original_photo_store.test.cjs','crack_width.test.cjs','field_records.test.cjs','drawing_list_actions.test.cjs','editor_drawing_add.test.cjs'):
    change('tests/'+name,
           "assert.match(index,/phone-runtime\\.js\\?v=170/);",
           "assert.match(index,/phone-runtime\\.js\\?v=171/);")
    change('tests/'+name,
           "assert.match(sw,/sentlog-pwa-v181/);",
           "assert.match(sw,/sentlog-pwa-v182/);")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.71: drawing-number groups with multiple nested drawing sheets')

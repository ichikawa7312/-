"""Sentlog v1.69 after v1.68: rename/delete controls on the drawing list."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
pending={}

def change(path,old,new,count=1):
    source=pending.get(path)
    if source is None:
        source=(ROOT/path).read_text(encoding='utf-8')
    actual=source.count(old)
    if actual!=count:
        raise RuntimeError(f'Drawing-list build mismatch: {path}: {old[:100]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)

p='sentlog/index.html'
change(p,
       "['field-records.js?v=168','SentlogFieldRecords']",
       "['field-records.js?v=168','SentlogFieldRecords'],['drawing-list-actions.js?v=169','SentlogDrawingListActions']")
change(p,
       '<script src="./field-records.js?v=168"><\/script>',
       '<script src="./field-records.js?v=168"><\/script><script src="./drawing-list-actions.js?v=169"><\/script>')
change(p,'original-photo-store.js?v=162','original-photo-store.js?v=169',2)
change(p,'phone-runtime.js?v=168','phone-runtime.js?v=169',2)
change(p,"['phone-runtime.js?v=169','v1.68']","['phone-runtime.js?v=169','v1.69']")
change('sentlog/phone-runtime.js','v1.68','v1.69',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v179';","const CACHE='sentlog-pwa-v180';")
change(p,
       "'field-records.js','sync-view.js'",
       "'field-records.js','drawing-list-actions.js','sync-view.js'")

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.68'","window.SENTLOG_BUILD==='v1.69'",count)
change('tests/image_memory_ui.py',"window.SENTLOG_BUILD==='v1.68'","window.SENTLOG_BUILD==='v1.69'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.68'","'v1.69'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v179','sentlog-pwa-v180')

change('tests/original_photo_store.test.cjs',
       "assert.match(index,/original-photo-store\\.js\\?v=162/);",
       "assert.match(index,/original-photo-store\\.js\\?v=169/);")
change('tests/original_photo_store.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=168/);",
       "assert.match(index,/phone-runtime\\.js\\?v=169/);")
change('tests/original_photo_store.test.cjs',
       "assert.match(sw,/sentlog-pwa-v179/);",
       "assert.match(sw,/sentlog-pwa-v180/);")
change('tests/crack_width.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=168/);",
       "assert.match(index,/phone-runtime\\.js\\?v=169/);")
change('tests/crack_width.test.cjs',
       "assert.match(sw,/sentlog-pwa-v179/);",
       "assert.match(sw,/sentlog-pwa-v180/);")
change('tests/field_records.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=168/);",
       "assert.match(index,/phone-runtime\\.js\\?v=169/);")
change('tests/field_records.test.cjs',
       "assert.match(sw,/sentlog-pwa-v179/);",
       "assert.match(sw,/sentlog-pwa-v180/);")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.69: drawing-list rename/delete actions with protected original photos')

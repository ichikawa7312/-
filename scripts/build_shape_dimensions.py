"""Sentlog v1.74 after v1.73: completed-shape dimensions and label summaries.
No stored schema migration. Real dimensions appear only on calibrated pages.
"""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
pending={}

def change(path,old,new,count=1):
    source=pending.get(path)
    if source is None:
        source=(ROOT/path).read_text(encoding='utf-8')
    actual=source.count(old)
    if actual!=count:
        raise RuntimeError(f'Shape-dimension build mismatch: {path}: {old[:120]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)

p='sentlog/index.html'
change(p,
       "['dimension-lines.js?v=173','SentlogDimensionLines']",
       "['dimension-lines.js?v=173','SentlogDimensionLines'],['shape-dimensions.js?v=174','SentlogShapeDimensions']")
change(p,
       '<script src="./dimension-lines.js?v=173"><\/script>',
       '<script src="./dimension-lines.js?v=173"><\/script><script src="./shape-dimensions.js?v=174"><\/script>')
change(p,'phone-runtime.js?v=173','phone-runtime.js?v=174',2)
change(p,"['phone-runtime.js?v=174','v1.73']","['phone-runtime.js?v=174','v1.74']")
change('sentlog/phone-runtime.js','v1.73','v1.74',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v184';","const CACHE='sentlog-pwa-v185';")
change(p,
       "'dimension-lines.js','sync-view.js'",
       "'dimension-lines.js','shape-dimensions.js','sync-view.js'")

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.73'","window.SENTLOG_BUILD==='v1.74'",count)
change('tests/image_memory_ui.py',"window.SENTLOG_BUILD==='v1.73'","window.SENTLOG_BUILD==='v1.74'")
change('tests/dimension_lines_ui.py',"window.SENTLOG_BUILD==='v1.73'","window.SENTLOG_BUILD==='v1.74'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.73'","'v1.74'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v184','sentlog-pwa-v185')

for name in ('original_photo_store.test.cjs','crack_width.test.cjs','field_records.test.cjs','drawing_list_actions.test.cjs','editor_drawing_add.test.cjs','drawing_groups.test.cjs'):
    change('tests/'+name,
           "assert.match(index,/phone-runtime\.js\?v=173/);",
           "assert.match(index,/phone-runtime\.js\?v=174/);")
    change('tests/'+name,
           "assert.match(sw,/sentlog-pwa-v184/);",
           "assert.match(sw,/sentlog-pwa-v185/);")
change('tests/group_sync_migration.test.cjs',
       "assert.match(index,/phone-runtime\.js\?v=173/);",
       "assert.match(index,/phone-runtime\.js\?v=174/);")
change('tests/group_sync_migration.test.cjs',
       "assert.match(sw,/sentlog-pwa-v184/);",
       "assert.match(sw,/sentlog-pwa-v185/);")
change('tests/dimension_lines.test.cjs',
       "assert.match(index,/phone-runtime\.js\?v=173/);",
       "assert.match(index,/phone-runtime\.js\?v=174/);")
change('tests/dimension_lines.test.cjs',
       "assert.match(sw,/sentlog-pwa-v184/);",
       "assert.match(sw,/sentlog-pwa-v185/);")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.74: rectangle/polygon side lengths + representative second-line values')

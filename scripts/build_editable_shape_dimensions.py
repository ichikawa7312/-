"""Sentlog v1.75 after v1.74: editable completed-shape edge dimensions.
Unscaled pages store dimension records without moving geometry. Calibrated pages
resize rectangle/polygon geometry to the entered real edge length.
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
        raise RuntimeError(f'Editable shape-dimension build mismatch: {path}: {old[:120]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)

p='sentlog/index.html'
change(p,'shape-dimensions.js?v=174','shape-dimensions.js?v=175',2)
change(p,'phone-runtime.js?v=174','phone-runtime.js?v=175',2)
change(p,"['phone-runtime.js?v=175','v1.74']","['phone-runtime.js?v=175','v1.75']")
change('sentlog/phone-runtime.js','v1.74','v1.75',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v185';","const CACHE='sentlog-pwa-v186';")

p='sentlog/sync-view.js'
change(p,
       "window.SentlogPolygonDimensions?.isEditing?.() || window.SentlogDimensionLines?.isEditing?.()",
       "window.SentlogPolygonDimensions?.isEditing?.() || window.SentlogDimensionLines?.isEditing?.() || window.SentlogShapeDimensions?.isEditing?.()")

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.74'","window.SENTLOG_BUILD==='v1.75'",count)
for name in ('image_memory_ui.py','dimension_lines_ui.py','shape_dimensions_ui.py'):
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.74'","window.SENTLOG_BUILD==='v1.75'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.74'","'v1.75'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v185','sentlog-pwa-v186')

for name in ('original_photo_store.test.cjs','crack_width.test.cjs','field_records.test.cjs','drawing_list_actions.test.cjs','editor_drawing_add.test.cjs','drawing_groups.test.cjs'):
    change('tests/'+name,
           "assert.match(index,/phone-runtime\\.js\\?v=174/);",
           "assert.match(index,/phone-runtime\\.js\\?v=175/);")
    change('tests/'+name,
           "assert.match(sw,/sentlog-pwa-v185/);",
           "assert.match(sw,/sentlog-pwa-v186/);")
for name in ('group_sync_migration.test.cjs','dimension_lines.test.cjs','shape_dimensions.test.cjs'):
    change('tests/'+name,
           "assert.match(index,/phone-runtime\\.js\\?v=174/);",
           "assert.match(index,/phone-runtime\\.js\\?v=175/);")
    change('tests/'+name,
           "assert.match(sw,/sentlog-pwa-v185/);",
           "assert.match(sw,/sentlog-pwa-v186/);")
change('tests/shape_dimensions.test.cjs',
       "assert.match(index,/shape-dimensions\\.js\\?v=174/);",
       "assert.match(index,/shape-dimensions\\.js\\?v=175/);")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.75: unscaled dimension records + calibrated rectangle/polygon edge resizing')

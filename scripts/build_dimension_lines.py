"""Sentlog v1.73 after v1.72: independent dimension-line annotations.
No Supabase schema or user files are migrated. Dimension records stay in the
existing drawing state and are ignored by normal damage numbering/counts.
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
        raise RuntimeError(f'Dimension-line build mismatch: {path}: {old[:120]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)

p='sentlog/index.html'
change(p,
       "['drawing-groups.js?v=172','SentlogDrawingGroups']",
       "['drawing-groups.js?v=172','SentlogDrawingGroups'],['dimension-lines.js?v=173','SentlogDimensionLines']")
change(p,
       '<script src="./drawing-groups.js?v=172"><\\/script>',
       '<script src="./drawing-groups.js?v=172"><\\/script><script src="./dimension-lines.js?v=173"><\\/script>')
change(p,'phone-runtime.js?v=172','phone-runtime.js?v=173',2)
change(p,"['phone-runtime.js?v=173','v1.72']","['phone-runtime.js?v=173','v1.73']")
change('sentlog/phone-runtime.js','v1.72','v1.73',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v183';","const CACHE='sentlog-pwa-v184';")
change(p,
       "'drawing-groups.js','sync-view.js'",
       "'drawing-groups.js','dimension-lines.js','sync-view.js'")

p='sentlog/sync-view.js'
change(p,
       "window.SentlogShapeMove?.isEditing?.() || window.SentlogPolygonDimensions?.isEditing?.())return true;",
       "window.SentlogShapeMove?.isEditing?.() || window.SentlogPolygonDimensions?.isEditing?.() || window.SentlogDimensionLines?.isEditing?.())return true;")

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.72'","window.SENTLOG_BUILD==='v1.73'",count)
change('tests/image_memory_ui.py',"window.SENTLOG_BUILD==='v1.72'","window.SENTLOG_BUILD==='v1.73'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.72'","'v1.73'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v183','sentlog-pwa-v184')

for name in ('original_photo_store.test.cjs','crack_width.test.cjs','field_records.test.cjs','drawing_list_actions.test.cjs','editor_drawing_add.test.cjs','drawing_groups.test.cjs'):
    change('tests/'+name,
           "assert.match(index,/phone-runtime\\.js\\?v=172/);",
           "assert.match(index,/phone-runtime\\.js\\?v=173/);")
    change('tests/'+name,
           "assert.match(sw,/sentlog-pwa-v183/);",
           "assert.match(sw,/sentlog-pwa-v184/);")
change('tests/group_sync_migration.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=172/);",
       "assert.match(index,/phone-runtime\\.js\\?v=173/);")
change('tests/group_sync_migration.test.cjs',
       "assert.match(sw,/sentlog-pwa-v183/);",
       "assert.match(sw,/sentlog-pwa-v184/);")

change('tests/toolbar_icons_ui.py',
       "assert page.locator('#sentlogDrawingToolbar button').count()==8",
       "assert page.locator('#sentlogDrawingToolbar button').count()==9")
change('tests/toolbar_icons_ui.py',
       "assert page.locator('#sentlogDrawingToolbar svg').count()==8",
       "assert page.locator('#sentlogDrawingToolbar svg').count()==9")
change('tests/toolbar_icons_ui.py',
       "rows=len({round(r['y']) for r in bounds});assert rows==(2 if width<=360 else 1),(width,rows,bounds)",
       "rows=len({round(r['y']) for r in bounds});assert rows==(2 if width<=390 else 1),(width,rows,bounds)")
change('tests/toolbar_icons_ui.py',
       "print(f'PASS {width}px: 8 SVGs;",
       "print(f'PASS {width}px: 9 SVGs;")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.73: independent dimension lines, manual labels unscaled, real-length editing scaled')

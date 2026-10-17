"""Sentlog v1.64 after v1.63: field photo points and grouped survey records."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
pending={}


def change(path,old,new,count=1):
    source=pending.get(path)
    if source is None:
        source=(ROOT/path).read_text(encoding='utf-8')
    actual=source.count(old)
    if actual!=count:
        raise RuntimeError(f'Field-record build mismatch: {path}: {old[:100]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)


p='sentlog/index.html'
change(p,
       "['crack-width.js?v=163','SentlogCrackWidth']",
       "['crack-width.js?v=163','SentlogCrackWidth'],['field-records.js?v=164','SentlogFieldRecords']")
change(p,
       '<script src="./crack-width.js?v=163"><\/script>',
       '<script src="./crack-width.js?v=163"><\/script><script src="./field-records.js?v=164"><\/script>')
change(p,'phone-runtime.js?v=163','phone-runtime.js?v=164',2)
change(p,"['phone-runtime.js?v=164','v1.63']","['phone-runtime.js?v=164','v1.64']")
change('sentlog/phone-runtime.js','v1.63','v1.64',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v174';","const CACHE='sentlog-pwa-v175';")
change(p,
       "'crack-width.js','sync-view.js'",
       "'crack-width.js','field-records.js','sync-view.js'")

# Field-record pseudo types must never leak into the normal damage-name catalog.
change('sentlog/damage-catalog.js',
       "    for(const s of shapes){\n      if(typeof s.type!=='string'||!s.type||seen.has(s.type))continue;",
       "    for(const s of shapes){\n      if(s?.recordKind==='field-record')continue;\n      if(typeof s.type!=='string'||!s.type||seen.has(s.type))continue;")

# Existing browser/build assertions follow the final release marker.
for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.63'","window.SENTLOG_BUILD==='v1.64'",count)
change('tests/image_memory_ui.py',"window.SENTLOG_BUILD==='v1.63'","window.SENTLOG_BUILD==='v1.64'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.63'","'v1.64'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v174','sentlog-pwa-v175')

# v1.62/v1.63 feature tests remain active while their integration expectations move to v1.64.
change('tests/original_photo_store.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=163/);",
       "assert.match(index,/phone-runtime\\.js\\?v=164/);")
change('tests/original_photo_store.test.cjs',
       "assert.match(sw,/sentlog-pwa-v174/);",
       "assert.match(sw,/sentlog-pwa-v175/);")
change('tests/crack_width.test.cjs',
       "assert.match(index,/phone-runtime\\.js\\?v=163/);",
       "assert.match(index,/phone-runtime\\.js\\?v=164/);")
change('tests/crack_width.test.cjs',
       "assert.match(sw,/sentlog-pwa-v174/);",
       "assert.match(sw,/sentlog-pwa-v175/);")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.64: fixed-length overview photo direction + grouped survey point/outlined arrow records')

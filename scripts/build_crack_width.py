"""Sentlog v1.63 after v1.62: concrete crack-width wheel and compact W= labels."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
pending={}


def change(path,old,new,count=1):
    source=pending.get(path)
    if source is None:
        source=(ROOT/path).read_text(encoding='utf-8')
    actual=source.count(old)
    if actual!=count:
        raise RuntimeError(f'Crack-width build mismatch: {path}: {old[:90]!r}; expected {count}, found {actual}')
    pending[path]=source.replace(old,new)


p='sentlog/index.html'
change(p,
       "['original-photo-store.js?v=162','SentlogOriginalPhotos']",
       "['original-photo-store.js?v=162','SentlogOriginalPhotos'],['crack-width.js?v=163','SentlogCrackWidth']")
change(p,
       '<script src="./original-photo-store.js?v=162"><\/script>',
       '<script src="./original-photo-store.js?v=162"><\/script><script src="./crack-width.js?v=163"><\/script>')
change(p,'phone-runtime.js?v=162','phone-runtime.js?v=163',2)
change(p,"['phone-runtime.js?v=163','v1.62']","['phone-runtime.js?v=163','v1.63']")
change('sentlog/phone-runtime.js','v1.62','v1.63',4)

p='sentlog/sw.js'
change(p,"const CACHE='sentlog-pwa-v173';","const CACHE='sentlog-pwa-v174';")
change(p,
       "'original-photo-store.js','sync-view.js'",
       "'original-photo-store.js','crack-width.js','sync-view.js'")

for name,count in {
    'full_management.py':1,'full_archive_click.py':1,'capacity_ui.py':1,
    'shape_move_ui.py':1,'instant_damage_type_ui.py':1,'overview_labels_ui.py':1,
    'polygon_snap_ui.py':1,'polygon_dimensions_ui.py':1,'toolbar_icons_ui.py':1,
    'damage_catalog_ui.py':2,'damage_styles_ui.py':2,'label_colors_ui.py':2,
    'toolbar_help_ui.py':1,'plain_numbers_ui.py':2,'single_number_ui.py':2,
    'optional_symbol_ui.py':2,'large_image_view_ui.py':1,
}.items():
    change('tests/'+name,"window.SENTLOG_BUILD==='v1.62'","window.SENTLOG_BUILD==='v1.63'",count)
change('tests/image_memory_ui.py',"window.SENTLOG_BUILD==='v1.62'","window.SENTLOG_BUILD==='v1.63'")

for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,"'v1.62'","'v1.63'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):
    change('tests/'+name,'sentlog-pwa-v173','sentlog-pwa-v174')

change('tests/original_photo_store.test.cjs',
       r"/phone-runtime\\.js\\?v=162/",
       r"/phone-runtime\\.js\\?v=163/")
change('tests/original_photo_store.test.cjs',
       r"/sentlog-pwa-v173/",
       r"/sentlog-pwa-v174/")

for path,source in pending.items():
    (ROOT/path).write_text(source,encoding='utf-8')
print('Built Sentlog v1.63: concrete crack width wheel, 0.05mm steps, W= compact second-line labels')

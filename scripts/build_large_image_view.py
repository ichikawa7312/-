"""v1.59 after v1.58: bounded image display with original coordinates and bytes."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path)
    if source is None:
        source = (ROOT / path).read_text(encoding='utf-8')
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Large image view mismatch: {path}: {old[:70]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


p = 'sentlog/index.html'
change(p, "['sync-view.js?v=158','canRestoreDrawing']",
       "['sync-view.js?v=158','canRestoreDrawing'],['image-quality.js?v=159','BASE_PIXELS=2200000']")
change(p, '<script src="./pdf-quality.js?v=122"><\\/script>',
       '<script src="./pdf-quality.js?v=122"><\\/script><script src="./image-quality.js?v=159"><\\/script>')
change(p, 'phone-runtime.js?v=158', 'phone-runtime.js?v=159', 2)
change(p, "'v1.58'", "'v1.59'")
change('sentlog/phone-runtime.js', 'v1.58', 'v1.59', 4)
change('sentlog/sw.js', "const CACHE='sentlog-pwa-v169';", "const CACHE='sentlog-pwa-v170';")
change('sentlog/sw.js', "'pdf-quality.js','sync-view.js'", "'pdf-quality.js','image-quality.js','sync-view.js'")

for name, count in {
    'full_management.py': 1, 'full_archive_click.py': 1, 'capacity_ui.py': 1,
    'shape_move_ui.py': 1, 'instant_damage_type_ui.py': 1, 'overview_labels_ui.py': 1,
    'polygon_snap_ui.py': 1, 'polygon_dimensions_ui.py': 1, 'toolbar_icons_ui.py': 1,
    'damage_catalog_ui.py': 2, 'damage_styles_ui.py': 2, 'label_colors_ui.py': 2,
    'toolbar_help_ui.py': 1, 'plain_numbers_ui.py': 2, 'single_number_ui.py': 2,
    'optional_symbol_ui.py': 2,
}.items():
    change('tests/' + name, "window.SENTLOG_BUILD==='v1.58'", "window.SENTLOG_BUILD==='v1.59'", count)
for name in ('capacity.test.cjs', 'resilience.test.cjs', 'toolbar_icons.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, "'v1.58'", "'v1.59'")
for name in ('toolbar_icons.test.cjs', 'damage_styles.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, 'sentlog-pwa-v169', 'sentlog-pwa-v170')

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built Sentlog v1.59: bounded large-image canvases and cropped zoom detail; original bytes/coordinates retained')

"""v1.60 after v1.59: release large decoded sources and reuse a mobile zoom surface."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path)
    if source is None:
        source = (ROOT / path).read_text(encoding='utf-8')
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Image memory build mismatch: {path}: {old[:70]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


p = 'sentlog/index.html'
change(p, 'image-quality.js?v=159', 'image-quality.js?v=160', 2)
change(p, "['image-quality.js?v=160','BASE_PIXELS=2200000']",
       "['image-quality.js?v=160','SOURCE_PIXELS=4000000']")
change(p, 'phone-runtime.js?v=159', 'phone-runtime.js?v=160', 2)
change(p, "'v1.59'", "'v1.60'")
change('sentlog/phone-runtime.js', 'v1.59', 'v1.60', 4)
change('sentlog/sw.js', "const CACHE='sentlog-pwa-v170';", "const CACHE='sentlog-pwa-v171';")
for name, count in {
    'full_management.py': 1, 'full_archive_click.py': 1, 'capacity_ui.py': 1,
    'shape_move_ui.py': 1, 'instant_damage_type_ui.py': 1, 'overview_labels_ui.py': 1,
    'polygon_snap_ui.py': 1, 'polygon_dimensions_ui.py': 1, 'toolbar_icons_ui.py': 1,
    'damage_catalog_ui.py': 2, 'damage_styles_ui.py': 2, 'label_colors_ui.py': 2,
    'toolbar_help_ui.py': 1, 'plain_numbers_ui.py': 2, 'single_number_ui.py': 2,
    'optional_symbol_ui.py': 2, 'large_image_view_ui.py': 1,
}.items():
    change('tests/' + name, "window.SENTLOG_BUILD==='v1.59'", "window.SENTLOG_BUILD==='v1.60'", count)
for name in ('capacity.test.cjs', 'resilience.test.cjs', 'toolbar_icons.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, "'v1.59'", "'v1.60'")
for name in ('toolbar_icons.test.cjs', 'damage_styles.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, 'sentlog-pwa-v170', 'sentlog-pwa-v171')

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built Sentlog v1.60: bounded decoded touch source and reusable small zoom surface; original file/coordinates retained')

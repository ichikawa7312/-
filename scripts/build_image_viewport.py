"""v1.61 after v1.60: bound touch SVG/CSS surfaces to the visible viewport."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path)
    if source is None:
        source = (ROOT / path).read_text(encoding='utf-8')
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Image viewport build mismatch: {path}: {old[:70]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


p = 'sentlog/index.html'
change(p, 'image-quality.js?v=160', 'image-quality.js?v=161', 2)
change(p, "['image-quality.js?v=161','SOURCE_PIXELS=4000000']",
       "['image-quality.js?v=161','drawTouchViewport']")
change(p, 'phone-runtime.js?v=160', 'phone-runtime.js?v=161', 2)
change(p, "'v1.60'", "'v1.61'")
change('sentlog/phone-runtime.js', 'v1.60', 'v1.61', 4)
change('sentlog/sw.js', "const CACHE='sentlog-pwa-v171';", "const CACHE='sentlog-pwa-v172';")
for name, count in {
    'full_management.py': 1, 'full_archive_click.py': 1, 'capacity_ui.py': 1,
    'shape_move_ui.py': 1, 'instant_damage_type_ui.py': 1, 'overview_labels_ui.py': 1,
    'polygon_snap_ui.py': 1, 'polygon_dimensions_ui.py': 1, 'toolbar_icons_ui.py': 1,
    'damage_catalog_ui.py': 2, 'damage_styles_ui.py': 2, 'label_colors_ui.py': 2,
    'toolbar_help_ui.py': 1, 'plain_numbers_ui.py': 2, 'single_number_ui.py': 2,
    'optional_symbol_ui.py': 2, 'large_image_view_ui.py': 1,
}.items():
    change('tests/' + name, "window.SENTLOG_BUILD==='v1.60'", "window.SENTLOG_BUILD==='v1.61'", count)
for name in ('capacity.test.cjs', 'resilience.test.cjs', 'toolbar_icons.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, "'v1.60'", "'v1.61'")
for name in ('toolbar_icons.test.cjs', 'damage_styles.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
    change('tests/' + name, 'sentlog-pwa-v171', 'sentlog-pwa-v172')

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built Sentlog v1.61: screen-size SVG and image surfaces during touch pinch; original file/coordinates retained')

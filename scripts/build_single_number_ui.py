"""v1.56 after v1.55: remove the redundant global-number UI, not record fields.
Guarded build-time edits only. Existing numerical/ID/photo/sync routines stay intact.
All expected source fragments are checked before any output is written.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
pending = {}


def change(path, old, new, count=1):
    source = pending.get(path)
    if source is None:
        source = (ROOT / path).read_text(encoding='utf-8')
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Single-number UI mismatch: {path}: {old[:70]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


change('sentlog/part03.txt',
       '<div class="row"><div><label>全体No.</label><input id="globalNo" value="未採番" readonly></div><div><label>変状No.</label><input id="typeNo" value="未採番" readonly></div></div>',
       '<div id="damageNumberField" data-number-ui="type-only-v156"><label for="typeNo">変状No.</label><input id="typeNo" value="未採番" readonly></div>')
change('sentlog/part04.txt',
       '新規変状には案件全体の通しNo.と、変状名称ごとのNo.を自動採番します。',
       '新規変状には、図面内で変状名称ごとのNo.を自動採番します（例：腐食-1）。同じPDF内ではページをまたいで採番します。')
# Delete field access in every path that can run without a selection or during
# load, delete, undo/redo and manual inspector updates. No hidden surrogate input.
change('sentlog/part04.txt', "$('globalNo').value='未選択';", '')
change('sentlog/part04.txt', 'function restorePageSnapshot(snapshot,page=state.currentPage){',
       '// type-only-history-v156: the global-number input is no longer present.\nfunction restorePageSnapshot(snapshot,page=state.currentPage){')
change('sentlog/part09.txt', "$('globalNo').value='未選択';", '', 2)
change('sentlog/part09.txt', "$('globalNo').value='未採番';", '')
change('sentlog/part09.txt', "$('globalNo').value='No.'+formatGlobalNo(s.globalNo);", '')
change('sentlog/part09.txt', 'function clearSelection(){',
       '// type-only-selection-v156: keep legacy record fields, not a second visible number.\nfunction clearSelection(){')
change('sentlog/inspector-interaction.js', "    $('globalNo').value='No.'+formatGlobalNo(s.globalNo);\n", '')
change('sentlog/inspector-interaction.js', '/* v1.24: selection and label movement never open the mobile inspector. */',
       '/* v1.24 selection behavior retained; type-only-inspector-v156 removes the redundant number field. */')

p = 'sentlog/index.html'
change(p, "[8,'const label=autoLabelFor(s);']",
       "[8,'const label=autoLabelFor(s);'],[2,'type-only-v156'],[3,'type-only-history-v156'],[8,'type-only-selection-v156']")
change(p, 'inspector-interaction.js?v=155', 'inspector-interaction.js?v=156', 2)
change(p, "['inspector-interaction.js?v=156','autoLabelFor(s)']",
       "['inspector-interaction.js?v=156','type-only-inspector-v156']")
change(p, "'v1.55'", "'v1.56'")
change(p, 'phone-runtime.js?v=155', 'phone-runtime.js?v=156', 2)
change('sentlog/phone-runtime.js', 'v1.55', 'v1.56', 4)
change('sentlog/sw.js', "const CACHE='sentlog-pwa-v166';", "const CACHE='sentlog-pwa-v167';")

# Existing regression suites still exercise the final build. Only version/cache
# assertions are updated; numeric IDs and geometry/photo assertions are unchanged.
for name, count in {
    'full_management.py': 1, 'full_archive_click.py': 1, 'capacity_ui.py': 1,
    'shape_move_ui.py': 1, 'instant_damage_type_ui.py': 1, 'overview_labels_ui.py': 1,
    'polygon_snap_ui.py': 1, 'polygon_dimensions_ui.py': 1, 'toolbar_icons_ui.py': 1,
    'damage_catalog_ui.py': 2, 'damage_styles_ui.py': 2, 'label_colors_ui.py': 2,
    'toolbar_help_ui.py': 1, 'plain_numbers_ui.py': 2,
}.items():
    change('tests/' + name, "window.SENTLOG_BUILD==='v1.55'", "window.SENTLOG_BUILD==='v1.56'", count)
for name in ('capacity.test.cjs', 'resilience.test.cjs', 'toolbar_icons.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs'):
    change('tests/' + name, "'v1.55'", "'v1.56'")
for name in ('toolbar_icons.test.cjs', 'damage_styles.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs'):
    change('tests/' + name, 'sentlog-pwa-v166', 'sentlog-pwa-v167')
change('tests/plain_numbers.test.cjs', 'inspector-interaction.js?v=155', 'inspector-interaction.js?v=156')
# Removing the test-only input forces existing undo/redo/reclassification tests
# to fail on any accidental access to the deleted control.
change('tests/instant_damage_type.test.cjs', "'lineWidth','globalNo','applyBtn'", "'lineWidth','applyBtn'")

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built Sentlog v1.56: one full-width damage number; no global-number UI; numeric identifiers, photos and storage preserved')

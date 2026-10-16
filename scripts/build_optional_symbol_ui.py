"""v1.57 after v1.56: remove the optional-symbol control, preserving old no values.
Guarded static build changes only. Validate every fragment before writing output.
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
        raise RuntimeError(f'Optional-symbol UI mismatch: {path}: {old[:70]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)


change('sentlog/part03.txt',
       '    <div><label>任意記号（必要時）</label><input id="damageNo" placeholder="例：G1-FU（自動番号とは別）"></div>',
       '    <!-- no-optional-symbol-v157: the damage number is followed by the member. -->')
change('sentlog/part09.txt', "$('damageNo').value=s.no||'';", '')
# Separate creation from editing. New records get an empty compatibility value;
# editing an existing record must NOT blank out its previously entered symbol.
change('sentlog/part09.txt', "s.no=$('damageNo').value;", '', 2)
change('sentlog/part09.txt', 'function addShape(s){pushHistory();',
       "// no-symbol-editor-v157: retain old record symbols, never copy one to a new shape.\nfunction addShape(s){pushHistory();s.no='';")
change('sentlog/inspector-interaction.js', "    $('damageNo').value=s.no||'';\n", '')
change('sentlog/inspector-interaction.js', "  'use strict';",
       "  'use strict';\n  // no-symbol-inspector-v157: optional symbol is no longer an editable field.")
# Only remove the missing UI field from dirty-input detection. Record comparison,
# snapshot merging, network transport and persisted no values remain unchanged.
change('sentlog/sync-view.js', "damageNo:s.no||'',", '')
change('sentlog/sync-view.js', "  'use strict';",
       "  'use strict';\n  // no-symbol-draft-guard-v157: guard only fields still present in the inspector.")
p = 'sentlog/index.html'
change(p, "[8,'type-only-selection-v156']",
       "[8,'type-only-selection-v156'],[2,'no-optional-symbol-v157'],[8,'no-symbol-editor-v157']")
change(p, 'inspector-interaction.js?v=156', 'inspector-interaction.js?v=157', 2)
change(p, "'type-only-inspector-v156'", "'no-symbol-inspector-v157'")
change(p, 'sync-view.js?v=153', 'sync-view.js?v=157', 2)
change(p, "['sync-view.js?v=157','window.SentlogRecords.batch']",
       "['sync-view.js?v=157','no-symbol-draft-guard-v157']")
change(p, "'v1.56'", "'v1.57'")
change(p, 'phone-runtime.js?v=156', 'phone-runtime.js?v=157', 2)
change('sentlog/phone-runtime.js', 'v1.56', 'v1.57', 4)
change('sentlog/sw.js', "const CACHE='sentlog-pwa-v167';", "const CACHE='sentlog-pwa-v168';")

# Keep regression tests on the final build. Change version assertions only.
for name, count in {
    'full_management.py': 1, 'full_archive_click.py': 1, 'capacity_ui.py': 1,
    'shape_move_ui.py': 1, 'instant_damage_type_ui.py': 1, 'overview_labels_ui.py': 1,
    'polygon_snap_ui.py': 1, 'polygon_dimensions_ui.py': 1, 'toolbar_icons_ui.py': 1,
    'damage_catalog_ui.py': 2, 'damage_styles_ui.py': 2, 'label_colors_ui.py': 2,
    'toolbar_help_ui.py': 1, 'plain_numbers_ui.py': 2, 'single_number_ui.py': 2,
}.items():
    change('tests/' + name, "window.SENTLOG_BUILD==='v1.56'", "window.SENTLOG_BUILD==='v1.57'", count)
for name in ('capacity.test.cjs', 'resilience.test.cjs', 'toolbar_icons.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs'):
    change('tests/' + name, "'v1.56'", "'v1.57'")
for name in ('toolbar_icons.test.cjs', 'damage_styles.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs'):
    change('tests/' + name, 'sentlog-pwa-v167', 'sentlog-pwa-v168')
for name in ('plain_numbers.test.cjs', 'single_number_ui.test.cjs'):
    change('tests/' + name, 'inspector-interaction.js?v=156', 'inspector-interaction.js?v=157')
change('tests/single_number_ui.test.cjs', "'type-only-inspector-v156'", "'no-symbol-inspector-v157'")
# Old-symbol fixtures stay, but their stored values (not the removed field) are
# asserted. A missing test mock makes any surviving field access fail immediately.
change('tests/instant_damage_type.test.cjs', "'typeNo','damageNo','member'", "'typeNo','member'")
change('tests/instant_damage_type.test.cjs', "fields.damageNo.value='unedited draft';\n", '')
change('tests/instant_damage_type.test.cjs', "{damageNo:'unedited draft',member:", "{member:")
change('tests/plain_numbers_ui.py', "assert page.locator('#damageNo').input_value()=='任意①-G1'",
       "assert page.locator('#damageNo').count()==0\n   assert page.evaluate(\"state.shapes.find(s=>s.id==='number-1000').no\")== '任意①-G1'")
change('tests/single_number_ui.py', "assert page.locator('#damageNo').input_value() == 'G1-①'",
       "assert page.locator('#damageNo').count() == 0\n            assert page.evaluate(\"state.shapes.find(s=>s.id==='single-1').no\") == 'G1-①'")

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built Sentlog v1.57: no optional-symbol input; old symbols retained during edits; new records do not inherit them')

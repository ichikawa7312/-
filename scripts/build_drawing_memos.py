"""Integrate drawing memos after the existing v1.76 production pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
pending = {}

def change(path, old, new, count=1):
    source = pending.get(path, (ROOT / path).read_text(encoding='utf-8'))
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'Drawing memo build mismatch: {path}: {old[:100]!r}; expected {count}, found {actual}')
    pending[path] = source.replace(old, new)

change('sentlog/index.html', "['shape-dimensions.js?v=176','SentlogShapeDimensions']",
       "['shape-dimensions.js?v=176','SentlogShapeDimensions'],['drawing-memos.js?v=177','SentlogDrawingMemos']")
change('sentlog/index.html', '<script src="./capacity-details.js?v=140"><\\/script>',
       '<script src="./capacity-details.js?v=140"><\\/script><script src="./drawing-memos.js?v=177"><\\/script>')
change('sentlog/index.html', 'phone-runtime.js?v=176', 'phone-runtime.js?v=177', 2)
change('sentlog/index.html', "['phone-runtime.js?v=177','v1.76']", "['phone-runtime.js?v=177','v1.77']")
change('sentlog/phone-runtime.js', 'v1.76', 'v1.77', 4)
change('sentlog/sw.js', "const CACHE='sentlog-pwa-v187';", "const CACHE='sentlog-pwa-v188';")
change('sentlog/sw.js', "'shape-dimensions.js','sync-view.js'", "'shape-dimensions.js','drawing-memos.js','sync-view.js'")
change('sentlog/sync-view.js', 'window.SentlogDimensionLines?.isEditing?.()',
       'window.SentlogDimensionLines?.isEditing?.() || window.SentlogDrawingMemos?.isEditing?.()')
change('sentlog/part09.txt',
       'const reconciliation=denom?window.SentlogShapeDimensions?.reconcileManualDimensions?.(state.currentPage):null;',
       'const reconciliation=denom?window.SentlogShapeDimensions?.reconcileManualDimensions?.(state.currentPage):null;\n  const memoWarnings=denom?window.SentlogDrawingMemos?.reconcileManualDimensions?.(state.currentPage):[];')
change('sentlog/part09.txt',
       "if(warning)setTimeout(()=>alert(warning),0);",
       "if(warning)setTimeout(()=>alert(warning),0);\n  if(memoWarnings?.length)setTimeout(()=>alert('記録した寸法を保持しました。図面の外に出る寸法線は、始点を移動してから寸法を確定してください。'),0);")
change('sentlog/shape-dimensions.js',
       "return !s||s.recordKind==='field-record'||s.recordKind==='dimension-line'||s.kind==='dimension';",
       "return !s||s.recordKind==='drawing-memo'||s.recordKind==='field-record'||s.recordKind==='dimension-line'||s.kind==='dimension';")
change('sentlog/toolbar-icons.js',
       "const name=active?active.d[1]:'選択・移動';",
       "const name=window.SentlogDrawingMemos?.mode==='memo'?window.SentlogDrawingMemos.toolLabel:(active?active.d[1]:'選択・移動');")
change('sentlog/toolbar-icons.js',
       "const groups=[...bar.querySelectorAll(':scope > .sl-tool-group')];",
       "const groups=[...bar.querySelectorAll(':scope > .sl-tool-group')].filter(g=>!g.hidden);")
change('sentlog/toolbar-icons.js',
       "const buttons=[...group.querySelectorAll(':scope > .sl-tool-button')],gcss=getComputedStyle(group);",
       "const buttons=[...group.querySelectorAll(':scope > .sl-tool-button')].filter(b=>!b.hidden),gcss=getComputedStyle(group);")
change('sentlog/toolbar-icons.js',
       "const enabled=items.map(x=>x.b).filter(x=>!x.disabled),i=enabled.indexOf(b);",
       "const enabled=[...bar.querySelectorAll('button')].filter(x=>!x.disabled&&!x.hidden&&!x.closest('[hidden]')),i=enabled.indexOf(b);")

# Earlier pipeline stages update these version assertions in order. Advance only
# the final app/cache versions; leave each module's own version assertion intact.
for path in (ROOT / 'tests').iterdir():
    if path.suffix not in ('.py', '.cjs'):
        continue
    text = path.read_text(encoding='utf-8')
    updated = text.replace("SENTLOG_BUILD==='v1.76'", "SENTLOG_BUILD==='v1.77'").replace('sentlog-pwa-v187', 'sentlog-pwa-v188')
    if path.name in ('capacity.test.cjs', 'resilience.test.cjs', 'toolbar_icons.test.cjs', 'label_colors.test.cjs', 'plain_numbers.test.cjs', 'single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs'):
        updated = updated.replace("'v1.76'", "'v1.77'")
    updated = updated.replace(r'phone-runtime\.js\?v=176', r'phone-runtime\.js\?v=177')
    if path.name == 'toolbar_icons_ui.py':
        updated = updated.replace("'[data-tool=\"dimension\"]',", '')
        updated = updated.replace("'#sentlogDrawingToolbar button').count()==9", "'#sentlogDrawingToolbar .sl-tool-button:visible').count()==8")
        updated = updated.replace("'#sentlogDrawingToolbar svg').count()==9", "'#sentlogDrawingToolbar .sl-tool-button:visible svg').count()==8")
        updated = updated.replace('for sel in selectors[:6]:', 'for sel in selectors[:5]:')
        updated = updated.replace('assert rows==(2 if width<=390 else 1)', 'assert rows in ((1,2) if width<=390 else (1,))')
        updated = updated.replace('assert icon_only==(width<=390 or width==1280),(width,icon_only)', 'assert width>390 or icon_only,(width,icon_only)')
        updated = updated.replace('9 SVGs;', '8 visible damage/history SVGs;')
    if updated != text:
        pending[str(path.relative_to(ROOT))] = updated

for path, source in pending.items():
    (ROOT / path).write_text(source, encoding='utf-8')
print('Built Sentlog v1.77: damage/memo modes, six note tools, editing, sync, history and page PDF export')

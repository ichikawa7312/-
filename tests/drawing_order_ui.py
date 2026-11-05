"""Rendered UI regression for drawing-No. / nested-sheet ordering; synthetic data only."""
import ast
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
tree=ast.parse((ROOT/'tests/drawing_groups_ui.py').read_text(encoding='utf-8'))
assignment=next(node for node in tree.body if isinstance(node,ast.Assign) and
                any(isinstance(x,ast.Name) and x.id=='BASE' for x in node.targets))
BASE=ast.literal_eval(assignment.value)
with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
        opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    page=browser.new_page(viewport={'width':760,'height':900})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('https://sentlog.test/',lambda route:route.fulfill(status=200,content_type='text/html',body=BASE))
    page.goto('https://sentlog.test/')
    page.add_script_tag(content=(ROOT/'sentlog/drawing-groups.js').read_text(encoding='utf-8'))
    page.add_script_tag(content=(ROOT/'sentlog/drawing-order.js').read_text(encoding='utf-8'))
    page.wait_for_function("!!window.SentlogDrawingOrder && !!document.getElementById('slDrawingOrderToolbar')")
    def order():
        return page.eval_on_selector_all('#drawingsGrid [data-drawing-group-id]',
          '(nodes)=>nodes.map(el=>el.dataset.drawingGroupId)')
    assert order()==['g1','g2'],order()
    # Explicit edit mode: mouse and touch controls do not replace open-card actions.
    page.get_by_role('button',name='⇅ 並び替え').click()
    assert page.locator('#drawingsGrid.sl-order-edit').count()==1
    assert page.locator('.sl-order-card-actions').count()==2
    page.locator('[data-drawing-group-id="g2"] .sl-order-card-actions button[aria-label*="一つ前へ"]').click()
    page.wait_for_function("workspace.projects[0].drawings[2].groupOrder===1")
    assert order()==['g2','g1'],order()
    assert page.evaluate("workspace.projects[0].drawings.every(d=>d.id!=='s1'&&d.id!=='s2'||d.groupOrder===2)")
    assert page.evaluate("files.size===3 && rec.get('draw:s1')==='{}'")
    # Numeric sorting puts 1 before 2 regardless of updated timestamps.
    page.get_by_role('button',name='図面No.順に整列').click()
    page.wait_for_function("workspace.projects[0].drawings[0].groupOrder===1")
    assert order()==['g1','g2'],order()
    # HTML drag-and-drop moves cards, then preserves the order on a full rerender.
    page.locator('[data-drawing-group-id="g2"]').drag_to(page.locator('[data-drawing-group-id="g1"]'))
    page.wait_for_function("workspace.projects[0].drawings[2].groupOrder===1")
    page.evaluate('renderDrawings()')
    assert order()==['g2','g1'],order()
    page.get_by_role('button',name='✓ 完了').click()
    assert page.locator('#drawingsGrid.sl-order-edit').count()==0
    # Original card opens its first sheet even after manual reordering.
    page.locator('[data-drawing-group-id="g1"] .manager-card-title').click()
    page.wait_for_function("currentView==='editor' && activeDrawingId==='s1'")
    assert page.locator('.sl-sheet-order').is_visible()
    page.locator('.sl-sheet-order [data-action="down"]').click()
    page.wait_for_function("workspace.projects[0].drawings[0].sheetOrder===2")
    assert page.evaluate("workspace.projects[0].drawings[1].sheetOrder===1")
    assert page.evaluate("files.size===3 && rec.get('draw:s1')!=='null'")
    page.evaluate("showDrawings('p1')")
    assert order()==['g2','g1'],order()
    assert not errors,errors
    (ROOT/'test-results').mkdir(exist_ok=True)
    page.screenshot(path=str(ROOT/'test-results/drawing-order-ui.png'),full_page=True)
    browser.close()
    print('PASS drawing order browser: edit mode, arrows, numeric sort, drag/drop, sheet order and no original-file changes')

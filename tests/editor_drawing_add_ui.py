"""Browser check for v1.70 editor-side drawing add control. Synthetic DOM only."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
BASE='''<!doctype html><html lang="ja"><meta charset="UTF-8"><style>
.stack{display:grid;gap:8px;width:240px}.btn,button{padding:10px;border:1px solid #ccc;border-radius:8px}
</style><body>
<div class="stack">
  <label class="btn" for="fileInput">この図面を差し替え</label>
  <input id="fileInput" type="file" hidden>
  <div id="fileName">current.pdf</div>
</div>
<input id="drawingAddInput" type="file" hidden>
<script>
let currentView='editor',activeProjectId='p1',activeDrawingId='d1';
let persistCount=0,addClick=0,replaceClick=0;
function persist(){persistCount++}
document.getElementById('drawingAddInput').addEventListener('click',e=>{e.preventDefault();addClick++});
document.getElementById('fileInput').addEventListener('click',e=>{e.preventDefault();replaceClick++});
</script></body></html>'''

with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
        opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    page=browser.new_page(viewport={'width':390,'height':844})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.route('https://sentlog.test/',lambda route: route.fulfill(status=200,content_type='text/html',body=BASE))
    page.goto('https://sentlog.test/')
    page.add_script_tag(content=(ROOT/'sentlog/editor-drawing-add.js').read_text(encoding='utf-8'))

    btn=page.locator('#editorDrawingAddBtn')
    assert btn.count()==1
    assert btn.inner_text()=='＋ 図面を追加'
    order=page.evaluate("""()=>[...document.querySelector('.stack').children].map(x=>x.id||x.getAttribute('for')||x.textContent.trim())""")
    assert order[0]=='editorDrawingAddBtn' and order[1]=='fileInput',order

    btn.click()
    result=page.evaluate("()=>({persistCount,addClick,replaceClick})")
    assert result=={'persistCount':1,'addClick':1,'replaceClick':0},result

    page.evaluate("currentView='drawings'")
    btn.click()
    result2=page.evaluate("()=>({persistCount,addClick,replaceClick})")
    assert result2==result,result2

    assert not errors,errors
    (ROOT/'test-results').mkdir(exist_ok=True)
    page.screenshot(path=str(ROOT/'test-results/editor-drawing-add-ui.png'),full_page=True)
    browser.close()
    print('PASS editor drawing add UI: one button above replace, current drawing persisted, add input triggered, replace untouched')

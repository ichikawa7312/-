"""Actual built editor: synthetic legacy symbols, no production APIs or files.
The removed control must not erase old symbols, break Apply/photo actions, or
silently prevent incoming updates / weaken unsaved-input protection.
"""
import ast
import functools
import json
import os
import threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
fixture = ast.parse((ROOT / 'tests/single_number_ui.py').read_text())
seed = next(ast.literal_eval(n.value) for n in fixture.body if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == 'seed' for t in n.targets))


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'


def shapes(page):
    return page.evaluate('JSON.stringify(state.shapes)')


def symbols(page):
    return page.evaluate("state.shapes.map(s=>[s.id,Object.hasOwn(s,'no'),s.no??null]).sort((a,b)=>a[0].localeCompare(b[0]))")


def same_records(left, right):
    # Existing cross-page add/delete Undo can reorder the legacy global sequence.
    canonical = lambda text: sorted([{k: v for k, v in item.items() if k != 'globalNo'}
                                     for item in json.loads(text)], key=lambda item: item['id'])
    return canonical(left) == canonical(right)


def settle(page):
    page.evaluate('async()=>{await window.SentlogRecords.settled();window.SentlogRecords.assertSafe()}')


def check_ui(page):
    expect(page.locator('#damageNo')).to_have_count(0)
    expect(page.locator('#globalNo')).to_have_count(0)
    assert not any('任意記号' in s for s in page.locator('#inspector label').all_text_contents())
    assert page.evaluate("$('damageNumberField').nextElementSibling.querySelector('#member')!==null")
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')


remote = """async()=>{
 const project=JSON.parse(JSON.stringify(getProject())),incoming=JSON.parse(JSON.stringify(state));
 incoming.shapes.find(s=>s.id==='single-1').memo='受信したメモ（合成）';
 const storedProject=JSON.parse(window.SentlogRecords.getItem(WORKSPACE_KEY)).projects.find(p=>p.id===activeProjectId);
 return window.sentlogSyncView.commit({client_key:activeProjectId},
  {payload:{project,drawings:[{meta:JSON.parse(JSON.stringify(getDrawingMeta())),state:incoming}]}},JSON.stringify(storedProject));
}"""
try:
    with sync_playwright() as p:
        launch = {'headless': True}
        if os.path.exists('/usr/bin/chromium'):
            launch.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        browser = p.chromium.launch(**launch)
        for width in (320, 390, 820, 1280):
            context = browser.new_context(viewport={'width': width, 'height': 940}, has_touch=width < 900,
                                          service_workers='block', accept_downloads=True)
            calls = []

            def route(rr):
                url = rr.request.url
                if url.startswith(origin + '/'):
                    rr.continue_()
                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    rr.fulfill(status=200, content_type='text/javascript',
                               body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Synthetic image test")}};')
                else:
                    calls.append(url)
                    rr.abort()

            context.route('**/*', route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(e.stack or str(e)))
            page.goto(origin + '/sentlog/', wait_until='domcontentloaded')
            page.wait_for_function("window.SENTLOG_BUILD==='v1.57'&&!!window.SentlogLabelColors")
            page.evaluate(seed)
            check_ui(page)
            legacy = symbols(page)
            initial = shapes(page)
            for sid in ('single-1', 'single-3', 'single-4'):
                page.evaluate('id=>selectShape(id)', sid)
                assert shapes(page) == initial
            page.evaluate("state.currentPage=2;selectShape('single-2')")
            assert page.locator('#typeNo').input_value() == '漏水-1'
            page.evaluate("state.currentPage=1;selectShape('single-1')")
            if width < 900:
                page.locator('#mobileHandle').click()
            page.evaluate('async()=>{await document.fonts.ready}')
            page.wait_for_timeout(400)
            page.locator('#typeNo').scroll_into_view_if_needed()
            (ROOT / 'test-results').mkdir(exist_ok=True)
            page.screenshot(path=str(ROOT / f'test-results/optional-symbol-{width}.png'))
            # Changing the remaining inputs and pressing Apply preserves no exactly.
            context.set_offline(True)
            page.locator('#member').fill('G1 上フランジ')
            page.locator('#memo').fill('既往図面のA-3に対応')
            page.locator('#lineWidth').select_option('1.6')
            page.locator('#applyBtn').click()
            settle(page)
            assert symbols(page) == legacy
            assert page.evaluate("state.shapes.find(s=>s.id==='single-1').member") == 'G1 上フランジ'
            assert page.evaluate("state.shapes.find(s=>s.id==='single-1').memo") == '既往図面のA-3に対応'
            page.evaluate('undo()')
            assert shapes(page) == initial
            page.evaluate('redo()')
            assert symbols(page) == legacy
            # Instant reclassification and Undo retain all legacy symbols too.
            page.evaluate("selectShape('single-1')")
            before = shapes(page)
            page.locator('#damageType').select_option('浮き')
            assert page.locator('#typeNo').input_value() == '浮き-1'
            assert symbols(page) == legacy
            page.evaluate('undo()')
            assert shapes(page) == before
            # A new record must not inherit a symbol from the selected old record.
            page.evaluate("selectShape('single-1');addShape({kind:'line',points:[{x:20,y:20},{x:50,y:50}]})")
            assert page.evaluate("state.shapes.at(-1).no") == ''
            assert page.evaluate("state.shapes.at(-1).typeNo") == 3
            page.evaluate('undo()')
            assert same_records(shapes(page), before) and symbols(page) == legacy
            # Exercise real photo preparation/storage and its wrapped sync guard.
            page.evaluate("""async()=>{
             selectShape('single-1');
             const c=document.createElement('canvas');c.width=4;c.height=4;
             const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
             await addPhotosToSelected([new File([blob],'new-synthetic.png',{type:'image/png'})]);
            }""")
            settle(page)
            assert symbols(page) == legacy
            assert page.evaluate("state.shapes.find(s=>s.id==='single-1').photos.length") == 2
            assert page.evaluate("state.shapes.find(s=>s.id==='single-1').photos[0].id") == 'single-photo'
            # Deleted input must not permanently mark the inspector as dirty.
            # Remaining unsaved memo still blocks incoming replacement after blur.
            page.locator('#memo').fill('まだ保存していないメモ')
            page.evaluate('document.activeElement.blur()')
            blocked = page.evaluate(remote)
            assert blocked.get('applied') is False and blocked.get('reason') == 'editing', blocked
            page.evaluate("selectShape('single-1');document.activeElement.blur()")
            applied = page.evaluate(remote)
            assert applied.get('applied') is True, applied
            settle(page)
            assert symbols(page) == legacy
            assert page.locator('#memo').input_value() == '受信したメモ（合成）'
            assert page.evaluate("state.shapes.find(s=>s.id==='single-1').photos.length") == 2
            # Backup + normal reopening keep old no bytes and all photo ownership.
            with page.expect_download() as info:
                page.evaluate('exportSentlogBackup()')
            pack = json.loads(Path(info.value.path()).read_text())
            records = pack['drawingStates']['single-d']['shapes']
            first = next(s for s in records if s['id'] == 'single-1')
            assert first['no'] == 'G1-①' and len(first['photos']) == 2
            assert 'no' not in next(s for s in records if s['id'] == 'single-3')
            assert any(f['key'] == 'photo:single-d:single-photo' for f in pack['files'])
            before = shapes(page)
            context.set_offline(False)
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function("window.SENTLOG_BUILD==='v1.57'&&!!window.SentlogLabelColors")
            page.evaluate("async()=>{await window.sentlogAppReady;await openDrawing('single-p','single-d');selectShape('single-1')}")
            check_ui(page)
            assert shapes(page) == before and symbols(page) == legacy
            assert not errors, errors
            assert not calls, calls
            print(f'PASS {width}px: optional input removed; number/member adjacency; legacy symbols intact on Apply/reclassification/Undo; new records empty; photos; unsaved-input guard; in-place receive; offline backup and reopen')
            context.close()
        browser.close()
finally:
    server.shutdown()
    server.server_close()

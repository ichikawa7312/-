"""Actual built editor with synthetic data only; no login or external APIs.
Verify the removed global-number input is not needed by any editing lifecycle.
"""
import functools
import json
import os
import threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
seed = """async()=>{
 await window.sentlogAppReady;
 const project={id:'single-p',name:'番号欄の確認（合成データ）',createdAt:1,updatedAt:1,
  drawings:[{id:'single-d',name:'変状No.だけの表示',sourceType:'image',fileName:'sample.svg',pageCount:2}],
  damageNamesV1:[{id:'single-custom',name:'補修材の再剥離',material:'concrete',displayGroup:'loss'}]};
 workspace={projects:[project]};activeProjectId=project.id;activeDrawingId='single-d';
 state=freshDrawingState(project.name);state.sourceType='image';state.fileName='sample.svg';
 state.shapes=[
  {id:'single-1',type:'腐食',kind:'rect',page:1,x:80,y:180,w:260,h:150,labelPos:{x:210,y:110},strokeWidth:1.2,photos:[{id:'single-photo',name:'合成写真.svg'}],memo:'既存の所見',no:'G1-①',member:'G1'},
  {id:'single-2',type:'漏水',kind:'line',page:2,points:[{x:20,y:30},{x:300,y:120}],strokeWidth:1.2,photos:[]},
  {id:'single-3',type:'腐食',kind:'rect',page:1,x:440,y:180,w:230,h:150,labelPos:{x:560,y:110},strokeWidth:1.2,photos:[]},
  {id:'single-4',type:'補修材の再剥離',kind:'rect',page:1,x:170,y:490,w:380,h:150,labelPos:{x:370,y:420},strokeWidth:1.2,photos:[]}
 ];
 rebuildNumberingState();showEditor();
 const image=new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="white"/><path d="M25 50H775V950H25Z M25 390H775" fill="none" stroke="#bbb"/></svg>'],{type:'image/svg+xml'});
 await putDBFile('background:single-d',image);await putDBFile('photo:single-d:single-photo',image);
 await openFile(image,false);state.pageCount=2;updatePageUI();clearSelection();persist();
 await window.SentlogRecords.settled();clearAllHistory();
}"""


def shapes(page):
    return page.evaluate('JSON.stringify(state.shapes)')


def identities(page):
    # Existing cross-page deletion Undo can reorder the derived global sequence.
    # Compare IDs, typeNo and all user fields, excluding only that legacy sequence.
    return sorted([{k: v for k, v in s.items() if k != 'globalNo'}
                   for s in json.loads(shapes(page))], key=lambda s: s['id'])


def all_saved(page):
    return page.evaluate("JSON.stringify({state,workspace,record:window.SentlogRecords.getItem(drawingStorageKey(activeDrawingId)),history:historyFor()})")


def open_inspector(page, width):
    if width < 900 and not page.locator('#inspector').evaluate("e=>e.classList.contains('open')"):
        page.locator('#mobileHandle').click()
    page.wait_for_timeout(350)


def check_number(page, value):
    expect(page.locator('#globalNo')).to_have_count(0)
    field = page.get_by_label('変状No.', exact=True)
    expect(field).to_have_count(1)
    expect(field).to_have_value(value)
    assert field.evaluate('e=>e.readOnly')
    assert page.locator('#inspector label').all_text_contents().count('全体No.') == 0
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')


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
            page.wait_for_function("window.SENTLOG_BUILD==='v1.56'&&!!window.SentlogLabelColors")
            page.evaluate(seed)
            baseline = shapes(page)
            before = all_saved(page)
            check_number(page, '未選択')
            for sid, name in [('single-1', '腐食-1'), ('single-3', '腐食-2'), ('single-4', '補修材の再剥離-1')]:
                page.evaluate('id=>selectShape(id)', sid)
                open_inspector(page, width)
                check_number(page, name)
                assert shapes(page) == baseline
            assert all_saved(page) == before, 'Read-only number display must not update records or counters'
            field = page.locator('#typeNo')
            field.scroll_into_view_if_needed()
            assert field.evaluate("e=>e.getBoundingClientRect().width/e.closest('.stack').getBoundingClientRect().width") > .94
            page.evaluate('async()=>{await document.fonts.ready}')
            page.wait_for_timeout(350)
            (ROOT / 'test-results').mkdir(exist_ok=True)
            page.screenshot(path=str(ROOT / f'test-results/single-number-{width}.png'))
            page.evaluate('clearSelection()')
            check_number(page, '未選択')
            assert all_saved(page) == before
            # Multi-page selection still uses the existing type-specific sequence.
            page.evaluate("state.currentPage=2;selectShape('single-2')")
            check_number(page, '漏水-1')
            page.evaluate("state.currentPage=1;selectShape('single-3')")
            # The removed field cannot break instant reclassification or Undo/Redo.
            context.set_offline(True)
            page.locator('#damageType').select_option('漏水')
            check_number(page, '漏水-2')
            page.evaluate('undo()')
            check_number(page, '未選択')
            assert shapes(page) == baseline
            page.evaluate('redo()')
            assert page.evaluate("state.shapes.find(s=>s.id==='single-3').type") == '漏水'
            page.evaluate('undo()')
            assert shapes(page) == baseline
            # Existing delete/restore retains type numbers and ownership; legacy order follows the unchanged algorithm.
            identity_before = identities(page)
            page.evaluate("selectShape('single-1');$('deleteBtn').click()")
            check_number(page, '未選択')
            assert page.evaluate('state.shapes.length') == 3
            page.evaluate('undo()')
            assert identities(page) == identity_before
            baseline = shapes(page)
            # Adding a record still produces a single visible number.
            page.evaluate("clearSelection();$('damageType').value='腐食';addShape({kind:'line',points:[{x:30,y:40},{x:70,y:80}]})")
            check_number(page, '腐食-3')
            assert page.evaluate('state.shapes.at(-1).globalNo') == 5  # legacy field retained, not displayed
            page.evaluate('undo()')
            assert shapes(page) == baseline
            page.evaluate('async()=>{persist();await window.SentlogRecords.settled()}')
            with page.expect_download() as info:
                page.evaluate('exportSentlogBackup()')
            pack = json.loads(Path(info.value.path()).read_text())
            assert pack['drawingStates']['single-d']['shapes'] == json.loads(baseline)
            assert any(f['key'] == 'photo:single-d:single-photo' for f in pack['files'])
            context.set_offline(False)
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function("window.SENTLOG_BUILD==='v1.56'&&!!window.SentlogLabelColors")
            page.evaluate("async()=>{await window.sentlogAppReady;await openDrawing('single-p','single-d');selectShape('single-1')}")
            open_inspector(page, width)
            check_number(page, '腐食-1')
            assert shapes(page) == baseline
            assert page.locator('#damageNo').input_value() == 'G1-①'
            # The v1.93 safe-replacement guard must reject a size mismatch
            # instead of silently deleting a recorded drawing. The source image
            # is 800x1000; the replacement is deliberately 900x1000.
            before_replacement = shapes(page)
            original_background = page.evaluate("async()=>await (await getBackgroundFile('single-d')).text()")
            original_photo = page.evaluate("async()=>await (await getPhotoBlob('single-photo','single-d')).text()")
            dialogs = []
            page.once('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
            page.evaluate("""async()=>{
             const f=new File(['<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1000"></svg>'],'replacement.svg',{type:'image/svg+xml'});
             await $('fileInput').onchange({target:{files:[f],value:'replacement.svg'}});
            }""")
            assert dialogs and '安全に差し替えできません' in dialogs[0], dialogs
            check_number(page, '腐食-1')
            assert shapes(page) == before_replacement, 'Blocked replacement must preserve every shape'
            assert page.evaluate("async()=>await (await getBackgroundFile('single-d')).text()") == original_background
            assert page.evaluate("async()=>await (await getPhotoBlob('single-photo','single-d')).text()") == original_photo
            assert not errors, errors
            assert not calls, calls
            print(f'PASS {width}px: one full-width number; no global input; read-only select/clear; multi-page types; reclassify/delete/add/undo; photos; offline backup/reopen; incompatible file replacement rejected without data loss')
            context.close()
        browser.close()
finally:
    server.shutdown()
    server.server_close()

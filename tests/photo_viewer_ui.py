"""Photo pinch-release regressions with synthetic evidence only.

Chromium CDP supplies real browser touch sequences (including touchcancel).
The fixture retains the previous viewer/backdrop listeners to check integration.
Optionally add --built-root PATH to exercise a fully built production app as well.
This is a browser regression, not a physical iPhone memory/crash certification.
"""
import argparse
import base64
import functools
import io
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://photo-viewer.test'
VIEW_BUDGET = 1_500_000


def jpeg_fixture():
    """A real 20MP JPEG; contrasting quadrants make empty/stale renders visible."""
    image = Image.new('RGB', (5000, 4000), '#d02020')
    painter = ImageDraw.Draw(image)
    painter.rectangle((2500, 0, 4999, 3999), fill='#2030d0')
    painter.rectangle((0, 2000, 2499, 3999), fill='#20b040')
    painter.rectangle((2500, 2000, 4999, 3999), fill='#e0d020')
    output = io.BytesIO()
    image.save(output, 'JPEG', quality=88)
    return output.getvalue()


AUDIT = r"""
window.photoAudit={created:0,maxPixels:0,oversize:0,urls:0,revokes:0,liveUrls:new Set(),events:[]};
const makeElement=document.createElement.bind(document);
document.createElement=function(tag,...args){
  if(String(tag).toLowerCase()==='canvas')photoAudit.created++;
  return makeElement(tag,...args);
};
for(const key of ['width','height']){
  const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
  Object.defineProperty(HTMLCanvasElement.prototype,key,{...descriptor,set(value){
    const other=key==='width'?this.height:this.width,pixels=Number(value)*other;
    photoAudit.maxPixels=Math.max(photoAudit.maxPixels,pixels);
    if(pixels>4000000){photoAudit.oversize++;throw Error('Canvas exceeded photo source budget');}
    descriptor.set.call(this,value);
  }});
}
const createUrl=URL.createObjectURL.bind(URL),revokeUrl=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=function(...args){const url=createUrl(...args);photoAudit.urls++;photoAudit.liveUrls.add(url);return url;};
URL.revokeObjectURL=function(url){photoAudit.revokes++;photoAudit.liveUrls.delete(url);return revokeUrl(url);};
for(const phase of ['pointerdown','pointerup','pointercancel'])document.addEventListener(phase,e=>photoAudit.events.push({id:e.pointerId,type:e.pointerType,phase}),true);
"""


def fixture_html(encoded):
    source = (ROOT / 'sentlog/part06.txt').read_text(encoding='utf-8')
    start = source.index('async function openPhotoViewer(')
    end = source.index('async function renderSelectedPhotos(', start)
    original_functions = source[start:end]
    css = (ROOT / 'sentlog/part02.txt').read_text(encoding='utf-8')
    css = css[css.index('.photo-viewer{'):css.index('.photo-badge{')]
    return """<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>body{margin:0;font-family:sans-serif}#stageWrap{position:fixed;inset:80px 0 0;background:#ddd}
button{min-height:42px}""" + css + """</style></head><body>
<section id="editorView"><button id="openPhotoButton">写真を開く</button><button id="navBackBtn">戻る</button>
<div id="stageWrap"><div id="stage" style="transform:translate(31px,47px) scale(1.75)">図面記録</div></div></section>
<section id="projectsView" hidden>トップ画面</section>
<div class="photo-viewer" id="photoViewer" aria-hidden="true">
<button id="photoViewerClose" class="photo-viewer-close" type="button">×</button>
<img id="photoViewerImg" alt="変状写真"><div id="photoViewerName" class="photo-viewer-name"></div></div>
<script>
const $=id=>document.getElementById(id);
let activeDrawingId='drawing-fixture',activeProjectId='project-fixture',currentView='editor',viewerPhotoUrl=null;
let scale=1.75,tx=31,ty=47,selected='record-fixture';
let state={project:'Synthetic project',width:1200,height:800,currentPage:2,
  shapes:[{id:'record-fixture',kind:'rect',x:320,y:250,w:60,h:40,type:'ひび割れ',photos:[{id:'photo-fixture'}]}],
  pageSettings:{'2':{scaleDenom:100,paperSize:'A3'}}};
window.fixture={reads:[],writes:0,navigations:0,backgroundEvents:0,deferred:{},blobs:new Map()};
const bytes=Uint8Array.from(atob(""" + json.dumps(encoded) + """),c=>c.charCodeAt(0));
fixture.blobs.set('photo-fixture',new Blob([bytes],{type:'image/jpeg'}));
fixture.blobs.set('blue',new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="blue"/></svg>'],{type:'image/svg+xml'}));
fixture.blobs.set('corrupt',new Blob(['not a readable photo'],{type:'image/jpeg'}));
async function getPhotoBlob(id,drawingId=activeDrawingId){
  fixture.reads.push({id,drawingId});
  if(id.startsWith('slow'))return new Promise((resolve,reject)=>fixture.deferred[id]={resolve,reject});
  return fixture.blobs.get(id)||null;
}
function persist(){fixture.writes++}
function showProjects(){fixture.navigations++;currentView='projects';$('editorView').hidden=true;$('projectsView').hidden=false}
function snapshot(){return JSON.stringify({state,activeDrawingId,activeProjectId,currentView,selected,scale,tx,ty,transform:$('stage').style.transform})}
async function photoHash(){const data=await fixture.blobs.get('photo-fixture').arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).join(',')}
""" + original_functions + """
$('photoViewerClose').onclick=closePhotoViewer;
$('photoViewer').addEventListener('pointerdown',e=>{if(e.target===$('photoViewer'))closePhotoViewer()});
$('openPhotoButton').onclick=()=>openPhotoViewer('photo-fixture','Fixture photo');
$('navBackBtn').onclick=showProjects;
$('stageWrap').addEventListener('pointerdown',()=>fixture.backgroundEvents++);
</script></body></html>"""


def wait_ready(page):
    page.wait_for_function("['ready','error'].includes(document.getElementById('photoViewer').dataset.photoState)")
    assert page.locator('#photoViewer').get_attribute('data-photo-state') == 'ready', page.locator('#photoViewerMessage').inner_text()
    page.wait_for_function("document.getElementById('photoViewerCanvas').width>1")


def state_of(page):
    return page.evaluate("""()=>{
      const viewer=document.getElementById('photoViewer'),canvas=document.getElementById('photoViewerCanvas'),r=canvas.getBoundingClientRect();
      return {open:viewer.classList.contains('open'),aria:viewer.getAttribute('aria-hidden'),state:viewer.dataset.photoState,
        zoom:Number(canvas.dataset.zoom),width:canvas.width,height:canvas.height,cssWidth:r.width,cssHeight:r.height,
        pageScale:window.visualViewport?.scale||1,created:photoAudit.created,urls:photoAudit.urls,maxPixels:photoAudit.maxPixels,
        oversize:photoAudit.oversize,liveUrls:photoAudit.liveUrls.size};
    }""")


def assert_ready(page):
    value = state_of(page)
    assert value['open'] and value['aria'] == 'false' and value['state'] == 'ready', value
    assert value['width'] * value['height'] <= VIEW_BUDGET, value
    assert max(value['width'], value['height']) <= 4096, value
    assert value['oversize'] == 0, value
    return value


def touch_point(identifier, x, y):
    return {'id': identifier, 'x': x, 'y': y, 'radiusX': 5, 'radiusY': 5, 'force': 1}


def real_pinch(page, session, sequential=True, cancel=False, lose_capture=False):
    """Use real Chromium input, or DOM pointer events for Linux WebKit."""
    previous_points = {}

    def dispatch(kind, points):
        nonlocal previous_points
        current = {point['id']: point for point in points}
        if session:
            # Our helper takes REMAINING contacts. Chromium's WebTouch path
            # instead takes RELEASED contacts for a partial touchEnd.
            payload = [point for key, point in previous_points.items() if key not in current] if kind == 'touchEnd' and points else points
            try:
                session.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': payload})
            except Exception as error:
                # The newer SyntheticPointerActions path adds/removes contacts
                # through touchMove. Adapt only its explicit protocol rejection.
                protocol_message = str(error)
                end_variant = kind == 'touchEnd' and points and 'TouchEnd and TouchCancel must not have any touch points' in protocol_message
                start_variant = kind == 'touchStart' and previous_points and 'Must have no prior active touch points' in protocol_message
                if not (end_variant or start_variant):
                    raise
                session.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': points})
            previous_points = current
            return
        if kind == 'touchCancel':
            events = [('pointercancel', point) for point in previous_points.values()]
        elif kind == 'touchEnd':
            events = [('pointerup', point) for key, point in previous_points.items() if key not in current]
        elif kind == 'touchStart':
            events = [('pointerdown', point) for key, point in current.items() if key not in previous_points]
        else:
            events = [('pointermove', point) for point in current.values()]
        for event, point in events:
            page.dispatch_event('#photoViewerCanvas', event, {
                'pointerType': 'touch', 'pointerId': point['id'], 'isPrimary': point['id'] == 11,
                'clientX': point['x'], 'clientY': point['y'], 'button': 0,
                'buttons': 0 if event in ('pointerup', 'pointercancel') else 1,
                'bubbles': True, 'cancelable': True,
            })
        previous_points = current

    box = page.locator('#photoViewerCanvas').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    previous = state_of(page)['zoom']
    start_events = page.evaluate('photoAudit.events.length')
    dispatch('touchStart', [touch_point(11, cx-35, cy)])
    dispatch('touchStart', [touch_point(11, cx-35, cy), touch_point(12, cx+35, cy)])
    downs = page.evaluate("start=>photoAudit.events.slice(start).filter(e=>e.type==='touch'&&e.phase==='pointerdown').map(e=>e.id)", start_events)
    assert len(downs) == 2, downs
    for distance in (45, 65, 90):
        dispatch('touchMove', [touch_point(11, cx-distance, cy), touch_point(12, cx+distance, cy)])
    # The surface publishes its zoom on requestAnimationFrame. Wait for the
    # final 180px / 70px pinch, not an earlier intermediate move's painted zoom.
    expected_zoom = min(8, previous * 180 / 70)
    page.wait_for_function("expected=>Math.abs(Number(document.getElementById('photoViewerCanvas').dataset.zoom)-expected)<.001", arg=expected_zoom)
    zoomed = assert_ready(page)
    if lose_capture:
        page.evaluate("""()=>{
          const id=photoAudit.events.filter(e=>e.type==='touch').at(-1).id;
          document.getElementById('photoViewerCanvas').dispatchEvent(new PointerEvent('lostpointercapture',{bubbles:true,pointerType:'touch',pointerId:id}));
        }""")
    if cancel:
        dispatch('touchCancel', [])
    elif sequential:
        dispatch('touchEnd', [touch_point(12, cx+90, cy)])
        released = page.evaluate("start=>photoAudit.events.slice(start).filter(e=>e.type==='touch'&&e.phase==='pointerup').map(e=>e.id)", start_events)
        assert released == [downs[0]], (downs, released)
        assert_ready(page)
        dispatch('touchMove', [touch_point(12, cx+100, cy+12)])
        assert page.evaluate("start=>photoAudit.events.slice(start).filter(e=>e.type==='touch'&&e.phase==='pointerdown').length", start_events) == 2
        dispatch('touchEnd', [])
    else:
        dispatch('touchEnd', [])
    # Let any release-triggered draw finish before checking the retained view.
    page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    final = assert_ready(page)
    assert abs(final['zoom'] - zoomed['zoom']) < .02, (zoomed, final)
    assert abs(final['pageScale'] - 1) < .01, final
    assert (final['width'], final['height']) == (zoomed['width'], zoomed['height']), (zoomed, final)
    return final


def fixture_regression(browser, encoded, mobile, engine):
    context = browser.new_context(viewport={'width': 390 if mobile else 1280, 'height': 844 if mobile else 900},
                                  is_mobile=mobile, has_touch=mobile, device_scale_factor=3 if mobile else 1,
                                  service_workers='block')
    context.add_init_script(AUDIT)
    unexpected = []

    def route(request):
        if request.request.url == ORIGIN + '/':
            request.fulfill(status=200, content_type='text/html', body=fixture_html(encoded))
        elif request.request.url.startswith(('blob:', 'data:')):
            request.continue_()
        elif request.request.url == ORIGIN + '/favicon.ico':
            request.fulfill(status=204, body='')
        else:
            unexpected.append(request.request.url)
            request.abort()

    context.route('**/*', route)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(ORIGIN + '/')
    # Establish the concrete regression: the legacy viewer leaves native page
    # gestures enabled. Do not claim to reproduce an OS process-memory kill.
    baseline = page.evaluate("""()=>{
      const viewer=$('photoViewer'),e=new Event('gesturestart',{bubbles:true,cancelable:true});
      viewer.dispatchEvent(e);return {touchAction:getComputedStyle(viewer).touchAction,prevented:e.defaultPrevented};
    }""")
    assert baseline == {'touchAction': 'auto', 'prevented': False}, baseline
    page.add_script_tag(content=(ROOT / 'sentlog/photo-viewer.js').read_text(encoding='utf-8'))
    page.wait_for_selector('#photoViewerCanvas', state='attached')
    before = page.evaluate('snapshot()')
    original_hash = page.evaluate('photoHash()')
    page.locator('#openPhotoButton').click()
    wait_ready(page)
    opened = assert_ready(page)
    assert opened['zoom'] == 1, opened
    page.evaluate("window.initialPhotoSurface=document.getElementById('photoViewerCanvas')")
    guards = page.evaluate("""()=>{
      const viewer=$('photoViewer');
      return {touchAction:getComputedStyle(viewer).touchAction,events:['gesturestart','gesturechange','gestureend'].map(type=>{
        const event=new Event(type,{bubbles:true,cancelable:true});viewer.dispatchEvent(event);return event.defaultPrevented;
      })};
    }""")
    assert guards['touchAction'] == 'none' and all(guards['events']), guards
    if mobile:
        session = context.new_cdp_session(page) if engine == 'chromium' else None
        for sequential, cancel, lose_capture in ((True, False, False), (False, False, False), (True, True, False), (True, False, True), (True, False, False)):
            page.locator('#photoViewerReset').click()
            page.wait_for_function("Number(document.getElementById('photoViewerCanvas').dataset.zoom)===1")
            real_pinch(page, session, sequential, cancel, lose_capture)
        after = assert_ready(page)
        assert after['created'] == opened['created'] and after['urls'] == opened['urls'], (opened, after)
        assert page.evaluate("document.getElementById('photoViewerCanvas')===window.initialPhotoSurface")
    else:
        page.locator('#photoViewerZoomIn').click()
        page.wait_for_function("Number(document.getElementById('photoViewerCanvas').dataset.zoom)>1")
        zoom = state_of(page)['zoom']
        page.locator('#photoViewerZoomOut').click()
        page.wait_for_function("zoom=>Number(document.getElementById('photoViewerCanvas').dataset.zoom)<zoom", arg=zoom)
        page.locator('#photoViewerReset').click()
        page.locator('#photoViewerCanvas').hover()
        page.mouse.wheel(0, -240)
        page.wait_for_function("Number(document.getElementById('photoViewerCanvas').dataset.zoom)>1")
        assert_ready(page)
    # A contact on the backdrop must no longer invoke the old pointerdown close.
    page.dispatch_event('#photoViewer', 'pointerdown', {'pointerType': 'touch', 'pointerId': 90, 'clientX': 2, 'clientY': 2, 'button': 0, 'buttons': 1})
    page.dispatch_event('#photoViewer', 'pointerup', {'pointerType': 'touch', 'pointerId': 90, 'clientX': 2, 'clientY': 2, 'button': 0, 'buttons': 0})
    assert_ready(page)
    page.locator('#photoViewerClose').click()
    page.wait_for_function("document.getElementById('photoViewer').dataset.photoState==='closed'")
    assert page.evaluate('snapshot()') == before
    assert page.evaluate('photoHash()') == original_hash
    assert page.evaluate("document.activeElement.id") == 'openPhotoButton'
    assert page.evaluate('fixture.writes===0&&fixture.navigations===0&&fixture.backgroundEvents===0')
    assert state_of(page)['liveUrls'] == 0

    for photo in ('missing', 'corrupt'):
        page.evaluate('(id)=>openPhotoViewer(id,id)', photo)
        page.wait_for_function("document.getElementById('photoViewer').dataset.photoState==='error'")
        assert page.locator('#photoViewerMessage').inner_text().strip()
        assert page.evaluate('snapshot()') == before
        assert page.evaluate("document.getElementById('photoViewer').classList.contains('open')")
        page.locator('#photoViewerClose').click()
        assert state_of(page)['liveUrls'] == 0

    # Closing while an IndexedDB read is pending must not reopen the viewer.
    page.evaluate("()=>{window.pendingOpen=openPhotoViewer('slow-close','Slow close')}")
    page.wait_for_function("!!fixture.deferred['slow-close']")
    page.evaluate('closePhotoViewer()')
    page.evaluate("()=>{fixture.deferred['slow-close'].resolve(fixture.blobs.get('photo-fixture'));return window.pendingOpen}")
    assert state_of(page)['state'] == 'closed' and state_of(page)['liveUrls'] == 0
    # A later photo must win over a slower preceding read.
    page.evaluate("()=>{window.pendingOpen=openPhotoViewer('slow-old','Old photo')}")
    page.wait_for_function("!!fixture.deferred['slow-old']")
    page.evaluate("openPhotoViewer('blue','New blue photo')")
    wait_ready(page)
    page.evaluate("()=>{fixture.deferred['slow-old'].resolve(fixture.blobs.get('photo-fixture'));return window.pendingOpen}")
    assert_ready(page)
    assert page.locator('#photoViewerName').inner_text() == 'New blue photo'
    pixel = page.evaluate("""()=>{const c=$('photoViewerCanvas');return Array.from(c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data)}""")
    assert pixel[2] > 200 and pixel[0] < 30 and pixel[1] < 30, pixel
    page.keyboard.press('Escape')
    assert state_of(page)['state'] == 'closed'
    assert page.evaluate('snapshot()') == before and page.evaluate('photoHash()') == original_hash
    assert page.evaluate('fixture.reads.every(read=>read.drawingId==="drawing-fixture")')
    assert not errors and not unexpected, (errors, unexpected)
    assert state_of(page)['oversize'] == 0 and state_of(page)['liveUrls'] == 0
    context.close()
    print('PASS photo viewer '+engine+' '+('mobile' if mobile else 'desktop')+': guarded gestures, stable editor/original, bounded reusable canvas, release/cancel, errors and async races')


def built_regression(browser, built_root, encoded, engine):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(built_root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    context = None
    try:
        options = dict(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                       device_scale_factor=3, service_workers='block')
        context = browser.new_context(**options)
        # Other app renderers have their own budgets, so only audit photo memory
        # in the isolated fixture above. Here test assembled-app integration.

        def route(request):
            if request.request.url.startswith((origin + '/', 'blob:', 'data:')):
                request.continue_()
            elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                request.fulfill(status=200, content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No PDF in photo fixture")}};')
            else:
                request.abort()

        context.route('**/*', route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(origin + '/sentlog/', wait_until='domcontentloaded')
        page.wait_for_function("window.sentlogAppReady&&!!document.getElementById('photoViewerCanvas')", timeout=30000)
        # The production loader replaces its bootstrap document with
        # document.open/write. Observe the finished document, not discarded
        # bootstrap listeners, so the real finger-release assertion is valid.
        page.evaluate("window.photoAudit={created:0,urls:0,maxPixels:0,oversize:0,liveUrls:new Set(),events:[]};for(const phase of ['pointerdown','pointerup','pointercancel'])document.addEventListener(phase,e=>photoAudit.events.push({id:e.pointerId,type:e.pointerType,phase}),true)")
        before = page.evaluate("""async ({encoded,engine})=>{
          await window.sentlogAppReady;
          const id='photo-test-drawing',pid='photo-test-project',meta={id,name:'Synthetic drawing',sourceType:'image',fileName:'drawing.svg',pageCount:1};
          workspace={projects:[{id:pid,name:'Synthetic photo test',drawings:[meta]}]};
          SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(workspace));
          SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify({...freshDrawingState('Synthetic photo test'),sourceType:'image',fileName:'drawing.svg',width:1200,height:800,
            shapes:[{id:'photo-test-record',kind:'rect',page:1,type:'ひび割れ',typeNo:1,globalNo:1,x:350,y:250,w:100,h:80,photos:[{id:'photo-test',name:'Evidence photo'}]}]}));
          const file=new File(['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="white"/></svg>'],'drawing.svg',{type:'image/svg+xml'});
          const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
          const photoBlob=new Blob([bytes],{type:'image/jpeg'});
          if(engine==='webkit'){
            // Linux WebKit automation cannot reliably persist synthetic Files
            // (also documented in image_memory_ui.py). Keep only Blob transport
            // outside this renderer integration test; all records still use IDB.
            // Chromium below covers the actual file-store round trip.
            const files=new Map([['background:'+id,file],[photoDBKey('photo-test',id),photoBlob]]);
            const originalRead=getDBFile;
            getDBFile=async function(key){return files.has(key)?files.get(key):originalRead.apply(this,arguments)};
          }else{
            await SentlogRecords.writeFile('background:'+id,file);
            await savePhotoBlob('photo-test',photoBlob,id);
          }
          window.photoBuiltHash=async()=>{
            const blob=await getPhotoBlob('photo-test',id);
            return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).join(',');
          };
          await SentlogRecords.settled();await openDrawing(pid,id);
          selected='photo-test-record';scale=1.7;tx=-140;ty=-90;applyTransform();render();
          window.photoBuiltSnapshot=()=>JSON.stringify({state,activeDrawingId,activeProjectId,currentView,selected,scale,tx,ty});
          return photoBuiltSnapshot();
        }""", {'encoded': encoded, 'engine': engine})
        original_hash = page.evaluate('photoBuiltHash()')
        page.evaluate("openPhotoViewer('photo-test','Evidence photo')")
        wait_ready(page)
        session = context.new_cdp_session(page) if engine == 'chromium' else None
        real_pinch(page, session, sequential=True)
        assert page.evaluate('photoBuiltSnapshot()') == before
        assert page.evaluate('photoBuiltHash()') == original_hash
        page.locator('#photoViewerClose').click()
        assert page.evaluate('photoBuiltSnapshot()') == before
        assert page.locator('#editorView').is_visible()
        assert not errors, errors
        transport = 'Blob transport fixture; renderer integration' if engine == 'webkit' else 'real IndexedDB Blob round trip'
        print('PASS built app '+engine+' ('+transport+'): pinch/release remains in photo viewer; close returns to unchanged drawing, records and original photo')
    finally:
        if context:
            context.close()
        server.shutdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--built-root', type=Path)
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    args = parser.parse_args()
    encoded = base64.b64encode(jpeg_fixture()).decode('ascii')
    with sync_playwright() as playwright:
        options = {'headless': True}
        if args.engine == 'chromium' and not os.path.exists(playwright.chromium.executable_path) and os.path.exists('/usr/bin/chromium'):
            options.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        browser = getattr(playwright, args.engine).launch(**options)
        try:
            fixture_regression(browser, encoded, mobile=True, engine=args.engine)
            fixture_regression(browser, encoded, mobile=False, engine=args.engine)
            if args.built_root:
                built_regression(browser, args.built_root.resolve(), encoded, engine=args.engine)
        finally:
            browser.close()


if __name__ == '__main__':
    main()

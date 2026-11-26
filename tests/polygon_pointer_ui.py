"""Polygon release stability in the complete built application.

The browser and its IndexedDB/File storage are real. Touch and pen inputs are
synthetic DOM PointerEvents, dispatched through the application's installed
event listeners; this is not physical iPhone/iPad or native pointer-capture
verification. Mouse and dimension-form interactions use browser input. All
records/images are synthetic and all external requests are blocked.
"""
import argparse
import base64
import functools
import hashlib
import json
import math
import os
import struct
import tempfile
import threading
import time
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'polygon-pointer-project'
DRAWING = 'polygon-pointer-drawing'


def png(width=2000, height=1600):
    def chunk(kind, value):
        return (struct.pack('!I', len(value))+kind+value+
                struct.pack('!I', zlib.crc32(kind+value) & 0xffffffff))
    pixels = b''.join(b'\x00'+b'\xff\xff\xff'*width for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0))+
            chunk(b'IDAT', zlib.compress(pixels))+chunk(b'IEND', b''))


def evaluate(page, source, arg=None):
    """Bound every asynchronous fixture/storage action and retain diagnostics."""
    return page.evaluate("""async ({source,arg})=>{
      let timer;
      try{
        const fn=eval('('+source+')');
        return await Promise.race([Promise.resolve(typeof fn==='function'?fn(arg):fn),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Polygon step timeout: '+
            JSON.stringify({document:document.readyState,view:typeof currentView==='undefined'?null:currentView,
              storageReady:!!window.SentlogRecords?.ready,pending:window.SentlogRecords?.pending}))),20000);})]);
      }finally{clearTimeout(timer);}
    }""", {'source': source, 'arg': arg})


def ready(page):
    page.wait_for_function('window.sentlogAppReady&&window.SentlogCameraReturn&&window.SentlogPolygonDimensions&&window.SentlogShapeDimensions', timeout=60000)
    evaluate(page, 'async()=>{await sentlogAppReady;await SentlogCameraReturn.ready;}')


def points(page):
    return page.evaluate('()=>drawing?.points.map(p=>({x:p.x,y:p.y}))||[]')


def same_point(actual, expected, label):
    assert math.hypot(actual['x']-expected['x'], actual['y']-expected['y']) < 1e-5, (label, actual, expected)


def pointer(page, kind, pointer_type, pointer_id, x, y, primary=True):
    """Coordinates are CSS pixels inside the actual stage, independent of zoom."""
    return page.evaluate("""p=>{
      const stage=$('stageWrap'),rect=stage.getBoundingClientRect();
      if(p.x<0||p.y<0||p.x>=rect.width||p.y>=rect.height)
        throw Error('Synthetic pointer outside visible stage: '+JSON.stringify({p,width:rect.width,height:rect.height}));
      const clientX=rect.left+p.x,clientY=rect.top+p.y;
      const target=p.kind==='pointerdown'?document.elementFromPoint(clientX,clientY):stage;
      if(!target||!stage.contains(target))throw Error('Stage input intercepted by another UI element');
      const ending=p.kind==='pointerup'||p.kind==='pointercancel';
      const event=new PointerEvent(p.kind,{bubbles:true,cancelable:true,composed:true,
        pointerId:p.pointerId,pointerType:p.pointerType,isPrimary:p.primary,
        clientX,clientY,button:0,buttons:ending?0:1,pressure:ending?0:.5});
      target.dispatchEvent(event);
      return {trusted:event.isTrusted,points:drawing?.points?.length||0};
    }""", {'kind': kind, 'pointerType': pointer_type, 'pointerId': pointer_id,
            'x': x, 'y': y, 'primary': primary})


def tap(page, pointer_type, pointer_id, x, y):
    pointer(page, 'pointerdown', pointer_type, pointer_id, x, y)
    pointer(page, 'pointerup', pointer_type, pointer_id, x, y)


def start(page, zoom=1, calibrated=False):
    # Actual tool buttons clear the previous draft and any release candidate.
    if page.evaluate("tool==='polygon'"):
        page.locator('[data-tool="polygon"]').click()
    page.locator('[data-tool="polygon"]').click()
    page.evaluate("""({zoom,calibrated})=>{
      if(activeTouches.size||gestureLock)throw Error('Previous pointer sequence not finished');
      scale=zoom;tx=ty=0;
      state.pageSettings['1']={paperSize:'custom',customW:2000,customH:1600,
        scaleDenom:calibrated?1:null,orientation:'auto'};
      applyTransform();render();
    }""", {'zoom': zoom, 'calibrated': calibrated})
    assert page.evaluate("tool==='polygon'&&drawing===null")


def first_edge(page, pointer_type='touch', zoom=1, calibrated=False):
    start(page, zoom, calibrated)
    tap(page, pointer_type, 10, 100, 200)
    tap(page, pointer_type, 11, 300, 200)
    actual = points(page)
    assert len(actual) == 2, actual
    same_point(actual[0], {'x': 100/zoom, 'y': 200/zoom}, 'first vertex')
    same_point(actual[1], {'x': 300/zoom, 'y': 200/zoom}, 'first edge end')


def preview(page):
    return page.evaluate("""()=>{
      const guide=polygonDraftCursor;
      const line=[...svg.querySelectorAll('polyline')].find(e=>e.getAttribute('stroke')===
        (guide?.closing?'#16a34a':'#2563eb'));
      return {guide:guide?JSON.parse(JSON.stringify(guide)):null,visibleLine:line?.getAttribute('points')||null};
    }""")


PROOF = """async()=>{
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey('polygon-pointer-drawing')));
  const old=saved.shapes.find(s=>s.id==='existing-rectangle');
  const file=await getDBFile('background:polygon-pointer-drawing');
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))]
    .map(n=>n.toString(16).padStart(2,'0')).join('');
  return {old:{id:old.id,kind:old.kind,page:old.page,type:old.type,x:old.x,y:old.y,w:old.w,h:old.h,
    memo:old.memo,photos:old.photos},backgroundHash:hash,
    polygons:saved.shapes.filter(s=>s.kind==='polygon').map(s=>({id:s.id,points:s.points}))};
}"""


def run(page, report):
    def phase(label):
        report['phase'] = label
        print('POLYGON_POINTER_PROGRESS '+json.dumps({'engine': report['engine'], 'phase': label}), flush=True)

    phase('native persistent fixture')
    image = png()
    evaluate(page, """async encoded=>{
      const meta={id:'polygon-pointer-drawing',name:'Synthetic pointer plan',sourceType:'image',
        fileName:'polygon-pointer.png',pageCount:1,createdAt:1,updatedAt:1};
      const project={id:'polygon-pointer-project',name:'Synthetic polygon pointer verification',
        drawings:[meta],createdAt:1,updatedAt:1};
      workspace={projects:[project]};SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(workspace));
      SentlogRecords.setItem(drawingStorageKey(meta.id),JSON.stringify({...freshDrawingState(project.name),
        sourceType:'image',fileName:meta.fileName,width:2000,height:1600,pageCount:1,currentPage:1,
        shapes:[{id:'existing-rectangle',kind:'rect',page:1,type:'腐食',typeNo:1,x:1600,y:1300,w:100,h:80,
          strokeWidth:.8,memo:'Existing synthetic note must survive',photos:[]}]}));
      await SentlogRecords.writeFile('background:'+meta.id,new File([
        Uint8Array.from(atob(encoded),n=>n.charCodeAt(0))],meta.fileName,{type:'image/png'}));
      await SentlogRecords.settled();await openDrawing(project.id,meta.id);
      persist();await SentlogRecords.settled();
    }""", base64.b64encode(image).decode())
    expect(page.locator('#editorView')).to_be_visible()
    baseline = evaluate(page, PROOF)
    assert baseline['backgroundHash'] == hashlib.sha256(image).hexdigest(), baseline
    assert baseline['polygons'] == []
    report['releaseCases'] = []

    for pointer_type in ('touch', 'pen'):
        for zoom in (.25, .5, 1, 2):
            phase(f'{pointer_type} release jitter at zoom {zoom}')
            first_edge(page, pointer_type, zoom)
            pointer(page, 'pointerdown', pointer_type, 12, 307, 221)
            pointer(page, 'pointermove', pointer_type, 12, 310, 225)
            guide = preview(page)
            assert guide['visibleLine'] and guide['guide']['valid'], guide
            expected = {'x': 300/zoom, 'y': 225/zoom}
            same_point(guide['guide']['points'][-1], expected, 'vertical preview before lift')
            pointer(page, 'pointerup', pointer_type, 12, 311, 225)
            actual = points(page)
            assert len(actual) == 3, actual
            # On v1.97 this is (318/zoom,218/zoom): a 1 CSS px release drift
            # changes the previously displayed vertical edge into a diagonal.
            same_point(actual[-1], expected, 'release changed displayed second-edge candidate')
            report['releaseCases'].append({'pointerType': pointer_type, 'zoom': zoom,
                'rawReleaseShiftCssPx': 1, 'preview': guide['guide']['points'], 'committed': actual[-1]})

        phase(f'{pointer_type} tap-only and intentional direction changes')
        first_edge(page, pointer_type)
        pointer(page, 'pointerdown', pointer_type, 20, 310, 225)
        pointer(page, 'pointerup', pointer_type, 20, 311, 225)
        same_point(points(page)[-1], {'x': 300, 'y': 225}, 'tap-only candidate')
        first_edge(page, pointer_type)
        pointer(page, 'pointerdown', pointer_type, 21, 310, 225)
        pointer(page, 'pointermove', pointer_type, 21, 330, 230)
        pointer(page, 'pointerup', pointer_type, 21, 330, 230)
        same_point(points(page)[-1], {'x': 330, 'y': 230}, 'deliberate diagonal remains supported')
        first_edge(page, pointer_type)
        pointer(page, 'pointerdown', pointer_type, 22, 310, 225)
        pointer(page, 'pointermove', pointer_type, 22, 310, 225)
        pointer(page, 'pointerup', pointer_type, 22, 350, 250)
        same_point(points(page)[-1], {'x': 350, 'y': 250}, 'large release must use current position')

        phase(f'{pointer_type} cancellation invalidates the previous candidate')
        first_edge(page, pointer_type)
        pointer(page, 'pointerdown', pointer_type, 23, 310, 225)
        pointer(page, 'pointermove', pointer_type, 23, 310, 225)
        pointer(page, 'pointercancel', pointer_type, 23, 311, 225)
        assert len(points(page)) == 2
        tap(page, pointer_type, 24, 330, 230)
        same_point(points(page)[-1], {'x': 330, 'y': 230}, 'new contact after cancellation')
    report['intentionalAnglesLargeReleaseTapAndCancel'] = True

    phase('tool switch and pinch invalidate pending input')
    first_edge(page)
    pointer(page, 'pointerdown', 'touch', 30, 310, 225)
    pointer(page, 'pointermove', 'touch', 30, 310, 225)
    page.locator('[data-tool="line"]').click()
    pointer(page, 'pointerup', 'touch', 30, 311, 225)
    assert points(page) == [] and page.evaluate('state.shapes.length') == 1
    first_edge(page)
    pointer(page, 'pointerdown', 'touch', 31, 310, 225)
    pointer(page, 'pointerdown', 'touch', 32, 360, 225, primary=False)
    assert page.evaluate('drawing===null&&gestureLock')
    pointer(page, 'pointerup', 'touch', 31, 310, 225)
    pointer(page, 'pointerup', 'touch', 32, 360, 225, primary=False)
    assert page.evaluate('drawing===null&&!gestureLock&&activeTouches.size===0&&state.shapes.length===1')
    report['toolSwitchAndPinch'] = True

    phase('dimension edit updates the anchor before the next side')
    first_edge(page, calibrated=True)
    target = page.locator('[data-dimension-length-target="true"]').first
    expect(target).to_be_attached()
    position = target.evaluate("""el=>{const r=el.getBoundingClientRect(),s=$('stageWrap').getBoundingClientRect();
      return {x:r.left+r.width/2-s.left,y:r.top+r.height/2-s.top};}""")
    pointer(page, 'pointerdown', 'touch', 40, position['x'], position['y'])
    expect(page.locator('.sentlog-polygon-dimension-editor')).to_be_visible(timeout=4000)
    pointer(page, 'pointerup', 'touch', 40, position['x'], position['y'])
    page.locator('.sentlog-polygon-dimension-editor input').fill('0.250')
    page.locator('.sentlog-polygon-dimension-editor button[type="submit"]').click()
    expect(page.locator('.sentlog-polygon-dimension-editor')).to_have_count(0)
    assert len(points(page)) == 2
    same_point(points(page)[-1], {'x': 350, 'y': 200}, 'dimension edit must resize first edge')
    pointer(page, 'pointerdown', 'touch', 41, 360, 225)
    pointer(page, 'pointermove', 'touch', 41, 360, 225)
    pointer(page, 'pointerup', 'touch', 41, 361, 225)
    same_point(points(page)[-1], {'x': 350, 'y': 225}, 'new dimension anchor with release jitter')
    report['dimensionEdit'] = True

    phase('ordinary browser mouse input')
    start(page)
    box = page.locator('#stageWrap').bounding_box()
    for x, y in [(100, 200), (300, 200), (330, 230)]:
        page.mouse.move(box['x']+x, box['y']+y)
        page.mouse.click(box['x']+x, box['y']+y)
    assert len(points(page)) == 3
    same_point(points(page)[-1], {'x': 330, 'y': 230}, 'mouse direction behavior')
    report['ordinaryMouse'] = True

    phase('closing preview, single undo, durable save and reload')
    first_edge(page)
    tap(page, 'touch', 50, 300, 300)
    tap(page, 'touch', 51, 100, 300)
    undo_before = page.evaluate('historyFor().undo.length')
    pointer(page, 'pointerdown', 'touch', 52, 117.5, 200)
    pointer(page, 'pointermove', 'touch', 52, 117.5, 200)
    guide = preview(page)
    assert guide['visibleLine'] and guide['guide']['closing'] and guide['guide']['valid'], guide
    pointer(page, 'pointerup', 'touch', 52, 118.5, 200)
    assert page.evaluate('drawing===null&&state.shapes.length===2'), page.evaluate('({drawing,shapes:state.shapes})')
    assert page.evaluate('historyFor().undo.length') == undo_before+1
    saved = evaluate(page, PROOF)
    assert saved['old'] == baseline['old'] and saved['backgroundHash'] == baseline['backgroundHash'], saved
    assert len(saved['polygons']) == 1, saved
    expected = [{'x': 100, 'y': 200}, {'x': 300, 'y': 200}, {'x': 300, 'y': 300}, {'x': 100, 'y': 300}]
    assert saved['polygons'][0]['points'] == expected, saved
    page.locator('#undoBtn').click()
    assert page.evaluate('state.shapes.length') == 1
    page.locator('#redoBtn').click()
    assert page.evaluate('state.shapes.length') == 2
    assert evaluate(page, PROOF) == saved
    page.reload(wait_until='domcontentloaded')
    ready(page)
    evaluate(page, "async()=>{await openDrawing('polygon-pointer-project','polygon-pointer-drawing');}")
    assert evaluate(page, PROOF) == saved
    assert page.evaluate("state.shapes.find(s=>s.kind==='polygon').points") == expected
    report['closedPolygon'] = saved['polygons'][0]
    report['singleUndoRedoAndNativeReload'] = True
    report['existingRecordAndBackgroundPreserved'] = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    built = args.built_root.resolve()
    report = {'engine': args.engine, 'passed': False,
              'inputScope': 'Synthetic DOM touch/pen PointerEvents; real browser mouse and form input. No physical device or native capture claim.',
              'storageScope': 'Native IndexedDB and File objects in a temporary persistent browser profile.'}
    started = time.monotonic()

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(built)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix='sentlog-polygon-pointer-') as profile:
            engine = getattr(playwright, args.engine)
            launch = {'headless': True}
            if args.engine == 'chromium' and not os.path.exists(engine.executable_path) and os.path.exists('/usr/bin/chromium'):
                launch.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            context = engine.launch_persistent_context(profile, **launch,
                viewport={'width': 1280, 'height': 1000}, has_touch=True, service_workers='block')

            def route(request):
                url = request.request.url
                if url.startswith((origin+'/', 'blob:', 'data:')):
                    request.continue_()
                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request.fulfill(content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(15000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                report['phase'] = 'initial application ready'
                page.goto(origin+'/sentlog/', wait_until='domcontentloaded', timeout=60000)
                ready(page)
                report['build'] = page.evaluate('window.SENTLOG_BUILD')
                run(page, report)
                assert not errors, errors
                report['passed'] = True
            except Exception as error:
                report.update(error=str(error), pageErrors=errors)
                try:
                    report['lastState'] = page.evaluate("()=>({view:currentView,tool,scale,tx,ty,draft:drawing,guide:polygonDraftCursor,touches:activeTouches.size,gestureLock})")
                    if args.report:
                        args.report.parent.mkdir(parents=True, exist_ok=True)
                        page.screenshot(path=str(args.report.with_suffix('.png')))
                except Exception as inspection_error:
                    report['inspectionError'] = str(inspection_error)
                raise
            finally:
                context.close()
    finally:
        server.shutdown()
        server.server_close()
        report['elapsedSeconds'] = round(time.monotonic()-started, 2)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS '+args.engine+': polygon release preview stability across touch/pen/zoom; intentional angles, cancel/pinch/tool/dimension boundaries, mouse, closure, undo/redo and native reload', flush=True)


if __name__ == '__main__':
    main()

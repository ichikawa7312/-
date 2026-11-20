"""Real PDF.js/canvas regression for drawing load and camera-covered rotation.

Uses the exact built app, its pinned PDF.js bundle, synthetic PDF bytes and real
IndexedDB records. Camera hardware and stored background-file transport use the
existing isolated fixtures. All external services are blocked.
"""
import argparse
import base64
import functools
import hashlib
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from continuous_camera_ui import CAMERA_MOCK, open_camera
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]


def pdf_fixture():
    # Four colored quadrants give a pixel assertion independent of fonts.
    paint = b'1 0 0 rg 0 400 600 400 re f\n0 1 0 rg 600 400 600 400 re f\n0 0 1 rg 0 0 600 400 re f\n1 1 0 rg 600 0 600 400 re f\n'
    second = b'0 1 1 rg 0 0 800 1200 re f\n'
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 800] /Resources << >> /Contents 4 0 R >>',
               b'<< /Length '+str(len(paint)).encode()+b' >>\nstream\n'+paint+b'endstream',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 1200] /Resources << >> /Contents 6 0 R >>',
               b'<< /Length '+str(len(second)).encode()+b' >>\nstream\n'+second+b'endstream']
    data = b'%PDF-1.4\n'
    offsets = [0]
    for i, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += str(i).encode()+b' 0 obj\n'+body+b'\nendobj\n'
    xref = len(data)
    data += b'xref\n0 7\n0000000000 65535 f \n'
    data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    data += b'trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n'+str(xref).encode()+b'\n%%EOF\n'
    return data


TRACE = r"""()=>{
  const trace=window.drawingTrace={persists:0,renders:0,activeRenders:0,allocations:0,documents:[]};
  const oldPersist=persist;persist=function(){trace.persists++;return oldPersist.apply(this,arguments);};
  for(const key of ['width','height']){
    const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
    Object.defineProperty(HTMLCanvasElement.prototype,key,{...descriptor,set(value){
      trace.allocations++;descriptor.set.call(this,value);
    }});
  }
  const oldGetDocument=pdfjsLib.getDocument,seen=new WeakSet();
  window.pdfjsLib={...pdfjsLib,getDocument:function(){
    const task=oldGetDocument.apply(this,arguments);
    task.promise.then(doc=>{
      const entry={released:false,destroyCalls:0};trace.documents.push(entry);
      const oldDestroy=doc.destroy;doc.destroy=function(){entry.destroyCalls++;
        return oldDestroy.apply(this,arguments).then(value=>{entry.released=true;return value;});};
      const oldPage=doc.getPage;doc.getPage=async function(){
        const page=await oldPage.apply(this,arguments);
        if(!seen.has(page)){
          seen.add(page);const oldRender=page.render;
          page.render=function(){trace.renders++;trace.activeRenders++;
            const result=oldRender.apply(this,arguments);
            result.promise.then(()=>trace.activeRenders--,()=>trace.activeRenders--);return result;};
        }
        return page;
      };
    });
    return task;
  }};
}"""


def run(page, engine):
    png = base64.b64encode(photo_png()).decode('ascii')
    page.evaluate(SETUP, png)
    page.evaluate(CAMERA_MOCK, png)
    pdf = pdf_fixture()
    source_hash = hashlib.sha256(pdf).hexdigest()
    page.evaluate("""async encoded=>{
      showDrawings(memoFixture.pid);await SentlogRecords.settled();
      const id='memo-plan-a',file=new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],
        'fixture.pdf',{type:'application/pdf'});
      memoFixture.files.set('background:'+id,file);
      const raw=JSON.parse(SentlogRecords.getItem(drawingStorageKey(id)));
      Object.assign(raw,{sourceType:'pdf',fileName:'fixture.pdf',pageCount:2,currentPage:1});
      SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify(raw));
      const d=workspace.projects[0].drawings.find(d=>d.id===id);
      Object.assign(d,{sourceType:'pdf',fileName:'fixture.pdf',pageCount:2});saveWorkspace();
      await SentlogRecords.settled();
      window.pdfBeforeRecords=JSON.stringify(raw.shapes);
    }""", base64.b64encode(pdf).decode('ascii'))
    page.evaluate(TRACE)
    open_ms = page.evaluate("""async()=>{
      const start=performance.now();await openDrawing(memoFixture.pid,'memo-plan-a');
      await SentlogRecords.settled();return performance.now()-start;
    }""")
    page.wait_for_function("document.getElementById('sentlogPdfQuality').textContent==='表示：画面に合わせて表示'&&drawingTrace.activeRenders===0")
    opened = page.evaluate("""()=>({persists:drawingTrace.persists,renders:drawingTrace.renders,
      records:JSON.stringify(state.shapes),shown:empty.style.display==='none',
      corners:[[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y])=>
        [...ctx.getImageData(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1).data])})""")
    assert opened['persists'] == opened['renders'] == 1, opened
    assert opened['records'] == page.evaluate('pdfBeforeRecords') and opened['shown'], opened
    assert opened['corners'] == [[255, 0, 0, 255], [0, 255, 0, 255],
                                 [0, 0, 255, 255], [255, 255, 0, 255]], opened
    page.evaluate("""()=>{scale=2;tx=-100;ty=-80;applyTransform();}""")
    page.wait_for_function("document.querySelector('.sentlog-pdf-detail')&&drawingTrace.activeRenders===0")
    assert page.evaluate('drawingTrace.renders') == 2
    page.evaluate("SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open')")
    original = page.evaluate("JSON.stringify(state.shapes)")
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_enabled()
    page.wait_for_function('drawingTrace.activeRenders===0')
    before = page.evaluate("({renders:drawingTrace.renders,allocations:drawingTrace.allocations,calls:cameraMock.calls})")
    assert page.locator('.sentlog-pdf-detail').count() == 0
    for width, height in [(844, 390), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.evaluate("window.dispatchEvent(new Event('orientationchange'))")
        page.wait_for_timeout(350)
    covered = page.evaluate("""()=>({renders:drawingTrace.renders,allocations:drawingTrace.allocations,
      calls:cameraMock.calls,view:currentView,id:activeDrawingId,selected,
      records:JSON.stringify(state.shapes),open:SentlogContinuousCamera.isOpen()})""")
    assert covered['renders'] == before['renders'] and covered['allocations'] == before['allocations'], covered
    assert covered['calls'] == before['calls'] and covered['open'], covered
    assert covered['view'] == 'editor' and covered['id'] == 'memo-plan-a' and covered['selected'] == 'survey-a', covered
    assert covered['records'] == original
    page.locator('#slCameraDone').click()
    expect(page.locator('#sentlogContinuousCamera')).to_be_hidden()
    page.wait_for_function("document.getElementById('sentlogPdfQuality').textContent==='表示：画面に合わせて表示'&&drawingTrace.activeRenders===0")
    page.evaluate("""async()=>{await renderPdfPage(2);await SentlogRecords.settled();}""")
    turned = page.evaluate("""()=>({page:state.currentPage,saved:JSON.parse(SentlogRecords.getItem(drawingStorageKey(activeDrawingId))).currentPage,
      pixel:[...ctx.getImageData(Math.floor(canvas.width*.5),Math.floor(canvas.height*.5),1,1).data]})""")
    assert turned == {'page': 2, 'saved': 2, 'pixel': [0, 255, 255, 255]}, turned
    assert page.evaluate('drawingTrace.documents[0].destroyCalls') == 0
    for _ in range(2):
        page.evaluate("""async()=>{showDrawings(memoFixture.pid);await openDrawing(memoFixture.pid,'memo-plan-a');await SentlogRecords.settled();}""")
    page.evaluate('showProjects()')
    page.wait_for_function('drawingTrace.documents.length===3&&drawingTrace.documents.every(d=>d.released&&d.destroyCalls===1)')
    retained = page.evaluate("""async()=>{
      const file=memoFixture.files.get('background:memo-plan-a');
      const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
      return {hash:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join(''),
        records:JSON.stringify(JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a'))).shapes)};
    }""")
    assert retained['hash'] == source_hash and retained['records'] == original, retained
    print('DRAWING_RESPONSIVENESS '+json.dumps({'engine': engine, 'openMs': round(open_ms, 2),
          'openPersists': opened['persists'], 'openPdfRenders': opened['renders'],
          'coveredRotations': 2, 'coveredCanvasAllocations': covered['allocations']-before['allocations'],
          'releasedPdfWorkers': 3, 'originalSha256': source_hash}), flush=True)
    print('PASS '+engine+': real PDF pixels, one open persist/render, zoom detail, camera rotation without background allocations, saved page navigation and released document workers', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=['chromium', 'webkit'], required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    args = parser.parse_args()

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *unused):
            pass

    root = args.built_root.resolve()
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            browser = getattr(playwright, args.engine).launch(headless=True)
            context = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True,
                                          is_mobile=True, device_scale_factor=2, service_workers='block')

            def route(request):
                url = request.request.url
                if url.startswith((origin+'/', 'blob:', 'data:')):
                    request.continue_()
                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    name = 'export-pdf.worker.min.js' if 'worker' in url else 'export-pdf.min.js'
                    request.fulfill(content_type='text/javascript', body=(root/'sentlog/vendor'/name).read_bytes())
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(origin+'/sentlog/', wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogAppReady&&window.SentlogContinuousCamera&&window.SentlogCollaborationPhotos', timeout=45000)
                # Serve the worker from the same origin; no CDN or fake-worker fallback.
                page.evaluate("pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/export-pdf.worker.min.js'")
                run(page, args.engine)
                assert not errors, errors
            finally:
                browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()

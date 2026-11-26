"""Camera reload continuation in the complete app, with native IndexedDB files.

Camera hardware is synthetic. Navigation, original/shared photo storage, PDF
rendering, sync projection, sessionStorage and reload are the production paths.
All external services are blocked and every record is synthetic.
"""
import argparse
import base64
import functools
import hashlib
import json
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from continuous_camera_ui import CAMERA_MOCK, camera_count, open_camera
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]
KEY = 'sentlogCameraReturnV1'


def two_page_pdf():
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>']
    for page in range(2):
        stream = f'q 0 {page/2} 0 RG 3 w 40 40 520 320 re S Q'.encode()
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> /Contents {4+2*page} 0 R >>'.encode())
        objects.append(f'<< /Length {len(stream)} >>\nstream\n'.encode()+stream+b'\nendstream')
    data = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{number} 0 obj\n'.encode()+value+b'\nendobj\n')
    xref = len(data)
    data.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        data.extend(f'{offset:010} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode())
    return bytes(data)


VIEW = """()=>({view:currentView,project:activeProjectId,drawing:activeDrawingId,
  page:state.currentPage,record:selected,camera:SentlogContinuousCamera.isOpen(),
  checkpoint:!!sessionStorage.getItem('sentlogCameraReturnV1')})"""

PHOTOS = """async()=>{
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a')));
  const rows=saved.shapes.find(r=>r.id==='survey-a').photos;
  const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))]
    .map(x=>x.toString(16).padStart(2,'0')).join('');
  return Promise.all(rows.map(async photo=>({id:photo.id,original:await hash(await SentlogOriginalPhotos.getOriginal('memo-plan-a',photo.id)),
    shared:await hash(await getPhotoBlob(photo.id,'memo-plan-a'))})));
}"""


def ready(page):
    page.wait_for_function('window.sentlogAppReady&&window.SentlogCameraReturn&&window.SentlogContinuousCamera&&window.SentlogCollaborationPhotos', timeout=60000)
    page.evaluate('window.sentlogAppReady')
    return page.evaluate('window.SentlogCameraReturn.ready')


def reload_return(page, drawing='memo-plan-a', record='survey-a', number=1):
    page.reload(wait_until='domcontentloaded')
    result = ready(page)
    assert result.get('restored'), result
    view = page.evaluate(VIEW)
    assert view == dict(view='editor', project='memo-project', drawing=drawing, page=number,
                        record=record, camera=False, checkpoint=True), view
    expect(page.locator('#editorView')).to_be_visible()
    return view


def reopen(page, record='survey-a'):
    page.evaluate("""async record=>{await openDrawing('memo-project','memo-plan-a');selectShape(record);
      $('inspector').classList.add('open');await SentlogRecords.settled();}""", record)


def remember_without_photo(page):
    # A native input intent is prepared synchronously before its chooser opens.
    with page.expect_file_chooser() as chooser:
        page.locator('#photoAddBtn').click()
    assert page.evaluate(f"!!sessionStorage.getItem('{KEY}')")
    page.locator('#photoInput').dispatch_event('cancel')
    return chooser.value


def run(page, report):
    png = photo_png()
    page.evaluate(SETUP, base64.b64encode(png).decode())
    page.evaluate("""async()=>{
      for(const [key,file] of memoFixture.files)await SentlogRecords.writeFile(key,file);
      memoFixture.files.clear();
      state.shapes.push({id:'damage-a',page:1,kind:'rect',type:'腐食',x:200,y:200,w:100,h:60,
        typeNo:1,strokeWidth:1.2,member:'synthetic',memo:'existing damage',photos:[]});
      persist();await SentlogRecords.settled();
    }""")
    page.evaluate(CAMERA_MOCK, base64.b64encode(png).decode())
    page.evaluate('cameraMock.imageReady')
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_enabled()
    page.locator('#slCameraShutter').click()
    camera_count(page, 1)
    before = page.evaluate(PHOTOS)
    assert len(before) == 1 and before[0]['original'] == hashlib.sha256(png).hexdigest(), before
    # No explicit openDrawing/selectRecord is allowed between reload and proof.
    report['continuousReload'] = reload_return(page)
    assert page.evaluate(PHOTOS) == before
    report['nativePhotoBytesRetained'] = True

    # A peer update repaints the same selected record through real sync-view.
    result = page.evaluate("""async()=>{
      const project=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY)).projects.find(p=>p.id==='memo-project');
      const payload={project:structuredClone(project),drawings:project.drawings.map(meta=>({meta:structuredClone(meta),
        state:JSON.parse(SentlogRecords.getItem(drawingStorageKey(meta.id)))}))};
      const drawing=payload.drawings.find(d=>d.meta.id==='memo-plan-a');
      const index=drawing.state.shapes.findIndex(r=>r.id==='survey-b');
      drawing.state.shapes[index]=SentlogRecordCollaboration.setField(drawing.state.shapes[index],'member','peer field',
        {revisionId:'camera-return-peer',actor:{deviceId:'synthetic-peer',deviceName:'synthetic'},at:Date.now()});
      const result=await sentlogSyncView.commit({client_key:project.id},{payload},JSON.stringify(project));
      await SentlogRecords.settled();return result;
    }""")
    assert result.get('applied'), result
    assert page.evaluate(f"!!sessionStorage.getItem('{KEY}')"), 'Sync repaint removed camera return checkpoint'
    report['syncPreservedReturn'] = reload_return(page)
    assert page.evaluate(PHOTOS) == before

    # Native camera fallback must establish a checkpoint in the actual click.
    page.evaluate(CAMERA_MOCK, base64.b64encode(png).decode())
    page.evaluate('cameraMock.imageReady')
    open_camera(page)
    with page.expect_file_chooser() as chooser:
        page.locator('#slCameraNative').click()
    assert page.evaluate(f"!!sessionStorage.getItem('{KEY}')")
    chooser.value.set_files({'name': 'native-return.png', 'mimeType': 'image/png', 'buffer': png})
    page.wait_for_function("JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a'))).shapes.find(r=>r.id==='survey-a').photos.length===2")
    after_native = page.evaluate(PHOTOS)
    report['nativeReload'] = reload_return(page)
    assert page.evaluate(PHOTOS) == after_native

    # Intentional Back/selection changes must not resurrect the older record.
    page.locator('#navBackBtn').click()
    assert not page.evaluate(f"sessionStorage.getItem('{KEY}')")
    page.reload(wait_until='domcontentloaded');ready(page)
    assert page.evaluate('currentView') == 'projects'
    report['deliberateLeaveRespected'] = True
    reopen(page)
    remember_without_photo(page)
    page.evaluate("selectShape('survey-b')")
    assert not page.evaluate(f"sessionStorage.getItem('{KEY}')")
    page.reload(wait_until='domcontentloaded');ready(page)
    assert page.evaluate('currentView') == 'projects'

    # Both kinds of inspector selection use the actual application's adapters.
    reopen(page, 'damage-a')
    remember_without_photo(page)
    report['damageReload'] = reload_return(page, record='damage-a')

    # Real PDF rendering: recover page 2 even if the last durable view was 1.
    encoded_pdf = base64.b64encode(two_page_pdf()).decode()
    page.evaluate("""async encoded=>{
      const file=new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],'return.pdf',{type:'application/pdf'});
      const meta={id:'return-pdf',name:'return PDF',sourceType:'pdf',fileName:'return.pdf',pageCount:2};
      workspace.projects.find(p=>p.id==='memo-project').drawings.push(meta);saveWorkspace();
      const record={id:'pdf-record',page:2,kind:'field-record',recordKind:'field-record',recordType:'photo',
        type:'全景',point:{x:200,y:180},angle:0,typeNo:1,photos:[],memo:'page 2 record'};
      SentlogRecords.setItem(drawingStorageKey(meta.id),JSON.stringify({...freshDrawingState('synthetic'),
        sourceType:'pdf',fileName:'return.pdf',pageCount:2,currentPage:2,shapes:[record]}));
      await SentlogRecords.writeFile('background:'+meta.id,file);await SentlogRecords.settled();
      await openDrawing('memo-project',meta.id);selectShape(record.id);$('inspector').classList.add('open');
    }""", encoded_pdf)
    remember_without_photo(page)
    page.evaluate("""async()=>{
      const key=drawingStorageKey('return-pdf'),saved=JSON.parse(SentlogRecords.getItem(key));saved.currentPage=1;
      SentlogRecords.setItem(key,JSON.stringify(saved));await SentlogRecords.settled();
    }""")
    report['pdfReload'] = reload_return(page, drawing='return-pdf', record='pdf-record', number=2)

    # Missing/archived sources must not be reopened; existing photo bytes remain.
    page.evaluate("""()=>localStorage.setItem('sentlogArchiveControlV1:',JSON.stringify([
      {client_key:'memo-project',status:'archived',checking:false}]))""")
    page.reload(wait_until='domcontentloaded');ready(page)
    assert page.evaluate('currentView') == 'projects'
    assert not page.evaluate(f"sessionStorage.getItem('{KEY}')")
    assert page.evaluate(PHOTOS) == after_native
    report['archivedReturnRejected'] = True
    report['photos'] = after_native


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    built = args.built_root.resolve()
    report = dict(engine=args.engine, passed=False, scope='Synthetic records and camera; native IndexedDB, real PDF/sync/navigation/reload')
    started = time.monotonic()

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(built)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            engine = getattr(playwright, args.engine)
            launch = dict(headless=True)
            if args.engine == 'chromium' and not os.path.exists(engine.executable_path) and os.path.exists('/usr/bin/chromium'):
                launch.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            browser = engine.launch(**launch)
            context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True,
                                          has_touch=True, service_workers='block')

            def route(request):
                url = request.request.url
                if url.startswith((origin+'/', 'blob:', 'data:')):
                    request.continue_()
                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
                    asset = built/'sentlog/vendor'/('export-'+url.rsplit('/', 1)[-1])
                    request.fulfill(content_type='text/javascript', body=asset.read_bytes())
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            page.set_default_timeout(30000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(origin+'/sentlog/', wait_until='domcontentloaded');ready(page)
                run(page, report)
                assert not errors, errors
                report['passed'] = True
            except Exception as error:
                report.update(passed=False, error=str(error), pageErrors=errors)
                try:
                    report['lastView'] = page.evaluate(VIEW)
                    page.screenshot(path=f'/tmp/sentlog-camera-return-{args.engine}-failure.png')
                except Exception:
                    pass
                raise
            finally:
                browser.close()
    finally:
        server.shutdown()
        report['elapsedSeconds'] = round(time.monotonic()-started, 2)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS '+args.engine+': camera reload returns to original drawing/record; native photo bytes, sync, deliberate navigation, damage/PDF page and archive boundaries verified', flush=True)


if __name__ == '__main__':
    main()

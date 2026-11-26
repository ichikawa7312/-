"""One emergency-record download through the complete built application.

Native browser input, downloads and IndexedDB run in a new temporary profile
at 375 x 667 CSS pixels. Only synthetic records are used. A test-only put()
fault raises QuotaExceededError in a real transaction; this does not exhaust
a disk or test physical iOS hardware. Web Share is disabled in this isolated
profile to exercise the application's download fallback. All external network
traffic is blocked; PDF.js requests are fulfilled from the local build vendor.

Usage: python tests/record_rescue_ui.py --engine chromium --built-root .
       python tests/record_rescue_ui.py --engine webkit --built-root . --report /tmp/record-rescue-webkit.json
Missing Playwright/browser/OS dependencies are BLOCKED and return nonzero.
"""
import argparse
import base64
import functools
import hashlib
import json
import struct
import sys
import tempfile
import threading
import time
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'synthetic-rescue-target'
DRAWING = 'synthetic-rescue-drawing'
OTHER_PROJECT = 'synthetic-rescue-other'
OTHER_DRAWING = 'synthetic-rescue-other-drawing'
SAVED_MEMO = 'Synthetic memo already saved'
UNSAVED_MEMO = 'Synthetic newest unsaved memo 日本語🧪'

SEED = r"""async fixture=>{
  await sentlogAppReady;await SentlogRecords.settled();SentlogRecords.assertSafe();
  showProjects();
  const drawing={id:fixture.drawing,name:'Synthetic target drawing',sourceType:null,fileName:'',
    pageCount:1,createdAt:100,updatedAt:100,shapeCount:1,photoCount:1};
  const otherDrawing={...drawing,id:fixture.otherDrawing,name:'Synthetic other drawing',photoCount:0};
  const project={id:fixture.project,name:'Synthetic target saved name',drawings:[drawing],createdAt:100,updatedAt:100};
  const other={id:fixture.otherProject,name:'Synthetic other project',drawings:[otherDrawing],createdAt:100,updatedAt:100};
  const shape={id:'synthetic-record',kind:'rect',page:1,type:'腐食',typeNo:1,globalNo:1,
    x:10,y:20,w:30,h:40,memo:fixture.savedMemo,photos:[{id:'synthetic-photo',name:'Synthetic photo reference'}]};
  const state={...freshDrawingState(project.name),shapes:[shape],collabDeletedRecords:[]};
  const otherState={...freshDrawingState(other.name),shapes:[{...shape,id:'synthetic-other-record',
    memo:'Synthetic other project must stay excluded',photos:[]}],collabDeletedRecords:[]};
  // The target is deliberately second: the test must use the project picker.
  workspace={projects:[other,project]};
  SentlogRecords.batch([[WORKSPACE_KEY,JSON.stringify(workspace)],
    [drawingStorageKey(drawing.id),JSON.stringify(state)],
    [drawingStorageKey(otherDrawing.id),JSON.stringify(otherState)]]);
  await SentlogRecords.settled();
  await SentlogRecords.writeFile('background:'+drawing.id,
    new File(['Synthetic PDF file bytes kept only in IndexedDB'],'synthetic.pdf',{type:'application/pdf',lastModified:100}));
  await SentlogRecords.writeFile('photo:'+drawing.id+':synthetic-photo',
    new File([Uint8Array.from(atob(fixture.png),c=>c.charCodeAt(0))],'synthetic.png',{type:'image/png',lastModified:100}));
  await SentlogRecords.settled();SentlogRecords.assertSafe();renderProjects();
  window.__recordRescueUi={fixture,fired:0,restoreFault:null};
  return {projects:workspace.projects.length,drawingStates:2,files:2};
}"""

FAIL_SAVE = r"""async()=>{
  const test=window.__recordRescueUi,f=test.fixture,native=IDBObjectStore.prototype.put;
  const quota=new DOMException('Synthetic isolated record-save quota','QuotaExceededError');
  IDBObjectStore.prototype.put=function(value,key){
    if(this.transaction.db.name==='surveyFieldNoteDB'&&this.name==='files'&&
      key==='__sentlog_record__:'+drawingStorageKey(f.drawing)){test.fired++;throw quota;}
    return native.apply(this,arguments);
  };
  test.restoreFault=()=>{IDBObjectStore.prototype.put=native;};
  workspace=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY));
  const project=workspace.projects.find(p=>p.id===f.project);
  project.name='Synthetic target latest unsaved name';project.updatedAt=200;
  const state=JSON.parse(SentlogRecords.getItem(drawingStorageKey(f.drawing)));
  state.shapes[0].memo=f.unsavedMemo;
  state.shapes[0].photos.push({id:'synthetic-pending-photo',name:'Synthetic pending photo reference'});
  SentlogRecords.batch([[WORKSPACE_KEY,JSON.stringify(workspace)],
    [drawingStorageKey(f.drawing),JSON.stringify(state)]]);
  let caught=null;
  try{await SentlogRecords.settled();}catch(error){caught=error;}
  if(caught!==quota||test.fired!==1||!SentlogRecords.failed||!SentlogRecords.pending)
    throw Error('The isolated quota fault did not leave the expected unsaved state');
  renderProjects();
  return {project:JSON.parse(JSON.stringify(project)),state,errorName:caught.name,
    fired:test.fired,failed:SentlogRecords.failed,pending:SentlogRecords.pending};
}"""

NATIVE_PROOF = r"""async()=>{
  const db=await SentlogRecords.openFilesDatabase();let data;
  try{data=await new Promise((resolve,reject)=>{
    const names=['files','sentlog_delta_journal_v1','sentlog_delta_control_v1'];
    const tx=db.transaction(names,'readonly'),out={};
    for(const name of names){const rows=out[name]=[],q=tx.objectStore(name).openCursor();
      q.onsuccess=()=>{const cursor=q.result;if(cursor){rows.push([cursor.key,cursor.value]);cursor.continue();}};}
    tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error||Error('Synthetic read-only proof aborted'));
  });}finally{db.close();}
  for(const rows of Object.values(data))for(const row of rows){const value=row[1];
    if(value instanceof Blob){
      const bytes=await value.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
      row[1]={kind:value instanceof File?'File':'Blob',size:value.size,type:value.type,
        name:value.name||null,lastModified:value.lastModified??null,
        sha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
    }
  }
  return data;
}"""


def tiny_png():
    def chunk(kind, value):
        return (struct.pack('!I', len(value)) + kind + value +
                struct.pack('!I', zlib.crc32(kind + value) & 0xffffffff))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff')) + chunk(b'IEND', b''))


def evaluate(page, source, arg=None):
    return page.evaluate("""async ({source,arg})=>{
      let timer;
      try{return await Promise.race([eval('('+source+')')(arg),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Record rescue UI storage step timed out')),20000);
      })]);}finally{clearTimeout(timer);}
    }""", {'source': source, 'arg': arg})


def clickable_proof(locator):
    locator.scroll_into_view_if_needed()
    proof = locator.evaluate("""element=>{
      const rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
      const hit=document.elementFromPoint(x,y),warning=document.getElementById('sentlogStorageWarning');
      const wr=warning.getBoundingClientRect(),overlay=element.closest('.modal-backdrop');
      return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport:{width:innerWidth,height:innerHeight},
        centerVisible:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,
        receivesPointer:hit===element||element.contains(hit),
        centerOverWarning:x>=wr.left&&x<wr.right&&y>=wr.top&&y<wr.bottom,
        warningZ:Number(getComputedStyle(warning).zIndex),overlayZ:overlay?Number(getComputedStyle(overlay).zIndex):null};
    }""")
    assert proof['viewport']['width'] == 375, proof
    assert proof['rect']['width'] > 0 and proof['rect']['height'] > 0, proof
    assert proof['centerVisible'] and proof['receivesPointer'], proof
    return proof


def run(page, expect, report, report_path, download_directory):
    report['phase'] = 'seed native saved records and files'
    report['fixture'] = evaluate(page, SEED, {
        'project': PROJECT, 'drawing': DRAWING, 'otherProject': OTHER_PROJECT, 'otherDrawing': OTHER_DRAWING,
        'savedMemo': SAVED_MEMO, 'unsavedMemo': UNSAVED_MEMO, 'png': base64.b64encode(tiny_png()).decode('ascii')})
    expect(page.locator('#projectsView')).to_be_visible()
    native_before = evaluate(page, NATIVE_PROOF)
    target_key = '__sentlog_record__:surveyFieldNoteDrawingV1:' + DRAWING
    assert json.loads(dict(native_before['files'])[target_key])['shapes'][0]['memo'] == SAVED_MEMO

    report['phase'] = 'isolated quota fault and visible save warning'
    current = evaluate(page, FAIL_SAVE)
    assert evaluate(page, NATIVE_PROOF) == native_before, 'Failed save must roll back all three native stores'
    warning = page.locator('#sentlogStorageWarning')
    expect(warning).to_be_visible()
    # Expanded diagnostics deliberately make the fixed warning overlap the
    # selector's save button on this short screen, exercising its stacking order.
    warning.locator('summary').filter(has_text='保存エラーの詳細').tap()
    expect(warning.locator('.failure-details')).to_have_js_property('open', True)
    rescue = warning.get_by_role('button', name='記録だけを案件ごとに書き出す', exact=True)
    report['warningButton'] = clickable_proof(rescue)
    page.screenshot(path=str(report_path.with_suffix('.warning.png')))
    issues_before = page.evaluate('JSON.stringify(SentlogRecords.issues)')
    rescue.tap()

    report['phase'] = 'native project picker above the warning'
    picker = page.locator('.modal-backdrop.open').filter(
        has=page.get_by_role('heading', name='救出する案件を選択', exact=True))
    expect(picker).to_have_count(1)
    expect(picker).to_be_visible()
    select = picker.locator('select')
    expect(select).to_have_value(OTHER_PROJECT)
    select.select_option(PROJECT)
    expect(select).to_have_value(PROJECT)
    expect(picker).to_contain_text('PDF・写真画像そのものは含みません')
    save = picker.get_by_role('button', name='この案件だけ保存', exact=True)
    report['pickerButton'] = clickable_proof(save)
    assert report['pickerButton']['centerOverWarning'], 'The stacking-order scenario did not overlap the warning'
    assert report['pickerButton']['overlayZ'] > report['pickerButton']['warningZ'], report['pickerButton']
    page.screenshot(path=str(report_path.with_suffix('.picker.png')))
    with page.expect_download(timeout=20000) as event:
        save.tap()
    download = event.value
    assert download.failure() is None, 'The native browser download did not complete'
    downloaded = download_directory / 'synthetic-record-rescue.json'
    download.save_as(str(downloaded))
    payload = json.loads(downloaded.read_text(encoding='utf-8'))
    assert payload['format'] == 'sentlog-record-rescue' and payload['version'] == 1, payload
    assert payload['workspace']['projects'] == [current['project']], 'Rescue must contain the latest selected project only'
    assert payload['drawingStates'] == {DRAWING: current['state']}, 'Latest unsaved drawing data was not preserved exactly'
    assert payload['drawingStates'][DRAWING]['shapes'][0]['memo'] == UNSAVED_MEMO
    assert payload['recovery'] == {'source': 'current-memory', 'pendingOrFailedStorage': True,
                                   'includesFileData': False, 'missingDrawingStateCount': 0}
    assert 'files' not in payload and 'originalPhotos' not in payload, 'Record rescue must not contain file bodies'
    assert OTHER_PROJECT not in json.dumps(payload) and OTHER_DRAWING not in json.dumps(payload)
    assert 'Synthetic PDF file bytes' not in json.dumps(payload)
    assert base64.b64encode(tiny_png()).decode('ascii') not in json.dumps(payload)
    expect(picker).to_have_count(0)
    expect(warning).to_be_visible()
    assert page.evaluate('SentlogRecords.failed && SentlogRecords.pending') is True
    assert page.evaluate('JSON.stringify(SentlogRecords.issues)') == issues_before, 'Rescue must not clear the save error'
    assert page.evaluate('__recordRescueUi.fired') == 1, 'Rescue must not retry the failing writer'
    assert evaluate(page, NATIVE_PROOF) == native_before, 'Rescue changed durable records, files, journal or control data'
    assert page.evaluate("JSON.parse(SentlogRecords.getItem(drawingStorageKey(__recordRescueUi.fixture.drawing))).shapes[0].memo") == UNSAVED_MEMO
    report.update(phase='complete', download={
        'suggestedFilename': download.suggested_filename, 'bytes': downloaded.stat().st_size,
        'sha256': hashlib.sha256(downloaded.read_bytes()).hexdigest(), 'projects': 1, 'drawingStates': 1,
        'photoReferences': len(payload['drawingStates'][DRAWING]['shapes'][0]['photos']), 'includesFileData': False},
        newestMemoExported=True, otherProjectExcluded=True, failedWarningRetained=True,
        allThreeNativeStoresUnchanged=True, nativeFilesPreserved=2, faultCalls=1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    built = args.built_root.resolve()
    report_path = (args.report or Path(tempfile.gettempdir()) / f'sentlog-record-rescue-{args.engine}.json').resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {'engine': args.engine, 'status': 'running', 'phase': 'setup', 'viewport': {'width': 375, 'height': 667},
              'scope': 'Synthetic loopback application; new persistent browser profile; native IndexedDB, input and download.',
              'faultModel': 'Test-only QuotaExceededError at one native put() call; not physical disk exhaustion.',
              'shareScope': 'Web Share disabled only in this test profile to use the real download fallback.',
              'externalRequestsBlocked': 0, 'localVendorResponses': 0}
    started = time.monotonic()
    server = context = page = None
    errors, dialogs = [], []
    try:
        try:
            from playwright.sync_api import expect, sync_playwright
        except ImportError as error:
            report['status'] = 'blocked'
            raise RuntimeError('Playwright Python package is unavailable') from error
        if 'sentlog-storage-recovery-v204' not in (built / 'sentlog/index.html').read_text(encoding='utf-8'):
            raise RuntimeError('--built-root must point to the assembled storage-recovery application')

        class Handler(SimpleHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def end_headers(self):
                self.send_header('Cache-Control', 'no-store')
                # HTTP routing below blocks external resources; connect-src
                # also prevents external WebSocket/EventSource connections.
                self.send_header('Content-Security-Policy', "connect-src 'self' blob: data:")
                super().end_headers()

        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(built)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f'http://127.0.0.1:{server.server_port}'
        with tempfile.TemporaryDirectory(prefix='sentlog-record-rescue-ui-') as temporary, sync_playwright() as playwright:
            try:
                context = getattr(playwright, args.engine).launch_persistent_context(
                    str(Path(temporary) / 'profile'), headless=True, viewport=report['viewport'],
                    has_touch=True, is_mobile=True, device_scale_factor=2, accept_downloads=True,
                    service_workers='block', timezone_id='UTC')
            except Exception:
                report['status'] = 'blocked'
                raise

            def route(request):
                url = request.request.url
                if url.startswith((origin + '/', 'blob:', 'data:')):
                    request.continue_()
                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    name = 'export-pdf.worker.min.js' if 'worker' in url else 'export-pdf.min.js'
                    report['localVendorResponses'] += 1
                    request.fulfill(content_type='text/javascript', body=(built / 'sentlog/vendor' / name).read_bytes())
                else:
                    report['externalRequestsBlocked'] += 1
                    request.abort()

            context.route('**/*', route)
            context.add_init_script("Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});")
            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(15000)
            page.on('pageerror', lambda error: errors.append(str(error)))

            def dialog_opened(dialog):
                dialogs.append({'type': dialog.type, 'message': dialog.message})
                if dialog.type == 'alert':
                    dialog.accept()
                else:
                    dialog.dismiss()

            page.on('dialog', dialog_opened)
            try:
                report['phase'] = 'assembled application ready'
                page.goto(origin + '/sentlog/', wait_until='domcontentloaded', timeout=60000)
                page.wait_for_function("window.sentlogAppReady && window.SentlogRecords?.ready && "
                    "typeof window.SentlogRecordRescue?.chooseProject==='function' && "
                    "document.querySelector('#sentlogStorageWarning .record-rescue')", timeout=60000)
                evaluate(page, 'async()=>{await sentlogAppReady;await SentlogRecords.settled();}')
                report['build'] = page.evaluate('window.SENTLOG_BUILD')
                run(page, expect, report, report_path, Path(temporary))
                assert not errors, errors
                assert len(dialogs) == 1 and dialogs[0]['type'] == 'alert', dialogs
                assert '端末内への保存完了は確認できていません' in dialogs[0]['message'], dialogs
                assert 'PDF・写真画像そのものは含みません' in dialogs[0]['message'], dialogs
                report['status'] = 'passed'
            except Exception:
                if page and not page.is_closed():
                    try:
                        page.screenshot(path=str(report_path.with_suffix('.failure.png')))
                        report['failureState'] = page.evaluate("""()=>({
                          ready:!!window.SentlogRecords?.ready,failed:window.SentlogRecords?.failed,
                          pending:window.SentlogRecords?.pending,issues:window.SentlogRecords?.issues,
                          faultCalls:window.__recordRescueUi?.fired,
                          warningVisible:document.getElementById('sentlogStorageWarning')?.hidden===false,
                          view:typeof currentView==='undefined'?null:currentView})""")
                    except Exception as inspection_error:
                        report['inspectionError'] = str(inspection_error)
                raise
            finally:
                active_failure = sys.exc_info()[0] is not None
                try:
                    if page and not page.is_closed():
                        page.evaluate('window.__recordRescueUi?.restoreFault?.()')
                except Exception as cleanup_error:
                    # The temporary browser is closed below regardless. Keep
                    # the actual test failure when its page is already gone.
                    report['faultCleanupError'] = str(cleanup_error)
                finally:
                    try:
                        context.close()
                    except Exception as cleanup_error:
                        report['contextCleanupError'] = str(cleanup_error)
                        if not active_failure:
                            raise
                    finally:
                        context = None
    except Exception as error:
        if report['status'] != 'blocked':
            report['status'] = 'failed'
        report['error'] = str(error)
    finally:
        if server:
            server.shutdown()
            server.server_close()
        report.update(elapsedSeconds=round(time.monotonic() - started, 2), browserErrors=errors, dialogs=dialogs)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    if report['status'] == 'passed':
        print('PASS ' + args.engine + ': native record rescue download at 375px; latest unsaved memo, '
              'selected project only, picker above warning, failed state and durable bytes preserved', flush=True)
        return 0
    print(report['status'].upper() + ' ' + args.engine + ': ' + report.get('error', 'record rescue UI test failed'), file=sys.stderr, flush=True)
    return 2 if report['status'] == 'blocked' else 1


if __name__ == '__main__':
    raise SystemExit(main())

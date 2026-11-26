"""Individual sync UI with real workers, native IndexedDB and PostgreSQL RPCs.

All data is synthetic. Existing application fixtures provide Auth, transport and
Realtime only. A read-only module getter observes worker/request state; production
functions, promises, save transactions and the 30-second UI deadline stay intact.
"""
import argparse
import base64
import copy
import functools
import hashlib
import json
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright
import delta_drawing_review_app as review

ROOT = Path(__file__).resolve().parents[1]
LOCAL, DRAWING = review.LOCAL, review.DRAWING
PHOTO_KEY = 'photo:' + DRAWING + ':synthetic-photo-1'

# WeakMap IDs are diagnostic identities only. Reading them never changes a
# production request, its promise, worker scheduling or durable application data.
READ_STATE = r"""
const individualSyncDiagnosticIds=new WeakMap();let individualSyncDiagnosticNext=0;
window.__individualSyncRead=()=>({
  at:Date.now(),busy:projectSyncControlBusy,importing:!!window.sentlogImporting,
  syncing,mergeBusy,online:navigator.onLine,hidden:document.hidden,
  metadata:{running:collaborationMetadataWorker.running,pending:collaborationMetadataWorker.pending},
  files:{running:collaborationFileWorker.running,pending:collaborationFileWorker.pending},
  fileFailures:[...collaborationFileFailures].map(([id,value])=>({id,code:value.code,message:value.message})),
  requests:[...projectSyncRequests].map(([key,promise])=>{
    if(!individualSyncDiagnosticIds.has(promise))individualSyncDiagnosticIds.set(promise,++individualSyncDiagnosticNext);
    return {key:JSON.parse(key),id:individualSyncDiagnosticIds.get(promise)};
  }),
  selected:document.getElementById('sentlogSyncProjectSelect')?.value,
  selectDisabled:document.getElementById('sentlogSyncProjectSelect')?.disabled,
  button:document.getElementById('sentlogSyncProjectNow')?.textContent,
  message:document.getElementById('sentlogCloudMsg')?.textContent,
  notice:document.getElementById('sentlogDrawingRecoveryNotice')?.textContent,
  records:{pending:SentlogRecords.pending,failed:SentlogRecords.failed,
    writer:SentlogRecords.writerState('photo:edit-plan:synthetic-photo-1')},
  binding:SentlogRecords.deltaJournal.bindingStateFor('edit-project')
});
"""

OBSERVE_BUTTON = r"""()=>{
  const button=document.getElementById('sentlogSyncProjectNow'),native=button.onclick,events=[];
  if(typeof native!=='function')throw Error('The actual individual sync button has no handler');
  window.__individualSyncEvents=events;let count=0;
  button.onclick=function(...args){
    const id=++count;events.push({id,event:'start',state:__individualSyncRead()});
    let result;try{result=native.apply(this,args);}catch(error){events.push({id,event:'error',message:String(error)});throw error;}
    if(!result?.then)throw Error('The actual individual sync handler did not return its promise');
    result.then(()=>events.push({id,event:'done',state:__individualSyncRead()}),
      error=>events.push({id,event:'error',message:String(error),code:error?.code}));
    return result;
  };
}"""

BLOCK_NATIVE_SAVE = r"""async ({key,base64})=>{
  const db=await SentlogRecords.openFilesDatabase();
  const tx=db.transaction(['files','sentlog_delta_journal_v1','sentlog_delta_control_v1'],'readwrite');
  let keep=true;const state={released:false,saved:false,release(){keep=false;state.released=true;}};
  window.__individualNativeSave=state;
  function pump(){const request=tx.objectStore('files').get('__sentlog_records_meta_v130__');
    request.onsuccess=()=>{if(keep)pump();};}pump();
  tx.oncomplete=()=>{db.close();state.complete=true;};
  tx.onabort=()=>{db.close();state.aborted=true;};
  const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
  const pending=SentlogRecords.writeFile(key,new Blob([bytes],{type:'image/png'}));
  pending.then(()=>{state.saved=true;},error=>{state.error=String(error);});
}"""


class Cloud(review.Cloud):
    def __init__(self, *args):
        super().__init__(*args)
        self.hold_path, self.held = None, []
        self.pdf_ack_proofs = []

    def route(self, route, device):
        path = urlparse(route.request.url).path
        if path.endswith('/rpc/sentlog_ack_pdf'):
            phase = route.request.frame.evaluate("SentlogRecords.deltaJournal.bindingStateFor('edit-project')?.phase")
            files = route.request.frame.evaluate(review.app.READ_NATIVE_FILES, [review.KEY])
            self.pdf_ack_proofs.append(dict(phase=phase, files=files))
        if self.hold_path and path == self.hold_path:
            self.hold_path = None
            self.held.append((route, device))
            return
        return super().route(route, device)

    def release(self):
        held, self.held = self.held, []
        for route, device in held:
            # Process the original request through the real PostgreSQL fixture.
            super().route(route, device)


def synthetic_pack():
    pack = review.app.base.payload(LOCAL, DRAWING)
    pack['project']['name'] = '合成個別同期検証'
    drawing = pack['drawings'][0]
    template = drawing['state']['shapes'][0]
    photo = {**template['photos'][0], 'sha256': hashlib.sha256(review.app.base.photo_png()).hexdigest()}
    shapes, number = [], 0
    for index, count in enumerate([14, 14, 14, 14, 13]):
        shape = copy.deepcopy(template)
        shape.update(id=f'synthetic-record-{index+1}', memo=f'合成記録{index+1}',
                     recordNo=index+1, typeNo=index+1, globalNo=index+1, autoLabel=f'調査-{index+1}')
        shape['photos'] = []
        for _ in range(count):
            number += 1
            shape['photos'].append({**photo, 'id': f'synthetic-photo-{number}', 'name': f'synthetic-{number}.png'})
        shapes.append(shape)
    drawing['state'].update(shapes=shapes, nextGlobalNo=6)
    for descriptor in (pack['project']['drawings'][0], drawing['meta'], drawing['state']):
        descriptor.update(sourceType='pdf', fileName='synthetic-review.pdf', pageCount=1)
    for descriptor in (pack['project']['drawings'][0], drawing['meta']):
        descriptor.update(shapeCount=5, photoCount=69)
    return pack


def setup(page, cloud):
    result = page.evaluate(review.SETUP, dict(pack=synthetic_pack(), scope=review.SCOPE))
    asset = review.seed_server(cloud, result['pack'], review.one_page_pdf())
    cutoff = page.evaluate(review.CUTOFF, dict(scope=review.SCOPE, localProjectId=LOCAL))
    assert cutoff['serverRevision'] == 1 and not cutoff['files'], cutoff
    page.reload(wait_until='domcontentloaded')
    page.wait_for_function('window.sentlogDrawingRecoveryReview&&window.__individualSyncRead', timeout=45000)
    page.evaluate('async()=>await sentlogAppReady')
    page.locator('#sentlogCloudStatus').click()
    page.locator('#sentlogSyncProjectSelect').select_option(LOCAL)
    page.evaluate(OBSERVE_BUTTON)
    return result['pack'], asset, cutoff


def state(page):
    return page.evaluate('__individualSyncRead()')


def click_individual(page):
    page.locator('#sentlogSyncProjectNow').click()
    event = page.evaluate("__individualSyncEvents.filter(event=>event.event==='start').at(-1)")
    assert event['state']['selected'] == LOCAL, event
    return event


def button_finished(page, event):
    return page.evaluate("id=>__individualSyncEvents.some(event=>event.id===id&&event.event==='done')", event['id'])


def assert_references(page, pack):
    actual = page.evaluate("JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:edit-plan')).shapes")
    expected = pack['drawings'][0]['state']['shapes']
    assert len(actual) == len(expected) == 5, actual
    assert [(record['id'], record['memo'], record['photos']) for record in actual] == [
        (record['id'], record['memo'], record['photos']) for record in expected]
    assert sum(len(record['photos']) for record in actual) == 69


def concurrency(page, cloud):
    pack, asset, cutoff = setup(page, cloud)
    cloud.hold_path = '/rest/v1/rpc/sentlog_delta_inspect_v1'
    page.evaluate("()=>{sentlogImporting=false;window.dispatchEvent(new Event('online'));}")
    review.app.wait(cloud, page, lambda: bool(cloud.held), 'Automatic sync did not reach the real inspect RPC')
    first = click_individual(page)
    assert first['state']['metadata']['running'] and first['state']['files']['running'], first
    cloud.release()
    review.app.wait(cloud, page, lambda: button_finished(page, first), 'Individual sync did not return during drawing review')
    notice = page.locator('#sentlogDrawingRecoveryNotice')
    notice.get_by_role('button', name='図面を確認して復旧').wait_for(timeout=10000)
    assert not state(page)['busy'] and not state(page)['requests'], state(page)
    assert page.evaluate(review.CUTOFF, dict(scope=review.SCOPE, localProjectId=LOCAL)) == cutoff
    assert_references(page, pack)
    assert not cloud.pdf_ack_requests, 'The receiver ACKed the PDF before explicit adoption'
    print('PASS individual button joins active automatic workers and returns with the PDF review panel', flush=True)

    notice.get_by_role('button', name='図面を確認して復旧').click()
    checked = page.locator('#sentlogDrawingRecoveryChecked')
    checked.wait_for(timeout=45000)
    page.wait_for_function("()=>document.querySelector('#sentlogDrawingRecoveryDialog canvas')?.width>100", timeout=45000)
    checked.check()
    cloud.hold_path = '/rest/v1/rpc/sentlog_delta_read_baseline_page_v1'
    page.locator('#sentlogDrawingRecoveryConfirm').click()
    page.locator('#sentlogDrawingRecoveryDialog').wait_for(state='hidden', timeout=45000)
    review.app.wait(cloud, page, lambda: bool(cloud.held), 'Adoption did not resume the actual baseline installer')
    resumed = state(page)
    assert resumed['binding']['phase'] == 'staging' and len(resumed['requests']) == 1, resumed
    assert not cloud.pdf_ack_requests, 'The receiver ACKed the PDF while protected migration was still staging'
    second = click_individual(page)
    assert second['state']['metadata']['running'] and second['state']['files']['running'], second
    assert state(page)['requests'] == resumed['requests'], 'Adoption and individual sync did not share the same task'
    cloud.release()
    review.app.wait(cloud, page, lambda: button_finished(page, second), 'Individual sync did not return after adoption', 60)
    current = state(page)
    assert not current['busy'] and not current['requests'] and current['binding']['phase'] == 'active', current
    assert any(failure['id'] == LOCAL and failure['code'] == 'DELTA_PHOTOS_PENDING'
               and '69' in failure['message'] for failure in current['fileFailures']), current
    files = page.evaluate(review.app.READ_NATIVE_FILES, [review.KEY, PHOTO_KEY])
    assert files[0]['sha256'] == asset['sha256'] and files[0]['size'] == asset['byte_size'], files
    assert files[1].get('missing'), files
    assert_references(page, pack)
    adopted = page.evaluate(review.CUTOFF, dict(scope=review.SCOPE, localProjectId=LOCAL))
    assert adopted['rawEntries'] == cutoff['rawEntries'] and adopted['serverRevision'] == 1, adopted
    # After activation the normal receiver may ACK the adopted bytes. Require
    # its real native copy and active binding; never depend on timer ordering.
    for proof in cloud.pdf_ack_proofs:
        assert proof['phase'] == 'active' and proof['files'][0].get('sha256') == asset['sha256'] \
            and proof['files'][0].get('size') == asset['byte_size'], proof
    assert not [request for request in cloud.photo_requests if request['path'].endswith('/rpc/sentlog_ack_photo')]
    print('PASS PDF adoption and individual button share one task, activate the binding, and retain all 69 pending photo references', flush=True)


def save_wait(page, cloud):
    pack, _, cutoff = setup(page, cloud)
    data = review.app.base.photo_png()
    page.evaluate(BLOCK_NATIVE_SAVE, dict(key=PHOTO_KEY, base64=base64.b64encode(data).decode()))
    assert state(page)['records']['pending']
    page.evaluate("()=>{sentlogImporting=false;window.dispatchEvent(new Event('online'));}")
    page.wait_for_function('__individualSyncRead().files.running', timeout=10000)
    started = time.monotonic()
    first = click_individual(page)
    waiting = state(page)
    assert waiting['busy'] and waiting['records']['pending'] and len(waiting['requests']) == 1, waiting
    # Exercise the production 30-second limit once; do not shorten its source
    # constant or replace the pending native save with a synthetic promise.
    review.app.wait(cloud, page, lambda: button_finished(page, first), 'The UI did not release its native-save wait within 40 seconds', 40)
    elapsed = time.monotonic() - started
    observed = state(page)
    assert elapsed >= 25, ('The UI returned before its real observation deadline', elapsed, observed)
    assert not observed['busy'] and not observed['selectDisabled'], observed
    assert observed['records']['pending'] and observed['files']['running'], observed
    assert observed['requests'] == waiting['requests'], 'The UI deadline cancelled or replaced the underlying sync'
    assert '確認に時間がかかっています' in observed['message'] and '同期完了はまだ確認できていません' in observed['message'], observed
    progress = page.locator('[data-sync-work-kind="metadata"]')
    assert progress.is_visible() and '端末への保存が終わるのを待っています' in progress.inner_text(), progress.inner_text()
    assert '秒経過' in progress.inner_text(), progress.inner_text()
    files_progress = page.locator('[data-sync-work-kind="files"]')
    assert files_progress.is_visible() and '記録の確認が終わるのを待っています' in files_progress.inner_text(), files_progress.inner_text()
    assert '秒経過' in files_progress.inner_text(), files_progress.inner_text()
    cloud.output_dir.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(cloud.output_dir / f'native-save-deadline-{cloud.engine}.png'), full_page=True)
    assert not page.evaluate('__individualNativeSave.saved')
    second = click_individual(page)
    assert state(page)['requests'] == waiting['requests'], 'Retry started another task while the first save was pending'
    page.evaluate('__individualNativeSave.release()')
    review.app.wait(cloud, page, lambda: button_finished(page, second), 'Released native save did not complete the original sync', 45)
    review.app.wait(cloud, page, lambda: page.evaluate('__individualNativeSave.saved'), 'The original native write was lost')
    current = state(page)
    assert not current['busy'] and not current['requests'] and not current['records']['pending'], current
    assert not current['message'], current
    files = page.evaluate(review.app.READ_NATIVE_FILES, [PHOTO_KEY])
    assert files[0]['sha256'] == hashlib.sha256(data).hexdigest() and files[0]['size'] == len(data), files
    assert_references(page, pack)
    after = page.evaluate(review.CUTOFF, dict(scope=review.SCOPE, localProjectId=LOCAL))
    assert after['rawEntries'] == cutoff['rawEntries'] and after['serverRevision'] == 1, after
    assert not cloud.pdf_ack_requests
    assert not [request for request in cloud.photo_requests if request['path'].endswith('/rpc/sentlog_ack_photo')]
    print(f'PASS real UI deadline after {elapsed:.2f}s releases controls; retry shares the task and native save commits identical bytes after release', flush=True)


def run_case(engine, cloud, name, test, output):
    with tempfile.TemporaryDirectory(prefix='individual-sync-app-') as profile:
        context, page, errors = review.app.make_page(engine, profile, cloud, review.DEVICE)
        try:
            test(page, cloud)
            review.app.assert_native_writes(page)
            assert not errors and not cloud.unexpected and not cloud.sql_errors, (errors, cloud.unexpected, cloud.sql_errors)
        except Exception:
            output.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(output / f'{name}-{cloud.engine}.png'), full_page=True)
            diagnostics = dict(state=state(page), events=page.evaluate('window.__individualSyncEvents'), errors=errors,
                unexpected=cloud.unexpected, sql_errors=cloud.sql_errors[-8:], requests=cloud.requests[-30:],
                pdf_ack_proofs=cloud.pdf_ack_proofs,
                runtime=page.evaluate('window.__deltaPhotoDiagnostics?.events.slice(-30)'))
            (output / f'{name}-{cloud.engine}.json').write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2, default=str))
            print(json.dumps(diagnostics, ensure_ascii=False, default=str), flush=True)
            raise
        finally:
            page.evaluate('window.__individualNativeSave?.release()')
            cloud.release()
            context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--executable-path', type=Path)
    parser.add_argument('--output-dir', type=Path, default=Path(tempfile.gettempdir()) / 'sentlog-individual-sync-app')
    args = parser.parse_args()
    root = args.built_root.resolve()
    source = (root / 'sentlog/cloud-sync.js').read_text()
    assert 'const PROJECT_SYNC_UI_WAIT_MS=30000;' in source and 'requestProjectSync(entry.localProjectId)' in source, 'Build the individual sync update first'
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            for name, test in [('concurrency', concurrency), ('native-save-wait', save_wait)]:
                backend = review.app.Backend(ROOT)
                cloud = Cloud(f'http://127.0.0.1:{server.server_port}', root, args.engine, backend)
                cloud.output_dir = args.output_dir
                cloud.executable_path = str(args.executable_path.resolve()) if args.executable_path else None
                cloud.webkit_sources['/sentlog/cloud-sync.js'] = source + READ_STATE
                try:
                    run_case(getattr(playwright, args.engine), cloud, name, test, args.output_dir)
                finally:
                    backend.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()

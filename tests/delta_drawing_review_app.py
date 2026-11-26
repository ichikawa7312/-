"""Built recovery UI, real PDF.js, native IndexedDB and PostgreSQL RPCs.

Only authentication, remote byte transport and Realtime delivery are fixtures.
The production HTML/controller/recovery/journal/installer are served unchanged.
All identities, notes, PDF bytes and photo references are synthetic.
"""
import argparse
import functools
import hashlib
import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright
import delta_app_ui as app

ROOT = Path(__file__).resolve().parents[1]
OWNER, PID, DEVICE, PEER = app.OWNER, app.PID, app.B, app.A
LOCAL, DRAWING = app.base.PROJECT, app.base.DRAWING
SCOPE = dict(ownerId=OWNER, projectId=PID, deviceId=DEVICE)
KEY = 'background:' + DRAWING
PHOTO_KEY = 'photo:' + DRAWING + ':retained-photo'


def one_page_pdf():
    stream = b'BT /F1 18 Tf 36 750 Td (SYNTHETIC REVIEW DRAWING) Tj ET\n'
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    result, offsets = b'%PDF-1.4\n', []
    for number, value in enumerate(objects, 1):
        offsets.append(len(result))
        result += str(number).encode() + b' 0 obj\n' + value + b'\nendobj\n'
    xref = len(result)
    result += b'xref\n0 6\n0000000000 65535 f \n'
    result += b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets)
    return result + b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n'


class Cloud(app.Cloud):
    def __init__(self, origin, root, engine, backend):
        super().__init__(origin, root, engine, backend)
        # Reuse the exact PDF.js distribution already included in the build.
        # No runtime function or native IDB operation is replaced.
        self.pdf = {
            'pdf.min.js': (root / 'sentlog/vendor/export-pdf.min.js').read_bytes(),
            'pdf.worker.min.js': (root / 'sentlog/vendor/export-pdf.worker.min.js').read_bytes(),
        }
        self.pdf_requests = []

    def route(self, route, device):
        url = urlparse(route.request.url)
        if route.request.url.startswith(self.origin + '/sentlog/vendor/export-pdf'):
            name = url.path.rsplit('/', 1)[-1].removeprefix('export-')
            if name in self.pdf:
                self.pdf_requests.append(name)
        if url.netloc == 'cdnjs.cloudflare.com' and '/pdf.js/3.11.174/' in url.path:
            name = url.path.rsplit('/', 1)[-1]
            assert name in self.pdf, name
            self.pdf_requests.append(name)
            route.fulfill(content_type='text/javascript', body=self.pdf[name],
                          headers={'Access-Control-Allow-Origin': '*'})
            return
        return super().route(route, device)


SETUP = r"""async ({pack,scope})=>{
  await sentlogAppReady;
  pack.project.collaborationVersion=1;
  for(const drawing of pack.drawings)drawing.state.shapes=drawing.state.shapes.map(SentlogRecordCollaboration.upgrade);
  workspace={projects:[structuredClone(pack.project)]};
  SentlogRecords.batch([[WORKSPACE_KEY,JSON.stringify(workspace)],
    ...pack.drawings.map(d=>[drawingStorageKey(d.meta.id),JSON.stringify(d.state)])]);
  await SentlogRecords.settled();showProjects();
  const cutoff=await SentlogRecords.deltaJournal.begin({scope,localProjectId:pack.project.id,
    serverRevision:1,actor:{deviceId:scope.deviceId,deviceName:'Synthetic PC'}});
  return {pack,cutoff:{bindingId:cutoff.bindingId,serverRevision:cutoff.serverRevision,rawEntries:cutoff.rawEntries}};
}"""

DURABLE = r"""async()=>{
  await SentlogRecords.settled();
  const db=await SentlogRecords.openFilesDatabase();
  let rows;
  try{rows=await new Promise((resolve,reject)=>{
    const stores=['files','sentlog_delta_journal_v1','sentlog_delta_control_v1'];
    const tx=db.transaction(stores,'readonly'),out={};
    for(const name of stores){const store=tx.objectStore(name),keys=store.getAllKeys(),values=store.getAll();
      values.onsuccess=()=>{out[name]=values.result.map((value,index)=>[keys.result[index],value]);};}
    tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  async function encode(value){
    if(value instanceof Blob)return {blob:true,size:value.size,type:value.type,
      sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await value.arrayBuffer()))]
        .map(x=>x.toString(16).padStart(2,'0')).join('')};
    if(Array.isArray(value))return Promise.all(value.map(encode));
    if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([k,v])=>[k,await encode(v)])));
    return value;
  }
  return encode(rows);
}"""

CUTOFF = r"""async ({scope,localProjectId})=>{
  const cutoff=await SentlogRecords.deltaJournal.readCutoff({scope,localProjectId});
  return {rawEntries:cutoff.rawEntries,serverRevision:cutoff.serverRevision,
    files:cutoff.files.map(file=>({key:file.key,recovery:file.recovery,
      size:file.blob instanceof Blob?file.blob.size:null}))};
}"""


def seed_server(cloud, pack, pdf):
    sha = hashlib.sha256(pdf).hexdigest()
    asset_id = '88888888-8888-4888-8888-888888888888'
    path = f'{OWNER}/{PID}/drawings/synthetic-review.pdf'
    asset = dict(id=asset_id, owner_id=OWNER, project_id=PID,
                 client_key='drawing:' + DRAWING, kind='drawing',
                 file_name='synthetic-review.pdf', mime_type='application/pdf',
                 byte_size=len(pdf), sha256=sha, storage_path=path, status='pc_verified',
                 source_device_id=PEER,
                 metadata=dict(local_project_key=LOCAL, drawing_id=DRAWING, source_type='pdf'))
    cloud.assets[asset_id], cloud.blobs[path] = asset, pdf
    # The protected local cutoff remains revision 1. Importing and activating a
    # revision-7 server baseline through the real SQL produces current revision 8.
    cloud.backend.admin(op='seed', ownerId=OWNER,
                        devices=[dict(id=PEER, name='Synthetic iPad'), dict(id=DEVICE, name='Synthetic PC')],
                        projects=[dict(id=PID, client_key=LOCAL, payload=pack, revision=7)],
                        assets=[asset], rollout=True)
    def rpc(name, **body):
        return cloud.backend.admin(op='request', ownerId=OWNER, deviceId=PEER, method='POST',
                                   path='/rest/v1/rpc/' + name,
                                   body=dict(p_project_id=PID, p_device_id=PEER, **body))
    baseline = rpc('sentlog_delta_prepare_baseline_v1', p_expected_revision=7)
    rpc('sentlog_delta_import_baseline_batch_v1', p_baseline_id=baseline['baselineId'], p_limit=100)
    rpc('sentlog_delta_activate_baseline_v1', p_baseline_id=baseline['baselineId'],
        p_proof=dict(writerVersion=2, migrationId='synthetic-prior-device',
                     sourceFingerprint='1' * 64, planSha256='2' * 64))
    current = cloud.backend.admin(op='state', ownerId=OWNER, projectId=PID)
    assert current['snapshots'][0]['revision'] == 8, current['snapshots'][0]['revision']
    return asset


def run(engine, cloud):
    with tempfile.TemporaryDirectory(prefix='delta-drawing-review-app-') as profile:
        context, page, errors = app.make_page(engine, profile, cloud, DEVICE)
        try:
            pack = app.base.payload(LOCAL, DRAWING)
            pack['project']['name'] = '合成PDF復旧検証'
            drawing = pack['drawings'][0]
            drawing['state']['shapes'] = drawing['state']['shapes'][:1]
            photo = drawing['state']['shapes'][0]['photos'][0]
            photo['sha256'] = hashlib.sha256(app.base.photo_png()).hexdigest()
            for meta in (pack['project']['drawings'][0], drawing['meta'], drawing['state']):
                meta.update(sourceType='pdf', fileName='synthetic-review.pdf', pageCount=1)
            for meta in (pack['project']['drawings'][0], drawing['meta']):
                meta.update(shapeCount=1, photoCount=1)
            setup = page.evaluate(SETUP, dict(pack=pack, scope=SCOPE))
            asset = seed_server(cloud, setup['pack'], one_page_pdf())
            before_cutoff = page.evaluate(CUTOFF, dict(scope=SCOPE, localProjectId=LOCAL))
            assert before_cutoff['serverRevision'] == 1 and not before_cutoff['files'], before_cutoff
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function('window.sentlogDeltaRuntime&&window.sentlogDrawingRecoveryReview', timeout=45000)
            page.evaluate('async()=>await sentlogAppReady')
            assert page.evaluate("SentlogRecords.deltaJournal.bindingStateFor('edit-project').phase") == 'staging'
            assert page.evaluate(CUTOFF, dict(scope=SCOPE, localProjectId=LOCAL)) == before_cutoff
            assert page.evaluate('pdfjsLib.version') == '3.11.174'
            page.locator('#sentlogCloudStatus').click()
            page.evaluate('sentlogImporting=false')
            page.locator('#sentlogCloudSyncNow').click()
            notice = page.locator('#sentlogDrawingRecoveryNotice')
            notice.locator('button').wait_for(state='attached', timeout=45000)
            # The existing Sync Now action closes its modal while it runs.
            page.locator('#sentlogCloudStatus').click()
            notice.get_by_role('button', name='図面を確認して復旧').wait_for(timeout=10000)
            assert '合成PDF復旧検証' in notice.inner_text()
            assert not [r for r in cloud.photo_requests if '/storage/' in r['path']], cloud.photo_requests
            before = page.evaluate(DURABLE)
            print('PASS actual sync UI identifies the old-cutoff/new-snapshot PDF without downloading or changing native files', flush=True)

            def preview():
                notice.get_by_role('button', name='図面を確認して復旧').click()
                checked = page.locator('#sentlogDrawingRecoveryChecked')
                checked.wait_for(timeout=45000)
                page.wait_for_function("""()=>{
                  const canvas=document.querySelector('#sentlogDrawingRecoveryDialog canvas');
                  if(!canvas?.width||canvas.width<100)return false;
                  const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
                  let dark=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0&&pixels[i]<100&&pixels[i+1]<100&&pixels[i+2]<100)dark++;
                  return dark>50;
                }""", timeout=45000)
                assert page.locator('#sentlogDrawingRecoveryConfirm').is_disabled()
                assert '1 / 1 ページ' in page.locator('#sentlogDrawingRecoveryDialog').inner_text()
                return checked

            preview()
            page.screenshot(path=f'/tmp/sentlog-delta-app-drawing-review-{cloud.engine}.png', full_page=True)
            assert page.evaluate(DURABLE) == before, 'Preview changed native application data'
            page.locator('#sentlogDrawingRecoveryCancel').click()
            page.locator('#sentlogDrawingRecoveryDialog').wait_for(state='hidden')
            assert page.evaluate(DURABLE) == before, 'Cancel changed native application data'
            assert all(f.get('missing') for f in page.evaluate(app.READ_NATIVE_FILES, [KEY, PHOTO_KEY]))
            print('PASS real PDF.js renders the candidate; preview and Cancel leave all native files, cutoff and journal unchanged', flush=True)

            preview().check()
            assert page.locator('#sentlogDrawingRecoveryConfirm').is_enabled()
            page.locator('#sentlogDrawingRecoveryConfirm').click()
            page.locator('#sentlogDrawingRecoveryDialog').wait_for(state='hidden', timeout=45000)
            app.wait(cloud, page, lambda: page.evaluate("SentlogRecords.deltaJournal.bindingStateFor('edit-project')?.phase==='active'"),
                     'Explicit confirmation did not resume the real application installer', 60)
            page.evaluate('async()=>{await SentlogRecords.settled();await sentlogCloudIdle();}')
            files = page.evaluate(app.READ_NATIVE_FILES, [KEY, PHOTO_KEY])
            assert files[0]['sha256'] == asset['sha256'] and files[0]['size'] == asset['byte_size'], files
            assert files[1].get('missing'), files
            cutoff = page.evaluate(CUTOFF, dict(scope=SCOPE, localProjectId=LOCAL))
            assert cutoff['rawEntries'] == before_cutoff['rawEntries'] and cutoff['serverRevision'] == 1, cutoff
            receipt = next(file['recovery'] for file in cutoff['files'] if file['key'] == KEY)
            assert receipt['sourceKind'] == 'user-confirmed-current-drawing' and receipt['exactOriginalVerified'] is False, receipt
            assert receipt['originalSnapshotRevision'] == 1 and receipt['selectedSnapshotRevision'] == 8, receipt
            record = page.evaluate("JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:edit-plan')).shapes[0]")
            assert record['photos'] == [photo] and record['memo'] == drawing['state']['shapes'][0]['memo'], record
            assert not [r for r in cloud.photo_requests if r['path'].endswith('/rpc/sentlog_ack_photo')], cloud.photo_requests
            assert not [r for r in cloud.photo_requests if '/storage/' in r['path'] and r['method'] != 'GET'], cloud.photo_requests
            app.assert_native_writes(page)
            print('PASS checked confirmation saves verified PDF bytes add-only, resumes real SQL migration, preserves the pending photo and sends no ACK/upload', flush=True)

            page.reload(wait_until='domcontentloaded')
            page.wait_for_function('window.sentlogDeltaRuntime&&window.SentlogRecords', timeout=45000)
            page.evaluate('async()=>await sentlogAppReady')
            assert page.evaluate(app.READ_NATIVE_FILES, [KEY, PHOTO_KEY]) == files
            accepted = page.evaluate("SentlogRecords.deltaJournal.confirmedDrawingSource('edit-project','edit-plan')")
            assert accepted['sha256'] == asset['sha256'] and accepted['assetId'] == asset['id'], accepted
            assert page.evaluate("SentlogRecords.deltaJournal.bindingStateFor('edit-project').phase") == 'active'
            assert 'pdf.min.js' in cloud.pdf_requests and 'pdf.worker.min.js' in cloud.pdf_requests, cloud.pdf_requests
            assert not cloud.unexpected, cloud.unexpected
            assert not errors, errors
            print('PASS adopted bytes, honest receipt, pending photo reference and active binding survive a real browser reload', flush=True)
        except Exception:
            print(json.dumps(dict(ui=page.locator('body').inner_text()[-3500:],
                                  errors=errors, unexpected=cloud.unexpected,
                                  sql_errors=cloud.sql_errors[-5:], diagnostics=page.evaluate(app.PHOTO_STATE)),
                             ensure_ascii=False, default=str), flush=True)
            raise
        finally:
            context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--executable-path', type=Path)
    args = parser.parse_args()
    root = args.built_root.resolve()
    assert 'SentlogDeltaDrawingReview' in (root / 'sentlog/cloud-sync.js').read_text(), 'Build the production app before testing'
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    backend = app.Backend(ROOT)
    cloud = Cloud(f'http://127.0.0.1:{server.server_port}', root, args.engine, backend)
    cloud.executable_path = str(args.executable_path.resolve()) if args.executable_path else None
    try:
        with sync_playwright() as playwright:
            run(getattr(playwright, args.engine), cloud)
    finally:
        backend.close()
        server.shutdown()


if __name__ == '__main__':
    main()

"""Built-app photo order: real conversion, canonical records, sync, ledger and reload.

Only synthetic data is used and all external requests are blocked. Both engines
use a temporary persistent browser profile and native original/shared/background
Blob stores, matching heavy_camera_ui. No iPhone/iPad hardware is simulated by
these storage tests.
"""
import argparse
import base64
import functools
import hashlib
import io
import json
import os
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

from collaboration_photos_ui import wait_photos
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]
IDS = ['ffffffff-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000002',
       '77777777-0000-4000-8000-000000000003']
NAMES = ['first.jpg', 'second.jpg', 'third.jpg']

def evaluate(page, source, arg=None):
    label = ' '.join(source.split())[:110]
    print('PHOTO_ORDER step: ' + label, flush=True)
    return page.evaluate(r"""async ({source,arg,label})=>{
      let timer;
      const detail=()=>({document:document.readyState,view:typeof currentView==='undefined'?null:currentView,
        recordsReady:!!window.SentlogRecords?.ready,cameraReturn:!!window.SentlogCameraReturn});
      try{
        const value=eval('('+source+')');
        return await Promise.race([
          Promise.resolve(typeof value==='function'?value(arg):value),
          new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Photo order step timeout: '+label+' '+JSON.stringify(detail()))),45000);})
        ]);
      }finally{clearTimeout(timer);}
    }""", {'source': source, 'arg': arg, 'label': label})


def await_ready(page):
    evaluate(page, r"""async()=>{
      await window.sentlogAppReady;let timer;
      try{
        await Promise.race([
          window.SentlogCameraReturn?.ready,
          new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Camera return ready timeout: '+JSON.stringify({
            document:document.readyState,view:typeof currentView==='undefined'?null:currentView,
            module:!!window.SentlogCameraReturn,recordsReady:!!window.SentlogRecords?.ready,
            checkpoint:sessionStorage.getItem('sentlogCameraReturnV1')
          }))),20000);})
        ]);
      }finally{clearTimeout(timer);}
    }""")


def pictures():
    result = []
    for index, color in enumerate([(220, 40, 40), (40, 190, 80), (40, 80, 220)]):
        output = io.BytesIO()
        Image.new('RGB', (320, 240), color).save(output, format='PNG')
        data = output.getvalue()
        result.append({'name': NAMES[index].replace('.jpg', '.png'),
                       'encoded': base64.b64encode(data).decode('ascii'),
                       'sha256': hashlib.sha256(data).hexdigest()})
    return result


def grid_order(page):
    return evaluate(page, """async()=>{
      const record=state.shapes.find(s=>s.id==='survey-a'),before=JSON.stringify(record);
      await renderSelectedPhotos();
      if(before!==JSON.stringify(record))throw Error('Photo rendering mutated the source record');
      return [...document.querySelectorAll('#photoGrid .photo-thumb')].map(el=>el.title);
    }""")


def ledger_order(page):
    return page.locator('.ledger-item').evaluate_all("rows=>rows.map(el=>el.dataset.ledgerKey.split(':').pop())")


def open_ledger(page):
    evaluate(page, """async()=>{
      const project=workspace.projects.find(p=>p.id==='memo-project');
      const group=SentlogDrawingGroups.groupsForProject(project).find(g=>g.sheets.some(s=>s.id==='memo-plan-a'));
      if(!group)throw Error('Synthetic ledger group missing');
      await SentlogPhotoLedger.open(project.id,group.id);
    }""")
    page.locator('.ledger-item').first.wait_for()


PHOTO_PROOF = r"""async()=>{
  const digest=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const record=state.shapes.find(s=>s.id==='survey-a'),result=[];
  for(const metadata of record.photos){
    const shared=await getPhotoBlob(metadata.id,'memo-plan-a');
    const original=await SentlogOriginalPhotos.getOriginal('memo-plan-a',metadata.id);
    if(!shared?.size||!original?.size)throw Error('Captured synthetic image bytes missing');
    const sharedHash=await digest(shared);
    if(sharedHash!==metadata.sha256)throw Error('Shared photo hash no longer matches metadata');
    result.push({id:metadata.id,name:metadata.name,originalHash:await digest(original),sharedHash,
      captureDisplayOrder:metadata.captureDisplayOrder});
  }
  return {photos:result.sort((a,b)=>a.name.localeCompare(b.name)),
    projectionValid:SentlogRecordCollaboration.matchesProjection(record),
    canonicalIds:record.photos.map(p=>p.id)};
}"""


def run(page, engine):
    evaluate(page, SETUP, base64.b64encode(photo_png()).decode('ascii'))
    # SETUP normally supplies backgrounds through a Map. Persist those actual
    # Files before reload; the persistent profile uses native IndexedDB in both
    # engines, matching the existing heavy-camera storage regression.
    evaluate(page, """async()=>{
      for(const [key,file] of memoFixture.files)await putDBFile(key,file);
      await SentlogRecords.settled();
    }""")
    sources = pictures()
    reserved = evaluate(page, r"""async({sources,ids})=>{
      if(!SentlogCollaborationPhotos.captureTarget())throw Error('Synthetic capture target missing');
      const nativeUUID=crypto.randomUUID,nativeNow=Date.now,convert=SentlogOriginalPhotos.makeSharedPhoto;
      const queue=['10000000-0000-4000-8000-000000000000',...ids];let calls=0;
      Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=>queue.shift()||nativeUUID.call(crypto)});
      Date.now=()=>1795700000000;
      SentlogOriginalPhotos.makeSharedPhoto=async file=>{
        if(calls++===0)throw Error('Synthetic first-photo conversion interruption');
        return convert(file);
      };
      try{
        const intent=SentlogCollaborationPhotos.prepareInput('photoInput');
        const files=sources.map(item=>new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name,{type:'image/png'}));
        const result=await SentlogCollaborationPhotos.register(files,intent);
        return {result,pending:await SentlogCollaborationPhotos.listPending()};
      }finally{
        Object.defineProperty(crypto,'randomUUID',{configurable:true,value:nativeUUID});
        Date.now=nativeNow;SentlogOriginalPhotos.makeSharedPhoto=convert;
      }
    }""", {'sources': sources, 'ids': IDS})
    assert [row['status'] for row in reserved['result']] == ['pending', 'attached', 'attached'], reserved
    assert [row['photoId'] for row in reserved['result']] == IDS, reserved
    assert len(reserved['pending']) == 1 and reserved['pending'][0]['originalSaved'], reserved
    assert grid_order(page) == NAMES[1:]
    retry = evaluate(page, "SentlogCollaborationPhotos.retryPending()")
    assert len(retry) == 1 and retry[0]['status'] == 'attached', retry
    wait_photos(page, 'memo-plan-a', 3)
    assert grid_order(page) == NAMES
    proof = evaluate(page, PHOTO_PROOF)
    assert proof['projectionValid'] and proof['canonicalIds'] == [IDS[1], IDS[2], IDS[0]], proof
    assert sorted(p['originalHash'] for p in proof['photos']) == sorted(p['sha256'] for p in sources), proof
    assert len({p['captureDisplayOrder']['at'] for p in proof['photos']}) == 1, proof
    assert sorted(p['captureDisplayOrder']['index'] for p in proof['photos']) == [0, 1, 2], proof

    before = evaluate(page, "JSON.stringify(state.shapes.find(s=>s.id==='survey-a'))")
    open_ledger(page)
    assert ledger_order(page) == IDS
    for format_name in ['damage', 'tensile', 'visual3', 'standard']:
        page.locator('[data-ledger=format]').select_option(format_name)
        assert ledger_order(page) == IDS, format_name
        if format_name == 'tensile':
            labels = page.locator('.ledger-tensile-photo-order').all_text_contents()
            assert len(labels) == 3 and all(name in labels[i] for i, name in enumerate(NAMES)), labels
    # Deliberate manual order must override the new chronological default.
    page.locator('.ledger-item').nth(2).locator('.ledger-order button').first.click()
    page.locator('.ledger-item').nth(1).locator('.ledger-order button').first.click()
    manual = [IDS[2], IDS[0], IDS[1]]
    assert ledger_order(page) == manual
    page.locator('.ledger-save').click()
    page.locator('.ledger-close').click()
    open_ledger(page)
    assert ledger_order(page) == manual
    page.locator('[data-ledger=format]').select_option('tensile')
    assert ledger_order(page) == manual
    page.locator('.ledger-close').click()
    assert before == evaluate(page, "JSON.stringify(state.shapes.find(s=>s.id==='survey-a'))")

    received = evaluate(page, """async()=>{
      document.activeElement?.blur();await SentlogRecords.settled();
      const incoming=structuredClone(memoFixture.snapshot()),drawing=incoming.drawings.find(d=>d.meta.id==='memo-plan-a');
      incoming.project.collaborationVersion=1;
      const index=drawing.state.shapes.findIndex(s=>s.id==='survey-a');
      drawing.state.shapes[index]=SentlogRecordCollaboration.appendComment(drawing.state.shapes[index],'写真順確認の受信コメント',
        {commentId:'order-peer-comment',revisionId:'order-peer-revision',actor:{deviceId:'peer',deviceName:'Peer'},at:1795700001000});
      return memoFixture.commit(incoming);
    }""")
    assert received['applied'], received
    assert grid_order(page) == NAMES
    assert evaluate(page, PHOTO_PROOF) == proof

    evaluate(page, "SentlogRecords.settled()")
    page.reload(wait_until='domcontentloaded')
    page.wait_for_function('window.sentlogAppReady&&window.SentlogCollaborationPhotos&&window.SentlogPhotoDisplayOrder&&window.SentlogPhotoLedger', timeout=45000)
    await_ready(page)
    evaluate(page, """async()=>{
      await openDrawing('memo-project','memo-plan-a');SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');
    }""")
    assert grid_order(page) == NAMES
    assert evaluate(page, PHOTO_PROOF) == proof
    open_ledger(page)
    assert ledger_order(page) == manual
    page.locator('.ledger-close').click()
    return {'engine': engine, 'photos': proof, 'defaultOrder': IDS, 'manualLedgerOrder': manual,
            'reload': True, 'incomingProjection': True, 'delayedRetry': True,
            'blobTransport': 'native IndexedDB with persistent browser profile'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(args.built_root.resolve())))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    errors, report = [], {'engine': args.engine, 'passed': False}
    try:
        with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix='sentlog-photo-order-') as profile:
            browser_type = getattr(playwright, args.engine)
            options = {'headless': True}
            if args.engine == 'chromium' and not os.path.exists(browser_type.executable_path) and os.path.exists('/usr/bin/chromium'):
                options.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            context = browser_type.launch_persistent_context(profile, **options,
                viewport={'width': 820, 'height': 1000}, has_touch=True, is_mobile=True, service_workers='block')

            def route(request):
                if request.request.url.startswith((origin+'/', 'blob:', 'data:')):
                    request.continue_()
                elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request.fulfill(content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(origin+'/sentlog/', wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogAppReady&&window.SentlogCollaborationPhotos&&window.SentlogPhotoDisplayOrder&&window.SentlogPhotoLedger', timeout=45000)
                await_ready(page)
                report.update(run(page, args.engine))
                assert not errors, errors
                report['passed'] = True
                print('PASS photo capture order '+args.engine+': inverse UUIDs, tied batch, durable retry, grid, four ledger defaults, manual draft, incoming projection, reload, exact photo hashes', flush=True)
            except Exception as error:
                report['error'] = str(error)
                if args.report:
                    args.report.parent.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(args.report.with_suffix('.png')), full_page=True)
                raise
            finally:
                report['pageErrors'] = errors
                context.close()
    finally:
        server.shutdown()
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

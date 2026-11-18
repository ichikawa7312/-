"""Production photo capture against synthetic records; all external I/O is blocked.

Chromium uses the real original/shared Blob stores. Linux WebKit substitutes
only Blob transport (its known fixture limitation), retaining production records
IndexedDB, photo operation journal, incoming commit, image conversion and UI.
"""
import argparse
import base64
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]

WEBKIT_TRANSPORT = r"""()=>{
  const originals=new Map(),metas=new Map(),shared=new Map(),api=SentlogOriginalPhotos;
  const readShared=getPhotoBlob;
  api.stageOriginal=async(did,pid,file,meta)=>{
    const key=did+':'+pid;if(metas.has(key))return structuredClone(metas.get(key));
    const row={...structuredClone(meta),key,drawingId:did,photoId:pid,size:file.size,type:file.type,
      originalName:file.name||meta.originalName,exportedAt:null,storedAt:Date.now()};
    originals.set(key,file);metas.set(key,row);return structuredClone(row);
  };
  api.getOriginal=async(did,pid)=>originals.get(did+':'+pid)||null;
  api.listMeta=async()=>[...metas.values()].map(x=>structuredClone(x));
  api.updatePhotoAssociation=async(did,pid,association)=>{
    const row=metas.get(did+':'+pid);if(!row)throw Error('Synthetic original missing');
    row.photoAssociation=structuredClone(association);return structuredClone(row);
  };
  getPhotoBlob=async(id,did=activeDrawingId)=>shared.get(did+':'+id)||readShared(id,did);
  savePhotoBlob=async(id,blob,did=activeDrawingId)=>{shared.set(did+':'+id,blob);};
}"""

HOLD_CONVERSION = r"""()=>{
  const convert=SentlogOriginalPhotos.makeSharedPhoto;
  window.photoCaptureGate={entered:false,release:null,convert};
  const gate=new Promise(resolve=>{photoCaptureGate.release=resolve;});
  SentlogOriginalPhotos.makeSharedPhoto=async file=>{
    photoCaptureGate.entered=true;await gate;return convert(file);
  };
}"""


def release(page):
    page.evaluate('SentlogOriginalPhotos.makeSharedPhoto=photoCaptureGate.convert;photoCaptureGate.release()')


def wait_photos(page, drawing_id, count):
    page.wait_for_function("""({id,count})=>JSON.parse(SentlogRecords.getItem(drawingStorageKey(id)))
      .shapes.find(s=>s.id==='survey-a').photos.length===count""", arg={'id': drawing_id, 'count': count})
    page.wait_for_function('async()=>!(await SentlogCollaborationPhotos.listPending()).length')


def run(page, engine):
    if engine == 'webkit':
        page.evaluate(WEBKIT_TRANSPORT)
    encoded = base64.b64encode(photo_png()).decode('ascii')
    page.evaluate(SETUP, encoded)

    # A real chooser click fixes the destination before a same-ID drawing switch.
    page.evaluate(HOLD_CONVERSION)
    with page.expect_file_chooser() as chooser:
        page.locator('#cameraInput').evaluate('input=>input.click()')
    page.evaluate("""async()=>{
      await openDrawing(memoFixture.pid,'memo-plan-b');SentlogFieldRecords.selectRecord('survey-a');
      $('inspector').classList.add('open');
    }""")
    chooser.value.set_files({'name': 'first.png', 'mimeType': 'image/png', 'buffer': photo_png()})
    page.wait_for_function('photoCaptureGate.entered')
    assert not page.evaluate('SentlogCollaborationPhotos.isCommitting()')
    release(page)
    wait_photos(page, 'memo-plan-a', 1)
    assert page.evaluate("activeDrawingId==='memo-plan-b'&&state.shapes.find(s=>s.id==='survey-a').photos.length===0")
    assert page.evaluate("state.shapes.find(s=>s.id==='survey-a').memo") == '別図面に保存済み'

    # Incoming append changes the current record while local image work awaits.
    page.evaluate("""async()=>{await openDrawing(memoFixture.pid,'memo-plan-a');
      SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');}""")
    page.evaluate(HOLD_CONVERSION)
    with page.expect_file_chooser() as chooser:
        page.locator('#photoAddBtn').click()
    chooser.value.set_files({'name': 'second.png', 'mimeType': 'image/png', 'buffer': photo_png()})
    page.wait_for_function('photoCaptureGate.entered')
    received = page.evaluate("""async()=>{
      const incoming=structuredClone(memoFixture.snapshot()),d=incoming.drawings.find(x=>x.meta.id==='memo-plan-a');
      incoming.project.collaborationVersion=1;
      const index=d.state.shapes.findIndex(s=>s.id==='survey-a'),M=SentlogRecordCollaboration;
      const actor={deviceId:'synthetic-ipad',deviceName:'iPad'};
      let record=M.appendComment(d.state.shapes[index],'撮影処理中に届いた所見',
        {commentId:'peer-comment',revisionId:'peer-comment-v1',actor,at:200});
      record=M.addPhoto(record,{id:'peer-photo',name:'peer.png',type:'image/png',size:memoFixture.photo.size},
        {revisionId:'peer-photo-v1',actor,at:201});
      d.state.shapes[index]=record;
      memoFixture.files.set(photoDBKey('peer-photo','memo-plan-a'),memoFixture.photo);
      return memoFixture.commit(incoming);
    }""")
    assert received['applied'], received
    assert page.evaluate("SentlogRecordCollaboration.view(memoFixture.record()).comments.some(c=>c.id==='peer-comment'&&c.text==='撮影処理中に届いた所見')")
    release(page)
    wait_photos(page, 'memo-plan-a', 3)
    assert page.evaluate("memoFixture.record().photos.some(p=>p.id==='peer-photo')")
    assert page.evaluate("SentlogRecordCollaboration.view(memoFixture.record()).comments.some(c=>c.id==='peer-comment')")

    # Decode failure retains a real original and a durable same-ID retry.
    failure = page.evaluate("""async()=>{
      const convert=SentlogOriginalPhotos.makeSharedPhoto;
      SentlogOriginalPhotos.makeSharedPhoto=async()=>{throw Error('Synthetic conversion interruption');};
      try{
        const intent=SentlogCollaborationPhotos.prepareInput('photoInput');
        await SentlogCollaborationPhotos.register([new File([memoFixture.photo],'retry.png',{type:'image/png'})],intent);
      }finally{SentlogOriginalPhotos.makeSharedPhoto=convert;}
      const pending=await SentlogCollaborationPhotos.listPending();
      return {pending,metas:await SentlogOriginalPhotos.listMeta()};
    }""")
    assert len(failure['pending']) == 1, failure
    pending = failure['pending'][0]
    assert pending['originalSaved'] and pending['target']['drawingId'] == 'memo-plan-a', pending
    page.locator('#sentlogPendingPhotos').evaluate('el=>el.open=true')
    page.get_by_role('button', name='保存を再試行', exact=True).click()
    wait_photos(page, 'memo-plan-a', 4)
    kept = page.evaluate("""async({photoId,encoded})=>{
      const metas=await SentlogOriginalPhotos.listMeta(),source=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      const originals=[];
      for(const meta of metas){const blob=await SentlogOriginalPhotos.getOriginal(meta.drawingId,meta.photoId);
        const bytes=new Uint8Array(await blob.arrayBuffer());
        originals.push({id:meta.photoId,exact:bytes.length===source.length&&bytes.every((v,i)=>v===source[i]),
          status:meta.photoAssociation.status,target:meta.photoAssociation.target.drawingId});}
      const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a')));
      const record=saved.shapes.find(s=>s.id==='survey-a');
      return {originals,ids:record.photos.map(p=>p.id),revision:record.collab.photos[photoId].revisions.map(r=>r.id),
        otherDrawing:JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-b'))).shapes[0].photos.length,
        comments:SentlogRecordCollaboration.view(record).comments.map(c=>c.text)};
    }""", {'photoId': pending['photoId'], 'encoded': encoded})
    assert len(kept['originals']) == 3 and all(row['exact'] and row['status'] == 'attached' and row['target'] == 'memo-plan-a' for row in kept['originals']), kept
    assert len(set(kept['ids'])) == 4 and kept['ids'].count(pending['photoId']) == 1, kept
    assert kept['revision'] == ['capture:' + pending['photoId']], kept
    assert kept['otherDrawing'] == 0 and '撮影処理中に届いた所見' in kept['comments'], kept
    print('PASS '+engine+': chooser target before navigation, incoming comment/photo during conversion, '
          'exact originals, durable same-ID retry, no other-drawing attachment or lost append')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    args = parser.parse_args()

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(args.built_root.resolve())))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            browser_type = getattr(playwright, args.engine)
            options = {'headless': True}
            if args.engine == 'chromium' and not os.path.exists(browser_type.executable_path) and os.path.exists('/usr/bin/chromium'):
                options.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            browser = browser_type.launch(**options)
            context = browser.new_context(viewport={'width': 820, 'height': 1000}, has_touch=True,
                                          is_mobile=True, service_workers='block')

            def route(request):
                if request.request.url.startswith((origin+'/', 'blob:', 'data:')):
                    request.continue_()
                elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request.fulfill(content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(origin+'/sentlog/', wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogAppReady&&window.SentlogCollaborationPhotos&&window.SentlogRecordCollaboration', timeout=45000)
                run(page, args.engine)
                assert not errors, errors
            finally:
                browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()

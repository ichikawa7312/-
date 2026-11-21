"""Heavy drawing lifetimes and interrupted photo transactions in the built app.

PDF.js, canvas decoding, Blob IndexedDB, record commits, capture recovery and UI
are production code. Camera hardware and fault timing are synthetic. Each fault
aborts a real native IndexedDB transaction after its write request succeeds,
before commit; this is not a claim of exhausting a physical iPhone's disk.
Fresh pages discard renderer memory while retaining the persistent profile.
No external service or user record is accessed.
"""
import argparse
import base64
import functools
import hashlib
import io
import json
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import expect, sync_playwright

from continuous_camera_ui import CAMERA_MOCK, camera_count, open_camera, shutter
from drawing_responsiveness_ui import TRACE as PDF_TRACE
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]
PID, PDF_ID, IMAGE_ID = 'memo-project', 'memo-plan-a', 'memo-plan-b'
COLORS = [(255, 224, 224), (224, 255, 224), (224, 224, 255),
          (255, 255, 224), (224, 255, 255), (255, 224, 255)]


def multi_page_pdf(pages=24):
    """Dense vector sheets; an unmarked corner has independent expected RGB."""
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'']
    for index in range(pages):
        red, green, blue = COLORS[index % len(COLORS)]
        paint = [f'{red/255:.6f} {green/255:.6f} {blue/255:.6f} rg 0 0 4200 2970 re f\n',
                 '0.25 0.28 0.30 RG 1 w\n']
        for line in range(2000):
            x, y = 100 + (line % 80) * 45, 100 + (line // 80) * 94
            paint.append(f'{x} {y} m {x+28} {y+35} l S\n')
        stream = ''.join(paint).encode('ascii')
        page_id = 3 + 2 * index
        objects.extend([
            f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 4200 2970] /Resources << >> /Contents {page_id+1} 0 R >>'.encode(),
            b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream'])
    kids = ' '.join(f'{3+2*i} 0 R' for i in range(pages))
    objects[1] = f'<< /Type /Pages /Kids [{kids}] /Count {pages} >>'.encode()
    data, offsets = b'%PDF-1.4\n', [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += str(number).encode() + b' 0 obj\n' + body + b'\nendobj\n'
    start = len(data)
    data += f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()
    data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return data + f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()


def raster_fixture(width, height, *, jpeg=False):
    image = Image.effect_noise((width, height), 18).convert('RGB')
    draw = ImageDraw.Draw(image)
    for y in range(80, height - 40, 190):
        draw.line((60, y, width-60, y+35), fill=(230, 235, 240), width=5)
        draw.rectangle((100, y+50, 340, y+115), outline=(30, 70, 100), width=5)
    buffer = io.BytesIO()
    image.save(buffer, format='JPEG' if jpeg else 'PNG', **({'quality': 88} if jpeg else {}))
    return buffer.getvalue()


SEED = r"""async ({pdf,image,pages})=>{
  showDrawings(memoFixture.pid);await SentlogRecords.settled();
  const decode=encoded=>Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const sources=[['memo-plan-a',new File([decode(pdf)],'heavy-24-pages.pdf',{type:'application/pdf'})],
    ['memo-plan-b',new File([decode(image)],'heavy-4096x3072.jpg',{type:'image/jpeg'})]];
  const base=JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a'))).shapes.find(r=>r.id==='survey-a');
  for(const [id,file]of sources){
    await putDBFile('background:'+id,file);
    const raw=JSON.parse(SentlogRecords.getItem(drawingStorageKey(id)));
    const isPdf=id==='memo-plan-a';
    Object.assign(raw,{sourceType:isPdf?'pdf':'image',fileName:file.name,
      pageCount:isPdf?pages:1,currentPage:1,width:isPdf?4200:4096,height:isPdf?2970:3072});
    raw.shapes=Array.from({length:isPdf?pages:1},(_,i)=>SentlogRecordCollaboration.upgrade({
      ...structuredClone(base),id:i?'survey-page-'+(i+1):'survey-a',page:i+1,recordNo:i+1,typeNo:i+1,globalNo:i+1,
      autoLabel:'調査-'+(i+1),memo:(isPdf?'PDF':'画像')+'保存済みの所見 '+(i+1),photos:[]}));
    SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify(raw));
    const meta=workspace.projects.find(p=>p.id===memoFixture.pid).drawings.find(d=>d.id===id);
    Object.assign(meta,{sourceType:raw.sourceType,fileName:file.name,pageCount:raw.pageCount});
  }
  saveWorkspace();await SentlogRecords.settled();
  // The legacy setup's in-memory source transport must not satisfy any later
  // load or restart. Both backgrounds above are now real native Blob records.
  memoFixture.files.clear();
  window.heavyInitialShapes=Object.fromEntries(sources.map(([id])=>[id,
    JSON.stringify(JSON.parse(SentlogRecords.getItem(drawingStorageKey(id))).shapes)]));
  return {drawings:sources.length,records:pages+1};
}"""

RESOURCE_TRACE = r"""()=>{
  const trace=window.heavyResources={urls:new Map(),created:0,revoked:0,bitmaps:[]};
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  URL.createObjectURL=function(value){const url=create.apply(this,arguments);trace.created++;
    trace.urls.set(url,{bytes:value.size||0,type:value.type||''});return url;};
  URL.revokeObjectURL=function(url){if(trace.urls.delete(url))trace.revoked++;return revoke.apply(this,arguments);};
  if(typeof createImageBitmap==='function'){
    const native=createImageBitmap;
    window.createImageBitmap=async function(){const bitmap=await native.apply(this,arguments);
      const row={width:bitmap.width,height:bitmap.height,closed:false};trace.bitmaps.push(row);
      const close=bitmap.close;bitmap.close=function(){row.closed=true;return close.apply(this,arguments);};return bitmap;};
  }
  trace.snapshot=()=>({urls:trace.urls.size,urlBytes:[...trace.urls.values()].reduce((n,x)=>n+x.bytes,0),
    liveBitmaps:trace.bitmaps.filter(b=>!b.closed).length,
    liveBitmapPixels:trace.bitmaps.filter(b=>!b.closed).reduce((n,b)=>n+b.width*b.height,0),
    attachedCanvasPixels:[...document.querySelectorAll('canvas')].reduce((n,c)=>n+c.width*c.height,0),
    detailCanvases:document.querySelectorAll('.sentlog-pdf-detail,.sentlog-image-detail').length,
    activePdfRenders:drawingTrace.activeRenders,livePdfWorkers:drawingTrace.documents.filter(d=>!d.released).length,
    liveTracks:cameraMock.tracks.filter(t=>t.readyState!=='ended').length});
}"""

FAULTS = r"""()=>{
  const state=window.heavyFault={mode:null,remaining:0,fired:0,aborted:0,events:[]};
  const native=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,key){
    const tx=this.transaction,db=tx.db.name,name=this.name,association=value?.photoAssociation;
    let selected=false;
    if(state.remaining>0){
      if(state.mode==='original')selected=db==='sentlog-original-photos-v1'&&name==='photos'&&value instanceof Blob;
      if(state.mode==='shared')selected=db==='surveyFieldNoteDB'&&name==='files'&&String(key).startsWith('photo:memo-plan-a:');
      if(state.mode==='record'&&db==='surveyFieldNoteDB'&&name==='files'&&key==='__sentlog_record__:surveyFieldNoteDrawingV1:memo-plan-a'){
        try{selected=JSON.parse(value).shapes.find(r=>r.id==='survey-a').photos.length>state.beforeCount;}catch{}
      }
      if(state.mode==='association')selected=db==='sentlog-original-photos-v1'&&name==='meta'&&association?.status==='attached';
    }
    const request=native.apply(this,arguments);
    if(selected){
      state.remaining--;state.fired++;state.events.push({mode:state.mode,database:db,store:name,key:String(key||value?.key||'')});
      request.addEventListener('success',()=>{tx.abort();state.aborted++;},{once:true});
    }
    return request;
  };
}"""

READ_RECORD = r"""async drawingId=>{
  const db=await SentlogRecords.openFilesDatabase();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('files','readonly'),q=tx.objectStore('files').get('__sentlog_record__:surveyFieldNoteDrawingV1:'+drawingId);
    q.onsuccess=()=>resolve(JSON.parse(q.result));q.onerror=()=>reject(q.error);
  });}finally{db.close();}
}"""

PHOTO_PROOF = r"""async ({drawingId,photoId})=>{
  const native=await (""" + READ_RECORD + r""")(drawingId),record=native.shapes.find(r=>r.id==='survey-a');
  const matches=record.photos.filter(p=>p.id===photoId),photo=matches[0];
  const original=await SentlogOriginalPhotos.getOriginal(drawingId,photoId),shared=await getPhotoBlob(photoId,drawingId);
  const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))]
    .map(x=>x.toString(16).padStart(2,'0')).join('');
  const meta=(await SentlogOriginalPhotos.listMeta(drawingId)).find(m=>m.photoId===photoId);
  return {photoId,matches:matches.length,ids:record.photos.map(p=>p.id),originalBytes:original?.size,
    originalHash:original?await hash(original):null,sharedHash:shared?await hash(shared):null,
    expectedSharedHash:photo?.sha256,status:meta?.photoAssociation?.status,
    target:meta?.photoAssociation?.target,revisionIds:record.collab?.photos?.[photoId]?.revisions?.map(r=>r.id)||[]};
}"""


def settle(page, delay=220):
    page.evaluate("""delay=>new Promise(resolve=>setTimeout(()=>
      requestAnimationFrame(()=>requestAnimationFrame(resolve)),delay))""", delay)


def saved_ids(page, drawing_id=PDF_ID):
    return [photo['id'] for photo in page.evaluate(READ_RECORD, drawing_id)['shapes'][0]['photos']]


def select_record(page, drawing_id, page_number=1):
    page.evaluate("""async({drawingId,pageNumber})=>{
      await openDrawing('memo-project',drawingId);
      if(state.sourceType==='pdf'&&state.currentPage!==pageNumber)await renderPdfPage(pageNumber);
      SentlogFieldRecords.selectRecord(pageNumber===1?'survey-a':'survey-page-'+pageNumber);
      $('inspector').classList.add('open');await SentlogRecords.settled();
    }""", {'drawingId': drawing_id, 'pageNumber': page_number})


def wait_attached(page, count):
    page.wait_for_function("""count=>JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:memo-plan-a'))
      .shapes.find(r=>r.id==='survey-a').photos.length===count""", arg=count, timeout=45000)
    page.evaluate("""async()=>{
      const deadline=performance.now()+45000;
      while((await SentlogCollaborationPhotos.listPending()).length){
        if(performance.now()>deadline)throw Error('Interrupted capture did not recover');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      await SentlogRecords.settled();SentlogRecords.assertSafe();
    }""")


def verify_backgrounds(page, expected):
    proof = page.evaluate("""async()=>{
      const out={};
      for(const id of ['memo-plan-a','memo-plan-b']){
        const blob=await getDBFile('background:'+id);
        const hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
        out[id]=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
      }
      return out;
    }""")
    assert proof == expected, ('Original drawing bytes changed', proof, expected)


def camera_rotations(page, *, background=False):
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_enabled()
    page.wait_for_function('drawingTrace.activeRenders===0')
    before = page.evaluate('({renders:drawingTrace.renders,allocations:drawingTrace.allocations})')
    for width, height in [(844, 390), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.evaluate("window.dispatchEvent(new Event('orientationchange'))")
        settle(page)
    if background:
        page.evaluate("""()=>{
          Object.defineProperty(document,'hidden',{configurable:true,value:true});
          document.dispatchEvent(new Event('visibilitychange'));
          delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));
        }""")
        expect(page.locator('#slCameraShutter')).to_be_disabled()
        assert page.evaluate("cameraMock.tracks.every(t=>t.readyState==='ended')")
        page.locator('#slCameraResume').click()
        expect(page.locator('#slCameraShutter')).to_be_enabled()
        settle(page)
    after = page.evaluate('({renders:drawingTrace.renders,allocations:drawingTrace.allocations})')
    assert after == before, ('Covered drawing did work during rotation/background', before, after)
    page.locator('#slCameraDone').click()
    expect(page.locator('#sentlogContinuousCamera')).to_be_hidden()
    settle(page)


def lifecycle(page, report, cycles, save_report):
    page.evaluate(PDF_TRACE)
    page.evaluate(RESOURCE_TRACE)
    measurements = []
    for index in range(cycles):
        page_number = (index * 7) % 24 + 1
        started = time.perf_counter()
        select_record(page, PDF_ID, page_number)
        page.wait_for_function('drawingTrace.activeRenders===0')
        actual = page.evaluate("""()=>({page:state.currentPage,
          pixel:[...ctx.getImageData(Math.floor(canvas.width*.98),Math.floor(canvas.height*.98),1,1).data]})""")
        assert actual['page'] == page_number
        assert all(abs(a-b) <= 1 for a, b in zip(actual['pixel'], [*COLORS[(page_number-1) % len(COLORS)], 255])), actual
        page.evaluate('scale=2;tx=-120;ty=-90;applyTransform()')
        page.wait_for_function("document.querySelector('.sentlog-pdf-detail')&&drawingTrace.activeRenders===0")
        camera_rotations(page, background=index % 5 == 0)
        expected_record = 'survey-a' if page_number == 1 else f'survey-page-{page_number}'
        assert page.evaluate('({id:activeDrawingId,page:state.currentPage,selected,view:currentView})') == {
            'id': PDF_ID, 'page': page_number, 'selected': expected_record, 'view': 'editor'}
        page.evaluate("showDrawings('memo-project')")
        page.wait_for_function('drawingTrace.documents.every(d=>d.released&&d.destroyCalls===1)')

        select_record(page, IMAGE_ID)
        page.wait_for_function("document.getElementById('stageWrap').dataset.imageViewport==='true'&&document.querySelector('.sentlog-image-detail')")
        source = page.evaluate("({width:state.width,height:state.height,pixels:Number(document.getElementById('stageWrap').dataset.imageSourcePixels)})")
        assert source['width'] == 4096 and source['height'] == 3072 and 0 < source['pixels'] <= 4000000, source
        page.evaluate('scale=2.4;tx=-200;ty=-120;applyTransform()')
        settle(page)
        camera_rotations(page)
        assert page.evaluate('({id:activeDrawingId,selected,view:currentView})') == {
            'id': IMAGE_ID, 'selected': 'survey-a', 'view': 'editor'}
        page.evaluate('showProjects()')
        settle(page, 60)
        resources = page.evaluate('heavyResources.snapshot()')
        assert resources['livePdfWorkers'] == resources['activePdfRenders'] == resources['liveTracks'] == 0, resources
        assert resources['detailCanvases'] == resources['liveBitmaps'] == resources['liveBitmapPixels'] == 0, resources
        assert resources['urls'] <= 1 and resources['attachedCanvasPixels'] <= 100000, resources
        measurements.append({'cycle': index+1, 'pdfPage': page_number,
                             'elapsedMs': round((time.perf_counter()-started)*1000, 2), 'released': resources})
        if (index+1) % 5 == 0 or index+1 == cycles:
            report['drawingCycles'] = measurements
            save_report()
            print(f'HEAVY_DURABILITY drawing cycles {index+1}/{cycles}', flush=True)
    summary = page.evaluate("""()=>({documents:drawingTrace.documents.length,
      destroyed:drawingTrace.documents.filter(d=>d.released&&d.destroyCalls===1).length,
      resources:heavyResources.snapshot(),sameRecords:['memo-plan-a','memo-plan-b'].every(id=>
        JSON.stringify(JSON.parse(SentlogRecords.getItem(drawingStorageKey(id))).shapes)===heavyInitialShapes[id])})""")
    assert summary['documents'] == summary['destroyed'] == cycles and summary['sameRecords'], summary
    report['drawingLifetimeProof'] = summary

    # Delay an old real file read, switch to another drawing and only then
    # release it. Repeat to detect stale-completion or generation drift.
    for _ in range(6):
        page.evaluate("""()=>{
          const original=getDBFile;window.heavyReadGate={entered:false,release:null,original};
          const gate=new Promise(resolve=>{heavyReadGate.release=resolve;});let once=false;
          getDBFile=async function(key){
            if(!once&&key==='background:memo-plan-a'){once=true;heavyReadGate.entered=true;await gate;}
            return original.apply(this,arguments);
          };
          heavyReadGate.old=openDrawing('memo-project','memo-plan-a');
        }""")
        page.wait_for_function('heavyReadGate.entered')
        try:
            select_record(page, IMAGE_ID)
            page.evaluate('heavyReadGate.release()')
            page.evaluate('heavyReadGate.old')
            settle(page)
            assert page.evaluate('({id:activeDrawingId,type:state.sourceType,width:state.width,height:state.height})') == {
                'id': IMAGE_ID, 'type': 'image', 'width': 4096, 'height': 3072}
        finally:
            page.evaluate('getDBFile=heavyReadGate.original;heavyReadGate.release()')
        page.evaluate('showProjects()')
    settle(page, 60)
    page.wait_for_function('drawingTrace.documents.every(d=>d.released&&d.destroyCalls===1)')
    resources = page.evaluate('heavyResources.snapshot()')
    assert resources['livePdfWorkers'] == resources['activePdfRenders'] == resources['liveTracks'] == 0, resources
    assert resources['detailCanvases'] == resources['liveBitmaps'] == resources['liveBitmapPixels'] == 0, resources
    assert resources['urls'] <= 1 and resources['attachedCanvasPixels'] <= 100000, resources
    report['staleFileCompletionRaces'] = 6
    report['afterStaleLoads'] = resources
    print('PASS drawing cycles: real PDF pixels, bounded large-image sources, released workers/bitmaps/tracks and six stale-load races', flush=True)


def fault_cases(page, context, new_page, report, camera_png, save_report):
    source_hash = hashlib.sha256(camera_png).hexdigest()
    encoded = base64.b64encode(camera_png).decode('ascii')
    recovered = []
    for mode in ('original', 'shared', 'record', 'association'):
        select_record(page, PDF_ID)
        before = saved_ids(page)
        other_pdf_records = page.evaluate(READ_RECORD, PDF_ID)['shapes'][1:]
        other_drawing_records = page.evaluate(READ_RECORD, IMAGE_ID)['shapes']
        page.evaluate(CAMERA_MOCK, encoded)
        page.evaluate('cameraMock.imageReady')
        page.evaluate(FAULTS)
        page.evaluate("""({mode,count})=>Object.assign(heavyFault,
          {mode,beforeCount:count,remaining:mode==='original'?2:1})""", {'mode': mode, 'count': len(before)})
        open_camera(page)
        shutter(page)
        expect(page.locator('#slCameraRetry')).to_be_visible(timeout=45000)
        camera_count(page, 0)
        failure = page.evaluate("""async()=>({fired:heavyFault.fired,aborted:heavyFault.aborted,events:heavyFault.events,
          pending:await SentlogCollaborationPhotos.listPending(),recordStoreFailed:SentlogRecords.failed})""")
        assert failure['fired'] == failure['aborted'] == (2 if mode == 'original' else 1), failure
        assert len(failure['pending']) == 1, failure
        pending = failure['pending'][0]
        photo_id = pending['photoId']
        # The collaboration projection deliberately orders photographs by ID,
        # independently of arrival time or the device doing the recovery.
        expected_ids = sorted(before+[photo_id])
        assert pending['target']['drawingId'] == PDF_ID and pending['target']['recordId'] == 'survey-a', pending
        assert pending['status'] == 'pending' and pending['originalSaved'] is (mode != 'original'), pending
        disk_ids = saved_ids(page)
        assert disk_ids == (expected_ids if mode == 'association' else before), (mode, disk_ids, before, photo_id)
        assert saved_ids(page, IMAGE_ID) == []
        if mode == 'original':
            expect(page.locator('#slCameraShutter')).to_be_disabled()
            page.locator('#slCameraDone').click()
            assert page.evaluate('SentlogContinuousCamera.isOpen()')
            expect(page.locator('#slCameraStatus')).to_contain_text('まだ保存できていない写真')
            assert page.evaluate("id=>SentlogOriginalPhotos.getOriginal('memo-plan-a',id)", photo_id) is None
            assert not page.evaluate("async id=>(await SentlogOriginalPhotos.listMeta('memo-plan-a')).some(m=>m.photoId===id)", photo_id)
        else:
            retained_hash = page.evaluate("""async id=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',
              await (await SentlogOriginalPhotos.getOriginal('memo-plan-a',id)).arrayBuffer()))]
              .map(x=>x.toString(16).padStart(2,'0')).join('')""", photo_id)
            assert retained_hash == source_hash
        if mode in ('shared', 'record'):
            assert failure['recordStoreFailed'], failure

        # Discard JS memory without invoking cleanup/retry. The profile's real
        # native IndexedDB and localStorage are the sole restart inputs.
        page = new_page(context, replacing=page)
        if mode == 'original':
            select_record(page, PDF_ID)
            restarted = page.evaluate('SentlogCollaborationPhotos.listPending()')
            assert len(restarted) == 1 and restarted[0]['photoId'] == photo_id and not restarted[0]['originalSaved'], restarted
            assert saved_ids(page) == before
            # RAM bytes cannot survive renderer termination before commit.
            # The application must say so and request the source again.
            panel = page.locator('#sentlogPendingPhotos')
            expect(panel).to_be_visible()
            panel.evaluate('element=>element.open=true')
            with page.expect_file_chooser() as chooser:
                panel.get_by_role('button', name='元の写真を選び直す', exact=True).click()
            chooser.value.set_files({'name': 'reselected-original.png', 'mimeType': 'image/png', 'buffer': camera_png})
        wait_attached(page, len(before)+1)
        proof = page.evaluate(PHOTO_PROOF, {'drawingId': PDF_ID, 'photoId': photo_id})
        assert proof['matches'] == 1 and proof['ids'] == expected_ids, proof
        assert proof['originalHash'] == source_hash and proof['originalBytes'] == len(camera_png), proof
        assert proof['sharedHash'] == proof['expectedSharedHash'] and proof['sharedHash'], proof
        assert proof['status'] == 'attached' and proof['target']['drawingId'] == PDF_ID, proof
        assert proof['revisionIds'] == ['capture:'+photo_id], proof
        assert saved_ids(page, IMAGE_ID) == []
        # A repeated retry callback is idempotent after recovery.
        assert page.evaluate('id=>SentlogCollaborationPhotos.retryPending(id)', photo_id) == []
        assert saved_ids(page) == expected_ids
        assert page.evaluate(READ_RECORD, PDF_ID)['shapes'][1:] == other_pdf_records
        assert page.evaluate(READ_RECORD, IMAGE_ID)['shapes'] == other_drawing_records
        recovered.append({'boundary': mode, 'nativeTransactionAborts': failure['aborted'],
                          'diskAttachedBeforeRestart': mode == 'association',
                          'sourceReselectionRequired': mode == 'original', 'proof': proof})
        report['transactionRecovery'] = recovered
        save_report()
        print('PASS native transaction recovery: '+mode+'; stable photo ID, exact original, hash-checked shared image and one attachment', flush=True)
    return page


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--cycles', type=int, default=30)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    assert args.cycles > 0
    report_path = args.report or Path(f'/tmp/sentlog-heavy-durability-{args.engine}.json')
    report = {'engine': args.engine, 'status': 'running', 'requestedCycles': args.cycles,
              'storage': 'native IndexedDB Blob storage in a persistent profile',
              'faultModel': 'native transaction abort after write request success; not physical disk exhaustion',
              'restartModel': 'new renderer page; precommit RAM bytes must be reselected'}

    def save_report():
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *unused):
            pass

    root = args.built_root.resolve()
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    page = None
    errors = []
    save_report()
    try:
        with tempfile.TemporaryDirectory(prefix='sentlog-heavy-durability-') as profile, sync_playwright() as playwright:
            context = getattr(playwright, args.engine).launch_persistent_context(
                profile, headless=True, viewport={'width': 390, 'height': 844}, has_touch=True,
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

            def new_page(browser_context, *, replacing=None):
                if replacing is None:
                    current = browser_context.pages[0] if browser_context.pages else browser_context.new_page()
                else:
                    # Closing WebKit's last page ends its persistent browser.
                    # Keep a new blank page alive, discard the old renderer,
                    # and only then load the app and acquire its writer lock.
                    current = browser_context.new_page()
                    replacing.close(run_before_unload=False)
                current.on('pageerror', lambda error: errors.append(str(error)))
                current.goto(origin+'/sentlog/', wait_until='domcontentloaded')
                current.wait_for_function('window.sentlogAppReady&&window.SentlogContinuousCamera&&window.SentlogCollaborationPhotos', timeout=45000)
                current.evaluate("pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/export-pdf.worker.min.js'")
                return current

            try:
                page = new_page(context)
                report['stage'] = 'seed'
                page.evaluate(SETUP, base64.b64encode(photo_png()).decode('ascii'))
                pdf, large_image = multi_page_pdf(), raster_fixture(4096, 3072, jpeg=True)
                hashes = {PDF_ID: hashlib.sha256(pdf).hexdigest(), IMAGE_ID: hashlib.sha256(large_image).hexdigest()}
                report['fixtures'] = {'pdfPages': 24, 'vectorSegmentsPerPage': 2000, 'pdfBytes': len(pdf),
                                      'imageWidth': 4096, 'imageHeight': 3072, 'imageBytes': len(large_image),
                                      'backgroundHashes': hashes}
                page.evaluate(SEED, {'pdf': base64.b64encode(pdf).decode('ascii'),
                                     'image': base64.b64encode(large_image).decode('ascii'), 'pages': 24})
                page.evaluate(CAMERA_MOCK, base64.b64encode(photo_png()).decode('ascii'))
                page.evaluate('cameraMock.imageReady')
                report['stage'] = 'drawing-lifetimes'
                lifecycle(page, report, args.cycles, save_report)
                verify_backgrounds(page, hashes)
                report['stage'] = 'native-transaction-recovery'
                page = fault_cases(page, context, new_page, report, raster_fixture(1600, 1200), save_report)
                verify_backgrounds(page, hashes)
                assert not errors, errors
                report.update(status='passed', stage='complete', browserErrors=errors,
                              cameraOpenCloseCycles=args.cycles*2, cameraCoveredRotations=args.cycles*4,
                              backgroundResumeCycles=(args.cycles+4)//5, finalPhotoIds=saved_ids(page))
                save_report()
                print('PASS '+args.engine+': heavy drawing lifetimes and native transaction/restart recovery', flush=True)
            except Exception as error:
                report.update(status='failed', error=str(error), browserErrors=errors)
                try:
                    active = [p for p in context.pages if not p.is_closed()]
                    if active:
                        active[-1].screenshot(path=f'/tmp/sentlog-heavy-durability-{args.engine}-failure.png')
                        report['failureState'] = active[-1].evaluate("""()=>({view:typeof currentView==='undefined'?null:currentView,
                          drawing:typeof activeDrawingId==='undefined'?null:activeDrawingId,
                          status:document.getElementById('slCameraStatus')?.textContent,
                          photoStatus:document.getElementById('photoStatus')?.textContent,
                          fault:window.heavyFault,resources:window.heavyResources?.snapshot(),
                          recordFailed:window.SentlogRecords?.failed,recordIssues:window.SentlogRecords?.issues})""")
                except Exception as diagnostic_error:
                    report['diagnosticError'] = str(diagnostic_error)
                save_report()
                raise
            finally:
                context.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()

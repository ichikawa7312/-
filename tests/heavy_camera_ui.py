"""Heavy camera use against the complete production app and native IndexedDB.

The old library deliberately uses small fixtures to stress its 5,000 metadata
entries. Forty new, distinct 12 MP frames exercise real JPEG conversion and
large Blob storage. Hardware and external services are synthetic; app capture,
save, record attachment, drawing UI, browser storage and reload are real.
Run only in the browser CI environment, not a managed local application host.
"""
import argparse
import base64
import functools
import hashlib
import io
import json
import random
import statistics
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import expect, sync_playwright

from continuous_camera_ui import CAMERA_MOCK, camera_count, open_camera, saved_photo_ids
from field_record_memo_ui import SETUP, photo_png
from photo_save_performance_ui import SEED, TRACE

ROOT = Path(__file__).resolve().parents[1]
WORKLOAD = dict(name='heavy', records=2000, originals=5000, selectedPhotos=40)
SHOT_COUNT = 40
BURST_EXTRAS = 20
COLORS = [(220, 30, 30), (30, 190, 60), (40, 80, 220), (230, 190, 20)]


def textured_base():
    rng = random.Random(20261121)
    tile = Image.frombytes('L', (256, 256), rng.randbytes(256*256)).convert('RGB')
    image = Image.new('RGB', (3000, 4000))
    for y in range(0, image.height, tile.height):
        for x in range(0, image.width, tile.width):
            image.paste(tile, (x, y))
    return image


def camera_frame(base, number, landscape):
    image = base.transpose(Image.Transpose.ROTATE_90) if landscape else base.copy()
    width, height = image.size
    draw = ImageDraw.Draw(image)
    for box, color in zip(((0, 0, width//3, height//3), (2*width//3, 0, width, height//3),
                           (2*width//3, 2*height//3, width, height), (0, 2*height//3, width//3, height)), COLORS):
        draw.rectangle(box, fill=color)
    # A distinct center marker makes repeating a stale frame detectable even
    # if it receives a new photo ID. Keep it far from the orientation samples.
    marker = ((number*47) % 220+20, (number*71) % 220+20, (number*97) % 220+20)
    draw.rectangle((width*2//5, height*2//5, width*3//5, height*3//5), fill=marker)
    output = io.BytesIO()
    image.save(output, format='PNG')
    image.close()
    return output.getvalue(), width, height, marker


PREPARE_NATIVE = r"""async()=>{
  // SETUP uses a read fixture only while seeding. Materialize all its files and
  // empty it, so subsequent reads and every reload use native IndexedDB.
  for(const [key,blob]of memoFixture.files)await SentlogRecords.writeFile(key,blob);
  memoFixture.files.clear();await SentlogRecords.settled();
  const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const metadata=await SentlogOriginalPhotos.listMeta();
  const readKeys=()=>new Promise((resolve,reject)=>{
    const q=indexedDB.open('sentlog-original-photos-v1');q.onerror=()=>reject(q.error);
    q.onsuccess=()=>{const db=q.result,tx=db.transaction('photos','readonly'),r=tx.objectStore('photos').getAllKeys();
      tx.oncomplete=()=>{db.close();resolve(r.result);};tx.onabort=()=>{db.close();reject(tx.error);};};
  });
  const drawing=JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a')));
  return {metadataSha256:await hash(metadata),originalKeysSha256:await hash(await readKeys()),
    untouchedRecordsSha256:await hash(drawing.shapes.filter(r=>r.id!=='survey-a')),
    otherDrawingShapes:JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-b'))).shapes,
    historicalBytes:metadata.reduce((sum,row)=>sum+row.size,0),
    seededSharedBytes:memoFixture.photo.size*40};
}"""


RESOURCES = r"""()=>{
  const live=new Set(),canvases=new Set();
  const resources=window.heavyResources={hiddenFits:0,hold:null,close:null};
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  URL.createObjectURL=function(...args){const url=create.apply(this,args);live.add(url);return url;};
  URL.revokeObjectURL=function(url){live.delete(url);return revoke.call(this,url);};
  const toBlob=HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob=function(...args){canvases.add(this);return toBlob.apply(this,args);};
  const oldFit=fit;fit=function(...args){if(SentlogContinuousCamera.isOpen())resources.hiddenFits++;return oldFit.apply(this,args);};
  const convert=SentlogOriginalPhotos.makeSharedPhoto;
  SentlogOriginalPhotos.makeSharedPhoto=async function(...args){
    if(resources.hold){const hold=resources.hold;resources.hold=null;hold.entered=true;await hold.promise;}
    return convert.apply(this,args);
  };
  resources.pauseNext=()=>{let release;const hold={entered:false,promise:new Promise(resolve=>release=resolve),release:()=>release()};
    resources.pendingHold=resources.hold=hold;};
  resources.release=()=>resources.pendingHold.release();
  resources.snapshot=()=>({liveObjectUrls:live.size,encodedCanvases:canvases.size,
    unreleasedEncodedCanvases:[...canvases].filter(c=>c.width*c.height>1).map(c=>[c.width,c.height]),
    hiddenFits:resources.hiddenFits,activeTracks:cameraMock.tracks.filter(t=>t.readyState==='live').length,
    enabledTracks:cameraMock.tracks.filter(t=>t.readyState==='live'&&t.enabled).length,
    imageFrontCanvases:document.querySelectorAll('.sentlog-image-detail').length,
    imageFrontPixels:[...document.querySelectorAll('.sentlog-image-detail')].reduce((s,c)=>s+c.width*c.height,0)});
  resources.armClose=expected=>{
    resources.close?.cleanup();const state=resources.close={expected,click:null,hidden:null,ready:null};
    const modal=document.getElementById('sentlogContinuousCamera');
    const check=()=>{
      if(!modal.hidden||state.click===null)return;
      if(state.hidden===null)state.hidden=performance.now();
      if(photoPerformance.thumbnailsReadyState(expected).ready&&state.ready===null)state.ready=performance.now();
    };
    const click=e=>{if(e.target.closest?.('#slCameraDone'))state.click=performance.now();};
    const observer=new MutationObserver(check);observer.observe(modal,{attributes:true,attributeFilter:['hidden']});
    const images=new MutationObserver(check);images.observe(document.getElementById('photoGrid'),{subtree:true,childList:true,attributes:true});
    document.addEventListener('click',click,true);document.addEventListener('load',check,true);
    state.cleanup=()=>{observer.disconnect();images.disconnect();document.removeEventListener('click',click,true);document.removeEventListener('load',check,true);};
  };
  resources.closeResult=()=>{const c=resources.close;const result={clickToHiddenMs:c.hidden-c.click,
    clickToThumbnailsReadyMs:c.ready-c.click,driverObservationLagMs:performance.now()-c.ready};c.cleanup();return result;};
}"""


VERIFY_PHOTO = r"""async ({id,width,height,marker,checkPixels})=>{
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  const did='memo-plan-a',key=drawingStorageKey(did),durable=await getDBFile('__sentlog_record__:'+key);
  if(durable!==SentlogRecords.getItem(key))throw Error('Record mirror differs from native durable storage');
  const drawing=JSON.parse(durable),record=drawing.shapes.find(r=>r.id==='survey-a');
  const entry=record.photos.find(photo=>photo.id===id),meta=(await SentlogOriginalPhotos.listMeta(did)).find(row=>row.photoId===id);
  if(!entry||meta?.photoAssociation?.status!=='attached'||meta.photoAssociation.target.recordId!=='survey-a'||
      meta.photoAssociation.target.drawingId!==did)throw Error('Captured photo attached to wrong record/drawing');
  const original=await SentlogOriginalPhotos.getOriginal(did,id),shared=await getPhotoBlob(id,did);
  if(!(original instanceof Blob)||!original.size||!(shared instanceof Blob)||!shared.size)throw Error('Native photo bytes missing');
  const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))]
    .map(v=>v.toString(16).padStart(2,'0')).join('');
  const originalHash=await hash(original),sharedHash=await hash(shared);
  if(sharedHash!==entry.sha256)throw Error('Shared bytes differ from durable record hash');
  const pixels=async blob=>{
    const url=URL.createObjectURL(blob),image=new Image();image.src=url;
    try{await image.decode();const canvas=document.createElement('canvas');canvas.width=5;canvas.height=1;
      try{const context=canvas.getContext('2d');
        const points=[[.25,.25],[.75,.25],[.75,.75],[.25,.75],[.5,.5]];
        for(let i=0;i<points.length;i++){const [x,y]=points[i];context.drawImage(image,
          Math.floor(image.naturalWidth*x),Math.floor(image.naturalHeight*y),1,1,i,0,1,1);}
        return {width:image.naturalWidth,height:image.naturalHeight,
          samples:points.map((_,i)=>[...context.getImageData(i,0,1,1).data].slice(0,3))};
      }finally{canvas.width=1;canvas.height=1;}
    }finally{image.src='';URL.revokeObjectURL(url);}
  };
  let originalPixels=null,sharedPixels=null;
  if(checkPixels){originalPixels=await pixels(original);sharedPixels=await pixels(shared);
    if(originalPixels.width!==width||originalPixels.height!==height)throw Error('Original dimensions changed');
    const ratio=Math.min(1,1600/Math.max(width,height));
    if(sharedPixels.width!==Math.round(width*ratio)||sharedPixels.height!==Math.round(height*ratio))throw Error('Shared dimensions changed');
    const expected=[[220,30,30],[30,190,60],[40,80,220],[230,190,20],marker];
    for(const p of [originalPixels,sharedPixels])for(let i=0;i<expected.length;i++)
      if(expected[i].some((v,c)=>Math.abs(v-p.samples[i][c])>35))throw Error('Orientation or frame marker changed: '+JSON.stringify(p));
  }
  return {id,originalSha256:originalHash,sharedSha256:sharedHash,originalBytes:original.size,sharedBytes:shared.size,
    originalPixels,sharedPixels,width,height,marker};
}"""


VERIFY_LIBRARY = r"""async ({baseline,proofs})=>{
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const all=await SentlogOriginalPhotos.listMeta(),newIds=new Set(proofs.map(p=>p.id)),old=all.filter(row=>!newIds.has(row.photoId));
  if(all.length!==5000+proofs.length||await hash(old)!==baseline.metadataSha256)throw Error('Historical original metadata changed');
  const keys=await new Promise((resolve,reject)=>{const q=indexedDB.open('sentlog-original-photos-v1');q.onerror=()=>reject(q.error);
    q.onsuccess=()=>{const db=q.result,tx=db.transaction('photos','readonly'),r=tx.objectStore('photos').getAllKeys();
      tx.oncomplete=()=>{db.close();resolve(r.result);};tx.onabort=()=>{db.close();reject(tx.error);};};});
  const addedKeys=new Set(proofs.map(p=>'memo-plan-a:'+p.id));
  if(keys.length!==5000+proofs.length||await hash(keys.filter(k=>!addedKeys.has(k)))!==baseline.originalKeysSha256)
    throw Error('Historical original keys changed');
  const key=drawingStorageKey('memo-plan-a'),raw=await getDBFile('__sentlog_record__:'+key);
  if(raw!==SentlogRecords.getItem(key))throw Error('Durable drawing readback mismatch');
  const drawing=JSON.parse(raw),record=drawing.shapes.find(r=>r.id==='survey-a'),ids=record.photos.map(p=>p.id);
  if(drawing.shapes.length!==2000||await hash(drawing.shapes.filter(r=>r.id!=='survey-a'))!==baseline.untouchedRecordsSha256)
    throw Error('Unrelated records/history changed');
  if(ids.length!==40+proofs.length||new Set(ids).size!==ids.length||proofs.some(p=>!ids.includes(p.id))||
      Array.from({length:40},(_,i)=>'retained-'+i).some(id=>!ids.includes(id)))throw Error('Missing/duplicated photo attachment');
  const other=JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-b'))).shapes;
  if(JSON.stringify(other)!==JSON.stringify(baseline.otherDrawingShapes))throw Error('Other drawing record changed');
  if((await SentlogCollaborationPhotos.listPending()).length)throw Error('Capture work remains pending');
  return {records:drawing.shapes.length,originals:all.length,selectedPhotos:ids.length,pendingPhotos:0,
    historicalMetadataUnchanged:true,historicalKeysUnchanged:true,unrelatedRecordsUnchanged:true};
}"""


def stats(values):
    values = sorted(values)
    return dict(count=len(values), medianMs=round(statistics.median(values), 2),
                p95Ms=round(values[max(0, (95*len(values)+99)//100-1)], 2), maxMs=round(max(values), 2))


def open_drawing(page, drawing='memo-plan-a'):
    page.evaluate("""async id=>{await openDrawing('memo-project',id);SentlogFieldRecords.selectRecord('survey-a');
      $('inspector').classList.add('open');await SentlogRecords.settled();}""", drawing)


def reveal_first_photo(page):
    # The camera's completion refresh can replace photo cards while Playwright
    # waits for an old card to become stable. The grid itself is permanent:
    # find and scroll its current first child within one synchronous operation.
    page.locator('#photoGrid').evaluate("""grid=>{
      const first=grid.firstElementChild;
      if(!first||!first.classList.contains('photo-thumb'))throw Error('Expected a photo preview to reveal');
      first.scrollIntoView({block:'nearest'});
    }""")


def boot_page(context, origin, errors):
    page = context.pages[0] if context.pages else context.new_page()
    page.set_default_timeout(30000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(origin+'/sentlog/', wait_until='domcontentloaded')
    page.wait_for_function('window.sentlogAppReady&&window.SentlogContinuousCamera&&window.SentlogCollaborationPhotos', timeout=60000)
    page.evaluate('window.sentlogAppReady')
    return page


def verify_retained(page, proofs):
    for proof in proofs:
        found = page.evaluate(VERIFY_PHOTO, {**proof, 'checkPixels': True})
        assert found['originalSha256'] == proof['originalSha256'], ('Original changed after reload', proof['id'])
        assert found['sharedSha256'] == proof['sharedSha256'], ('Shared photo changed after reload', proof['id'])


def run(playwright, engine, root, report, report_path=None):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    errors, proofs, captures, closes, snapshots = [], [], [], [], []
    report.update(proofs=proofs, shots=captures, closes=closes, resources=snapshots)

    def checkpoint():
        report.update(acceptedCaptures=len(proofs), totalNewOriginalBytes=sum(p['originalBytes'] for p in proofs),
                      totalNewSharedBytes=sum(p['sharedBytes'] for p in proofs))
        if report_path:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    base = textured_base()
    try:
        with tempfile.TemporaryDirectory(prefix='sentlog-heavy-camera-') as profile:
            def launch():
                context = getattr(playwright, engine).launch_persistent_context(profile, headless=True,
                    viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True, service_workers='block')
                def route(request):
                    if request.request.url.startswith((origin+'/', 'blob:', 'data:')):
                        request.continue_()
                    elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                        request.fulfill(content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
                    else:
                        request.abort()
                context.route('**/*', route)
                return context

            context = launch()
            try:
                page = boot_page(context, origin, errors)
                page.evaluate(SETUP, base64.b64encode(photo_png()).decode('ascii'))
                seeded = page.evaluate(SEED, WORKLOAD)
                assert seeded['records'] == 2000 and seeded['originals'] == 5000, seeded
                # Let each seeded legacy record receive its normal first-open
                # normalization before taking the unchanged-record baseline.
                open_drawing(page, 'memo-plan-b')
                open_drawing(page)
                baseline = page.evaluate(PREPARE_NATIVE)
                report['seed'] = {**WORKLOAD, 'historicalOriginalBytes': baseline['historicalBytes'],
                                  'historicalFixtureKind': 'small PNG fixtures, not 5000 full-resolution photographs'}
                first, _, _, _ = camera_frame(base, 0, False)
                page.evaluate(CAMERA_MOCK, base64.b64encode(first).decode('ascii'))
                page.evaluate('cameraMock.imageReady')
                page.evaluate("""()=>{
                  Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15'});
                  Object.defineProperty(navigator,'platform',{configurable:true,value:'iPhone'});
                  Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,value:5});
                }""")
                page.evaluate(TRACE)
                page.evaluate(RESOURCES)
                for number in range(1, SHOT_COUNT+1):
                    landscape = number % 2 == 0
                    frame, width, height, marker = camera_frame(base, number, landscape)
                    page.evaluate('fixture=>cameraMock.setFrame(fixture)', dict(encoded=base64.b64encode(frame).decode('ascii'), width=width, height=height))
                    if number % 10 == 1:
                        open_camera(page)
                    expect(page.locator('#slCameraShutter')).to_be_enabled()
                    page.set_viewport_size({'width': 844, 'height': 390} if landscape else {'width': 390, 'height': 844})
                    page.evaluate("window.dispatchEvent(new Event('orientationchange'))")
                    before = saved_photo_ids(page, 'memo-plan-a')
                    ending = number % 10 == 0
                    if ending:
                        page.evaluate('heavyResources.pauseNext();heavyResources.armClose('+str(40+number)+')')
                    page.evaluate('label=>photoPerformance.start(label)', 'heavy-shot-'+str(number))
                    page.locator('#slCameraShutter').evaluate('button=>{for(let i=0;i<21;i++)button.click();}')
                    if ending:
                        page.wait_for_function('heavyResources.pendingHold.entered')
                        page.locator('#slCameraDone').click()
                        expect(page.locator('#sentlogContinuousCamera')).to_be_visible()
                        expect(page.locator('#slCameraDone')).to_be_disabled()
                        assert page.evaluate('SentlogContinuousCamera.isOpen()'), 'Done discarded a save still in flight'
                        page.evaluate('heavyResources.release()')
                        page.wait_for_function('!SentlogContinuousCamera.isOpen()')
                        reveal_first_photo(page)
                        page.wait_for_function('heavyResources.close.ready!==null')
                        closes.append(page.evaluate('heavyResources.closeResult()'))
                    else:
                        camera_count(page, (number-1) % 10+1)
                    trace = page.evaluate('photoPerformance.stop()')
                    trace['finishDuringSave'] = ending
                    captures.append(trace)
                    after = saved_photo_ids(page, 'memo-plan-a')
                    added = set(after)-set(before)
                    assert len(added) == 1 and len(after) == len(before)+1 and set(before) <= set(after), (number, len(added), len(after))
                    proof = page.evaluate(VERIFY_PHOTO, dict(id=added.pop(), width=width, height=height, marker=marker, checkPixels=True))
                    assert proof['originalSha256'] not in {p['originalSha256'] for p in proofs}, 'Distinct frames reused stale captured bytes'
                    proofs.append(proof)
                    assert not trace['idbErrors'], trace
                    scan = trace['idb'].get('sentlog-original-photos-v1/meta/getAll', {})
                    assert scan.get('unboundedCalls', 0) == 0, scan
                    assert scan.get('boundedCalls') == 1 and scan.get('rows') == len(before), scan
                    assert trace['maxCanvasPixels'] == 12000000, trace
                    # Original and shared-photo capture must still encode once
                    # each. Only closing the camera may additionally encode
                    # small, visible display previews; these never enter storage.
                    encoded = {}
                    for name, stage in trace['stages'].items():
                        if name.startswith('canvas.toBlob.'):
                            dimensions = tuple(map(int, name.removeprefix('canvas.toBlob.').split('x')))
                            encoded[dimensions] = stage['calls']
                    ratio = 1600 / max(width, height)
                    capture_sizes = {(width, height), (round(width*ratio), round(height*ratio))}
                    assert all(encoded.get(size) == 1 for size in capture_sizes), (capture_sizes, encoded)
                    preview_encodes = sum(calls for size, calls in encoded.items() if size not in capture_sizes)
                    assert all(max(size) <= 384 for size in encoded if size not in capture_sizes), encoded
                    assert trace['canvasEncodes'] == 2 + preview_encodes, trace
                    trace['captureEncodes'] = 2
                    trace['visiblePreviewEncodes'] = preview_encodes
                    if not ending:
                        assert preview_encodes == 0, 'Photo previews ran behind the open camera'
                        assert trace['renderCalls'] == trace['photoListRenders'] == 0, trace
                    resources = page.evaluate('heavyResources.snapshot()')
                    assert not resources['unreleasedEncodedCanvases'] and resources['hiddenFits'] == 0, resources
                    assert resources['activeTracks'] <= 1 and resources['imageFrontCanvases'] <= 1, resources
                    assert resources['imageFrontPixels'] <= 1500000, resources
                    assert resources['liveObjectUrls'] <= 40+number+12, resources
                    if ending:
                        assert resources['enabledTracks'] == 0, resources
                        snapshots.append(dict(shot=number, **resources))
                        page.screenshot(path=f'/tmp/sentlog-heavy-camera-{engine}-session-{number//10}.png')
                        # Reopening the same drawing must reuse its disabled
                        # stream. Navigation afterward must fully release it.
                        calls = page.evaluate('cameraMock.calls')
                        for _ in range(3):
                            open_camera(page)
                            expect(page.locator('#slCameraShutter')).to_be_enabled()
                            page.locator('#slCameraDone').click()
                            page.wait_for_function('!SentlogContinuousCamera.isOpen()')
                            reveal_first_photo(page)
                            page.wait_for_function('count=>photoPerformance.thumbnailsReadyState(count).ready', arg=40+number)
                        assert page.evaluate('cameraMock.calls') == calls, 'Plain reopen repeatedly requested camera access'
                        reopened = page.evaluate('heavyResources.snapshot()')
                        assert reopened['liveObjectUrls'] <= 40+number+12 and reopened['activeTracks'] <= 1, reopened
                        assert reopened['imageFrontCanvases'] <= 1 and not reopened['unreleasedEncodedCanvases'], reopened
                        if number != SHOT_COUNT:
                            open_drawing(page, 'memo-plan-b')
                            assert page.evaluate("cameraMock.tracks.every(t=>t.readyState==='ended')"), 'Navigation retained camera hardware'
                            open_drawing(page)
                        print('HEAVY_CAMERA_PROGRESS '+json.dumps(dict(engine=engine, saved=number, expected=SHOT_COUNT,
                            latestSaveMs=round(trace['elapsedMs'], 2), originalBytes=sum(p['originalBytes'] for p in proofs))), flush=True)
                        checkpoint()

                assert page.evaluate('cameraMock.canvasPhotos') == SHOT_COUNT
                assert page.evaluate('cameraMock.photos') == 0
                report['beforeReload'] = page.evaluate(VERIFY_LIBRARY, dict(baseline=baseline, proofs=proofs))
                page.evaluate("window.dispatchEvent(new Event('pagehide'))")
                assert page.evaluate("cameraMock.tracks.every(t=>t.readyState==='ended')")
                page.reload(wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogAppReady&&window.SentlogContinuousCamera&&window.SentlogCollaborationPhotos', timeout=60000)
                page.evaluate('window.sentlogAppReady')
                open_drawing(page)
                report['afterReload'] = page.evaluate(VERIFY_LIBRARY, dict(baseline=baseline, proofs=proofs))
                verify_retained(page, proofs)
            except Exception:
                try:
                    page.screenshot(path=f'/tmp/sentlog-heavy-camera-{engine}-failure.png')
                    print('HEAVY_CAMERA_FAILURE', json.dumps(page.evaluate("""async()=>({open:window.SentlogContinuousCamera?.isOpen(),
                      status:document.getElementById('slCameraStatus')?.textContent,
                      resources:window.heavyResources?.snapshot(),pending:await window.SentlogCollaborationPhotos?.listPending()})"""), default=str), flush=True)
                except Exception:
                    pass
                raise
            finally:
                context.close()

            # A completely new browser process reads the same persistent
            # profile. Neither seed nor in-memory fixture is reinstalled.
            context = launch()
            try:
                page = boot_page(context, origin, errors)
                open_drawing(page)
                report['afterBrowserRestart'] = page.evaluate(VERIFY_LIBRARY, dict(baseline=baseline, proofs=proofs))
                verify_retained(page, proofs)
            finally:
                context.close()
            assert not errors, errors
            report.update(dict(extraShutterPresses=SHOT_COUNT*BURST_EXTRAS, acceptedCaptures=SHOT_COUNT,
                viewportChanges=SHOT_COUNT-1, orientationNotifications=SHOT_COUNT, ordinaryReopens=12,
                totalNewOriginalBytes=sum(p['originalBytes'] for p in proofs),
                totalNewSharedBytes=sum(p['sharedBytes'] for p in proofs),
                saveTiming=stats([s['elapsedMs'] for s in captures if not s['finishDuringSave']]),
                finishingSaveTiming=stats([s['elapsedMs'] for s in captures if s['finishDuringSave']]),
                closeTiming=stats([s['clickToThumbnailsReadyMs'] for s in closes])))
    finally:
        checkpoint()
        base.close()
        server.shutdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    report = dict(engine=args.engine, capturePixels=12000000,
        scope=dict(nativeStorage=['records', 'all original photos', 'all shared photos', 'drawing backgrounds'],
                   synthetic=['camera hardware', 'external service availability'], deltaBindingActive=False,
                   timing='Advisory headless browser measurements, not physical iPhone measurements. Ordinary save includes driver waits. The four finishing saves include an intentional conversion hold and are reported separately. Close starts while that hold is active, uses browser DOM/image events and reports observation lag separately.'))
    started = time.monotonic()
    try:
        with sync_playwright() as playwright:
            run(playwright, args.engine, args.built_root.resolve(), report, args.report)
        report['passed'] = True
    except Exception as error:
        report.update(passed=False, error=str(error))
        raise
    finally:
        report['elapsedSeconds'] = round(time.monotonic()-started, 2)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS '+args.engine+': 2000 records, 5000 historical originals, 40 distinct 12 MP captures, '
          '800 extra presses, rotation/finish/reopen and native reload/restart preserve exact original/shared bytes; '
          'capture canvases are released and hidden drawing work stays bounded', flush=True)
    print('HEAVY_CAMERA_SUMMARY '+json.dumps({key:report[key] for key in ('engine', 'acceptedCaptures',
        'totalNewOriginalBytes', 'totalNewSharedBytes', 'saveTiming', 'closeTiming', 'elapsedSeconds')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()

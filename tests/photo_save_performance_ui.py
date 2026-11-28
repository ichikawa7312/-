"""Compare complete built baseline/candidate apps on the same browser runner.

Camera hardware and network are synthetic. Seeded drawing backgrounds and old
shared thumbnails are supplied by SETUP's memory map. Fresh shared photos and
all original photos use native IndexedDB; their writes/readback, JPEG encoding,
decoding, capture journal, record attachment, rendering and camera UI execute
production code. Persistent profiles retain the native WebKit Blob path.

This isolates photo/UI costs on an offline legacy project. Delta binding/GC
scaling has its own regression and is not inferred from this workload. Wall
times are diagnostic only. Durable records, original hashes and photo IDs are
asserted; request/row/byte counts provide hardware-independent work evidence.
Closing the camera is measured separately, including the final visible
thumbnail refresh, so deferred repaint work remains visible in the report.
Both versions must retain every photo placeholder in order. Readiness requires
decoded previews inside the actual viewport/scroll clips; it does not force
the candidate's offscreen placeholders to decode their full-size source.
"""
import argparse
import base64
import functools
import io
import json
import statistics
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import expect, sync_playwright

from continuous_camera_ui import CAMERA_MOCK, camera_count, open_camera, saved_photo_ids, shutter
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 2160, 3840
WORKLOADS = [dict(name='small', records=20, originals=0, selectedPhotos=0),
             dict(name='established', records=400, originals=2000, selectedPhotos=20)]


def camera_image():
    # A textured image makes JPEG work and bytes more representative than the
    # existing flat 32x32 UI fixture. Both versions receive these exact bytes.
    noise = Image.effect_noise((WIDTH, HEIGHT), 22).convert('RGB')
    draw = ImageDraw.Draw(noise)
    for y in range(80, HEIGHT, 320):
        draw.line([(80, y), (WIDTH-80, y+80)], fill=(240, 235, 220), width=9)
        draw.rectangle((120, y+100, 360, y+200), outline=(40, 70, 90), width=7)
    output = io.BytesIO()
    noise.save(output, format='PNG')
    return output.getvalue()


SEED = r"""async workload=>{
  await SentlogOriginalPhotos.listMeta();
  const did='memo-plan-a', base=structuredClone(state.shapes.find(r=>r.id==='survey-a'));
  const shapes=[];
  for(let i=0;i<workload.records;i++){
    const record={...structuredClone(base),id:i?'perf-record-'+i:'survey-a',recordNo:i+1,typeNo:i+1,
      globalNo:i+1,autoLabel:'調査-'+(i+1),memo:'調査記録 '+i+'：位置・寸法・写真を確認。',photos:[],
      point:{x:50+(i%20)*50,y:50+Math.floor(i/20)*30}};
    record.points=[{...record.point},{...record.point}];delete record.collab;
    shapes.push(record);
  }
  const oldPhotos=[];
  for(let i=0;i<workload.selectedPhotos;i++){
    const id='retained-'+i;oldPhotos.push({id,name:id+'.png',createdAt:1000+i,
      type:'image/png',size:memoFixture.photo.size});
    memoFixture.files.set(photoDBKey(id,did),memoFixture.photo);
  }
  shapes[0].photos=oldPhotos;
  const raw=JSON.parse(SentlogRecords.getItem(drawingStorageKey(did)));
  raw.shapes=shapes.map(record=>SentlogRecordCollaboration.upgrade(record));
  SentlogRecords.setItem(drawingStorageKey(did),JSON.stringify(raw));
  await SentlogRecords.settled();
  await new Promise((resolve,reject)=>{
    const request=indexedDB.open('sentlog-original-photos-v1');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction(['photos','meta'],'readwrite');
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};
      for(let i=0;i<workload.originals;i++){
        const selected=i<workload.selectedPhotos,photoId=selected?'retained-'+i:'old-photo-'+i;
        const drawingId=selected?did:'history-drawing-'+Math.floor(i/100),projectId=selected?memoFixture.pid:'history-project';
        const target={projectId,drawingId,recordId:selected?'survey-a':'old-record-'+i,ownerId:'',
          projectName:'既存案件',drawingName:'図面',recordLabel:'調査-'+i};
        const key=drawingId+':'+photoId,association={version:1,operationId:'old-operation-'+i,photoId,
          inputId:'photoInput',index:0,target,storageDrawingId:drawingId,at:1000+i,updatedAt:1000+i,
          status:'attached',originalSaved:true,exportName:photoId+'.png',originalName:photoId+'.png',
          sourceSize:memoFixture.photo.size,sourceType:'image/png'};
        const meta={key,drawingId,photoId,projectId,projectName:'既存案件',drawingName:'図面',
          shapeId:target.recordId,shapeLabel:target.recordLabel,exportName:photoId+'.png',originalName:photoId+'.png',
          size:memoFixture.photo.size,type:'image/png',createdAt:1000+i,storedAt:1000+i,
          exportedAt:null,lastModified:1000+i,photoAssociation:association};
        tx.objectStore('photos').put(memoFixture.photo,key);tx.objectStore('meta').put(meta);
      }
    };
  });
  await openDrawing(memoFixture.pid,did);SentlogFieldRecords.selectRecord('survey-a');
  $('inspector').classList.add('open');await SentlogRecords.settled();
  await SentlogCollaborationPhotos.listPending();
  const untouched=JSON.parse(SentlogRecords.getItem(drawingStorageKey(did))).shapes.filter(r=>r.id!=='survey-a');
  return {records:raw.shapes.length,originals:(await SentlogOriginalPhotos.listMeta()).length,
    otherRecordsJson:JSON.stringify(untouched),photoIds:oldPhotos.map(p=>p.id)};
}"""


TRACE = r"""()=>{
  let active=null,lastFrame=performance.now(),closeObserver=null,readyObserver=null,readyListener=null;
  const clearCloseObservers=()=>{
    closeObserver?.disconnect();closeObserver=null;readyObserver?.disconnect();readyObserver=null;
    if(readyListener){document.removeEventListener('load',readyListener,true);
      document.removeEventListener('transitionend',readyListener,true);}readyListener=null;
  };
  const closeMark=name=>{
    const phases=active?.closePhases;
    if(phases&&phases.offsetsMs[name]===null)phases.offsetsMs[name]=performance.now()-active.started;
  };
  document.addEventListener('click',event=>{
    if(active?.closePhases&&event.target.closest?.('#slCameraDone'))closeMark('click');
  },true);
  // Observe DOM geometry independently of the production thumbnail queue.
  // Playwright's isVisible() intentionally includes offscreen elements, so it
  // cannot distinguish a retained lazy placeholder from a visible preview.
  const inVisibleArea=element=>{
    const box=element.getBoundingClientRect();
    if(!element.isConnected||box.width<=0||box.height<=0)return false;
    let left=Math.max(0,box.left),top=Math.max(0,box.top),
      right=Math.min(innerWidth,box.right),bottom=Math.min(innerHeight,box.bottom);
    for(let node=element;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;
      const bounds=node.getBoundingClientRect();
      if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
      if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
    }
    return right>left&&bottom>top;
  };
  const thumbnailsReadyState=expected=>{
    const names=Array.isArray(expected)?expected.map(value=>typeof value==='string'?value:value.name):null;
    const count=names?names.length:expected,items=[...document.querySelectorAll('#photoGrid .photo-thumb')];
    const identitiesMatch=items.length===count&&items.every((item,index)=>{
      const image=item.querySelector('img');
      return !!image&&(!names||item.title===names[index]&&image.alt===names[index]);
    });
    const decoded=item=>{const image=item.querySelector('img');return !!image?.getAttribute('src')&&image.complete&&image.naturalWidth>0;};
    const visibleIndices=items.flatMap((item,index)=>inVisibleArea(item)?[index]:[]);
    const readyVisible=visibleIndices.filter(index=>decoded(items[index])).length;
    const offscreenLoaded=items.filter((item,index)=>!visibleIndices.includes(index)&&decoded(item)).length;
    return {ready:identitiesMatch&&(count===0||visibleIndices.length>0)&&readyVisible===visibleIndices.length,
      placeholders:items.length,identitiesMatch,visible:visibleIndices.length,readyVisible,
      offscreen:items.length-visibleIndices.length,offscreenLoaded,visibleIndices};
  };
  const summary=()=>({stages:{},idb:{},digests:{calls:0,bytes:0,ms:0},
    imageLoads:0,canvasEncodes:0,canvasEncodedPixels:0,maxCanvasPixels:0,
    drawCalls:0,renderCalls:0,photoListRenders:0,frameCount:0,maxFrameGapMs:0,
    longTasksSupported:PerformanceObserver.supportedEntryTypes?.includes('longtask')||false,
    longTaskCount:0,longTaskMs:0,maxLongTaskMs:0,cloneCalls:0,cutoffClones:0,idbErrors:[]});
  const stage=(name,ms)=>{if(!active)return;const s=active.stages[name]||={calls:0,ms:0,maxMs:0};
    s.calls++;s.ms+=ms;s.maxMs=Math.max(s.maxMs,ms);};
  const observe=(object,name,label)=>{
    if(typeof object?.[name]!=='function')return;
    const native=object[name];object[name]=function(...args){
      const started=performance.now(),scope=active;let result;
      try{result=native.apply(this,args);}catch(error){if(scope===active)stage(label,performance.now()-started);throw error;}
      const done=()=>{if(scope&&scope===active)stage(label,performance.now()-started);};
      if(result?.then)result.then(done,done);else done();return result;
    };
  };
  for(const method of ['stageOriginal','getOriginal','listMeta','getMeta','updatePhotoAssociation','makeSharedPhoto','refreshUI'])
    observe(SentlogOriginalPhotos,method,'originals.'+method);
  for(const method of ['settled','writeFile','batch'])observe(SentlogRecords,method,'records.'+method);
  observe(SentlogCollaborationPhotos,'register','photos.register');
  // Include forced-layout/focus time around camera close, outside render().
  observe(document.getElementById('stageWrap'),'getBoundingClientRect','ui.drawingRect');
  observe(HTMLElement.prototype,'focus','ui.focus');
  for(const [name,counter]of [['render','renderCalls'],['renderSelectedPhotos','photoListRenders']]){
    const native=window[name];if(typeof native!=='function')continue;
    window[name]=function(...args){
      const scope=active,started=performance.now();if(scope)scope[counter]++;
      const result=native.apply(this,args);
      if(scope&&scope===active)stage('ui.'+name+'.sync',performance.now()-started);
      if(result?.then)result.then(()=>{if(scope&&scope===active)stage('ui.'+name+'.elapsed',performance.now()-started);},()=>{});
      return result;
    };
  }
  const clone=window.structuredClone;
  window.structuredClone=function(value,...rest){if(active){active.cloneCalls++;if(value?.cutoff)active.cutoffClones++;}
    return clone.call(this,value,...rest);};
  const digest=SubtleCrypto.prototype.digest;
  SubtleCrypto.prototype.digest=function(algorithm,data){
    const started=performance.now(),scope=active,result=digest.call(this,algorithm,data);
    if(scope){scope.digests.calls++;scope.digests.bytes+=data?.byteLength||0;
      result.then(()=>{if(scope===active)scope.digests.ms+=performance.now()-started;},()=>{});}
    return result;
  };
  for(const [prototype,names] of [[IDBObjectStore.prototype,['get','getAll','put','add','openCursor']],
                                 [IDBIndex.prototype,['get','getAll','openCursor']]]){
    for(const name of names){
      const native=prototype[name];prototype[name]=function(...args){
        const scope=active,store=this.objectStore||this,key=store.transaction.db.name+'/'+store.name+'/'+
          (this.objectStore?'index:'+this.name+':':'')+name;
        const started=performance.now();let request;
        try{request=native.apply(this,args);}catch(error){if(scope)scope.idbErrors.push(error.name);throw error;}
        if(scope){const count=scope.idb[key]||={calls:0,rows:0,cutoffRows:0,unboundedCalls:0,boundedCalls:0,
          unboundedRows:0,boundedRows:0,ms:0};count.calls++;
          if(name==='getAll'||name==='openCursor')count[args[0]==null?'unboundedCalls':'boundedCalls']++;
          request.addEventListener('success',()=>{
            if(scope!==active)return;const value=request.result;
            const rows=Array.isArray(value)?value:value==null?[]:name==='openCursor'?[value.value]:[value];
            count.rows+=rows.length;count.cutoffRows+=rows.filter(row=>row?.kind==='cutoff-file').length;
            if(name==='getAll'||name==='openCursor')count[args[0]==null?'unboundedRows':'boundedRows']+=rows.length;
            count.ms+=performance.now()-started;
          });request.addEventListener('error',()=>scope.idbErrors.push(request.error?.name));}
        return request;
      };
    }
  }
  const encode=HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob=function(callback,...args){
    const scope=active,started=performance.now(),pixels=this.width*this.height,dimensions=this.width+'x'+this.height;
    if(scope){scope.canvasEncodes++;scope.canvasEncodedPixels+=pixels;scope.maxCanvasPixels=Math.max(scope.maxCanvasPixels,pixels);}
    return encode.call(this,blob=>{if(scope===active){const elapsed=performance.now()-started;
      stage('canvas.toBlob',elapsed);stage('canvas.toBlob.'+dimensions,elapsed);}callback(blob);},...args);
  };
  const draw=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(...args){
    const scope=active,started=performance.now();if(scope)scope.drawCalls++;
    const result=draw.apply(this,args);
    if(scope&&scope===active)stage('canvas.drawImage.'+(args[0] instanceof HTMLVideoElement?'video':'image'),performance.now()-started);
    return result;
  };
  const src=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  Object.defineProperty(HTMLImageElement.prototype,'src',{...src,set(value){if(active&&value)active.imageLoads++;return src.set.call(this,value);}});
  let longTasks=null;
  if(PerformanceObserver.supportedEntryTypes?.includes('longtask')){
    longTasks=new PerformanceObserver(list=>{if(active)for(const entry of list.getEntries()){
      active.longTaskCount++;active.longTaskMs+=entry.duration;active.maxLongTaskMs=Math.max(active.maxLongTaskMs,entry.duration);}});
    longTasks.observe({entryTypes:['longtask']});
  }
  function frame(at){if(active){active.frameCount++;active.maxFrameGapMs=Math.max(active.maxFrameGapMs,at-lastFrame);}
    lastFrame=at;requestAnimationFrame(frame);}
  requestAnimationFrame(frame);
  window.photoPerformance={
    thumbnailsReadyState,
    start(label,photoIds=[],photoNames=[]){
      clearCloseObservers();
      active={label,...summary(),started:performance.now()};lastFrame=performance.now();
      if(label.endsWith('-close')){
        active.closePhases={expectedPhotoIds:[...photoIds],offsetsMs:{click:null,modalHidden:null,thumbnailsAvailable:null,
          thumbnailsReady:null,stopCalled:null,stopped:null}};
        const scope=active,modal=document.getElementById('sentlogContinuousCamera');
        // Observe the same readiness condition in the browser's own image
        // events, independently of when the automation driver next polls it.
        const available=()=>{
          if(active!==scope||!modal.hidden||scope.closePhases.offsetsMs.modalHidden===null)return;
          if(thumbnailsReadyState(photoNames).ready){
            closeMark('thumbnailsAvailable');readyObserver?.disconnect();
            document.removeEventListener('load',available,true);
            document.removeEventListener('transitionend',available,true);
          }
        };
        readyListener=available;document.addEventListener('load',available,true);
        document.addEventListener('transitionend',available,true);
        readyObserver=new MutationObserver(available);
        readyObserver.observe(document.getElementById('photoGrid'),{
          childList:true,subtree:true,attributes:true,attributeFilter:['src','alt','title']});
        closeObserver=new MutationObserver(()=>{
          if(active===scope&&modal.hidden){closeMark('modalHidden');closeObserver.disconnect();available();}
        });
        closeObserver.observe(modal,{attributes:true,attributeFilter:['hidden']});
      }
    },
    thumbnailsReady(){readyListener?.();closeMark('thumbnailsReady');},
    async stop(){
      closeMark('stopCalled');
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const result=active;result.elapsedMs=performance.now()-result.started;
      if(result.closePhases){
        const times=result.closePhases.offsetsMs;times.stopped=result.elapsedMs;
        const delta=(end,start=0)=>end===null||start===null?null:end-start;
        result.closePhases.durationsMs={startToClick:delta(times.click),
          clickToModalHidden:delta(times.modalHidden,times.click),
          modalHiddenToThumbnails:delta(times.thumbnailsReady,times.modalHidden),
          modalHiddenToThumbnailsAvailable:delta(times.thumbnailsAvailable,times.modalHidden),
          thumbnailsAvailableToObserved:delta(times.thumbnailsReady,times.thumbnailsAvailable),
          thumbnailsToStopCall:delta(times.stopCalled,times.thumbnailsReady),
          stopFrameWait:delta(times.stopped,times.stopCalled)};
      }
      clearCloseObservers();delete result.started;active=null;
      return result;}
  };
}"""


SCOPED_METADATA = r"""async()=>{
  // Drawing IDs may contain a colon. A key-range neighbor can then share the
  // prefix, so the public API must also match the row's drawingId exactly.
  const did='perf:query:target',rows=[
    {drawingId:did,photoId:'own',exportName:'same.jpg',photoAssociation:{version:1}},
    {drawingId:did,photoId:'legacy',exportName:'legacy.jpg'},
    {drawingId:did+':child',photoId:'nested',exportName:'same.jpg'},
    {drawingId:did+'-neighbor',photoId:'similar',exportName:'same.jpg'},
    {drawingId:did+'2',photoId:'suffix',exportName:'same.jpg'}
  ].map(row=>({...row,key:row.drawingId+':'+row.photoId}));
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('sentlog-original-photos-v1');
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const change=remove=>new Promise((resolve,reject)=>{
    const tx=db.transaction('meta','readwrite'),store=tx.objectStore('meta');
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    for(const row of rows)remove?store.delete(row.key):store.put(row);
  });
  try{
    await change(false);
    const found=await SentlogOriginalPhotos.listMeta(did),ids=found.map(row=>row.photoId).sort();
    if(JSON.stringify(ids)!==JSON.stringify(['legacy','own']))throw Error('Scoped metadata includes another drawing or loses legacy metadata');
    const all=await SentlogOriginalPhotos.listMeta();
    if(rows.some(row=>!all.some(value=>value.key===row.key)))throw Error('Unscoped recovery must retain all drawing metadata');
    return {exactDrawing:true,colonAndPrefixNeighbors:true,legacyMetadata:true,unscopedRecovery:true};
  }finally{await change(true);db.close();}
}"""


VERIFY = r"""async ({before,expectedTotal})=>{
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  // SETUP intercepts background/old-photo keys only. This key falls through
  // to native IndexedDB, independently checking the synchronous record mirror.
  const key=drawingStorageKey('memo-plan-a'),stored=await getDBFile('__sentlog_record__:'+key);
  if(stored!==SentlogRecords.getItem(key))throw Error('Record mirror differs from durable storage');
  const drawing=JSON.parse(stored);
  const record=drawing.shapes.find(r=>r.id==='survey-a'),ids=record.photos.map(p=>p.id),added=ids.filter(id=>!before.includes(id));
  if(ids.length!==expectedTotal||new Set(ids).size!==ids.length||added.length!==1||before.some(id=>!ids.includes(id)))
    throw Error('Photo attachment mismatch');
  const photoId=added[0],original=await SentlogOriginalPhotos.getOriginal('memo-plan-a',photoId);
  const meta=(await SentlogOriginalPhotos.listMeta()).find(m=>m.photoId===photoId&&m.drawingId==='memo-plan-a');
  if(!(original instanceof Blob)||!original.size||meta?.photoAssociation?.status!=='attached')throw Error('Not durably attached');
  const shared=await getPhotoBlob(photoId,'memo-plan-a'),photo=record.photos.find(p=>p.id===photoId);
  const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))]
    .map(v=>v.toString(16).padStart(2,'0')).join('');
  if(!(shared instanceof Blob)||await hash(shared)!==photo.sha256)throw Error('Shared readback failed');
  const url=URL.createObjectURL(original),image=new Image();image.src=url;
  try{await image.decode();if(image.naturalWidth!==2160||image.naturalHeight!==3840)throw Error('Captured original resolution changed');}
  finally{image.src='';URL.revokeObjectURL(url);}
  return {photoId,originalSha256:await hash(original),originalBytes:original.size,sharedBytes:shared.size,
    nativeRecordReadback:true,nativeSharedReadback:true,ids};
}"""


def profile_case(playwright, engine, built_root, workload, encoded, shots, *, candidate=False):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(built_root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with tempfile.TemporaryDirectory(prefix='sentlog-photo-performance-') as profile:
            context = getattr(playwright, engine).launch_persistent_context(
                profile, headless=True, viewport={'width': 390, 'height': 844}, has_touch=True,
                is_mobile=True, service_workers='block')
            try:
                def route(request):
                    if request.request.url.startswith((origin+'/', 'blob:', 'data:')):
                        request.continue_()
                    elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                        request.fulfill(content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
                    else:
                        request.abort()

                context.route('**/*', route)
                page = context.pages[0] if context.pages else context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(origin+'/sentlog/', wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogAppReady&&window.SentlogContinuousCamera&&window.SentlogCollaborationPhotos', timeout=45000)
                page.evaluate(SETUP, base64.b64encode(photo_png()).decode('ascii'))
                seeded = page.evaluate(SEED, workload)
                assert seeded['originals'] == workload['originals'], seeded
                page.evaluate(CAMERA_MOCK, encoded)
                page.evaluate('cameraMock.imageReady')
                page.evaluate("""()=>{
                  Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15'});
                  Object.defineProperty(navigator,'platform',{configurable:true,value:'iPhone'});
                  Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,value:5});
                  cameraMock.width=2160;cameraMock.height=3840;
                }""")
                page.evaluate(TRACE)
                open_camera(page)
                expect(page.locator('#slCameraShutter')).to_be_enabled()
                results, proofs = [], []
                for index in range(shots):
                    before = saved_photo_ids(page, 'memo-plan-a')
                    page.evaluate('label=>photoPerformance.start(label)', workload['name']+'-'+str(index+1))
                    shutter(page)
                    camera_count(page, index+1)
                    result = page.evaluate('photoPerformance.stop()')
                    proof = page.evaluate(VERIFY, {'before': before, 'expectedTotal': len(before)+1})
                    assert not result['idbErrors'], result
                    assert result['canvasEncodes'] >= 2 and result['maxCanvasPixels'] == WIDTH*HEIGHT, result
                    assert result['digests']['calls'] >= 2, 'Trace must include generated and stored shared-photo hashes'
                    if candidate:
                        scan = result['idb']['sentlog-original-photos-v1/meta/getAll']
                        assert scan['unboundedCalls'] == 0 and scan['boundedCalls'] == 1, scan
                        assert scan['rows'] == workload['selectedPhotos']+index, scan
                        assert result['renderCalls'] == result['photoListRenders'] == 0, result
                        assert page.evaluate('SentlogContinuousCamera.isOpen()'), 'Deferred repaint requires the covering camera to remain open'
                    result['durableOriginalBytes'] = proof['originalBytes']
                    result['durableSharedBytes'] = proof['sharedBytes']
                    results.append(result);proofs.append(proof)
                photo_metadata = """()=>JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a')))
                  .shapes.find(row=>row.id==='survey-a').photos"""
                stored_metadata = page.evaluate(photo_metadata)
                stored_photos = [{'id': photo['id'], 'name': photo.get('name') or '変状写真'} for photo in stored_metadata]
                stored_ids = [photo['id'] for photo in stored_photos]
                visible_photos = stored_photos
                if candidate:
                    # v1.97 presents photos chronologically while retaining the
                    # collaboration store's canonical order. Derive the expected
                    # display from fixture/capture order, independently of the
                    # production ordering helper. The fixed baseline predates it.
                    display_ids = seeded['photoIds']+[proof['photoId'] for proof in proofs]
                    assert len(display_ids) == len(stored_ids) and set(display_ids) == set(stored_ids)
                    by_id = {photo['id']: photo for photo in stored_photos}
                    visible_photos = [by_id[photo_id] for photo_id in display_ids]
                page.evaluate('({label,photos})=>photoPerformance.start(label,photos.map(p=>p.id),photos.map(p=>p.name))',
                              {'label': workload['name']+'-close', 'photos': visible_photos})
                page.locator('#slCameraDone').click()
                page.wait_for_function('!SentlogContinuousCamera.isOpen()')
                page.wait_for_function("""expected=>{
                  const ready=photoPerformance.thumbnailsReadyState(expected).ready;
                  if(ready)photoPerformance.thumbnailsReady();
                  return ready;
                }""", arg=visible_photos)
                expect(page.locator('#photoGrid')).to_be_visible()
                close_result = page.evaluate('photoPerformance.stop()')
                readiness = page.evaluate('expected=>photoPerformance.thumbnailsReadyState(expected)', visible_photos)
                assert readiness['ready'] and readiness['identitiesMatch'], readiness
                assert readiness['placeholders'] == len(visible_photos), readiness
                assert readiness['visible'] == readiness['readyVisible'] > 0, readiness
                close_result['thumbnailReadiness'] = readiness
                close_result['visiblePreviewPhotoIds'] = [visible_photos[index]['id'] for index in readiness['visibleIndices']]
                assert not close_result['idbErrors'], close_result
                if candidate:
                    assert close_result['renderCalls'] == close_result['photoListRenders'] == 1, close_result
                assert saved_photo_ids(page, 'memo-plan-a') == stored_ids, 'Camera close changed the canonical stored photo order'
                assert page.evaluate(photo_metadata) == stored_metadata, 'Camera close changed stored photo metadata'
                close_result['visiblePhotoIds'] = [photo['id'] for photo in visible_photos]
                close_result['storedPhotoIds'] = stored_ids
                assert page.evaluate('SentlogCollaborationPhotos.listPending()') == []
                retained = page.evaluate("""async()=>({
                  originals:(await SentlogOriginalPhotos.listMeta()).length,
                  records:JSON.stringify(JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a')))
                    .shapes.filter(r=>r.id!=='survey-a'))
                })""")
                assert retained['originals'] == workload['originals']+shots, retained['originals']
                assert retained['records'] == seeded['otherRecordsJson'], 'Unrelated record/history changed while saving photos'
                # Reading/displaying subsequent shots must retain every original.
                for proof in proofs:
                    digest = page.evaluate("""async id=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',
                      await (await SentlogOriginalPhotos.getOriginal('memo-plan-a',id)).arrayBuffer()))]
                      .map(v=>v.toString(16).padStart(2,'0')).join('')""", proof['photoId'])
                    assert digest == proof['originalSha256']
                # Run boundary checks after timing so candidate-only query
                # validation does not warm the measured storage workload.
                scoped_proof = page.evaluate(SCOPED_METADATA) if candidate else None
                assert not errors, errors
                return {'workload': workload, 'shots': results, 'close': close_result,
                        'durableProofs': proofs, 'scopedMetadataProof': scoped_proof}
            finally:
                context.close()
    finally:
        server.shutdown()


def summarize(case):
    shots = case['shots']
    close = case['close']
    def scans(shot):
        return sum(value['rows'] for name, value in shot['idb'].items()
                   if name == 'sentlog-original-photos-v1/meta/getAll')
    return {'medianSaveMs': round(statistics.median(s['elapsedMs'] for s in shots), 2),
            'originalMetadataRows': sum(scans(s) for s in shots),
            'fullOriginalMetadataRows': sum(s['idb'].get('sentlog-original-photos-v1/meta/getAll', {}).get('unboundedRows', 0) for s in shots),
            'boundedOriginalMetadataRows': sum(s['idb'].get('sentlog-original-photos-v1/meta/getAll', {}).get('boundedRows', 0) for s in shots),
            'originalMetadataFullScans': sum(s['idb'].get('sentlog-original-photos-v1/meta/getAll', {}).get('unboundedCalls', 0) for s in shots),
            'originalMetadataBoundedScans': sum(s['idb'].get('sentlog-original-photos-v1/meta/getAll', {}).get('boundedCalls', 0) for s in shots),
            'digestCalls': sum(s['digests']['calls'] for s in shots),
            'digestBytes': sum(s['digests']['bytes'] for s in shots),
            'imageLoads': sum(s['imageLoads'] for s in shots),
            'renderCalls': sum(s['renderCalls'] for s in shots),
            'photoListRenders': sum(s['photoListRenders'] for s in shots),
            'maxFrameGapMs': round(max(s['maxFrameGapMs'] for s in shots), 2),
            'cameraCloseMs': round(close['elapsedMs'], 2),
            'closeRenderCalls': close['renderCalls'],
            'closePhotoListRenders': close['photoListRenders'],
            'closeImageLoads': close['imageLoads'],
            'closeThumbnailReadiness': close['thumbnailReadiness'],
            'closeDrawingRect': close['stages'].get('ui.drawingRect', {'calls': 0, 'ms': 0, 'maxMs': 0}),
            'closeFocus': close['stages'].get('ui.focus', {'calls': 0, 'ms': 0, 'maxMs': 0}),
            'closePhasesMs': close['closePhases']['durationsMs'],
            'closeMaxFrameGapMs': round(close['maxFrameGapMs'], 2),
            'captureAndCloseMs': round(sum(s['elapsedMs'] for s in shots)+close['elapsedMs'], 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--baseline-root', type=Path, required=True)
    parser.add_argument('--shots', type=int, default=2)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    assert 1 <= args.shots <= 3, 'Keep the diagnostic workload bounded'
    encoded = base64.b64encode(camera_image()).decode('ascii')
    report = {'engine': args.engine, 'capturePixels': [WIDTH, HEIGHT],
              'scope': {'nativeStorage': ['all original photos', 'fresh shared photos', 'records'],
                        'memoryFixtures': ['drawing backgrounds', 'preexisting shared thumbnails'],
                        'deltaBindingActive': False,
                        'thumbnailReadiness': 'Every photo placeholder and display identity/order, plus decoded previews clipped to the visible viewport; offscreen decoding is not required for either version',
                        'timing': 'Advisory headless-browser measurements including driver/UI wait overhead; not physical iPhone timings'},
              'results': {}, 'comparison': {}}
    with sync_playwright() as playwright:
        # Alternate order so all baseline work does not systematically receive
        # a cold runner while all candidate work receives a warmed runner.
        for index, workload in enumerate(WORKLOADS):
            versions = [('baseline', args.baseline_root), ('candidate', args.built_root)]
            if index % 2:
                versions.reverse()
            for version, root in versions:
                result = profile_case(playwright, args.engine, root.resolve(), workload, encoded, args.shots,
                                      candidate=version == 'candidate')
                report['results'].setdefault(version, {})[workload['name']] = result
                print('PHOTO_PERFORMANCE '+json.dumps({'engine': args.engine, 'version': version,
                      'workload': workload['name'], **summarize(result)}, ensure_ascii=False), flush=True)
    for workload in WORKLOADS:
        name = workload['name']
        report['comparison'][name] = {version: summarize(report['results'][version][name])
                                      for version in ('baseline', 'candidate')}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS '+args.engine+': baseline/candidate camera saves are durable, retain original resolution/bytes, '
          'and attach one unique photo per shot; work counts and frame/timing diagnostics recorded', flush=True)


if __name__ == '__main__':
    main()

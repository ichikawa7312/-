"""Real 93MP JPEG decoding plus repeated zoom/pan in Chromium and WebKit.
Synthetic pixels/records only; no production services, accounts or user files.
File transport is supplied in memory; IndexedDB receipt is covered separately.
Linux WebKit is an engine regression test, not a physical iPhone RAM test.
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import base64
import functools
import os
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as playwright:
        chrome_options = {'headless': True}
        if os.path.exists('/usr/bin/chromium'):
            chrome_options.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        # Encode a genuine raster JPEG in a separate process, then close the
        # producer before testing. SVG alone does not exercise raster decoding.
        producer = playwright.chromium.launch(**chrome_options)
        producer_page = producer.new_page()
        encoded = producer_page.evaluate("""async()=>{
            const c=document.createElement('canvas');c.width=11575;c.height=8031;
            const context=c.getContext('2d',{alpha:false});
            context.fillStyle='white';context.fillRect(0,0,c.width,c.height);
            context.fillStyle='red';context.fillRect(0,1000,5788,7031);
            context.fillStyle='blue';context.fillRect(5788,0,5787,8031);
            const blob=await new Promise(resolve=>c.toBlob(resolve,'image/jpeg',.9));
            if(!blob)throw Error('JPEG fixture generation failed');
            c.width=1;c.height=1;
            return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});
        }""")
        jpeg = base64.b64decode(encoded)
        producer.close()
        assert jpeg[:2] == b'\xff\xd8'

        for engine in ('chromium', 'webkit'):
            browser = (playwright.chromium.launch(**chrome_options) if engine == 'chromium'
                       else playwright.webkit.launch(headless=True))
            context = browser.new_context(viewport={'width': 390, 'height': 844},
                                          is_mobile=True, has_touch=True, device_scale_factor=3,
                                          user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
                                          service_workers='block')
            context.add_init_script("""
                window.memoryTest={afterReady:false,largeReadsAfterReady:0,createdAfterReady:0,toolbarMeasurements:0,canvasCallers:[],urlsAfterReady:0};
                const create=document.createElement.bind(document);
                document.createElement=function(tag,...args){
                    if(window.memoryTest.afterReady&&tag.toLowerCase()==='canvas'){
                        const caller=String(new Error().stack||'');
                        // The existing toolbar measures button text in a tiny
                        // canvas after a WebKit viewport resize. Track it apart
                        // from image-rendering allocations; do not hide unknowns.
                        if(!caller.includes('image-quality.js')&&caller.includes('toolbar-icons.js'))window.memoryTest.toolbarMeasurements++;
                        else {window.memoryTest.createdAfterReady++;window.memoryTest.canvasCallers.push(caller);}
                    }
                    return create(tag,...args);
                };
                const draw=CanvasRenderingContext2D.prototype.drawImage;
                CanvasRenderingContext2D.prototype.drawImage=function(source,...args){
                    if(window.memoryTest.afterReady&&source instanceof HTMLImageElement&&
                       source.naturalWidth*source.naturalHeight>16777216)window.memoryTest.largeReadsAfterReady++;
                    return draw.call(this,source,...args);
                };
                const makeUrl=URL.createObjectURL.bind(URL);
                URL.createObjectURL=function(...args){
                    if(window.memoryTest.afterReady)window.memoryTest.urlsAfterReady++;
                    return makeUrl(...args);
                };
            """)

            def route(request):
                url = request.request.url
                if url == origin + '/memory-fixture.jpg':
                    request.fulfill(status=200, content_type='image/jpeg', body=jpeg)
                elif url.startswith((origin + '/', 'blob:', 'data:')):
                    request.continue_()
                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request.fulfill(status=200, content_type='text/javascript',
                                    body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No PDF in memory fixture")}};')
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            errors = []
            messages = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda message: messages.append(message.text) if message.type in ('warning', 'error') else None)
            page.goto(origin + '/sentlog/', wait_until='domcontentloaded')
            page.wait_for_function("window.SENTLOG_BUILD==='v1.61'&&!!window.sentlogSyncView", timeout=18000)
            original = page.evaluate("""async()=>{
                await window.sentlogAppReady;
                const meta={id:'memory-drawing',name:'JPEG memory fixture',fileName:'large.jpg',sourceType:'image',pageCount:1};
                const project={id:'memory-project',name:'Memory fixture',drawings:[meta]};
                workspace={projects:[project]};
                window.SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(workspace));
                window.SentlogRecords.setItem(drawingStorageKey(meta.id),JSON.stringify({
                    ...freshDrawingState(project.name),sourceType:'image',fileName:'large.jpg',width:11575,height:8031,
                    shapes:[{id:'record',page:1,kind:'rect',type:'浮き',typeNo:1,globalNo:1,x:9000,y:5000,w:300,h:200,photos:[{id:'photo'}]}],
                    pageSettings:{'1':{paperSize:'A3',scaleDenom:100}}
                }));
                const blob=await(await fetch('/memory-fixture.jpg')).blob();
                const file=new File([await blob.arrayBuffer()],'large.jpg',{type:'image/jpeg'});
                // Keep transport outside this renderer memory regression. The
                // separate receipt test exercises real IndexedDB persistence;
                // Linux WebKit automation cannot reliably persist large Files.
                const originalRead=getBackgroundFile;
                getBackgroundFile=async function(id=activeDrawingId){
                    return id===meta.id?file:originalRead.apply(this,arguments);
                };
                await window.SentlogRecords.settled();await openDrawing(project.id,meta.id);
                return JSON.stringify({shapes:state.shapes,settings:state.pageSettings});
            }""")
            diagnostic = page.evaluate("""()=>({empty:empty.style.display,loading:loading.style.display,
                error:document.getElementById('errorBanner')?.textContent,hidden:document.hidden,
                dataset:{...document.getElementById('stageWrap').dataset},type:state.sourceType,
                activeDrawingId,canvas:[canvas.width,canvas.height]})""")
            if diagnostic['empty'] != 'none':
                probes = page.evaluate('''async()=>{
                    const file=await getBackgroundFile(),bytes=new Uint8Array(await file.arrayBuffer());
                    async function probe(src){
                        const image=new Image();
                        try{return await new Promise(resolve=>{
                            image.onload=()=>resolve({ok:true,width:image.naturalWidth,height:image.naturalHeight});
                            image.onerror=()=>resolve({ok:false});image.src=src;
                            setTimeout(()=>resolve({timeout:true}),10000);
                        });}finally{image.onload=null;image.onerror=null;image.src='';}
                    }
                    const blobUrl=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));
                    const fileUrl=URL.createObjectURL(file);
                    try{return {size:file.size,type:file.type,byteLength:bytes.length,head:Array.from(bytes.slice(0,4)),
                        network:await probe('/memory-fixture.jpg'),blob:await probe(blobUrl),file:await probe(fileUrl)};}
                    finally{URL.revokeObjectURL(blobUrl);URL.revokeObjectURL(fileUrl);}
                }''')
                print(f'IMAGE LOAD DIAGNOSTIC {engine}: {diagnostic} probes={probes} messages={messages} errors={errors}', flush=True)
            assert diagnostic['empty'] == 'none' and diagnostic['loading'] == 'none', (engine, diagnostic, messages, errors)
            page.bring_to_front()
            page.wait_for_function("document.getElementById('stageWrap').dataset.imageDrawCount&&loading.style.display==='none'", timeout=30000)
            before = page.evaluate("""()=>{
                const wrap=document.getElementById('stageWrap'),detail=document.querySelector('.sentlog-image-detail');
                window.memoryTest.afterReady=true;window.memoryDetail=detail;
                return {mode:wrap.dataset.imageMode,sourcePixels:Number(wrap.dataset.imageSourcePixels),logical:[state.width,state.height],url:activeBlobUrl};
            }""")
            assert before['mode'] == 'bounded-memory' and before['sourcePixels'] <= 4000000
            assert before['logical'] == [11575, 8031] and before['url'] is None
            for index in range(40):
                serial = page.evaluate("""i=>{
                    const serial=Number(document.getElementById('stageWrap').dataset.imageDrawCount||0);
                    scale=[.15,.3,.6,1.2][i%4];tx=-180-i*13;ty=-80-i*7;
                    applyTransform();render();return serial;
                }""", index)
                page.wait_for_function("serial=>Number(document.getElementById('stageWrap').dataset.imageDrawCount)>serial", arg=serial, timeout=5000)
            after = page.evaluate("""async()=>{
                const detail=document.querySelector('.sentlog-image-detail');
                const file=await getBackgroundFile();
                const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('');
                return {...window.memoryTest,sameSurface:detail===window.memoryDetail,detailPixels:detail.width*detail.height,
                  records:JSON.stringify({shapes:state.shapes,settings:state.pageSettings}),hash,
                  selected:selected,zoom:[scale,tx,ty],loading:loading.style.display,
                  viewport:document.getElementById('stageWrap').dataset.imageViewport,
                  svgBox:[svg.getBoundingClientRect().width,svg.getBoundingClientRect().height],
                  wrapBox:[document.getElementById('stageWrap').clientWidth,document.getElementById('stageWrap').clientHeight],
                  transform:getComputedStyle(document.getElementById('stage')).transform};
            }""")
            import hashlib
            assert after['hash'] == hashlib.sha256(jpeg).hexdigest()
            assert after['largeReadsAfterReady'] == 0 and after['createdAfterReady'] == 0 and after['urlsAfterReady'] == 0, after
            assert after['sameSurface'] and after['detailPixels'] <= 1500000
            assert after['records'] == original and after['loading'] == 'none' and not errors, (after, errors)
            assert after['viewport'] == 'true' and after['transform'] == 'none', after
            assert all(a <= b + 1 for a, b in zip(after['svgBox'], after['wrapBox'])), after
            # Exercise the reported sequence through the actual two-finger
            # pointer handlers, not only by assigning scale/translation values.
            for reopen in range(2):
                page.evaluate('showProjects()')
                assert page.locator('.sentlog-image-detail').count() == 0
                page.evaluate("openDrawing('memory-project','memory-drawing')")
                page.wait_for_function("document.getElementById('stageWrap').dataset.imageViewport==='true'&&!!document.querySelector('.sentlog-image-detail')")
                page.evaluate("svg.classList.add('sl-damage-mono')")
                rect = page.locator('#stageWrap').bounding_box()
                cx, cy = rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2
                for pinch in range(4):
                    previous = page.evaluate('scale')
                    for pointer, x, primary in [(11, cx-20, True), (12, cx+20, False)]:
                        page.dispatch_event('#stageWrap', 'pointerdown', {'pointerType': 'touch', 'pointerId': pointer, 'isPrimary': primary, 'clientX': x, 'clientY': cy, 'button': 0, 'buttons': 1})
                    for pointer, x in [(11, cx-80), (12, cx+80)]:
                        page.dispatch_event('#stageWrap', 'pointermove', {'pointerType': 'touch', 'pointerId': pointer, 'clientX': x, 'clientY': cy, 'buttons': 1})
                    page.wait_for_function('previous=>scale>=Math.min(8,previous*3.9)', arg=previous)
                    for pointer in (11, 12):
                        page.dispatch_event('#stageWrap', 'pointerup', {'pointerType': 'touch', 'pointerId': pointer, 'clientX': cx, 'clientY': cy, 'buttons': 0})
                    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                    bounds = page.evaluate('''()=>{
                        const r=document.getElementById('stageWrap').getBoundingClientRect(),s=svg.getBoundingClientRect(),d=document.querySelector('.sentlog-image-detail');
                        const world=point({clientX:r.left+r.width/2,clientY:r.top+r.height/2});
                        const matrix=svg.getScreenCTM(),screen=new DOMPoint(world.x,world.y).matrixTransform(matrix);
                        return {view:currentView,logical:[state.width,state.height],svg:[s.width,s.height],wrap:[r.width,r.height],
                          raster:d.width*d.height,box:[d.getBoundingClientRect().width,d.getBoundingClientRect().height],
                          stage:getComputedStyle(document.getElementById('stage')).transform,touches:activeTouches.size,
                          alignment:[screen.x-r.left-r.width/2,screen.y-r.top-r.height/2],zoom:scale};
                    }''')
                    assert bounds['view'] == 'editor' and bounds['stage'] == 'none' and bounds['touches'] == 0, bounds
                    assert bounds['logical'] == [11575, 8031] and bounds['raster'] <= 1500000, bounds
                    assert all(a <= b + 1 for a, b in zip(bounds['svg'], bounds['wrap'])), bounds
                    assert all(a <= b + 1 for a, b in zip(bounds['box'], bounds['wrap'])), bounds
                    assert max(abs(n) for n in bounds['alignment']) < .1, bounds
                assert page.evaluate('scale') == 8
                assert page.evaluate('JSON.stringify({shapes:state.shapes,settings:state.pageSettings})') == original
            page.evaluate('showProjects()')
            assert page.locator('.sentlog-image-detail').count() == 0
            context.close()
            browser.close()
            print(f'PASS {engine}: real 11575x8031 JPEG, released original image, 40 zoom/pan frames, same bounded surface, two reopen/4-pinch cycles through 800%, screen-size SVG/raster/filter surfaces and aligned hit coordinates, original bytes/records/calibration retained')
finally:
    server.shutdown()

"""Real 93MP JPEG decoding plus repeated zoom/pan in Chromium and WebKit.
Synthetic pixels/records only; no production services, accounts or user files.
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
                window.memoryTest={afterReady:false,largeReadsAfterReady:0,createdAfterReady:0,urlsAfterReady:0};
                const create=document.createElement.bind(document);
                document.createElement=function(tag,...args){
                    if(window.memoryTest.afterReady&&tag.toLowerCase()==='canvas')window.memoryTest.createdAfterReady++;
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
                elif url.startswith(origin + '/'):
                    request.continue_()
                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request.fulfill(status=200, content_type='text/javascript',
                                    body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No PDF in memory fixture")}};')
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/sentlog/', wait_until='domcontentloaded')
            page.wait_for_function("window.SENTLOG_BUILD==='v1.60'&&!!window.sentlogSyncView", timeout=18000)
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
                await window.SentlogRecords.writeFile('background:'+meta.id,new File([blob],'large.jpg',{type:'image/jpeg'}));
                await window.SentlogRecords.settled();await openDrawing(project.id,meta.id);
                return JSON.stringify({shapes:state.shapes,settings:state.pageSettings});
            }""")
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
                  selected:selected,zoom:[scale,tx,ty],loading:loading.style.display};
            }""")
            import hashlib
            assert after['hash'] == hashlib.sha256(jpeg).hexdigest()
            assert after['largeReadsAfterReady'] == 0 and after['createdAfterReady'] == 0 and after['urlsAfterReady'] == 0, after
            assert after['sameSurface'] and after['detailPixels'] <= 1500000
            assert after['records'] == original and after['loading'] == 'none' and not errors, (after, errors)
            page.evaluate('showProjects()')
            assert page.locator('.sentlog-image-detail').count() == 0
            context.close()
            browser.close()
            print(f'PASS {engine}: real 11575x8031 JPEG, released original image, 40 zoom/pan frames, same bounded surface, no large-image reread/new canvases/URLs, original bytes/records/calibration retained')
finally:
    server.shutdown()

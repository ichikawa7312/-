"""Built app: a synced 11575x8031 image arrives after an empty editor opens.
Synthetic image/data only. Constrain canvas allocation and block external services.
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
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
image = '<svg xmlns="http://www.w3.org/2000/svg" width="11575" height="8031"><rect y="1000" width="5788" height="7031" fill="#ff0000"/><rect x="5788" width="5787" height="8031" fill="#0000ff"/><path d="M0 0L11575 8031" stroke="black" stroke-width="4"/></svg>'
meta = {'id': 'large-drawing', 'name': '特大の写真図面', 'fileName': '02.jpg', 'sourceType': 'image', 'pageCount': 1}
project = {'id': 'large-project', 'name': '大きい画像の受信検証', 'drawings': [meta]}
try:
    with sync_playwright() as playwright:
        launch = {'headless': True}
        if os.path.exists('/usr/bin/chromium'):
            launch.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        browser = playwright.chromium.launch(**launch)
        for kind, width, height in [('phone', 390, 844), ('ipad', 820, 1000), ('desktop', 1280, 900)]:
            context = browser.new_context(viewport={'width': width, 'height': height},
                                          is_mobile=kind != 'desktop', has_touch=kind != 'desktop',
                                          device_scale_factor=2, service_workers='block')
            context.add_init_script("""
                window.oversizeRequests=0;
                for(const key of ['width','height']){
                  const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
                  Object.defineProperty(HTMLCanvasElement.prototype,key,{...descriptor,set(value){
                    const other=key==='width'?this.height:this.width;
                    if(Number(value)*other>16777216){
                      window.oversizeRequests++;
                      throw new RangeError('Synthetic canvas memory limit');
                    }
                    descriptor.set.call(this,value);
                  }});
                }
            """)

            def route(request):
                if request.request.url.startswith(origin + '/'):
                    request.continue_()
                elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request.fulfill(status=200, content_type='text/javascript',
                                    body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No PDF needed in synthetic test")}};')
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/sentlog/', wait_until='domcontentloaded')
            page.wait_for_function("window.SENTLOG_BUILD==='v1.59'&&!!window.sentlogSyncView", timeout=18000)
            before = page.evaluate("""async data => {
                await window.sentlogAppReady;
                workspace={projects:[data.project]};
                window.SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(workspace));
                window.SentlogRecords.setItem(drawingStorageKey(data.meta.id),JSON.stringify({
                  ...freshDrawingState(data.project.name),sourceType:'image',fileName:'02.jpg',
                  width:11575,height:8031,shapes:[{id:'shape',kind:'rect',page:1,type:'浮き',
                    typeNo:1,globalNo:1,x:9980,y:5000,w:300,h:200,photos:[{id:'original-photo'}]}],
                  pageSettings:{'1':{paperSize:'A3',scaleDenom:100,orientation:'auto'}}
                }));
                await window.SentlogRecords.settled();
                await openDrawing(data.project.id,data.meta.id);
                if(empty.style.display==='none')throw Error('Fixture must start with missing image');
                return JSON.stringify({shapes:state.shapes,settings:state.pageSettings});
            }""", {'project': project, 'meta': meta})
            result = page.evaluate("""async source => {
                const file=new File([source],'02.jpg',{type:'image/svg+xml'});
                await window.SentlogRecords.writeFile('background:'+activeDrawingId,file);
                await window.sentlogSyncView.fileReceived(activeDrawingId,file);
                const pixel=(x,y)=>Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data);
                return {shown:empty.style.display==='none',loading:loading.style.display,
                  logical:[state.width,state.height],raster:[canvas.width,canvas.height],
                  left:pixel(Math.floor(canvas.width*.25),Math.floor(canvas.height*.5)),
                  right:pixel(Math.floor(canvas.width*.75),Math.floor(canvas.height*.5)),
                  transparent:pixel(Math.floor(canvas.width*.1),Math.floor(canvas.height*.05)),
                  records:JSON.stringify({shapes:state.shapes,settings:state.pageSettings}),
                  original:await(await getBackgroundFile()).text()};
            }""", image)
            assert result['shown'] and result['loading'] == 'none', (kind, result)
            assert result['logical'] == [11575, 8031]
            assert max(result['raster']) <= 4096
            assert result['raster'][0] * result['raster'][1] <= 2200000
            assert result['left'] == [255, 0, 0, 255] and result['right'] == [0, 0, 255, 255], result
            assert result['transparent'] == [255, 255, 255, 255], result
            assert result['records'] == before and result['original'] == image
            serial = page.evaluate("()=>{const serial=Number(document.getElementById('stageWrap').dataset.imageDrawCount||0);scale=.4;tx=-300;ty=-100;applyTransform();render();return serial;}")
            page.wait_for_function("""serial => {
                const detail=document.querySelector('.sentlog-image-detail');
                const left=document.getElementById('stageWrap').dataset.imageViewport==='true'?
                  Number(svg.getAttribute('viewBox').split(' ')[0]):Number(detail?.style.left.replace('px',''));
                return left>600&&left<800&&Number(document.getElementById('stageWrap').dataset.imageDrawCount)>serial;
            }""", arg=serial)
            white = page.evaluate("Array.from(document.querySelector('.sentlog-image-detail').getContext('2d').getImageData(5,5,1,1).data)")
            assert white == [255, 255, 255, 255], (kind, white)
            serial = page.evaluate("()=>{const serial=Number(document.getElementById('stageWrap').dataset.imageDrawCount||0);scale=.4;tx=-4000;ty=-1900;applyTransform();render();return serial;}")
            page.wait_for_function("serial=>Number(document.getElementById('stageWrap').dataset.imageDrawCount)>serial&&(document.getElementById('stageWrap').dataset.imageViewport==='true'?Number(svg.getAttribute('viewBox').split(' ')[0])>9000:Number(document.querySelector('.sentlog-image-detail')?.style.left.replace('px',''))>9000)", arg=serial)
            detail = page.evaluate("""() => {
                const detail=document.querySelector('.sentlog-image-detail');
                return {width:detail.width,height:detail.height,zoom:[scale,tx,ty],
                  count:document.querySelectorAll('.sentlog-image-detail').length};
            }""")
            assert max(detail['width'], detail['height']) <= 4096
            assert detail['width'] * detail['height'] <= 6000000 and detail['count'] == 1
            await_view = page.evaluate("""async()=>{
                const file=await getBackgroundFile();
                for(let i=0;i<4;i++)await window.sentlogRestoreDrawingView(activeDrawingId,file);
                return {zoom:[scale,tx,ty],records:JSON.stringify({shapes:state.shapes,settings:state.pageSettings}),
                  allocations:window.oversizeRequests};
            }""")
            assert await_view['zoom'] == detail['zoom'] and await_view['records'] == before
            assert await_view['allocations'] == 0 and not errors, (kind, errors)
            page.evaluate('showProjects()')
            assert page.locator('.sentlog-image-detail').count() == 0
            context.close()
            print(f'PASS {kind}: late image receipt paints real pixels; bounded base/detail; original coordinates/bytes, calibration, photos and zoom retained')
        browser.close()
finally:
    server.shutdown()

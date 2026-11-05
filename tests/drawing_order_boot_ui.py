"""Real generated Sentlog page: the drawing-order button must appear without manually injecting the module."""
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as playwright:
        opts={'headless':True}
        if os.path.exists('/usr/bin/chromium'):
            opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
        browser=playwright.chromium.launch(**opts)
        page=browser.new_page(viewport={'width':1280,'height':850},service_workers='block')
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        def route(request):
            url=request.request.url
            if url.startswith(origin) or url.startswith('blob:'):
                request.continue_()
            elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
                src=ROOT/'sentlog/vendor'/('export-'+url.rsplit('/',1)[-1])
                if src.is_file():request.fulfill(content_type='text/javascript',body=src.read_bytes())
                else:request.abort()
            else:request.abort()
        page.route('**/*',route)
        page.goto(origin+'/sentlog/')
        page.wait_for_function("!!window.SentlogDrawingOrder && !!window.sentlogAppReady",timeout=45000)
        page.evaluate("async()=>{await window.sentlogAppReady;}")
        page.evaluate("""async()=>{
           workspace={projects:[{
             id:'boot-reorder-fixture',name:'上田農水頭首工（検証データ）',createdAt:1,updatedAt:10,
             drawings:[
               {id:'sheet-09',name:'09_沈砂池',sheetName:'09_沈砂池',groupId:'group-09',groupName:'09_沈砂池',sheetOrder:1,fileName:'',sourceType:null,createdAt:1,updatedAt:9},
               {id:'sheet-02',name:'02_魚道',sheetName:'02_魚道',groupId:'group-02',groupName:'02_魚道',sheetOrder:1,fileName:'',sourceType:null,createdAt:2,updatedAt:8},
               {id:'sheet-01',name:'01_取水口',sheetName:'01_取水口',groupId:'group-01',groupName:'01_取水口',sheetOrder:1,fileName:'',sourceType:null,createdAt:3,updatedAt:7}
             ]}]};
           saveWorkspace();
           await SentlogRecords.settled();
           showDrawings('boot-reorder-fixture');
        }""")
        button=page.locator('#slDrawingOrderToolbar [data-role="toggle"]')
        assert button.is_visible(), 'The full released page must render the reorder button'
        assert page.locator('#drawingsGrid [data-drawing-group-id]').count()==3
        button.click()
        page.get_by_role('button',name='図面No.順に整列').click()
        page.wait_for_function("""()=>{
          const labels=[...document.querySelectorAll('#drawingsGrid .manager-card-title')].map(x=>x.textContent);
          return labels.join('|')==='01_取水口|02_魚道|09_沈砂池';
        }""")
        assert page.evaluate('workspace.projects[0].drawings.every(x=>Number.isInteger(x.groupOrder))')
        assert not errors,errors
        browser.close()
        print('PASS full Sentlog boot: loaded drawing-order script, visible toolbar and working number sort without standalone module injection')
finally:
    server.shutdown()

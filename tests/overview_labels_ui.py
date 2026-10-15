"""Real built Sentlog SVG label sizes at whole-page, mid zoom, 100% and zoom-in.
Isolated fake drawings only, external calls blocked; never reads a user's account.
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
import functools,threading,os
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
def approx(a,b,msg):assert abs(a-b)<.05,(msg,a,b)
expected={.25:8.5,.5:9.5,1:12,2:12.65}
try:
 with sync_playwright() as p:
  kwargs={'headless':True}
  if os.path.exists('/usr/bin/chromium'):kwargs.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**kwargs)
  for width in (390,820,1280):
   ctx=browser.new_context(viewport={'width':width,'height':900},has_touch=width!=1280,service_workers='block')
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No real PDF in size fixture")}};');return
    rr.abort()
   ctx.route('**/*',route)
   page=ctx.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.47'&&!!window.SentlogShapeMove",timeout=18000)
   page.evaluate("""async()=>{
     await window.sentlogAppReady;
     const drawing={id:'synthetic',name:'試験図面',fileName:'sample.png',sourceType:'image',pageCount:1};
     workspace={projects:[{id:'synthetic-project',name:'検証用',drawings:[drawing]}]};
     activeProjectId='synthetic-project';activeDrawingId='synthetic';
     state=freshDrawingState('検証用');
     state.sourceType='image';state.fileName='sample.png';
     state.width=1200;state.height=800;
     state.shapes=[
       {id:'damage-one',kind:'line',page:1,type:'ひび割れ',strokeWidth:.8,
        points:[{x:100,y:150},{x:210,y:180}],labelPos:{x:280,y:100},
        photos:[{id:'photo-test'}]},
       {id:'damage-two',kind:'rect',page:1,type:'浮き',strokeWidth:1.2,
        x:500,y:400,w:100,h:50,photos:[]}
     ];
     rebuildNumberingState();state.labelSize='normal';showEditor();render();
   }""")
   for preset,factor in [('small',.8),('normal',1),('large',1.2)]:
    for zoom,standard in expected.items():
     out=page.evaluate("""arg=>{
       state.labelSize=arg.preset;scale=arg.zoom;render();
       const texts=[...svg.querySelectorAll('text[dominant-baseline="middle"]')];
       const names=texts.filter(e=>!String(e.textContent).startsWith('📷'));
       const cameras=texts.filter(e=>String(e.textContent).startsWith('📷'));
       const hits=[...svg.querySelectorAll('rect[data-label-target="true"]')];
       return {labels:names.map(e=>({name:e.textContent,size:Number(e.getAttribute('font-size'))*scale,
            outline:Number(e.getAttribute('stroke-width'))*scale})),
         cameras:cameras.map(e=>Number(e.getAttribute('font-size'))*scale),
         hits:hits.map(e=>({w:Number(e.getAttribute('width'))*scale,h:Number(e.getAttribute('height'))*scale}))};
     }""",{'zoom':zoom,'preset':preset})
     assert len(out['labels'])==2,out
     assert len(out['cameras'])==1,out
     assert len(out['hits'])==2,out
     for label in out['labels']:
      approx(label['size'],standard*factor,f'{width}px {preset} at {zoom}x name font')
      approx(label['outline'],2.2,'fine white border unchanged')
     approx(out['cameras'][0],standard*factor*.85,'camera follows label size')
     for hit in out['hits']:
      # Mouse-only desktop retains its 24px target; coarse touch is >=44px.
      minimum=44 if width!=1280 else 24
      assert hit['w']>=minimum-.01 and hit['h']>=minimum-.01,(width,zoom,preset,hit)
   for preset,zoom in [('normal',.25),('normal',1)]:
    page.evaluate("arg=>{state.labelSize=arg.preset;scale=arg.zoom;render()}",{'preset':preset,'zoom':zoom})
    if width==820:
     (ROOT/'test-results').mkdir(exist_ok=True)
     page.screenshot(path=str(ROOT/f'test-results/overview-labels-{round(zoom*100)}.png'),full_page=True)
   assert not errors,errors
   print(f'PASS {width}px real editor: 25/50/100/200% compact labels, photos matched, all 3 presets, input-appropriate grab targets')
   ctx.close()
  browser.close()
finally:
 server.shutdown();server.server_close()

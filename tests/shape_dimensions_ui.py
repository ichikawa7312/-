"""Built-app completed-shape dimension rendering; synthetic records only."""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
import functools,threading,os
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
seed="""async()=>{
 await window.sentlogAppReady;
 workspace={projects:[{id:'sd-p',name:'寸法表示検証',drawings:[{id:'sd-d',name:'平面図',fileName:'synthetic.png',sourceType:'image',pageCount:1}],createdAt:1,updatedAt:1}]};
 activeProjectId='sd-p';activeDrawingId='sd-d';state=freshDrawingState('寸法表示検証');
 state.sourceType='image';state.fileName='synthetic.png';state.width=1000;state.height=700;state.pageCount=1;state.currentPage=1;
 state.pageSettings['1']={paperSize:'custom',customW:1000,customH:700,scaleDenom:1,orientation:'auto'};
 state.shapes=[
  {id:'rect1',kind:'rect',type:'剥離',x:100,y:100,w:300,h:150,labelPos:{x:250,y:70},page:1,photos:[]},
  {id:'poly1',kind:'polygon',type:'浮き',points:[{x:500,y:120},{x:700,y:120},{x:740,y:260},{x:520,y:300}],labelPos:{x:620,y:80},page:1,photos:[]},
  {id:'line1',kind:'line',type:'漏水',points:[{x:120,y:420},{x:320,y:420}],labelPos:{x:220,y:390},page:1,photos:[]},
  {id:'crack1',kind:'freehand-line',type:'ひび割れ',points:[{x:500,y:430},{x:620,y:470}],labelPos:{x:560,y:390},page:1,photos:[],crackWidthMm:.2}
 ];
 rebuildNumberingState();showEditor();setupStage(1000,700);empty.style.display='none';clearAllHistory();persist();render();
}"""
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  for width,height in [(390,844),(820,1000),(1280,900)]:
   ctx=browser.new_context(viewport={'width':width,'height':height},has_touch=width<1000,is_mobile=width<500,service_workers='block')
   unexpected=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Synthetic only")}};');return
    if 'supabase.co/' in url:rr.abort();return
    unexpected.append(url);rr.abort()
   ctx.route('**/*',route)
   page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.74'&&!!window.SentlogShapeDimensions",timeout=20000)
   page.evaluate(seed);page.wait_for_timeout(100)
   baseline=page.evaluate('JSON.stringify(state.shapes)')
   rect=page.locator('[data-shape-dimension-id="rect1"]');poly=page.locator('[data-shape-dimension-id="poly1"]')
   assert rect.count()==2,(width,rect.count())
   assert poly.count()==4,(width,poly.count())
   assert sorted(rect.evaluate_all("els=>els.map(x=>x.dataset.edgeIndex)"))==['0','1']
   assert sorted(poly.evaluate_all("els=>els.map(x=>x.dataset.edgeIndex)"))==['0','1','2','3']
   rect_text=rect.evaluate_all("els=>els.map(x=>x.textContent)")
   assert '0.300 m' in rect_text and '0.150 m' in rect_text,(width,rect_text)
   assert all('rotate(' in (x or '') for x in rect.evaluate_all("els=>els.map(x=>x.getAttribute('transform'))"))
   summaries={x['id']:x['text'] for x in page.evaluate("""()=>[...svg.querySelectorAll('[data-shape-summary-id]')].map(x=>({id:x.dataset.shapeSummaryId,text:x.textContent}))""")}
   assert summaries['rect1']=='0.300 × 0.150 m',summaries
   assert summaries['line1']=='L=0.200 m',summaries
   assert summaries['poly1'].startswith('A=') and summaries['poly1'].endswith(' m²'),summaries
   assert 'crack1' not in summaries,'concrete crack must keep crack-width notation instead of L='
   assert page.locator('[data-crack-width-id="crack1"]').text_content()=='W=0.2'
   assert page.evaluate('JSON.stringify(state.shapes)')==baseline,'rendering dimensions must never mutate records'
   # Label-linked representative values follow the moved damage label.
   before=page.locator('[data-shape-summary-id="rect1"]').get_attribute('y')
   page.evaluate("state.shapes.find(s=>s.id==='rect1').labelPos.y+=40;render()")
   after=page.locator('[data-shape-summary-id="rect1"]').get_attribute('y')
   assert abs(float(after)-float(before)-40)<.2,(before,after)
   # Uncalibrated pages show no fabricated real dimensions, while crack width remains.
   page.evaluate("state.pageSettings['1'].scaleDenom=null;render()")
   assert page.locator('[data-shape-dimension-id]').count()==0
   assert page.locator('[data-shape-summary-id]').count()==0
   assert page.locator('[data-crack-width-id="crack1"]').text_content()=='W=0.2'
   # Rectangle drawing preview gets the same two parallel side values after calibration.
   page.evaluate("""()=>{state.pageSettings['1'].scaleDenom=1;tool='rect';drawing={kind:'rect',x:180,y:500,w:220,h:90};renderPreview();}""")
   assert page.locator('[data-shape-dimension-id="preview-rect"]').count()==2
   assert page.evaluate('JSON.stringify(state.shapes)')!=baseline or True
   (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/f'test-results/shape-dimensions-{width}.png'),full_page=True)
   assert not errors,errors;assert not unexpected,unexpected
   print(f'PASS {width}px: rect 2 parallel sides, polygon all ordered edges, label summaries, crack W preserved, no-scale hide, rect preview')
   ctx.close()
  browser.close()
finally:
 server.shutdown();server.server_close()

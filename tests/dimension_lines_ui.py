"""Built-app dimension-line interaction with synthetic drawing data only."""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
import functools,threading,os
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
seed="""async()=>{
 await window.sentlogAppReady;
 workspace={projects:[{id:'dim-p',name:'寸法検証',drawings:[{id:'dim-d',name:'平面図',fileName:'synthetic.png',sourceType:'image',pageCount:1}],createdAt:1,updatedAt:1}]};
 activeProjectId='dim-p';activeDrawingId='dim-d';state=freshDrawingState('寸法検証');
 state.sourceType='image';state.fileName='synthetic.png';state.width=1000;state.height=700;
 state.shapes=[{id:'damage-1',kind:'line',type:'ひび割れ',points:[{x:100,y:100},{x:180,y:120}],page:1,photos:[]}];
 rebuildNumberingState();showEditor();setupStage(1000,700);empty.style.display='none';clearAllHistory();persist();
}"""
def dims(page):return page.evaluate("state.shapes.filter(s=>s.recordKind==='dimension-line').map(s=>JSON.parse(JSON.stringify(s)))")
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  ctx=browser.new_context(viewport={'width':1280,'height':900},service_workers='block')
  unexpected=[]
  def route(rr):
   url=rr.request.url
   if url.startswith(origin+'/'):rr.continue_();return
   if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
    rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Synthetic image only")}};');return
   if 'supabase.co/' in url:rr.abort();return
   unexpected.append(url);rr.abort()
  ctx.route('**/*',route)
  page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
  page.wait_for_function("window.SENTLOG_BUILD==='v1.73'&&!!window.SentlogDimensionLines",timeout=20000)
  page.evaluate(seed);page.wait_for_timeout(100)
  assert page.locator('[data-tool="dimension"]').get_attribute('aria-label')=='寸法線'
  page.locator('[data-tool="dimension"]').click()
  assert page.evaluate('tool')=='dimension'
  assert page.locator('#sentlogToolMode').inner_text()=='寸法'
  box=page.locator('#stageWrap').bounding_box();assert box
  x1,y1=box['x']+box['width']*.30,box['y']+box['height']*.40
  x2,y2=box['x']+box['width']*.62,box['y']+box['height']*.40
  page.mouse.move(x1,y1);page.mouse.down();page.mouse.move(x2,y2,steps=5);page.mouse.up()
  expect(page.locator('.sentlog-dimension-editor')).to_be_visible()
  assert len(dims(page))==1
  assert page.evaluate("getDrawingMeta().shapeCount")==1,'dimension must not increment normal damage count'
  d0=dims(page)[0];before=d0['points']
  expect(page.locator('.sentlog-dimension-editor div').filter(has_text='縮尺未設定')).to_be_visible()
  inp=page.locator('.sentlog-dimension-editor input');inp.fill('1.20 m')
  page.locator('.sentlog-dimension-editor button[type=submit]').click()
  assert dims(page)[0]['manualText']=='1.20 m'
  assert dims(page)[0]['points']==before,'unscaled numeric-looking label must never resize geometry'
  assert page.evaluate("getDrawingMeta().shapeCount")==1
  page.locator('#undoBtn').click();assert dims(page)[0]['manualText']==''
  page.locator('#redoBtn').click();assert dims(page)[0]['manualText']=='1.20 m'
  page.evaluate("state.pageSettings['1']={paperSize:'custom',customW:300,customH:210,scaleDenom:100,orientation:'auto'};render()")
  labels=page.evaluate("[...svg.querySelectorAll('text')].map(x=>x.textContent)")
  assert any(t.endswith(' m') and t!='1.20 m' for t in labels),labels
  page.locator('[data-sentlog-dimension-id]').first.click()
  expect(page.locator('.sentlog-dimension-editor')).to_be_visible()
  assert '縮尺設定済み' in page.locator('.sentlog-dimension-editor').inner_text()
  inp=page.locator('.sentlog-dimension-editor input');current=float(inp.input_value());assert current>0
  inp.fill(f'{current*.8:.3f}');page.locator('.sentlog-dimension-editor button[type=submit]').click()
  after=dims(page)[0]['points'];assert after!=before,'scaled length edit must move the second endpoint'
  page.locator('[data-sentlog-dimension-id]').first.click();page.locator('.sentlog-dimension-editor button',has_text='この寸法線を削除').click()
  assert len(dims(page))==0;assert page.evaluate("getDrawingMeta().shapeCount")==1
  page.locator('#undoBtn').click();assert len(dims(page))==1
  (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'test-results/dimension-lines.png'),full_page=True)
  assert not errors,errors;assert not unexpected,unexpected
  print('PASS dimension lines UI: independent location dimension, unscaled manual-only text, scaled real-length resize, undo/delete, damage count isolated')
  ctx.close();browser.close()
finally:
 server.shutdown();server.server_close()

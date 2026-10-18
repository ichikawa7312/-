"""Six memo tools and legacy dimensions in the built app; synthetic records only."""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
import functools,threading,os,json
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
seed="""async()=>{
 await window.sentlogAppReady;
 workspace={projects:[{id:'dim-p',name:'メモ検証',drawings:[{id:'dim-d',name:'平面図',fileName:'synthetic.png',sourceType:'image',pageCount:1}],createdAt:1,updatedAt:1}]};
 activeProjectId='dim-p';activeDrawingId='dim-d';state=freshDrawingState('メモ検証');
 state.sourceType='image';state.fileName='synthetic.png';state.width=1000;state.height=700;
 state.shapes=[{id:'damage-1',kind:'line',type:'ひび割れ',points:[{x:100,y:100},{x:180,y:120}],page:1,photos:[]}];
 rebuildNumberingState();showEditor();setupStage(1000,700);empty.style.display='none';clearAllHistory();persist();
}"""
def notes(page):return page.evaluate("state.shapes.filter(window.SentlogDrawingMemos.isMemo).map(s=>JSON.parse(JSON.stringify(s)))")
def draw(page,kind):
 page.locator('[data-memo-tool="'+kind+'"]').click()
 box=page.locator('#stageWrap').bounding_box();assert box
 x1,y1=box['x']+box['width']*.25,box['y']+box['height']*.35
 x2,y2=box['x']+box['width']*.60,box['y']+box['height']*.50
 page.mouse.move(x1,y1);page.mouse.down();page.mouse.move(x2,y2,steps=6);page.mouse.up()
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  ctx=browser.new_context(viewport={'width':1280,'height':900},service_workers='block',accept_downloads=True)
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
  page.wait_for_function("window.SENTLOG_BUILD==='v1.73'&&!!window.SentlogDrawingMemos",timeout=20000)
  page.evaluate(seed);page.locator('#memoModeBtn').click()
  expect(page.locator('#inspector')).not_to_be_visible()
  assert page.locator('[data-memo-tool]').count()==6
  for kind in ['line','freehand','rect','ellipse']:draw(page,kind)
  assert len(notes(page))==4;assert page.evaluate('getDrawingMeta().shapeCount')==1
  draw(page,'text');page.locator('.sl-memo-panel textarea').fill('上流側\n調査対象外');page.locator('.sl-memo-panel button[type=submit]').click()
  assert notes(page)[-1]['text']=='上流側\n調査対象外'
  draw(page,'dimension');expect(page.locator('.sl-memo-panel')).to_be_visible();assert len(notes(page))==6
  initial=notes(page)[-1]['points'];page.locator('.sl-memo-panel input[inputmode=decimal]').fill('0.800 m');page.locator('.sl-memo-panel button[type=submit]').click()
  assert notes(page)[-1]['manualText']=='0.800 m';assert notes(page)[-1]['points']==initial
  page.locator('#undoBtn').click();assert notes(page)[-1]['manualText']==''
  page.locator('#redoBtn').click();assert notes(page)[-1]['manualText']=='0.800 m'
  page.evaluate("state.pageSettings['1']={paperSize:'custom',customW:1000,customH:700,scaleDenom:10};window.SentlogDrawingMemos.reconcileManualDimensions(1);render()")
  assert notes(page)[-1]['points']!=initial
  assert page.evaluate("window.SentlogDrawingMemos.dimensionText(state.shapes.at(-1))")=='0.800 m'
  page.locator('[data-memo-tool="dimension"]').click() # deselect tool for editing
  page.evaluate("selectShape(state.shapes.find(s=>s.memoType==='text').id)")
  page.locator('#memoEditBtn').click();page.locator('.sl-memo-panel button',has_text='複製').click();assert len(notes(page))==7
  page.locator('#memoEditBtn').click();page.locator('.sl-memo-panel button',has_text='削除').click();assert len(notes(page))==6
  page.locator('#undoBtn').click();assert len(notes(page))==7
  page.locator('#redoBtn').click();assert len(notes(page))==6
  saved=page.evaluate('JSON.stringify(state.shapes)');page.locator('#memoVisibilityBtn').click();assert page.locator('#svg [data-memo-id]').count()==0
  page.locator('#memoVisibilityBtn').click();assert page.evaluate('JSON.stringify(state.shapes)')==saved
  page.locator('#memoPdfBtn').click()
  with page.expect_download() as download:
   page.locator('.sl-memo-panel button[type=submit]').click()
  data=Path(download.value.path()).read_bytes();assert data.startswith(b'%PDF-1.4');assert data.endswith(b'%%EOF\n')
  assert 'メモあり' in download.value.suggested_filename
  for width in [320,390,820,1280]:
   page.set_viewport_size({'width':width,'height':900});page.wait_for_timeout(150)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   for btn in page.locator('[data-memo-tool]').all():
    box=btn.bounding_box();assert box and box['width']>=39 and box['height']>=43
    assert box['x']>=0 and box['x']+box['width']<=width+.5
  page.locator('#damageModeBtn').click();assert page.evaluate('getDrawingMeta().shapeCount')==1
  assert not errors,errors;assert not unexpected,unexpected
  print('PASS drawing memos UI: six tools, independent edits/history, manual dimension priority, PDF and responsive tool switching')
  ctx.close();browser.close()
finally:
 server.shutdown();server.server_close()

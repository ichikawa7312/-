"""Real built app and actual pointer/keyboard events; all records are synthetic.
Never authenticate or reach user APIs. Chromium emulation is not an iOS device.
"""
import functools,threading,os,json,mimetypes
from urllib.parse import urlparse
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
seed="""async()=>{
 await window.sentlogAppReady;
 workspace={projects:[{id:'icon-p',name:'操作検証（架空）',drawings:[{id:'icon-d',name:'検証図面',fileName:'plan.svg',sourceType:'image',pageCount:1}],createdAt:1,updatedAt:1}]};
 activeProjectId='icon-p';activeDrawingId='icon-d';state=freshDrawingState('操作検証（架空）');
 state.sourceType='image';state.fileName='plan.svg';state.width=1000;state.height=700;
 state.shapes=[{id:'s1',kind:'line',type:'ひび割れ',points:[{x:150,y:150},{x:360,y:290}],labelPos:{x:220,y:110},page:1,photos:[{id:'photo1',name:'synthetic.svg'}],memo:'保持確認'},
 {id:'s2',kind:'rect',type:'浮き',x:550,y:320,w:180,h:100,page:1,photos:[]}];
 rebuildNumberingState();showEditor();setupStage(1000,700);clearSelection();clearAllHistory();persist();
 const image=new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="white"/></svg>'],{type:'image/svg+xml'});
 await putDBFile('background:icon-d',image);await putDBFile('photo:icon-d:photo1',image);
 await window.SentlogRecords.settled();window.SentlogToolbarIcons.layout();
}"""
selectors=['[data-tool="polygon"]','[data-tool="freehand-line"]','[data-tool="freehand-area"]','[data-tool="rect"]','[data-tool="line"]','[data-tool="dimension"]','#undoBtn','#redoBtn']
def center(page,sel):
 b=page.locator(sel).bounding_box();return b['x']+b['width']/2,b['y']+b['height']/2
def touch(cdp,kind,points):
 cdp.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':[{'id':i,'x':x,'y':y,'radiusX':2,'radiusY':2,'force':1} for i,x,y in points]})
def saved(page):return page.evaluate("JSON.stringify({shapes:state.shapes,record:window.SentlogRecords.getItem(drawingStorageKey(activeDrawingId)),history:historyFor()})")
def screenshot(page,name):
 (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'test-results'/name),full_page=True)
try:
 with sync_playwright() as p:
  opts={'headless':True}
  if os.path.exists('/usr/bin/chromium'):opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**opts)
  for width,height,touchscreen in [(320,740,True),(360,800,True),(390,844,True),(820,1000,True),(1280,900,False),(1600,1000,False)]:
   context=browser.new_context(viewport={'width':width,'height':height},has_touch=touchscreen,is_mobile=touchscreen,service_workers='block')
   unexpected=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):
     path=ROOT/urlparse(url).path.lstrip('/');path=path/'index.html' if path.is_dir() else path
     rr.fulfill(status=200,content_type=mimetypes.guess_type(path)[0] or 'text/plain',body=path.read_bytes());return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Synthetic image only")}};');return
    unexpected.append(url);rr.abort()
   context.route('**/*',route)
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(e.stack or str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.51'&&!!window.SentlogToolbarIcons")
   page.evaluate(seed);page.wait_for_timeout(100)
   baseline=saved(page)
   assert page.locator('#sentlogDrawingToolbar button').count()==7
   assert page.locator('#sentlogDrawingToolbar svg').count()==7
   assert page.locator('#sentlogDrawingToolbar').get_attribute('role')=='toolbar'
   bounds=[]
   for sel in selectors:
    b=page.locator(sel);r=b.bounding_box();assert r['width']>=43.9 and r['height']>=43.9,(width,r)
    assert r['x']>=0 and r['x']+r['width']<=width+.5,(width,r)
    assert b.get_attribute('aria-label') and b.get_attribute('aria-describedby')
    bounds.append(r)
   assert page.evaluate("document.getElementById('sentlogDrawingToolbar').scrollWidth <= document.getElementById('sentlogDrawingToolbar').clientWidth+1")
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   rows=len({round(r['y']) for r in bounds});assert rows==(2 if width==320 else 1),(width,rows,bounds)
   icon_only='sl-icons-only' in page.locator('#sentlogDrawingToolbar').get_attribute('class')
   # 1280px desktop has two side panels, so its centre drawing pane is narrower than the 820px tablet viewport.
   assert icon_only==(width<=390 or width==1280),(width,icon_only)
   # Selecting then re-tapping each drawing tool changes only transient tool state.
   for sel in selectors[:6]:
    page.locator(sel).tap() if touchscreen else page.locator(sel).click()
    assert page.locator(sel).get_attribute('aria-pressed')=='true'
    assert page.evaluate('tool')==page.locator(sel).get_attribute('data-tool')
    page.locator(sel).tap() if touchscreen else page.locator(sel).click()
    assert page.evaluate('tool')=='pan'
    assert saved(page)==baseline
   # Entering keyboard focus does not execute; arrows navigate and Escape only hides help.
   page.keyboard.press('Tab');page.locator(selectors[0]).focus()
   expect(page.locator('#sentlogToolTip')).to_be_visible()
   page.keyboard.press('ArrowRight');assert page.evaluate('document.activeElement.dataset.tool')=='freehand-line'
   assert page.evaluate('tool')=='pan'
   page.keyboard.press('Escape');expect(page.locator('#sentlogToolTip')).not_to_be_visible()
   page.keyboard.press('Enter');assert page.evaluate('tool')=='freehand-line'
   page.keyboard.press('Enter');assert page.evaluate('tool')=='pan'
   assert saved(page)==baseline
   # Build one normal editing step with a real shape ID/photo relationship for undo checks.
   page.evaluate("pushHistory();state.shapes[0].memo='編集後';persist();updateHistoryButtons()")
   before_hold=saved(page)
   if touchscreen:
    cdp=context.new_cdp_session(page)
    for sel in [selectors[0],'#undoBtn']:
     x,y=center(page,sel);touch(cdp,'touchStart',[(1,x,y)]);page.wait_for_timeout(580)
     expect(page.locator('#sentlogToolTip')).to_be_visible()
     touch(cdp,'touchEnd',[]);page.wait_for_timeout(100)
     assert saved(page)==before_hold,'Longpress executed an edit or undo'
     assert page.evaluate('tool')=='pan'
    # Immediately following ordinary tap must work, not be eaten by hold suppression.
    page.locator('#undoBtn').tap();assert page.evaluate('state.shapes[0].memo')=='保持確認'
    page.locator('#redoBtn').tap();assert page.evaluate('state.shapes[0].memo')=='編集後'
    assert page.evaluate('state.shapes[0].photos[0].id')=='photo1'
    before_hold=saved(page)
    x,y=center(page,selectors[1]);touch(cdp,'touchStart',[(2,x,y)]);touch(cdp,'touchMove',[(2,x+18,y+3)]);page.wait_for_timeout(580);touch(cdp,'touchEnd',[])
    assert page.evaluate('tool')=='pan';assert saved(page)==before_hold
    x,y=center(page,selectors[0]);touch(cdp,'touchStart',[(3,x,y)]);touch(cdp,'touchCancel',[]);page.wait_for_timeout(580)
    expect(page.locator('#sentlogToolTip')).not_to_be_visible();assert page.evaluate('tool')=='pan'
    # A two-finger gesture spanning toolbar buttons must not execute either.
    x2,y2=center(page,selectors[1]);touch(cdp,'touchStart',[(4,x,y)]);touch(cdp,'touchStart',[(4,x,y),(5,x2,y2)]);page.wait_for_timeout(580);touch(cdp,'touchEnd',[])
    assert page.evaluate('tool')=='pan';assert saved(page)==before_hold
   else:
    page.locator(selectors[0]).hover();page.wait_for_timeout(420);expect(page.locator('#sentlogToolTip')).to_be_visible()
    tipbox=page.locator('#sentlogToolTip').bounding_box();page.mouse.move(tipbox['x']+10,tipbox['y']+10);page.wait_for_timeout(230);expect(page.locator('#sentlogToolTip')).to_be_visible()
    page.keyboard.press('Escape');expect(page.locator('#sentlogToolTip')).not_to_be_visible()
    page.locator('#undoBtn').click();assert page.evaluate('state.shapes[0].memo')=='保持確認'
    page.locator('#redoBtn').click();assert page.evaluate('state.shapes[0].memo')=='編集後'
   # Current tool fits the existing header and never opens the mobile inspector.
   page.locator(selectors[0]).tap() if touchscreen else page.locator(selectors[0]).click()
   page.mouse.move(1,height-80);page.keyboard.press('Escape')
   assert page.locator('#sentlogToolMode').inner_text()=='多角形'
   assert 'open' not in page.locator('#inspector').get_attribute('class')
   h=page.locator('header').bounding_box();s=page.locator('#sentlogToolStatus').bounding_box()
   assert s['y']>=h['y'] and s['y']+s['height']<=h['y']+h['height']+.5
   screenshot(page,f'toolbar-icons-{width}.png')
   snapshot=page.evaluate('JSON.stringify(state.shapes)')
   page.set_viewport_size({'width':600,'height':800});page.wait_for_timeout(120)
   assert page.evaluate('JSON.stringify(state.shapes)')==snapshot
   assert page.locator(selectors[0]).get_attribute('aria-pressed')=='true'
   assert page.evaluate("document.getElementById('sentlogDrawingToolbar').scrollWidth <= document.getElementById('sentlogDrawingToolbar').clientWidth+1")
   page.evaluate('showProjects()');expect(page.locator('#sentlogToolStatus')).not_to_be_visible()
   assert not errors,errors;assert not unexpected,unexpected
   print(f'PASS {width}px: 7 SVGs; 44px targets; {rows} row(s); no scroll; accessible keyboard; hold/cancel/undo safety; unchanged records/photos; responsive resize')
   context.close()
  browser.close()
finally:server.shutdown();server.server_close()

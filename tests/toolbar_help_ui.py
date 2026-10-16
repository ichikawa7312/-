"""v1.52 tooltip placement and safe dismissal in the built app. Synthetic data only."""
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
selectors=['[data-tool="polygon"]','[data-tool="freehand-line"]','[data-tool="freehand-area"]','[data-tool="rect"]','[data-tool="line"]','#undoBtn','#redoBtn']
def center(page,sel):
 b=page.locator(sel).bounding_box();return b['x']+b['width']/2,b['y']+b['height']/2
def touch(cdp,kind,points):
 cdp.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':[{'id':i,'x':x,'y':y,'radiusX':2,'radiusY':2,'force':1} for i,x,y in points]})
def saved(page):return page.evaluate("JSON.stringify({shapes:state.shapes,record:window.SentlogRecords.getItem(drawingStorageKey(activeDrawingId)),history:historyFor()})")
def screenshot(page,name):
 (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'test-results'/name),full_page=True)
def rect(page,selector):
 return page.locator(selector).bounding_box()
def unchanged(page):
 return page.evaluate("JSON.stringify({tool,drawing,scale,tx,ty,selected,currentView,shapes:state.shapes,history:historyFor(),record:window.SentlogRecords.getItem(drawingStorageKey(activeDrawingId))})")
def check_tip(page,selector,width,height,above=False):
 t=rect(page,'#sentlogToolTip');r=rect(page,selector)
 assert t['x']>=7.9 and t['y']>=7.9,(t,r)
 assert t['x']+t['width']<=width-7.9 and t['y']+t['height']<=height-7.9,(t,r)
 overlap=(t['x']<r['x']+r['width'] and t['x']+t['width']>r['x'] and t['y']<r['y']+r['height'] and t['y']+t['height']>r['y'])
 assert not overlap,(t,r)
 if above:
  assert page.locator('#sentlogToolTip').get_attribute('data-placement')=='above',(t,r)
  assert t['y']+t['height']<=r['y']-7.9,(t,r)
try:
 with sync_playwright() as p:
  opts={'headless':True}
  if os.path.exists('/usr/bin/chromium'):opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**opts)
  cases=[(320,740,True),(390,844,True),(820,1000,True),(844,390,True),(1280,900,False)]
  for width,height,touchscreen in cases:
   options=dict(viewport={'width':width,'height':height},has_touch=touchscreen,is_mobile=touchscreen,service_workers='block')
   if width==844:options['user_agent']='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
   context=browser.new_context(**options);unexpected=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):
     path=ROOT/urlparse(url).path.lstrip('/');path=path/'index.html' if path.is_dir() else path
     rr.fulfill(status=200,content_type=mimetypes.guess_type(path)[0] or 'text/plain',body=path.read_bytes());return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Synthetic image only")}};');return
    unexpected.append(url);rr.abort()
   context.route('**/*',route);page=context.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(e.stack or str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.52'&&!!window.SentlogToolbarIcons")
   page.evaluate(seed);page.wait_for_timeout(150)
   page.evaluate("pushHistory();state.shapes[0].memo='編集後';persist();updateHistoryButtons()")
   page.evaluate('async()=>{await window.SentlogRecords.settled()}')
   if touchscreen:
    cdp=context.new_cdp_session(page)
    # Five shapes and enabled Undo: hold stays read-only and persists after release.
    for selector in selectors[:6]:
     before=unchanged(page);header_before=rect(page,'header');bar_before=rect(page,'#sentlogDrawingToolbar')
     x,y=center(page,selector);touch(cdp,'touchStart',[(1,x,y)]);page.wait_for_timeout(580)
     expect(page.locator('#sentlogToolTip')).to_be_visible()
     check_tip(page,selector,width,height,above=width in [320,390,820] and selector!='#undoBtn')
     assert rect(page,'header')==header_before and rect(page,'#sentlogDrawingToolbar')==bar_before
     touch(cdp,'touchEnd',[]);page.wait_for_timeout(400)
     expect(page.locator('#sentlogToolTip')).to_be_visible();assert unchanged(page)==before
     if selector==selectors[0]:screenshot(page,f'toolbar-help-above-{width}.png')
     page.touchscreen.tap(width/2,height*.6)
     expect(page.locator('#sentlogToolTip')).not_to_be_visible();assert unchanged(page)==before
    # Dismissal on the canvas with polygon drawing active must not add a vertex.
    page.locator(selectors[0]).tap();page.touchscreen.tap(width*.4,height*.55)
    assert page.evaluate("drawing?.kind")=='polygon'
    before=unchanged(page);n=page.evaluate('drawing.points.length')
    x,y=center(page,selectors[1]);touch(cdp,'touchStart',[(2,x,y)]);page.wait_for_timeout(580);touch(cdp,'touchEnd',[])
    expect(page.locator('#sentlogToolTip')).to_be_visible()
    page.touchscreen.tap(width*.7,height*.65);assert unchanged(page)==before
    page.touchscreen.tap(width*.7,height*.65);assert page.evaluate('drawing.points.length')==n+1
    page.locator(selectors[0]).tap();assert page.evaluate('tool')=='pan'
    # Direct toolbar command immediately after a hold remains usable.
    x,y=center(page,'#undoBtn');touch(cdp,'touchStart',[(3,x,y)]);page.wait_for_timeout(580);touch(cdp,'touchEnd',[])
    assert page.evaluate('state.shapes[0].memo')=='編集後'
    page.locator('#undoBtn').tap();assert page.evaluate('state.shapes[0].memo')=='保持確認'
    page.locator('#redoBtn').tap();assert page.evaluate('state.shapes[0].memo')=='編集後'
   else:
    page.locator(selectors[0]).hover();page.wait_for_timeout(420)
    expect(page.locator('#sentlogToolTip')).to_be_visible();check_tip(page,selectors[0],width,height)
    assert page.locator('#sentlogToolTip').get_attribute('data-placement')=='below'
    screenshot(page,'toolbar-help-pc-1280.png')
    page.keyboard.press('Escape');expect(page.locator('#sentlogToolTip')).not_to_be_visible()
   assert page.evaluate('state.shapes[0].photos[0].id')=='photo1'
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   assert not errors,errors;assert not unexpected,unexpected
   print(f'PASS v1.52 {width}x{height}: readable help, bounded non-overlap, no extra row, hold release, outside dismissal, draft/undo/photos unchanged')
   context.close()
  browser.close()
finally:server.shutdown();server.server_close()

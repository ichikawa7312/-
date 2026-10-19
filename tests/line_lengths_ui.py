"""Real built app, synthetic damage records, native persistence; no production I/O."""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
import functools,threading,os,tempfile,json,math
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
engine=os.getenv('SENTLOG_TEST_BROWSER','chromium')
seed="""async()=>{
 await window.sentlogAppReady;
 workspace={projects:[{id:'ll-p',name:'線長検証',drawings:[{id:'ll-d',name:'試験図',fileName:'test.png',sourceType:'image',pageCount:1}],createdAt:1,updatedAt:1}]};
 activeProjectId='ll-p';activeDrawingId='ll-d';state=freshDrawingState('線長検証');
 state.sourceType='image';state.fileName='test.png';state.width=1000;state.height=700;state.pageCount=1;state.currentPage=1;
 state.pageSettings['1']={paperSize:'custom',customW:1000,customH:700,scaleDenom:null,orientation:'auto'};
 state.shapes=[
  {id:'straight',kind:'line',type:'漏水',points:[{x:100,y:140},{x:300,y:140}],labelPos:{x:260,y:90},page:1,photos:[{id:'p-straight',name:'keep.jpg'}],memo:'keep memo',no:'実測A'},
  {id:'curve',kind:'freehand-line',type:'ひび割れ',points:[{x:100,y:400},{x:160,y:480},{x:220,y:400}],labelPos:{x:320,y:340},page:1,photos:[{id:'p-curve',name:'keep2.jpg'}],crackWidthMm:.2},
  {id:'other',kind:'rect',type:'剥離',x:600,y:200,w:100,h:100,page:1,photos:[]},
  {id:'page2',kind:'line',type:'漏水',points:[{x:10,y:10},{x:20,y:10}],lineLengthM:9,page:2,photos:[]}
 ];
 rebuildNumberingState();showEditor();setupStage(1000,700);empty.style.display='none';clearAllHistory();persist();fit();render();
}"""
def shape(page,id):return page.evaluate('(id)=>JSON.parse(JSON.stringify(state.shapes.find(s=>s.id===id)))',id)
def near(a,b):assert abs(a-b)<1e-7,(a,b)
def edit(page,id,value):
 page.evaluate('(id)=>{selectShape(id);SentlogLineLengths.open(id)}',id)
 expect(page.locator('.sentlog-line-length-editor')).to_be_visible()
 page.locator('#sentlogLineLengthInput').fill(value)
 page.locator('.sentlog-line-length-editor button[type=submit]').click()
 expect(page.locator('.sentlog-line-length-editor')).to_have_count(0)
def scale_to(page,value):
 page.evaluate("""v=>{paperSize.value='custom';customPaperW.value='1000';customPaperH.value='700';paperOrientation.value='auto';drawingScale.value=v==null?'':'custom';customScale.value=v==null?'':String(v);savePageSettings();}""",value)
def metric(page,id):return page.evaluate('(id)=>lineLengthMm(state.shapes.find(s=>s.id===id).points,1)',id)
def hold_label(page,id,delay=600):
 page.evaluate('(id)=>selectShape(id)',id)
 loc=page.locator('[data-line-length-hit="'+id+'"]');box=loc.bounding_box();assert box
 page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down();page.wait_for_timeout(delay);page.mouse.up()
try:
 with tempfile.TemporaryDirectory(prefix='sentlog-length-ui-') as profile,sync_playwright() as pw:
  opts={'headless':True};executable=os.getenv('SENTLOG_CHROMIUM_EXECUTABLE','/usr/bin/chromium')
  if engine=='chromium' and os.path.exists(executable):opts.update(executable_path=executable,args=['--no-sandbox'])
  browser=None if engine=='webkit' else pw.chromium.launch(**opts)
  for width,height in [(390,844),(820,1000),(1280,900)]:
   context_args=dict(viewport={'width':width,'height':height},has_touch=width<1000,is_mobile=width<500,service_workers='block')
   ctx=browser.new_context(**context_args) if browser else pw.webkit.launch_persistent_context(str(Path(profile)/str(width)),headless=True,**context_args)
   unexpected=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("synthetic only")}};');return
    if 'supabase.co/' in url:rr.abort();return
    unexpected.append(url);rr.abort()
   ctx.route('**/*',route);page=ctx.new_page();errors=[];dialogs=[]
   page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:(dialogs.append(d.message),d.accept()))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   try:page.wait_for_function("window.SENTLOG_BUILD==='v1.82'&&!!window.SentlogLineLengths",timeout=15000)
   except Exception:
    print('BOOT ERRORS',errors,page.locator('body').inner_text()[:1800],flush=True);raise
   page.evaluate(seed);page.wait_for_timeout(80)
   straight0=shape(page,'straight');curve0=shape(page,'curve');other0=shape(page,'other');page20=shape(page,'page2')
   assert page.locator('[data-line-length-id]').count()==0,'unscaled unselected lines must not invent a length'
   hold_label(page,'straight',80);expect(page.locator('.sentlog-line-length-editor')).to_have_count(0)
   if width<1000:
    box=page.locator('[data-line-length-hit="straight"]').bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
    page.touchscreen.tap(x,y);expect(page.locator('.sentlog-line-length-editor')).to_have_count(0)
    if engine=='chromium':
     cdp=ctx.new_cdp_session(page)
     cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
     page.wait_for_timeout(600)
     cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
     expect(page.locator('.sentlog-line-length-editor')).to_be_visible()
     page.locator('.sentlog-line-length-editor button').filter(has_text='閉じる').click();cdp.detach()
   hold_label(page,'straight');expect(page.locator('.sentlog-line-length-editor')).to_be_visible()
   assert '縮尺なし' in page.locator('.sentlog-line-length-editor').inner_text()
   box=page.locator('.sentlog-line-length-editor').bounding_box();assert box['x']>=0 and box['x']+box['width']<=width+1
   page.locator('#sentlogLineLengthInput').fill('0.400');page.locator('.sentlog-line-length-editor button[type=submit]').click()
   edit(page,'curve','0.600')
   for id,before,length in [('straight',straight0,.4),('curve',curve0,.6)]:
    after=shape(page,id);assert after['points']==before['points'] and after['photos']==before['photos']
    assert after['lineLengthM']==length
    assert page.locator('[data-line-length-id="'+id+'"]').text_content()==f'L={length:.3f} m'
   assert shape(page,'curve')['crackWidthMm']==.2
   assert page.locator('[data-crack-width-id="curve"]').text_content()=='W=0.2'
   page.evaluate('undo()');assert 'lineLengthM' not in shape(page,'curve')
   page.evaluate('redo()');assert shape(page,'curve')['lineLengthM']==.6

   scale_to(page,1);near(metric(page,'straight'),400);near(metric(page,'curve'),600)
   assert shape(page,'straight')['points'][0]==straight0['points'][0]
   curve=shape(page,'curve');assert curve['points'][0]==curve0['points'][0]
   for p,q in zip(curve['points'],curve0['points']):
    near(p['x']-100,(q['x']-100)*3);near(p['y']-400,(q['y']-400)*3)
   scale_to(page,2);near(metric(page,'straight'),400);near(metric(page,'curve'),600)
   assert shape(page,'straight')['lineLengthM']==.4 and shape(page,'curve')['lineLengthM']==.6
   current=shape(page,'curve');scale_to(page,None);assert shape(page,'curve')['points']==current['points']
   assert page.evaluate("shapeMeasurement(state.shapes.find(s=>s.id==='curve')).value")==600
   scale_to(page,1)

   # Calibrated edits use the total path length, and Undo restores both geometry and value.
   before=shape(page,'curve');edit(page,'curve','0.300');near(metric(page,'curve'),300)
   page.evaluate('undo()');assert shape(page,'curve')==before
   page.evaluate('redo()');near(metric(page,'curve'),300)
   edit(page,'straight','0.500');near(metric(page,'straight'),500)
   before=shape(page,'straight')
   page.evaluate("SentlogLineLengths.open('straight')")
   page.locator('#sentlogLineLengthInput').fill('2.000');page.locator('.sentlog-line-length-editor button[type=submit]').click()
   assert '図面の外' in page.locator('.sentlog-line-length-editor [role=alert]').inner_text()
   assert shape(page,'straight')==before,'failed resize must not change record or vertices'
   page.locator('#sentlogLineLengthInput').fill('0');page.locator('.sentlog-line-length-editor button[type=submit]').click();assert shape(page,'straight')==before
   page.locator('.sentlog-line-length-editor button').filter(has_text='閉じる').click()

   # A later scale that cannot fit keeps the measured record and flags the mismatch.
   scale_to(page,.1);page.wait_for_timeout(80)
   assert shape(page,'straight')['lineLengthM']==.5
   assert page.locator('[data-line-length-id="straight"]').text_content()=='⚠ L=0.500 m'
   assert dialogs and '線長' in dialogs[-1],dialogs
   scale_to(page,1)
   assert shape(page,'other')==other0 and shape(page,'page2')==page20
   assert shape(page,'straight')['memo']=='keep memo' and shape(page,'straight')['no']=='実測A'
   # Closing or changing the active drawing cannot accidentally edit the former record.
   page.evaluate("SentlogLineLengths.open('straight');activeDrawingId='elsewhere';render()")
   expect(page.locator('.sentlog-line-length-editor')).to_have_count(0)
   page.evaluate("activeDrawingId='ll-d';render();SentlogLineLengths.open('straight')")
   old=shape(page,'straight');page.locator('[data-clear-line-length]').click()
   assert 'lineLengthM' not in shape(page,'straight') and shape(page,'straight')['points']==old['points']
   page.evaluate('undo()');assert shape(page,'straight')==old

   # Export capture includes both W and L as real text, without input placeholders.
   captured=page.evaluate("SentlogDrawingMemos.captureForExport(false,()=>SentlogDxf.capturePrimitives()).filter(x=>x.type==='text').map(x=>x.text)")
   assert 'L=0.500 m' in captured and 'L=0.300 m' in captured and 'W=0.2' in captured,captured
   assert '長さを入力' not in captured,captured
   # Length typography stays readable at overview zoom and compact when zoomed in;
   # its hit area and visible text cannot cover the draggable name or crack width.
   for zoom in [.25,.5,1,2,8]:
    metrics=page.evaluate("""zoom=>{
      scale=zoom;applyTransform();selectShape('curve');
      const length=svg.querySelector('[data-line-length-id="curve"]'),hit=svg.querySelector('[data-line-length-hit="curve"]');
      const name=svg.querySelector('[data-damage-label-id="curve"][data-damage-label-role="name"]'),width=svg.querySelector('[data-crack-width-id="curve"]');
      const l=length.getBBox(),n=name.getBBox(),w=width.getBBox(),h=hit.getBBox(),cy=l.y+l.height/2;
      return {font:Number(length.getAttribute('font-size'))*scale,gap:(l.y-w.y-w.height)*scale,hitGap:(h.y-n.y-n.height)*scale,containsText:h.y<=cy&&h.y+h.height>=cy};
    }""",zoom)
    assert 8.4<=metrics['font']<=12,metrics
    assert metrics['gap']>=-1 and metrics['hitGap']>=0 and metrics['containsText'],metrics
   page.evaluate('fit()')
   page.evaluate("selected=null;render();persist()")
   (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/f'test-results/line-lengths-{engine}-{width}.png'),full_page=True)
   expected=page.evaluate('JSON.stringify(state.shapes)')
   # Wait for the native record-store queue, then reload its actual stored JSON.
   page.wait_for_function("JSON.parse(SentlogRecords.getItem(drawingStorageKey('ll-d'))||'{}').shapes?.find(s=>s.id==='curve')?.lineLengthM===.3")
   page.wait_for_timeout(100)
   page.reload(wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.82'&&!!window.SentlogLineLengths")
   stored=page.evaluate("SentlogRecords.getItem(drawingStorageKey('ll-d'))")
   assert json.loads(stored)['shapes']==json.loads(expected),'native reload must preserve values, IDs, photos and geometry'
   assert not errors,errors;assert not unexpected,unexpected
   print(f'PASS {engine} {width}px: straight/freehand manual metres, path-preserving scale, long press, W+L, bounds, scale transitions, undo/redo, DXF text and native reload',flush=True)
   ctx.close()
  if browser:browser.close()
finally:
 server.shutdown();server.server_close()

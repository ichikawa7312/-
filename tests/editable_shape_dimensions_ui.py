"""Built-app editable completed-shape dimensions; synthetic records only."""
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
 workspace={projects:[{id:'ed-p',name:'辺寸法編集検証',drawings:[{id:'ed-d',name:'平面図',fileName:'synthetic.png',sourceType:'image',pageCount:1}],createdAt:1,updatedAt:1}]};
 activeProjectId='ed-p';activeDrawingId='ed-d';state=freshDrawingState('辺寸法編集検証');
 state.sourceType='image';state.fileName='synthetic.png';state.width=1000;state.height=700;state.pageCount=1;state.currentPage=1;
 state.pageSettings['1']={paperSize:'custom',customW:1000,customH:700,scaleDenom:null,orientation:'auto'};
 state.shapes=[
  {id:'rect1',kind:'rect',type:'剥離',x:100,y:100,w:300,h:150,labelPos:{x:250,y:70},page:1,photos:[]},
  {id:'poly1',kind:'polygon',type:'浮き',points:[{x:500,y:100},{x:700,y:100},{x:700,y:300},{x:500,y:300}],labelPos:{x:600,y:65},page:1,photos:[]},
  {id:'polyBad',kind:'polygon',type:'浮き',points:[{x:500,y:360},{x:650,y:360},{x:650,y:500},{x:500,y:500}],labelPos:{x:575,y:330},page:1,photos:[],edgeDimensionsM:{0:2.000}},
  {id:'crack1',kind:'freehand-line',type:'ひび割れ',points:[{x:120,y:450},{x:260,y:470}],labelPos:{x:190,y:410},page:1,photos:[],crackWidthMm:.2}
 ];
 rebuildNumberingState();showEditor();setupStage(1000,700);empty.style.display='none';clearAllHistory();persist();render();
}"""
def shape(page,id):
 return page.evaluate("(id)=>JSON.parse(JSON.stringify(state.shapes.find(s=>s.id===id)))",id)
def edge_text(page,id,index):
 return page.evaluate("""([id,index])=>{
  const el=[...svg.querySelectorAll('[data-shape-dimension-id="'+id+'"]')].find(x=>x.dataset.edgeIndex===String(index));
  return el?.textContent||null;
 }""",[id,index])
def click_edge(page,id,index):
 page.evaluate("(id)=>{if(selected!==id)selectShape(id)}",id)
 loc=page.evaluate("""([id,index])=>{
  const hit=[...svg.querySelectorAll('[data-shape-dimension-hit-id="'+id+'"]')].find(x=>x.dataset.edgeIndex===String(index));
  if(!hit)return null;const r=hit.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};
 }""",[id,index])
 assert loc and loc['w']>0 and loc['h']>0,(id,index,loc)
 page.mouse.click(loc['x'],loc['y'])
def edit_edge(page,id,index,value,scaled):
 click_edge(page,id,index)
 expect(page.locator('.sentlog-shape-dimension-editor')).to_be_visible()
 body=page.locator('.sentlog-shape-dimension-editor').inner_text()
 assert ('縮尺設定済み' in body)==scaled,body
 assert ('縮尺未設定' in body)==(not scaled),body
 page.locator('.sentlog-shape-dimension-editor input').fill(value)
 page.locator('.sentlog-shape-dimension-editor button[type=submit]').click()
 expect(page.locator('.sentlog-shape-dimension-editor')).to_have_count(0)
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
    rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Synthetic only")}};');return
   if 'supabase.co/' in url:rr.abort();return
   unexpected.append(url);rr.abort()
  ctx.route('**/*',route)
  page=ctx.new_page();errors=[];dialogs=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:(dialogs.append(d.message),d.accept()))
  page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
  page.wait_for_function("window.SENTLOG_BUILD==='v1.75'&&!!window.SentlogShapeDimensions",timeout=20000)
  page.evaluate(seed);page.wait_for_timeout(100)

  rect0=shape(page,'rect1');poly0=shape(page,'poly1')
  assert page.locator('[data-shape-dimension-id]').count()==0
  page.evaluate("selectShape('rect1')")
  assert edge_text(page,'rect1',0)=='寸法'
  assert edge_text(page,'rect1',1)=='寸法'
  assert page.locator('[data-shape-dimension-id="poly1"]').count()==0
  page.evaluate("selectShape('poly1')")
  assert [edge_text(page,'poly1',i) for i in range(4)]==['寸法']*4
  assert page.locator('[data-shape-dimension-id="rect1"]').count()==0

  # Unscaled: values are recorded but geometry must stay exactly where it was drawn.
  edit_edge(page,'rect1',0,'0.800',False)
  assert shape(page,'rect1')['x']==rect0['x'] and shape(page,'rect1')['w']==rect0['w']
  assert shape(page,'rect1')['edgeDimensionsM']['0']==.8
  assert edge_text(page,'rect1',0)=='0.800 m'
  edit_edge(page,'rect1',1,'0.450',False)
  rect=shape(page,'rect1')
  assert rect['x']==rect0['x'] and rect['y']==rect0['y'] and rect['w']==rect0['w'] and rect['h']==rect0['h']
  assert rect['edgeDimensionsM']['1']==.45
  assert page.locator('[data-shape-summary-id="rect1"]').text_content()=='0.800 × 0.450 m'

  edit_edge(page,'poly1',0,'0.300',False)
  assert shape(page,'poly1')['points']==poly0['points'],'unscaled polygon record must not move vertices'
  assert shape(page,'poly1')['edgeDimensionsM']['0']==.3
  assert edge_text(page,'poly1',0)=='0.300 m'

  # Save a 1:1 scale through the real page-settings path. Recorded dimensions
  # are authoritative, so geometry moves to them instead of replacing the records.
  page.evaluate("""()=>{
    paperSize.value='custom';customPaperW.value='1000';customPaperH.value='700';
    paperOrientation.value='auto';drawingScale.value='custom';customScale.value='1';
    savePageSettings();
  }""")
  page.wait_for_timeout(50)
  rect=shape(page,'rect1');poly=shape(page,'poly1')
  assert abs(rect['w']-800)<.01 and abs(rect['h']-450)<.01,rect
  assert rect['edgeDimensionsM']=={'0':.8,'1':.45},rect
  pts=poly['points']
  assert abs(pts[0]['x']-500)<.01 and abs(pts[1]['x']-800)<.01 and abs(pts[2]['x']-800)<.01 and abs(pts[3]['x']-500)<.01,pts
  assert poly['edgeDimensionsM']=={'0':.3},poly
  assert edge_text(page,'rect1',0)=='0.800 m' and edge_text(page,'rect1',1)=='0.450 m'
  assert edge_text(page,'poly1',0)=='0.300 m'
  assert dialogs and '記録 2.000 m' in dialogs[-1],dialogs
  assert shape(page,'polyBad')['edgeDimensionsM']['0']==2
  assert edge_text(page,'polyBad',0).startswith('⚠ 2.000 m'),'unmatched manual value must remain visible with warning'

  # Editing on a calibrated page updates only the touched edge as the authoritative record.
  edit_edge(page,'rect1',0,'0.500',True)
  rect=shape(page,'rect1')
  assert abs(rect['w']-500)<.01 and abs(rect['h']-450)<.01,rect
  assert rect['edgeDimensionsM']=={'0':.5,'1':.45},rect
  assert edge_text(page,'rect1',0)=='0.500 m'
  assert edge_text(page,'rect1',1)=='0.450 m'
  assert page.locator('[data-shape-summary-id="rect1"]').text_content()=='0.500 × 0.450 m'

  edit_edge(page,'poly1',0,'0.400',True)
  poly=shape(page,'poly1');pts=poly['points']
  assert abs(pts[0]['x']-500)<.01 and abs(pts[1]['x']-900)<.01 and abs(pts[2]['x']-900)<.01 and abs(pts[3]['x']-500)<.01,pts
  assert poly['edgeDimensionsM']=={'0':.4},poly
  assert page.evaluate("""()=>{const p=state.shapes.find(s=>s.id==='poly1').points;return p.every((x,i)=>polygonAligned(x,p[(i+1)%p.length]));}""")
  assert edge_text(page,'poly1',0)=='0.400 m'

  # Changing scale again must preserve the same entered real dimensions and move
  # geometry accordingly. At 1:2, the pixel lengths become half of their 1:1 size.
  dialogs.clear()
  page.evaluate("""()=>{
    paperSize.value='custom';customPaperW.value='1000';customPaperH.value='700';
    paperOrientation.value='auto';drawingScale.value='custom';customScale.value='2';
    savePageSettings();
  }""")
  page.wait_for_timeout(50)
  rect=shape(page,'rect1');poly=shape(page,'poly1')
  assert abs(rect['w']-250)<.01 and abs(rect['h']-225)<.01,rect
  assert abs(poly['points'][1]['x']-700)<.01 and abs(poly['points'][2]['x']-700)<.01,poly
  assert rect['edgeDimensionsM']=={'0':.5,'1':.45}
  assert poly['edgeDimensionsM']=={'0':.4}
  assert edge_text(page,'rect1',0)=='0.500 m' and edge_text(page,'rect1',1)=='0.450 m'
  assert edge_text(page,'poly1',0)=='0.400 m'
  assert dialogs and '記録 2.000 m' in dialogs[-1],dialogs

  # Removing scale keeps geometry unchanged and returns to the same stored records.
  before_remove=shape(page,'rect1')
  page.evaluate("state.pageSettings['1'].scaleDenom=null;render()")
  assert shape(page,'rect1')['w']==before_remove['w'] and shape(page,'rect1')['h']==before_remove['h']
  assert edge_text(page,'rect1',0)=='0.500 m'
  assert edge_text(page,'rect1',1)=='0.450 m'
  assert edge_text(page,'poly1',0)=='0.400 m'
  assert page.locator('[data-shape-summary-id="rect1"]').text_content()=='0.500 × 0.450 m'
  assert page.locator('[data-crack-width-id="crack1"]').text_content()=='W=0.2'

  # Stored edge dimensions participate in ordinary Undo/Redo with the same shape id.
  before=shape(page,'rect1')
  edit_edge(page,'rect1',0,'0.650',False)
  assert edge_text(page,'rect1',0)=='0.650 m'
  page.locator('#undoBtn').click();assert shape(page,'rect1')['edgeDimensionsM']==before['edgeDimensionsM']
  page.locator('#redoBtn').click();assert edge_text(page,'rect1',0)=='0.650 m'

  (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'test-results/editable-shape-dimensions.png'),full_page=True)
  assert not errors,errors;assert not unexpected,unexpected
  print('PASS editable shape dimensions UI: manual values survive scale saves, geometry follows entered values, impossible polygon warns without overwriting, scale changes preserve records, undo/redo')
  ctx.close();browser.close()
finally:
 server.shutdown();server.server_close()

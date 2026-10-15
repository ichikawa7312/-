"""Verify instant reclassification on the real built Sentlog at desktop and iPad size.
All data is synthetic in an isolated browser profile; external requests are blocked.
"""
import functools,threading,os,json
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
shapes=[
 {'id':'s1','kind':'freehand-line','page':1,'type':'ひび割れ','strokeWidth':.8,'no':'A','memo':'現場所見',
  'points':[{'x':100,'y':130},{'x':180,'y':160}],'labelPos':{'x':210,'y':95},
  'photos':[{'id':'p-1','name':'photo.jpg'}]},
 {'id':'s2','kind':'polygon','page':2,'type':'浮き','strokeWidth':1.2,
  'points':[{'x':15,'y':15},{'x':30,'y':15},{'x':30,'y':35}],'photos':[]},
 {'id':'s3','kind':'line','page':1,'type':'ひび割れ','strokeWidth':.8,
  'points':[{'x':220,'y':280},{'x':350,'y':290}],'photos':[]},
 {'id':'s4','kind':'rect','page':1,'type':'浮き','strokeWidth':1.2,
  'x':450,'y':230,'w':100,'h':100,'photos':[]}
]
proj={'id':'category-test-project','name':'選択変更テスト','drawings':[{'id':'category-test-drawing','name':'図面A',
 'fileName':'synthetic.png','sourceType':'image','pageCount':2,'createdAt':1,'updatedAt':1}],'createdAt':1,'updatedAt':1}
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  for width in (390,820,1280):
   context=browser.new_context(viewport={'width':width,'height':900},service_workers='block',has_touch=(width!=1280))
   calls=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No real PDF in isolated test")}};');return
    calls.append(url);rr.abort()
   context.route('**/*',route)
   page=context.new_page()
   errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.45'&&!!window.SentlogShapeMove",timeout=18000)
   page.evaluate("""async data=>{
     await window.sentlogAppReady;
     workspace={projects:[data.project]};
     activeProjectId=data.project.id;
     activeDrawingId=data.project.drawings[0].id;
     state=freshDrawingState(data.project.name);
     state.sourceType='image';state.fileName='synthetic.png';state.width=1000;state.height=700;
     state.pageCount=2;state.currentPage=1;state.shapes=data.shapes;
     rebuildNumberingState();clearAllHistory();
     showEditor();selectShape('s1');persist();
     await window.SentlogRecords.settled();
     clearAllHistory();
   }""",{'project':proj,'shapes':shapes})
   assert page.evaluate("state.shapes.map(s=>s.autoLabel)")==['ひび割れ①','浮き①','ひび割れ②','浮き②']
   geometry_before=page.evaluate("JSON.stringify(state.shapes.map(s=>({id:s.id,page:s.page,points:s.points,x:s.x,y:s.y,w:s.w,h:s.h,photos:s.photos,labelPos:s.labelPos,memo:s.memo})))")
   assert page.locator('#damageType').input_value()=='ひび割れ'
   if width<900:page.locator('#mobileHandle').click()
   expect(page.locator('#applyBtn')).to_be_visible()
   # Change the native dropdown; do NOT press the Apply button.
   page.locator('#damageType').select_option('浮き')
   page.wait_for_function("state.shapes[0].type==='浮き' && state.shapes[0].autoLabel==='浮き①'",timeout=5000)
   assert page.locator('#typeNo').input_value()=='浮き①'
   assert page.evaluate("state.shapes.map(s=>s.autoLabel)")==['浮き①','浮き②','ひび割れ①','浮き③']
   assert '浮き①' in page.evaluate("Array.from(document.querySelectorAll('#svg text')).map(t=>t.textContent)")
   assert page.evaluate("historyFor().undo.length")==1
   assert page.evaluate("JSON.stringify(state.shapes.map(s=>({id:s.id,page:s.page,points:s.points,x:s.x,y:s.y,w:s.w,h:s.h,photos:s.photos,labelPos:s.labelPos,memo:s.memo})))")==geometry_before
   assert page.evaluate("async()=>{await window.SentlogRecords.settled(); return JSON.parse(window.SentlogRecords.getItem('surveyFieldNoteDrawingV1:category-test-drawing')).shapes[0].type}")=='浮き'
   # Untouched type selection must not add new history or save a second time.
   page.locator('#damageType').dispatch_event('change')
   assert page.evaluate("historyFor().undo.length")==1
   page.locator('#undoBtn').click()
   assert page.evaluate("state.shapes.map(s=>s.autoLabel)")==['ひび割れ①','浮き①','ひび割れ②','浮き②'], 'Undo restores original cross-page order'
   page.locator('#redoBtn').click()
   assert page.evaluate("state.shapes.map(s=>s.autoLabel)")==['浮き①','浮き②','ひび割れ①','浮き③']
   (ROOT/'test-results').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/f'test-results/instant-damage-type-{width}.png'),full_page=True)
   assert not errors,errors
   assert not calls,calls
   print(f'PASS real built app {width}px: type dropdown instantly renumbers, persists without Apply, undo/redo cross-page, photo/geometry preserved')
   context.close()
  browser.close()
finally:
 server.shutdown();server.server_close()

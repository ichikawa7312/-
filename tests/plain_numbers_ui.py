"""Actual built app, only synthetic records and locally served assets.
Legacy caches + 1,000 numbered records across pages; no real cloud credentials.
"""
import functools,json,os,threading
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
 const project={id:'numbers-p',name:'番号表示の確認（合成データ）',drawings:[{id:'numbers-d',name:'1～1000の表示',fileName:'sample.svg',sourceType:'image',pageCount:2}],createdAt:1,updatedAt:1};
 workspace={projects:[project]};activeProjectId=project.id;activeDrawingId='numbers-d';
 state=freshDrawingState(project.name);state.sourceType='image';state.fileName='sample.svg';state.width=1000;state.height=1000;
 const visible=[1,25,50,51,99,100,128,999,1000];
 const legacy=n=>n<=20?String.fromCodePoint(0x2460+n-1):n<=35?String.fromCodePoint(0x3251+n-21):n<=50?String.fromCodePoint(0x32b1+n-36):'('+n+')';
 state.shapes=Array.from({length:1000},(_,i)=>{
  const n=i+1,j=visible.indexOf(n),col=j<0?0:j%3,row=j<0?0:Math.floor(j/3);
  return {id:'number-'+n,type:'腐食',typeNo:n,globalNo:n,autoLabel:'腐食'+legacy(n),kind:'rect',page:j<0?2:1,
   x:60+col*310,y:160+row*275,w:220,h:130,labelPos:{x:170+col*310,y:110+row*275},strokeWidth:1.2,
   member:'G1',memo:'合成記録 '+n,no:'任意①-G1',photos:n===50?[{id:'numbers-photo',name:'sample.svg'}]:[]};
 });
 state.nextGlobalNo=1001;state.typeCounters={'腐食':1000};showEditor();clearSelection();
 const image=new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="white"/><path d="M20 40H980V970H20Z M20 365H980M20 645H980" fill="none" stroke="#bbb" stroke-width="1"/></svg>'],{type:'image/svg+xml'});
 await putDBFile('background:numbers-d',image);await putDBFile('photo:numbers-d:numbers-photo',image);
 await openFile(image,false);state.pageCount=2;updatePageUI();persist();await window.SentlogRecords.settled();clearAllHistory();
 window.numberingOriginal=JSON.stringify(state.shapes.map(({autoLabel,...s})=>s));
} """
def core(page):return page.evaluate('JSON.stringify(state.shapes.map(({autoLabel,...s})=>s))')
def stored(page):return page.evaluate("JSON.stringify({state,record:window.SentlogRecords.getItem(drawingStorageKey(activeDrawingId)),history:historyFor()})")
def close_panels(page):
 page.evaluate("document.getElementById('sidebar').classList.remove('open');document.getElementById('inspector').classList.remove('open')")
 page.wait_for_timeout(350)
def mode(page,value):
 page.evaluate("document.getElementById('sidebar').classList.add('open');document.getElementById('sentlogDamageStyleSettings').open=true")
 page.locator('#damageDisplayMode').select_option(value);close_panels(page)
def verify(page,expected_count=9):
 rows=page.evaluate("""()=>[...svg.querySelectorAll('[data-damage-label-role="name"]')].map(t=>{
  const s=state.shapes.find(s=>s.id===t.dataset.damageLabelId),r=t.getBBox(),hit=[...svg.querySelectorAll('[data-label-target]')].find(h=>h.dataset.id===s.id),h=hit?.getBBox();
  return {id:s.id,text:t.textContent,expected:s.type+'-'+s.typeNo,color:t.getAttribute('fill'),font:t.getAttribute('font-size'),
   expectedColor:['hatch','color'].includes(window.SentlogDamageStyles.getMode())?window.SentlogDamageStyles.styleFor(s.type,getProject()).color:'#111827',
   fits:!h||(h.x<=r.x+.1&&h.x+h.width>=r.x+r.width-.1),width:r.width,height:r.height};
 })""")
 assert len(rows)==expected_count,rows
 for r in rows:assert r['text']==r['expected'] and r['color']==r['expectedColor'] and r['fits'],r
 # More digits widen the string, not shrink the font.
 first=next(r for r in rows if r['id']=='number-1');last=next(r for r in rows if r['id']=='number-1000')
 assert first['font']==last['font'] and last['width']>first['width']
 assert page.evaluate("(()=>{const t=svg.querySelector('[data-damage-label-id=\"number-50\"][data-damage-label-role=\"name\"]'),p=[...svg.querySelectorAll('text')].find(x=>x.textContent==='📷1');return Math.abs((Number(p.getAttribute('x'))-(Number(t.getAttribute('x'))+t.getComputedTextLength()/2))*scale-4)<.01})()")
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  for width in (390,820,1280):
   context=browser.new_context(viewport={'width':width,'height':940},has_touch=width<900,service_workers='block',accept_downloads=True)
   calls=[]
   def route(rr):
    u=rr.request.url
    if u.startswith(origin+'/'):rr.continue_();return
    if u.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Synthetic image test")}};');return
    calls.append(u);rr.abort()
   context.route('**/*',route);page=context.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(e.stack or str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.55'&&!!window.SentlogLabelColors")
   page.evaluate(seed);close_panels(page);baseline=stored(page);numeric=core(page);verify(page)
   assert page.evaluate('state.shapes[49].autoLabel')=='腐食㊿','Old cache is not migrated by rendering'
   for display in ('color','mono','original','hatch'):
    mode(page,display);verify(page);assert stored(page)==baseline
   for z in (.05,.25,.5,1,2,8):
    page.evaluate('z=>{scale=z;applyTransform();render()}',z);verify(page);assert stored(page)==baseline
   page.evaluate('fit();render()');close_panels(page)
   (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/f'test-results/plain-numbers-{width}.png'))
   # Stale cached labels also cannot leak into the inspector or rename dialog.
   page.evaluate("selectShape('number-1000')")
   assert page.locator('#typeNo').input_value()=='腐食-1000'
   expect(page.locator('#mobileHandle')).to_contain_text('腐食-1000')
   assert page.locator('#damageNo').input_value()=='任意①-G1'
   page.evaluate("document.getElementById('inspector').classList.add('open')")
   page.locator('#damageNameSearch').click();expect(page.locator('#damageNameModal .dn-target')).to_contain_text('腐食-1000')
   page.locator('#damageNameClose').click();assert stored(page)==baseline
   # Reclassification/Undo keeps its original behavior; only derived text changes.
   context.set_offline(True)
   page.locator('#damageType').select_option('漏水');assert page.locator('#typeNo').input_value()=='漏水-1'
   page.evaluate('undo()');assert core(page)==numeric;verify(page)
   # New number 1001 follows 1000 without changing IDs or existing numerals.
   page.evaluate("clearSelection();document.getElementById('damageType').value='腐食';addShape({kind:'line',points:[{x:20,y:20},{x:30,y:30}]})")
   assert page.evaluate('state.shapes.at(-1).autoLabel')=='腐食-1001'
   assert page.evaluate('state.shapes.at(-1).typeNo')==1001
   assert page.evaluate('JSON.stringify(state.shapes.slice(0,1000).map(({autoLabel,...s})=>s))')==numeric
   numeric=core(page);verify(page,10)
   # Display and photo links survive a normal backup and a real reopen.
   page.evaluate('async()=>{persist();await window.SentlogRecords.settled()}')
   with page.expect_download() as info:page.evaluate('exportSentlogBackup()')
   pack=json.loads(Path(info.value.path()).read_text());shapes=pack['drawingStates']['numbers-d']['shapes']
   assert len(shapes)==1001 and shapes[1000]['typeNo']==1001 and shapes[999]['typeNo']==1000 and shapes[999]['globalNo']==1000
   assert shapes[49]['photos'][0]['id']=='numbers-photo'
   assert any(f['key']=='photo:numbers-d:numbers-photo' for f in pack['files'])
   context.set_offline(False);page.reload(wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.55'&&!!window.SentlogLabelColors")
   page.evaluate("async()=>{await window.sentlogAppReady;await openDrawing('numbers-p','numbers-d')}")
   close_panels(page);assert core(page)==numeric;verify(page,10)
   # Real label dragging remains operational, with no changed photo ownership.
   if width==1280:
    before=core(page);hit=page.locator('[data-label-target][data-id="number-1000"]').bounding_box();x=hit['x']+hit['width']/2;y=hit['y']+hit['height']/2
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+20,y+15,steps=5);page.mouse.up()
    assert core(page)!=before;page.evaluate('undo()');assert core(page)==before;verify(page,10)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   assert not errors,errors
   assert not calls,calls
   print(f'PASS {width}px: 1,000 cross-page legacy records, unchanged numerals/IDs/photos, decimal labels through 1001, stale cache handling, photo spacing, drag targets, four color modes, zoom, undo, offline save/backup/reopen')
   context.close()
  browser.close()
finally:server.shutdown();server.server_close()

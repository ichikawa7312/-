"""Real app, synthetic records only. No credentials or production API access."""
import ast,functools,json,os,threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
# Reuse the existing synthetic fixture without importing/running its test suite.
fixture=ast.parse((ROOT/'tests/damage_styles_ui.py').read_text())
seed=ast.literal_eval(next(n.value for n in fixture.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='seed' for t in n.targets)))
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
def saved(page):
 return page.evaluate("JSON.stringify({state,project:getProject(),history:historyFor(),record:window.SentlogRecords.getItem(drawingStorageKey(activeDrawingId)),workspace:window.SentlogRecords.getItem(WORKSPACE_KEY)})")
def mode(page,value):
 page.evaluate("document.getElementById('sidebar').classList.add('open');document.getElementById('sentlogDamageStyleSettings').open=true")
 page.locator('#damageDisplayMode').select_option(value)
 page.evaluate("document.getElementById('sidebar').classList.remove('open')")
def shot(page,name):
 (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'test-results'/name))
inspect="""()=>[...svg.querySelectorAll('[data-damage-label-role="name"]')].map(e=>{
 const id=e.dataset.damageLabelId,record=state.shapes.find(s=>s.id===id),nodes=[...svg.querySelectorAll('[data-damage-label-id]')].filter(x=>x.dataset.damageLabelId===id);
 const leader=nodes.find(x=>x.dataset.damageLabelRole==='leader'),tip=nodes.find(x=>x.dataset.damageLabelRole==='marker');
 const colored=['hatch','color'].includes(window.SentlogDamageStyles.getMode());
 const expected=colored?window.SentlogDamageStyles.styleFor(record.type,getProject()).color:'#111827';
 return {id,label:e.textContent,color:e.getAttribute('fill'),expected,outline:e.getAttribute('stroke'),halo:Number(e.getAttribute('stroke-width'))*scale,order:e.getAttribute('paint-order'),
  lead:leader?.getAttribute('stroke'),leadWidth:leader?Number(leader.getAttribute('stroke-width'))*scale:null,
  marker:tip?{kind:tip.dataset.damageMarkerKind,fill:tip.getAttribute('fill'),stroke:tip.getAttribute('stroke')}:null};
})"""
def check(page):
 rows=page.evaluate(inspect);assert len(rows)==8,rows
 for r in rows:
  assert r['color']==r['expected'],r
  assert r['outline']=='#FFFFFF' and r['order']=='stroke fill',r
  assert abs(r['halo']-2.2)<1e-7,r
  if r.get('lead'):
   assert r['lead']==r['expected'] and abs(r['leadWidth']-.6)<1e-7,r
  m=r.get('marker')
  if m:
   assert m['fill']==('#FFFFFF' if m['kind']=='open-circle' else r['expected']),r
   assert m['stroke']==('#FFFFFF' if m['kind']=='filled-circle' else r['expected']),r
 return rows
geometry="""()=>JSON.stringify([...svg.children].filter(e=>!['defs','path'].includes(e.localName)).map(e=>({tag:e.localName,text:e.textContent,attrs:[...e.attributes].filter(a=>!['fill','stroke','stroke-width','stroke-linejoin','paint-order','data-damage-group','data-damage-pattern','stroke-dasharray','fill-opacity'].includes(a.name)).map(a=>[a.name,a.value])})))"""
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
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.54'&&!!window.SentlogLabelColors")
   page.evaluate(seed)
   # Alias and project-specific classification without inference from label text.
   page.evaluate("""async()=>{
    state.shapes[0].type='ひびわれ';
    for(const s of state.shapes)s.labelPos.y-=45;
    getProject().damageNamesV1=[{id:'custom',name:'補修材の再剥離',material:'concrete',displayGroup:'loss'}];
    rebuildNumberingState();persist();await window.SentlogRecords.settled();clearAllHistory();render();
   }""")
   base=saved(page);geo=page.evaluate(geometry)
   ui=page.evaluate("getComputedStyle(document.getElementById('damageType')).color")
   colors=check(page);assert len(set(r['color'] for r in colors))==6
   photo=page.evaluate("[...svg.querySelectorAll('text')].find(t=>t.textContent==='📷1').outerHTML")
   for m in ('color','mono','original','hatch'):
    mode(page,m);check(page);assert saved(page)==base
    assert page.evaluate(geometry)==geo,'Display switch must not move label/photo/targets'
    assert page.evaluate("getComputedStyle(document.getElementById('damageType')).color")==ui
    assert page.evaluate("[...svg.querySelectorAll('text')].find(t=>t.textContent==='📷1').outerHTML")==photo
   # Repaint is ID-based and cannot duplicate glyphs or modify records.
   page.evaluate('window.SentlogLabelColors.paint();window.SentlogLabelColors.paint()')
   assert page.locator('[data-damage-label-role="name"]').count()==8 and saved(page)==base
   for z in (.05,.25,.5,1,2,8):
    page.evaluate('z=>{scale=z;applyTransform();render()}',z);check(page)
   page.evaluate('fit();render()')
   # All tip styles keep their geometry while acquiring the correct family paint.
   for kind in ('filled-circle','arrow','none','open-circle'):
    page.evaluate('kind=>{state.leaderMarker=kind;render()}',kind);check(page)
    assert page.locator('[data-damage-label-role="marker"]').count()==(0 if kind=='none' else page.evaluate('currentShapes().filter(s=>s.autoLabel&&shouldDrawLeader(s)).length'))
   page.evaluate("selectShape('style-1')")
   for m in ('mono','original','color','hatch'):
    mode(page,m);check(page)
    if m in ('hatch','color'):assert page.locator('[data-damage-selection]').count()==1
   page.evaluate("document.getElementById('inspector').classList.add('open')")
   before=page.evaluate('JSON.stringify(state.shapes)')
   page.locator('#damageType').select_option('腐食');check(page)
   assert page.locator('[data-damage-label-id="style-1"][data-damage-label-role="name"]').text_content().startswith('腐食')
   page.evaluate('undo()');assert page.evaluate('JSON.stringify(state.shapes)')==before;check(page)
   # Existing custom name group change immediately recolors its whole label chain.
   context.set_offline(True);page.evaluate("selectShape('style-7')")
   page.locator('.damage-name-details > summary').click()
   shapes=page.evaluate('JSON.stringify(state.shapes)')
   page.locator('#damageCustomDisplayGroup').select_option('movement');page.locator('#damageCustomStyleApply').click()
   expect(page.locator('#damageCustomStyleStatus')).to_contain_text('保存しました');check(page)
   assert page.evaluate('JSON.stringify(state.shapes)')==shapes
   # Color changes do not swallow existing text-drag, hit targets or Undo.
   page.evaluate("document.getElementById('inspector').classList.remove('open');clearSelection();fit();render()")
   context.set_offline(False)
   if width==1280:
    target=page.locator('[data-label-target="true"][data-id="style-1"]').bounding_box()
    start=page.evaluate("JSON.stringify(state.shapes)")
    x,y=target['x']+target['width']/2,target['y']+target['height']/2
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+25,y+22,steps=5);page.mouse.up()
    assert page.evaluate('JSON.stringify(state.shapes)')!=start,'Existing label drag must work'
    check(page);page.evaluate('undo()');assert page.evaluate('JSON.stringify(state.shapes)')==start
   page.evaluate('clearSelection();render()')
   shot(page,f'label-colors-{width}.png')
   mode(page,'mono');shot(page,f'label-colors-mono-{width}.png')
   mode(page,'hatch');page.evaluate('async()=>{persist();await window.SentlogRecords.settled()}')
   with page.expect_download() as info:page.evaluate('exportSentlogBackup()')
   pack=json.loads(Path(info.value.path()).read_text());assert pack['workspace']['projects'][0]['damageNamesV1'][0]['displayGroup']=='movement'
   assert 'style-d' in pack['drawingStates']
   assert all('color' not in s and 'labelColor' not in s for s in pack['drawingStates']['style-d']['shapes'])
   page.reload(wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.54'&&!!window.SentlogLabelColors")
   page.evaluate("async()=>{await window.sentlogAppReady;await openDrawing('style-p','style-d')}")
   check(page);assert page.evaluate('window.SentlogDamageStyles.getMode()')=='hatch'
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   assert not errors,errors
   assert not calls,calls
   print(f'PASS {width}px: names/numbers/leaders/tips share group colors; black mono/original; constant white outline; selection and reclassification/undo; offline custom groups; no geometry/photo/input/storage regression; reload')
   context.close()
  browser.close()
finally:server.shutdown();server.server_close()

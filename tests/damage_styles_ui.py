"""Exercise the actual built app with synthetic records; block all external APIs."""
import functools, json, os, threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
seed="""async()=>{
 await window.sentlogAppReady;
 const p={id:'style-p',name:'色・模様の表示確認',drawings:[{id:'style-d',name:'合成図面',fileName:'sample.svg',sourceType:'image',pageCount:1}],createdAt:1,updatedAt:1};
 workspace={projects:[p]};activeProjectId=p.id;activeDrawingId='style-d';
 state=freshDrawingState(p.name);state.sourceType='image';state.fileName='sample.svg';
 const types=['ひび割れ','浮き','剥離','漏水','腐食','変形','その他','補修材の再剥離'];
 state.shapes=types.map((type,i)=>({id:'style-'+i,type,kind:i===0?'freehand-line':'rect',page:1,
   x:60+i%3*310,y:130+Math.floor(i/3)*270,w:230,h:160,
   points:i===0?[{x:60,y:170},{x:140,y:155},{x:210,y:230},{x:290,y:200}]:undefined,
   labelPos:{x:175+i%3*310,y:95+Math.floor(i/3)*270},strokeWidth:1.2,
   member:'試験部材',memo:'合成データ',photos:i===1?[{id:'photo1',name:'sample.svg'}]:[]}));
 rebuildNumberingState();showEditor();setupStage(1000,940);clearSelection();persist();
 const image=new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="940"><rect width="1000" height="940" fill="white"/><path d="M20 40H980V910H20Z M20 360H980M20 640H980" fill="none" stroke="#b9b9b9" stroke-width="1"/></svg>'],{type:'image/svg+xml'});
 await putDBFile('background:style-d',image);await putDBFile('photo:style-d:photo1',image);
 await openFile(image,false);persist();await window.SentlogRecords.settled();clearAllHistory();
} """
def snapshot(page):return page.evaluate("JSON.stringify({state,project:getProject(),history:historyFor(),record:window.SentlogRecords.getItem(drawingStorageKey(activeDrawingId)),workspace:window.SentlogRecords.getItem(WORKSPACE_KEY)})")
def show_settings(page):
 page.evaluate("document.getElementById('sidebar').classList.add('open');document.getElementById('sentlogDamageStyleSettings').open=true")
def hide_panels(page):
 page.evaluate("document.getElementById('sidebar').classList.remove('open');document.getElementById('inspector').classList.remove('open')")
def inspector(page):
 page.evaluate("document.getElementById('sidebar').classList.remove('open');document.getElementById('inspector').classList.add('open')")
def shot(page,name):
 (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'test-results'/name))
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
   page.wait_for_function("window.SENTLOG_BUILD==='v1.53'&&!!window.SentlogDamageStyles")
   page.evaluate(seed);base=snapshot(page)
   assert page.locator('#svg [data-damage-group]').count()==8
   assert page.locator('#svg [data-id="style-1"][data-damage-group]').get_attribute('data-damage-pattern')=='rise'
   assert page.locator('#svg [data-id="style-2"][data-damage-group]').get_attribute('data-damage-pattern')=='fall'
   assert page.locator('#svg [data-id="style-7"][data-damage-group]').get_attribute('data-damage-group')=='other'
   colors=page.evaluate("[...new Set([...svg.querySelectorAll('[data-damage-group]')].map(e=>e.getAttribute('stroke')))]")
   assert len(colors)==6,colors
   show_settings(page)
   for mode in ('color','mono','original','hatch'):
    page.locator('#damageDisplayMode').select_option(mode)
    assert snapshot(page)==base,'View mode must not write annotations or timestamps'
    if mode=='original':assert page.locator('#svg [data-damage-group]').count()==0
    if mode=='mono':assert page.evaluate("[...svg.querySelectorAll('[data-damage-group]')].every(e=>e.getAttribute('stroke')==='#333333')")
   hide_panels(page);shot(page,f'damage-styles-{width}.png')
   # Zoom-stable hatch spacing and user-defined screen-pixel outline width.
   for z in (.05,.25,.5,1,2,8):
    page.evaluate('(z)=>{scale=z;applyTransform();render()}',z)
    values=page.evaluate("({transform:svg.querySelector('pattern').getAttribute('patternTransform'),width:svg.querySelector('[data-damage-group]').getAttribute('stroke-width'),defs:svg.querySelectorAll('defs[data-damage-patterns]').length})")
    assert abs(float(values['width'])*z-1.2)<.0001,values
    assert abs(float(values['transform'][6:-1])*z-1)<.0001,values
    assert values['defs']==1
   page.evaluate('fit();render()')
   # Instant reclassification and Undo update appearance without moving geometry/photos.
   page.evaluate("selectShape('style-1')");inspector(page)
   before=page.evaluate('JSON.stringify(state.shapes)')
   keep=page.evaluate("JSON.stringify(state.shapes.map(({id,x,y,w,h,points,labelPos,photos,strokeWidth,member,memo})=>({id,x,y,w,h,points,labelPos,photos,strokeWidth,member,memo})))")
   page.locator('#damageType').select_option('腐食')
   assert page.locator('#svg [data-id="style-1"][data-damage-group]').get_attribute('data-damage-group')=='corrosion'
   assert page.locator('#svg [data-damage-selection]').count()==1
   page.evaluate('undo()');assert page.evaluate('JSON.stringify(state.shapes)')==before
   assert page.locator('#svg [data-id="style-1"][data-damage-group]').get_attribute('data-damage-pattern')=='rise'
   assert page.evaluate("JSON.stringify(state.shapes.map(({id,x,y,w,h,points,labelPos,photos,strokeWidth,member,memo})=>({id,x,y,w,h,points,labelPos,photos,strokeWidth,member,memo})))")==keep
   # Add a classified custom name while offline. Existing unknown names are not guessed.
   page.evaluate("selectShape('style-7')");context.set_offline(True)
   page.locator('#damageNameSearch').click();page.locator('#damageNameInput').fill('補修材の再剥離A')
   page.locator('#damageNameDisplayGroup').select_option('loss');page.locator('#damageNameSave').click()
   expect(page.locator('#damageNameModal')).not_to_be_visible()
   assert page.evaluate('getProject().damageNamesV1[0].displayGroup')=='loss'
   assert page.locator('#svg [data-id="style-7"][data-damage-group]').get_attribute('data-damage-group')=='loss'
   # Optional means optional: new unknown names default to neutral even if a keyword matches.
   page.evaluate('clearSelection()');page.locator('#damageNameSearch').click()
   assert page.locator('#damageNameDisplayGroup').input_value()=='other'
   page.locator('#damageNameInput').fill('漏水かどうか未確認A');page.locator('#damageNameSave').click()
   expect(page.locator('#damageNameModal')).not_to_be_visible()
   assert page.evaluate('getProject().damageNamesV1[1].displayGroup')=='other'
   page.evaluate("selectShape('style-7')")
   page.locator('.damage-name-details > summary').click()
   custom_before=page.evaluate('JSON.stringify(state.shapes)')
   page.locator('#damageCustomDisplayGroup').select_option('movement');page.locator('#damageCustomStyleApply').click()
   expect(page.locator('#damageCustomStyleStatus')).to_contain_text('保存しました')
   assert page.evaluate('JSON.stringify(state.shapes)')==custom_before
   assert page.locator('#svg [data-id="style-7"][data-damage-group]').get_attribute('data-damage-group')=='movement'
   assert page.evaluate("JSON.parse(window.SentlogRecords.getItem(WORKSPACE_KEY)).projects[0].damageNamesV1[0].displayGroup")=='movement'
   context.set_offline(False)
   with page.expect_download() as info:page.evaluate('exportSentlogBackup()')
   pack=json.loads(Path(info.value.path()).read_text())
   assert pack['workspace']['projects'][0]['damageNamesV1'][0]['displayGroup']=='movement'
   # Reload must preserve project classification and local display mode.
   show_settings(page);page.locator('#damageDisplayMode').select_option('mono');hide_panels(page);shot(page,f'damage-styles-mono-{width}.png')
   page.reload(wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.53'&&!!window.SentlogDamageStyles")
   page.evaluate("async()=>{await window.sentlogAppReady;await openDrawing('style-p','style-d')}")
   assert page.evaluate('window.SentlogDamageStyles.getMode()')=='mono'
   assert page.locator('#svg [data-id="style-7"][data-damage-group]').get_attribute('data-damage-group')=='movement'
   # Other projects cannot inherit custom name families, and no model is mutated by lookup.
   assert page.evaluate("window.SentlogDamageStyles.resolve('補修材の再剥離A',{id:'different-project'}).key")=='other'
   show_settings(page);page.locator('#damageDisplayMode').select_option('hatch')
   shot(page,f'damage-styles-legend-{width}.png')
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
   assert not errors,errors
   assert not calls,calls
   print(f'PASS {width}px: 6 colors + float/peel patterns; zoom-stable hatch; four view modes without record writes; instant reclass/undo/selection; offline optional custom family; backup/reload; project isolation')
   context.close()
  browser.close()
finally:server.shutdown();server.server_close()

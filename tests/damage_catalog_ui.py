"""Real built app: synthetic data only, no login or external API requests.
Check field naming offline at phone/tablet/desktop size, persistence, project
isolation, undo, data preservation, search, sources, validation and sync guard.
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
 const p={id:'names-test-p',name:'名称テスト（架空）',createdAt:1,updatedAt:1,
 drawings:[{id:'names-test-d',name:'図面A',fileName:'sample.svg',sourceType:'image',pageCount:1,updatedAt:1}]};
 const other={id:'names-other-p',name:'別案件（架空）',createdAt:1,updatedAt:1,
 drawings:[{id:'names-other-d',name:'図面B',fileName:'sample.svg',sourceType:'image',pageCount:1,updatedAt:1}]};
 workspace={projects:[p,other]};activeProjectId=p.id;activeDrawingId=p.drawings[0].id;
 state=freshDrawingState(p.name);state.fileName='sample.svg';state.sourceType='image';
 state.width=1000;state.height=700;
 state.shapes=[
  {id:'old-1',type:'ひび割れ',kind:'line',page:1,points:[{x:100,y:100},{'x':400,'y':160}],photos:[{id:'ph1',name:'synthetic.png'}],memo:'元のメモ',member:'堰柱',no:'X',strokeWidth:1.2,labelPos:{x:300,y:90}},
  {id:'old-2',type:'ひびわれ',kind:'rect',page:1,x:250,y:280,w:100,h:80,photos:[]},
  {id:'old-3',type:'腐食',kind:'rect',page:1,x:600,y:300,w:100,h:80,photos:[]}
 ];
 rebuildNumberingState();clearAllHistory();showEditor();setupStage(1000,700);selectShape('old-1');persist();
 const image=new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="white"/></svg>'],{type:'image/svg+xml'});
 await putDBFile('background:names-test-d',image);await putDBFile('background:names-other-d',image);
 await putDBFile('photo:names-test-d:ph1',image);
 window.SentlogRecords.setItem(drawingStorageKey('names-other-d'),JSON.stringify({...freshDrawingState(other.name),sourceType:'image',fileName:'sample.svg'}));
 saveWorkspace();await window.SentlogRecords.settled();clearAllHistory();
} """
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  for width in (390,820,1280):
   context=browser.new_context(viewport={'width':width,'height':900},service_workers='block',has_touch=width<900,accept_downloads=True)
   calls=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Synthetic image test: PDF rendering is not used")}};');return
    calls.append(url);rr.abort()
   context.route('**/*',route)
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(e.stack or str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.50'&&!!window.SentlogDamageCatalog")
   page.evaluate(seed)
   if width<900:page.locator('#mobileHandle').click()
   before=page.evaluate('JSON.stringify(state.shapes)')
   geom=page.evaluate("JSON.stringify(state.shapes.map(({id,points,x,y,w,h,photos,labelPos,memo,member,no})=>({id,points,x,y,w,h,photos,labelPos,memo,member,no})))")
   page.locator('#damageMaterial').select_option('concrete')
   assert page.evaluate('JSON.stringify(state.shapes)')==before
   assert page.locator('#damageType option[value="ポップアウト"]').count()==1
   assert page.locator('#damageType option[value="漏水"]').count()==1
   assert page.locator('#damageType option[value="亀裂"]').count()==0
   assert page.evaluate('historyFor().undo.length')==0
   # Historical spelling must stay selectable without changing it on selection.
   page.evaluate("selectShape('old-2')")
   assert page.locator('#damageType').input_value()=='ひびわれ'
   assert page.evaluate('JSON.stringify(state.shapes)')==before
   page.evaluate("selectShape('old-1')")
   page.locator('#damageNameSearch').click()
   page.locator('#damageNameQuery').fill('うき')
   expect(page.locator('#damageNameResults button[data-damage-name="浮き"]')).to_be_visible()
   page.locator('#damageNameClose').click()
   assert page.evaluate('JSON.stringify(state.shapes)')==before,'Cancel is read-only'
   # Offline custom name addition, instant reclassification, no Apply.
   context.set_offline(True)
   page.locator('#damageNameSearch').click()
   page.locator('#damageNameSave').click()
   expect(page.locator('#damageNameError')).to_contain_text('入力してください')
   page.locator('#damageNameInput').fill('あ'*41);page.locator('#damageNameSave').click()
   expect(page.locator('#damageNameError')).to_contain_text('40文字')
   page.locator('#damageNameInput').fill('補修材の再剥離')
   page.locator('#damageNameCustomMaterial').select_option('concrete')
   page.locator('#damageNameSave').click()
   expect(page.locator('#damageNameModal')).not_to_be_visible()
   assert page.evaluate("state.shapes[0].type")=='補修材の再剥離'
   assert page.evaluate('historyFor().undo.length')==1
   assert page.evaluate("JSON.stringify(state.shapes.map(({id,points,x,y,w,h,photos,labelPos,memo,member,no})=>({id,points,x,y,w,h,photos,labelPos,memo,member,no})))")==geom
   assert page.evaluate("JSON.parse(window.SentlogRecords.getItem(WORKSPACE_KEY)).projects[0].damageNamesV1[0].name")=='補修材の再剥離'
   assert page.evaluate("JSON.parse(window.SentlogRecords.getItem(drawingStorageKey(activeDrawingId))).shapes[0].type")=='補修材の再剥離'
   page.evaluate('undo()');assert page.evaluate('JSON.stringify(state.shapes)')==before
   page.evaluate('redo()');assert page.evaluate('state.shapes[0].type')=='補修材の再剥離'
   page.evaluate("selectShape('old-1')")
   # Duplicate registration reuses the name; it must not add another entry/history.
   page.locator('#damageNameSearch').click();page.locator('#damageNameInput').fill(' 補修材の再剥離 ');page.locator('#damageNameSave').click()
   expect(page.locator('#damageNameModal')).not_to_be_visible()
   assert page.evaluate('getProject().damageNamesV1.length')==1
   # Modal blocks incoming replacement, including when inputs are not focused.
   page.locator('#damageNameSearch').click()
   result=page.evaluate("""async()=>{
    const remote=JSON.parse(JSON.stringify(getProject()));remote.damageNamesV1=[];
    return window.sentlogSyncView.commit({client_key:activeProjectId},{payload:{project:remote,drawings:[{meta:getDrawingMeta(),state:JSON.parse(JSON.stringify(state))}]}},JSON.stringify(getProject()));
   }""")
   assert result.get('applied') is False and result.get('reason')=='editing',result
   page.locator('#damageNameClose').click()
   # An IndexedDB failure must never be reported as a completed save.
   page.evaluate("()=>{window.__settled=window.SentlogRecords.settled;window.SentlogRecords.settled=()=>Promise.reject(Error('synthetic storage failure'));}")
   page.locator('#damageNameSearch').click();page.locator('#damageNameQuery').fill('ポップアウト')
   page.locator('#damageNameResults button[data-damage-name="ポップアウト"]').click()
   expect(page.locator('#damageNameError')).to_contain_text('保存を確認できません')
   expect(page.locator('#damageNameModal')).to_be_visible()
   page.evaluate('()=>{window.SentlogRecords.settled=window.__settled;}')
   page.locator('#damageNameClose').click()
   page.locator('#damageType').select_option('補修材の再剥離')
   page.evaluate('async()=>{await window.SentlogRecords.settled()}')
   context.set_offline(False)
   # Existing backup format transports the project-level names without a schema change.
   with page.expect_download() as download_info:page.evaluate('exportSentlogBackup()')
   pack=json.loads(Path(download_info.value.path()).read_text())
   assert pack['workspace']['projects'][0]['damageNamesV1'][0]['name']=='補修材の再剥離'
   # Reload uses persisted names; other projects must not inherit private name lists.
   page.reload(wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.50'&&!!window.SentlogDamageCatalog")
   page.evaluate("async()=>{await window.sentlogAppReady;await openDrawing('names-test-p','names-test-d');selectShape('old-1')}")
   assert page.locator('#damageMaterial').input_value()=='concrete'
   assert page.locator('#damageType').input_value()=='補修材の再剥離'
   if width<900:page.locator('#mobileHandle').click()
   page.locator('#damageNameSearch').click();page.locator('#damageNameQuery').fill('剥離')
   (ROOT/'test-results').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/f'test-results/damage-catalog-{width}.png'),full_page=True)
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
   page.locator('#damageNameClose').click()
   page.evaluate("async()=>{showDrawings('names-test-p');showDrawings('names-other-p');await openDrawing('names-other-p','names-other-d')}")
   assert page.locator('#damageType option[value="補修材の再剥離"]').count()==0
   assert page.evaluate('!!getProject().damageNamesV1') is False
   assert not errors,errors
   assert not calls,calls
   print(f'PASS {width}px: material/read-only filters, aliases, offline custom names, undo/photos, duplicate/cancel, storage failure, sync guard, backup/reload/project isolation')
   context.close()
  browser.close()
finally:
 server.shutdown();server.server_close()

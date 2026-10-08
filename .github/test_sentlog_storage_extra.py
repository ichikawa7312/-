"""Extra tests run on localhost in disposable browser profiles. No real cloud traffic."""
import runpy,json,threading,functools,http.server
from playwright.sync_api import sync_playwright
h=runpy.run_path('.github/test_sentlog_storage.py')
h['server'].server_close()
server=http.server.ThreadingHTTPServer(('127.0.0.1',8765),functools.partial(h['Handler'],directory=str(h['SITE'])))
threading.Thread(target=server.serve_forever,daemon=True).start()
OUT=h['OUT'];passed=h['passed'];disk=h['disk'];DR=h['DR']
def fail_write(page,key):
 # CDP quota overrides did not trigger an error in this browser build. Instead,
 # exercise the real aborted-transaction path after a request succeeds but before
 # commit. This simulates an interrupted save; it is not a native quota test.
 page.evaluate('''key=>{window.storageTestPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,k){const request=storageTestPut.apply(this,arguments);if(k===key){const tx=this.transaction;request.addEventListener('success',()=>tx.abort(),{once:true});}return request;};}''',key)
def restore_writes(page):
 page.evaluate('IDBObjectStore.prototype.put=storageTestPut')
with sync_playwright() as pw:
 browser=pw.chromium.launch();ctx=browser.new_context(service_workers='block',viewport={'width':390,'height':844},has_touch=True,is_mobile=True)
 ctx.route('**/*',h['route']);page=h['launch'](ctx);h['seed'](page);h['open_app'](page)
 old=disk(page,DR+'d1');fail_write(page,'__sentlog_record__:'+DR+'d1')
 page.evaluate("SentlogRecords.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify({...JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1')),pendingTest:'q'.repeat(1024*1024)}))")
 page.wait_for_function('SentlogRecords.failed')
 assert disk(page,DR+'d1')==old
 assert page.locator('#sentlogStorageWarning').is_visible()
 page.screenshot(path=str(OUT/'local-save-warning.png'))
 restore_writes(page)
 page.locator('#sentlogStorageWarning .retry').click();page.wait_for_function('!SentlogRecords.failed && !SentlogRecords.pending')
 assert len(json.loads(disk(page,DR+'d1'))['pendingTest'])==1024*1024
 passed('Simulated transaction failure preserves previous records and pending edit; warning and retry work')
 page.evaluate("async()=>{let s=JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1'));delete s.pendingTest;SentlogRecords.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify(s));await SentlogRecords.settled()}")
 # A sync snapshot must persist without changing the currently viewed page or zoom.
 page.evaluate('openDrawing("p1","d1")');page.wait_for_function('pdfDoc && loading.style.display==="none"');page.evaluate('zoomCenter(1.5)');page.evaluate('SentlogRecords.settled()')
 before=page.evaluate('({page:state.currentPage,scale,tx,ty,view:currentView})')
 result=page.evaluate('''async()=>{const project=JSON.parse(SentlogRecords.getItem('surveyFieldNoteWorkspaceV1')).projects[0];const expected=JSON.stringify(project);const incoming=JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1'));incoming.shapes[0].memo='同期テストの変更';return sentlogSyncView.commit({client_key:'p1'},{payload:{project,drawings:[{meta:project.drawings[0],state:incoming}]}},expected)}''')
 assert result['applied']
 assert page.evaluate('({page:state.currentPage,scale,tx,ty,view:currentView})')==before
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='同期テストの変更'
 passed('Incoming snapshot commits to IDB without navigation or viewport reset')
 # Binary data is retained in memory on a failed transaction and can be retried too.
 fail_write(page,'photo:d1:retry-test')
 value=page.evaluate('''async()=>{try{await putDBFile('photo:d1:retry-test',new Blob(['p'.repeat(1024*1024)],{type:'image/jpeg'}));return false}catch(e){return true}}''')
 assert value and page.evaluate('SentlogRecords.failed')
 restore_writes(page);page.evaluate('SentlogRecords.retry()')
 assert not page.evaluate('SentlogRecords.failed')
 assert page.evaluate("getDBFile('photo:d1:retry-test').then(f=>f.size)")==1024*1024
 passed('PDF/photo transaction failure retains content for explicit retry')
 ctx.set_offline(True)
 page.evaluate("async()=>{state.shapes[0].memo='オフライン保存';persist();await SentlogRecords.settled()}")
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='オフライン保存'
 passed('Offline annotation edit commits to IndexedDB')
 ctx.close()
 # The full cloud synchronizer runs only against intercepted synthetic responses.
 ctx=browser.new_context(service_workers='block');ctx.route('**/*',h['route'])
 page=h['launch'](ctx);h['open_app'](page)
 local={'id':'mock-project','name':'Mock local project','drawings':[],'updatedAt':1}
 page.evaluate('''async p=>{SentlogRecords.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify({projects:[p]}));await SentlogRecords.settled();localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'TEST_ONLY',expires_at:Date.now()/1000+3600,user:{id:'mock-owner',email:'test@example.invalid'}}));localStorage.setItem('sentlogCloudDeviceV1','mock-device');}''',local)
 uploaded=[];remote={};cloud={'id':'mock-cloud-project','client_key':'mock-project','name':'Mock local project'}
 def mock(route):
  req=route.request;u=req.url;out=[]
  if 'sentlog_devices' in u:out=[{'id':'mock-device','active':True}]
  elif 'sentlog_projects' in u:out=[cloud]
  elif 'sentlog_project_snapshots' in u:
   if req.method=='POST':
    body=req.post_data_json;uploaded.append(body);remote['snapshot']=body;out=[body]
   else:out=[remote['snapshot']] if 'snapshot' in remote else []
  route.fulfill(status=200,body=json.dumps(out),content_type='application/json')
 ctx.route('https://wiulvaqixphuobdielyy.supabase.co/**',mock)
 page.reload();page.wait_for_function('window.SENTLOG_BUILD==="v1.30"');page.evaluate('window.sentlogAppReady');page.wait_for_timeout(1800)
 assert uploaded and uploaded[0]['payload']['project']['id']=='mock-project'
 assert json.loads(disk(page,'sentlogCloudProjectSyncV2:mock-project'))['revision']==1
 remote['snapshot']={'project_id':'mock-cloud-project','revision':2,'updated_at':'2026-10-08T00:00:00Z','payload':{'project':{**local,'name':'Mock remote update','updatedAt':2},'drawings':[]}}
 page.wait_for_function('workspace.projects[0].name==="Mock remote update"',timeout=15000)
 page.evaluate('SentlogRecords.settled()')
 assert json.loads(disk(page,'surveyFieldNoteWorkspaceV1'))['projects'][0]['name']=='Mock remote update'
 assert page.evaluate('localStorage.getItem("surveyFieldNoteWorkspaceV1")') is None
 passed('Mocked cloud upload and incoming update use migrated records rather than localStorage')
 ctx.close();browser.close()
 # WebKit engine storage + viewport smoke test; this is not a real-device test.
 browser=pw.webkit.launch();ctx=browser.new_context(service_workers='block',viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 ctx.route('**/*',h['route']);page=h['launch'](ctx);h['seed'](page);h['open_app'](page)
 page.evaluate('openDrawing("p1","d1")');page.wait_for_function('pdfDoc && loading.style.display==="none"')
 page.evaluate("async()=>{state.shapes[0].memo='WebKit保存テスト';persist();await SentlogRecords.settled()}")
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='WebKit保存テスト'
 page.reload();page.wait_for_function('window.SENTLOG_BUILD==="v1.30"');page.evaluate('window.sentlogAppReady')
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='WebKit保存テスト'
 page.locator('#sentlogSettingsBtn').click();page.locator('#sentlogStorageSection summary').click();page.wait_for_function('document.querySelector("#sentlogStorageRows").children.length>6')
 page.screenshot(path=str(OUT/'webkit-storage-settings.png'))
 passed('WebKit engine: legacy migration record save reload and capacity settings')
 ctx.close();browser.close()
server.shutdown();server.server_close()

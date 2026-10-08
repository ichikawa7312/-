"""Extra tests run on localhost in disposable browser profiles. No cloud traffic."""
import runpy,json,threading,functools,http.server
from playwright.sync_api import sync_playwright
h=runpy.run_path('.github/test_sentlog_storage.py')
h['server'].server_close()
server=http.server.ThreadingHTTPServer(('127.0.0.1',8765),functools.partial(h['Handler'],directory=str(h['SITE'])))
threading.Thread(target=server.serve_forever,daemon=True).start()
OUT=h['OUT'];passed=h['passed'];disk=h['disk'];DR=h['DR']
with sync_playwright() as pw:
 browser=pw.chromium.launch();ctx=browser.new_context(service_workers='block',viewport={'width':390,'height':844},has_touch=True,is_mobile=True)
 ctx.route('**/*',h['route']);page=h['launch'](ctx);h['seed'](page);h['open_app'](page)
 # CDP's test quota applies only to this disposable localhost origin. Avoid
 # compressible payloads and allow the engine's cached space allowance to expire.
 cdp=ctx.new_cdp_session(page);origin='http://127.0.0.1:8765'
 cdp.send('Storage.overrideQuotaForOrigin',{'origin':origin,'quotaSize':0})
 info=cdp.send('Storage.getUsageAndQuota',{'origin':origin});print('Test quota override',info,flush=True)
 assert info['overrideActive'] and info['quota']==0
 page.wait_for_timeout(65000)
 old=disk(page,DR+'d1')
 page.evaluate("""()=>{const chunks=[];for(let i=0;i<128;i++){const a=crypto.getRandomValues(new Uint8Array(32768));chunks.push(btoa(String.fromCharCode(...a)));}window.quotaTestSize=chunks.join('').length;SentlogRecords.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify({...JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1')),quotaTest:chunks.join('')}));}""")
 page.wait_for_function('SentlogRecords.failed')
 assert disk(page,DR+'d1')==old
 assert page.locator('#sentlogStorageWarning').is_visible()
 page.screenshot(path=str(OUT/'local-save-warning.png'))
 cdp.send('Storage.overrideQuotaForOrigin',{'origin':origin})
 page.locator('#sentlogStorageWarning .retry').click();page.wait_for_function('!SentlogRecords.failed && !SentlogRecords.pending')
 assert len(json.loads(disk(page,DR+'d1'))['quotaTest'])==page.evaluate('window.quotaTestSize')
 passed('Native IndexedDB quota test preserves old data and pending edit; retry succeeds')
 page.evaluate("async()=>{let s=JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1'));delete s.quotaTest;SentlogRecords.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify(s));await SentlogRecords.settled()}")
 # A sync snapshot must persist without changing the currently viewed page or zoom.
 page.evaluate('openDrawing("p1","d1")');page.wait_for_function('pdfDoc && loading.style.display==="none"');page.evaluate('zoomCenter(1.5)');page.evaluate('SentlogRecords.settled()')
 before=page.evaluate('({page:state.currentPage,scale,tx,ty,view:currentView})')
 result=page.evaluate('''async()=>{const project=JSON.parse(SentlogRecords.getItem('surveyFieldNoteWorkspaceV1')).projects[0];const expected=JSON.stringify(project);const incoming=JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1'));incoming.shapes[0].memo='同期テストの変更';return sentlogSyncView.commit({client_key:'p1'},{payload:{project,drawings:[{meta:project.drawings[0],state:incoming}]}},expected)}''')
 assert result['applied']
 assert page.evaluate('({page:state.currentPage,scale,tx,ty,view:currentView})')==before
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='同期テストの変更'
 passed('Incoming snapshot commits to IDB without navigation or viewport reset')
 # Binary data is retained in memory on quota failure and can be retried too.
 cdp.send('Storage.overrideQuotaForOrigin',{'origin':origin,'quotaSize':0});page.wait_for_timeout(65000)
 value=page.evaluate('''async()=>{const chunks=Array.from({length:64},()=>crypto.getRandomValues(new Uint8Array(32768)));try{await putDBFile('photo:d1:retry-test',new Blob(chunks,{type:'image/jpeg'}));return false}catch(e){return true}}''')
 assert value and page.evaluate('SentlogRecords.failed')
 cdp.send('Storage.overrideQuotaForOrigin',{'origin':origin});page.evaluate('SentlogRecords.retry()')
 assert not page.evaluate('SentlogRecords.failed')
 assert page.evaluate("getDBFile('photo:d1:retry-test').then(f=>f.size)")==2*1024*1024
 passed('PDF/photo write failure retains content for explicit retry')
 ctx.set_offline(True)
 page.evaluate("async()=>{state.shapes[0].memo='オフライン保存';persist();await SentlogRecords.settled()}")
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='オフライン保存'
 passed('Offline annotation edit commits to IndexedDB')
 ctx.close();browser.close()
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

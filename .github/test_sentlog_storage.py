"""Local fixtures only. External requests are aborted. No user credentials or cloud API calls."""
import json, base64, threading, functools, http.server
from pathlib import Path
from playwright.sync_api import sync_playwright
from reportlab.pdfgen import canvas
ROOT=Path('.sentlog-storage').resolve();SITE=ROOT/'site';OUT=ROOT/'results';OUT.mkdir(parents=True,exist_ok=True)
PDF=ROOT/'fixture.pdf'
c=canvas.Canvas(str(PDF),pagesize=(600,800))
for n in range(1,4):
 c.setFont('Helvetica',24);c.drawString(40,740,'Local storage test - page '+str(n));c.rect(50,120,450,580);c.showPage()
c.save()
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',8765),functools.partial(Handler,directory=str(SITE)))
threading.Thread(target=server.serve_forever,daemon=True).start()
WS='surveyFieldNoteWorkspaceV1';DR='surveyFieldNoteDrawingV1:'
state={'project':'保存先テスト','sourceType':'pdf','fileName':'fixture.pdf','pageCount':3,'currentPage':3,'width':1320,'height':1760,'shapes':[{'id':'s1','kind':'rect','type':'腐食','autoLabel':'腐食①','page':3,'x':100,'y':100,'w':50,'h':40,'memo':'移行前のテスト記録','photos':[]}],'labelSize':'small','pageSettings':{},'pageRotations':{},'pdfPageInfo':{}}
ws={'projects':[{'id':'p1','name':'保存先テスト','updatedAt':1000,'drawings':[{'id':'d1','name':'テスト図面','fileName':'fixture.pdf','sourceType':'pdf','pageCount':3,'updatedAt':1000}]}]}
results=[]
def passed(name):
 print('PASS',name,flush=True);results.append(name);(OUT/'tests.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
def route(request):
 url=request.request.url
 if url.startswith('http://127.0.0.1:8765/'):
  request.continue_();return
 if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
  name='pdf.worker.min.js' if 'worker' in url else 'pdf.min.js'
  request.fulfill(path=str(ROOT/'vendor'/name),content_type='application/javascript');return
 request.abort()
def launch(context):
 page=context.new_page();page.goto('http://127.0.0.1:8765/README.md')
 return page
def seed(page):
 page.evaluate('''async fixtures=>{
  for(const [key,value] of Object.entries(fixtures.records))localStorage.setItem(key,JSON.stringify(value));
  localStorage.setItem('unrelated-fixture','preserved');
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('surveyFieldNoteDB',1);request.onupgradeneeded=()=>request.result.createObjectStore('files');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
  const bytes=Uint8Array.from(atob(fixtures.pdf),c=>c.charCodeAt(0));
  await new Promise((resolve,reject)=>{const tx=db.transaction('files','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);const files=tx.objectStore('files');files.put(new File([bytes],'fixture.pdf',{type:'application/pdf'}),'background:d1');files.put(new Blob(['fixture-photo'],{type:'image/jpeg'}),'photo:d1:ph1')});db.close();
 }''',{'records':{WS:ws,DR+'d1':state},'pdf':base64.b64encode(PDF.read_bytes()).decode()})
def open_app(page):
 page.goto('http://127.0.0.1:8765/sentlog/')
 try:page.wait_for_function('window.SentlogRecords?.ready && window.SENTLOG_BUILD==="v1.30"')
 except:
  print(page.locator('body').inner_text());page.screenshot(path=str(OUT/'boot-error.png'));raise
 page.evaluate('window.sentlogAppReady')
def disk(page,key):
 return page.evaluate('''async key=>{const db=await new Promise(resolve=>{const r=indexedDB.open('surveyFieldNoteDB',1);r.onsuccess=()=>resolve(r.result)});const value=await new Promise(resolve=>{const r=db.transaction('files').objectStore('files').get('__sentlog_record__:'+key);r.onsuccess=()=>resolve(r.result)});db.close();return value;}''',key)
with sync_playwright() as pw:
 browser=pw.chromium.launch()
 ctx=browser.new_context(viewport={'width':390,'height':844},has_touch=True,is_mobile=True,device_scale_factor=3,user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',service_workers='block')
 ctx.route('**/*',route)
 page=launch(ctx);seed(page);open_app(page)
 assert json.loads(disk(page,DR+'d1'))==state
 assert page.evaluate('localStorage.getItem("unrelated-fixture")')=='preserved'
 assert page.evaluate('localStorage.getItem("surveyFieldNoteDrawingV1:d1")') is None
 passed('Legacy migration preserves records, settings and unrelated storage')
 page.reload();page.wait_for_function('window.SENTLOG_BUILD==="v1.30"');page.evaluate('window.sentlogAppReady')
 assert json.loads(disk(page,DR+'d1'))==state
 passed('Migration is idempotent on restart')
 page.evaluate('openDrawing("p1","d1")');page.wait_for_function('pdfDoc && state.currentPage===3 && loading.style.display==="none"')
 page.evaluate('''async()=>{state.shapes[0].memo='新しいテスト記録';persist();await SentlogRecords.flush()}''')
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='新しいテスト記録'
 page.locator('#prevPageBtn').click();page.wait_for_function('state.currentPage===2 && loading.style.display==="none"');page.locator('#nextPageBtn').click();page.wait_for_function('state.currentPage===3 && loading.style.display==="none"')
 page.evaluate('zoomCenter(1.25)');page.evaluate('SentlogRecords.flush()')
 passed('Editor saves records and retains PDF page and zoom operations')
 page.evaluate('''async()=>{let record=JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1'));record.stressMemo='x'.repeat(7*1024*1024);SentlogRecords.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify(record));await SentlogRecords.flush()}''')
 page.reload();page.wait_for_function('window.SENTLOG_BUILD==="v1.30"');page.evaluate('window.sentlogAppReady')
 assert page.evaluate("JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1')).stressMemo.length")==7*1024*1024
 passed('Seven MiB record is retained beyond localStorage capacity')
 page.evaluate('''async()=>{let r=JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1'));delete r.stressMemo;SentlogRecords.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify(r));await SentlogRecords.flush()}''')
 page.locator('#sentlogSettingsBtn').click();page.locator('#sentlogStorageSection summary').click();page.wait_for_function('document.querySelector("#sentlogStorageRows").children.length>6')
 assert '写真（1枚）' in page.locator('#sentlogStorageRows').inner_text()
 page.screenshot(path=str(OUT/'iphone-storage-settings.png'));passed('Settings shows record PDF photo and archive usage')
 page.locator('#sentlogStorageSection summary').click();page.locator('#sentlogBackupSection summary').click()
 with page.expect_download() as download:page.locator('#exportBackupBtn').click()
 backup=OUT/'fixture.sentlog.json';download.value.save_as(str(backup));pack=json.loads(backup.read_text())
 assert pack['drawingStates']['d1']['shapes'][0]['memo']=='新しいテスト記録'
 assert any(f['key']=='background:d1' and f['data'].split(',')[1]==base64.b64encode(PDF.read_bytes()).decode() for f in pack['files'])
 assert all(not f['key'].startswith('__sentlog_') for f in pack['files'])
 passed('Backup preserves IDB records and exact PDF bytes without internal state')
 messages=[];page.on('dialog',lambda d:(messages.append(d.message),d.accept()))
 invalid={**pack,'files':[{'key':'background:d1','data':'not-a-data-url'}]}
 page.locator('#importBackupInput').set_input_files({'name':'invalid.json','mimeType':'application/json','buffer':json.dumps(invalid).encode()});page.wait_for_timeout(300)
 assert any('現在のデータは変更していません' in m for m in messages)
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='新しいテスト記録'
 passed('Invalid backup is rejected without changing existing records')
 page.locator('#importBackupInput').set_input_files(str(backup));page.wait_for_timeout(800);page.wait_for_function('window.SENTLOG_BUILD==="v1.30"');page.evaluate('window.sentlogAppReady')
 assert json.loads(disk(page,DR+'d1'))['shapes'][0]['memo']=='新しいテスト記録'
 assert page.evaluate('localStorage.getItem("unrelated-fixture")')=='preserved'
 assert page.evaluate('JSON.parse(SentlogRecords.getItem("sentlogCloudProjectSyncV2:p1")).restored_backup')
 passed('Atomic restore retains records, files, and unrelated local data')
 other=ctx.new_page();other.goto('http://127.0.0.1:8765/sentlog/');other.wait_for_timeout(500)
 assert '別に開いています' in other.locator('body').inner_text();other.close()
 passed('Second editor is blocked instead of overwriting stale records')
 ctx.close();browser.close()
server.shutdown()

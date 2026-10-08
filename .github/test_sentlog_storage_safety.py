"""Additional migration safety tests using disposable profiles and synthetic files only."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import json,threading,functools,http.server,tempfile
ROOT=Path('.sentlog-storage').resolve();SITE=ROOT/'site';OUT=ROOT/'results'
PACK=json.loads((OUT/'fixture.sentlog.json').read_text())
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',8766),functools.partial(Handler,directory=str(SITE)))
threading.Thread(target=server.serve_forever,daemon=True).start()
BASE='http://127.0.0.1:8766';results=[]
def passed(message):
 results.append(message);print('PASS',message,flush=True);(OUT/'safety-tests.json').write_text(json.dumps(results,indent=2))
def route(r):
 u=r.request.url
 if u.startswith(BASE+'/'):r.continue_()
 elif u.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
  r.fulfill(path=str(ROOT/'vendor'/('pdf.worker.min.js' if 'worker' in u else 'pdf.min.js')),content_type='application/javascript')
 else:r.abort()
def seed(page):
 page.goto(BASE+'/README.md')
 page.evaluate('''async p=>{localStorage.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify(p.workspace));for(const [id,st] of Object.entries(p.drawingStates))localStorage.setItem('surveyFieldNoteDrawingV1:'+id,JSON.stringify(st));localStorage.setItem('OTHER_APP_KEEP','keep');const db=await new Promise((res,rej)=>{const q=indexedDB.open('surveyFieldNoteDB',1);q.onupgradeneeded=()=>q.result.createObjectStore('files');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});await new Promise((res,rej)=>{const tx=db.transaction('files','readwrite');tx.oncomplete=res;tx.onabort=()=>rej(tx.error);for(const f of p.files){const b=Uint8Array.from(atob(f.data.split(',')[1]),c=>c.charCodeAt(0));tx.objectStore('files').put(new File([b],f.name||'file',{type:f.type}),f.key);}});db.close();}''',PACK)
def open_app(page):
 page.goto(BASE+'/sentlog/');page.wait_for_function('window.SentlogRecords?.ready && window.SENTLOG_BUILD==="v1.30"');page.evaluate('window.sentlogAppReady')
def keys(page):
 return page.evaluate('''async()=>{const db=await new Promise(res=>{const q=indexedDB.open('surveyFieldNoteDB',1);q.onsuccess=()=>res(q.result);});const tx=db.transaction('files');const all=await new Promise(res=>{const q=tx.objectStore('files').getAllKeys();q.onsuccess=()=>res(q.result)});db.close();return all;}''')
with sync_playwright() as pw:
 browser=pw.chromium.launch()
 ctx=browser.new_context(service_workers='block');ctx.route('**/*',route);page=ctx.new_page();seed(page)
 old=page.evaluate('localStorage.getItem("surveyFieldNoteWorkspaceV1")')
 ctx.add_init_script('''const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,k){const q=original.apply(this,arguments);if(String(k).startsWith('__sentlog_record__:surveyFieldNoteDrawingV1:'))q.addEventListener('success',()=>this.transaction.abort(),{once:true});return q;};''')
 page.goto(BASE+'/sentlog/');page.wait_for_function('document.body.textContent.includes("開始できません")')
 assert page.evaluate('localStorage.getItem("surveyFieldNoteWorkspaceV1")')==old
 assert '__sentlog_records_meta_v130__' not in keys(page) and 'background:d1' in keys(page)
 passed('Migration transaction abort retains legacy records and files without starting an empty app')
 ctx.close()
 ctx=browser.new_context(service_workers='block');ctx.route('**/*',route);page=ctx.new_page();seed(page)
 page.evaluate('localStorage.setItem("surveyFieldNoteDrawingV1:d1","{bad json")')
 page.goto(BASE+'/sentlog/');page.wait_for_function('document.body.textContent.includes("開始できません")')
 assert page.evaluate('localStorage.getItem("surveyFieldNoteDrawingV1:d1")')=='{bad json'
 assert '__sentlog_records_meta_v130__' not in keys(page)
 passed('Malformed legacy data is rejected without erasing original records')
 ctx.close()
 ctx=browser.new_context(service_workers='block');ctx.route('**/*',route);page=ctx.new_page();seed(page);open_app(page)
 page.evaluate('''async()=>{const r=JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1'));r.shapes[0].memo='new durable edit';SentlogRecords.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify(r));await SentlogRecords.settled();localStorage.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify({...r,oldTab:true}));}''')
 page.reload();page.wait_for_function('document.body.textContent.includes("旧版の画面で変更")')
 assert 'oldTab' in page.evaluate('localStorage.getItem("surveyFieldNoteDrawingV1:d1")')
 passed('Divergent old-tab records are preserved and blocked rather than replacing migrated data')
 ctx.close();browser.close()
 with tempfile.TemporaryDirectory(prefix='sentlog-chromium-') as directory:
  options=dict(service_workers='block',viewport={'width':390,'height':844},is_mobile=True,has_touch=True,user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')
  ctx=pw.chromium.launch_persistent_context(directory,**options);ctx.route('**/*',route);page=ctx.new_page();seed(page);open_app(page)
  page.evaluate('''async()=>{const r=JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d1'));r.big='x'.repeat(7*1024*1024);SentlogRecords.setItem('surveyFieldNoteDrawingV1:d1',JSON.stringify(r));await SentlogRecords.settled();}''')
  ctx.close();ctx=pw.chromium.launch_persistent_context(directory,**options);ctx.route('**/*',route);page=ctx.new_page();open_app(page)
  assert page.evaluate('JSON.parse(SentlogRecords.getItem("surveyFieldNoteDrawingV1:d1")).big.length')==7*1024*1024
  assert page.evaluate('localStorage.getItem("surveyFieldNoteDrawingV1:d1")') is None
  assert page.evaluate('localStorage.getItem("OTHER_APP_KEEP")')=='keep'
  assert not page.locator('#saveStatus').is_visible()
  passed('Seven MiB record survives full Chromium restart; unrelated storage and hidden header label preserved')
  ctx.close()
server.shutdown();server.server_close()

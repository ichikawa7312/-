"""Built app/IndexedDB management UI with mocked external transport only.
No live account, repository, database or PC files are mutated by this test.
"""
import functools,json,os,threading
from pathlib import Path
from datetime import datetime,timezone
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  opts={'headless':True}
  if os.path.exists('/usr/bin/chromium'):opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**opts)
  for width in (390,1280):
   context=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
   context.add_init_script("""localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'synthetic-only',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'synthetic-owner',email:'test@example.invalid'}}));localStorage.setItem('sentlogCloudDeviceV1','device-current');""")
   project={'id':'local-test','name':'使用終了の検証案件','drawings':[],'createdAt':1,'updatedAt':1}
   cp={'id':'cloud-test','client_key':'local-test','name':project['name'],'status':'active','checking':False,'retired':False}
   payload={'project':project,'drawings':[]}
   devices=[{'id':'device-current','name':'検証ブラウザ','type':'browser','active':True,'last_seen_at':'2026-10-01T01:00:00Z','created_at':'2026-09-01T00:00:00Z'}, {'id':'device-old','name':'以前の登録','type':'ipad','active':True,'last_seen_at':'2026-09-01T01:00:00Z','created_at':'2026-09-01T00:00:00Z'}]
   calls=[];unexpected=[];fail_list=False
   def route(rr):
    r=rr.request;url=r.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Unexpected PDF use");}};');return
    if not url.startswith('https://wiulvaqixphuobdielyy.supabase.co/rest/v1/'):
     unexpected.append(url);rr.abort();return
    path=urlparse(url).path;body=json.loads(r.post_data) if r.post_data else None
    if r.method=='OPTIONS':rr.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'});return
    calls.append({'path':path,'method':r.method,'body':body});status=200
    if path.endswith('/rpc/sentlog_archive_v1'):
     if body['p_action']=='list':result=[cp]
     else:unexpected.append(body);result={};status=400
    elif path.endswith('/rpc/sentlog_management_v1'):
     action=body['p_action'];data=body.get('p_data',{})
     if action=='device_list':result=devices
     elif action in ('device_stop','device_resume','device_rename'):
      row=next(d for d in devices if d['id']==data['device_id'])
      if action=='device_rename':row['name']=data['name']
      else:row['active']=action=='device_resume'
      result={'updated':True}
     elif action=='project_retire':
      assert data['confirmed'] and data['confirm_name']==cp['name'];cp.update(status='archived',retired=True);result={'retired':True,'file_backup_verified':False}
     elif action=='project_resume':cp.update(status='active',retired=False);result={'retired':False}
     else:unexpected.append(body);result={};status=400
    elif path.endswith('/sentlog_devices'):
     if r.method=='PATCH':rr.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*'});return
     result=[devices[0]]
    elif path.endswith('/sentlog_projects'):result=[cp]
    elif path.endswith('/sentlog_project_snapshots'):result=[{'revision':1,'payload':payload,'updated_at':'2026-01-01T00:00:00Z'}]
    elif path.endswith('/sentlog_assets') or path.endswith('/sentlog_pdf_requests'):result=[]
    else:unexpected.append(path);result={};status=400
    rr.fulfill(status=status,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(result,ensure_ascii=False))
   context.route('**/*',route);page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.35'")
   expect(page.get_by_role('button',name='使用終了にする',exact=True)).to_be_visible()
   page.evaluate("async()=>{await window.SentlogRecords.writeFile('background:retained-test',new Blob(['keep original bytes']));await window.SentlogRecords.writeFile('photo:retained-test:1',new Blob(['keep photo']));}")
   before=page.evaluate('JSON.stringify(workspace)')
   page.get_by_role('button',name='使用終了にする',exact=True).click();d=page.locator('.sl-management-dialog');expect(d).to_be_visible()
   expect(d.get_by_role('button',name='削除せずに使用終了にする')).to_be_disabled()
   d.get_by_role('button',name='やめる').click();assert not any(c['body'] and c['body'].get('p_action')=='project_retire' for c in calls)
   page.get_by_role('button',name='使用終了にする',exact=True).click();d.get_by_role('checkbox').check();d.get_by_role('button',name='削除せずに使用終了にする').click();expect(d).not_to_be_visible()
   expect(page.get_by_role('button',name='使用終了にする',exact=True)).to_have_count(0)
   page.get_by_role('button',name='📁 保管').click();expect(page.locator('#projectsGrid')).to_contain_text('使用終了（不要）')
   expect(page.get_by_role('button',name='この案件を手動同期')).to_have_count(0)
   assert page.evaluate('JSON.stringify(workspace)')==before
   assert page.evaluate("async()=>await (await getDBFile('background:retained-test')).text()")=='keep original bytes'
   assert page.evaluate("async()=>await (await getDBFile('photo:retained-test:1')).text()")=='keep photo'
   start=len(calls);page.evaluate('window.sentlogArchiveSync()');page.evaluate('window.sentlogCheckPdfRecovery()')
   assert not any(c['path'].endswith('/sentlog_project_snapshots') for c in calls[start:])
   assert not any(c['method']=='DELETE' for c in calls)
   page.get_by_role('button',name='設定',exact=True).click();page.locator('#slDeviceSection summary').click()
   expect(page.locator('#slDeviceList')).to_contain_text('この端末');old=page.locator('[data-device-id="device-old"]')
   expect(page.locator('[data-device-id="device-current"]').get_by_role('button',name='登録を停止')).to_be_disabled()
   page.once('dialog',lambda d:d.accept('現場用 iPad'));old.get_by_role('button',name='名前を変更').click();expect(old).to_contain_text('現場用 iPad')
   old.get_by_role('button',name='登録を停止').click();d=page.locator('.sl-management-dialog');expect(d).to_be_visible()
   expect(d.get_by_role('button',name='この登録を停止する')).to_be_disabled();d.get_by_role('checkbox').check();d.get_by_role('button',name='この登録を停止する').click();expect(d).not_to_be_visible()
   expect(old).to_contain_text('停止中');old.get_by_role('button',name='登録を再開').click();d.get_by_role('checkbox').check();d.get_by_role('button',name='この登録を再開する').click();expect(d).not_to_be_visible();expect(old).to_contain_text('使用中')
   (ROOT/'test-results').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/f'test-results/management-{width}.png'),full_page=True)
   # A stopped current registration is an explicit sync pause, not a new device.
   devices[0]['active']=False;start=len(calls);page.evaluate('window.sentlogArchiveSync()');page.evaluate('window.sentlogCheckPdfRecovery()')
   assert not any('sentlog_register_device' in c['path'] for c in calls)
   assert not any(c['path'].endswith('/sentlog_project_snapshots') for c in calls[start:])
   assert not unexpected,unexpected
   assert not errors,errors
   print(f'PASS built app {width}px: retirement confirmation/cancel, shared folder, no record/blob deletion, no automatic retired transfer, device name/stop/resume, current-stop prevention, no silent re-registration')
   context.close()
  browser.close()
finally:
 server.shutdown();server.server_close()

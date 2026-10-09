"""Live built Sentlog/IndexedDB capacity regression; all cloud & PC replies synthetic.
No live user account or company PC files are used or changed.
"""
import functools,threading,os,json,hashlib
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
pdf=b'%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'
photo=b'fake-photo-data-not-a-real-photo'
drawingid='11111111-1111-4111-8111-111111111111'
photoid='33333333-3333-4333-8333-333333333333'
asset1='22222222-2222-4222-8222-222222222222'
asset2='44444444-4444-4444-8444-444444444444'
owner='00000000-0000-4000-8000-000000000000'
jobid='55555555-5555-4555-8555-555555555555'
opid='66666666-6666-4666-8666-666666666666'
metadata={'id':drawingid,'name':'図面A','fileName':'plan.pdf','sourceType':'pdf','updatedAt':1}
state={'id':drawingid,'fileName':'plan.pdf','sourceType':'pdf','shapes':[{'id':'shape-a','photos':[{'id':photoid,'name':'photo.jpg'}]}]}
project={'id':'local-archive-test','name':'保管済み検証案件','drawings':[metadata],'createdAt':1,'updatedAt':1}
other={'id':'other-project','name':'使用中の大事な案件','drawings':[],'createdAt':1,'updatedAt':1}
payload={'project':project,'drawings':[{'meta':metadata,'state':state}]}
def f(asset,key,kind,name,data):
 return {'id':asset,'key':key,'kind':kind,'file_name':name,'mime_type':'application/pdf' if kind=='drawing' else 'image/jpeg',
         'byte_size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'path':'files/'+asset,
         'temp_path':owner+'/archive-restore/'+opid+'/'+asset}
manifest=[f(asset1,'background:'+drawingid,'drawing','plan.pdf',pdf),f(asset2,'photo:'+drawingid+':'+photoid,'photo','photo.jpg',photo)]
job={'id':jobid,'project_id':'cloud-test','revision':1,'payload':payload,'manifest':manifest,'catalog_hash':'a'*64,
     'pc_receipt':{'package_sha256':'b'*64,'path':'PC\\復旧用\\cloud-test\\'+jobid+'\\manifest.sentlog.json'}}
op={'id':opid,'owner_id':owner,'device_id':'device-current','project_id':'cloud-test','job_id':jobid,'state':'ready','action':'verify','mode':'files',
    'expires_at':'2099-12-01T00:00:00Z'}
cp={'id':'cloud-test','client_key':project['id'],'name':project['name'],'status':'archived','checking':False,'retired':False,'job_id':jobid}
try:
 with sync_playwright() as p:
  options={'headless':True}
  if os.path.exists('/usr/bin/chromium'):options.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**options)
  for width in (390,1280):
   context=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
   context.add_init_script("""localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'synthetic-only',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'synthetic-owner',email:'test@example.invalid'}}));localStorage.setItem('sentlogCloudDeviceV1','device-current');""")
   calls=[];unexpected=[];operation={}
   def route(rr):
    r=rr.request;url=r.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Unexpected PDF use");}};');return
    if url.startswith('https://wiulvaqixphuobdielyy.supabase.co/storage/v1/object/authenticated/'):
     if asset1 in url:rr.fulfill(status=200,content_type='application/pdf',body=pdf);return
     if asset2 in url:rr.fulfill(status=200,content_type='image/jpeg',body=photo);return
     unexpected.append(url);rr.abort();return
    if not url.startswith('https://wiulvaqixphuobdielyy.supabase.co/rest/v1/'):
     unexpected.append(url);rr.abort();return
    path=urlparse(url).path;body=json.loads(r.post_data) if r.post_data else None
    if r.method=='OPTIONS':rr.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'});return
    calls.append({'path':path,'method':r.method,'body':body})
    code=200;result={}
    if path.endswith('/rpc/sentlog_archive_v1'):
     if body['p_action']=='list':result=[cp]
     else:unexpected.append(body);code=400
    elif path.endswith('/rpc/sentlog_capacity_v1'):
     action=body['p_action']
     if action=='begin':
      operation.clear();operation.update(op);operation['action']=body['p_data']['action'];operation['mode']=body['p_data']['mode']
      result={'id':opid,'state':'requested'}
     elif action=='inspect':
      result={'operation':operation.copy(),'job':job,'files':manifest}
     elif action=='finish':result={'finished':True}
     elif action=='cancel':result={'cancelled':True}
     else:unexpected.append(body);code=400
    elif path.endswith('/sentlog_devices'):
     if r.method=='PATCH':rr.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*'});return
     result=[{'id':'device-current','active':True}]
    elif path.endswith('/sentlog_projects'):result=[cp]
    elif path.endswith('/sentlog_project_snapshots'):result=[{'revision':1,'payload':payload,'updated_at':'2026-01-01T00:00:00Z'}]
    elif path.endswith('/sentlog_assets') or path.endswith('/sentlog_pdf_requests'):result=[]
    else:unexpected.append(path);code=400
    rr.fulfill(status=code,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(result,ensure_ascii=False))
   context.route('**/*',route)
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.37' && !!window.SentlogCapacity && !!window.SentlogArchive",timeout=15000)
   page.evaluate("""async data=>{
     workspace={projects:data.projects};
     window.SentlogRecords.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify(workspace));
     window.SentlogRecords.setItem('surveyFieldNoteDrawingV1:'+data.id,JSON.stringify(data.state));
     await window.SentlogRecords.writeFile('background:'+data.id,new File([Uint8Array.from(data.pdf)],'plan.pdf',{type:'application/pdf'}));
     await window.SentlogRecords.writeFile('photo:'+data.id+':'+data.photoid,new File([Uint8Array.from(data.photo)],'photo.jpg',{type:'image/jpeg'}));
     await window.SentlogRecords.settled();
     await window.SentlogArchive.refresh();renderProjects();
   }""",{'projects':[project,other],'id':drawingid,'state':state,'photoid':photoid,'pdf':list(pdf),'photo':list(photo)})
   page.get_by_role('button',name='📁 保管').click()
   original=page.evaluate('window.SentlogRecords.getItem("surveyFieldNoteDrawingV1:'+drawingid+'")')
   page.get_by_role('button',name='PDF・写真を端末から外す').click()
   delete=page.get_by_role('button',name='照合済みのPDF・写真を端末から削除')
   expect(delete).to_be_visible()
   page.once('dialog',lambda d:d.accept())
   delete.click()
   page.wait_for_function("window.SentlogCapacity.isCleared('cloud-test') && !window.SentlogRecords.pending")
   assert page.evaluate("async()=>await getDBFile('background:"+drawingid+"')") is None
   assert page.evaluate("async()=>await getDBFile('photo:"+drawingid+":"+photoid+"')") is None
   assert page.evaluate('window.SentlogRecords.getItem("surveyFieldNoteDrawingV1:'+drawingid+'")')==original
   assert len(page.evaluate('workspace.projects'))==2
   page.locator('.sl-capacity-dialog').get_by_role('button',name='閉じる',exact=True).click()
   page.get_by_role('button',name='PCからこの端末に復旧').click()
   page.wait_for_function("!window.SentlogCapacity.isCleared('cloud-test') && !window.SentlogRecords.pending",timeout=30000)
   assert page.evaluate("async()=>Array.from(new Uint8Array(await (await getDBFile('background:"+drawingid+"')).arrayBuffer()))")==list(pdf)
   assert page.evaluate("async()=>Array.from(new Uint8Array(await (await getDBFile('photo:"+drawingid+":"+photoid+"')).arrayBuffer()))")==list(photo)
   page.locator('.sl-capacity-dialog').get_by_role('button',name='閉じる',exact=True).click()
   page.get_by_role('button',name='この端末から案件を外す').click()
   delete=page.get_by_role('button',name='この端末から案件一式を外す')
   expect(delete).to_be_visible()
   page.once('dialog',lambda d:d.accept())
   delete.click()
   page.wait_for_function("window.SentlogCapacity.isWholeRemoved('cloud-test') && !window.SentlogRecords.pending")
   assert [x['name'] for x in page.evaluate('workspace.projects')]==[other['name']]
   assert page.evaluate('window.SentlogRecords.getItem("surveyFieldNoteDrawingV1:'+drawingid+'")') is None
   page.locator('.sl-capacity-dialog').get_by_role('button',name='閉じる',exact=True).click()
   page.get_by_role('button',name='PCからこの端末に復旧').click()
   page.wait_for_function("!window.SentlogCapacity.isCleared('cloud-test') && !window.SentlogRecords.pending",timeout=30000)
   assert sorted(x['name'] for x in page.evaluate('workspace.projects'))==sorted([project['name'],other['name']])
   assert page.evaluate('window.SentlogRecords.getItem("surveyFieldNoteDrawingV1:'+drawingid+'")')==original
   assert not unexpected,unexpected
   assert not errors,errors
   assert not any(c['method']=='DELETE' for c in calls)
   (ROOT/'test-results').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/f'test-results/capacity-{width}.png'),full_page=True)
   print(f'PASS capacity {width}px: verified PC release, file-only and case eviction, restoration with byte/hash checks, other case preserved, no cloud deletes')
   context.close()
  browser.close()
finally:
 server.shutdown();server.server_close()

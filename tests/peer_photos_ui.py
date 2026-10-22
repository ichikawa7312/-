"""Two isolated real browser stores; peer uploads and normal recovery, no PC.
Network and account are synthetic. Both production scripts execute unchanged.
"""
import functools,hashlib,json,os,threading,tempfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  prefix='/storage/v1/object/sentlog-temp/'
  assert self.path.startswith(prefix) and self.headers.get('x-upsert')=='false'
  objects[self.path.removeprefix(prefix)]=self.rfile.read(int(self.headers['Content-Length']))
  stats['uploads']+=1
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{}')
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
owner='00000000-0000-4000-8000-000000000001'
project='00000000-0000-4000-8000-000000000002'
phone='00000000-0000-4000-8000-000000000003'
ipad='00000000-0000-4000-8000-000000000004'
assets=[]
for i in range(2):
 data=('peer-photo-'+str(i)).encode()
 assets.append({'id':'10000000-0000-4000-8000-'+str(i).zfill(12),'project_id':project,'kind':'photo',
  'status':'storage_deleted','mime_type':'image/jpeg','file_name':f'p{i}.jpg','byte_size':len(data),
  'sha256':hashlib.sha256(data).hexdigest(),'metadata':{'drawing_id':'drawing','photo_id':f'p{i}'},'bytes':data,'storage_path':'old'})
state={'id':'drawing','shapes':[{'id':'defect-1','type':'欠損・損傷','page':3,'photos':[{'id':'p0'},{'id':'p1'}]}]}
workspace={'projects':[{'id':'local','name':'Synthetic survey','drawings':[{'id':'drawing'}]}]}
html='''<!doctype html><html><body><main id="projectsView"><div class="manager-shell"></div></main><div id="sentlogCloudLoggedIn"></div>
<script>
 // WebKit omits Blob bodies from Playwright's intercepted request metadata.
 // Send uploads through native fetch to the test HTTP server and verify actual bytes.
 const nativeFetch=window.fetch.bind(window);
 window.fetch=(input,options)=>{const u=new URL(input,location.href);return nativeFetch(options?.method==='POST'&&u.pathname.startsWith('/storage/v1/object/sentlog-temp/')?location.origin+u.pathname:input,options);};
 const state=STATE,workspace=WORKSPACE;
 const nativeTimeout=window.setTimeout;window.setTimeout=(f,ms,...a)=>[2500,4500].includes(ms)?0:nativeTimeout(f,ms,...a);
 window.setInterval=()=>0;
 const device=new URL(location.href).searchParams.get('device');
 localStorage.setItem('sentlogCloudDeviceV1',device);
 localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'synthetic',expires_at:9999999999,user:{id:'OWNER'}}));
 async function database(){return await new Promise((resolve,reject)=>{const q=indexedDB.open('surveyFieldNoteDB',1);q.onupgradeneeded=()=>q.result.createObjectStore('files');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}
 async function put(key,file){const db=await database();try{await new Promise((resolve,reject)=>{const tx=db.transaction('files','readwrite');tx.objectStore('files').put(file,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}finally{db.close();}}
 window.readPhotos=async()=>{const db=await database();try{return await Promise.all(['p0','p1'].map(p=>new Promise((resolve,reject)=>{const q=db.transaction('files','readonly').objectStore('files').get('photo:drawing:'+p);q.onsuccess=async()=>resolve(q.result?await q.result.text():null);q.onerror=()=>reject(q.error);})));}finally{db.close();}};
 window.sentlogAppReady=database().then(db=>db.close());
 window.SentlogRecords={ready:true,getItem:k=>k==='surveyFieldNoteWorkspaceV1'?JSON.stringify(workspace):k==='surveyFieldNoteDrawingV1:drawing'?JSON.stringify(state):null,writeFile:put};
 window.putPhoto=put;window.sentlogManagementSession=async()=>{};window.sentlogSyncView={photoReceived(){}};
</script><script src="/sentlog/sync-traffic.js"></script><script src="/sentlog/photo-recovery.js"></script><script src="/sentlog/peer-photo-recovery.js"></script></body></html>'''.replace('STATE',json.dumps(state)).replace('WORKSPACE',json.dumps(workspace)).replace('OWNER',owner)
try:
 with sync_playwright() as p:
  engines=[(name,getattr(p,name)) for name in os.getenv('SENTLOG_TEST_BROWSERS','chromium').split(',')]
  for name,engine in engines:
   options={'headless':True}
   executable=os.getenv('SENTLOG_CHROMIUM_EXECUTABLE','/usr/bin/chromium')
   if name=='chromium' and os.path.exists(executable):options.update(executable_path=executable,args=['--no-sandbox','--disable-dev-shm-usage'])
   profiles=tempfile.TemporaryDirectory()
   browser=None if name=='webkit' else engine.launch(**options)
   # Reset synthetic cloud for each browser engine.
   for a in assets:a['status']='storage_deleted';a['storage_path']='old'
   requests={};objects={};leases={};stats={'uploads':0,'acks':0};errors=[]
   def route(rr):
    u=urlparse(rr.request.url);q=parse_qs(u.query);path=u.path
    if path=='/peer-fixture':rr.fulfill(content_type='text/html',body=html);return
    if u.hostname!='wiulvaqixphuobdielyy.supabase.co':rr.continue_();return
    headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}
    if rr.request.method=='OPTIONS':rr.fulfill(status=204,headers=headers);return
    data=[];body=rr.request.post_data_json if rr.request.method=='POST' and '/rest/v1/' in path else None
    if path.endswith('/sentlog_projects'):data=[] if 'id' in q else [{'id':project}]
    elif path.endswith('/sentlog_devices'):
     data=[{'id':d,'device_type':'iphone' if d==phone else 'ipad','last_seen_at':'2099-01-01T00:00:00Z'} for d in [phone,ipad]]
     if 'id' in q:data=[d for d in data if d['id']>q['id'][0][3:]]
    elif path.endswith('/sentlog_pdf_requests'):
     data=[r for r in requests.values() if r.get('received_at') is None]
     data.sort(key=lambda r:(r['asset_id'],r['device_id']))
     if 'or' in q:
      import re
      after=re.search(r'asset_id.gt.([^,]+)',q['or'][0])[1];dev=re.search(r'device_id.gt.([^\)]+)',q['or'][0])[1]
      data=[r for r in data if (r['asset_id'],r['device_id'])>(after,dev)]
    elif path.endswith('/sentlog_assets'):
     data=[{k:v for k,v in a.items() if k!='bytes'} for a in assets]
     if 'id' in q:
      value=q['id'][0]
      if value.startswith('gt.'):data=[a for a in data if a['id']>value[3:]]
      elif value.startswith('in.'):data=[a for a in data if a['id'] in value]
     if q.get('status')==['eq.storage_deleted']:data=[a for a in data if a['status']=='storage_deleted']
    elif path.endswith('/rpc/sentlog_request_photo'):
     a=next(a for a in assets if a['id']==body['p_asset_id'])
     requests[(a['id'],body['p_device_id'])]={'asset_id':a['id'],'device_id':body['p_device_id'],'expected_sha256':a['sha256'],'requested_at':'2099-01-01T00:00:00Z','received_at':None}
     data={'requested':True}
    elif path.endswith('/rpc/sentlog_device_photo_redelivery_v1'):
     a=next(a for a in assets if a['id']==body['p_asset_id'])
     assert body['p_sha256']==a['sha256'] and body['p_byte_size']==a['byte_size']
     if body['p_action']=='claim':
      token='token-'+a['id'];dest=owner+'/'+project+'/device-redelivery/'+a['id']+'/'+token+'.jpg'
      data={'claimed':a['status']=='storage_deleted' and a['id'] not in leases,'token':token,'storage_path':dest}
      if data['claimed']:leases[a['id']]=data
     else:
      lease=leases.pop(a['id']);assert hashlib.sha256(objects[lease['storage_path']]).hexdigest()==a['sha256']
      a['status']='uploaded';a['storage_path']=lease['storage_path'];data={'published':True}
    elif path.endswith('/rpc/sentlog_ack_photo'):
     a=next(a for a in assets if a['id']==body['p_asset_id']);assert body['p_sha256']==a['sha256']
     key=(a['id'],body['p_device_id'])
     if key in requests:requests[key]['received_at']='now'
     stats['acks']+=1;data={'received':True}
    elif path.startswith('/storage/v1/object/sentlog-temp/'):
     raise AssertionError('uploads must reach the HTTP server with actual bytes')
    elif path.startswith('/storage/v1/object/authenticated/sentlog-temp/'):
     rr.fulfill(content_type='image/jpeg',headers=headers,body=objects[path.removeprefix('/storage/v1/object/authenticated/sentlog-temp/')]);return
    else:raise AssertionError('unexpected '+path)
    rr.fulfill(content_type='application/json',headers=headers,body=json.dumps(data))
   contexts=[];pages=[]
   for i,d in enumerate([phone,ipad]):
    size={'width':390 if i==0 else 1024,'height':844 if i==0 else 768}
    context=browser.new_context(viewport=size) if browser else engine.launch_persistent_context(str(Path(profiles.name)/str(i)),headless=True,viewport=size)
    context.route('**/*',route);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(origin+'/peer-fixture?device='+d);page.wait_for_function("typeof window.sentlogCheckPeerPhotos==='function'")
    page.evaluate("async i=>{await sentlogAppReady;await putPhoto('photo:drawing:p'+i,new File(['peer-photo-'+i],'photo.jpg',{type:'image/jpeg'}));}",i)
    contexts.append(context);pages.append(page)
   # Each page initially has exactly one different original.
   assert pages[0].evaluate('readPhotos()')==['peer-photo-0',None]
   assert pages[1].evaluate('readPhotos()')==[None,'peer-photo-1']
   for page in pages:page.evaluate('sentlogCheckPhotoRecovery()')
   assert len(requests)==2
   for page in pages:page.evaluate('sentlogCheckPeerPhotos()')
   for page in pages:page.evaluate('sentlogCheckPhotoRecovery()')
   for page in pages:
    page.wait_for_function("async()=> (await readPhotos()).every(Boolean)")
    assert page.evaluate('readPhotos()')==['peer-photo-0','peer-photo-1']
    assert page.evaluate("JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:drawing'))")==state
    page.reload();page.wait_for_function("typeof window.readPhotos==='function'")
    assert page.evaluate('readPhotos()')==['peer-photo-0','peer-photo-1']
   assert stats['uploads']==2,stats
   assert all(r.get('received_at') for r in requests.values()),requests
   assert not errors,errors
   print('PASS',name,'two-device relay without PC, exact files, received ACKs, annotations unchanged, restart persistence',flush=True)
   for context in contexts:context.close()
   if browser:browser.close()
   profiles.cleanup()
finally:server.shutdown()

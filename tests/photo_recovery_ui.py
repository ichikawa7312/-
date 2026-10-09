"""Actual Chromium/IndexedDB regression for missing photos on a new browser profile.
All external calls are synthetic. No user account, PC files or production data touched.
"""
import json,hashlib,threading,functools,os
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
drawing_id='88888888-8888-4888-8888-888888888888'
photo_id='99999999-9999-4999-8999-999999999999'
cloud_id='77777777-7777-4777-8777-777777777777'
asset_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
content=b'fake-jpeg-blob-for-missing-photo-recovery'
asset={'id':asset_id,'project_id':cloud_id,'kind':'photo','status':'storage_deleted',
       'file_name':'image.jpg','mime_type':'image/jpeg','byte_size':len(content),
       'sha256':hashlib.sha256(content).hexdigest(),
       'storage_path':'owner/project/photo.jpg',
       'metadata':{'drawing_id':drawing_id,'photo_id':photo_id}}
project={'id':'local-photo-case','name':'写真の再取得テスト','drawings':[{'id':drawing_id,'name':'図面A'}]}
state={'id':drawing_id,'shapes':[{'id':'shape-1','photos':[{'id':photo_id,'name':'image.jpg'}]}]}
script_prefix="""<!doctype html><html lang='ja'><head><meta charset='utf-8'></head>
<body><main id='projectsView'><div class='manager-shell'></div></main><script>
 localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'test-token',expires_at:9999999999,user:{id:'test-owner'}}));
 localStorage.setItem('sentlogCloudDeviceV1','test-phone');
 const PROJECT=REPLACE_PROJECT,STATE=REPLACE_STATE;
 const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:'+STATE.id;
 window.sentlogAppReady=Promise.resolve();
 window.SentlogRecords={ready:true,getItem:k=>k===WS?JSON.stringify({projects:[PROJECT]}):k===DRAW?JSON.stringify(STATE):null,
  writeFile:async(key,file)=>{
    const db=await new Promise((res,rej)=>{const q=indexedDB.open('surveyFieldNoteDB',1);
      q.onupgradeneeded=()=>q.result.createObjectStore('files');
      q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});
    try{await new Promise((res,rej)=>{const tx=db.transaction('files','readwrite');
      tx.objectStore('files').put(file,key);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})}finally{db.close()}
  }};
 window.photoNotices=0;
 window.sentlogSyncView={photoReceived:()=>window.photoNotices++};
</script><script src='/sentlog/photo-recovery.js'></script></body></html>"""
html=script_prefix.replace('REPLACE_PROJECT',json.dumps(project,ensure_ascii=False)).replace('REPLACE_STATE',json.dumps(state,ensure_ascii=False))
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  for corrupt in (False,True):
   context=browser.new_context(viewport={'width':390,'height':844},service_workers='block')
   stats={'requests':0,'acks':0,'uploaded':False,'unexpected':[]}
   def route(rr):
    u=rr.request.url
    if not u.startswith('https://wiulvaqixphuobdielyy.supabase.co/'):
     rr.continue_();return
    path=urlparse(u).path
    if rr.request.method=='OPTIONS':
     rr.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*'});return
    data=[];status=200;binary=False
    if path.endswith('/sentlog_projects'):data=[{'id':cloud_id}]
    elif path.endswith('/sentlog_assets'):data=[{**asset,'status':'uploaded' if stats['uploaded'] else 'storage_deleted'}]
    elif path.endswith('/rpc/sentlog_request_photo'):
     stats['requests']+=1;stats['uploaded']=True;data={'requested':True,'asset_id':asset_id}
    elif path.endswith('/rpc/sentlog_ack_photo'):
     stats['acks']+=1;data={'received':True}
    elif path.startswith('/storage/v1/object/authenticated/'):
     binary=True;data=b'corrupted-data' if corrupt else content
    else:status=404;stats['unexpected'].append(path);data={'message':'Unsupported route'}
    if binary:rr.fulfill(status=status,content_type='image/jpeg',body=data)
    else:rr.fulfill(status=status,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},
      body=json.dumps(data,ensure_ascii=False))
   context.route('**/*',route)
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/photo-recovery.js',wait_until='domcontentloaded') if False else None
   page.goto(origin+'/',wait_until='domcontentloaded')
   page.set_content(html,wait_until='domcontentloaded')
   page.wait_for_function("typeof window.sentlogCheckPhotoRecovery==='function'",timeout=15000)
   page.evaluate("window.sentlogCheckPhotoRecovery()")
   page.wait_for_function("document.querySelector('#slPhotoRedeliveryStatus')?.textContent?.includes('PC')",timeout=15000)
   page.evaluate("window.sentlogCheckPhotoRecovery()")
   if corrupt:
    page.wait_for_function("document.querySelector('#slPhotoRedeliveryStatus')?.textContent?.includes('照合に失敗')",timeout=15000)
    assert stats['acks']==0
    assert page.evaluate("""async()=>new Promise(res=>{const req=indexedDB.open('surveyFieldNoteDB',1);
      req.onsuccess=()=>{const q=req.result.transaction('files').objectStore('files').get('photo:'+STATE.id+':'+STATE.shapes[0].photos[0].id);q.onsuccess=()=>res(q.result===undefined)}})""")
   else:
    page.wait_for_function("window.photoNotices===1",timeout=15000)
    assert stats['requests']>=1,stats
    assert stats['acks']>=1,stats
    got=page.evaluate("""async()=>new Promise(res=>{const req=indexedDB.open('surveyFieldNoteDB',1);
      req.onsuccess=()=>{const q=req.result.transaction('files').objectStore('files').get('photo:'+STATE.id+':'+STATE.shapes[0].photos[0].id);
        q.onsuccess=async()=>res(Array.from(new Uint8Array(await q.result.arrayBuffer())))}})""")
    assert bytes(got)==content
   assert not stats['unexpected'],stats['unexpected']
   assert not errors,errors
   print('PASS photo recovery browser:', 'corrupt PC transmission cannot overwrite' if corrupt else 'missing JPEG received and saved in IndexedDB with SHA-256 verification')
   context.close()
  browser.close()
finally:
 server.shutdown();server.server_close()

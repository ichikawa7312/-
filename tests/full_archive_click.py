"""Load the actual built app and IndexedDB, intercepting ALL external traffic.
Only the transport is synthetic: the loader, app scripts, styles, cloud loop,
archive handlers and native dialog are the deployed build. No live credentials.
"""
import functools, json, os, threading
from datetime import datetime, timezone, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        opts={'headless':True}
        if os.path.exists('/usr/bin/chromium'):opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        browser=p.chromium.launch(**opts)
        for width in [390,1280]:
            context=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
            context.add_init_script("""localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'isolated-test-only',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'synthetic-owner',email:'test@example.invalid'}}));localStorage.setItem('sentlogCloudDeviceV1','synthetic-device');""")
            local={'id':'synthetic-project','name':'クリック検証専用案件','drawings':[],'createdAt':1,'updatedAt':1}
            cp={'id':'synthetic-cloud-project','client_key':local['id'],'name':local['name'],'status':'active','updated_at':'2026-01-01T00:00:00Z'}
            control={**cp,'checking':False}
            payload={'project':local,'drawings':[]}
            now=lambda:datetime.now(timezone.utc).isoformat()
            job={'id':'synthetic-job','project_id':cp['id'],'initiator':'synthetic-device','revision':1,'payload':payload,'manifest':[],'catalog_hash':'synthetic-hash','state':'checking','required_devices':[{'id':'synthetic-device','name':'この端末'}],'reports':{},'pc_receipt':None,'expires_at':(datetime.now(timezone.utc)+timedelta(minutes=10)).isoformat()}
            calls=[];unexpected=[]
            def route(request_route):
                request=request_route.request;url=request.url
                if url.startswith(origin+'/'):
                    request_route.continue_();return
                if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request_route.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{}};');return
                if not url.startswith('https://wiulvaqixphuobdielyy.supabase.co/rest/v1/'):
                    unexpected.append(url);request_route.abort();return
                path=urlparse(url).path;body=json.loads(request.post_data) if request.post_data else None
                calls.append({'path':path,'method':request.method,'body':body})
                if request.method=='OPTIONS':
                    request_route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'});return
                if path.endswith('/rpc/sentlog_archive_v1'):
                    action=body['p_action']
                    if action=='list':result=[control]
                    elif action=='begin':control.update(checking=True,job_id=job['id']);result=job
                    elif action=='inspect':result=job
                    elif action=='report':job['reports'][body['p_device_id']]={'clean':body['p_data']['clean'],'reason':body['p_data']['reason'],'at':now()};result={'ok':True}
                    elif action=='cancel':control['checking']=False;control.pop('job_id',None);job['state']='cancelled';result={'ok':True}
                    else:unexpected.append(action);request_route.fulfill(status=400,body='{}');return
                elif path.endswith('/sentlog_devices'):
                    result=[{'id':'synthetic-device','active':True}]
                    if request.method=='PATCH':
                        request_route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*'});return
                elif path.endswith('/sentlog_projects'):result=[cp]
                elif path.endswith('/sentlog_project_snapshots'):
                    result=[{'revision':1,'payload':payload,'updated_at':'2026-01-01T00:00:00Z'}]
                elif path.endswith('/sentlog_assets') or path.endswith('/sentlog_pdf_requests'):result=[]
                else:unexpected.append(path);request_route.fulfill(status=400,body='{}');return
                request_route.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(result,ensure_ascii=False))
            context.route('**/*',route)
            page=context.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
            page.wait_for_function("window.SENTLOG_BUILD==='v1.34'",timeout=15000)
            expect(page.get_by_role('button',name='保管へ移す',exact=True)).to_be_visible(timeout=15000)
            before=page.evaluate('JSON.stringify(workspace)')
            page.evaluate('''()=>{window.sentlogCloudIdle=()=>new Promise(resolve=>{window.releaseArchiveTestIdle=resolve;});}''')
            page.get_by_role('button',name='保管へ移す',exact=True).click()
            expect(page.locator('#slArchiveDialog')).to_be_visible()
            expect(page.locator('#slArchiveJobBody')).to_contain_text('現在の同期')
            assert not any(c['body'] and c['body'].get('p_action')=='begin' for c in calls)
            page.evaluate('()=>{window.releaseArchiveTestIdle()}')
            expect(page.locator('#slArchiveJobBody')).to_contain_text('会社PC',timeout=15000)
            expect(page.locator('#slArchiveCancel')).to_be_enabled(timeout=15000)
            expect(page.locator('#slArchiveFinalize')).to_be_disabled()
            assert any(c['body'] and c['body'].get('p_action')=='report' and c['body']['p_data']['clean'] for c in calls)
            (ROOT/'test-results').mkdir(exist_ok=True)
            page.screenshot(path=str(ROOT/f'test-results/full-app-archive-{width}.png'),full_page=True)
            page.locator('#slArchiveCancel').click()
            expect(page.locator('#slArchiveDialog')).not_to_be_visible()
            assert page.evaluate('JSON.stringify(workspace)')==before
            assert not any(c['method']=='DELETE' or c['body'] and c['body'].get('p_action')=='finalize' for c in calls)
            assert not unexpected,unexpected
            assert not errors,errors
            print(f'PASS actual built loader/app/IndexedDB/cloud loop/archive dialog at {width}px (mocked external transport only)')
            context.close()
        browser.close()
finally:
    server.shutdown();server.server_close()

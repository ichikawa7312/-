"""Actual built app and IndexedDB in two isolated browsers. All external I/O is mocked."""
import copy, functools, hashlib, json, os, threading, uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
WS='surveyFieldNoteWorkspaceV1'; DRAW='surveyFieldNoteDrawingV1:d'; META='sentlogCloudProjectSyncV2:p'
def record(name):
    return dict(id=name,type='ひび割れ',kind='polyline',points=[dict(x=1,y=2),dict(x=10,y=12)],no='手入力-'+name,memo='',photos=[])
def payload(names):
    meta=dict(id='d',name='正面図',fileName='',sourceType=None,updatedAt=2,groupId='d',groupName='正面図',sheetName='正面図',sheetOrder=1)
    state=dict(project='同期検証',sourceType=None,fileName='',pageCount=1,currentPage=1,width=100,height=100,shapes=[record(n) for n in names],pageSettings={},pageRotations={},pdfPageInfo={},nextGlobalNo=3,typeCounters={},leaderMarker='open-circle')
    return dict(project=dict(id='p',name='同期検証',createdAt=1,updatedAt=2,drawings=[meta]),drawings=[dict(meta=copy.deepcopy(meta),state=state)])
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
cp=dict(id='cloud-p',client_key='p',name='同期検証',status='active',checking=False)
cloud=dict(revision=2,payload=payload(['common','phone']),updated_at='2026-10-19T00:00:00Z')
assets={};blobs={};writes=[];unexpected=[];fail_write=False;race_write=False
def respond(route,value,status=200):
    route.fulfill(status=status,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(value,ensure_ascii=False))
def transport(route):
    global cloud,fail_write,race_write
    req=route.request;u=urlparse(req.url);q=parse_qs(u.query);path=u.path
    if req.url.startswith(origin+'/'):route.continue_();return
    if req.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
        route.fulfill(content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No PDF in fixture");}};');return
    if u.netloc!='wiulvaqixphuobdielyy.supabase.co':unexpected.append(req.url);route.abort();return
    if req.method=='OPTIONS':route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'});return
    if path.startswith('/storage/v1/object/authenticated/sentlog-temp/'):
        key=path.split('/sentlog-temp/',1)[1]
        route.fulfill(status=200,content_type='image/jpeg',headers={'Access-Control-Allow-Origin':'*'},body=blobs[key]);return
    if path.startswith('/storage/v1/object/sentlog-temp/'):
        assert req.method=='POST',req.method
        blobs[path.split('/sentlog-temp/',1)[1]]=req.post_data_buffer
        respond(route,{'ok':True});return
    body=json.loads(req.post_data) if req.post_data else None
    if path.endswith('/rpc/sentlog_archive_v1'):
        assert body['p_action']=='list',body
        respond(route,[cp]);return
    if path.endswith('/rpc/sentlog_ack_asset') or path.endswith('/rpc/sentlog_request_photo_v1'):
        respond(route,True);return
    if path.endswith('/sentlog_devices'):
        device=q.get('id',['eq.device'])[0][3:]
        respond(route,[dict(id=device,active=True)]);return
    if path.endswith('/sentlog_projects'):respond(route,[cp]);return
    if path.endswith('/sentlog_project_snapshots'):
        if req.method=='GET':respond(route,[cloud]);return
        assert req.method=='POST',req.method
        if fail_write:respond(route,dict(message='試験用：通信中断'),503);return
        if race_write:
            race_write=False;cloud=copy.deepcopy(cloud);cloud['revision']+=1
            cloud['payload']['drawings'][0]['state']['shapes'].append(record('third-device'))
        if body['revision']!=cloud['revision']+1:respond(route,dict(message='別端末の変更があります。同期を再確認してください。'),409);return
        cloud=copy.deepcopy(body);writes.append(copy.deepcopy(body));respond(route,[cloud]);return
    if path.endswith('/sentlog_assets'):
        if req.method=='GET':
            rows=list(assets.values())
            for field in ('client_key','kind','project_id','status','id'):
                term=q.get(field,[None])[0]
                if term and term.startswith('eq.'):rows=[a for a in rows if a.get(field)==term[3:]]
                if term and term.startswith('neq.'):rows=[a for a in rows if a.get(field)!=term[4:]]
            respond(route,rows);return
        assert req.method in ('POST','PATCH')
        body['id']=body.get('id',str(uuid.uuid4()));assets[body['client_key']]=body;respond(route,[body]);return
    if path.endswith('/sentlog_pdf_requests'):respond(route,[]);return
    unexpected.append((req.method,path,body));respond(route,{},500)

def make_page(browser,name,pack,width=810):
    context=browser.new_context(viewport=dict(width=width,height=1000),service_workers='block')
    seed={WS:json.dumps({'projects':[pack['project']]}),DRAW:json.dumps(pack['drawings'][0]['state']),META:json.dumps(dict(revision=1,local_updated_at=1,fingerprint='pre-v180-baseline',fingerprint_schema=2))}
    init='window.sentlogImporting=true;'+''.join(f'localStorage.setItem({json.dumps(k)},{json.dumps(v)});' for k,v in seed.items())
    init+=f"localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({{access_token:'synthetic',expires_at:Date.now()/1000+3600,user:{{id:'owner',email:'test@example.invalid'}}}}));localStorage.setItem('sentlogCloudDeviceV1',{json.dumps(name)});"
    context.add_init_script(init);context.route('**/*',transport)
    page=context.new_page();page.goto(origin+'/sentlog/',wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.80'")
    return context,page
def sync(page):
    page.evaluate('async()=>{window.sentlogImporting=false;await window.sentlogCloudIdle();await window.sentlogArchiveSync();await window.sentlogCloudIdle();window.sentlogImporting=true;}')
def ids(page):return page.evaluate(f"JSON.parse(window.SentlogRecords.getItem('{DRAW}')).shapes.map(s=>s.id)")
def open_merge(page):
    page.locator('#sentlogCloudStatus').click();expect(page.get_by_role('button',name='両方の記録を残して同期',exact=True)).to_be_visible()
def merge_click(page):
    page.get_by_role('button',name='両方の記録を残して同期',exact=True).click()
    page.wait_for_function("!document.querySelector('#sentlogMergePanel button')?.disabled")
def checkpoints(page):return page.evaluate("window.SentlogRecords.keys().filter(k=>k.startsWith('sentlogSyncMergeCheckpointV1:')).map(k=>JSON.parse(window.SentlogRecords.getItem(k)))")
def add_record(page,name):
    page.evaluate("""async s=>{const S=window.SentlogRecords,w=JSON.parse(S.getItem('surveyFieldNoteWorkspaceV1')),d=JSON.parse(S.getItem('surveyFieldNoteDrawingV1:d'));d.shapes.push(s);w.projects[0].updatedAt=Date.now();workspace=w;S.batch([['surveyFieldNoteWorkspaceV1',JSON.stringify(w)],['surveyFieldNoteDrawingV1:d',JSON.stringify(d)]]);await S.settled();} """,record(name))

try:
    with sync_playwright() as pw:
        engine=os.getenv('SENTLOG_TEST_BROWSER','chromium');opts=dict(headless=True)
        executable=os.getenv('SENTLOG_CHROMIUM_EXECUTABLE','/usr/bin/chromium')
        if engine=='chromium' and os.path.exists(executable):opts.update(executable_path=executable,args=['--no-sandbox'])
        browser=getattr(pw,engine).launch(**opts)
        ipad=payload(['common','ipad']);phone=payload(['common','phone'])
        for pack,name in [(ipad,'ipad'),(phone,'phone'),(cloud['payload'],'phone')]:
            pack['drawings'][0]['state']['shapes'][1]['photos']=[dict(id='photo-'+name,name=name+'.jpg',createdAt=1)]
        raw=b'phone-photo';blobs['phone.jpg']=raw
        assets['photo:d:photo-phone']=dict(id='asset-phone',project_id='cloud-p',client_key='photo:d:photo-phone',kind='photo',file_name='phone.jpg',storage_path='phone.jpg',mime_type='image/jpeg',byte_size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),status='uploaded',source_device_id='phone',metadata=dict(drawing_id='d',photo_id='photo-phone'))
        ca,a=make_page(browser,'ipad',ipad);cb,b=make_page(browser,'phone',phone,390)
        a.evaluate("window.SentlogRecords.writeFile('photo:d:photo-ipad',new Blob(['ipad-photo'],{type:'image/jpeg'}))")
        b.evaluate("window.SentlogRecords.writeFile('photo:d:photo-phone',new Blob(['phone-photo'],{type:'image/jpeg'}))")
        sync(a);assert not writes;assert ids(a)==['common','ipad']
        open_merge(a)
        # Storage refusal must precede any in-memory record replacement or network write.
        a.evaluate("window.savedMergeAtomic=window.SentlogRecords.archiveAtomic;window.SentlogRecords.archiveAtomic=async()=>{throw Error('試験用：保存容量不足')}")
        merge_click(a);expect(a.locator('#sentlogMergePanel')).to_contain_text('保存容量不足')
        assert ids(a)==['common','ipad'] and not checkpoints(a) and not writes
        a.evaluate('window.SentlogRecords.archiveAtomic=window.savedMergeAtomic')
        merge_click(a);a.wait_for_function("JSON.parse(window.SentlogRecords.getItem('surveyFieldNoteDrawingV1:d')).shapes.length===3")
        assert set(ids(a))=={'common','phone','ipad'}
        saved=checkpoints(a);assert len(saved)==1
        assert len(saved[0]['local']['drawings'][0]['state']['shapes'])==2 and len(saved[0]['remote']['drawings'][0]['state']['shapes'])==2
        # Failure after local commit leaves the merged records and checkpoint on disk.
        fail_write=True;sync(a);assert cloud['revision']==2;assert len(ids(a))==3
        fail_write=False;sync(a);assert len(cloud['payload']['drawings'][0]['state']['shapes'])==3
        assert a.evaluate("async()=>{const b=await getDBFile('photo:d:photo-ipad');return await b.text()}")=='ipad-photo'
        assert a.evaluate("async()=>{const b=await getDBFile('photo:d:photo-phone');return await b.text()}")=='phone-photo'
        sync(b);open_merge(b);merge_click(b);sync(b);assert set(ids(b))==set(ids(a))
        assert len(checkpoints(b))==1 and len(cloud['payload']['drawings'][0]['state']['shapes'])==3
        # After first repair both devices have a real ancestor. Independent field work merges automatically.
        add_record(a,'next-ipad');add_record(b,'next-phone');sync(a);sync(b);sync(a)
        assert set(ids(a))==set(ids(b))=={'common','phone','ipad','next-ipad','next-phone'}
        # A third writer racing the upload is rejected by the revision guard, then merged on retry.
        add_record(a,'racing-ipad');race_write=True;sync(a);sync(a);sync(b)
        assert set(ids(a))==set(ids(b)) and {'third-device','racing-ipad'}<=set(ids(a))
        # Atomic commit checks drawing records, not just project timestamps.
        result=a.evaluate("""async()=>{const S=SentlogRecords,k='surveyFieldNoteDrawingV1:d',before=S.getItem(k),w=S.getItem('surveyFieldNoteWorkspaceV1');try{await S.archiveAtomic({writes:[[k,'{}']],deleteFiles:[],expectedWorkspace:w,expectedRecords:[[k,'stale']]});return false;}catch(e){return S.getItem(k)===before}}""")
        assert result
        # Checkpoint and merged data survive closing/reopening a browser tab.
        expected=set(ids(a));a.reload();a.wait_for_function("window.SENTLOG_BUILD==='v1.80'");assert set(ids(a))==expected and checkpoints(a)
        (ROOT/'test-results').mkdir(exist_ok=True);b.screenshot(path=str(ROOT/'test-results/sync-merge-phone.png'),full_page=True)
        assert b.evaluate('document.documentElement.scrollWidth<=innerWidth')
        ca.close();cb.close()
        # Genuine same-record edits remain visible and unchanged, even on explicit preserve.
        cloud=dict(revision=2,payload=payload(['common']),updated_at='2026-10-19T00:00:00Z');cloud['payload']['drawings'][0]['state']['shapes'][0]['memo']='共有側の説明'
        pack=payload(['common']);pack['drawings'][0]['state']['shapes'][0]['memo']='iPad側の説明';before=len(writes)
        cc,c=make_page(browser,'conflicting-ipad',pack);sync(c);open_merge(c);merge_click(c)
        expect(c.locator('#sentlogMergePanel')).to_contain_text('同じ記録')
        assert c.evaluate("JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:d')).shapes[0].memo")=='iPad側の説明'
        assert cloud['payload']['drawings'][0]['state']['shapes'][0]['memo']=='共有側の説明'
        assert len(writes)==before and not checkpoints(c)
        assert not unexpected,unexpected
        cc.close();browser.close()
        print('PASS two-device live app: conflict repair, native checkpoints, both photo blobs, automatic next edits, stale-revision race, storage/network failure, reload, true-conflict stop, phone layout')
finally:
    server.shutdown();server.server_close()

"""Production HTML + real IndexedDB/WAL + actual PostgreSQL RPCs in two browsers.

Only Auth, Storage transport and Realtime delivery are synthetic. Every delta,
baseline, checkpoint and archive RPC executes the reviewed SQL in PGlite.
Persistent profiles keep the native WebKit Blob path; no memory store fallback.
"""
import argparse
import base64
import copy
import functools
import hashlib
import json
import subprocess
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright
import collaboration_ui as collaboration
import edit_sync_ui as base
from delta_capacity_app_flow import run as run_capacity_flow, READ_FILES as READ_NATIVE_FILES

ROOT = Path(__file__).resolve().parents[1]
OWNER, A, B = collaboration.OWNER, collaboration.A, collaboration.B
PID = base.CLOUD_PROJECT
PC = '77777777-7777-4777-8777-777777777777'
CP = dict(id=PID, client_key=base.PROJECT, name='実動作の同期検証', status='active')

# Observe the production factories before the application captures them. These
# wrappers retain the original return values and promises; they never substitute
# IndexedDB, transport responses, receipt state or the application's scheduler.
PHOTO_TRACE = r"""(() => {
  const events=[],probes=[],idbErrors=[];
  window.__deltaPhotoDiagnostics={events,probes,idbErrors};
  const add=(list,value)=>{list.push({at:Date.now(),...value});if(list.length>160)list.shift();};
  const err=e=>({name:e?.name,code:e?.code,message:String(e?.message||e),status:e?.status});
  const blobPaths=(value,path='$',out=[],seen=new WeakSet())=>{
    if(out.length>=32||!value||typeof value!=='object'||seen.has(value))return out;
    seen.add(value);
    if(value instanceof Blob){out.push({path,size:value.size,type:value.type,file:value instanceof File,name:value.name});return out;}
    for(const [key,item]of Object.entries(value))blobPaths(item,path+'.'+key,out,seen);
    return out;
  };
  for(const [prototype,methods]of [[IDBObjectStore.prototype,['put','add']],[IDBCursor.prototype,['update']]])for(const method of methods){
    const native=prototype[method];
    prototype[method]=function(value,...rest){
      const store=this instanceof IDBObjectStore?this:this.source,stack=new Error().stack;
      const details=()=>({stage:'idb.'+method,event:'error',database:store.transaction?.db?.name,store:store.name,
        key:rest[0]??this.primaryKey,blobs:blobPaths(value),stack});
      const failed=error=>{const value={...details(),...err(error)};add(events,value);if(error?.name!=='AbortError')add(idbErrors,value);};
      let request;try{request=native.call(this,value,...rest);}catch(error){failed(error);throw error;}
      request.addEventListener('error',()=>failed(request.error));
      return request;
    };
  }
  function observe(object,method,label,details=()=>({}),inspect=()=>({})){
    const native=object[method];
    object[method]=function(...args){
      const started=Date.now(),info=details(args);add(events,{stage:label,event:'start',...info});
      let result;try{result=native.apply(this,args);}catch(e){add(events,{stage:label,event:'error',...info,...err(e),...inspect(args)});throw e;}
      if(result?.then)result.then(value=>add(events,{stage:label,event:'done',...info,elapsed:Date.now()-started,
        complete:value?.complete,pending:value?.pending,deferred:value?.deferred,cursor:value?.cursor,issues:value?.issues,
        assetId:value?.asset?.id,references:value?.references?.map(x=>({assetId:x.assetId,photoId:x.photoId})),
        assets:Array.isArray(value)?value.map(x=>({id:x.id,key:x.client_key,status:x.status})):undefined}),
        e=>add(events,{stage:label,event:'error',...info,elapsed:Date.now()-started,...err(e),...inspect(args)}));
      return result;
    };
  }
  function intercept(name,wrap){
    Object.defineProperty(window,name,{configurable:true,set(value){
      Object.defineProperty(window,name,{value,writable:true,configurable:true,enumerable:true});
      const native=value.createRuntime||value.createTransport,key=value.createRuntime?'createRuntime':'createTransport';
      value[key]=function(options){return wrap(native.call(this,options),options);};
    }});
  }
  intercept('SentlogDeltaAssetTransport',(transport)=>{
    for(const method of ['listPhotos','uploadPhoto','download','acknowledge'])observe(transport,method,'transport.'+method,
      args=>({photoId:args[0]?.photoId,assetId:args[0]?.assetId,size:args[1] instanceof Blob?args[1].size:undefined}));
    return transport;
  });
  intercept('SentlogDeltaAssetRuntime',(runtime,options)=>{
    const inspect=args=>{try{return {scopeCurrent:!!options.currentScope(),snapshotCurrent:options.currentSnapshotToken()===args[0]?.snapshotToken};}catch(e){return {probeError:String(e)};}};
    observe(runtime,'sync','assets.sync',()=>({}),inspect);
    probes.push(()=>({scope:options.scope,scopeCurrent:!!options.currentScope()}));
    return runtime;
  });
  intercept('SentlogDeltaAppRuntime',(runtime)=>{
    observe(runtime,'photos','application.photos',args=>({projectId:args[0]?.id}));
    observe(runtime,'sync','application.sync',args=>({projectId:args[0]?.id}));
    return runtime;
  });
})();"""

PHOTO_STATE = r"""async()=>{
  const diagnostics=window.__deltaPhotoDiagnostics;
  let assets;
  try{
    assets=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('sentlog-delta-assets-v1');
      request.onupgradeneeded=()=>{request.transaction.abort();resolve({notOpened:true});};
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result;
        try{
          const tx=db.transaction('assets','readonly'),get=tx.objectStore('assets').getAll();
          tx.oncomplete=()=>{db.close();resolve(get.result.map(row=>({key:row.key,phase:row.phase,revision:row.revision,
            reference:row.reference,blob:row.blob instanceof Blob?{size:row.blob.size,type:row.blob.type}:null,
            localReceipt:row.localReceipt,remoteReceipt:row.remoteReceipt})));};
          tx.onerror=()=>{db.close();reject(tx.error);};
        }catch(e){db.close();reject(e);}
      };
    });
  }catch(e){assets={error:String(e)};}
  return {events:diagnostics?.events,idbErrors:diagnostics?.idbErrors,assets,
    scopes:diagnostics?.probes.map(probe=>{try{return probe();}catch(e){return {error:String(e)};}}),
    storageBodies:window.__sentlogWebKitStorageBodies,
    ui:[...document.querySelectorAll('[id*="Sync"],[id*="sync"],[id*="Cloud"]')]
      .filter(el=>el.offsetParent&&el.innerText&&el.innerText.length<500).map(el=>({id:el.id,text:el.innerText})).slice(-12)};
}"""


class Backend:
    def __init__(self, root):
        self.log = tempfile.TemporaryFile(mode='w+t')
        self.process = subprocess.Popen(['node', 'tests/delta_app_backend.cjs'], cwd=root,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, text=True, bufsize=1)
        line = self.process.stdout.readline()
        assert line and json.loads(line).get('ready'), ('Backend failed to initialize', line)

    def call(self, **request):
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        assert line, ('Backend stopped', self.process.poll())
        return json.loads(line)

    def admin(self, **request):
        response = self.call(**request)
        assert response['ok'], response
        return response['data']

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
        self.log.close()


class Cloud(collaboration.Cloud):
    def __init__(self, origin, root, engine, backend):
        super().__init__(origin, root, engine)
        self.backend, self.offline, self.receipts, self.sql_errors = backend, set(), {}, []
        self.photo_requests = []
        self.webkit_sources = {}  # Serve the exact built application source.

    @staticmethod
    def rows(values, query):
        # PostgREST quotes reserved characters in text equality filters. Match
        # the decoded value when the real asset transport looks up its upload.
        normalized = {}
        for key, terms in query.items():
            normalized[key] = []
            for term in terms:
                if term.startswith('eq."') and term.endswith('"'):
                    term = 'eq.' + json.loads(term[3:])
                normalized[key].append(term)
        return base.FakeCloud.rows(values, normalized)

    def route(self, route, device):
        request, url = route.request, urlparse(route.request.url)
        if url.netloc != 'wiulvaqixphuobdielyy.supabase.co' or request.method == 'OPTIONS':
            return super().route(route, device)
        if device in self.offline:
            route.abort('internetdisconnected')
            return
        path, query = url.path, parse_qs(url.query)
        body = json.loads(request.post_data) if '/storage/' not in path and request.post_data else None
        if '/storage/' in path or path.endswith(('/sentlog_assets','/sentlog_asset_device_receipts','/rpc/sentlog_ack_photo','/rpc/sentlog_request_photo')):
            self.photo_requests.append(dict(at=time.time(),device=device,path=path,method=request.method,query=query,
                assetId=body.get('p_asset_id') if isinstance(body,dict) else None))
        if path.endswith('/sentlog_asset_device_receipts'):
            self.respond(route, self.rows(self.receipts.values(), query))
            return
        if path.endswith('/rpc/sentlog_ack_photo'):
            asset = self.assets[body['p_asset_id']]
            assert asset['sha256'] == body['p_sha256'] and asset['byte_size'] == body['p_byte_size']
            self.receipts[(asset['id'], device)] = dict(asset_id=asset['id'], owner_id=OWNER,
                device_id=device, sha256=asset['sha256'], byte_size=asset['byte_size'], received_at='2026-11-20T12:00:00Z')
            self.respond(route, {'received': True})
            return
        tables = ('/sentlog_projects', '/sentlog_devices', '/sentlog_project_snapshots')
        if '/rpc/sentlog_delta_' in path or path.endswith('/rpc/sentlog_archive_v1') or path.endswith(tables):
            entry = dict(op='request', ownerId=OWNER, deviceId=device, method=request.method,
                         path=path, query=query, body=body, headers=dict(request.headers))
            result = self.backend.call(**entry)
            self.requests.append(dict(device=device, path=path, method=request.method, body=body))
            if not result['ok']:
                self.sql_errors.append(dict(path=path, **result['error']))
            data = result.get('data') if result['ok'] else result['error']
            self.respond(route, data, result.get('status', 200 if result['ok'] else 400))
            if result['ok'] and '/rpc/sentlog_delta_append' in path:
                self.notifications.append(dict(kind='delta', project_id=PID, seq=data.get('endSeq', data.get('seq'))))
            return
        result = super().route(route, device)
        if path.endswith('/sentlog_assets') and request.method in ('POST', 'PATCH'):
            self.backend.admin(op='admin', action='assets', ownerId=OWNER, assets=list(self.assets.values()))
        return result


def make_page(engine, profile, cloud, device):
    context = engine.launch_persistent_context(profile, headless=True, viewport={'width': 820 if device == A else 390, 'height': 1000},
                                               is_mobile=True, has_touch=True, service_workers='block')
    session = dict(access_token='synthetic-access-token', expires_at=time.time()+3600, user=dict(id=OWNER, email='fixture@example.invalid'))
    socket = collaboration.SOCKET.replace('revision:v.revision}', 'revision:v.revision,seq:v.seq}')
    context.add_init_script(socket + "window.sentlogImporting=true;Object.defineProperty(navigator,'onLine',{get:()=>!window.__fixtureOffline});"
                           + "localStorage.setItem('sentlogCloudSessionV1'," + json.dumps(json.dumps(session)) + ');'
                           + "localStorage.setItem('sentlogCloudDeviceV1'," + json.dumps(device) + ');')
    if cloud.engine == 'webkit':
        context.add_init_script(collaboration.WEBKIT_STORAGE_BODY)
    context.add_init_script(PHOTO_TRACE)
    context.route('**/*', lambda route: cloud.route(route, device))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(cloud.origin+'/sentlog/', wait_until='domcontentloaded')
    page.wait_for_function('window.sentlogDeltaRuntime&&window.sentlogAppReady&&window.SentlogDeltaMetadataUI', timeout=45000)
    page.evaluate('async()=>await sentlogAppReady')
    cloud.pages.append(page)
    cloud.page_errors.append(errors)
    return context, page, errors


def wait(cloud, page, predicate, description, timeout=45):
    deadline = time.monotonic()+timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError(description)
        cloud.pump()
        page.wait_for_timeout(80)


def saved(page):
    return page.evaluate("JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:edit-plan'))")


def saved_record(page):
    return next(record for record in saved(page)['shapes'] if record['id']=='survey-a')


def sync(page):
    return page.evaluate('async cp=>{await SentlogRecords.settled();return sentlogDeltaRuntime.sync(cp)}', CP)


def assert_native_writes(page):
    errors = page.evaluate("()=>window.__deltaPhotoDiagnostics.idbErrors.filter(error=>error.name!=='AbortError')")
    assert not errors, ('Unexpected native IndexedDB write failure', errors)


def run(engine, cloud, root):
    with tempfile.TemporaryDirectory(prefix='delta-app-a-') as pa, tempfile.TemporaryDirectory(prefix='delta-app-b-') as pb:
        ca, a, ea = make_page(engine, pa, cloud, A)
        cb, b, eb = make_page(engine, pb, cloud, B)
        try:
            pack = base.payload(base.PROJECT, base.DRAWING)
            setup = dict(packs=[pack], encoded=base64.b64encode(base.photo_png()).decode('ascii'))
            a.evaluate(base.SETUP, setup)
            baseline = a.evaluate("""async()=>{
              for(const [key,value]of editFixture.files)await SentlogRecords.writeFile(key,value);
              const ws=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY));
              for(const p of ws.projects){p.collaborationVersion=1;for(const d of p.drawings){
                const state=JSON.parse(SentlogRecords.getItem(drawingStorageKey(d.id)));
                state.shapes=state.shapes.map(r=>SentlogRecordCollaboration.upgrade(r));
                SentlogRecords.setItem(drawingStorageKey(d.id),JSON.stringify(state));}}
              SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(ws));await SentlogRecords.settled();
              return editFixture.snapshots();
            }""")
            b.evaluate(base.SETUP, {**setup, 'packs': baseline})
            b.evaluate('async()=>{for(const [key,value]of editFixture.files)await SentlogRecords.writeFile(key,value);await SentlogRecords.settled();}')
            # Existing users migrate database-backed Files after reopening the
            # app, not just the fresh in-memory objects from a file picker.
            # Keep the real native File/Blob path when creating the cutoff.
            legacy_keys = ['background:edit-plan', 'photo:edit-plan:retained-photo']
            for page in (a, b):
                before_files = page.evaluate(READ_NATIVE_FILES, legacy_keys)
                assert all(not item.get('missing') for item in before_files), before_files
                assert_native_writes(page)
                page.reload(wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogDeltaRuntime&&SentlogRecords.ready', timeout=45000)
                page.evaluate('async()=>await sentlogAppReady')
                after_files = page.evaluate(READ_NATIVE_FILES, legacy_keys)
                assert after_files == before_files, 'Legacy native files changed across a real page restart before migration'
                assert page.evaluate("SentlogRecords.deltaJournal.bindingFor('edit-project')===null")
            print('PASS existing native File/Blob bytes survive restart before protected application migration', flush=True)
            cloud.backend.admin(op='seed', ownerId=OWNER,
                devices=[dict(id=A,name='検証iPad'),dict(id=B,name='検証iPhone'),dict(id=PC,name='検証PC',type='pc')],
                projects=[dict(id=PID,client_key=base.PROJECT,payload=baseline[0])],rollout=True)
            for page in (a,b):
                page.evaluate("async()=>{showProjects();sentlogImporting=false;await sentlogArchiveSync({force:true});}")
            wait(cloud,a,lambda:all(p.evaluate("SentlogRecords.deltaJournal.bindingFor('edit-project')?.phase==='active'") for p in (a,b)),
                 'Actual application migration did not activate both durable writers',90)
            for page in (a,b):
                result=sync(page)
                assert result['enabled'] and not result.get('pending'), result
            state=cloud.backend.admin(op='state',ownerId=OWNER,projectId=PID)
            assert state['heads'][0]['enabled'],state['counts']
            print('PASS actual HTML activates both protected writers using the real SQL baseline and metadata seed',flush=True)

            for page,scale,rotation in [(a,125,None),(b,None,90)]:
                page.evaluate("""async ({scale,rotation})=>{
                  await openDrawing('edit-project','edit-plan');
                  if(scale!==null)state.pageSettings['1']={...(state.pageSettings['1']||{}),scale};
                  if(rotation!==null)state.pageRotations['1']=rotation;
                  persist();await SentlogRecords.settled();showProjects();
                }""",dict(scale=scale,rotation=rotation))
            wait(cloud,a,lambda:all(saved(p).get('pageSettings',{}).get('1',{}).get('scale')==125 and saved(p).get('pageRotations',{}).get('1')==90 for p in (a,b)),
                 'Independent drawing setting edits did not merge into both real legacy mirrors')
            print('PASS drawing scale and rotation changed through persist(), journal, atomic delta and renderer',flush=True)

            # Two disconnected edits of the same scalar keep both alternatives.
            for device,page,value in [(A,a,150),(B,b,175)]:
                cloud.offline.add(device)
                page.evaluate('()=>window.__fixtureOffline=true')
                page.evaluate("""async value=>{await openDrawing('edit-project','edit-plan');
                  state.pageSettings['1'].scale=value;persist();await SentlogRecords.settled();showProjects();}""",value)
            assert_native_writes(a)
            a.reload(wait_until='domcontentloaded')
            a.wait_for_function('window.sentlogDeltaRuntime&&SentlogRecords.ready',timeout=45000)
            a.evaluate('async()=>await sentlogAppReady')
            assert saved(a)['pageSettings']['1']['scale']==150
            assert a.evaluate("SentlogRecords.deltaJournal.bindingFor('edit-project').phase")=='active'
            print('PASS saved offline input survives a real page restart before journal replay',flush=True)
            cloud.offline.clear()
            for page in (a,b):
                page.evaluate("()=>{window.__fixtureOffline=false;sentlogImporting=false;window.dispatchEvent(new Event('online'));}")
            wait(cloud,a,lambda:a.locator('#sentlogDeltaMetadataNotice').is_visible(), 'Conflicting scale choices were not shown')
            a.locator('#sentlogDeltaMetadataNotice button').click()
            a.get_by_role('button',name='150 を使う',exact=True).click()
            wait(cloud,a,lambda:'選んだ内容を保存しました' in a.locator('#sentlogDeltaMetadataDialog').inner_text(), 'Explicit settings resolution was not saved')
            a.locator('#sentlogDeltaMetadataDialog').get_by_role('button',name='閉じる',exact=True).click()
            wait(cloud,a,lambda:all(saved(p)['pageSettings']['1']['scale']==150 for p in (a,b)), 'Chosen scale did not converge')
            print('PASS same-setting candidates remain visible and an explicit UI choice converges',flush=True)

            a.evaluate("async()=>{await openDrawing('edit-project','edit-plan');SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');}")
            collaboration.add_comment(a,'切替後もコメントを保存')
            a.locator('#slCollabDraft').press('Tab')
            collaboration.capture(a,'delta-camera.png')
            wait(cloud,a,lambda:len(saved_record(a).get('photos',[]))>=2,'Real camera save did not reach the journal')
            a.evaluate('()=>showProjects()')
            wait(cloud,a,lambda:len(saved_record(b).get('photos',[]))>=2,'Peer did not automatically receive the camera record')
            reference=next(photo for photo in saved_record(a)['photos'] if photo['id']!='retained-photo')
            def received_by_both():
                asset=next((item for item in cloud.assets.values() if item['client_key']=='photo:edit-plan:'+reference['id']),None)
                return asset and all((asset['id'],device) in cloud.receipts for device in (A,B))
            wait(cloud,a,received_by_both,'Automatic photo delivery did not produce both exact-byte receipts')
            hashes=[]
            for page in (a,b):
                hashes.append(page.evaluate("""async id=>{const blob=await getDBFile('photo:edit-plan:'+id);
                  if(!(blob instanceof Blob))return null;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');}""",reference['id']))
            assert hashes[0] and hashes[0]==hashes[1],hashes
            assert all('切替後もコメントを保存' in saved_record(p)['memo'] for p in (a,b))
            print('PASS actual capture, record comment, native Blob storage and exact peer ACK remain connected',flush=True)

            certificate=a.evaluate('cp=>sentlogDeltaRuntime.checkpoint(cp,{force:true})',CP)
            assert certificate['payload']['drawings'][0]['state']['pageSettings']['1']['scale']==150
            certified_record=next(record for record in certificate['payload']['drawings'][0]['state']['shapes'] if record['id']=='survey-a')
            assert '切替後もコメントを保存' in certified_record['memo']
            assert len(certified_record['photos'])>=2
            print('PASS actual application publishes a current PC-compatible certified snapshot',flush=True)
            run_capacity_flow(cloud,a,b,certificate,CP,OWNER,A,B,PC)
            for page in (a, b):
                assert_native_writes(page)
            a.screenshot(path=f'/tmp/sentlog-delta-app-{cloud.engine}.png',full_page=True)
            assert not ea and not eb,dict(a=ea,b=eb)
            assert not cloud.unexpected,cloud.unexpected
            print('PASS delta full application '+cloud.engine,flush=True)
        finally:
            for i,page in enumerate((a,b)):
                try:
                    print('DELTA_APP_DIAGNOSTICS',i,json.dumps(page.evaluate("""async()=>({ready:SentlogRecords.ready,failed:SentlogRecords.failed,
                      issues:SentlogRecords.issues,bindings:SentlogRecords.deltaJournal.listBindingsSync().map(b=>({phase:b.phase,ackedSeq:b.ackedSeq})),
                      message:document.getElementById('sentlogCloudMsg')?.textContent,photoStatus:document.getElementById('photoStatus')?.textContent,
                      pendingPhotos:await SentlogCollaborationPhotos.listPending(),
                      records:JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:edit-plan')||'{"shapes":[]}').shapes.map(r=>({id:r.id,photos:(r.photos||[]).map(p=>p.id),memo:r.memo})),
                      live:typeof state==='object'?{selected,drawing:activeDrawingId,records:state.shapes.map(r=>({id:r.id,photos:(r.photos||[]).map(p=>p.id)}))}:null})"""),ensure_ascii=False),flush=True)
                    print('DELTA_PHOTO_DIAGNOSTICS',i,json.dumps(page.evaluate(PHOTO_STATE),ensure_ascii=False),flush=True)
                    page.screenshot(path=f'/tmp/sentlog-delta-app-{cloud.engine}-{i}.png',full_page=True)
                except Exception:
                    pass
            print('DELTA_SQL_ERRORS',json.dumps(cloud.sql_errors[-12:],ensure_ascii=False),flush=True)
            print('DELTA_SERVER_PHOTOS',json.dumps(dict(assets=list(cloud.assets.values()),receipts=list(cloud.receipts.values())),ensure_ascii=False),flush=True)
            print('DELTA_PHOTO_REQUESTS',json.dumps(cloud.photo_requests[-100:],ensure_ascii=False),flush=True)
            print('DELTA_RECENT_REQUESTS',json.dumps([{key:r.get(key) for key in ('device','path','method')} for r in cloud.requests[-20:]]),flush=True)
            ca.close();cb.close()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--engine',choices=('chromium','webkit'),required=True)
    parser.add_argument('--built-root',type=Path,default=ROOT)
    args=parser.parse_args();root=args.built_root.resolve()
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    backend=Backend(root)
    cloud=Cloud(f'http://127.0.0.1:{server.server_port}',root,args.engine,backend)
    try:
        with sync_playwright() as playwright:
            run(getattr(playwright,args.engine),cloud,root)
    finally:
        backend.close();server.shutdown()


if __name__=='__main__':main()

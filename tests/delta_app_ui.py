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
import struct
import subprocess
import tempfile
import threading
import time
import zlib
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
  const events=[],probes=[],idbErrors=[],recovery=[],syncUi=[];
  window.__deltaPhotoDiagnostics={events,probes,idbErrors,recovery,syncUi};
  const add=(list,value)=>{
    const entry={at:Date.now(),...value};list.push(entry);if(list.length>160)list.shift();
    if(list===events&&value.stage==='application.sync'){
      if(value.event==='error'&&value.code==='DELTA_MIGRATION_RECOVERING')recovery.push(entry);
      else if(value.event==='start'&&recovery.length&&!recovery.at(-1).nextStart)recovery.at(-1).nextStart=entry.at;
    }
  };
  const err=e=>({name:e?.name,code:e?.code,message:String(e?.message||e),status:e?.status,recovered:e?.recovered,remaining:e?.remaining});
  new MutationObserver(()=>{
    const result=document.querySelector('#sentlogCloudDetails [role="status"]'),message=result?.textContent||'';
    if(result?.offsetParent&&message.includes('不足している写真・図面を受信しています（残り')&&syncUi.at(-1)?.message!==message)
      add(syncUi,{message,level:result.getAttribute('data-level')});
  }).observe(document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-level']});
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
  return {events:diagnostics?.events,idbErrors:diagnostics?.idbErrors,recovery:diagnostics?.recovery,syncUi:diagnostics?.syncUi,assets,
    scopes:diagnostics?.probes.map(probe=>{try{return probe();}catch(e){return {error:String(e)};}}),
    storageBodies:window.__sentlogWebKitStorageBodies,
    ui:[...document.querySelectorAll('[id*="Sync"],[id*="sync"],[id*="Cloud"]')]
      .filter(el=>el.offsetParent&&el.innerText&&el.innerText.length<500).map(el=>({id:el.id,text:el.innerText})).slice(-12)};
}"""

READ_DURABLE_PHOTO = r"""async ({scope,reference,key})=>{
  // Read both real IndexedDB copies while the HTTP ACK is still unserved.
  // This probe cannot manufacture a receipt or substitute downloaded bytes.
  const store=SentlogDeltaAssets.createIndexedDBStore(scope);
  const digest=async blob=>blob instanceof Blob?{size:blob.size,mimeType:blob.type,
    sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))]
      .map(value=>value.toString(16).padStart(2,'0')).join('')}:null;
  try{
    const row=await store.read(reference),db=await SentlogRecords.openFilesDatabase();
    let local;
    try{local=await new Promise((resolve,reject)=>{
      const tx=db.transaction('files','readonly'),request=tx.objectStore('files').get(key);
      tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
    return {scope:row?.scope,reference:row?.reference,phase:row?.phase,
      localReceipt:row?.localReceipt,stored:await digest(row?.blob),local:await digest(local)};
  }finally{store.close();}
}"""

READ_MIGRATION_PHOTOS = r"""async ({scope,localProjectId})=>{
  const store=SentlogDeltaIndexedDB.createStore(scope);
  const migration=SentlogDeltaMigration.createCoordinator({
    source:{capture:async()=>{throw Error('read-only probe');},recheck:async()=>{throw Error('read-only probe');}},
    store:SentlogDeltaMigration.createStore(scope),localProjectId,currentScope:()=>scope});
  try{
    const provenance=await store.readProvenance(),saved=await migration.readCopy(provenance.source.migrationId);
    const cutoff=await SentlogRecords.deltaJournal.readCutoff({scope,localProjectId});
    return {cutoff:{bindingId:cutoff.bindingId,cutoffSeq:cutoff.cutoffSeq,rawEntries:cutoff.rawEntries},
      cutoffPhotos:cutoff.files.filter(file=>file.key.startsWith('photo:')).map(file=>file.key).sort(),
      copiedPhotos:saved.snapshot.files.filter(file=>file.kind==='photo').map(({blob,...file})=>file),
      pending:saved.snapshot.manifest.filter(file=>file.status==='shared-photo-pending')};
  }finally{migration.close();store.close();}
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
        self.durable_ack_checks = []
        self.webkit_sources = {}  # Serve the exact built application source.

    @staticmethod
    def rows(values, query):
        # PostgREST quotes reserved characters in text equality filters. Match
        # the decoded value when the real asset transport looks up its upload.
        normalized = {}
        values = list(values)
        for key, terms in query.items():
            normalized[key] = []
            for term in terms:
                if term.startswith('in.(') and term.endswith(')') and '"' in term:
                    identities = json.loads('[' + term[4:-1] + ']')
                    values = [value for value in values if str(value.get(key)) in identities]
                    continue
                if term.startswith('eq."') and term.endswith('"'):
                    term = 'eq.' + json.loads(term[3:])
                normalized[key].append(term)
        return base.FakeCloud.rows(values, {key: terms for key, terms in normalized.items() if terms})

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
        if '/storage/v1/object/authenticated/sentlog-temp/' in path and request.method == 'GET':
            storage_key = path.split('/storage/v1/object/authenticated/sentlog-temp/', 1)[1]
            data = self.blobs.get(storage_key)
            asset = next((asset for asset in self.assets.values() if asset['storage_path'] == storage_key), None)
            # The shared fixture's JPEG default would change the Blob MIME of
            # a PNG delivered by the normal receiver after pending activation.
            route.fulfill(status=200 if data is not None else 404,
                content_type=asset['mime_type'] if asset else 'application/octet-stream',
                headers={'Access-Control-Allow-Origin': '*'}, body=data or b'')
            return
        if path.endswith('/sentlog_asset_device_receipts'):
            self.respond(route, self.rows(self.receipts.values(), query))
            return
        if path.endswith('/rpc/sentlog_ack_photo'):
            asset = self.assets[body['p_asset_id']]
            assert asset['sha256'] == body['p_sha256'] and asset['byte_size'] == body['p_byte_size'] and body['p_device_id'] == device
            scope = dict(ownerId=OWNER, projectId=asset['project_id'], deviceId=device)
            reference = dict(ownerId=asset['owner_id'], projectId=asset['project_id'], assetId=asset['id'],
                drawingId=asset['metadata']['drawing_id'], photoId=asset['metadata']['photo_id'], variant='shared',
                sha256=asset['sha256'], size=asset['byte_size'], mimeType=asset['mime_type'])
            proof = request.frame.evaluate(READ_DURABLE_PHOTO, dict(scope=scope, reference=reference, key=asset['client_key']))
            assert proof['scope'] == scope and proof['reference'] == reference and proof['phase'] in ('received','acknowledged'), proof
            assert proof['localReceipt'] == {**reference, 'deviceId':device, 'verified':True}, proof
            expected = dict(size=reference['size'], mimeType=reference['mimeType'], sha256=reference['sha256'])
            assert proof['stored'] == expected and proof['local'] == expected, ('ACK preceded exact durable bytes', proof)
            self.durable_ack_checks.append(dict(device=device, assetId=asset['id'], reference=reference))
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
                                               is_mobile=True, has_touch=True, service_workers='block',
                                               executable_path=getattr(cloud, 'executable_path', None))
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
            # Keep survey-a's camera assertions unchanged. The second existing
            # record supplies 16 distinct PNGs, exceeding the default batch of 16.
            photo_bytes = {'retained-photo': base.photo_png()}
            extra_photos = []
            for index in range(16):
                photo_id = f'recovery-photo-{index:02d}'
                text = b'SentlogFixture\0' + photo_id.encode('ascii')
                chunk = struct.pack('!I', len(text)) + b'tEXt' + text + struct.pack('!I', zlib.crc32(b'tEXt' + text) & 0xffffffff)
                data = base.photo_png()[:-12] + chunk + base.photo_png()[-12:]
                photo_bytes[photo_id] = data
                extra_photos.append(dict(id=photo_id, name=photo_id+'.png', type='image/png', size=len(data),
                                         sha256=hashlib.sha256(data).hexdigest(), createdAt=1))
            next(record for record in pack['drawings'][0]['state']['shapes'] if record['id']=='survey-b')['photos'] = extra_photos
            pack['project']['drawings'][0]['photoCount'] = pack['drawings'][0]['meta']['photoCount'] = len(photo_bytes)
            setup = dict(packs=[pack], encoded=base64.b64encode(base.photo_png()).decode('ascii'))
            a.evaluate(base.SETUP, setup)
            baseline = a.evaluate("""async files=>{
              for(const file of files)editFixture.files.set(file.key,
                new Blob([Uint8Array.from(atob(file.encoded),c=>c.charCodeAt(0))],{type:'image/png'}));
              for(const [key,value]of editFixture.files)await SentlogRecords.writeFile(key,value);
              const ws=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY));
              for(const p of ws.projects){p.collaborationVersion=1;for(const d of p.drawings){
                const state=JSON.parse(SentlogRecords.getItem(drawingStorageKey(d.id)));
                state.shapes=state.shapes.map(r=>SentlogRecordCollaboration.upgrade(r));
                SentlogRecords.setItem(drawingStorageKey(d.id),JSON.stringify(state));}}
              SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(ws));await SentlogRecords.settled();
              return editFixture.snapshots();
            }""", [dict(key='photo:edit-plan:'+photo_id, encoded=base64.b64encode(data).decode('ascii'))
                    for photo_id,data in photo_bytes.items() if photo_id!='retained-photo'])
            b.evaluate(base.SETUP, {**setup, 'packs': baseline})
            # Reproduce the reported deadlock: the other device has received
            # all 17 photo references but no photo bytes when a durable
            # migration cutoff is made. Its later restart must keep that cutoff.
            b.evaluate('async()=>{for(const [key,value]of editFixture.files)if(!key.startsWith("photo:"))await SentlogRecords.writeFile(key,value);await SentlogRecords.settled();}')
            receiver_cutoff = b.evaluate("""async ({owner,project,device})=>{
              const cutoff=await SentlogRecords.deltaJournal.begin({scope:{ownerId:owner,projectId:project,deviceId:device},
                localProjectId:'edit-project',serverRevision:1,actor:{deviceId:device,deviceName:'検証iPhone'}});
              return {bindingId:cutoff.bindingId,cutoffSeq:cutoff.cutoffSeq,rawEntries:cutoff.rawEntries};
            }""",dict(owner=OWNER,project=PID,device=B))
            # Existing users migrate database-backed Files after reopening the
            # app, not just the fresh in-memory objects from a file picker.
            # Keep the real native File/Blob path when creating the cutoff.
            photo_keys = ['photo:edit-plan:'+photo_id for photo_id in photo_bytes]
            legacy_keys = ['background:edit-plan', *photo_keys]
            for page in (a, b):
                before_files = page.evaluate(READ_NATIVE_FILES, legacy_keys)
                if page==a:
                    assert all(not item.get('missing') for item in before_files), before_files
                else:
                    assert not before_files[0].get('missing') and all(item.get('missing') for item in before_files[1:]), before_files
                assert_native_writes(page)
                page.reload(wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogDeltaRuntime&&SentlogRecords.ready', timeout=45000)
                page.evaluate('async()=>await sentlogAppReady')
                after_files = page.evaluate(READ_NATIVE_FILES, legacy_keys)
                assert after_files == before_files, 'Legacy native files changed across a real page restart before migration'
                if page==a:
                    assert page.evaluate("SentlogRecords.deltaJournal.bindingStateFor('edit-project')===null")
                else:
                    assert page.evaluate("SentlogRecords.deltaJournal.bindingStateFor('edit-project')?.phase==='staging'")
            print('PASS existing native File/Blob bytes survive restart before protected application migration', flush=True)
            # Existing restored shared bytes must work with both the recovery
            # reader and the normal delta asset transport after activation.
            seed_assets=[]
            for index,(photo_id,seed_bytes) in enumerate(photo_bytes.items()):
                seed_hash=hashlib.sha256(seed_bytes).hexdigest()
                seed_id=f'77777777-7777-4777-8777-{777777777778+index}'
                seed_path=f'{OWNER}/{PID}/active-restore/{seed_id}/{seed_hash}/'+('c'*64)+f'/77777777-7777-4777-8777-{777777777900+index}.png'
                seed_asset=dict(id=seed_id,owner_id=OWNER,project_id=PID,client_key='photo:edit-plan:'+photo_id,
                    kind='photo',file_name='synthetic.png' if photo_id=='retained-photo' else photo_id+'.png',mime_type='image/png',
                    byte_size=len(seed_bytes),sha256=seed_hash,status='uploaded',source_device_id=A,storage_path=seed_path,
                    metadata=dict(local_project_key=base.PROJECT,drawing_id=base.DRAWING,photo_id=photo_id))
                seed_assets.append(seed_asset)
                cloud.assets[seed_id]=seed_asset
                cloud.blobs[seed_path]=seed_bytes
            cloud.backend.admin(op='seed', ownerId=OWNER,
                devices=[dict(id=A,name='検証iPad'),dict(id=B,name='検証iPhone'),dict(id=PC,name='検証PC',type='pc')],
                projects=[dict(id=PID,client_key=base.PROJECT,payload=baseline[0])],assets=seed_assets,rollout=True)
            b.locator('#sentlogCloudStatus').click()
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
            recovered=b.evaluate(READ_NATIVE_FILES,photo_keys)
            original=a.evaluate(READ_NATIVE_FILES,photo_keys)
            assert len(recovered)==17 and recovered==original,('all 17 photos must be durable with exact bytes and MIME',recovered,original)
            assert {item['key']:item['sha256'] for item in recovered}=={
                'photo:edit-plan:'+photo_id:hashlib.sha256(data).hexdigest() for photo_id,data in photo_bytes.items()}
            assert b.evaluate("SentlogRecords.deltaJournal.bindingStateFor('edit-project')?.phase")=='active'
            assert all(any(r['path'].endswith('/'+asset['storage_path']) and r['method']=='GET' and r['device']==B
                           for r in cloud.photo_requests) for asset in seed_assets)
            migration=b.evaluate(READ_MIGRATION_PHOTOS,dict(
                scope=dict(ownerId=OWNER,projectId=PID,deviceId=B),localProjectId=base.PROJECT))
            assert migration['cutoff']==receiver_cutoff, 'Pending activation changed immutable source metadata'
            assert len(migration['cutoffPhotos'])==16 and len(migration['copiedPhotos'])==16, migration
            assert len(migration['pending'])==1, migration
            pending=migration['pending'][0]
            assert pending['required'] and pending['deliveryVerified'] is False and pending['kind']=='photo', pending
            assert pending['key'] not in migration['cutoffPhotos'], 'Later runtime delivery must not rewrite the source cutoff'
            assert set(migration['cutoffPhotos']+[pending['key']])==set(photo_keys), migration
            expected_hashes={item['key']:item['sha256'] for item in original}
            assert all(file['sha256']==expected_hashes[file['key']] and file['key'] in migration['cutoffPhotos']
                       for file in migration['copiedPhotos']), migration
            assert pending['references']==[dict(recordId='survey-b',photo=next(photo for photo in extra_photos
                                                if photo['id']==pending['photoId']))], pending
            batches=[json.loads('['+request['query']['client_key'][0][4:-1]+']') for request in cloud.photo_requests
                     if request['device']==B and request['path'].endswith('/sentlog_assets') and request['method']=='GET'
                     and request['query'].get('client_key',[''])[0].startswith('in.(')]
            assert batches and len(batches[0])==16 and set(batches[0])==set(migration['cutoffPhotos']), batches
            b.locator('#sentlogCloudModal').get_by_role('button',name='閉じる',exact=True).click()
            print('PASS 16 verified cutoff photos and one preserved pending reference activate; normal receiver '
                  'durably stores all 17 exact files without rewriting the source cutoff',flush=True)
            # Complete the expanded baseline before the existing editing flow.
            # Otherwise its rapid setting changes can exhaust the intentional
            # snapshot fence retries while these 17 initial ACKs are in flight.
            def baseline_received_by_both():
                for asset in seed_assets:
                    for device in (A,B):
                        receipt=cloud.receipts.get((asset['id'],device))
                        if not receipt or receipt['owner_id']!=OWNER or receipt['device_id']!=device \
                                or receipt['sha256']!=asset['sha256'] or receipt['byte_size']!=asset['byte_size']:
                            return False
                return all(page.evaluate("""ids=>window.__deltaPhotoDiagnostics.events.some(event=>
                  event.stage==='application.photos'&&event.event==='done'&&event.complete===true&&
                  event.references?.length===ids.length&&ids.every(id=>event.references.some(ref=>ref.assetId===id)))""",
                  [asset['id'] for asset in seed_assets]) for page in (a,b))
            wait(cloud,a,baseline_received_by_both,'Baseline delivery did not produce all 34 exact-byte photo receipts')
            assert all(any(check['assetId']==asset['id'] and check['device']==device
                           for check in cloud.durable_ack_checks) for asset in seed_assets for device in (A,B)), cloud.durable_ack_checks
            print('PASS all 17 baseline photos have exact-byte ACKs from both devices before further editing',flush=True)

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
            # The reference can arrive before its uploader publishes the bytes;
            # existing 30-second project backoffs can exceed 45 seconds on slow WebKit.
            wait(cloud,a,received_by_both,'Automatic photo delivery did not produce both exact-byte receipts',timeout=90)
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
    parser.add_argument('--executable-path',type=Path)
    args=parser.parse_args();root=args.built_root.resolve()
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    backend=Backend(root)
    cloud=Cloud(f'http://127.0.0.1:{server.server_port}',root,args.engine,backend)
    cloud.executable_path=str(args.executable_path.resolve()) if args.executable_path else None
    try:
        with sync_playwright() as playwright:
            run(getattr(playwright,args.engine),cloud,root)
    finally:
        backend.close();server.shutdown()


if __name__=='__main__':main()

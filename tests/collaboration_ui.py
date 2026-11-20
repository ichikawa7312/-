"""Two production browser contexts, shared CAS and byte-verified photo delivery.

Synthetic REST/notification services only. No real login or business record is used.
Run in the pinned browser CI container, never as a substitute for physical iOS tests.

Chromium retains real Blob IndexedDB. WebKit first probes raw Blob/File storage;
only a demonstrated transport failure enables a shared in-memory Blob adapter.
WebKit also sends identical Uint8Array Storage bodies for Playwright inspection.
Records IndexedDB, image conversion, hashes, CAS and Storage requests stay real.
"""
import argparse
import base64
import copy
import functools
import hashlib
import json
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import sync_playwright
import edit_sync_ui as base

ROOT = Path(__file__).resolve().parents[1]
OWNER = '11111111-1111-4111-8111-111111111111'
A = '33333333-3333-4333-8333-333333333333'
B = '44444444-4444-4444-8444-444444444444'
base.CLOUD_PROJECT = '55555555-5555-4555-8555-555555555555'
base.CLOUD_QUIET = '66666666-6666-4666-8666-666666666666'


class Cloud(base.FakeCloud):
    def __init__(self, origin, built_root, engine):
        super().__init__(origin)
        self.engine = engine
        self.assets, self.blobs, self.notifications, self.pages = {}, {}, [], []
        self.page_errors = []
        self.hold_upload, self.held_uploads, self.drop_ack = None, [], None
        self.hold_inspection, self.held_inspections = None, []
        self.hold_head, self.held_heads = None, []
        self.webkit_sources = {}
        if engine == 'webkit':
            for filename, marker in [('cloud-sync.js', 'async function dbGet(key){'),
                                     ('photo-recovery.js', 'async function localPhoto(key){')]:
                source = (built_root / 'sentlog' / filename).read_text(encoding='utf-8')
                assert source.count(marker) == 1, f'Production {filename} file-read boundary changed'
                # Both readers are module-local. Share precisely the photo Blob
                # transport used by getDBFile and SentlogRecords.writeFile;
                # before a failed raw probe, the real reader remains unchanged.
                self.webkit_sources['/sentlog/' + filename] = source.replace(marker, marker + "\n"
                    "  const fixture=window.__sentlogWebKitBlobTransport;\n"
                    "  if(fixture?.files.has(key))return fixture.files.get(key);", 1)

    def accept(self, route, entry):
        body = self.snapshot_candidate(route, entry)
        if body is None:
            return
        assert body['payload']['project']['collaborationVersion'] == 1
        assert route.request.headers.get('x-client-info') == 'sentlog-collaboration/1'
        self.snapshots[body['project_id']] = copy.deepcopy(body)
        self.writes.append(copy.deepcopy(entry))
        self.notifications.append(dict(kind='records', project_id=body['project_id'], revision=body['revision']))
        if self.drop_ack == entry['device']:
            self.drop_ack = None
            route.abort('failed')
        else:
            self.respond(route, self.rows([body], {'select': entry['query']['select']}))

    def route(self, route, device):
        request, parsed = route.request, urlparse(route.request.url)
        if parsed.path in self.webkit_sources and request.url.startswith(self.origin + '/'):
            route.fulfill(status=200, content_type='text/javascript', body=self.webkit_sources[parsed.path])
            return
        if parsed.netloc != 'wiulvaqixphuobdielyy.supabase.co' or request.method == 'OPTIONS':
            return super().route(route, device)
        path, query = unquote(parsed.path), parse_qs(parsed.query)
        if path.endswith('/rpc/sentlog_delta_inspect_v1') and self.hold_inspection:
            body = json.loads(request.post_data)
            if self.hold_inspection == (device, body['p_project_id']):
                self.held_inspections.append(route)
                return
        if (path.endswith('/sentlog_project_snapshots') and request.method == 'GET'
                and query.get('select') == ['revision,updated_at']
                and self.hold_head == (device, query.get('project_id', [''])[0].removeprefix('eq.'))):
            self.held_heads.append((route, query))
            return
        if '/storage/v1/object/' in path:
            if request.method == 'POST':
                storage_key = path.split('/storage/v1/object/sentlog-temp/', 1)[1]
                data = request.post_data_buffer
                assert data is not None, {
                    'error': 'Playwright could not inspect the Storage POST bytes',
                    'device': device, 'engine': self.engine, 'path': path,
                    'content_type': request.headers.get('content-type'),
                }
                if self.hold_upload == device:
                    self.hold_upload = None
                    self.held_uploads.append((route, storage_key, data))
                else:
                    self.blobs[storage_key] = data
                    self.respond(route, {'Key': storage_key})
                return
            if request.method == 'GET':
                storage_key = path.split('/storage/v1/object/authenticated/sentlog-temp/', 1)[1]
                data = self.blobs.get(storage_key)
                route.fulfill(status=200 if data else 404, content_type='image/jpeg',
                              headers={'Access-Control-Allow-Origin': '*'}, body=data or b'')
                return
        if path.endswith('/sentlog_devices'):
            self.respond(route, [dict(id=device, active=True, device_name='検証iPad' if device == A else '検証iPhone')])
            return
        if path.endswith('/sentlog_assets'):
            if request.method == 'GET':
                rows = list(self.assets.values())
                after = query.get('id', [''])[0]
                if after.startswith('gt.'):
                    rows = [r for r in rows if r['id'] > after[3:]]
                rows.sort(key=lambda r: r['id'])
                self.respond(route, self.rows(rows, query))
            elif request.method in ('POST', 'PATCH'):
                body = json.loads(request.post_data)
                existing = next((a for a in self.assets.values() if a['client_key'] == body['client_key']), None)
                asset = dict(body, id=existing['id'] if existing else str(uuid.uuid4()))
                assert len(self.blobs[asset['storage_path']]) == asset['byte_size']
                assert hashlib.sha256(self.blobs[asset['storage_path']]).hexdigest() == asset['sha256']
                self.assets[asset['id']] = asset
                self.notifications.append(dict(kind='asset', project_id=body['project_id']))
                self.respond(route, [asset])
            return
        if '/rpc/sentlog_ack_' in path:
            self.respond(route, {'received': True})
            return
        return super().route(route, device)

    def pump(self):
        notifications, self.notifications = self.notifications, []
        for value in notifications:
            for page in self.pages:
                page.evaluate('value=>window.syntheticNotify(value)', value)

    def release_uploads(self):
        held, self.held_uploads = self.held_uploads, []
        for route, storage_key, data in held:
            self.blobs[storage_key] = data
            self.respond(route, {'Key': storage_key})

    def release_inspections(self):
        self.hold_inspection = None
        held, self.held_inspections = self.held_inspections, []
        for route in held:
            self.respond(route, {'code': 'PGRST202', 'message': 'Legacy fixture has no delta RPC'}, 404)

    def release_heads(self):
        self.hold_head = None
        held, self.held_heads = self.held_heads, []
        for route, query in held:
            try:
                self.respond(route, self.rows(self.snapshots.values(), query))
            except Exception:
                # The real AbortSignal may already have cancelled this held
                # request. A late response must never complete the decision.
                if not route.request.failure:
                    raise


SOCKET = r"""(() => {
  const sockets=[];
  class SyntheticSocket {
    constructor(){this.readyState=0;this.topic='';this.join='';sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
    send(text){const m=JSON.parse(text);if(m.event==='phx_join'){this.topic=m.topic;this.join=m.ref;}
      if(m.event==='phx_join'||m.event==='heartbeat')queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({topic:m.topic,event:'phx_reply',ref:m.ref,join_ref:m.join_ref,payload:{status:'ok'}})}));}
    close(){this.readyState=3;}
  }
  window.WebSocket=SyntheticSocket;
  window.syntheticNotify=v=>{for(const s of sockets)if(s.readyState===1&&s.topic)s.onmessage?.({data:JSON.stringify({topic:s.topic,event:'broadcast',join_ref:s.join,payload:{event:v.kind,payload:{project_id:v.project_id,revision:v.revision}}})});};
})();"""

WEBKIT_STORAGE_BODY = r"""(() => {
  const nativeFetch=window.fetch.bind(window);
  window.__sentlogWebKitStorageBodies=[];
  window.fetch=async function(input,init){
    if(init?.body instanceof Blob&&String(init.method||'GET').toUpperCase()==='POST'){
      const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href);
      if(url.origin==='https://wiulvaqixphuobdielyy.supabase.co'&&url.pathname.startsWith('/storage/v1/object/sentlog-temp/')){
        // Playwright WebKit omits Blob POST bodies from Request.post_data_buffer.
        // Native fetch still sends the identical bytes, without a file-backed
        // Blob body that its request inspector cannot expose to this fixture.
        const blob=init.body,bytes=new Uint8Array(await blob.arrayBuffer()),headers=new Headers(init.headers);
        if(!headers.has('content-type')&&blob.type)headers.set('content-type',blob.type);
        window.__sentlogWebKitStorageBodies.push({size:bytes.byteLength,type:blob.type});
        return nativeFetch(input,{...init,headers,body:bytes});
      }
    }
    return nativeFetch(input,init);
  };
})();"""

WEBKIT_BLOB_PROBE = r"""async encoded=>{
  const name='sentlog-synthetic-blob-probe-'+crypto.randomUUID();
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  let db,stage='open';
  try{
    db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('files');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('Synthetic Blob probe database blocked'));
    });
    // This is an isolated raw API check, independent of all app wrappers.
    for(const [kind,value] of [['Blob',new Blob([bytes],{type:'image/png'})],
      ['File',new File([bytes],'probe.png',{type:'image/png',lastModified:1})]]){
      stage='write '+kind;
      await new Promise((resolve,reject)=>{
        const transaction=db.transaction('files','readwrite');
        transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error||Error('Synthetic Blob write aborted'));
        transaction.onerror=()=>{};transaction.objectStore('files').put(value,kind);
      });
      stage='read '+kind;
      const stored=await new Promise((resolve,reject)=>{
        const request=db.transaction('files','readonly').objectStore('files').get(kind);
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      if(!(stored instanceof Blob))throw Error('Synthetic Blob round-trip returned a non-Blob');
      const read=new Uint8Array(await stored.arrayBuffer());
      if(stored.type!=='image/png'||read.length!==bytes.length||!read.every((v,i)=>v===bytes[i]))
        throw Error('Synthetic Blob round-trip changed the bytes');
    }
    return {ok:true,stage:'Blob and File exact round-trip'};
  }catch(error){return {ok:false,stage,name:error.name,message:error.message};}
  finally{
    db?.close();
    await new Promise((resolve,reject)=>{
      const request=indexedDB.deleteDatabase(name);request.onsuccess=resolve;request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('Synthetic Blob probe cleanup blocked'));
    });
  }
}"""

WEBKIT_BLOB_TRANSPORT = r"""()=>{
  const files=new Map(),originals=new Map(),metas=new Map(),api=SentlogOriginalPhotos;
  const read=getDBFile,write=putDBFile,recordWrite=SentlogRecords.writeFile;
  window.__sentlogWebKitBlobTransport={files};
  getDBFile=async function(key){return files.has(key)?files.get(key):read.apply(this,arguments);};
  const storePhoto=(key,value)=>{
    if(!(value instanceof Blob))throw Error('Synthetic shared photo is not a Blob');
    files.set(key,value);
  };
  putDBFile=async function(key,value){
    return key.startsWith('photo:')?storePhoto(key,value):write.apply(this,arguments);
  };
  // Photo recovery calls writeFile directly on reconnect. Keep its verification
  // and the real record-error guards, using the same photo-only Blob transport.
  SentlogRecords.writeFile=async function(key,value){
    return key.startsWith('photo:')?storePhoto(key,value):recordWrite.apply(this,arguments);
  };
  // Preserve real getPhotoBlob/savePhotoBlob and makeSharedPhoto. Both the
  // editor and cloud module read/write this same per-device shared-byte map.
  api.stageOriginal=async(did,pid,file,meta)=>{
    if(!(file instanceof Blob))throw Error('Synthetic original is not a Blob');
    const key=did+':'+pid,previous=metas.get(key);
    if(previous){
      if(previous.photoAssociation.operationId!==meta.photoAssociation.operationId)
        throw Error('Synthetic original identity collision');
      return structuredClone(previous);
    }
    const row={...structuredClone(meta),key,drawingId:did,photoId:pid,size:file.size,type:file.type,
      originalName:file.name||meta.originalName,storedAt:Date.now(),exportedAt:null};
    originals.set(key,file);metas.set(key,row);return structuredClone(row);
  };
  api.getOriginal=async(did,pid)=>originals.get(did+':'+pid)||null;
  api.listMeta=async()=>[...metas.values()].map(row=>structuredClone(row));
  api.updatePhotoAssociation=async(did,pid,association)=>{
    const row=metas.get(did+':'+pid);
    if(!row||row.photoAssociation.operationId!==association.operationId)
      throw Error('Synthetic original association missing');
    row.photoAssociation=structuredClone(association);return structuredClone(row);
  };
}"""


def make_page(browser, cloud, device, width):
    context = browser.new_context(viewport={'width': width, 'height': 1000}, is_mobile=True,
                                  has_touch=True, service_workers='block')
    session = dict(access_token='synthetic-access-token', expires_at=time.time() + 3600,
                   user=dict(id=OWNER, email='synthetic@example.invalid'))
    context.add_init_script(SOCKET + "window.sentlogImporting=true;localStorage.setItem('sentlogCloudSessionV1',"
                            + json.dumps(json.dumps(session)) + ");localStorage.setItem('sentlogCloudDeviceV1',"
                            + json.dumps(device) + ');')
    if cloud.engine == 'webkit':
        context.add_init_script(WEBKIT_STORAGE_BODY)
    context.route('**/*', lambda route: cloud.route(route, device))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(cloud.origin + '/sentlog/', wait_until='domcontentloaded')
    page.wait_for_function('window.SentlogCollaboration&&window.sentlogCollabRefresh&&window.SentlogCollaborationPhotos', timeout=45000)
    cloud.pages.append(page)
    cloud.page_errors.append(errors)
    return context, page, errors


def wait(cloud, page, condition, description, timeout=14):
    deadline = time.monotonic() + timeout
    while True:
        cloud.pump()
        if condition():
            return
        assert time.monotonic() < deadline, description
        page.wait_for_timeout(60)


def texts(page):
    return page.evaluate("SentlogRecordCollaboration.view(state.shapes.find(s=>s.id==='survey-a')).comments.filter(c=>!c.deleted).map(c=>c.text)")


def add_comment(page, text):
    page.get_by_role('button', name='次のコメント', exact=True).click()
    page.locator('#slCollabDraft').fill(text)


def capture(page, name='IMG_0001.png'):
    page.evaluate("SentlogCollaborationPhotos.prepareInput('cameraInput')")
    page.locator('#cameraInput').set_input_files(dict(name=name, mimeType='image/png', buffer=base.photo_png()))


def preserved_records(page, expected=None):
    value = page.evaluate("""async()=>{
      await SentlogRecords.settled();SentlogRecords.assertSafe();
      const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey(activeDrawingId)));
      const keep=shapes=>Object.fromEntries(shapes.filter(s=>['survey-b','drawing-note'].includes(s.id)).map(s=>[s.id,s]));
      return {view:currentView,drawing:activeDrawingId,
        ids:state.shapes.map(s=>s.id).sort(),savedIds:saved.shapes.map(s=>s.id).sort(),
        live:keep(state.shapes),saved:keep(saved.shapes)};
    }""")
    assert value['view'] == 'editor' and value['drawing'] == base.DRAWING, value
    assert value['ids'] == value['savedIds'] == ['crack-a', 'drawing-note', 'survey-a', 'survey-b'], value
    assert value['live'] == value['saved'], value
    if expected is not None:
        assert value['live'] == expected, value
    return value['live']


def draft_selection(page):
    return page.locator('#slCollabDraft').evaluate("""el=>({value:el.value,focused:document.activeElement===el,
      start:el.selectionStart,end:el.selectionEnd,record:selected,drawing:activeDrawingId})""")


def run(browser, cloud, engine):
    ca, a, ea = make_page(browser, cloud, A, 820)
    cb, b, eb = make_page(browser, cloud, B, 390)
    packs = [base.payload(base.PROJECT, base.DRAWING), base.payload(base.QUIET, 'unrelated-plan')]
    crack = dict(id='crack-a', kind='line', type='ひび割れ', page=1, points=[dict(x=300, y=200), dict(x=480, y=200)],
                 member='主桁', memo='', photos=[], strokeWidth=1.2, crackWidthMm=0.2, unit=1)
    packs[0]['drawings'][0]['state']['shapes'].append(crack)
    packs[0]['drawings'][0]['meta']['shapeCount'] = 4
    packs[0]['project']['drawings'][0]['shapeCount'] = 4
    fixture = dict(packs=packs, encoded=base64.b64encode(base.photo_png()).decode('ascii'))
    baseline = a.evaluate(base.SETUP, fixture)
    b.evaluate(base.SETUP, dict(fixture, packs=baseline))
    if engine == 'webkit':
        print('WebKit Storage fixture: native fetch sends exact Blob bytes as Uint8Array for request inspection', flush=True)
        for number, page in enumerate((a, b)):
            probe = page.evaluate(WEBKIT_BLOB_PROBE, fixture['encoded'])
            page.evaluate('result=>window.__sentlogBlobProbe=result', probe)
            print('WebKit raw Blob IndexedDB probe', number, json.dumps(probe, ensure_ascii=False), flush=True)
            if not probe['ok']:
                assert probe['name'] in ('UnknownError', 'DataCloneError', 'NotSupportedError'), probe
                page.evaluate(WEBKIT_BLOB_TRANSPORT)
                print(f'WebKit device {number}: Blob transport fixture enabled; real conversion/hash/CAS/Storage pipeline retained', flush=True)
            else:
                print(f'WebKit device {number}: real Blob IndexedDB retained', flush=True)
    else:
        print('Chromium: real Blob IndexedDB retained', flush=True)
    cloud.seed(baseline)
    for page in (a, b):
        page.evaluate('async()=>{sentlogImporting=false;await sentlogArchiveSync();await sentlogCloudIdle();}')
    wait(cloud, a, lambda: all(p.evaluate("SentlogRecordCollaboration.view(state.shapes.find(s=>s.id==='survey-a')).comments.length") == 1 for p in (a, b)), 'initial record not ready')
    quiet = copy.deepcopy(cloud.snapshots[base.CLOUD_QUIET])
    protected = preserved_records(a)
    preserved_records(b, protected)

    # Both clients post from the same baseline; the losing CAS must rebase all entries.
    cloud.hold_device = A
    a.locator('#slCollabDraft').fill('上流側のコメント')
    b.locator('#slCollabDraft').fill('下流側のコメント')
    wait(cloud, a, lambda: bool(cloud.held), 'first metadata post did not reach CAS')
    wait(cloud, b, lambda: any('下流側のコメント' in json.dumps(s['payload'], ensure_ascii=False) for s in cloud.snapshots.values()), 'second writer blocked by first device')
    cloud.release()
    wait(cloud, a, lambda: all(set(texts(p)) == {'保存済みの所見', '上流側のコメント', '下流側のコメント'} for p in (a, b)), 'concurrent comments did not converge')

    # Remote input must not replace the focused Japanese composition draft.
    a.get_by_role('button', name='次のコメント', exact=True).click()
    a.locator('#slCollabDraft').evaluate("""el=>{
      el.focus();el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      el.value='へんかんちゅう';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
      el.setSelectionRange(2,5);render();render();
    }""")
    preedit_selection = dict(value='へんかんちゅう', focused=True, start=2, end=5,
                            record='survey-a', drawing=base.DRAWING)
    assert draft_selection(a) == preedit_selection
    add_comment(b, '変換中に届く追記')
    wait(cloud, a, lambda: '変換中に届く追記' in texts(a), 'IME blocked another comment')
    assert draft_selection(a) == preedit_selection, 'Remote render reset the IME focus or selection'
    assert 'へんかんちゅう' not in texts(a)

    # Drawing-memo renderers temporarily filter the shape list. Changing modes
    # during IME must preserve all records and retain the original draft.
    a.evaluate('async()=>{selected=null;render();await Promise.resolve();await SentlogRecords.settled();}')
    preserved_records(a, protected)
    assert a.evaluate('SentlogCollaboration.hasPendingDraft()')
    assert 'へんかんちゅう' not in texts(a)
    a.evaluate("SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');$('slCollabDraft').focus()")
    assert draft_selection(a) == preedit_selection
    a.locator('#slCollabDraft').evaluate("""el=>{
      el.value='変換後のコメント';el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:el.value}));
      el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false,inputType:'insertText'}));
      el.setSelectionRange(3,6);render();SentlogFieldRecords.selectRecord('survey-a');
    }""")
    wait(cloud, b, lambda: '変換後のコメント' in texts(b), 'composition did not commit')
    assert draft_selection(a) == dict(value='変換後のコメント', focused=True, start=3, end=6,
                                      record='survey-a', drawing=base.DRAWING)
    for page in (a, b):
        preserved_records(page, protected)

    # Keep an actual Storage upload in flight. Other metadata must still travel.
    cloud.hold_upload = A
    capture(a)
    wait(cloud, a, lambda: bool(cloud.held_uploads), 'photo did not reach Storage upload', timeout=20)
    start = time.monotonic()
    add_comment(b, '写真送信中にもコメント')
    wait(cloud, a, lambda: '写真送信中にもコメント' in texts(a), 'photo I/O blocked metadata', timeout=8)
    metadata_seconds = time.monotonic() - start
    assert cloud.held_uploads, 'photo stall ended before metadata assertion'
    capture(b)  # Identical filename, independent photo ID/bytes/association.
    cloud.release_uploads()
    wait(cloud, b, lambda: all(p.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.length") == 3 for p in (a, b)), 'independent photos lost', timeout=25)
    initial_photo_ids = a.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.filter(p=>p.id!=='retained-photo').map(p=>p.id)")
    def received_all(page, expected_ids):
        return page.evaluate("""async expectedIds=>{
          const photos=state.shapes.find(s=>s.id==='survey-a').photos.filter(x=>x.id!=='retained-photo');
          return JSON.stringify(photos.map(p=>p.id).sort())===JSON.stringify([...expectedIds].sort())&&(await Promise.all(photos.map(async photo=>{
            const blob=await getDBFile('photo:'+activeDrawingId+':'+photo.id);
            if(!(blob instanceof Blob)||blob.size!==photo.size||blob.type!==photo.type)return false;
            const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
            return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')===photo.sha256;
          }))).every(Boolean);
        }""", expected_ids)
    wait(cloud, b, lambda: received_all(a, initial_photo_ids) and received_all(b, initial_photo_ids), 'photo bytes not delivered after metadata', timeout=25)

    # A confirmation remains open while B confirms and shares a newer measurement.
    for page in (a, b):
        page.evaluate("selectShape('crack-a');$('inspector').classList.add('open')")
    a.evaluate("SentlogCrackWidth.setWidth(state.shapes.find(s=>s.id==='crack-a'),0.3)")
    a.locator('.sl-collab-dialog').wait_for(state='visible')
    b.evaluate("SentlogCrackWidth.setWidth(state.shapes.find(s=>s.id==='crack-a'),0.4)")
    b.locator('.sl-collab-dialog').get_by_role('button', name='変更する', exact=True).click()
    wait(cloud, a, lambda: a.evaluate("state.shapes.find(s=>s.id==='crack-a').crackWidthMm") == 0.4, 'open confirmation blocked remote measurement')
    a.locator('.sl-collab-dialog').get_by_role('button', name='変更する', exact=True).click()
    a.wait_for_timeout(600)
    assert a.evaluate("state.shapes.find(s=>s.id==='crack-a').crackWidthMm") == 0.4, 'stale confirmation silently replaced newer value'
    assert a.locator('.sl-collab-dialog').is_visible()
    a.locator('.sl-collab-dialog').get_by_role('button', name='変更する', exact=True).click()
    wait(cloud, b, lambda: b.evaluate("state.shapes.find(s=>s.id==='crack-a').crackWidthMm") == 0.3, 'fresh measurement confirmation not shared')

    # A real long press and drag keeps its preview local until pointer release.
    # Undo that movement after a remote append; the remote append survives.
    for page in (a, b):
        page.evaluate("selectShape('survey-a')")
    original_point = a.evaluate("state.shapes.find(s=>s.id==='survey-a').point")
    a.evaluate("document.activeElement?.blur();$('inspector').classList.remove('open');tool='pan';render()")
    hit = a.locator('[data-field-record-id="survey-a"]').first.bounding_box()
    assert hit, 'The record must have a real pointer target'
    x, y = hit['x'] + hit['width'] / 2, hit['y'] + hit['height'] / 2
    a.mouse.move(x, y)
    a.mouse.down()
    a.wait_for_timeout(650)
    a.mouse.move(x + 24, y + 18, steps=5)
    a.wait_for_timeout(950)
    assert a.evaluate("state.shapes.find(s=>s.id==='survey-a').point") != original_point, 'Long press did not start a drag preview'
    assert a.evaluate("JSON.parse(SentlogRecords.getItem(drawingStorageKey(activeDrawingId))).shapes.find(s=>s.id==='survey-a').point") == original_point, 'Drag preview was saved before release'
    assert next(s for s in cloud.snapshots[base.CLOUD_PROJECT]['payload']['drawings'][0]['state']['shapes'] if s['id'] == 'survey-a')['point'] == original_point, 'Drag preview reached the server before release'
    a.mouse.up()
    moved_point = a.evaluate("state.shapes.find(s=>s.id==='survey-a').point")
    assert moved_point != original_point
    a.evaluate("$('inspector').classList.add('open')")
    wait(cloud, b, lambda: b.evaluate("state.shapes.find(s=>s.id==='survey-a').point") == moved_point, 'Released move not shared')
    add_comment(b, '移動の後に届くコメント')
    wait(cloud, a, lambda: '移動の後に届くコメント' in texts(a), 'remote append before undo missing')
    a.locator('#undoBtn').click()
    wait(cloud, b, lambda: b.evaluate("state.shapes.find(s=>s.id==='survey-a').point") == original_point, 'scoped undo did not return point')
    assert '移動の後に届くコメント' in texts(a) and '移動の後に届くコメント' in texts(b)
    assert a.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.length") == 3

    # Offline additions merge on reconnection without duplicate comments.
    for page in (a, b):
        page.evaluate('SentlogRecords.assertSafe()')
    ca.set_offline(True)
    a.wait_for_function('!navigator.onLine')
    assert b.evaluate('navigator.onLine'), 'Taking one device offline affected its peer'
    add_comment(a, '圏外の間のコメント')
    a.wait_for_timeout(900)
    assert '圏外の間のコメント' in texts(a)
    add_comment(b, '接続中の別コメント')
    b.wait_for_timeout(1800)
    ca.set_offline(False)
    a.wait_for_function('navigator.onLine')
    def offline_comments_converged():
        for page in (a, b):
            page.evaluate('SentlogRecords.assertSafe()')
        return all('圏外の間のコメント' in texts(p) and '接続中の別コメント' in texts(p) for p in (a, b))
    wait(cloud, b, offline_comments_converged, 'offline changes did not converge', timeout=20)
    assert texts(a).count('圏外の間のコメント') == 1
    assert texts(a) == texts(b)

    # The server accepted the operation but its acknowledgement was lost.
    # Retrying must read back the accepted IDs, never append a second entry.
    cloud.drop_ack = A
    add_comment(a, '応答が途切れても一度だけ保存')
    wait(cloud, b, lambda: all('応答が途切れても一度だけ保存' in texts(p) for p in (a, b)),
         'accepted write with lost response did not recover', timeout=20)
    a.evaluate('async()=>{await sentlogArchiveSync();await sentlogCloudIdle();}')
    cloud.pump()
    assert texts(a).count('応答が途切れても一度だけ保存') == 1
    assert texts(b).count('応答が途切れても一度だけ保存') == 1

    # The existing photo × remains an explicit operation. Another capture can
    # arrive while its decision is open, and undo must preserve that peer photo.
    before_ids = set(a.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.map(p=>p.id)"))
    remove_id = next(photo_id for photo_id in before_ids if photo_id != 'retained-photo')
    a.evaluate('photoId=>removeSelectedPhoto(photoId)', remove_id)
    a.locator('.sl-collab-dialog').wait_for(state='visible')
    capture(b)
    wait(cloud, a, lambda: all(p.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.length") == 4 for p in (a, b)),
         'photo confirmation blocked another capture', timeout=25)
    after_ids = set(a.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.map(p=>p.id)"))
    peer_ids = after_ids - before_ids
    assert len(peer_ids) == 1
    a.locator('.sl-collab-dialog').get_by_role('button', name='写真を外す', exact=True).click()
    wait(cloud, b, lambda: all(p.evaluate("id=>!state.shapes.find(s=>s.id==='survey-a').photos.some(p=>p.id===id)", remove_id) for p in (a, b)),
         'explicit photo removal did not converge')
    for page in (a, b):
        ids = set(page.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.map(p=>p.id)"))
        assert ids == after_ids - {remove_id}, ids
    a.locator('#undoBtn').click()
    wait(cloud, b, lambda: all(set(p.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.map(p=>p.id)")) == after_ids for p in (a, b)),
         'photo undo lost another capture or failed to restore its own photo')
    expected_photo_ids = list(after_ids - {'retained-photo'})
    wait(cloud, b, lambda: received_all(a, expected_photo_ids) and received_all(b, expected_photo_ids), 'restored photo bytes or peer bytes missing', timeout=25)
    for page in (a, b):
        preserved_records(page, protected)
    assert quiet == cloud.snapshots[base.CLOUD_QUIET], 'unrelated project was rewritten'
    assert not cloud.unexpected, cloud.unexpected
    assert not ea and not eb, (ea, eb)
    a.screenshot(path=f'/tmp/sentlog-collaboration-{engine}-ipad.png', full_page=True)
    b.screenshot(path=f'/tmp/sentlog-collaboration-{engine}-iphone.png', full_page=True)
    print(f'PASS {engine}: two writers, CAS collision, IME focus/caret and mode switch, retained drawing memo/record IDs, comments during held Storage upload ({metadata_seconds:.2f}s), photo bytes, stale confirmation, real drag release and scoped undo, offline/lost-ack recovery, photo removal/undo during peer capture; {len(cloud.writes)} snapshots')
    ca.close();cb.close()


def run_deletion_confirmation(browser, cloud, engine):
    context, page, errors = make_page(browser, cloud, A, 390)
    packs = [base.payload(base.PROJECT, base.DRAWING), base.payload(base.QUIET, 'unrelated-plan')]
    drawing = packs[0]['drawings'][0]['state']
    drawing['shapes'] = drawing['shapes'][:2]
    drawing['shapes'][0]['photos'] = [dict(id='retained-photo' if i == 0 else f'existing-photo-{i}',
        name=f'existing-{i}.png', type='image/png', size=len(base.photo_png()), createdAt=1) for i in range(31)]
    for meta in [packs[0]['project']['drawings'][0], packs[0]['drawings'][0]['meta']]:
        meta.update(shapeCount=2, photoCount=31)
    encoded = base64.b64encode(base.photo_png()).decode('ascii')
    baseline = page.evaluate(base.SETUP, dict(packs=packs, encoded=encoded))
    if engine == 'webkit':
        probe = page.evaluate(WEBKIT_BLOB_PROBE, encoded)
        if not probe['ok']:
            assert probe['name'] in ('UnknownError', 'DataCloneError', 'NotSupportedError'), probe
            page.evaluate(WEBKIT_BLOB_TRANSPORT)
    page.evaluate("""async encoded=>{
      const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      for(const photo of state.shapes[0].photos)await SentlogRecords.writeFile('photo:'+activeDrawingId+':'+photo.id,new Blob([bytes],{type:'image/png'}));
      await SentlogRecords.settled();
    }""", encoded)
    cloud.seed(baseline)
    page.evaluate('async()=>{sentlogImporting=false;await sentlogArchiveSync();await sentlogCloudIdle();}')
    assert page.evaluate('state.shapes.length') == 2
    before_photos = page.evaluate('state.shapes[0].photos')
    retained_record = page.evaluate("state.shapes.find(s=>s.id==='survey-b')")

    # The real metadata worker is awaiting another project's first delta-mode
    # read. A confirmation must bypass that flight without activating anything.
    cloud.hold_inspection = (A, base.CLOUD_QUIET)
    cloud.snapshots[base.CLOUD_QUIET]['revision'] += 1
    cloud.notifications.append(dict(kind='records', project_id=base.CLOUD_QUIET,
                                    revision=cloud.snapshots[base.CLOUD_QUIET]['revision']))
    wait(cloud, page, lambda: bool(cloud.held_inspections), 'unrelated metadata check was not held')
    page.locator('#deleteBtn').click()
    remote = cloud.snapshots[base.CLOUD_PROJECT]
    remote['payload']['drawings'][0]['state']['shapes'][0] = page.evaluate("""record=>
      SentlogRecordCollaboration.appendComment(record,'確認中の別端末の追記',{
        commentId:'peer-before-delete',revisionId:'peer-before-delete-r1',at:10,
        actor:{deviceId:'peer',deviceName:'別端末'}})""", remote['payload']['drawings'][0]['state']['shapes'][0])
    remote['revision'] += 1  # Deliberately no notification: confirmation itself must receive it.
    started = time.monotonic()
    page.locator('.sl-collab-dialog').get_by_role('button', name='削除する', exact=True).click()
    wait(cloud, page, lambda: 'もう一度' in page.locator('.sl-collab-dialog [data-status]').inner_text(),
         'fresh delete check did not re-confirm the peer comment while unrelated sync was held', timeout=7)
    assert page.evaluate('state.shapes.length') == 2
    assert cloud.held_inspections, 'unrelated sync ended before the fresh-read assertion'
    page.locator('.sl-collab-dialog').get_by_role('button', name='削除する', exact=True).click()
    wait(cloud, page, lambda: page.evaluate('state.shapes.length') == 1,
         'deletion still waits for the unrelated metadata queue', timeout=7)
    deletion_seconds = time.monotonic() - started
    assert cloud.held_inspections
    saved = page.evaluate("""async()=>{
      await SentlogRecords.settled();SentlogRecords.assertSafe();
      return {saved:JSON.parse(SentlogRecords.getItem(drawingStorageKey(activeDrawingId))),
        view:currentView,drawing:activeDrawingId};
    }""")
    removed = saved['saved']['collabDeletedRecords'][0]
    assert removed['id'] == 'survey-a' and len(removed['photos']) == 31
    assert removed['photos'] == before_photos and '確認中の別端末の追記' in removed['memo']
    assert saved['saved']['shapes'][0] == retained_record
    assert saved['view'] == 'editor' and saved['drawing'] == base.DRAWING
    assert page.evaluate("""async expected=>{
      const bytes=Uint8Array.from(atob(expected),c=>c.charCodeAt(0));
      return (await Promise.all(state.collabDeletedRecords[0].photos.map(async photo=>{
        const blob=await getDBFile('photo:'+activeDrawingId+':'+photo.id);
        if(!(blob instanceof Blob)||blob.size!==bytes.length)return false;
        const saved=new Uint8Array(await blob.arrayBuffer());return saved.every((v,i)=>v===bytes[i]);
      }))).every(Boolean);
    }""", encoded), 'record deletion changed its retained photo bytes'
    cloud.release_inspections()
    wait(cloud, page, lambda: len(cloud.snapshots[base.CLOUD_PROJECT]['payload']['drawings'][0]['state'].get('collabDeletedRecords', [])) == 1,
         'durable deletion did not synchronize after the unrelated check resumed')
    page.locator('#undoBtn').click()
    wait(cloud, page, lambda: len(cloud.snapshots[base.CLOUD_PROJECT]['payload']['drawings'][0]['state']['shapes']) == 2,
         'deletion undo failed to restore the same record with peer history')
    page.evaluate('async()=>{await sentlogCloudIdle();}')

    cloud.hold_head = (A, base.CLOUD_PROJECT)
    page.evaluate("SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open')")
    page.locator('#deleteBtn').click()
    page.locator('.sl-collab-dialog').get_by_role('button', name='削除する', exact=True).click()
    wait(cloud, page, lambda: bool(cloud.held_heads), 'confirmation read was not held')
    cancel = page.locator('.sl-collab-dialog').get_by_role('button', name='キャンセル', exact=True)
    assert cancel.is_enabled(), 'a pending delete disabled its cancel button'
    cancel.click()
    assert page.evaluate('state.shapes.length') == 2
    cloud.release_heads()
    page.wait_for_timeout(500)
    assert page.evaluate('state.shapes.length') == 2 and not page.locator('.sl-collab-dialog').is_visible()
    assert not errors, errors
    assert not cloud.unexpected, cloud.unexpected
    print(f'PASS {engine}: 2 records / 31 photos; fresh peer revision, re-confirm and durable delete in {deletion_seconds:.2f}s while unrelated metadata remained held; exact retained photo bytes, sync, undo and cancellable delayed confirmation', flush=True)
    context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    args = parser.parse_args()
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(args.built_root.resolve())))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    cloud = Cloud(f'http://127.0.0.1:{server.server_port}', args.built_root.resolve(), args.engine)
    try:
        with sync_playwright() as playwright:
            browser = getattr(playwright, args.engine).launch(headless=True)
            try:
                run(browser, cloud, args.engine)
                cloud = Cloud(f'http://127.0.0.1:{server.server_port}', args.built_root.resolve(), args.engine)
                run_deletion_confirmation(browser, cloud, args.engine)
            except Exception:
                print('Recent synthetic requests:', json.dumps(cloud.requests[-25:], ensure_ascii=False))
                for i, page in enumerate(cloud.pages):
                    try:
                        print('Page errors', i, cloud.page_errors[i])
                        print('Browser state', i, page.evaluate("""async()=>{
                          let pending;
                          try{pending=await SentlogCollaborationPhotos.listPending();}
                          catch(error){pending={name:error.name,message:error.message};}
                          return {view:currentView,selected,state,pending,
                            photoStatus:document.getElementById('photoStatus')?.textContent,
                            blobProbe:window.__sentlogBlobProbe,
                            blobFixtureKeys:[...(window.__sentlogWebKitBlobTransport?.files.keys()||[])],
                            storageBodyAdapters:window.__sentlogWebKitStorageBodies,
                            storageIssues:SentlogRecords.issues,storageFailed:SentlogRecords.failed,
                            online:navigator.onLine,
                            error:document.getElementById('errorBanner')?.textContent,
                            cloud:document.getElementById('sentlogCloudMsg')?.textContent};
                        }"""))
                        page.screenshot(path=f'/tmp/sentlog-collaboration-{args.engine}-failure-{i}.png', full_page=True)
                    except Exception:
                        pass
                raise
            finally:
                browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()

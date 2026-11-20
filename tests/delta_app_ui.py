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

ROOT = Path(__file__).resolve().parents[1]
OWNER, A, B = collaboration.OWNER, collaboration.A, collaboration.B
PID = base.CLOUD_PROJECT
PC = '77777777-7777-4777-8777-777777777777'
CP = dict(id=PID, client_key=base.PROJECT, name='実動作の同期検証', status='active')


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


def sync(page):
    return page.evaluate('async cp=>{await SentlogRecords.settled();return sentlogDeltaRuntime.sync(cp)}', CP)


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
            for page in (a,b):sync(page)
            wait(cloud,a,lambda:all(saved(p).get('pageSettings',{}).get('1',{}).get('scale')==125 and saved(p).get('pageRotations',{}).get('1')==90 for p in (a,b)),
                 'Independent drawing setting edits did not merge into both real legacy mirrors')
            print('PASS drawing scale and rotation changed through persist(), journal, atomic delta and renderer',flush=True)

            # Two disconnected edits of the same scalar keep both alternatives.
            for device,page,value in [(A,a,150),(B,b,175)]:
                cloud.offline.add(device)
                page.evaluate('()=>window.__fixtureOffline=true')
                page.evaluate("""async value=>{await openDrawing('edit-project','edit-plan');
                  state.pageSettings['1'].scale=value;persist();await SentlogRecords.settled();showProjects();}""",value)
            a.reload(wait_until='domcontentloaded')
            a.wait_for_function('window.sentlogDeltaRuntime&&SentlogRecords.ready',timeout=45000)
            a.evaluate('async()=>await sentlogAppReady')
            assert saved(a)['pageSettings']['1']['scale']==150
            assert a.evaluate("SentlogRecords.deltaJournal.bindingFor('edit-project').phase")=='active'
            print('PASS saved offline input survives a real page restart before journal replay',flush=True)
            cloud.offline.clear()
            for page in (a,b):
                page.evaluate("()=>{window.__fixtureOffline=false;sentlogImporting=false;window.dispatchEvent(new Event('online'));}")
                sync(page)
            wait(cloud,a,lambda:a.locator('#sentlogDeltaMetadataNotice').is_visible(), 'Conflicting scale choices were not shown')
            a.locator('#sentlogDeltaMetadataNotice button').click()
            a.get_by_role('button',name='150 を使う',exact=True).click()
            wait(cloud,a,lambda:'選んだ内容を保存しました' in a.locator('#sentlogDeltaMetadataDialog').inner_text(), 'Explicit settings resolution was not saved')
            a.locator('#sentlogDeltaMetadataDialog').get_by_role('button',name='閉じる',exact=True).click()
            for page in (a,b):sync(page)
            wait(cloud,a,lambda:all(saved(p)['pageSettings']['1']['scale']==150 for p in (a,b)), 'Chosen scale did not converge')
            print('PASS same-setting candidates remain visible and an explicit UI choice converges',flush=True)

            a.evaluate("async()=>{await openDrawing('edit-project','edit-plan');SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');}")
            collaboration.add_comment(a,'切替後もコメントを保存')
            a.locator('#slCollabDraft').press('Tab')
            collaboration.capture(a,'delta-camera.png')
            wait(cloud,a,lambda:len(saved(a)['shapes'][0].get('photos',[]))>=2,'Real camera save did not reach the journal')
            a.evaluate('()=>showProjects()')
            for page in (a,b):sync(page)
            wait(cloud,a,lambda:len(saved(b)['shapes'][0].get('photos',[]))>=2,'Peer did not receive the camera record')
            for page in (a,b):
                result=page.evaluate('cp=>sentlogDeltaRuntime.photos(cp)',CP)
                assert result['complete'],result.get('issues')
            reference=next(photo for photo in saved(a)['shapes'][0]['photos'] if photo['id']!='retained-photo')
            hashes=[]
            for page in (a,b):
                hashes.append(page.evaluate("""async id=>{const blob=await getDBFile('photo:edit-plan:'+id);
                  if(!(blob instanceof Blob))return null;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');}""",reference['id']))
            assert hashes[0] and hashes[0]==hashes[1],hashes
            assert all('切替後もコメントを保存' in saved(p)['shapes'][0]['memo'] for p in (a,b))
            print('PASS actual capture, record comment, native Blob storage and exact peer ACK remain connected',flush=True)

            certificate=a.evaluate('cp=>sentlogDeltaRuntime.checkpoint(cp,{force:true})',CP)
            assert certificate['payload']['drawings'][0]['state']['pageSettings']['1']['scale']==150
            assert '切替後もコメントを保存' in certificate['payload']['drawings'][0]['state']['shapes'][0]['memo']
            assert len(certificate['payload']['drawings'][0]['state']['shapes'][0]['photos'])>=2
            print('PASS actual application publishes a current PC-compatible certified snapshot',flush=True)
            a.screenshot(path=f'/tmp/sentlog-delta-app-{cloud.engine}.png',full_page=True)
            assert not ea and not eb,dict(a=ea,b=eb)
            assert not cloud.unexpected,cloud.unexpected
            print('PASS delta full application '+cloud.engine,flush=True)
        finally:
            for i,page in enumerate((a,b)):
                try:
                    print('DELTA_APP_DIAGNOSTICS',i,json.dumps(page.evaluate("""()=>({ready:SentlogRecords.ready,failed:SentlogRecords.failed,
                      issues:SentlogRecords.issues,bindings:SentlogRecords.deltaJournal.listBindingsSync().map(b=>({phase:b.phase,ackedSeq:b.ackedSeq})),
                      message:document.getElementById('sentlogCloudMsg')?.textContent})"""),ensure_ascii=False),flush=True)
                except Exception:
                    pass
            print('DELTA_SQL_ERRORS',json.dumps(cloud.sql_errors[-12:],ensure_ascii=False),flush=True)
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

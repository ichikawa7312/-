"""Two production browser contexts, shared CAS and byte-verified photo delivery.

Synthetic REST/notification services only. No real login or business record is used.
Run in the pinned browser CI container, never as a substitute for physical iOS tests.
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
    def __init__(self, origin):
        super().__init__(origin)
        self.assets, self.blobs, self.notifications, self.pages = {}, {}, [], []
        self.hold_upload, self.held_uploads, self.drop_ack = None, [], None

    def accept(self, route, entry):
        body = entry['body']
        old = self.snapshots[body['project_id']]
        if body['revision'] != old['revision'] + 1:
            self.respond(route, {'code': 'P0001', 'message': '別端末の変更があります。同期を再確認してください。'}, 409)
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
            self.respond(route, [body])

    def route(self, route, device):
        request, parsed = route.request, urlparse(route.request.url)
        if parsed.netloc != 'wiulvaqixphuobdielyy.supabase.co' or request.method == 'OPTIONS':
            return super().route(route, device)
        path, query = unquote(parsed.path), parse_qs(parsed.query)
        if '/storage/v1/object/' in path:
            if request.method == 'POST':
                storage_key = path.split('/storage/v1/object/sentlog-temp/', 1)[1]
                data = request.post_data_buffer
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


def make_page(browser, cloud, device, width):
    context = browser.new_context(viewport={'width': width, 'height': 1000}, is_mobile=True,
                                  has_touch=True, service_workers='block')
    session = dict(access_token='synthetic-access-token', expires_at=time.time() + 3600,
                   user=dict(id=OWNER, email='synthetic@example.invalid'))
    context.add_init_script(SOCKET + "window.sentlogImporting=true;localStorage.setItem('sentlogCloudSessionV1',"
                            + json.dumps(json.dumps(session)) + ");localStorage.setItem('sentlogCloudDeviceV1',"
                            + json.dumps(device) + ');')
    context.route('**/*', lambda route: cloud.route(route, device))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(cloud.origin + '/sentlog/', wait_until='domcontentloaded')
    page.wait_for_function('window.SentlogCollaboration&&window.sentlogCollabRefresh&&window.SentlogCollaborationPhotos', timeout=45000)
    cloud.pages.append(page)
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
    cloud.seed(baseline)
    for page in (a, b):
        page.evaluate('async()=>{sentlogImporting=false;await sentlogArchiveSync();await sentlogCloudIdle();}')
    wait(cloud, a, lambda: all(p.evaluate("SentlogRecordCollaboration.view(state.shapes.find(s=>s.id==='survey-a')).comments.length") == 1 for p in (a, b)), 'initial record not ready')
    quiet = copy.deepcopy(cloud.snapshots[base.CLOUD_QUIET])

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
    a.locator('#slCollabDraft').evaluate("el=>{el.focus();el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='へんかんちゅう';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));}")
    add_comment(b, '変換中に届く追記')
    wait(cloud, a, lambda: '変換中に届く追記' in texts(a), 'IME blocked another comment')
    assert a.locator('#slCollabDraft').input_value() == 'へんかんちゅう'
    assert 'へんかんちゅう' not in texts(a)
    a.locator('#slCollabDraft').evaluate("el=>{el.value='変換後のコメント';el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:el.value}));}")
    wait(cloud, b, lambda: '変換後のコメント' in texts(b), 'composition did not commit')

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
    def received_all(page):
        return page.evaluate("async()=>{const p=state.shapes.find(s=>s.id==='survey-a').photos.filter(x=>x.id!=='retained-photo');return (await Promise.all(p.map(x=>getDBFile('photo:'+activeDrawingId+':'+x.id)))).every(x=>x instanceof Blob&&x.size>0);}")
    wait(cloud, b, lambda: received_all(a) and received_all(b), 'photo bytes not delivered after metadata', timeout=25)

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

    # Undo one's movement after a remote append; the remote append survives.
    for page in (a, b):
        page.evaluate("selectShape('survey-a')")
    original_x = a.evaluate("state.shapes.find(s=>s.id==='survey-a').point.x")
    a.evaluate("()=>{const s=state.shapes.find(s=>s.id==='survey-a');pushHistory();s.point.x+=25;s.points=s.points.map(p=>({...p,x:p.x+25}));persist();render();}")
    wait(cloud, b, lambda: b.evaluate("state.shapes.find(s=>s.id==='survey-a').point.x") == original_x + 25, 'move not shared')
    add_comment(b, '移動の後に届くコメント')
    wait(cloud, a, lambda: '移動の後に届くコメント' in texts(a), 'remote append before undo missing')
    a.locator('#undoBtn').click()
    wait(cloud, b, lambda: b.evaluate("state.shapes.find(s=>s.id==='survey-a').point.x") == original_x, 'scoped undo did not return point')
    assert '移動の後に届くコメント' in texts(a) and '移動の後に届くコメント' in texts(b)
    assert a.evaluate("state.shapes.find(s=>s.id==='survey-a').photos.length") == 3

    # Offline additions merge on reconnection without duplicate comments.
    ca.set_offline(True)
    add_comment(a, '圏外の間のコメント')
    a.wait_for_timeout(900)
    assert '圏外の間のコメント' in texts(a)
    add_comment(b, '接続中の別コメント')
    b.wait_for_timeout(1800)
    ca.set_offline(False)
    wait(cloud, b, lambda: all('圏外の間のコメント' in texts(p) and '接続中の別コメント' in texts(p) for p in (a, b)), 'offline changes did not converge', timeout=20)
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
    assert quiet == cloud.snapshots[base.CLOUD_QUIET], 'unrelated project was rewritten'
    assert not cloud.unexpected, cloud.unexpected
    assert not ea and not eb, (ea, eb)
    a.screenshot(path=f'/tmp/sentlog-collaboration-{engine}-ipad.png', full_page=True)
    b.screenshot(path=f'/tmp/sentlog-collaboration-{engine}-iphone.png', full_page=True)
    print(f'PASS {engine}: two writers, CAS collision, IME, comments during held Storage upload ({metadata_seconds:.2f}s), photo bytes, stale confirmation, scoped undo, offline/lost-ack recovery; {len(cloud.writes)} snapshots')
    ca.close();cb.close()


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
    cloud = Cloud(f'http://127.0.0.1:{server.server_port}')
    try:
        with sync_playwright() as playwright:
            browser = getattr(playwright, args.engine).launch(headless=True)
            try:
                run(browser, cloud, args.engine)
            except Exception:
                print('Recent synthetic requests:', json.dumps(cloud.requests[-25:], ensure_ascii=False))
                for i, page in enumerate(cloud.pages):
                    try:
                        print('Browser state', i, page.evaluate("({view:currentView,selected,state,error:document.getElementById('errorBanner')?.textContent,cloud:document.getElementById('sentlogCloudMsg')?.textContent})"))
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

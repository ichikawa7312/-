"""Built-app automatic edit sync, with two devices and a shared fake REST server.

No real account or network service is used. Records use production IndexedDB,
persist, merge and commit code. Tiny SVG/PNG reads are fixtures in both engines:
this suite checks attachment references, not the separately tested Blob transport.
Only the initial baseline uses manual sync; every subsequent send is automatic.
"""
import argparse
import base64
import copy
import functools
import json
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright
from field_record_memo_ui import photo_png

ROOT = Path(__file__).resolve().parents[1]
PROJECT, DRAWING, QUIET = 'edit-project', 'edit-plan', 'unrelated-project'
CLOUD_PROJECT, CLOUD_QUIET = 'cloud-edit', 'cloud-unrelated'
WS = 'surveyFieldNoteWorkspaceV1'
DRAW = 'surveyFieldNoteDrawingV1:'
META = 'sentlogCloudProjectSyncV2:'


def payload(project_id, drawing_id):
    def record(record_id, memo, number):
        point = {'x': 300 + number * 80, 'y': 300}
        return dict(id=record_id, page=1, kind='field-record', recordKind='field-record',
                    recordType='survey', type='調査', displayKind='point', recordNo=number,
                    typeNo=number, globalNo=number, autoLabel='調査-' + str(number),
                    point=point, points=[copy.deepcopy(point), copy.deepcopy(point)],
                    surveyItems=['写真記録'], memo=memo, photos=[])
    shapes = [record('survey-a', '保存済みの所見', 1), record('survey-b', '別記録の所見', 2)]
    shapes[0]['photos'] = [dict(id='retained-photo', name='synthetic.png', type='image/png',
                               size=len(photo_png()), createdAt=1)]
    shapes.append(dict(id='drawing-note', page=1, kind='memo', recordKind='drawing-memo',
                       memoType='line', points=[dict(x=100, y=100), dict(x=180, y=140)],
                       color='#2563eb', strokeWidth=1, unit=1))
    meta = dict(id=drawing_id, name='合成図面', groupId=drawing_id, groupName='合成図面',
                sheetName='合成図面', sheetOrder=1, sourceType='image', fileName='fixture.svg',
                pageCount=1, shapeCount=len(shapes), photoCount=1, createdAt=1, updatedAt=1)
    state = dict(project='合成同期検証', sourceType='image', fileName='fixture.svg',
                 pageCount=1, currentPage=1, width=1200, height=800, shapes=shapes,
                 nextGlobalNo=3, typeCounters={}, pageSettings={}, pdfPageInfo={},
                 pageRotations={}, leaderMarker='open-circle')
    return dict(project=dict(id=project_id, name='合成同期検証', createdAt=1, updatedAt=1,
                             drawings=[meta]), drawings=[dict(meta=copy.deepcopy(meta), state=state)])


class FakeCloud:
    def __init__(self, origin):
        self.origin = origin
        self.projects = [dict(id=cid, client_key=pid, name='合成同期検証', status='active', checking=False)
                         for cid, pid in [(CLOUD_PROJECT, PROJECT), (CLOUD_QUIET, QUIET)]]
        self.snapshots = {}
        self.requests, self.posts, self.writes, self.unexpected = [], [], [], []
        self.hold_device, self.held = None, []

    @staticmethod
    def respond(route, value, status=200):
        route.fulfill(status=status, content_type='application/json',
                      headers={'Access-Control-Allow-Origin': '*'},
                      body=json.dumps(value, ensure_ascii=False))

    @staticmethod
    def rows(values, query):
        values = list(values)
        for field, terms in query.items():
            term = terms[0]
            if term.startswith('eq.'):
                values = [v for v in values if str(v.get(field)) == term[3:]]
            elif term.startswith('in.(') and term.endswith(')'):
                ids = term[4:-1].split(',')
                values = [v for v in values if str(v.get(field)) in ids]
        fields = query.get('select', ['*'])[0].split(',')
        if fields != ['*']:
            values = [{key: row[key] for key in fields if key in row} for row in values]
        return copy.deepcopy(values[:int(query.get('limit', ['1001'])[0])])

    def seed(self, packs):
        for cp, pack in zip(self.projects, packs):
            self.snapshots[cp['id']] = dict(project_id=cp['id'], revision=1, payload=pack,
                                           updated_at='2026-11-18T00:00:00Z')

    def snapshot_candidate(self, route, entry):
        body, query = entry['body'], entry['query']
        assert query.get('select') == ['project_id,revision,updated_at'], entry
        if entry['method'] == 'PATCH':
            assert 'project_id' not in body and 'owner_id' not in body, entry
            project_filter = query.get('project_id', [''])[0]
            revision_filter = query.get('revision', [''])[0]
            assert project_filter.startswith('eq.') and revision_filter.startswith('eq.'), entry
            project_id = project_filter[3:]
            previous = self.snapshots.get(project_id)
            # Evaluate the condition when a held request is released, so two
            # writers race against the actual server revision, not a cached row.
            if previous is None or str(previous['revision']) != revision_filter[3:]:
                self.respond(route, [])
                return None
            candidate = dict(copy.deepcopy(previous), **copy.deepcopy(body))
        else:
            assert entry['method'] == 'POST' and 'on_conflict' not in query, entry
            project_id = body['project_id']
            previous = self.snapshots.get(project_id)
            if previous is not None:
                self.respond(route, {'code': '23505', 'message': 'duplicate snapshot'}, 409)
                return None
            candidate = copy.deepcopy(body)
        if candidate['revision'] != (previous['revision'] if previous else 0) + 1:
            self.respond(route, {'code': 'P0001', 'message': '別端末の変更があります。同期を再確認してください。'}, 409)
            return None
        return candidate

    def accept(self, route, entry):
        body = self.snapshot_candidate(route, entry)
        if body is None:
            return
        self.snapshots[body['project_id']] = copy.deepcopy(body)
        self.writes.append(copy.deepcopy(entry))
        self.respond(route, self.rows([body], {'select': entry['query']['select']}))

    def release(self):
        held, self.held = self.held, []
        for route, entry in held:
            self.accept(route, entry)

    def route(self, route, device):
        request = route.request
        url = urlparse(request.url)
        if request.url.startswith((self.origin + '/', 'blob:', 'data:')):
            route.continue_()
            return
        if request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
            route.fulfill(content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
            return
        if url.netloc != 'wiulvaqixphuobdielyy.supabase.co':
            self.unexpected.append(request.url)
            route.abort()
            return
        if request.method == 'OPTIONS':
            route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*',
                          'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
            return
        query = parse_qs(url.query)
        body = json.loads(request.post_data) if request.post_data else None
        entry = dict(device=device, method=request.method, path=url.path, query=query, body=body)
        self.requests.append(entry)
        if url.path.endswith('/rpc/sentlog_archive_v1') and body.get('p_action') == 'list':
            self.respond(route, self.projects)
        elif url.path.endswith('/sentlog_devices'):
            self.respond(route, [dict(id=device, active=True)])
        elif url.path.endswith('/sentlog_projects') and request.method == 'GET':
            self.respond(route, self.rows(self.projects, query))
        elif url.path.endswith('/sentlog_project_snapshots'):
            if request.method == 'GET':
                # An account-wide receive probe must never download record payloads.
                if 'project_id' not in query:
                    assert query == {'select': ['project_id,revision'], 'limit': ['1001']}, entry
                self.respond(route, self.rows(self.snapshots.values(), query))
            else:
                assert request.method in ('POST', 'PATCH') and body['updated_by_device'] == device, entry
                self.posts.append(copy.deepcopy(entry))
                if self.hold_device == device:
                    self.hold_device = None
                    self.held.append((route, entry))
                else:
                    self.accept(route, entry)
        elif url.path.endswith(('/sentlog_assets', '/sentlog_pdf_requests')) and request.method == 'GET':
            self.respond(route, [])
        else:
            self.unexpected.append(entry)
            self.respond(route, {'message': 'Unexpected synthetic endpoint'}, 500)


SETUP = r"""async ({packs,encoded})=>{
  await sentlogAppReady;
  const image=new File(['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="white"/></svg>'],
    'fixture.svg',{type:'image/svg+xml'});
  const photo=new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'});
  const files=new Map(),originalRead=getDBFile;
  for(const p of packs)for(const d of p.drawings){
    files.set('background:'+d.meta.id,image);
    files.set('photo:'+d.meta.id+':retained-photo',photo);
  }
  getDBFile=async function(key){return files.has(key)?files.get(key):originalRead.apply(this,arguments)};
  workspace={projects:packs.map(p=>structuredClone(p.project))};
  const writes=[[WORKSPACE_KEY,JSON.stringify(workspace)]];
  for(const p of packs)for(const d of p.drawings)writes.push([drawingStorageKey(d.meta.id),JSON.stringify(d.state)]);
  SentlogRecords.batch(writes);await SentlogRecords.settled();
  await openDrawing('edit-project','edit-plan');SentlogFieldRecords.selectRecord('survey-a');
  $('inspector').classList.add('open');persist();await SentlogRecords.settled();clearAllHistory();
  window.editFixture={files,record:()=>state.shapes.find(s=>s.id==='survey-a'),snapshots(){
    const ws=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY));
    return ws.projects.map(project=>({project,drawings:project.drawings.map(meta=>{
      const state=JSON.parse(SentlogRecords.getItem(drawingStorageKey(meta.id)));delete state.labelSize;
      return {meta,state};
    })}));
  }};
  return editFixture.snapshots();
}"""


def make_page(browser, cloud, device, width):
    context = browser.new_context(viewport={'width': width, 'height': 1000},
                                  is_mobile=True, has_touch=True, service_workers='block')
    context.add_init_script("""(() => {
      window.sentlogImporting=true;
      localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'synthetic',
        expires_at:Date.now()/1000+3600,user:{id:'synthetic-owner',email:'test@example.invalid'}}));
    })();""" + "localStorage.setItem('sentlogCloudDeviceV1'," + json.dumps(device) + ');')
    context.route('**/*', lambda route: cloud.route(route, device))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(cloud.origin + '/sentlog/', wait_until='domcontentloaded')
    page.wait_for_function("window.sentlogAppReady&&window.sentlogEditSync&&window.sentlogSyncView&&window.SentlogFieldRecords", timeout=45000)
    return context, page, errors


def wait_for(page, predicate, message, timeout=11):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, message
        page.wait_for_timeout(50)  # Pump both contexts' mocked network handlers.


def idle(page):
    page.wait_for_function('!sentlogEditSync.running&&!sentlogEditSync.pending.length', timeout=12000)
    page.evaluate('async()=>{await SentlogRecords.settled();await sentlogCloudIdle();}')


def wait_memo(page, text):
    page.wait_for_function("""text=>editFixture.record()?.memo===text&&$('frRecordMemo').value===text&&
      JSON.parse(SentlogRecords.getItem(drawingStorageKey('edit-plan'))).shapes.find(s=>s.id==='survey-a').memo===text""",
                           arg=text, timeout=11000)


def intact(page, text):
    value = page.evaluate("""async()=>{
      await SentlogRecords.settled();
      const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey('edit-plan')));
      return {view:currentView,drawing:activeDrawingId,memo:editFixture.record().memo,
        saved:saved.shapes.find(s=>s.id==='survey-a').memo,photos:editFixture.record().photos,
        ids:saved.shapes.map(s=>s.id),other:saved.shapes.find(s=>s.id==='survey-b').memo};
    }""")
    assert value['view'] == 'editor' and value['drawing'] == DRAWING, value
    assert value['memo'] == value['saved'] == text, value
    assert value['photos'] == [dict(id='retained-photo', name='synthetic.png', type='image/png',
                                   size=len(photo_png()), createdAt=1)], value
    assert value['ids'] == ['survey-a', 'survey-b', 'drawing-note'], value
    assert value['other'] == '別記録の所見', value


def run(browser, cloud):
    ca, a, errors_a = make_page(browser, cloud, 'ipad', 820)
    cb, b, errors_b = make_page(browser, cloud, 'phone', 390)
    packs = [payload(PROJECT, DRAWING), payload(QUIET, 'unrelated-plan')]
    fixture = dict(packs=packs, encoded=base64.b64encode(photo_png()).decode('ascii'))
    baseline = a.evaluate(SETUP, fixture)
    b.evaluate(SETUP, dict(fixture, packs=baseline))
    cloud.seed(baseline)
    # This is the sole manual synchronization in the suite, before any test edit.
    for page in (a, b):
        page.evaluate('async()=>{sentlogImporting=false;await sentlogArchiveSync();await sentlogCloudIdle();}')
        idle(page)
    idle(a)
    quiet = copy.deepcopy(cloud.snapshots[CLOUD_QUIET])
    for page in (a, b):
        intact(page, '保存済みの所見')
        assert not page.evaluate('document.hidden')

    # A focused textarea commits locally immediately, but bursts send once.
    before, request_start = len(cloud.writes), len(cloud.requests)
    memo = a.locator('#frRecordMemo')
    started = time.monotonic()
    memo.fill('中性化を確認')
    a.wait_for_timeout(120)
    memo.fill('中性化を確認。採取位置は上流側。')
    a.wait_for_timeout(120)
    text = '中性化を確認。採取位置は上流側。\n写真と照合する。'
    memo.fill(text)
    a.wait_for_timeout(300)
    assert len(cloud.writes) == before, 'Typing must debounce before sending a snapshot'
    intact(a, text)
    assert a.evaluate("document.activeElement===$('frRecordMemo')"), 'Typing must not require blur'
    wait_for(a, lambda: len(cloud.writes) > before, 'Committed text was not sent automatically', 8)
    sent = cloud.writes[before:]
    assert len(sent) == 1 and sent[0]['device'] == 'ipad', sent
    scoped = cloud.requests[request_start:]
    assert not [r for r in scoped if r['device'] == 'ipad' and
                (r['query'].get('project_id') == ['eq.' + CLOUD_QUIET] or
                 r['query'].get('client_key') == ['eq.' + QUIET])], scoped
    wait_memo(b, text)
    assert time.monotonic() - started < 15, 'Receiver must update before the old 15-second fallback'
    idle(a)
    idle(b)
    assert len(cloud.writes) == before + 1, 'Applying a remote memo must not echo a write'
    intact(b, text)

    # Real field-record long press, drag preview, then pointer release/persist.
    b.evaluate("document.activeElement?.blur();$('inspector').classList.remove('open');tool='pan';render()")
    hit = b.locator('[data-field-record-id="survey-a"]').first.bounding_box()
    assert hit, 'Synthetic record must have a real rendered pointer target'
    x, y = hit['x'] + hit['width'] / 2, hit['y'] + hit['height'] / 2
    before = len(cloud.writes)
    original = b.evaluate('structuredClone(editFixture.record().point)')
    b.mouse.move(x, y)
    b.mouse.down()
    b.wait_for_timeout(650)
    b.mouse.move(x + 24, y + 18, steps=5)
    b.wait_for_timeout(950)
    assert len(cloud.writes) == before, 'An uncommitted drag preview must not be sent'
    b.mouse.up()
    position = b.evaluate('structuredClone(editFixture.record().point)')
    assert position != original, (original, position)
    wait_for(b, lambda: len(cloud.writes) > before, 'Drag release did not schedule sync', 8)
    a.wait_for_function('p=>JSON.stringify(editFixture.record().point)===JSON.stringify(p)', arg=position, timeout=11000)
    idle(a)
    idle(b)
    assert len(cloud.writes) == before + 1 and cloud.writes[-1]['device'] == 'phone', cloud.writes[before:]
    for page in (a, b):
        intact(page, text)

    # Hold a real POST after its body was captured, then edit while it is active.
    before, attempts = len(cloud.writes), len(cloud.posts)
    cloud.hold_device = 'ipad'
    a.locator('#frRecordMemo').fill('送信中にも所見を追記')
    wait_for(a, lambda: bool(cloud.held), 'Automatic snapshot write never reached the barrier', 8)
    text = '送信中にも所見を追記。追加した内容も残す。'
    a.locator('#frRecordMemo').fill(text)
    a.wait_for_timeout(1100)
    assert len(cloud.posts) == attempts + 1, 'Only one sync may run while the POST is stalled'
    assert a.evaluate("sentlogEditSync.pending.includes('edit-project')"), 'A newer edit must remain queued'
    intact(a, text)
    cloud.release()
    wait_for(a, lambda: len(cloud.writes) >= before + 2, 'The edit made during sync was lost', 10)
    wait_memo(b, text)
    idle(a)
    idle(b)
    assert len(cloud.writes) == before + 2, cloud.writes[before:]

    # Browser IME preedit is not a saved edit; compositionend must send it.
    before = len(cloud.writes)
    a.evaluate("""()=>{
      const el=$('frRecordMemo');el.focus();
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='へんかんちゅう';
      el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText'}));
      el.setSelectionRange(2,4);render();
    }""")
    a.wait_for_timeout(1100)
    assert len(cloud.writes) == before, 'IME preedit must not become a cloud edit'
    assert a.evaluate("[$('frRecordMemo').value,$('frRecordMemo').selectionStart,$('frRecordMemo').selectionEnd]") == ['へんかんちゅう', 2, 4]
    intact(a, text)
    text = '変換を確定した日本語の所見'
    a.evaluate("""text=>{const el=$('frRecordMemo');el.value=text;
      el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:text}));
      el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false,inputType:'insertText'}));}""", text)
    wait_memo(b, text)
    idle(a)
    idle(b)
    assert len(cloud.writes) == before + 1, cloud.writes[before:]

    # Saved offline edits survive and wake automatically on reconnect.
    before = len(cloud.writes)
    ca.set_offline(True)
    a.wait_for_function('!navigator.onLine')
    text = '通信が戻ったら自動送信する所見'
    a.locator('#frRecordMemo').fill(text)
    a.wait_for_timeout(1100)
    intact(a, text)
    assert len(cloud.writes) == before
    ca.set_offline(False)
    a.wait_for_function('navigator.onLine')
    wait_memo(b, text)
    idle(a)
    idle(b)
    assert len(cloud.writes) == before + 1, cloud.writes[before:]

    # Multiple revision probes after convergence must not create echo writes.
    before = len(cloud.writes)
    a.wait_for_timeout(6500)
    assert len(cloud.writes) == before, cloud.writes[before:]
    probes = [r for r in cloud.requests if r['path'].endswith('/sentlog_project_snapshots') and
              r['method'] == 'GET' and 'project_id' not in r['query']]
    assert {r['device'] for r in probes} == {'ipad', 'phone'}, probes
    assert all(r['query'] == {'select': ['project_id,revision'], 'limit': ['1001']} for r in probes), probes
    assert cloud.snapshots[CLOUD_QUIET] == quiet, 'Unrelated project must remain unchanged'
    for page in (a, b):
        intact(page, text)
        assert page.evaluate('editFixture.record().point') == position
    assert not cloud.unexpected, cloud.unexpected
    assert not errors_a + errors_b, errors_a + errors_b
    print('PASS automatic sync: focused Japanese typing/debounce, two-device display and drag commit, '
          'queued edits during POST, IME, offline recovery, revision-only polling, project scope, no echo; '
          'record IDs, comment, photo reference and drawing memo retained')
    ca.close()
    cb.close()


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
    cloud = FakeCloud(f'http://127.0.0.1:{server.server_port}')
    try:
        with sync_playwright() as playwright:
            browser_type = getattr(playwright, args.engine)
            options = {'headless': True}
            if args.engine == 'chromium' and not os.path.exists(browser_type.executable_path) and os.path.exists('/usr/bin/chromium'):
                options.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            browser = browser_type.launch(**options)
            try:
                run(browser, cloud)
            except Exception:
                print('Recent synthetic REST requests:', json.dumps(cloud.requests[-30:], ensure_ascii=False))
                raise
            finally:
                browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()

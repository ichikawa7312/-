"""Active-delta correctness load through the built app, native IDB and real SQL.

Two persistent browser profiles retain 1,000 records across ten drawings while
400 individually committed offline comments and twelve photographs cross the
actual journal, replica and PostgreSQL RPC implementation. Rollout is enabled
only in the disposable PGlite fixture. No live account or project is contacted.

Auth, Storage HTTP and Realtime hints are synthetic. This does not measure a
physical iPhone, a real websocket reconnect, PostgreSQL transaction contention
or server crash persistence. WebKit uses native Blob/File IndexedDB throughout;
its existing byte-identical Storage POST adapter only permits byte inspection.
"""
import argparse
import base64
import copy
import functools
import hashlib
import json
import tempfile
import threading
import time
from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

import collaboration_ui as collaboration
import delta_app_ui as delta
import edit_sync_ui as base
import heavy_sync_ui as heavy

ROOT = Path(__file__).resolve().parents[1]
OWNER, PID, CP, PC = delta.OWNER, delta.PID, delta.CP, delta.PC
DEVICES = [delta.A, delta.B]
ROUNDS, COMMENTS_PER_DEVICE, PHOTOS_PER_DEVICE = 2, 100, 3
RECORD_COUNT = heavy.DRAWINGS * heavy.RECORDS_PER_DRAWING
METADATA_COUNT = heavy.DRAWINGS + 1


class Cloud(delta.Cloud):
    """The existing SQL adapter, with bounded diagnostics and one lost ACK."""

    def __init__(self, origin, root, engine, backend):
        super().__init__(origin, root, engine, backend)
        self.page_devices, self.route_devices = {}, {}
        self.traffic, self.accepted, self.method_counts = [], [], {}
        self.drop_delta_ack, self.lost_ack = None, None
        self.duplicate_acks, self.notification_deliveries, self.head_seq = 0, 0, 0
        self.stale_notifications = []

    def route(self, route, device):
        request, parsed = route.request, urlparse(route.request.url)
        if parsed.netloc == 'wiulvaqixphuobdielyy.supabase.co' and request.method != 'OPTIONS':
            self.traffic.append(dict(device=device, path=parsed.path, method=request.method,
                                     bytes=len(request.post_data_buffer or b''), offline=device in self.offline, at=time.time()))
            key = request.method + ' ' + parsed.path
            self.method_counts[key] = self.method_counts.get(key, 0) + 1
            assert len(self.traffic) <= 6000, 'Active delta produced an unbounded request storm'
        self.route_devices[id(route)] = device
        try:
            return super().route(route, device)
        finally:
            self.route_devices.pop(id(route), None)
            # The inherited fixture stores request bodies for small scenarios.
            # Keep only recent full bodies; counters and receipt IDs are enough
            # for this workload and do not manufacture fixture-only memory load.
            for values in (self.requests, self.posts, self.writes):
                del values[:-24]
            del self.photo_requests[:-100]

    def respond(self, route, value, status=200):
        path = urlparse(route.request.url).path
        if status >= 400 and self.sql_errors and self.sql_errors[-1]['path'] == path:
            self.sql_errors[-1].update(device=self.route_devices[id(route)], at=time.time())
        if '/rpc/sentlog_delta_append' in path and 200 <= status < 300:
            device = self.route_devices[id(route)]
            receipt = dict(device=device, groupId=value.get('groupId'), eventId=value.get('eventId'),
                           startSeq=value.get('startSeq', value.get('seq')),
                           endSeq=value.get('endSeq', value.get('seq')), duplicate=value.get('duplicate'))
            receipt['eventIds'] = [row['eventId'] for row in value.get('events', [])] or [value['eventId']]
            self.accepted.append(receipt)
            self.head_seq = max(self.head_seq, receipt['endSeq'])
            if receipt['duplicate']:
                self.duplicate_acks += 1
            if self.drop_delta_ack == device:
                assert self.lost_ack is None and not receipt['duplicate'], receipt
                self.drop_delta_ack = None
                self.lost_ack = copy.deepcopy(receipt)
                # The real PostgreSQL transaction has already committed.
                # Only its HTTP acknowledgement is lost. The actual replica
                # must retry its durable FIFO entry with the same identity.
                route.abort('failed')
                return
        return super().respond(route, value, status)

    def pump(self):
        notifications, self.notifications = self.notifications, []
        if not notifications:
            return
        self.stale_notifications = (self.stale_notifications + notifications)[-20:]
        # These are hints, not replacement payloads. Reverse and duplicate them
        # while offline profiles receive none, as with a disconnected socket.
        values = list(reversed(notifications)) * 2
        for page in self.pages:
            if page.is_closed() or self.page_devices.get(page) in self.offline:
                continue
            page.evaluate('values=>{for(const value of values)syntheticNotify(value);}', values)
            self.notification_deliveries += len(values)


def make_page(engine, profile, cloud, device):
    # Use the existing persistent/native fixture. The additional init script is
    # installed before our explicit reopen; the initial navigation is protected
    # by sentlogImporting=true and the independent Python transport gate.
    context, page, errors = delta.make_page(engine, profile, cloud, device)
    context.add_init_script("window.__fixtureOffline=localStorage.getItem('heavyOffline')==='1';")
    page.evaluate("()=>{window.__fixtureOffline=localStorage.getItem('heavyOffline')==='1';}")
    cloud.page_devices[page] = device
    return context, page, errors


def restart(engine, profile, cloud, client, device, error_history):
    context, page, errors = client
    error_history.extend(errors)
    cloud.pages.remove(page)
    cloud.page_errors.remove(errors)
    cloud.page_devices.pop(page, None)
    context.close()
    result = make_page(engine, profile, cloud, device)
    assert not result[1].evaluate('!!window.editFixture||!!window.__sentlogWebKitBlobTransport'), 'Native restart retained a fixture memory file map'
    return result


# Reuse the coherent before/disk/after observation fence from the snapshot
# stress test. Active bindings contain a large migration cutoff; their public
# lightweight state is sufficient here and does not copy that cutoff per poll.
_BINDING = "binding:store.deltaJournal.bindingFor('edit-project')"
assert heavy.SUMMARY.count(_BINDING) == 1
SUMMARY = heavy.SUMMARY.replace(_BINDING, "binding:store.deltaJournal.bindingStateFor('edit-project')")
_VIEW = 'const view=SentlogRecordCollaboration.view(record);'
assert SUMMARY.count(_VIEW) == 1
SUMMARY = SUMMARY.replace(_VIEW, _VIEW + "\n          if(!SentlogRecordCollaboration.matchesProjection(record,{allowLegacyOrder:true}))throw Error('Durable record projection disagrees with its history: '+meta.id+'/'+record.id);")

BURST = r"""async ({operations,scope})=>{
  const started=performance.now(),M=SentlogRecordCollaboration;
  const before=await SentlogRecords.deltaJournal.pending({scope,localProjectId:'edit-project'});
  window.__heavyDeltaProgress={committed:0,total:operations.length};
  for(const op of operations){
    if(activeDrawingId!==op.drawing||currentView!=='editor')throw Error('Active editor changed during the offline burst');
    const index=state.shapes.findIndex(r=>r.id===op.record);
    if(index<0)throw Error('Missing active-delta stress target');
    state.shapes[index]=M.appendComment(state.shapes[index],op.text,{actor:SentlogCollaboration.actor(),
      at:op.at,commentId:op.id,revisionId:op.id+':r1'});
    persist();await SentlogRecords.settled();SentlogRecords.assertSafe();
    window.__heavyDeltaProgress.committed++;
  }
  const after=await SentlogRecords.deltaJournal.pending({scope,localProjectId:'edit-project'});
  if(after.throughSeq-before.throughSeq<operations.length)throw Error('Offline edits were not individually durable journal commits');
  return {ms:performance.now()-started,operations:operations.length,
    beforeThroughSeq:before.throughSeq,afterThroughSeq:after.throughSeq,
    journalCount:after.count,view:currentView,drawing:activeDrawingId};
}"""

# Compare the complete immutable history, including metadata, independently of
# derived projection.memo. PostgreSQL retains that rendering cache differently;
# revision IDs, payloads, order, parents and deletion observations must match.
GRAPH = r"""async records=>{
  const M=SentlogRecordCollaboration,histories={},rows=[],comments=[];
  for(const [key,record]of Object.entries(records)){
    const [drawing,id]=JSON.parse(key),normalized=M.upgrade(record),view=M.view(normalized);
    const history=structuredClone(normalized.collab);delete history.projection;
    histories[key]=history;
    rows.push({drawing,record:id,token:view.token,deleted:M.isDeleted(normalized),conflicts:view.conflicts.length});
    if(drawing!=='@sentlog:metadata:v1')for(const comment of view.comments)comments.push({drawing,record:id,
      id:comment.id,text:comment.text,deleted:comment.deleted,headIds:comment.headIds});
  }
  const encoded=new TextEncoder().encode(JSON.stringify(M.canonical(histories)));
  const graphSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoded))].map(v=>v.toString(16).padStart(2,'0')).join('');
  return {records:rows,comments,graphSha256,canonicalBytes:encoded.length};
}"""

NATIVE_STATE = r"""async ({scope,full=false})=>{
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  const reader=SentlogDeltaIndexedDB.createStore(scope);
  try{
    const replica=await reader.read();
    if(!replica)throw Error('Missing native delta replica');
    const journal=await SentlogRecords.deltaJournal.pending({scope,localProjectId:'edit-project'});
    const result={scope:replica.scope,cursor:replica.cursor,outbox:replica.outbox.length,
      blocked:(replica.blockedOutbox||[]).length,journal,recordCount:Object.keys(replica.records).length,
      binding:SentlogRecords.deltaJournal.bindingStateFor('edit-project')};
    if(full)result.graph=await (""" + GRAPH + r""")(replica.records);
    return result;
  }finally{reader.close();}
}"""


def scope_for(device):
    return dict(ownerId=OWNER, projectId=PID, deviceId=device)


def operation(drawing, number, round_index, index):
    record = 'survey-a' if index % 4 == 0 else heavy.record_id(1 + number * 30 + index % 29)
    identity = f'heavy-delta-{round_index}-{number}-{index}'
    return dict(drawing=drawing, record=record, id=identity,
                text=f'差分負荷追記 {identity}：位置と写真を保存。', at=100 + index if number else 900000 + index)


def tokens(summary, include_metadata=False):
    return {(row['drawing'], row['record']): row['token'] for row in summary['records']
            if include_metadata or row['drawing'] != '@sentlog:metadata:v1'}


def verify_summary(summary, expected, original_tokens, changed, photos):
    assert summary['binding'] and summary['binding']['phase'] == 'active', summary['binding']
    assert len(summary['records']) == RECORD_COUNT
    assert len(tokens(summary)) == RECORD_COUNT, 'Duplicate scoped records'
    assert not any(row['deleted'] or row['conflicts'] for row in summary['records'])
    observed = heavy.comment_set(summary)
    assert observed == expected, dict(missing=list(expected-observed)[:8], extra=list(observed-expected)[:8])
    assert len(summary['comments']) == len(expected), 'A comment was duplicated or silently deleted'
    assert all(len(row['headIds']) == 1 for row in summary['comments']), 'Comment revision heads changed'
    assert summary['pending'] == [], summary['pending']
    expected_photos = {(base.DRAWING, 'survey-a', 'retained-photo')}
    expected_photos.update((row['drawing'], row['record'], row['photoId']) for row in photos)
    observed_photos = {(row['drawing'], row['record'], row['id']) for row in summary['photos']}
    assert observed_photos == expected_photos and len(summary['photos']) == len(expected_photos), 'Missing, duplicate or foreign photo association'
    for key, token in tokens(summary).items():
        if key not in changed:
            assert token == original_tokens[key], ('Unrelated record history changed', key)


def native_state(page, device, full=False):
    return page.evaluate(NATIVE_STATE, dict(scope=scope_for(device), full=full))


def is_drained(proof, head):
    return (proof['binding']['phase'] == 'active' and proof['cursor'] == head
            and proof['outbox'] == proof['blocked'] == proof['journal']['count'] == 0
            and proof['journal']['claimId'] is None and not proof['journal']['detached'])


def brief_native(proof):
    result = {key:value for key, value in proof.items() if key != 'graph'}
    if proof.get('graph'):
        result['historySha256'] = proof['graph']['graphSha256']
    return result


def observe_complete(cloud, pages, drawings, report, phase):
    """Wait for file-receive WAL work, then capture a fenced final proof.

    Native photo writes can create new journal intents after record replay has
    drained. This is a separate asynchronous phase, not evidence of a lost
    comment. Do not manually trigger sync or accept pending work: an unchanged
    nonempty journal must fail the deadline, and stable history mismatches are
    still checked by the caller without retries.
    """
    trace = dict(phase=phase, samples=0, changedObservations=0, transitions=[])
    report.setdefault('postPhotoSettling', []).append(trace)
    started, result, ui_started, previous = time.monotonic(), [], [None]*len(pages), [None]

    def sample():
        cloud.pump()
        head = cloud.head_seq
        before = [native_state(page, device) for device, page in zip(DEVICES, pages)]
        trace['samples'] += 1
        status = dict(headSeq=head, devices=[brief_native(proof) for proof in before])
        if status != previous[0]:
            trace['transitions'].append(dict(seconds=time.monotonic()-started, **status))
            del trace['transitions'][:-40]
            previous[0] = status
            print('HEAVY_DELTA post-photo journal state:', phase,
                  [dict(cursor=proof['cursor'], outbox=proof['outbox'], journal=proof['journal']) for proof in before], flush=True)
        if head != cloud.head_seq or not all(is_drained(proof, head) for proof in before):
            return False
        summaries = [page.evaluate(SUMMARY) for page in pages]
        for index, (page, drawing, summary) in enumerate(zip(pages, drawings, summaries)):
            assert summary['view'] == 'editor' and summary['drawing'] == drawing, 'Reconnect interrupted the active editor'
            expected_live = {row['record']:row['token'] for row in summary['records'] if row['drawing'] == drawing}
            live = page.evaluate("""()=>({view:currentView,drawing:activeDrawingId,
              records:state.shapes.map(record=>[record.id,SentlogRecordCollaboration.view(record).token])})""")
            assert live['view'] == 'editor' and live['drawing'] == drawing, 'Incoming edits navigated away from the active editor'
            if len(live['records']) != len(expected_live) or dict(live['records']) != expected_live:
                if ui_started[index] is None:
                    ui_started[index] = time.monotonic()
                assert time.monotonic()-ui_started[index] < 15, 'The active editor did not display the converged saved revisions'
                return False
            ui_started[index] = None
        proofs = [native_state(page, device, full=True) for device, page in zip(DEVICES, pages)]
        after = [native_state(page, device) for device, page in zip(DEVICES, pages)]
        # Discard only an observation proven to overlap durable journal/cursor
        # activity. A settled graph mismatch is never hidden by polling.
        proof_states = [{key:value for key, value in proof.items() if key != 'graph'} for proof in proofs]
        if head != cloud.head_seq or before != after or proof_states != after:
            trace['changedObservations'] += 1
            return False
        assert all(is_drained(proof, head) for proof in proofs), [brief_native(proof) for proof in proofs]
        result[:] = [summaries, proofs]
        report['lastNativeProofs'] = proofs  # Full proof remains in a failure artifact, never the exception text.
        trace['seconds'] = time.monotonic()-started
        return True

    heavy.wait(cloud, pages[0], sample,
               'Post-photo journal/UI work did not automatically settle before the 180-second deadline', timeout=180)
    return result


def verify_sql(cloud, page, expected, report):
    state = cloud.backend.admin(op='state', ownerId=OWNER, projectId=PID)
    assert len(state['heads']) == 1 and state['heads'][0]['enabled']
    head = state['heads'][0]['last_seq']
    assert head == cloud.head_seq
    assert sorted(row['seq'] for row in state['events']) == list(range(1, head+1)), 'SQL event sequence has a duplicate or gap'
    assert len({row['event_id'] for row in state['events']}) == len(state['events']), 'SQL contains duplicate event identities'
    assert len(state['recordStates']) == RECORD_COUNT + METADATA_COUNT, state['counts']
    records = {json.dumps([row['drawing_id'], row['record_id']], separators=(',', ':')):
               dict(id=row['record_id'], collab=row['collab']) for row in state['recordStates']}
    graph = page.evaluate(GRAPH, records)
    assert heavy.comment_set(graph) == expected and len(graph['comments']) == len(expected), 'SQL canonical history lost or duplicated a comment'
    assert not any(row['deleted'] or row['conflicts'] for row in graph['records'])
    if cloud.lost_ack:
        lost = cloud.lost_ack
        retry = [row for row in cloud.accepted if row['duplicate'] and row['device'] == lost['device']
                 and row['eventIds'] == lost['eventIds'] and row['startSeq'] == lost['startSeq'] and row['endSeq'] == lost['endSeq']]
        assert retry, ('Client did not retry the accepted event/group with its original identity', lost)
        assert all(sum(row['event_id'] == identity for row in state['events']) == 1 for identity in lost['eventIds'])
        if lost['groupId']:
            assert sum(row['group_id'] == lost['groupId'] for row in state['eventGroups']) == 1
    report['sql'] = dict(headSeq=head, counts=state['counts'], historySha256=graph['graphSha256'])
    return state, graph


def verify_photo_receipts(cloud, photos):
    for photo in photos:
        key = 'photo:'+photo['drawing']+':'+photo['photoId']
        assets = [asset for asset in cloud.assets.values() if asset['project_id'] == PID and asset['client_key'] == key]
        assert len(assets) == 1, ('Missing or duplicate SQL-fixture photo asset', key)
        asset = assets[0]
        assert asset['sha256'] == photo['sharedSha256'] and asset['byte_size'] == photo['sharedBytes']
        for device in DEVICES:
            receipt = cloud.receipts.get((asset['id'], device))
            assert receipt and receipt['sha256'] == photo['sharedSha256'] and receipt['byte_size'] == photo['sharedBytes'], ('Missing exact-byte photo receipt', key, device)


def capture_failure(cloud, report, report_path):
    if report.get('status') == 'passed':
        return
    for page in cloud.pages:
        if page.is_closed():
            continue
        device = cloud.page_devices.get(page)
        try:
            report.setdefault('failureStates', []).append(dict(device=device,
                state=page.evaluate("""()=>({view:currentView,drawing:activeDrawingId,selected,
                  online:navigator.onLine,hidden:document.hidden,importing:window.sentlogImporting,progress:window.__heavyDeltaProgress,
                  burst:window.__heavyDeltaOutcome,bootstrap:window.__heavyDeltaBootstrap,
                  binding:SentlogRecords.deltaJournal.bindingStateFor('edit-project'),
                  failed:SentlogRecords.failed,issues:SentlogRecords.issues,
                  cloud:document.getElementById('sentlogCloudMsg')?.textContent,
                  observation:window.__heavySummaryObservation,
                  photoDiagnostics:window.__deltaPhotoDiagnostics?.events.slice(-20)})""")))
            try:
                report.setdefault('failureNativeProofs', []).append(native_state(page, device, full=True))
            except Exception as error:
                report.setdefault('diagnosticErrors', []).append('Native failure proof: '+str(error))
            page.screenshot(path=str(report_path.with_name(report_path.stem+'-'+str(DEVICES.index(device))+'.png')), full_page=True)
        except Exception as error:
            report.setdefault('diagnosticErrors', []).append(str(error))
    try:
        state = cloud.backend.admin(op='state', ownerId=OWNER, projectId=PID)
        report['failureSQL'] = dict(counts=state['counts'], heads=state['heads'])
    except Exception as error:
        report.setdefault('diagnosticErrors', []).append(str(error))


def run(engine, cloud, report, report_path):
    with ExitStack() as stack:
        profiles = [stack.enter_context(tempfile.TemporaryDirectory(prefix='heavy-delta-'+str(number)+'-')) for number in range(2)]
        clients, error_history = [], []
        def close_clients():
            for client in clients:
                client[0].close()
        stack.callback(close_clients)
        for profile, device in zip(profiles, DEVICES):
            client = make_page(engine, profile, cloud, device)
            clients.append(client)
        # Registered after contexts so assertions retain live diagnostic pages.
        stack.callback(capture_failure, cloud, report, report_path)
        baseline, baseline_files = None, {}
        encoded = base64.b64encode(base.photo_png()).decode('ascii')
        legacy_keys = ['background:'+heavy.drawing_id(i) for i in range(heavy.DRAWINGS)] + ['photo:'+base.DRAWING+':retained-photo']
        for number, (profile, device) in enumerate(zip(profiles, DEVICES)):
            page = clients[number][1]
            page.evaluate(base.SETUP, dict(packs=[heavy.packs()[0]] if baseline is None else baseline, encoded=encoded))
            canonical = page.evaluate("""async()=>{
              for(const [key,value]of editFixture.files)if(!key.startsWith('photo:')||key==='photo:edit-plan:retained-photo')await SentlogRecords.writeFile(key,value);
              const ws=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY));
              for(const project of ws.projects){project.collaborationVersion=1;
                for(const meta of project.drawings){const key=drawingStorageKey(meta.id),drawing=JSON.parse(SentlogRecords.getItem(key));
                  drawing.shapes=drawing.shapes.map(r=>SentlogRecordCollaboration.upgrade(r));SentlogRecords.setItem(key,JSON.stringify(drawing));}}
              SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(ws));await SentlogRecords.settled();SentlogRecords.assertSafe();
              return editFixture.snapshots();
            }""")
            if baseline is None:
                baseline = canonical
            probe = page.evaluate(collaboration.WEBKIT_BLOB_PROBE, encoded)
            assert probe['ok'], ('Native Blob/File persistence is mandatory; no memory fallback', number, probe)
            before_files = page.evaluate(delta.READ_NATIVE_FILES, legacy_keys)
            assert all(not row.get('missing') for row in before_files), before_files
            baseline_files[device] = before_files
            delta.assert_native_writes(page)
            clients[number] = restart(engine, profile, cloud, clients[number], device, error_history)
            page = clients[number][1]
            assert page.evaluate(delta.READ_NATIVE_FILES, legacy_keys) == before_files, 'Native baseline bytes changed across a browser process restart'
            assert page.evaluate("SentlogRecords.deltaJournal.bindingFor('edit-project')===null")
        pages = [client[1] for client in clients]
        cloud.backend.admin(op='seed', ownerId=OWNER,
            devices=[dict(id=DEVICES[0], name='負荷検証iPad'), dict(id=DEVICES[1], name='負荷検証iPhone'), dict(id=PC, name='負荷検証PC', type='pc')],
            projects=[dict(id=PID, client_key=base.PROJECT, payload=baseline[0])], rollout=True)
        for page in pages:
            page.evaluate("""()=>{showProjects();sentlogImporting=false;window.__heavyDeltaBootstrap={done:false};
              sentlogArchiveSync({force:true}).then(()=>window.__heavyDeltaBootstrap={done:true},
                error=>window.__heavyDeltaBootstrap={done:true,error:String(error)});}""")
        def activated():
            values = [page.evaluate("({binding:SentlogRecords.deltaJournal.bindingStateFor('edit-project'),bootstrap:window.__heavyDeltaBootstrap})") for page in pages]
            assert not any(value['bootstrap'].get('error') for value in values), values
            return all(value['binding'] and value['binding']['phase'] == 'active' and value['bootstrap']['done'] for value in values)
        heavy.wait(cloud, pages[0], activated, 'Protected SQL migration did not activate both 1,000-record profiles', timeout=300)
        for page in pages:
            result = delta.sync(page)
            assert result['enabled'] and not result['pending'] and not result['deferred'], result
            page.evaluate(heavy.OPEN, base.DRAWING)
        initial = pages[0].evaluate(SUMMARY)
        expected = heavy.comment_set(initial)
        independent_baseline = {(heavy.drawing_id(di), heavy.record_id(ri), f'初期記録 {di}-{ri}')
                                for di in range(heavy.DRAWINGS) for ri in range(heavy.RECORDS_PER_DRAWING)}
        assert {(row[0], row[1], row[3]) for row in expected} == independent_baseline and len(expected) == RECORD_COUNT
        original_tokens, changed, photos = tokens(initial), set(), []
        for page in pages:
            verify_summary(page.evaluate(SUMMARY), expected, original_tokens, changed, photos)
        assert cloud.method_counts.get('POST /rest/v1/rpc/sentlog_delta_import_baseline_batch_v1', 0) >= 10
        # Both fresh profiles call bootstrap.prepare -> readBaseline; its
        # production pageLimit is 100, so each complete 1,000-record baseline
        # needs at least ten page RPCs (activation rechecks may add more).
        assert cloud.method_counts.get('POST /rest/v1/rpc/sentlog_delta_read_baseline_page_v1', 0) >= 20
        report.update(mode='active-delta', devices=2, drawings=heavy.DRAWINGS, records=RECORD_COUNT,
                      plannedDurableComments=ROUNDS*len(DEVICES)*COMMENTS_PER_DEVICE, rounds=[], photos=photos)
        print('HEAVY_DELTA active SQL baseline ready:', RECORD_COUNT, 'records, 10 drawings, 2 native persistent profiles', flush=True)

        for round_index in range(ROUNDS):
            started, head_before, accepted_before = time.monotonic(), cloud.head_seq, len(cloud.accepted)
            local_expected = [set(expected) for _ in pages]
            bursts = []
            for number, (device, page) in enumerate(zip(DEVICES, pages)):
                heavy.offline(cloud, device, page, True)
                drawing = heavy.drawing_id(number+1 if round_index else 0)
                page.evaluate(heavy.OPEN, drawing)
                operations = [operation(drawing, number, round_index, index) for index in range(COMMENTS_PER_DEVICE)]
                local_expected[number].update((row['drawing'], row['record'], row['id'], row['text']) for row in operations)
                changed.update((row['drawing'], row['record']) for row in operations)
                bursts.append(dict(operations=operations, scope=scope_for(device)))
            for page, burst in zip(pages, bursts):
                page.evaluate('args=>{window.__heavyDeltaOutcome={done:false};('+BURST+')(args).then(value=>window.__heavyDeltaOutcome={done:true,value},error=>window.__heavyDeltaOutcome={done:true,error:String(error)});}', burst)
            progress_at = [0.0]
            def committed():
                values = [page.evaluate('window.__heavyDeltaOutcome') for page in pages]
                assert not any(value.get('error') for value in values), values
                if time.monotonic()-progress_at[0] > 20:
                    print('HEAVY_DELTA offline commit progress:', round_index+1, [page.evaluate('window.__heavyDeltaProgress') for page in pages], flush=True)
                    progress_at[0] = time.monotonic()
                return all(value['done'] for value in values)
            heavy.wait(cloud, pages[0], committed, 'Individually durable offline comment burst did not finish', timeout=300)
            results = [page.evaluate('window.__heavyDeltaOutcome.value') for page in pages]
            for number, (device, page) in enumerate(zip(DEVICES, pages)):
                for index in range(PHOTOS_PER_DEVICE):
                    data = heavy.fixture_photo(number, round_index, index)
                    photo = page.evaluate(heavy.CAPTURE, dict(encoded=base64.b64encode(data).decode('ascii'), name='IMG_0001.png'))
                    assert photo['originalSha256'] == hashlib.sha256(data).hexdigest()
                    photo.update(device=device, round=round_index)
                    photos.append(photo)
                    changed.add((photo['drawing'], photo['record']))
                own_photos = [photo for photo in photos if photo['round'] < round_index or photo['device'] == device]
                summary = page.evaluate(SUMMARY)
                verify_summary(summary, local_expected[number], original_tokens, changed, own_photos)
                assert summary['view'] == 'editor' and summary['drawing'] == bursts[number]['operations'][0]['drawing']
                assert page.evaluate(heavy.PHOTO_PROOF, own_photos) is not False
                durable = native_state(page, device)
                assert durable['journal']['count'] + durable['outbox'] > 0 and not durable['blocked'], 'Offline edits lost their durable pending state'
                results[number]['durablePending'] = durable
                expected.update(local_expected[number])
            sql_offline = cloud.backend.admin(op='state', ownerId=OWNER, projectId=PID)
            assert sql_offline['heads'][0]['last_seq'] == head_before == cloud.head_seq, 'Offline changes reached the isolated server'
            assert not any('heavy-delta-'+str(round_index)+'-' in json.dumps(row['collab']) for row in sql_offline['recordStates'])
            print('HEAVY_DELTA offline round durable:', round_index+1, len(expected)-RECORD_COUNT, 'comments,', len(photos), 'photos', flush=True)

            if round_index == 0:
                report.setdefault('snapshotObservationFences', []).append(dict(device=DEVICES[0], phase='before-offline-restart', counters=pages[0].evaluate('window.__heavySummaryObservation')))
                clients[0] = restart(engine, profiles[0], cloud, clients[0], DEVICES[0], error_history)
                pages[0] = clients[0][1]
                assert not pages[0].evaluate('navigator.onLine')
                own_photos = [photo for photo in photos if photo['device'] == DEVICES[0]]
                verify_summary(pages[0].evaluate(SUMMARY), local_expected[0], original_tokens, changed, own_photos)
                assert pages[0].evaluate(heavy.PHOTO_PROOF, own_photos) is not False
                resumed = native_state(pages[0], DEVICES[0])
                assert resumed['journal']['count'] + resumed['outbox'] > 0
                assert resumed['journal']['throughSeq'] >= results[0]['afterThroughSeq']
                pages[0].evaluate(heavy.OPEN, base.DRAWING)
                pages[0].evaluate('sentlogImporting=false')
                report['offlineProcessRestartRetainedJournalAndFiles'] = True
                cloud.drop_delta_ack = DEVICES[0]
            for device, page in zip(DEVICES, pages):
                heavy.offline(cloud, device, page, False)
            def converged():
                head = cloud.head_seq
                durable = [native_state(page, device) for device, page in zip(DEVICES, pages)]
                if head != cloud.head_seq or not all(is_drained(proof, head) for proof in durable):
                    return False
                # Observe the canvas only after the durable sender/receiver
                # queues drain. Stable mirror corruption still fails the
                # reader immediately; continuous incoming work is not mistaken
                # for an atomic canvas snapshot.
                summaries = [page.evaluate(SUMMARY) for page in pages]
                return all(heavy.comment_set(summary) == expected for summary in summaries) and head == cloud.head_seq
            heavy.wait(cloud, pages[0], converged, 'Active journals did not automatically replay and converge', timeout=180)
            heavy.wait(cloud, pages[0], lambda:all(page.evaluate(heavy.PHOTO_PROOF, photos) is not False for page in pages),
                       'Active-delta photo bytes did not reach both native profiles', timeout=180)
            heavy.wait(cloud, pages[0], lambda:all(any(asset['client_key']=='photo:'+photo['drawing']+':'+photo['photoId']
                and all((asset['id'], device) in cloud.receipts for device in DEVICES) for asset in cloud.assets.values()) for photo in photos),
                'Photo delivery did not record both exact-byte device receipts', timeout=90)
            verify_photo_receipts(cloud, photos)
            summaries, native_proofs = observe_complete(cloud, pages,
                [burst['operations'][0]['drawing'] for burst in bursts], report, 'round-'+str(round_index+1))
            sql_state, sql_graph = verify_sql(cloud, pages[0], expected, report)
            proofs = []
            for number, (device, page) in enumerate(zip(DEVICES, pages)):
                summary, proof = summaries[number], native_proofs[number]
                verify_summary(summary, expected, original_tokens, changed, photos)
                assert is_drained(proof, cloud.head_seq), brief_native(proof)
                assert tokens(summary) == tokens(proof['graph']) == tokens(sql_graph), 'Saved record mirror, native replica and SQL revisions differ'
                assert proof['graph']['graphSha256'] == sql_graph['graphSha256'], 'Native replica and SQL immutable history bytes differ'
                delta.assert_native_writes(page)
                proofs.append(dict(device=device, cursor=proof['cursor'], journal=proof['journal'], outbox=proof['outbox'], historySha256=proof['graph']['graphSha256']))
            report['rounds'].append(dict(round=round_index+1, seconds=time.monotonic()-started,
                localBursts=results, acceptedAppendCalls=len(cloud.accepted)-accepted_before,
                newComments=len(expected)-RECORD_COUNT, photos=len(photos), durableProofs=proofs))
            report.pop('lastNativeProofs', None)
            print('PASS heavy active-delta round:', round_index+1, len(expected)-RECORD_COUNT, 'comments, SQL head', cloud.head_seq, flush=True)

        assert cloud.lost_ack is not None and cloud.duplicate_acks >= 1, 'Lost acknowledgement and idempotent retry were not exercised'
        certificate = pages[0].evaluate('cp=>sentlogDeltaRuntime.checkpoint(cp,{force:true})', CP)
        assert certificate['headSeq'] == cloud.head_seq and certificate['projectId'] == PID
        pc_rows = cloud.backend.admin(op='request', ownerId=OWNER, deviceId=PC, method='GET',
            path='/rest/v1/sentlog_project_snapshots', query=dict(project_id='eq.'+PID, select='revision,payload'),
            headers={'x-client-info':'sentlog-collaboration/1'})
        assert len(pc_rows) == 1 and pc_rows[0]['revision'] == certificate['revision'] and pc_rows[0]['payload'] == certificate['payload'], 'PC-compatible snapshot differs from the certified SQL projection'
        checkpoint_records = {json.dumps([drawing['meta']['id'], record['id']], separators=(',', ':')):record
                              for drawing in certificate['payload']['drawings']
                              for record in drawing['state']['shapes'] + drawing['state'].get('collabDeletedRecords', [])}
        checkpoint_graph = pages[0].evaluate(GRAPH, checkpoint_records)
        assert tokens(checkpoint_graph) == tokens(sql_graph) and heavy.comment_set(checkpoint_graph) == expected
        assert sum(len(record.get('photos', [])) for record in checkpoint_records.values()) == len(photos)+1
        report['pcCheckpoint'] = {key:certificate[key] for key in ('checkpointId', 'headSeq', 'revision', 'payloadSha256')}

        before_echo = len(cloud.accepted)
        hints = list(reversed(cloud.stale_notifications))*5
        for page in pages:
            page.evaluate('values=>{for(const value of values)syntheticNotify(value);}', hints)
        pages[0].wait_for_timeout(1500)
        cloud.pump()
        assert len(cloud.accepted) == before_echo, 'Old delta hints manufactured outgoing edits'
        for number, (device, profile) in enumerate(zip(DEVICES, profiles)):
            page = pages[number]
            heavy.offline(cloud, device, page, True)
            report.setdefault('snapshotObservationFences', []).append(dict(device=device, phase='before-final-restart', counters=page.evaluate('window.__heavySummaryObservation')))
            clients[number] = restart(engine, profile, cloud, clients[number], device, error_history)
            pages[number] = page = clients[number][1]
            assert not page.evaluate('navigator.onLine')
            assert page.evaluate(delta.READ_NATIVE_FILES, legacy_keys) == baseline_files[device], 'Activation or replay changed a retained background or legacy photo'
            summary = page.evaluate(SUMMARY)
            verify_summary(summary, expected, original_tokens, changed, photos)
            assert page.evaluate(heavy.PHOTO_PROOF, photos) is not False
            proof = native_state(page, device, full=True)
            assert is_drained(proof, cloud.head_seq)
            assert tokens(summary) == tokens(proof['graph']) == tokens(sql_graph)
            assert proof['graph']['graphSha256'] == sql_graph['graphSha256']
            for photo in [photo for photo in photos if photo['device'] == device]:
                original = page.evaluate("""async row=>{
                  const blob=await SentlogOriginalPhotos.getOriginal(row.drawing,row.photoId);
                  if(!(blob instanceof Blob))throw Error('Missing originating original after restart');
                  return {size:blob.size,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('')};
                }""", photo)
                assert original == dict(size=photo['originalBytes'], sha256=photo['originalSha256'])
            delta.assert_native_writes(page)
            error_history.extend(clients[number][2])
        assert not error_history, error_history
        assert not cloud.unexpected, cloud.unexpected
        report.update(status='passed', newComments=len(expected)-RECORD_COUNT, durableCommentCommits=sum(row['operations'] for phase in report['rounds'] for row in phase['localBursts']),
            photos=photos, sharedByteCopiesVerified=len(photos)*2, originatingOriginalHashesVerified=len(photos),
            retainedBaselineFileCopiesVerified=len(legacy_keys)*len(DEVICES),
            nativeProcessRestartsVerified=5, lostAcknowledgement=cloud.lost_ack, duplicateAcknowledgements=cloud.duplicate_acks,
            acceptedAppendCalls=len(cloud.accepted), restRequests=len(cloud.traffic), requestBodyBytes=sum(row['bytes'] for row in cloud.traffic),
            rpcCounts=cloud.method_counts, sqlErrors=cloud.sql_errors, strictSQLReplicaHistoryEquality=True,
            duplicatedReorderedHintDeliveries=cloud.notification_deliveries+len(hints)*2)
        print('PASS heavy active-delta native/SQL sync:', {key:report[key] for key in ('records', 'durableCommentCommits', 'sharedByteCopiesVerified', 'restRequests', 'duplicateAcknowledgements')}, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    report = dict(engine=args.engine, mode='active-delta', status='running', startedAt=time.time())
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(args.built_root.resolve())))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    backend, cloud = None, None
    try:
        backend = delta.Backend(args.built_root.resolve())
        cloud = Cloud(f'http://127.0.0.1:{server.server_port}', args.built_root.resolve(), args.engine, backend)
        with sync_playwright() as playwright:
            run(getattr(playwright, args.engine), cloud, report, args.report)
    except Exception as error:
        report.update(status='failed', error=str(error))
        if cloud:
            report.update(recentTraffic=cloud.traffic[-35:], rpcCounts=cloud.method_counts, sqlErrors=cloud.sql_errors,
                          acceptedAppendCalls=len(cloud.accepted), lostAcknowledgement=cloud.lost_ack)
        raise
    finally:
        if backend:
            backend.close()
        server.shutdown()
        report['elapsedSeconds'] = time.time()-report['startedAt']
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()

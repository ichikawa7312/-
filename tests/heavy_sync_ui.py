"""Three actual legacy-mode applications under offline/concurrent edit load.

The built application, collaboration model, persistence, native IndexedDB,
photo conversion and sync scheduler run unchanged. Auth, REST/Storage and
Realtime are isolated fixtures; no request can reach a real service. Persistent
profiles retain WebKit's native Blob path. Only Storage POST inspection uses
the existing byte-identical Uint8Array adapter in WebKit.

This checks correctness under load, not physical iPhone speed or a live-server
capacity limit. Timings are diagnostic; exact records, revisions, bytes and
bounded request counts are gates.
"""
import argparse
import base64
import copy
import functools
import hashlib
import io
import json
import tempfile
import threading
import time
from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image
from playwright.sync_api import expect, sync_playwright

import collaboration_ui as collaboration
import edit_sync_ui as base

ROOT = Path(__file__).resolve().parents[1]
PC = '77777777-7777-4777-8777-777777777777'
DEVICES = [collaboration.A, collaboration.B, PC]
DRAWINGS, RECORDS_PER_DRAWING, ROUNDS, COMMENTS_PER_DEVICE = 10, 100, 3, 100
PHOTOS_PER_DEVICE_ROUND = 3


def drawing_id(index):
    return base.DRAWING if index == 0 else f'heavy-plan-{index}'


def record_id(index):
    return ['survey-a', 'survey-b'][index] if index < 2 else f'heavy-record-{index}'


def packs():
    main = base.payload(base.PROJECT, base.DRAWING)
    template = copy.deepcopy(main['drawings'][0])
    main['drawings'], main['project']['drawings'] = [], []
    for drawing_index in range(DRAWINGS):
        drawing = copy.deepcopy(template)
        did = drawing_id(drawing_index)
        drawing['meta'].update(id=did, name=f'負荷検証図面{drawing_index+1}', groupId=did,
                               sheetName=f'負荷検証図面{drawing_index+1}', shapeCount=RECORDS_PER_DRAWING,
                               photoCount=1 if drawing_index == 0 else 0)
        records = []
        for index in range(RECORDS_PER_DRAWING):
            record = copy.deepcopy(template['state']['shapes'][0])
            point = dict(x=40+(index % 20)*50, y=40+(index // 20)*80)
            record.update(id=record_id(index), recordNo=index+1, globalNo=index+1,
                          typeNo=index+1, autoLabel=f'調査-{index+1}', point=point,
                          points=[copy.deepcopy(point), copy.deepcopy(point)],
                          memo=f'初期記録 {drawing_index}-{index}', photos=[])
            if drawing_index == 0 and index == 0:
                record['photos'] = copy.deepcopy(template['state']['shapes'][0]['photos'])
            records.append(record)
        drawing['state'].update(shapes=records, nextGlobalNo=RECORDS_PER_DRAWING+1)
        main['drawings'].append(drawing)
        main['project']['drawings'].append(copy.deepcopy(drawing['meta']))
    return [main, base.payload(base.QUIET, 'unrelated-plan')]


class Cloud(collaboration.Cloud):
    def __init__(self, origin, root, engine):
        super().__init__(origin, root, engine)
        self.webkit_sources = {}  # Serve the exact built source; no Blob fallback.
        self.offline, self.page_devices, self.receipts = set(), {}, {}
        self.traffic, self.accepted, self.stale_notifications = [], [], []
        self.lost_acknowledgements = 0
        self.notification_deliveries = 0
        self.suspend_notifications = False

    @staticmethod
    def rows(values, query):
        normalized = {}
        for key, terms in query.items():
            normalized[key] = [('eq.'+json.loads(term[3:]))
                               if term.startswith('eq."') and term.endswith('"') else term
                               for term in terms]
        return base.FakeCloud.rows(values, normalized)

    def accept(self, route, entry):
        before = len(self.writes)
        dropping = self.drop_ack == entry['device']
        super().accept(route, entry)
        if len(self.writes) != before:
            project = entry['query'].get('project_id', [''])[0].removeprefix('eq.') or entry['body'].get('project_id')
            self.accepted.append(dict(device=entry['device'], project=project,
                                      revision=self.snapshots[project]['revision']))
            if dropping:
                self.lost_acknowledgements += 1

    def route(self, route, device):
        request, parsed = route.request, urlparse(route.request.url)
        if parsed.netloc != 'wiulvaqixphuobdielyy.supabase.co' or request.method == 'OPTIONS':
            return super().route(route, device)
        query = parse_qs(parsed.query)
        self.traffic.append(dict(device=device, path=parsed.path, method=request.method,
                                 bytes=len(request.post_data_buffer or b''), offline=device in self.offline))
        assert len(self.traffic) < 6000, 'Unbounded synthetic REST request storm'
        if device in self.offline:
            route.abort('internetdisconnected')
            return
        if parsed.path.endswith('/sentlog_devices'):
            self.respond(route, [dict(id=device, active=True, device_name={DEVICES[0]:'検証iPad', DEVICES[1]:'検証iPhone', PC:'検証PC'}[device],
                                     device_type='pc' if device == PC else 'mobile')])
            return
        if parsed.path.endswith('/sentlog_asset_device_receipts'):
            self.respond(route, self.rows(self.receipts.values(), query))
            return
        if parsed.path.endswith('/rpc/sentlog_ack_photo'):
            body = json.loads(request.post_data)
            asset = self.assets[body['p_asset_id']]
            assert body['p_sha256'] == asset['sha256'] and body['p_byte_size'] == asset['byte_size']
            self.receipts[(asset['id'], device)] = dict(asset_id=asset['id'], owner_id=collaboration.OWNER,
                device_id=device, sha256=asset['sha256'], byte_size=asset['byte_size'], received_at='2026-11-21T00:00:00Z')
            self.respond(route, {'received': True})
            return
        result = super().route(route, device)
        # The fixture must not keep hundreds of multi-megabyte request copies.
        # The full server state remains, with independent small traffic evidence.
        self.requests = self.requests[-24:]
        self.posts = self.posts[-24:]
        self.writes = self.writes[-24:]
        return result

    def pump(self):
        if self.suspend_notifications:
            return
        notifications, self.notifications = self.notifications, []
        if not notifications:
            return
        self.stale_notifications = (self.stale_notifications+copy.deepcopy(notifications))[-30:]
        # Notifications carry only hints. Reverse and duplicate them so old
        # announcements cannot replace a later canonical server snapshot.
        hints = list(reversed(notifications))*3
        for page in self.pages:
            if page.is_closed() or self.page_devices.get(page) in self.offline:
                continue
            page.evaluate('values=>{for(const value of values)syntheticNotify(value);}', hints)
            self.notification_deliveries += len(hints)


def make_page(engine, profile, cloud, device, number):
    context = engine.launch_persistent_context(str(profile), headless=True,
        viewport={'width':[820,390,1440][number], 'height':[1000,844,900][number]},
        is_mobile=number != 2, has_touch=number != 2, service_workers='block')
    session = dict(access_token='synthetic-access-token', expires_at=time.time()+7200,
                   user=dict(id=collaboration.OWNER, email='fixture@example.invalid'))
    context.add_init_script(collaboration.SOCKET + "window.sentlogImporting=true;"
        + "window.__fixtureOffline=localStorage.getItem('heavyOffline')==='1';"
        + "Object.defineProperty(navigator,'onLine',{get:()=>!window.__fixtureOffline});"
        + "localStorage.setItem('sentlogCloudSessionV1',"+json.dumps(json.dumps(session))+");"
        + "localStorage.setItem('sentlogCloudDeviceV1',"+json.dumps(device)+");")
    if cloud.engine == 'webkit':
        context.add_init_script(collaboration.WEBKIT_STORAGE_BODY)
    context.route('**/*', lambda route: cloud.route(route, device))
    page = context.pages[0] if context.pages else context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(cloud.origin+'/sentlog/', wait_until='domcontentloaded')
    ready(page)
    cloud.pages.append(page)
    cloud.page_devices[page] = device
    cloud.page_errors.append(errors)
    return context, page, errors


def ready(page):
    page.wait_for_function('window.sentlogAppReady&&window.SentlogCollaboration&&window.SentlogCollaborationPhotos&&SentlogRecords.ready', timeout=60000)
    page.evaluate('async()=>await sentlogAppReady')


def wait(cloud, page, predicate, label, timeout=90):
    deadline = time.monotonic()+timeout
    while True:
        cloud.pump()
        if predicate():
            return
        assert time.monotonic() < deadline, label
        page.wait_for_timeout(100)


def offline(cloud, device, page, value):
    if value:
        cloud.offline.add(device)
    else:
        cloud.offline.discard(device)
    page.evaluate("""value=>{
      window.__fixtureOffline=value;localStorage.setItem('heavyOffline',value?'1':'0');
      window.dispatchEvent(new Event(value?'offline':'online'));
    }""", value)


OPEN = """async did=>{await openDrawing('edit-project',did);SentlogFieldRecords.selectRecord('survey-a');
  $('inspector').classList.add('open');await SentlogRecords.settled();}"""

BURST = r"""async ({operations,geometry})=>{
  const start=performance.now(),M=SentlogRecordCollaboration;
  for(const [n,op] of operations.entries()){
    const index=state.shapes.findIndex(r=>r.id===op.record);
    if(index<0)throw Error('Missing stress target');
    const next=M.appendComment(state.shapes[index],op.text,{actor:SentlogCollaboration.actor(),
      at:op.at,commentId:op.id,revisionId:op.id+':r1'});
    state.shapes[index]=next;persist();
    if(n%10===9)await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(geometry){
    const index=state.shapes.findIndex(r=>r.id==='survey-b'),record=state.shapes[index];
    const field=M.view(record).fields.geometry,value=structuredClone(field.value);
    value.point.x=geometry.x;value.points=value.points.map(p=>({...p,x:geometry.x}));
    state.shapes[index]=M.setField(record,'geometry',value,{actor:SentlogCollaboration.actor(),
      at:geometry.at,expectedHeads:field.headIds,revisionId:geometry.id});persist();
  }
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  return {ms:performance.now()-start,operations:operations.length,view:currentView,drawing:activeDrawingId};
}"""

SUMMARY = r"""async()=>{
  const store=SentlogRecords,started=performance.now();let generation=0,changedReads=0;
  const unsubscribe=store.subscribe(()=>generation++);
  window.__heavySummaryObservation??={calls:0,changedReads:0,maxChangedReads:0};
  window.__heavySummaryObservation.calls++;
  try{
    for(let attempt=0;attempt<12&&performance.now()-started<15000;attempt++){
      await store.settled();store.assertSafe();
      const beforeGeneration=generation,beforePending=store.pending;
      const workspaceText=store.getItem(WORKSPACE_KEY),workspace=JSON.parse(workspaceText);
      const project=workspace.projects.find(p=>p.id==='edit-project');
      const keys=[WORKSPACE_KEY,...project.drawings.map(meta=>drawingStorageKey(meta.id))];
      const memory=keys.map(key=>store.getItem(key));
      const disk=await Promise.all(keys.map(key=>getDBFile('__sentlog_record__:'+key)));
      const afterPending=store.pending,afterGeneration=generation,after=keys.map(key=>store.getItem(key));
      // settled() drains the work already scheduled; it is not a read lock.
      // Discard only a sample proven to overlap store activity or changed
      // values, including ABA changes detected by the subscription generation.
      if(beforePending||afterPending||beforeGeneration!==afterGeneration||memory.some((text,i)=>text!==after[i])){
        changedReads++;window.__heavySummaryObservation.changedReads++;
        window.__heavySummaryObservation.maxChangedReads=Math.max(window.__heavySummaryObservation.maxChangedReads,changedReads);
        await new Promise(resolve=>setTimeout(resolve,0));continue;
      }
      const mismatch=keys.findIndex((key,i)=>disk[i]!==memory[i]);
      if(mismatch>=0){
        const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value))))]
          .map(v=>v.toString(16).padStart(2,'0')).join('');
        throw Error('Stable native durable record mirror mismatch: '+JSON.stringify({key:keys[mismatch],
          beforeGeneration,afterGeneration,beforePending,afterPending,changedReads,
          memoryLength:memory[mismatch]?.length,durableLength:disk[mismatch]?.length,
          memorySha256:await hash(memory[mismatch]),durableSha256:await hash(disk[mismatch])}));
      }
      const records=[],comments=[],photos=[];
      for(const [index,meta]of project.drawings.entries()){
        const drawing=JSON.parse(disk[index+1]);
        for(const record of [...drawing.shapes,...(drawing.collabDeletedRecords||[])]){
          const view=SentlogRecordCollaboration.view(record);
          records.push({drawing:meta.id,record:record.id,token:view.token,deleted:SentlogRecordCollaboration.isDeleted(record),conflicts:view.conflicts.length});
          for(const comment of view.comments)comments.push({drawing:meta.id,record:record.id,id:comment.id,
            text:comment.text,deleted:comment.deleted,headIds:comment.headIds});
          for(const photo of record.photos||[])photos.push({drawing:meta.id,record:record.id,...photo});
        }
      }
      return {records,comments,photos,pending:await SentlogCollaborationPhotos.listPending(),
        binding:store.deltaJournal.bindingFor('edit-project'),view:currentView,drawing:activeDrawingId,
        queuedProjects:[...(window.sentlogEditSync?.pending||[])],
        observation:{changedReads,ms:performance.now()-started},
        cloudMessage:document.getElementById('sentlogCloudMsg')?.textContent};
    }
    throw Error('Could not obtain a coherent native record observation within bounds: '+JSON.stringify({changedReads,ms:performance.now()-started}));
  }finally{unsubscribe();}
}"""

CAPTURE = r"""async ({encoded,name})=>{
  const photo=new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],name,{type:'image/png',lastModified:123});
  const target=SentlogCollaborationPhotos.captureTarget(),intent=SentlogCollaborationPhotos.prepareCapture(target);
  const results=await SentlogCollaborationPhotos.register([photo],intent);
  if(results.length!==1||results[0].status!=='attached'||!results[0].originalSaved)throw Error('Stress photo was not durable');
  const photoId=results[0].photoId,record=JSON.parse(SentlogRecords.getItem(drawingStorageKey(target.drawingId)))
    .shapes.find(r=>r.id===target.recordId),shared=record.photos.find(p=>p.id===photoId);
  const original=await SentlogOriginalPhotos.getOriginal(target.drawingId,photoId);
  const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
  return {drawing:target.drawingId,record:target.recordId,photoId,originalSha256:await hash(original),
    originalBytes:original.size,sharedSha256:shared.sha256,sharedBytes:shared.size,sharedType:shared.type};
}"""

PHOTO_PROOF = r"""async expected=>{
  const proofs=[];
  for(const row of expected){
    const blob=await getDBFile('photo:'+row.drawing+':'+row.photoId);
    if(!(blob instanceof Blob)||blob.size!==row.sharedBytes||blob.type!==row.sharedType)return false;
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==row.sharedSha256)return false;
    proofs.push(row.photoId);
  }
  return proofs;
}"""


def expected_row(did, number, round_index, index):
    rid = 'survey-a' if index % 4 == 0 else record_id(1+number*30+index % 29)
    identity = f'heavy-{round_index}-{number}-{index}'
    return dict(drawing=did, record=rid, id=identity, text=f'負荷検証追記 {identity}：位置・写真・数量を確認。',
                at=(1000+index if number == 1 else 900000+index))


def comment_set(summary):
    return {(row['drawing'],row['record'],row['id'],row['text']) for row in summary['comments'] if not row['deleted']}


def verify_summary(summary, expected, original_tokens, changed):
    assert summary['binding'] is None, 'Stress must stay in legacy snapshot mode'
    assert len(summary['records']) == DRAWINGS*RECORDS_PER_DRAWING, len(summary['records'])
    assert len({(r['drawing'],r['record']) for r in summary['records']}) == len(summary['records'])
    assert not any(row['deleted'] for row in summary['records'])
    assert comment_set(summary) == expected, {'missing':list(expected-comment_set(summary))[:10], 'extra':list(comment_set(summary)-expected)[:10]}
    assert len(summary['comments']) == len(expected), 'Duplicate or silently deleted comments'
    assert all(len(row['headIds']) == 1 for row in summary['comments']), 'Comment revision unexpectedly changed'
    assert summary['pending'] == [], summary['pending']
    for row in summary['records']:
        key=(row['drawing'],row['record'])
        if key not in changed:
            assert row['token'] == original_tokens[key], ('Unrelated immutable history changed',key)


def fixture_photo(number, round_index, index):
    image=Image.new('RGB',(64,48),(30+number*70,40+round_index*60,50+index*60))
    stream=io.BytesIO();image.save(stream,format='PNG')
    return stream.getvalue()


def capture_failure(cloud, report):
    if report.get('status') == 'passed':return
    for index,page in enumerate(cloud.pages):
        if page.is_closed():continue
        try:
            report.setdefault('failureStates',[]).append(page.evaluate("""()=>({view:currentView,drawing:activeDrawingId,selected,
              cloud:document.getElementById('sentlogCloudMsg')?.textContent,
              photo:document.getElementById('photoStatus')?.textContent,
              storageFailed:SentlogRecords.failed,storageIssues:SentlogRecords.issues,
              observations:window.__heavySummaryObservation,
              confirmation:document.querySelector('.sl-collab-dialog [data-status]')?.textContent})"""))
            page.screenshot(path=f'/tmp/sentlog-heavy-sync-{cloud.engine}-failure-{index}.png',full_page=True)
        except Exception as diagnostic_error:report.setdefault('diagnosticErrors',[]).append(str(diagnostic_error))


def run(engine, cloud, report):
    with ExitStack() as stack:
        profiles=[Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='sentlog-heavy-sync-'))) for _ in DEVICES]
        clients=[]
        for number,device in enumerate(DEVICES):
            context,page,errors=make_page(engine,profiles[number],cloud,device,number)
            stack.callback(context.close);clients.append((context,page,errors))
        pages=[item[1] for item in clients]
        # This callback runs before the contexts close, including on assertion
        # failure; the outer report writer then records the original exception.
        stack.callback(capture_failure,cloud,report)
        encoded=base64.b64encode(base.photo_png()).decode('ascii')
        baseline=None
        for number,page in enumerate(pages):
            setup=dict(packs=packs() if baseline is None else baseline,encoded=encoded)
            page.evaluate(base.SETUP,setup)
            canonical=page.evaluate("""async()=>{
              for(const [key,value]of editFixture.files)await SentlogRecords.writeFile(key,value);
              const ws=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY));
              for(const project of ws.projects){project.collaborationVersion=1;
                for(const meta of project.drawings){const key=drawingStorageKey(meta.id),drawing=JSON.parse(SentlogRecords.getItem(key));
                  drawing.shapes=drawing.shapes.map(r=>SentlogRecordCollaboration.upgrade(r));SentlogRecords.setItem(key,JSON.stringify(drawing));}}
              SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(ws));await SentlogRecords.settled();
              return editFixture.snapshots();
            }""")
            if baseline is None:baseline=canonical
            probe=page.evaluate(collaboration.WEBKIT_BLOB_PROBE,encoded)
            assert probe['ok'], ('Native Blob/File persistence is required, no memory fallback',number,probe)
            # Clear the setup's background/file memory map. All subsequent reads
            # and all reopens exercise the actual persisted database values.
            page.reload(wait_until='domcontentloaded');ready(page)
        cloud.seed(baseline)
        for page in pages:
            page.evaluate('async()=>{sentlogImporting=false;await sentlogArchiveSync();await sentlogCloudIdle();}')
            page.evaluate(OPEN,base.DRAWING)
        initial=pages[0].evaluate(SUMMARY)
        expected=comment_set(initial)
        assert len(expected)==DRAWINGS*RECORDS_PER_DRAWING
        original_tokens={(r['drawing'],r['record']):r['token'] for r in initial['records']}
        changed=set()
        quiet=copy.deepcopy(cloud.snapshots[base.CLOUD_QUIET])
        photos=[]
        report.update(mode='legacy',devices=3,drawings=DRAWINGS,records=DRAWINGS*RECORDS_PER_DRAWING,
                      plannedComments=ROUNDS*len(DEVICES)*COMMENTS_PER_DEVICE,rounds=[],photos=[])
        print('HEAVY_SYNC native baseline ready:',report['records'],'records in',DRAWINGS,'drawings,3 persistent contexts',flush=True)

        for round_index in range(ROUNDS):
            started=time.monotonic();accepted_before=len(cloud.accepted)
            for device,page in zip(DEVICES,pages):offline(cloud,device,page,True)
            local_expected=[set(expected) for _ in pages]
            results=[]
            bursts=[]
            for number,(device,page) in enumerate(zip(DEVICES,pages)):
                did=drawing_id(number+1 if round_index==1 else 0)
                page.evaluate(OPEN,did)
                operations=[expected_row(did,number,round_index,index) for index in range(COMMENTS_PER_DEVICE)]
                geometry=dict(x=600+number*100,at=1 if number==1 else 900000,id=f'heavy-geometry-{number}') if round_index==0 else None
                bursts.append(dict(operations=operations,geometry=geometry))
            # Begin all three workloads before awaiting any result. Periodic
            # event-loop yields retain overlapping edits and native I/O while
            # each replica still observes the same disconnected baseline.
            for page,burst in zip(pages,bursts):
                page.evaluate('args=>{window.__heavyBurstFlight=('+BURST+')(args);window.__heavyBurstFlight.catch(()=>{});}',burst)
            for number,(device,page) in enumerate(zip(DEVICES,pages)):
                operations,geometry=bursts[number]['operations'],bursts[number]['geometry']
                did=operations[0]['drawing']
                results.append(page.evaluate('window.__heavyBurstFlight'))
                for row in operations:
                    item=(row['drawing'],row['record'],row['id'],row['text'])
                    expected.add(item);local_expected[number].add(item);changed.add((row['drawing'],row['record']))
                if geometry:changed.add((base.DRAWING,'survey-b'))
                for index in range(PHOTOS_PER_DEVICE_ROUND):
                    image=fixture_photo(number,round_index,index)
                    proof=page.evaluate(CAPTURE,dict(encoded=base64.b64encode(image).decode('ascii'),name='IMG_0001.png'))
                    assert proof['originalSha256']==hashlib.sha256(image).hexdigest()
                    proof['device']=device;photos.append(proof)
                    changed.add((proof['drawing'],proof['record']))
                snapshot=page.evaluate(SUMMARY)
                verify_summary(snapshot,local_expected[number],original_tokens,changed)
                assert not page.evaluate('navigator.onLine')
                assert base.PROJECT in snapshot['queuedProjects'],('Offline edits falsely lost their pending synchronization',snapshot['queuedProjects'])
                assert snapshot['view']=='editor' and snapshot['drawing']==did
            assert len({p['photoId'] for p in photos})==len(photos),'Repeated filenames collided'
            assert f'heavy-{round_index}-' not in json.dumps(cloud.snapshots[base.CLOUD_PROJECT]['payload']), 'Offline edits escaped the isolated transport'
            print('HEAVY_SYNC offline round',round_index+1,'durable comments',len(expected)-1000,'photos',len(photos),flush=True)

            if round_index==1:
                report.setdefault('snapshotObservationFences',[]).append(dict(device=DEVICES[0],phase='before-mid-round-reload',
                    counters=pages[0].evaluate('window.__heavySummaryObservation')))
                pages[0].reload(wait_until='domcontentloaded');ready(pages[0])
                assert not pages[0].evaluate('navigator.onLine')
                verify_summary(pages[0].evaluate(SUMMARY),local_expected[0],original_tokens,changed)
                pages[0].evaluate('sentlogImporting=false')
                pages[0].evaluate(OPEN,drawing_id(1))
                report['offlineReloadNativeProof']=True
            if round_index==0:cloud.hold_device=DEVICES[0]
            if round_index==1:cloud.drop_ack=DEVICES[1]
            for device,page in zip(DEVICES,pages):offline(cloud,device,page,False)
            if round_index==0:
                wait(cloud,pages[0],lambda:bool(cloud.held),'CAS write did not reach the delay barrier')
                wait(cloud,pages[0],lambda:any(row['device']!=DEVICES[0] for row in cloud.accepted[accepted_before:]),
                     'Other devices were blocked by a delayed writer')
                assert cloud.held,'Held response disappeared before race proof'
                cloud.release()
                report['delayedCASRace']=True

            def converged():
                return all(comment_set(page.evaluate(SUMMARY))==expected for page in pages)
            wait(cloud,pages[0],converged,'Three applications did not converge after offline burst',timeout=150)
            wait(cloud,pages[0],lambda:all(page.evaluate(PHOTO_PROOF,photos) is not False for page in pages),
                 'Shared photo bytes were not delivered to every persistent profile',timeout=150)
            for page in pages:verify_summary(page.evaluate(SUMMARY),expected,original_tokens,changed)
            writes=len(cloud.accepted)-accepted_before
            assert writes<=18,('One burst created an unbounded snapshot echo',round_index,writes)
            report['rounds'].append(dict(round=round_index+1,seconds=time.monotonic()-started,
                                        localBursts=results,acceptedSnapshots=writes,comments=len(expected)-1000,photos=len(photos)))
            print('PASS heavy sync round',round_index+1,report['rounds'][-1],flush=True)

        assert cloud.lost_acknowledgements==1,'Dropped acknowledgement fault did not execute'
        # Three disconnected moves of the same record preserve alternatives.
        for page in pages:page.evaluate(OPEN,base.DRAWING)
        geometries=[page.evaluate("SentlogRecordCollaboration.view(state.shapes.find(r=>r.id==='survey-b')).fields.geometry") for page in pages]
        assert all(field['conflict'] and {h['value']['point']['x'] for h in field['heads']}=={600,700,800} for field in geometries)
        pages[2].evaluate("""async()=>{
          const M=SentlogRecordCollaboration,index=state.shapes.findIndex(r=>r.id==='survey-b'),record=state.shapes[index],field=M.view(record).fields.geometry;
          const value=structuredClone(field.heads.find(h=>h.value.point.x===700).value);
          state.shapes[index]=M.resolveField(record,'geometry',value,{actor:SentlogCollaboration.actor(),expectedHeads:field.headIds,revisionId:'heavy-geometry-resolved'});
          persist();await SentlogRecords.settled();
        }""")
        wait(cloud,pages[0],lambda:all(page.evaluate("(()=>{const f=SentlogRecordCollaboration.view(state.shapes.find(r=>r.id==='survey-b')).fields.geometry;return !f.conflict&&f.value.point.x===700;})()") for page in pages),
             'Explicit geometry resolution did not converge')
        report['geometryConflictPreservedAndResolved']=True

        # A large record is deleted only after a fresh peer change is shown.
        a,b=pages[:2]
        a.locator('#deleteBtn').click()
        cloud.suspend_notifications=True
        peer=dict(drawing=base.DRAWING,record='survey-a',id='heavy-peer-before-delete',text='削除確認中の別端末からの追記',at=123)
        b.evaluate(BURST,dict(operations=[peer],geometry=None))
        wait(cloud,b,lambda:'heavy-peer-before-delete' in json.dumps(cloud.snapshots[base.CLOUD_PROJECT]['payload']),
             'Peer edit did not reach canonical server state before confirmation')
        expected.add((peer['drawing'],peer['record'],peer['id'],peer['text']))
        a.locator('.sl-collab-dialog').get_by_role('button',name='削除する',exact=True).click()
        wait(cloud,a,lambda:'もう一度' in a.locator('.sl-collab-dialog [data-status]').inner_text(),
             'Heavy record deletion did not re-confirm new peer history',timeout=20)
        assert a.evaluate("state.shapes.some(r=>r.id==='survey-a')")
        a.locator('.sl-collab-dialog').get_by_role('button',name='削除する',exact=True).click()
        wait(cloud,a,lambda:not a.evaluate("state.shapes.some(r=>r.id==='survey-a')"),'Confirmed deletion did not finish',timeout=20)
        cloud.suspend_notifications=False
        wait(cloud,a,lambda:all(page.evaluate("(state.collabDeletedRecords||[]).some(r=>r.id==='survey-a')") for page in pages),
             'Deleted record and preserved history did not synchronize')
        for page in pages:
            assert page.evaluate(PHOTO_PROOF,photos) is not False,'Deleting a heavy record discarded retained photo bytes'
        a.locator('#undoBtn').click()
        wait(cloud,a,lambda:all(page.evaluate("state.shapes.some(r=>r.id==='survey-a')") for page in pages),'Deletion undo did not restore the heavy record')
        report['freshDeleteReconfirmationAndUndo']=True

        a.evaluate(OPEN,base.DRAWING)
        cloud.hold_head=(DEVICES[0],base.CLOUD_PROJECT)
        a.locator('#deleteBtn').click()
        a.locator('.sl-collab-dialog').get_by_role('button',name='削除する',exact=True).click()
        wait(cloud,a,lambda:bool(cloud.held_heads),'Confirmation did not reach delayed fresh-read barrier')
        a.locator('.sl-collab-dialog').get_by_role('button',name='キャンセル',exact=True).click()
        cloud.release_heads();a.wait_for_timeout(250)
        assert a.evaluate("state.shapes.some(r=>r.id==='survey-a')")
        report['cancelledLateResponseProtected']=True

        before_echo=len(cloud.accepted)
        old_hints=list(reversed(cloud.stale_notifications))*10
        for page in pages:page.evaluate('values=>{for(const value of values)syntheticNotify(value);}',old_hints)
        a.wait_for_timeout(1500);cloud.pump()
        final=[]
        for page in pages:
            proof=page.evaluate(SUMMARY);verify_summary(proof,expected,original_tokens,changed)
            assert not any(row['conflicts'] for row in proof['records'])
            assert page.evaluate(PHOTO_PROOF,photos) is not False
            final.append(sorted((r['drawing'],r['record'],r['token']) for r in proof['records']))
        assert final[0]==final[1]==final[2],'Persistent replicas disagree despite matching visible text'
        assert len(cloud.accepted)-before_echo<=3,'Old notification burst created repeated write echoes'
        assert cloud.snapshots[base.CLOUD_QUIET]==quiet,'Unrelated project was changed by heavy scoped work'

        for number,(device,page) in enumerate(zip(DEVICES,pages)):
            offline(cloud,device,page,True)
            report.setdefault('snapshotObservationFences',[]).append(dict(device=device,phase='before-final-reload',
                counters=page.evaluate('window.__heavySummaryObservation')))
            page.reload(wait_until='domcontentloaded');ready(page)
            proof=page.evaluate(SUMMARY);verify_summary(proof,expected,original_tokens,changed)
            assert page.evaluate(PHOTO_PROOF,photos) is not False
            for photo in [p for p in photos if p['device']==device]:
                digest=page.evaluate("""async row=>{
                  const blob=await SentlogOriginalPhotos.getOriginal(row.drawing,row.photoId);
                  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
                }""",photo)
                assert digest==photo['originalSha256'],'Originating original bytes changed across restart'
            assert not clients[number][2],clients[number][2]
        assert not cloud.unexpected,cloud.unexpected
        report.update(commentsVerified=len(expected),newComments=len(expected)-1000,photos=photos,
            nativeReloadsVerified=4,sharedByteCopiesVerified=len(photos)*3,originalHashesVerified=len(photos),
            acceptedSnapshots=len(cloud.accepted),restRequests=len(cloud.traffic),requestBodyBytes=sum(r['bytes'] for r in cloud.traffic),
            duplicatedReorderedHintDeliveries=cloud.notification_deliveries+len(old_hints)*3,
            lostAcknowledgements=cloud.lost_acknowledgements,unrelatedProjectUnchanged=True,
            strictReplicaTokenEquality=True,status='passed')
        print('PASS heavy three-device legacy sync:',{k:report[k] for k in ('records','newComments','sharedByteCopiesVerified','acceptedSnapshots','restRequests','lostAcknowledgements')},flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--engine',choices=('chromium','webkit'),required=True)
    parser.add_argument('--built-root',type=Path,default=ROOT)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(args.built_root.resolve())))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    cloud=Cloud(f'http://127.0.0.1:{server.server_port}',args.built_root.resolve(),args.engine)
    report=dict(engine=args.engine,status='running',startedAt=time.time())
    try:
        with sync_playwright() as playwright:
            try:run(getattr(playwright,args.engine),cloud,report)
            except Exception as error:
                report.update(status='failed',error=str(error),recentTraffic=cloud.traffic[-35:],acceptedSnapshots=len(cloud.accepted))
                capture_failure(cloud,report)
                raise
    finally:
        server.shutdown();report['elapsedSeconds']=time.time()-report['startedAt']
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')


if __name__=='__main__':main()

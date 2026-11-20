"""Real capacity UI flows, using disposable SQL and a synthetic PC directory.

Call after delta_app_ui's certified checkpoint. The application HTML, capacity
buttons, record store, delta journal, copy GC and IndexedDB Blobs are unchanged.
Only the PC filesystem/transport and its authenticated device are fixtures; no
real account, production records or company PC are accessed.
"""
import base64
import copy
import hashlib
import json
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse


READ_FILES = r"""async keys=>{
  // The earlier drawing fixture keeps baseline image objects in a Map for its
  // renderer. They have already been committed to native IndexedDB. Remove
  // that test fallback so a deleted file cannot appear to survive in memory.
  window.editFixture?.files?.clear();
  const files=[];
  for(const key of keys){
    const blob=await getDBFile(key);
    if(!(blob instanceof Blob)){files.push({key,missing:true});continue;}
    const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
    const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    files.push({key,size:bytes.length,sha256,mimeType:blob.type,name:blob.name||key,encoded:btoa(binary)});
  }
  return files;
}"""

BLOB_STATS = r"""async ({scope,localProjectId})=>{
  const bytes=value=>value instanceof Blob?value.size:Array.isArray(value)?value.reduce((n,x)=>n+bytes(x),0):
    value&&typeof value==='object'?Object.values(value).reduce((n,x)=>n+bytes(x),0):0;
  async function rows(name,stores){
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name);
      q.onupgradeneeded=()=>q.transaction.abort();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try{return await new Promise((resolve,reject)=>{const out={},tx=db.transaction(stores,'readonly');
      tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error);
      for(const name of stores){const q=tx.objectStore(name).getAll();q.onsuccess=()=>out[name]=q.result;}
    });}finally{db.close();}
  }
  const legacy=await rows('surveyFieldNoteDB',['files','sentlog_delta_journal_v1','sentlog_delta_control_v1']);
  const migration=await rows('sentlog-delta-migration-v1',['items','sessions']);
  const asset=await rows('sentlog-delta-assets-v1',['assets']);
  const own=row=>row.scope&&['ownerId','projectId','deviceId'].every(k=>row.scope[k]===scope[k]);
  const assets=asset.assets.filter(own).map(row=>({assetId:row.reference.assetId,phase:row.phase,
    blobBytes:row.blob instanceof Blob?row.blob.size:0,released:!!row.archiveRelease}));
  const sessions=migration.sessions.filter(row=>own(row)&&row.localProjectId===localProjectId).map(row=>({id:row.id,status:row.status}));
  return {totalBlobBytes:bytes(legacy)+bytes(migration)+bytes(asset),visibleBlobBytes:bytes(legacy.files),
    journalBlobBytes:bytes(legacy.sentlog_delta_journal_v1),controlBlobBytes:bytes(legacy.sentlog_delta_control_v1),
    migrationBlobBytes:bytes(migration.items),assetBlobBytes:bytes(asset.assets),assets,sessions};
}"""

MAKE_PACK = r"""job=>{
  const paths=Object.fromEntries(job.manifest.map(file=>[file.key,'files/'+file.id]));
  const pack=SentlogArchiveCore.backupPack(job,paths);
  if(!SentlogArchiveCore.validatePack(pack,job))throw Error('Synthetic PC package did not validate');
  return JSON.stringify(pack);
}"""

ARCHIVE_PROOF = r"""async ({cp,job})=>{
  const result=await sentlogDeltaRuntime.archiveProof(cp,job);
  await result.validate();const {validate,...proof}=result;return proof;
}"""

PROJECT_STATE = r"""async ({scope,localProjectId,drawingIds})=>{
  await SentlogRecords.settled();
  const store=SentlogDeltaIndexedDB.createStore(scope);let replica;
  try{replica=await store.read();}finally{store.close();}
  const binding=SentlogRecords.deltaJournal.bindingFor(localProjectId);
  const pending=await SentlogRecords.deltaJournal.pending({scope,localProjectId});
  const workspace=JSON.parse(SentlogRecords.getItem('surveyFieldNoteWorkspaceV1')||'{"projects":[]}');
  const present=workspace.projects.some(project=>project.id===localProjectId);
  const snapshot=present?SentlogDeltaAppBridge.captureProject({records:SentlogRecords,localProjectId}):null;
  const histories={};
  for(const drawing of snapshot?[...snapshot.drawings,...(snapshot.project.deltaMetadata?.retainedDrawings||[])]:[])
    for(const record of [...(drawing.state.shapes||[]),...(drawing.state.collabDeletedRecords||[])])
      histories[JSON.stringify([drawing.meta.id,record.id])]=SentlogRecordCollaboration.upgrade(record).collab;
  return {phase:binding?.phase,baselineId:binding?.baselineId,pending:pending.count,claimId:pending.claimId,present,
    rawDrawings:drawingIds.map(id=>({id,present:SentlogRecords.getItem('surveyFieldNoteDrawingV1:'+id)!==null})),
    shared:snapshot?SentlogDeltaMetadata.shared(snapshot):null,histories,
    replica:{cursor:replica.cursor,records:replica.records,outbox:replica.outbox.length,blocked:(replica.blockedOutbox||[]).length}};
}"""

READ_ORIGINALS = r"""async drawingIds=>{
  const originals=[];
  for(const meta of await SentlogOriginalPhotos.listMeta()){
    if(!drawingIds.includes(meta.drawingId))continue;
    const blob=await SentlogOriginalPhotos.getOriginal(meta.drawingId,meta.photoId);
    if(!(blob instanceof Blob)){originals.push({drawingId:meta.drawingId,photoId:meta.photoId,missing:true});continue;}
    const bytes=await blob.arrayBuffer();
    const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    originals.push({drawingId:meta.drawingId,photoId:meta.photoId,size:blob.size,sha256});
  }
  return originals.sort((a,b)=>a.photoId.localeCompare(b.photoId));
}"""


def _state_summary(state):
    return {key: state[key] for key in ('phase', 'baselineId', 'pending', 'claimId', 'present', 'rawDrawings')} | {
        'cursor': state['replica']['cursor'], 'outbox': state['replica']['outbox'], 'blocked': state['replica']['blocked'],
        'recordCount': len(state['replica']['records']), 'historyCount': len(state['histories'])}


def _wait(cloud, page, predicate, description, timeout=60):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, description
        cloud.pump()
        page.wait_for_timeout(80)


def _keys(payload):
    result = set()
    drawings = payload['drawings'] + payload['project'].get('deltaMetadata', {}).get('retainedDrawings', [])
    for drawing in drawings:
        drawing_id = drawing['meta']['id']
        result.add('background:' + drawing_id)
        state = drawing['state']
        for record in state.get('shapes', []) + state.get('collabDeletedRecords', []):
            photos = list(record.get('photos', []))
            for entry in record.get('collab', {}).get('photos', {}).values():
                photos.extend(revision['value'] for revision in entry['revisions'])
            for photo in photos:
                result.add('photo:' + drawing_id + ':' + photo['id'])
    return sorted(result)


def _rpc(cloud, owner, device, project_id, gateway, action, data=None):
    result = cloud.backend.call(op='request', ownerId=owner, deviceId=device,
        method='POST', path='/rest/v1/rpc/' + gateway,
        headers={'x-client-info': 'sentlog-collaboration/1'},
        body={'p_action': action, 'p_project_id': project_id, 'p_device_id': device, 'p_data': data or {}})
    assert result['ok'], (gateway, action, result)
    return result['data']


class _SyntheticPc:
    """Re-read actual fixture bytes before sending the real SQL PC receipt."""
    def __init__(self, cloud, owner, pc_device, job, directory, package_hash):
        self.cloud, self.owner, self.device = cloud, owner, pc_device
        self.job, self.directory, self.package_hash = job, Path(directory), package_hash
        self.previous_route = cloud.route
        self.operations, self.downloads = [], []

    def verify(self, job):
        assert job['id'] == self.job['id'] and job['catalog_hash'] == self.job['catalog_hash']
        assert job['delta_checkpoint'] == self.job['delta_checkpoint']
        assert job['payload'] == self.job['payload'] and job['manifest'] == self.job['manifest']
        package = (self.directory / 'manifest.sentlog.json').read_bytes()
        assert hashlib.sha256(package).hexdigest() == self.package_hash
        files = {}
        for file in job['manifest']:
            data = (self.directory / 'files' / file['id']).read_bytes()
            assert len(data) == int(file['byte_size']) and hashlib.sha256(data).hexdigest() == file['sha256']
            files[file['id']] = data
        return files

    def route(self, route, device):
        request, url = route.request, urlparse(route.request.url)
        if url.netloc != 'wiulvaqixphuobdielyy.supabase.co' or request.method == 'OPTIONS':
            return self.previous_route(route, device)
        if '/storage/v1/object/authenticated/sentlog-temp/' in url.path and '/archive-restore/' in url.path:
            self.downloads.append({'device': device, 'path': url.path})
            return self.previous_route(route, device)
        if not url.path.endswith('/rpc/sentlog_capacity_v1'):
            return self.previous_route(route, device)
        body = json.loads(request.post_data)
        entry = dict(op='request', ownerId=self.owner, deviceId=device, method=request.method,
                     path=url.path, query=parse_qs(url.query), body=body, headers=dict(request.headers))
        result = self.cloud.backend.call(**entry)
        self.cloud.requests.append(dict(device=device, path=url.path, method=request.method, body=body))
        if result['ok'] and body['p_action'] == 'begin':
            operation_id = result['data']['id']
            info = _rpc(self.cloud, self.owner, device, self.job['project_id'], 'sentlog_capacity_v1',
                        'inspect', {'operation_id': operation_id})
            jobs = _rpc(self.cloud, self.owner, self.device, self.job['project_id'], 'sentlog_capacity_v1', 'pc_jobs')
            pc_job = next(item for item in jobs if item['operation']['id'] == operation_id)
            files = self.verify(pc_job['job'])
            assert info['job']['delta_checkpoint'] == pc_job['job']['delta_checkpoint']
            if info['operation']['action'] == 'restore':
                for file in info['files']:
                    self.cloud.blobs[file['temp_path']] = files[file['id']]
            _rpc(self.cloud, self.owner, self.device, self.job['project_id'], 'sentlog_capacity_v1', 'pc_ready',
                 {'operation_id': operation_id, 'catalog_hash': self.job['catalog_hash'],
                  'package_sha256': self.package_hash, 'file_count': len(files)})
            self.operations.append(copy.deepcopy(info['operation']))
        if not result['ok']:
            self.cloud.sql_errors.append(dict(path=url.path, **result['error']))
        self.cloud.respond(route, result.get('data') if result['ok'] else result['error'], result.get('status', 400))

    def install(self):
        self.cloud.route = self.route

    def close(self):
        self.cloud.route = self.previous_route


def run(cloud, page, peer, certificate, cloud_project, owner, device, peer_device, pc_device):
    """Execute files and whole-project restoration through production controls."""
    cp, project_id = copy.deepcopy(cloud_project), cloud_project['id']
    keys = _keys(certificate['payload'])
    page.wait_for_function('window.SentlogCapacity&&window.SentlogDeltaCapacityGC')
    originals = page.evaluate(READ_FILES, keys)
    peer_originals = peer.evaluate(READ_FILES, keys)
    assert all(not item.get('missing') for item in originals + peer_originals), (originals, peer_originals)
    by_key = {item['key']: item for item in originals}
    assert {item['key']: item['sha256'] for item in originals} == {item['key']: item['sha256'] for item in peer_originals}

    # Background upload is outside this capacity test. Complete only absent
    # synthetic server assets from the native files already used by this UI.
    for key, file in by_key.items():
        client_key = 'drawing:' + key[len('background:'):] if key.startswith('background:') else key
        asset = next((row for row in cloud.assets.values() if row['client_key'] == client_key and row['project_id'] == project_id), None)
        if asset is None:
            drawing_id = key.split(':')[1]
            asset_id = str(uuid.uuid4())
            asset = dict(id=asset_id, owner_id=owner, project_id=project_id, client_key=client_key,
                kind='drawing' if key.startswith('background:') else 'photo', file_name=file['name'],
                mime_type=file['mimeType'], byte_size=file['size'], sha256=file['sha256'], status='uploaded',
                storage_path=owner + '/' + project_id + '/capacity-fixture/' + asset_id,
                source_device_id=device, metadata={'drawing_id': drawing_id, 'local_project_key': cp['client_key']})
            if asset['kind'] == 'photo':
                asset['metadata']['photo_id'] = key.split(':', 2)[2]
            cloud.assets[asset_id] = asset
            cloud.blobs[asset['storage_path']] = base64.b64decode(file['encoded'])
        assert asset['sha256'] == file['sha256'] and asset['byte_size'] == file['size'], (asset, file)
    cloud.backend.admin(op='admin', action='assets', ownerId=owner, deviceId=device, assets=list(cloud.assets.values()))

    job = _rpc(cloud, owner, device, project_id, 'sentlog_archive_v1', 'begin', {'revision': certificate['revision']})
    assert set(file['key'] for file in job['manifest']) == set(keys)
    package_text = page.evaluate(MAKE_PACK, job)
    package_hash = hashlib.sha256(package_text.encode('utf-8')).hexdigest()
    with tempfile.TemporaryDirectory(prefix='sentlog-synthetic-capacity-pc-') as directory:
        folder = Path(directory)
        (folder / 'files').mkdir()
        (folder / 'manifest.sentlog.json').write_text(package_text, encoding='utf-8')
        for file in job['manifest']:
            (folder / 'files' / file['id']).write_bytes(base64.b64decode(by_key[file['key']]['encoded']))
        pc = _SyntheticPc(cloud, owner, pc_device, job, folder, package_hash)
        pc.verify(job)
        for browser, browser_device in ((page, device), (peer, peer_device)):
            proof = browser.evaluate(ARCHIVE_PROOF, {'cp': cp, 'job': job})
            _rpc(cloud, owner, browser_device, project_id, 'sentlog_archive_v1', 'report',
                 {'job_id': job['id'], 'catalog_hash': job['catalog_hash'], 'clean': True, 'delta_proof': proof})
        _rpc(cloud, owner, pc_device, project_id, 'sentlog_archive_v1', 'pc_complete',
             {'job_id': job['id'], 'catalog_hash': job['catalog_hash'], 'file_count': len(keys),
              'package_sha256': package_hash, 'path': 'synthetic-pc/' + job['id'] + '/manifest.sentlog.json'})
        archived = _rpc(cloud, owner, device, project_id, 'sentlog_archive_v1', 'finalize', {'job_id': job['id']})
        assert archived['status'] == 'archived'
        pc.job = _rpc(cloud, owner, device, project_id, 'sentlog_archive_v1', 'inspect', {'job_id': job['id']})
        pc.install()
        diagnostics = {}
        try:
            for browser in (page, peer):
                browser.evaluate('async()=>{showProjects();await SentlogArchive.refresh();renderProjects();}')
            scope = {'ownerId': owner, 'projectId': project_id, 'deviceId': device}
            context = {'scope': scope, 'localProjectId': cp['client_key']}
            before = page.evaluate(BLOB_STATS, context)
            diagnostics['before'] = before
            assert before['migrationBlobBytes'] > 0 and before['assetBlobBytes'] > 0 and before['assets'], before
            before_records = page.evaluate('()=>SentlogRecords.getItem("surveyFieldNoteDrawingV1:edit-plan")')
            page.locator('.sl-archive-folder').click()
            page.get_by_role('button', name='PDF・写真を端末から外す', exact=True).click()
            confirm = page.get_by_role('button', name='照合済みのPDF・写真を端末から削除', exact=True)
            confirm.wait_for(state='visible', timeout=60000)
            page.once('dialog', lambda dialog: dialog.accept())
            confirm.click()
            _wait(cloud, page, lambda: 'この端末の整理が完了しました。' in page.locator('.sl-capacity-dialog .sl-capacity-message').inner_text(),
                  'Built capacity wrapper did not finish certified files cleanup')
            assert page.evaluate('id=>SentlogCapacity.isCleared(id)', project_id)
            assert all(item.get('missing') for item in page.evaluate(READ_FILES, keys))
            assert page.evaluate('()=>SentlogRecords.getItem("surveyFieldNoteDrawingV1:edit-plan")') == before_records
            after = page.evaluate(BLOB_STATS, context)
            diagnostics['afterCleanup'] = after
            assert after['totalBlobBytes'] < before['totalBlobBytes'] - sum(file['size'] for file in originals), (before, after)
            assert after['migrationBlobBytes'] < before['migrationBlobBytes'] and after['assetBlobBytes'] == 0, (before, after)
            assert after['assets'] and all(row['phase'] == 'archived' and row['released'] for row in after['assets']), after
            assert any(row['status'] == 'archived-copy' for row in after['sessions']), after
            assert {item['key']: item.get('sha256') for item in peer.evaluate(READ_FILES, keys)} == {item['key']: item['sha256'] for item in peer_originals}
            print('PASS built capacity files button frees native files plus certified migration/asset copies, retaining records and peer bytes', flush=True)

            page.locator('.sl-capacity-dialog').get_by_role('button', name='閉じる', exact=True).click()
            page.get_by_role('button', name='PCからこの端末に復旧', exact=True).click()
            _wait(cloud, page, lambda: '復旧完了！' in page.locator('.sl-capacity-dialog .sl-capacity-message').inner_text(),
                  'Built capacity restore did not complete with exact fixture PC bytes')
            assert not page.evaluate('id=>SentlogCapacity.isCleared(id)', project_id)
            restored = page.evaluate(READ_FILES, keys)
            assert {item['key']: item.get('sha256') for item in restored} == {item['key']: item['sha256'] for item in originals}, restored
            assert len(pc.downloads) == len(keys) and all(row['device'] == device for row in pc.downloads), pc.downloads
            assert page.evaluate('()=>SentlogRecords.getItem("surveyFieldNoteDrawingV1:edit-plan")') == before_records
            page.locator('.sl-capacity-dialog').get_by_role('button', name='閉じる', exact=True).click()
            page.get_by_role('button', name='この案件を手動同期', exact=True).click()
            _wait(cloud, page, lambda: all(row['phase'] == 'acknowledged' for row in page.evaluate(BLOB_STATS, context)['assets']),
                  'Explicit archived manual sync did not rehydrate and acknowledge delta asset copies')
            final = page.evaluate(BLOB_STATS, context)
            diagnostics['afterRestore'] = final
            assert final['assetBlobBytes'] == before['assetBlobBytes'], (before, final)
            assert final['migrationBlobBytes'] == after['migrationBlobBytes'], (after, final)
            assert [operation['action'] for operation in pc.operations] == ['verify', 'restore']
            pc.verify(pc.job)
            print('PASS built capacity restore rechecks a synthetic PC directory, restores native bytes, and guarded manual sync rehydrates asset receipts', flush=True)

            # Repeat through the distinct detached-project/WAL recovery path.
            # The same on-disk PC package is independently re-read for each
            # new SQL capacity operation; no local snapshot is injected.
            drawing_ids = [drawing['meta']['id'] for drawing in certificate['payload']['drawings']]
            project_context = {**context, 'drawingIds': drawing_ids}
            _wait(cloud, page, lambda: (lambda state: state['phase'] == 'active' and not state['pending']
                  and not state['claimId'] and not state['replica']['outbox'] and not state['replica']['blocked'])(
                      page.evaluate(PROJECT_STATE, project_context)),
                  'Restored files did not leave a clean project before whole-project cleanup')
            before_project = page.evaluate(PROJECT_STATE, project_context)
            camera_originals = page.evaluate(READ_ORIGINALS, drawing_ids)
            assert camera_originals and all(not item.get('missing') for item in camera_originals), camera_originals
            server_before = cloud.backend.admin(op='state', ownerId=owner, projectId=project_id)
            before_project_bytes = page.evaluate(BLOB_STATS, context)
            ack_start, download_start = len(cloud.photo_requests), len(pc.downloads)
            diagnostics['beforeWholeProject'] = _state_summary(before_project)

            page.get_by_role('button', name='この端末から案件を外す', exact=True).click()
            confirm_project = page.get_by_role('button', name='この端末から案件一式を外す', exact=True)
            confirm_project.wait_for(state='visible', timeout=60000)
            page.once('dialog', lambda dialog: dialog.accept())
            confirm_project.click()
            _wait(cloud, page, lambda: 'この端末の整理が完了しました。' in page.locator('.sl-capacity-dialog .sl-capacity-message').inner_text(),
                  'Built whole-project capacity cleanup did not finish')
            detached = page.evaluate(PROJECT_STATE, project_context)
            diagnostics['afterDetach'] = _state_summary(detached)
            assert page.evaluate('id=>SentlogCapacity.isWholeRemoved(id)', project_id)
            assert detached['phase'] == 'detached' and not detached['present'] and not detached['pending'] and not detached['claimId'], _state_summary(detached)
            assert all(not drawing['present'] for drawing in detached['rawDrawings']), detached['rawDrawings']
            assert detached['replica'] == before_project['replica'], 'Detaching a local cache changed immutable replica history or created an outbox'
            assert all(item.get('missing') for item in page.evaluate(READ_FILES, keys))
            detached_bytes = page.evaluate(BLOB_STATS, context)
            diagnostics['afterDetachBytes'] = detached_bytes
            assert detached_bytes['totalBlobBytes'] < before_project_bytes['totalBlobBytes'] and detached_bytes['assetBlobBytes'] == 0, (before_project_bytes, detached_bytes)
            assert page.evaluate(READ_ORIGINALS, drawing_ids) == camera_originals, 'Whole-project cleanup altered camera originals'
            assert {item['key']: item.get('sha256') for item in peer.evaluate(READ_FILES, keys)} == {item['key']: item['sha256'] for item in peer_originals}
            print('PASS built whole-project cleanup detaches the real journal, removes local records/files, and retains immutable history, camera originals and peer bytes', flush=True)

            page.locator('.sl-capacity-dialog').get_by_role('button', name='閉じる', exact=True).click()
            page.get_by_role('button', name='PCからこの端末に復旧', exact=True).click()
            _wait(cloud, page, lambda: '復旧完了！' in page.locator('.sl-capacity-dialog .sl-capacity-message').inner_text(),
                  'Built detached-project restoration did not finish its verified PC file/WAL transaction')
            restored_project = page.evaluate(PROJECT_STATE, project_context)
            diagnostics['immediatelyAfterWholeRestore'] = _state_summary(restored_project)
            assert restored_project['phase'] == 'active' and restored_project['present'], _state_summary(restored_project)
            assert restored_project['shared'] == before_project['shared'], 'PC restoration changed project/drawing metadata'
            assert restored_project['histories'] == before_project['histories'], 'PC restoration changed record/photo/comment history'
            assert restored_project['replica'] == before_project['replica'], 'A pure cache restoration created new replica changes'
            assert all(drawing['present'] for drawing in restored_project['rawDrawings'])
            assert not page.evaluate('id=>SentlogCapacity.isCleared(id)', project_id)
            assert {item['key']: item.get('sha256') for item in page.evaluate(READ_FILES, keys)} == {item['key']: item['sha256'] for item in originals}
            assert page.evaluate(READ_ORIGINALS, drawing_ids) == camera_originals, 'PC restoration replaced camera originals'
            assert len(pc.downloads) - download_start == len(keys), pc.downloads[download_start:]

            page.locator('.sl-capacity-dialog').get_by_role('button', name='閉じる', exact=True).click()
            page.get_by_role('button', name='この案件を手動同期', exact=True).click()
            def whole_restore_synced():
                state = page.evaluate(PROJECT_STATE, project_context)
                assets = page.evaluate(BLOB_STATS, context)['assets']
                return (state['phase'] == 'active' and state['present'] and not state['pending'] and not state['claimId']
                        and not state['replica']['outbox'] and not state['replica']['blocked']
                        and bool(assets) and all(row['phase'] == 'acknowledged' for row in assets))
            _wait(cloud, page, whole_restore_synced, 'Manual sync did not finish detached cache replay and exact photo ACKs')
            whole_final = page.evaluate(PROJECT_STATE, project_context)
            whole_final_bytes = page.evaluate(BLOB_STATS, context)
            diagnostics['afterWholeManualSync'] = _state_summary(whole_final)
            diagnostics['afterWholeManualSyncBytes'] = whole_final_bytes
            assert whole_final['replica'] == before_project['replica'], 'Cache replay emitted authored restore revisions or altered old history'
            assert whole_final['shared'] == before_project['shared'] and whole_final['histories'] == before_project['histories']
            assert whole_final['baselineId'] == before_project['baselineId']
            assert whole_final_bytes['assetBlobBytes'] == before_project_bytes['assetBlobBytes']
            assert whole_final_bytes['migrationBlobBytes'] == before_project_bytes['migrationBlobBytes']
            assert page.evaluate(READ_ORIGINALS, drawing_ids) == camera_originals, 'Manual photo synchronization altered camera originals'
            acknowledgements = {request['assetId'] for request in cloud.photo_requests[ack_start:]
                if request['device'] == device and request['path'].endswith('/rpc/sentlog_ack_photo')}
            assert acknowledgements == {row['assetId'] for row in before_project_bytes['assets']}, acknowledgements
            server_after = cloud.backend.admin(op='state', ownerId=owner, projectId=project_id)
            assert server_after['heads'][0]['last_seq'] == server_before['heads'][0]['last_seq']
            assert server_after['counts']['events'] == server_before['counts']['events'], 'A pure cache restore appended server events'
            assert sorted(json.dumps(row, sort_keys=True) for row in server_after['recordStates']) == sorted(
                json.dumps(row, sort_keys=True) for row in server_before['recordStates']), 'PC restoration rewrote server record/metadata state'
            assert [operation['action'] for operation in pc.operations] == ['verify', 'restore', 'verify', 'restore']
            assert [operation['mode'] for operation in pc.operations] == ['files', 'files', 'project', 'project']
            pc.verify(pc.job)
            print('PASS built whole-project PC restoration and manual sync preserve all record/metadata history, keep outbox/server events unchanged, and re-ACK restored photo bytes', flush=True)
        finally:
            try:
                diagnostics['message'] = page.locator('.sl-capacity-dialog .sl-capacity-message').all_text_contents()
            except Exception:
                pass
            print('DELTA_CAPACITY_UI', json.dumps({'operations': pc.operations, 'downloads': pc.downloads, **diagnostics}, ensure_ascii=False), flush=True)
            pc.close()

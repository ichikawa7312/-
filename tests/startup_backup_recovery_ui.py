"""Native, synthetic startup recovery through the standalone 375px UI.

Each case gets a new temporary browser profile and a loopback-only server.
No real backup/account/profile is read. Quota faults are isolated request faults
in actual native IndexedDB transactions, not a claim to reproduce disk pressure.
Usage: python tests/startup_backup_recovery_ui.py --engine chromium --built-root .
Missing native browser dependencies are BLOCKED (nonzero), never a fake pass.
"""
import argparse
import base64
import functools
import hashlib
import json
import sys
import tempfile
import threading
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = '/__startup_backup_fixture__.html'
DB = 'surveyFieldNoteDB'
FILES = 'files'
JOURNAL = 'sentlog_delta_journal_v1'
CONTROL = 'sentlog_delta_control_v1'
META = '__sentlog_records_meta_v130__'
ARCHIVE = '__sentlog_records_archive_v130__'
INTENT = 'startup-backup-recovery:v1'
PREFIX = '__sentlog_record__:'
WS = 'surveyFieldNoteWorkspaceV1'
MARKER = 'sentlogRecordsReadyV130'


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == FIXTURE:
            body = (b'<!doctype html><meta charset="utf-8"><title>Isolated startup backup fixture</title>'
                    b'<script src="/sentlog/record-store.js"></script>')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
        else:
            super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *_args):
        pass


SEED = r"""async scenario=>{
  localStorage.setItem('sentlogRecordsReadyV130','1');
  localStorage.setItem('SYNTHETIC_unrelated_setting','SYNTHETIC_preserve');
  const q=indexedDB.open('surveyFieldNoteDB',2);
  q.onupgradeneeded=()=>{
    q.result.createObjectStore('files');
    for(const name of ['sentlog_delta_journal_v1','sentlog_delta_control_v1'])
      q.result.createObjectStore(name).createIndex('kind','kind');
    if(scenario==='unknown-schema')q.result.createObjectStore('SYNTHETIC_unknown');
  };
  const db=await new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{
    if(['residual-file','residual-journal','residual-control','residual-null-meta'].includes(scenario)){
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(['files','sentlog_delta_journal_v1','sentlog_delta_control_v1'],'readwrite');
        if(scenario==='residual-file')tx.objectStore('files').add(new Blob(['SYNTHETIC existing bytes'],{type:'image/png'}),'photo:SYNTHETIC:existing');
        if(scenario==='residual-null-meta')tx.objectStore('files').add(null,'__sentlog_records_meta_v130__');
        if(scenario==='residual-journal')tx.objectStore('sentlog_delta_journal_v1').add({kind:'SYNTHETIC retained',bytes:new Blob(['SYNTHETIC journal bytes'])},1);
        if(scenario==='residual-control')tx.objectStore('sentlog_delta_control_v1').add(undefined,'SYNTHETIC retained');
        tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
      });
    }
  }finally{db.close();}
  if(scenario==='legacy')localStorage.setItem('surveyFieldNoteDrawingV1:SYNTHETIC','null');
  if(scenario==='other-database'||scenario==='unknown-database'){
    const name=scenario==='other-database'?'sentlogSyncTrafficV1':'other-application-synthetic';
    const q=indexedDB.open(name,1);q.onupgradeneeded=()=>q.result.createObjectStore('acks');
    const db=await new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try{await new Promise((resolve,reject)=>{const tx=db.transaction('acks','readwrite');
      tx.objectStore('acks').add({kind:'SYNTHETIC receipt',bytes:new Blob(['SYNTHETIC other bytes'])},'SYNTHETIC');
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
}"""

INSTRUMENT = r"""(()=>{
  if(!location.pathname.endsWith('/storage-restore.html'))return;
  const state=window.__startupRecoveryTest={adds:[],opens:[],forbidden:[],csp:[],fault:null,fired:0};
  window.addEventListener('securitypolicyviolation',event=>state.csp.push({directive:event.violatedDirective,blocked:event.blockedURI}));
  const nativeAdd=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(value,key){
    if(this.transaction.db.name==='surveyFieldNoteDB'){
      const type=key==='__sentlog_records_meta_v130__'?'META':key==='__sentlog_records_archive_v130__'?'ARCHIVE':
        key==='startup-backup-recovery:v1'?'INTENT':String(key).startsWith('photo:')?'PHOTO':
          String(key).startsWith('background:')?'DRAWING':'RECORD';
      state.adds.push({store:this.name,type});
      if((state.fault==='stage-quota'&&type==='PHOTO')||(state.fault==='final-quota'&&type==='META')){
        state.fired++;throw new DOMException('Synthetic isolated quota fault','QuotaExceededError');
      }
    }
    return nativeAdd.apply(this,arguments);
  };
  for(const method of ['put','delete','clear']){
    IDBObjectStore.prototype[method]=function(){state.forbidden.push('IDB.'+method);throw Error('Recovery attempted forbidden '+method);};
  }
  for(const method of ['setItem','removeItem','clear']){
    Storage.prototype[method]=function(){state.forbidden.push('Storage.'+method);throw Error('Recovery attempted storage mutation');};
  }
  const nativeOpen=IDBFactory.prototype.open;
  IDBFactory.prototype.open=function(name,...args){
    state.opens.push(name);
    const q=nativeOpen.call(this,name,...args);
    q.addEventListener('upgradeneeded',()=>state.forbidden.push('schema-upgrade'));
    return q;
  };
  IDBFactory.prototype.deleteDatabase=function(){state.forbidden.push('deleteDatabase');throw Error('Recovery attempted database deletion');};
})()"""

SNAPSHOT = r"""async()=>{
  const read=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  async function normalize(value){
    if(value===undefined)return {kind:'undefined'};
    if(value instanceof Blob)return {kind:value instanceof File?'File':'Blob',size:value.size,type:value.type,
      name:typeof value.name==='string'?value.name:null,lastModified:Number.isFinite(value.lastModified)?value.lastModified:null,
      sha256:await hash(await value.arrayBuffer())};
    if(Array.isArray(value))return Promise.all(value.map(normalize));
    if(value&&typeof value==='object'){const out={};for(const key of Object.keys(value).sort())out[key]=await normalize(value[key]);return out;}
    return value;
  }
  const databases=[];
  for(const item of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
    const db=await read(indexedDB.open(item.name));
    try{
      const stores=await new Promise((resolve,reject)=>{
        const tx=db.transaction(Array.from(db.objectStoreNames),'readonly'),rows=[];
        for(const name of db.objectStoreNames){const s=tx.objectStore(name),row={name,keyPath:s.keyPath,autoIncrement:s.autoIncrement,
          indexes:Array.from(s.indexNames).map(n=>{const i=s.index(n);return {name:n,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry};})};rows.push(row);
          s.getAllKeys().onsuccess=e=>row.keys=e.target.result;s.getAll().onsuccess=e=>row.values=e.target.result;
        }
        tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error);
      });
      for(const row of stores)row.values=await normalize(row.values);
      databases.push({name:db.name,version:db.version,stores});
    }finally{db.close();}
  }
  const local=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);local.push([key,localStorage.getItem(key)]);}
  local.sort((a,b)=>a[0].localeCompare(b[0]));return {databases,local};
}"""

GUARD = r"""async()=>{
  let result;
  try{await SentlogRecords.init();result={accepted:true,ready:SentlogRecords.ready,
    workspace:SentlogRecords.getItem('surveyFieldNoteWorkspaceV1')};}
  catch(error){result={accepted:false,ready:SentlogRecords.ready,message:error.message};}
  return result;
}"""

RECT = r"""element=>{
  const r=element.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
  return {width:r.width,height:r.height,x:r.left,y:r.top,visible:x>=0&&x<innerWidth&&y>=0&&y<innerHeight,
    receivesPointer:hit===element||element.contains(hit),viewportWidth:innerWidth};
}"""


def make_backup(large=False):
    pdf = b'%PDF-1.7\nSYNTHETIC drawing bytes\n' + (b'SYNTHETIC\n' * 240_000 if large else b'')
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=')
    drawing = {'id': 'SYNTHETIC_drawing', 'name': 'Synthetic drawing', 'sourceType': 'pdf', 'fileName': 'synthetic.pdf', 'pageCount': 1}
    missing = {'id': 'SYNTHETIC_missing_drawing', 'name': 'Synthetic missing image', 'sourceType': 'image', 'fileName': 'missing.png', 'pageCount': 1}
    pack = {'format': 'sentlog-backup', 'version': 1, 'exportedAt': '2026-01-01T00:00:00.000Z',
            'workspace': {'projects': [{'id': 'SYNTHETIC_project', 'name': 'Synthetic project', 'updatedAt': 100, 'drawings': [drawing, missing]}]},
            'drawingStates': {
                drawing['id']: {'sourceType': 'pdf', 'fileName': 'synthetic.pdf', 'shapes': [
                    {'id': 'SYNTHETIC_record', 'memo': 'Synthetic latest memo 日本語', 'photos': [
                        {'id': 'SYNTHETIC_photo', 'size': len(png), 'type': 'image/png', 'sha256': hashlib.sha256(png).hexdigest()},
                        {'id': 'SYNTHETIC_missing_photo', 'size': 7, 'type': 'image/jpeg'}]}], 'collabDeletedRecords': []},
                missing['id']: {'sourceType': 'image', 'fileName': 'missing.png', 'shapes': []}},
            'files': [
                {'key': 'background:' + drawing['id'], 'name': 'synthetic.pdf', 'type': 'application/pdf', 'lastModified': 1234,
                 'data': 'data:application/pdf;base64,' + base64.b64encode(pdf).decode()},
                {'key': 'photo:' + drawing['id'] + ':SYNTHETIC_photo', 'name': 'synthetic.png', 'type': 'image/png', 'lastModified': 5678,
                 'data': 'data:image/png;base64,' + base64.b64encode(png).decode()}]}
    return pack


def file_payload(pack):
    return {'name': 'synthetic-backup.sentlog.json', 'mimeType': 'application/json',
            'buffer': json.dumps(pack, ensure_ascii=False).encode('utf-8')}


def stores(snapshot):
    db = next(d for d in snapshot['databases'] if d['name'] == DB)
    return {s['name']: dict(zip(s['keys'], s['values'])) for s in db['stores']}


def verify_pack(snapshot, pack, complete):
    data = stores(snapshot)
    assert data[JOURNAL] == {}
    assert list(data[CONTROL]) == [INTENT]
    assert (META in data[FILES]) == complete
    expected = {PREFIX + WS: json.dumps(pack['workspace'], ensure_ascii=False, separators=(',', ':'))}
    for key, state in pack['drawingStates'].items():
        expected[PREFIX + 'surveyFieldNoteDrawingV1:' + key] = json.dumps(state, ensure_ascii=False, separators=(',', ':'))
    for project in pack['workspace']['projects']:
        expected[PREFIX + 'sentlogCloudProjectSyncV2:' + project['id']] = json.dumps(
            {'revision': 0, 'restored_backup': True, 'local_updated_at': project.get('updatedAt', 0)}, separators=(',', ':'))
    for key, value in expected.items():
        assert data[FILES][key] == value
    for f in pack['files']:
        body = base64.b64decode(f['data'].split(',', 1)[1])
        assert data[FILES][f['key']] == {'kind': 'File', 'size': len(body), 'type': f['type'], 'name': f['name'],
                                       'lastModified': f['lastModified'], 'sha256': hashlib.sha256(body).hexdigest()}
    allowed = set(expected) | {f['key'] for f in pack['files']} | {ARCHIVE} | ({META} if complete else set())
    assert set(data[FILES]) == allowed
    intent = data[CONTROL][INTENT]
    assert intent['backupSha256'] == hashlib.sha256(file_payload(pack)['buffer']).hexdigest()
    assert intent['recordCount'] == len(expected) and intent['fileCount'] == len(pack['files'])
    assert data[FILES][ARCHIVE] == {'entries': [], 'migratedAt': intent['startedAt']}
    if complete:
        assert data[FILES][META]['schema'] == 1 and data[FILES][META]['revision'] == 0
        assert data[FILES][META]['startupRecovery']['backupSha256'] == intent['backupSha256']


def wait_idle(page):
    page.wait_for_function("!document.getElementById('recoveryFile').disabled", timeout=70_000)


def check_file(page, pack):
    page.locator('#recoveryFile').set_input_files(file_payload(pack))
    page.locator('#recoveryCheck').click()
    wait_idle(page)


def restore_click(page, wait=True):
    page.locator('#recoveryTabsClosed').check()
    page.locator('#recoveryUnderstood').check()
    target = page.locator('#recoveryRestore')
    assert target.is_enabled()
    target.scroll_into_view_if_needed()
    rect = target.evaluate(RECT)
    assert rect['viewportWidth'] == 375 and rect['width'] >= 250 and rect['height'] >= 44
    assert rect['visible'] and rect['receivesPointer']
    target.tap()
    if wait:
        wait_idle(page)
    return rect


def close_with_evidence(close, cleanup_errors, operation):
    original = sys.exc_info()[1]
    try:
        close()
    except Exception as error:
        cleanup_errors.append({'operation': operation, 'error': str(error)})
        if original is None:
            raise


def guard_probe(context, base, cleanup_errors):
    page = context.new_page()
    try:
        page.goto(base + FIXTURE)
        return page.evaluate(GUARD)
    finally:
        close_with_evidence(page.close, cleanup_errors, 'guard page close')


def run_case(browser_type, base, port, scenario, cleanup_errors):
    external, errors = [], []
    with tempfile.TemporaryDirectory(prefix='sentlog-startup-recovery-native-') as profile:
        context = browser_type.launch_persistent_context(profile, headless=True, viewport={'width': 375, 'height': 667},
                                                         has_touch=True, accept_downloads=False)
        try:
            def route(request):
                url = urlparse(request.request.url)
                if url.hostname == '127.0.0.1' and url.port == port and url.scheme == 'http':
                    request.continue_()
                else:
                    external.append({'scheme': url.scheme, 'host': url.hostname})
                    request.abort()
            context.route('**/*', route)
            context.add_init_script(INSTRUMENT)
            page = context.pages[0] if context.pages else context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + FIXTURE)
            page.evaluate(SEED, scenario)
            before = page.evaluate(SNAPSHOT)
            page.goto(base + '/sentlog/storage-restore.html')
            assert page.locator('#recoveryOpen').is_hidden()
            assert page.evaluate("typeof SentlogRecords==='undefined' && typeof sentlogAppReady==='undefined'")
            pack = make_backup(large=scenario == 'success')
            check_file(page, pack)
            rejected = {'residual-file': 'OTHER_BACKUP', 'residual-null-meta': 'OTHER_BACKUP', 'residual-journal': 'OTHER_BACKUP',
                        'residual-control': 'OTHER_BACKUP', 'legacy': 'LEGACY_PRESENT', 'other-database': 'OTHER_DATA', 'unknown-schema': 'SCHEMA',
                        'unknown-database': 'OTHER_DATABASE'}
            result = {'case': scenario}
            if scenario in rejected:
                assert page.locator('#recoveryStatus').get_attribute('data-code') == rejected[scenario]
                assert page.locator('#recoveryRestore').is_disabled() and page.locator('#recoveryOpen').is_hidden()
                if scenario == 'unknown-database':
                    assert 'other-application-synthetic' not in page.evaluate('window.__startupRecoveryTest.opens')
                assert page.evaluate(SNAPSHOT) == before
                result['rejectionUnchanged'] = True
            else:
                assert page.locator('#recoveryStatus').get_attribute('data-code') is None
                missing = page.locator('#recoverySummary dt').filter(has_text='参照があるが控えにない添付')
                assert missing.locator('xpath=following-sibling::dd[1]').inner_text() == '2件'
                assert page.locator('#recoveryRestore').is_disabled()
                if scenario in ('stage-quota', 'final-quota'):
                    page.evaluate('mode=>{window.__startupRecoveryTest.fault=mode}', scenario)
                if scenario == 'cancel-hash':
                    page.evaluate(r"""()=>{
                      const native=Blob.prototype.arrayBuffer;window.__heldRead=false;
                      Blob.prototype.arrayBuffer=function(){
                        if(!window.__heldRead){window.__heldRead=true;const value=this;
                          return new Promise((resolve,reject)=>{window.__releaseRead=()=>native.call(value).then(resolve,reject);});}
                        return native.apply(this,arguments);
                      };
                      window.__restoreBlobRead=()=>{Blob.prototype.arrayBuffer=native;window.__releaseRead?.();};
                    }""")
                    result['button'] = restore_click(page, wait=False)
                    page.wait_for_function('window.__heldRead===true', timeout=15_000)
                    page.locator('#recoveryCancel').tap()
                    wait_idle(page)
                    page.evaluate('window.__restoreBlobRead()')
                    assert page.locator('#recoveryStatus').get_attribute('data-code') == 'CANCELLED'
                    staged = page.evaluate(SNAPSHOT)
                    verify_pack(staged, pack, complete=False)
                    assert staged['local'] == before['local'] and page.locator('#recoveryOpen').is_hidden()
                    assert not guard_probe(context, base, cleanup_errors)['ready']
                    result['cancelledDuringNativeBlobRead'] = True
                elif scenario == 'lock-held':
                    holder = context.new_page()
                    holder.goto(base + FIXTURE)
                    holder.evaluate("""async()=>{
                      window.__lockReady=new Promise(resolve=>navigator.locks.request('sentlog-record-writer-v130',async()=>{
                        resolve();await new Promise(release=>{window.__releaseWriter=release;});}));await window.__lockReady;
                    }""")
                    result['button'] = restore_click(page)
                    assert page.locator('#recoveryStatus').get_attribute('data-code') == 'LOCK_UNAVAILABLE'
                    assert page.evaluate(SNAPSHOT) == before and page.locator('#recoveryOpen').is_hidden()
                    holder.close()
                else:
                    result['button'] = restore_click(page)
                    state = page.evaluate('window.__startupRecoveryTest')
                    after = page.evaluate(SNAPSHOT)
                    assert after['local'] == before['local']
                    if scenario == 'stage-quota':
                        assert state['fired'] == 1 and after == before
                        assert 'QuotaExceededError' in page.locator('#recoveryStatus').inner_text()
                        assert page.locator('#recoveryOpen').is_hidden()
                        result['atomicRollback'] = True
                    elif scenario == 'final-quota':
                        assert state['fired'] == 1 and page.locator('#recoveryOpen').is_hidden()
                        verify_pack(after, pack, complete=False)
                        stopped = guard_probe(context, base, cleanup_errors)
                        assert not stopped['accepted'] and not stopped['ready']
                        assert page.evaluate(SNAPSHOT) == after
                        # Reload removes this isolated fault; recovery's intent and
                        # all bytes remain. A different backup is rejected first.
                        page.reload()
                        changed = json.loads(json.dumps(pack))
                        changed['drawingStates']['SYNTHETIC_drawing']['shapes'][0]['memo'] = 'Synthetic other backup'
                        check_file(page, changed)
                        assert page.locator('#recoveryStatus').get_attribute('data-code') == 'OTHER_BACKUP'
                        assert page.evaluate(SNAPSHOT) == after
                        check_file(page, pack)
                        result['resumeButton'] = restore_click(page)
                        final = page.evaluate(SNAPSHOT)
                        verify_pack(final, pack, complete=True)
                        assert page.evaluate('window.__startupRecoveryTest.adds') == [{'store': 'files', 'type': 'META'}]
                        assert not page.locator('#recoveryOpen').is_hidden()
                        assert guard_probe(context, base, cleanup_errors)['ready']
                        result['stageGuardAndResume'] = True
                    else:
                        verify_pack(after, pack, complete=True)
                        assert not page.locator('#recoveryOpen').is_hidden()
                        assert page.locator('#recoveryOpen').get_attribute('href') == './'
                        assert page.url.endswith('/sentlog/storage-restore.html'), 'Recovery must not navigate automatically'
                        probe = guard_probe(context, base, cleanup_errors)
                        assert probe['accepted'] and probe['ready']
                        assert json.loads(probe['workspace']) == pack['workspace']
                        # A completed backup recheck must perform no additional adds.
                        page.reload()
                        check_file(page, pack)
                        restore_click(page)
                        assert page.evaluate('window.__startupRecoveryTest.adds') == []
                        assert page.evaluate(SNAPSHOT) == after
                        result['fullReadbackAndReadOnlyRecheck'] = True
            state = page.evaluate('window.__startupRecoveryTest')
            assert not state['forbidden'] and not state['csp'] and not errors and not external
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
            result.update({'status': 'PASS', 'externalRequests': 0, 'forbiddenWrites': 0, 'cspViolations': 0})
            return result
        finally:
            close_with_evidence(context.close, cleanup_errors, 'browser context close')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    report = {'engine': args.engine, 'status': 'RUNNING', 'cases': [], 'cleanupErrors': []}
    server = None
    try:
        from playwright.sync_api import sync_playwright
        required = ['sentlog/storage-restore.html', 'sentlog/startup-backup-recovery.js', 'sentlog/backup-format.js', 'sentlog/record-store.js']
        if any(not (args.built_root / p).is_file() for p in required):
            raise RuntimeError('Required recovery/build resources are missing')
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(args.built_root.resolve())))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        scenarios = ('success', 'stage-quota', 'final-quota', 'cancel-hash', 'lock-held', 'residual-file', 'residual-null-meta',
                     'residual-journal', 'residual-control', 'legacy', 'other-database', 'unknown-schema', 'unknown-database')
        with sync_playwright() as playwright:
            browser = getattr(playwright, args.engine)
            for scenario in scenarios:
                result = run_case(browser, base, server.server_port, scenario, report['cleanupErrors'])
                report['cases'].append(result)
                print('PASS ' + args.engine + ' ' + scenario, flush=True)
        report['status'] = 'PASS'
        print(f'PASS startup backup recovery native {args.engine}: {len(report["cases"])} cases', flush=True)
        return 0
    except Exception as error:
        report['status'] = 'BLOCKED' if not report['cases'] and any(s in str(error).lower() for s in (
            'no module named', 'executable doesn\'t exist', 'missing dependencies', 'host system is missing', 'cannot open shared object')) else 'FAIL'
        report['error'] = str(error)
        report['traceback'] = traceback.format_exc()
        print(report['status'] + ': ' + str(error), flush=True)
        return 2 if report['status'] == 'BLOCKED' else 1
    finally:
        if server:
            server.shutdown()
            server.server_close()
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    raise SystemExit(main())

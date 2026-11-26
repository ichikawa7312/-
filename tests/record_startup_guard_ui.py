"""Verify startup protection using disposable native IndexedDB profiles.

The actual assembled record store runs against synthetic data on loopback.
Rejected states are also opened through the real application loader. No account,
existing profile, remote service, or SQL fixture is used. Missing native browser
dependencies produce a nonzero BLOCKED result, not a passing substitute.

Usage: python tests/record_startup_guard_ui.py --engine chromium --built-root .
       --report /tmp/sentlog-delta-app-startup-guard/chromium.json
"""
import argparse
import functools
import json
import re
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = '/__record_startup_guard_fixture__.html'
DB = 'surveyFieldNoteDB'
FILES = 'files'
JOURNAL = 'sentlog_delta_journal_v1'
CONTROL = 'sentlog_delta_control_v1'
META = '__sentlog_records_meta_v130__'
ARCHIVE = '__sentlog_records_archive_v130__'
PREFIX = '__sentlog_record__:'
WS = 'surveyFieldNoteWorkspaceV1'
DRAW = 'surveyFieldNoteDrawingV1:GUARD_PRIVATE_drawing'
MARKER = 'sentlogRecordsReadyV130'
REJECTED_CASES = (
    'meta-workspace-missing', 'meta-workspace-null', 'meta-workspace-invalid-projects',
    'missing-meta-retained-workspace', 'missing-meta-retained-drawing',
    'missing-meta-retained-archive', 'missing-meta-retained-journal',
    'missing-meta-retained-control', 'missing-meta-legacy-durable-collision',
    'missing-meta-legacy-with-migration-marker',
)
ACCEPTED_CASES = ('empty-first-start', 'valid-pre-v130-migration', 'normal-valid-start')


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == FIXTURE:
            body = b'<!doctype html><meta charset="utf-8"><title>Isolated startup fixture</title>'
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


# Snapshot reads and Blob hashing belong to the fixture, outside init(). Native
# transactions finish before asynchronous hashing, and every opened DB closes.
FIXTURE_HELPERS = r"""(() => {
  const DB='surveyFieldNoteDB',FILES='files',JOURNAL='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
  const META='__sentlog_records_meta_v130__',ARCHIVE='__sentlog_records_archive_v130__',PREFIX='__sentlog_record__:';
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:GUARD_PRIVATE_drawing',MARKER='sentlogRecordsReadyV130';
  const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const completed=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Synthetic transaction aborted'));tx.onerror=()=>{};});
  async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
  async function normalized(value){
    if(value===undefined)return {kind:'undefined'};
    if(value instanceof Blob)return {kind:value instanceof File?'File':'Blob',size:value.size,type:value.type,
      name:value instanceof File?value.name:null,lastModified:value instanceof File?value.lastModified:null,
      sha256:await digest(await value.arrayBuffer())};
    if(value instanceof ArrayBuffer)return {kind:'ArrayBuffer',size:value.byteLength,sha256:await digest(value)};
    if(ArrayBuffer.isView(value))return {kind:value.constructor.name,size:value.byteLength,
      sha256:await digest(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength))};
    if(value instanceof Date)return {kind:'Date',value:value.toISOString()};
    if(Array.isArray(value))return Promise.all(value.map(normalized));
    if(value&&typeof value==='object'){
      const out={};for(const key of Object.keys(value).sort())out[key]=await normalized(value[key]);return out;
    }
    return value;
  }
  async function create(version,rows){
    const q=indexedDB.open(DB,version);
    q.onupgradeneeded=()=>{
      q.result.createObjectStore(FILES);
      if(version===2)for(const name of [JOURNAL,CONTROL])q.result.createObjectStore(name).createIndex('kind','kind');
    };
    const db=await request(q);
    try{
      const tx=db.transaction(Array.from(db.objectStoreNames),'readwrite'),done=completed(tx);
      for(const [name,values] of Object.entries(rows))for(const [key,value] of values)tx.objectStore(name).put(value,key);
      await done;
    }finally{db.close();}
  }
  async function seed(name){
    const drawing={id:'GUARD_PRIVATE_drawing',name:'GUARD_PRIVATE_plan',fileName:'GUARD_PRIVATE_plan.pdf',sourceType:'pdf',pageCount:1};
    const workspace=JSON.stringify({projects:[{id:'GUARD_PRIVATE_project',name:'GUARD_PRIVATE_durable',drawings:[drawing]}]});
    const state=JSON.stringify({fileName:drawing.fileName,sourceType:'pdf',pageCount:1,currentPage:1,
      shapes:[{id:'GUARD_PRIVATE_record',memo:'GUARD_PRIVATE_durable_memo',photos:[{id:'GUARD_PRIVATE_photo'}]}]});
    const legacyWorkspace=JSON.stringify({projects:[{id:'GUARD_PRIVATE_project',name:'GUARD_PRIVATE_legacy',drawings:[drawing]}]});
    const legacyDrawing=JSON.stringify({fileName:drawing.fileName,sourceType:'pdf',pageCount:1,currentPage:1,
      shapes:[{id:'GUARD_PRIVATE_record',memo:'GUARD_PRIVATE_legacy_memo',photos:[{id:'GUARD_PRIVATE_photo'}]}]});
    const legacy=[[WS,legacyWorkspace],[DRAW,legacyDrawing]];
    const meta={schema:1,revision:7,migratedAt:'2026-01-01T00:00:00.000Z',legacyCount:0};
    const background=new Blob([new Uint8Array([37,80,68,70,45,49,46,55,10,1,2,3])],{type:'application/pdf'});
    const photo=new Blob([new Uint8Array([255,216,255,224,0,17,42,255,217])],{type:'image/jpeg'});
    const fileRows=[['background',background],['background:GUARD_PRIVATE_drawing',background],
      ['photo:GUARD_PRIVATE_drawing:GUARD_PRIVATE_photo',photo]];
    const rows={[FILES]:fileRows.slice(),[JOURNAL]:[],[CONTROL]:[]};
    let version=2,legacyEntries=[];
    if(name==='empty-first-start')return {legacy:[],fileKeys:[],workspace:null,drawing:null};
    localStorage.setItem('GUARD_PRIVATE_unrelated','GUARD_PRIVATE_preserved');
    if(name.startsWith('meta-workspace-')){
      rows[FILES].push([META,meta],[PREFIX+DRAW,state],[ARCHIVE,{entries:[]}]);
      localStorage.setItem(MARKER,'1');
      if(name==='meta-workspace-null')rows[FILES].push([PREFIX+WS,'null']);
      else if(name==='meta-workspace-invalid-projects')rows[FILES].push([PREFIX+WS,JSON.stringify({projects:{}})]);
      else if(name!=='meta-workspace-missing')throw Error('Unknown synthetic workspace case');
    }else if(name==='missing-meta-retained-workspace')rows[FILES].push([PREFIX+WS,workspace]);
    else if(name==='missing-meta-retained-drawing')rows[FILES].push([PREFIX+DRAW,state]);
    else if(name==='missing-meta-retained-archive')rows[FILES].push([ARCHIVE,{entries:[[WS,workspace],[DRAW,state]]}]);
    else if(name==='missing-meta-retained-journal')rows[JOURNAL].push([1,{kind:'GUARD_PRIVATE_pending',before:photo,after:new Blob(['GUARD_PRIVATE_pending_bytes'])}]);
    else if(name==='missing-meta-retained-control')rows[CONTROL].push(['GUARD_PRIVATE_control',{kind:'GUARD_PRIVATE_retained',value:background,sequence:9}]);
    else if(name==='missing-meta-legacy-durable-collision'){
      rows[FILES].push([PREFIX+WS,workspace],[PREFIX+DRAW,state]);legacyEntries=legacy;
    }else if(name==='missing-meta-legacy-with-migration-marker'){
      legacyEntries=legacy;localStorage.setItem(MARKER,'1');
    }else if(name==='valid-pre-v130-migration'){
      version=1;delete rows[JOURNAL];delete rows[CONTROL];legacyEntries=legacy;
    }else if(name==='normal-valid-start'){
      rows[FILES].push([META,meta],[PREFIX+WS,workspace],[PREFIX+DRAW,state],[ARCHIVE,{entries:[]}]);
      localStorage.setItem(MARKER,'1');
    }else throw Error('Unknown synthetic startup case');
    for(const [key,value] of legacyEntries)localStorage.setItem(key,value);
    await create(version,rows);
    return {legacy:legacyEntries,fileKeys:fileRows.map(([key])=>key),
      workspace:name==='valid-pre-v130-migration'?legacyWorkspace:workspace,
      drawing:name==='valid-pre-v130-migration'?legacyDrawing:state};
  }
  async function snapshot(){
    const databases=[];
    for(const entry of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
      const q=indexedDB.open(entry.name);q.onupgradeneeded=()=>q.transaction.abort();
      const db=await request(q);
      try{
        const stores=[];
        for(const name of Array.from(db.objectStoreNames)){
          const tx=db.transaction(name,'readonly'),done=completed(tx),store=tx.objectStore(name),rows=[];
          const descriptor={name,keyPath:store.keyPath,autoIncrement:store.autoIncrement,
            indexes:Array.from(store.indexNames).map(key=>{const index=store.index(key);
              return {name:key,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};})};
          const q=store.openCursor();q.onsuccess=()=>{const cursor=q.result;if(cursor){rows.push([cursor.primaryKey,cursor.value]);cursor.continue();}};
          await done;stores.push({...descriptor,rows:await normalized(rows)});
        }
        databases.push({name:db.name,version:db.version,stores});
      }finally{db.close();}
    }
    const local=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);local.push([key,localStorage.getItem(key)]);}
    local.sort((a,b)=>a[0].localeCompare(b[0]));return {databases,local};
  }
  window.__startupGuardFixture={seed,snapshot};
})();"""

START_INIT = r"""() => {
  window.__startupGuardOutcome=null;
  window.__startupGuardFlight=(async()=>{
    const records=window.SentlogRecords;
    try{
      await records.init();await records.settled();records.assertSafe();
      window.__startupGuardOutcome={resolved:true,ready:records.ready,version:records.startupProtectionVersion,
        workspace:records.getItem('surveyFieldNoteWorkspaceV1'),
        drawing:records.getItem('surveyFieldNoteDrawingV1:GUARD_PRIVATE_drawing')};
    }catch(error){
      window.__startupGuardOutcome={resolved:false,ready:records?.ready===true,version:records?.startupProtectionVersion,
        errorName:['Error','AbortError','InvalidStateError','ConstraintError'].includes(error?.name)?error.name:'OtherError',
        message:typeof error?.message==='string'?error.message:''};
    }
  })();
}"""


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def safe_failure(error, operation):
    first = next((line.strip() for line in str(error).splitlines() if line.strip()), 'No error message')
    first = first.split('Call log:', 1)[0].split('Browser logs:', 1)[0]
    first = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', first)
    first = re.sub(r'\b(?:https?|wss?|blob|data|file):[^\s<>"\']+', '[URL]', first, flags=re.IGNORECASE)
    first = re.sub(r'GUARD_PRIVATE_[^\s<>"\']*', '[synthetic value]', first)
    first = re.sub(r'<[^>]*(?:>|$)', '[DOM]', first)
    first = re.sub(r'[\x00-\x1f\x7f]', ' ', first).strip()
    name = type(error).__name__
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', name):
        name = 'Error'
    return dict(operation=operation, failureType=name, reason=first[:280] or 'No error message')


def stores(snapshot):
    check(len(snapshot['databases']) == 1 and snapshot['databases'][0]['name'] == DB,
          'Startup created or removed an unexpected database')
    return {row['name']: row for row in snapshot['databases'][0]['stores']}


def check_schema(snapshot):
    data = stores(snapshot)
    check(snapshot['databases'][0]['version'] == 2 and set(data) == {FILES, JOURNAL, CONTROL},
          'Startup did not retain the expected database version and three stores')
    for name, store in data.items():
        expected = [] if name == FILES else [dict(name='kind', keyPath='kind', unique=False, multiEntry=False)]
        check(store['keyPath'] is None and store['autoIncrement'] is False and store['indexes'] == expected,
              'Startup altered an object store or index schema')
    return data


def verify_fixture(name, snapshot, expected):
    if name == 'empty-first-start':
        check(snapshot == dict(databases=[], local=[]), 'The first-start fixture was not empty')
        return
    data = stores(snapshot)
    if name != 'valid-pre-v130-migration':
        check_schema(snapshot)
    rows, local = dict(data[FILES]['rows']), dict(snapshot['local'])
    check(all(rows[key]['kind'] == 'Blob' and rows[key]['size'] > 0 and len(rows[key]['sha256']) == 64
              for key in expected['fileKeys']), 'Synthetic native Blob fixtures were not persisted and hashed')
    metadata = set(rows) - set(expected['fileKeys'])
    if name.startswith('meta-workspace-'):
        wanted = {META, ARCHIVE, PREFIX + DRAW} | ({PREFIX + WS} if name != 'meta-workspace-missing' else set())
        check(metadata == wanted and rows[META]['schema'] == 1, 'Invalid-workspace fixture has another metadata defect')
        if name == 'meta-workspace-null':
            check(json.loads(rows[PREFIX + WS]) is None, 'Workspace-null fixture is not valid JSON null')
        elif name == 'meta-workspace-invalid-projects':
            check(json.loads(rows[PREFIX + WS]) == {'projects': {}}, 'Invalid-projects fixture has a different shape')
    else:
        wanted = {'missing-meta-retained-workspace': {PREFIX + WS}, 'missing-meta-retained-drawing': {PREFIX + DRAW},
            'missing-meta-retained-archive': {ARCHIVE}, 'missing-meta-legacy-durable-collision': {PREFIX + WS, PREFIX + DRAW},
            'normal-valid-start': {META, ARCHIVE, PREFIX + WS, PREFIX + DRAW}}.get(name, set())
        check(metadata == wanted, 'Fixture contains unexpected durable metadata')
    if name != 'valid-pre-v130-migration':
        check(len(data[JOURNAL]['rows']) == int(name == 'missing-meta-retained-journal')
              and len(data[CONTROL]['rows']) == int(name == 'missing-meta-retained-control'),
              'Retained journal/control cases were not isolated')
    marked = name.startswith('meta-workspace-') or name in ('normal-valid-start', 'missing-meta-legacy-with-migration-marker')
    check((MARKER in local) == marked, 'Fixture migration-marker presence differs')
    check(all(local[key] == value for key, value in expected['legacy']), 'Fixture legacy values differ')


def verify_accepted(name, before, after, expected, outcome):
    check(outcome['resolved'] and outcome['ready'], 'A valid startup was refused')
    data = check_schema(after)
    rows = dict(data[FILES]['rows'])
    if name == 'normal-valid-start':
        check(after == before, 'Normal startup changed existing records, schema, Blob hashes, or localStorage')
        check(outcome['workspace'] == expected['workspace'] and outcome['drawing'] == expected['drawing'],
              'Normal startup did not expose the existing durable records')
        return
    check(not data[JOURNAL]['rows'] and not data[CONTROL]['rows'], 'First migration created unrelated journal/control rows')
    meta, archive = rows[META], rows[ARCHIVE]
    check(meta['schema'] == 1 and meta['revision'] == 0 and meta['legacyCount'] == len(expected['legacy']),
          'Migration metadata does not match the actual legacy inputs')
    check(isinstance(meta['migratedAt'], str) and bool(meta['migratedAt']) and archive['migratedAt'] == meta['migratedAt'],
          'Migration did not retain a consistent completion record')
    check(len(archive['entries']) == len(expected['legacy']) and dict(archive['entries']) == dict(expected['legacy']),
          'Migration archive is not an exact copy of the legacy records')
    local = dict(before['local'])
    for key, value in expected['legacy']:
        check(rows[PREFIX + key] == value, 'Migration changed a legacy record value')
        del local[key]
    local[MARKER] = '1'
    check(dict(after['local']) == local, 'Migration removed or changed unrelated localStorage data')
    if name == 'empty-first-start':
        check(before == dict(databases=[], local=[]), 'The empty first-start case was not fresh')
        check(set(rows) == {META, ARCHIVE, PREFIX + WS} and json.loads(rows[PREFIX + WS]) == {'projects': []},
              'Empty first start did not create only the initial workspace metadata')
        check(json.loads(outcome['workspace']) == {'projects': []} and outcome['drawing'] is None,
              'Empty first start exposed unexpected records')
    else:
        original = stores(before)
        check(before['databases'][0]['version'] == 1 and set(original) == {FILES}, 'Legacy fixture was not a pre-v130 files-only database')
        check({k: v for k, v in original[FILES].items() if k != 'rows'} == {k: v for k, v in data[FILES].items() if k != 'rows'},
              'Migration changed the existing files store schema')
        old_rows = dict(original[FILES]['rows'])
        check(set(old_rows) == set(expected['fileKeys']), 'Legacy fixture file inventory differs')
        check(all(rows[key] == old_rows[key] for key in expected['fileKeys']), 'Migration changed native background/photo Blob bytes or metadata')
        check(set(rows) == set(old_rows) | {META, ARCHIVE, PREFIX + WS, PREFIX + DRAW}, 'Migration added or removed an unexpected file/record')
        check(outcome['workspace'] == expected['workspace'] and outcome['drawing'] == expected['drawing'],
              'Migration did not initialize the mirror from the preserved legacy records')


def run_case(browser, folder, origin, name, trace):
    trace['operation'] = 'browser.launch-isolated-profile'
    context = browser.launch_persistent_context(str(folder / name), headless=True,
        viewport={'width': 375, 'height': 812}, service_workers='block')
    primary_error = None
    unexpected_requests, page_errors, console_errors = [], [], []
    try:
        def route_request(route):
            parsed = urlparse(route.request.url)
            allowed = (f'{parsed.scheme}://{parsed.netloc}' == origin and route.request.method == 'GET'
                and (parsed.path in (FIXTURE, '/favicon.ico') or parsed.path.startswith('/sentlog/')))
            if allowed:
                route.continue_()
            else:
                unexpected_requests.append('blocked-request')
                route.abort()

        trace['operation'] = 'page.configure-isolated-fixture'
        context.route('**/*', route_request)
        context.add_init_script(FIXTURE_HELPERS)
        page = context.pages[0] if context.pages else context.new_page()
        page.set_default_timeout(15000)
        page.on('pageerror', lambda _error: page_errors.append('pageerror'))
        page.on('console', lambda message: console_errors.append('console-error') if message.type == 'error' else None)
        page.goto(origin + FIXTURE, wait_until='load')
        trace['operation'] = 'fixture.seed-native-database'
        expected = page.evaluate('(name) => __startupGuardFixture.seed(name)', name)
        trace['operation'] = 'snapshot.before-startup'
        before = page.evaluate('() => __startupGuardFixture.snapshot()')
        verify_fixture(name, before, expected)
        trace['operation'] = 'startup.load-actual-record-store'
        page.add_script_tag(url=origin + '/sentlog/record-store.js')
        trace['operation'] = 'startup.call-init'
        page.evaluate(START_INIT)
        page.wait_for_function('window.__startupGuardOutcome !== null')
        outcome = page.evaluate('window.__startupGuardOutcome')
        check(outcome.get('version') == 1, 'The executed record store lacks startupProtectionVersion:1')
        trace['operation'] = 'snapshot.after-startup'
        after = page.evaluate('() => __startupGuardFixture.snapshot()')
        rejected = name in REJECTED_CASES
        if rejected:
            trace['operation'] = 'startup.verify-rejection-and-preservation'
            check(not outcome['resolved'] and not outcome['ready'], 'Incomplete durable state was accepted as a ready application')
            check(after == before, 'Rejected initialization changed native records, Blob hashes, schema, or localStorage')
            check_schema(after)
            check(bool(outcome['message']), 'Rejected initialization did not provide a reason')
            trace['operation'] = 'app.open-real-startup-loader'
            page.goto(origin + '/sentlog/', wait_until='load')
            page.get_by_text('セントログを開始できませんでした', exact=True).wait_for(state='visible')
            trace['operation'] = 'app.verify-reason-and-diagnostic-link'
            page.get_by_text(outcome['message'], exact=True).wait_for(state='visible')
            link = page.get_by_role('link', name='保存領域の確認', exact=True)
            link.wait_for(state='visible')
            check(link.evaluate("element => element.href === location.origin + '/sentlog/storage-check.html'"),
                  'Startup failure did not link to the same-origin standalone diagnostic')
            check(page.evaluate('() => window.SentlogRecords?.startupProtectionVersion === 1 && !window.SentlogRecords.ready'),
                  'The real loader did not preserve the protected stopped state')
            trace['operation'] = 'snapshot.after-real-app-rejection'
            check(page.evaluate('() => __startupGuardFixture.snapshot()') == before,
                  'The real startup error page changed native records, Blob hashes, schema, or localStorage')
        else:
            trace['operation'] = 'startup.verify-valid-path'
            verify_accepted(name, before, after, expected, outcome)
        trace['operation'] = 'page.verify-network-and-errors'
        check(not unexpected_requests and not page_errors and not console_errors,
              'Startup emitted an unexpected network request or browser error')
        return dict(case=name, status='passed', startupRejected=rejected,
            nativePreservationVerified=True, appErrorAndDiagnosticLinkVerified=rejected,
            nativeBlobValuesChecked=len(expected['fileKeys']), startupProtectionVersion=outcome['version'])
    except Exception as error:
        primary_error = error
        trace['primaryFailure'] = safe_failure(error, trace['operation'])
        raise
    finally:
        trace['operation'] = 'browser.close-isolated-context'
        try:
            context.close()
        except Exception as error:
            trace['cleanupFailure'] = safe_failure(error, trace['operation'])
            if primary_error is None:
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    report = dict(suite='record-startup-guard-ui', engine=args.engine, status='running',
        isolatedSyntheticProfiles=True, physicalDeviceTest=False, cases=[])
    trace, stage, server = {'operation': 'runtime.import-playwright'}, 'dependencies', None
    result = 1
    try:
        from playwright.sync_api import sync_playwright
        stage = 'build-input'
        trace['operation'] = 'build.check-required-files'
        root = args.built_root.resolve()
        for name in ('record-store.js', 'index.html', 'storage-check.html'):
            check((root / 'sentlog' / name).is_file(), 'The assembled application is missing a required startup resource')
        stage = 'server'
        trace['operation'] = 'server.start-loopback'
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = 'http://127.0.0.1:' + str(server.server_port)
        trace['operation'] = 'runtime.start-playwright'
        with tempfile.TemporaryDirectory(prefix='sentlog-startup-guard-native-') as temporary, sync_playwright() as playwright:
            browser = getattr(playwright, args.engine)
            for name in REJECTED_CASES + ACCEPTED_CASES:
                stage, trace = name, {'operation': 'case.start'}
                report['cases'].append(run_case(browser, Path(temporary), origin, name, trace))
            trace['operation'] = 'runtime.close-playwright'
        report['status'], result = 'passed', 0
    except Exception as error:
        missing = stage == 'dependencies' or (not report['cases'] and not isinstance(error, AssertionError)
            and any(term in str(error).lower() for term in ("executable doesn't exist", 'host system is missing', 'browser was not found')))
        failure = trace.get('primaryFailure') or safe_failure(error, trace['operation'])
        report.update(status='blocked' if missing else 'failed', stage=stage, **failure)
        if trace.get('cleanupFailure'):
            report['cleanupFailure'] = trace['cleanupFailure']
        result = 2 if missing else 1
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        report['elapsedSeconds'] = time.monotonic() - started
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    return result


if __name__ == '__main__':
    sys.exit(main())

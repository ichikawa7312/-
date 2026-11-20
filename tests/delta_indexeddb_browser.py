"""Real IndexedDB durability/CAS tests for the isolated delta prototype.

Run: python tests/delta_indexeddb_browser.py --browser chromium
     python tests/delta_indexeddb_browser.py --browser webkit

Only loopback HTTP and disposable browser profiles are used. No live app,
Supabase project, company folder or device data is opened. Fault injection
tests storage errors; it is not a physical-device low-disk test. The offline
fixture has a test-only service worker, not the production app's worker.
"""
import argparse
import functools
import json
import socket
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


CHECKS = r"""async engine=>{
  const API=SentlogDeltaIndexedDB,scope={ownerId:'owner-a',projectId:'project-a',deviceId:'device-a'};
  const copy=x=>structuredClone(x),results=[];window.__deltaResults=results;
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const equal=(a,b,message)=>assert(JSON.stringify(a)===JSON.stringify(b),message);
  let serial=0;
  const database=()=>`sentlog-delta-test-${engine}-${++serial}`;
  const state=(extra={})=>({version:2,scope:copy(scope),cursor:0,records:{},outbox:[],...extra});
  const store=(name,other={})=>API.createStore({...scope,databaseName:name,...other});
  const expect=async(fn,code)=>{
    let caught;try{await fn();}catch(error){caught=error;}
    assert(caught,`expected ${code}`);
    if(code)assert(caught.code===code||caught.name===code,`expected ${code}, got ${caught.code||caught.name}: ${caught.message}`);
    return caught;
  };
  async function raw(name,fn,version=1){
    const db=await new Promise((resolve,reject)=>{
      const q=indexedDB.open(name,version);
      q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('replicas'))q.result.createObjectStore('replicas');};
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('raw fixture blocked'));
    });
    try{return await fn(db);}finally{db.close();}
  }
  const key=JSON.stringify([scope.ownerId,scope.projectId,scope.deviceId]);
  function rawPut(db,value){return new Promise((resolve,reject)=>{
    const tx=db.transaction('replicas','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    tx.objectStore('replicas').put(value,key);
  });}
  function rawGet(db){return new Promise((resolve,reject)=>{
    const q=db.transaction('replicas').objectStore('replicas').get(key);
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });}
  async function test(name,fn){
    try{await fn();results.push(name);}catch(error){error.message=name+': '+error.message;throw error;}
  }
  await test('fresh storage is empty and cannot be overwritten without reading',async()=>{
    const s=store(database());
    await expect(()=>s.write(state()),'DELTA_STORE_NOT_READ');
    equal(await s.read(),null,'new state');await s.write(state());s.close();
  });
  await test('records outbox and cursor survive close and reopen together',async()=>{
    const name=database(),s=store(name),saved=state({cursor:7,records:{one:{id:'r1',memo:'未送信の所見 🌧️'}},
      outbox:[{projectId:scope.projectId,deviceId:scope.deviceId,eventId:'one'}]});
    await s.read();await s.write(saved);s.close();
    const recovered=store(name);equal(await recovered.read(),saved,'atomic state changed');recovered.close();
  });
  await test('caller mutations cannot change a queued write or a durable read',async()=>{
    const s=store(database());await s.read();const candidate=state({records:{r:{memo:'保存する内容'}}});
    const pending=s.write(candidate);candidate.records.r.memo='後から変更';await pending;
    const first=await s.read();equal(first.records.r.memo,'保存する内容','write input was aliased');
    first.records.r.memo='返却値を変更';equal((await s.read()).records.r.memo,'保存する内容','read output was aliased');s.close();
  });
  await test('account project and device each isolate their storage',async()=>{
    const name=database(),a=store(name);await a.read();await a.write(state({records:{a:{memo:'private'}}}));
    for(const field of ['ownerId','projectId','deviceId']){
      const b=store(name,{[field]:'another'});equal(await b.read(),null,field+' leaked');
      const saved=state({scope:{...scope,[field]:'another'},records:{b:{memo:field}}});
      await b.write(saved);b.close();
    }
    equal((await a.read()).records,{a:{memo:'private'}},'foreign scope changed A');a.close();
  });
  await test('scope options and getScope return value cannot redirect a store',async()=>{
    const options={...scope,databaseName:database()},s=API.createStore(options);
    options.ownerId='other';const exposed=s.getScope();exposed.projectId='other';
    equal(s.getScope(),scope,'immutable scope changed');await s.read();await s.write(state());s.close();
  });
  await test('foreign and legacy unscoped writes reject without replacing data',async()=>{
    const s=store(database());await s.read();const saved=state({cursor:3});await s.write(saved);
    await expect(()=>s.write(state({scope:{...scope,ownerId:'other'}})),'DELTA_SCOPE');
    await expect(()=>s.write({version:1,cursor:0,records:{},outbox:[]}),'DELTA_SCOPE');
    await expect(()=>s.write(state({outbox:[{projectId:'foreign',deviceId:scope.deviceId}]})),'DELTA_SCOPE');
    equal(await s.read(),saved,'invalid write damaged saved state');s.close();
  });
  await test('two stores reject a stale writer and allow explicit reload',async()=>{
    const name=database(),a=store(name),b=store(name);await a.read();await b.read();
    const first=state({records:{a:{memo:'first'}}});await a.write(first);
    await expect(()=>b.write(state({records:{b:{memo:'second'}}})),'DELTA_STORE_STALE');
    equal(await a.read(),first,'stale writer replaced data');const latest=await b.read();
    latest.records.b={memo:'second'};await b.write(latest);
    equal((await a.read()).records,{a:{memo:'first'},b:{memo:'second'}},'explicit reload lost first edit');a.close();b.close();
  });
  await test('simultaneous first writes have one winner without lost-update success',async()=>{
    const name=database(),a=store(name),b=store(name);await Promise.all([a.read(),b.read()]);
    const results=await Promise.allSettled([a.write(state({records:{a:{}}})),b.write(state({records:{b:{}}}))]);
    assert(results.filter(x=>x.status==='fulfilled').length===1,'both writes succeeded');
    equal(results.find(x=>x.status==='rejected').reason.code,'DELTA_STORE_STALE','wrong conflict');a.close();b.close();
  });
  await test('transaction abort rolls back cursor records and outbox and permits retry',async()=>{
    const name=database(),s=store(name);await s.read();const saved=state({cursor:2,records:{original:{}},
      outbox:[{projectId:scope.projectId,deviceId:scope.deviceId,eventId:'queued'}]});await s.write(saved);
    const native=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){const q=native.apply(this,args);if(this.transaction.db.name===name)this.transaction.abort();return q;};
    try{await expect(()=>s.write(state({cursor:3,records:{new:{}},outbox:[]})));}
    finally{IDBObjectStore.prototype.put=native;}
    equal(await s.read(),saved,'partial save committed');await s.write(state({cursor:3,records:{new:{}},outbox:[]}));
    equal((await s.read()).cursor,3,'retry failed');s.close();
  });
  await test('injected quota error retains previous data and unsent changes',async()=>{
    const name=database(),s=store(name);await s.read();const saved=state({outbox:[{projectId:scope.projectId,deviceId:scope.deviceId,eventId:'keep'}]});
    await s.write(saved);const native=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.transaction.db.name===name)throw new DOMException('test quota failure','QuotaExceededError');return native.apply(this,args);};
    try{await expect(()=>s.write(state({cursor:1})),'QuotaExceededError');}
    finally{IDBObjectStore.prototype.put=native;}
    equal(await s.read(),saved,'quota failure lost queue');await s.write(state({cursor:1}));s.close();
  });
  await test('failed database open can be retried without resetting its contents',async()=>{
    const name=database(),s=store(name);await s.read();await s.write(state({cursor:5}));s.close();
    let calls=0;const wrapped={open(...args){if(!calls++)throw new DOMException('test open failure','UnknownError');return indexedDB.open(...args);}};
    const retry=store(name,{indexedDB:wrapped});await expect(()=>retry.read(),'UnknownError');
    equal((await retry.read()).cursor,5,'open retry changed data');retry.close();
  });
  await test('cursor cannot regress on a valid current revision',async()=>{
    const s=store(database());await s.read();await s.write(state({cursor:8}));
    await expect(()=>s.write(state({cursor:7})),'DELTA_STORE_CURSOR');equal((await s.read()).cursor,8,'cursor regressed');s.close();
  });
  await test('closing rejects queued writes before they touch storage',async()=>{
    const name=database(),s=store(name);await s.read();const pending=s.write(state({cursor:1}));s.close();
    await expect(()=>pending,'DELTA_STORE_CLOSED');await expect(()=>s.read(),'DELTA_STORE_CLOSED');
    const reopened=store(name);equal(await reopened.read(),null,'closed write committed');reopened.close();
  });
  await test('closing during an active transaction aborts the full save',async()=>{
    const name=database(),s=store(name);await s.read();const saved=state({cursor:2});await s.write(saved);
    const native=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){const q=native.apply(this,args);if(this.transaction.db.name===name)s.close();return q;};
    try{await expect(()=>s.write(state({cursor:3})),'DELTA_STORE_CLOSED');}
    finally{IDBObjectStore.prototype.put=native;}
    const reopened=store(name);equal(await reopened.read(),saved,'closed transaction committed');reopened.close();
  });
  await test('unscoped legacy state on disk is preserved and refuses automatic migration',async()=>{
    const name=database(),legacy={storageVersion:1,scope:copy(scope),revision:1,state:{version:1,cursor:3,records:{old:{}},outbox:[]}};
    await raw(name,db=>rawPut(db,legacy));const s=store(name);await expect(()=>s.read(),'DELTA_SCOPE');s.close();
    equal(await raw(name,rawGet),legacy,'legacy bytes changed');
  });
  await test('unknown envelope and mismatched owner fail closed without clearing',async()=>{
    for(const envelope of [{storageVersion:2,revision:1,scope:copy(scope),state:state()},
      {storageVersion:1,revision:1,scope:{...scope,ownerId:'other'},state:state()}]){
      const name=database();await raw(name,db=>rawPut(db,envelope));const s=store(name);
      await expect(()=>s.read(),envelope.storageVersion===2?'DELTA_STORE_SCHEMA':'DELTA_SCOPE');s.close();
      equal(await raw(name,rawGet),envelope,'invalid envelope overwritten');
    }
  });
  await test('a missing previously observed row is not replaced with an empty state',async()=>{
    const name=database(),s=store(name);await s.read();await s.write(state({cursor:3}));
    await raw(name,db=>new Promise((resolve,reject)=>{const tx=db.transaction('replicas','readwrite');
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.objectStore('replicas').delete(key);}));
    await expect(()=>s.read(),'DELTA_STORE_MISSING');await expect(()=>s.write(state()),'DELTA_STORE_STALE');s.close();
  });
  await test('future database upgrade closes our connection and does not erase saved data',async()=>{
    const name=database(),s=store(name);await s.read();await s.write(state({cursor:4}));
    await raw(name,async()=>{},2);await expect(()=>s.read(),'VersionError');s.close();
    equal((await raw(name,rawGet,2)).state.cursor,4,'upgrade lost saved data');
  });
  await test('the adapter refuses the production legacy database name',async()=>{
    await expect(()=>API.createStore({...scope,databaseName:'surveyFieldNoteDB'}),'DELTA_STORE_CONFIG');
  });

  const C=SentlogRecordCollaboration,D=SentlogDeltaSyncCore;
  const initial=id=>C.upgrade({id,recordKind:'field-record',kind:'field-record',recordType:'survey',
    type:'調査',page:1,point:{x:1,y:2},memo:'試験の所見',photos:[],crackWidthMm:0.2});
  function cloud(){
    const rows=[],byId=new Map(),flag={online:false},stats={push:0,read:0};
    const transport={online:()=>flag.online,
      async push(event){
        stats.push++;D.validateEvent(event);
        let row=byId.get(event.eventId);
        if(row)equal(row.event,event,'retry changed payload');
        else{row={seq:rows.length+1,event:copy(event)};rows.push(row);byId.set(event.eventId,row);}
        return {seq:row.seq,eventId:event.eventId,projectId:event.projectId,deviceId:event.deviceId,
          drawingId:event.drawingId,recordId:event.recordId};
      },
      async list(projectId,cursor,limit){stats.read++;return copy(rows.filter(r=>r.seq>cursor&&r.event.projectId===projectId).slice(0,limit));}};
    return {rows,flag,stats,transport};
  }
  const replica=(s,transport,extra={})=>D.createReplica({...scope,store:s,transport,
    reconcileIntervalMs:0,retryBaseMs:10000,retryMaxMs:10000,requestTimeoutMs:3000,...extra});
  async function until(fn,label){for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error(label);}
  await test('core restores a real disk outbox then automatically sends it on reconnect',async()=>{
    const name=database(),server=cloud(),s=store(name),a=replica(s,server.transport);await a.start();
    const record=initial('offline-record');await a.change({drawingId:'d',before:null,after:record,eventId:'offline-create'});
    equal(server.rows.length,0,'offline write was sent');a.close();s.close();
    const recoveredStore=store(name),recovered=replica(recoveredStore,server.transport);await recovered.start();
    const before=await recovered.snapshot();equal(before.outbox.length,1,'disk queue missing');
    equal(before.records[D.keyOf('d',record.id)],record,'disk record missing');
    server.flag.online=true;recovered.onOnline();
    await until(async()=>{const state=await recovered.snapshot();return state.cursor===1&&!state.outbox.length;},'automatic reconnect did not send');
    equal(server.rows.length,1,'reconnect duplicated record');recovered.close();recoveredStore.close();
    const peerScope={...scope,deviceId:'peer-device'},peerStore=store(name,{deviceId:peerScope.deviceId});
    const peer=replica(peerStore,server.transport,{deviceId:peerScope.deviceId});await peer.start();
    equal((await peer.snapshot()).records[D.keyOf('d',record.id)],record,'peer did not receive');peer.close();peerStore.close();
  });
  await test('core local save failure preserves its caller draft and existing disk record',async()=>{
    const name=database(),server=cloud(),s=store(name),a=replica(s,server.transport);await a.start();
    const record=initial('quota-draft'),native=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.transaction.db.name===name)throw new DOMException('test quota','QuotaExceededError');return native.apply(this,args);};
    try{await expect(()=>a.change({drawingId:'d',before:null,after:record,eventId:'quota-create'}),'QuotaExceededError');}
    finally{IDBObjectStore.prototype.put=native;}
    equal((await a.snapshot()).outbox,[],'failed write became pending in memory');equal(await s.read(),null,'failed write reached disk');
    equal(record.memo,'試験の所見','caller draft was discarded');
    await a.change({drawingId:'d',before:null,after:record,eventId:'quota-create'});equal((await a.snapshot()).outbox.length,1,'draft could not retry');
    a.close();s.close();
  });
  await test('server commit then failed local ACK save survives restart and sends once',async()=>{
    const name=database(),server=cloud(),s=store(name),a=replica(s,server.transport);await a.start();
    await a.change({drawingId:'d',before:null,after:initial('lost-ack-record'),eventId:'lost-ack'});
    const native=IDBObjectStore.prototype.put;server.flag.online=true;
    IDBObjectStore.prototype.put=function(...args){if(this.transaction.db.name===name){server.flag.online=false;throw new DOMException('test quota after server commit','QuotaExceededError');}return native.apply(this,args);};
    try{await expect(()=>a.sync(),'QuotaExceededError');}finally{IDBObjectStore.prototype.put=native;}
    equal(server.rows.length,1,'server did not commit exactly once');equal((await a.snapshot()).outbox.length,1,'lost ACK erased local queue');
    a.close();s.close();const reopenedStore=store(name),reopened=replica(reopenedStore,server.transport);await reopened.start();
    equal((await reopened.snapshot()).outbox.length,1,'restart lost retry');server.flag.online=true;reopened.onOnline();
    await until(async()=>!(await reopened.snapshot()).outbox.length,'retry did not finish');
    equal(server.rows.length,1,'replayed ACK duplicated server event');reopened.close();reopenedStore.close();
  });
  await test('failed receive transaction does not advance durable cursor',async()=>{
    const name=database(),server=cloud(),record=initial('incoming-record');
    const event=D.diffRecord(null,record,{eventId:'incoming',projectId:scope.projectId,drawingId:'d',deviceId:'peer'});
    await server.transport.push(event);server.flag.online=true;const s=store(name),a=replica(s,server.transport);
    const native=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.transaction.db.name===name)throw new DOMException('test receive quota','QuotaExceededError');return native.apply(this,args);};
    try{await expect(()=>a.start(),'QuotaExceededError');}finally{IDBObjectStore.prototype.put=native;}
    const failed=await a.snapshot();equal(failed.cursor,0,'failed receive advanced memory');equal(await s.read(),null,'failed receive advanced disk');
    await a.sync();const recovered=await a.snapshot();equal(recovered.cursor,1,'retry failed');equal(recovered.records[D.keyOf('d',record.id)],record,'record lost');
    a.close();s.close();
  });
  await test('two replicas using real storage cannot silently replace pending local work',async()=>{
    const name=database(),server=cloud(),sa=store(name),sb=store(name),a=replica(sa,server.transport),b=replica(sb,server.transport);
    await a.start();await b.start();const one=initial('one'),two=initial('two');
    await a.change({drawingId:'d',before:null,after:one,eventId:'one'});
    await expect(()=>b.change({drawingId:'d',before:null,after:two,eventId:'two'}),'DELTA_STORE_STALE');
    equal((await sa.read()).outbox.map(e=>e.eventId),['one'],'first pending event was replaced');
    equal(two.id,'two','second caller lost draft');a.close();b.close();sa.close();sb.close();
  });
  await test('a hanging network request does not block a second durable local edit',async()=>{
    const name=database(),server=cloud(),s=store(name);server.flag.online=true;
    let entered=false;server.transport.push=async()=>{entered=true;return new Promise(()=>{});};
    const a=replica(s,server.transport);await a.start();const first=initial('first');
    await a.change({drawingId:'d',before:null,after:first,eventId:'first'});await until(()=>entered,'push did not start');
    await a.change({drawingId:'d',before:null,after:initial('second'),eventId:'second'});
    equal((await a.snapshot()).outbox.length,2,'hanging network blocked local queue');a.close();s.close();
    const reopened=store(name);equal((await reopened.read()).outbox.length,2,'second edit was not durable');reopened.close();
  });
  return results;
}"""


PERSIST = r"""async()=>{
  const scope={ownerId:'offline-owner',projectId:'offline-project',deviceId:'offline-device'};
  const s=SentlogDeltaIndexedDB.createStore({...scope,databaseName:'sentlog-delta-test-offline-restart'});
  await s.read();
  const saved={version:2,scope,cursor:12,records:{r:{memo:'閉じても残す写真の所見 📷',crackWidthMm:0.35}},
    outbox:[{projectId:scope.projectId,deviceId:scope.deviceId,eventId:'offline-unsent'}]};
  await s.write(saved);s.close();
  await navigator.serviceWorker.register('./delta_indexeddb_fixture_sw.js');
  await navigator.serviceWorker.ready;
  return saved;
}"""


RESTORE = r"""async()=>{
  const scope={ownerId:'offline-owner',projectId:'offline-project',deviceId:'offline-device'};
  const s=SentlogDeltaIndexedDB.createStore({...scope,databaseName:'sentlog-delta-test-offline-restart'});
  const saved=await s.read();s.close();return saved;
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', choices=['chromium', 'webkit'], required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_address[1]}'
    url = origin + '/tests/delta_indexeddb_fixture.html'
    report = {'browser': args.browser, 'passed': 0, 'cases': [], 'status': 'running',
              'physical_ios_tested': False, 'legacy_app_migration_tested': False,
              'photo_original_delivery_tested': False,
              'backend': 'in-page synthetic event server; no Supabase requests',
              'storage': 'real IndexedDB in disposable browser profile',
              'network': 'loopback fixture only',
              'playwright_version': package_version('playwright'),
              'offline_methods': ['Playwright offline flag', 'fixture origin stopped; external requests blocked'],
              'playwright_offline_probe': {'status': 'not-run'}}
    origin_stopped = False

    def stop_origin():
        nonlocal origin_stopped
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive(), 'fixture HTTP server did not stop'
        assert server.socket.fileno() == -1, 'fixture server socket is still open'
        with socket.socket() as probe:
            probe.settimeout(2)
            result = probe.connect_ex(('127.0.0.1', server.server_address[1]))
            assert result != 0, 'fixture origin is still reachable'
        report['origin_unreachable_probe'] = {'connect_errno': result, 'server_socket_closed': True}
        origin_stopped = True

    def cached_navigation(response):
        assert response is not None and response.status == 200, 'cached fixture did not return HTTP 200'
        assert response.headers.get('x-sentlog-fixture-source') == 'service-worker-cache', 'navigation was not fulfilled by the cached test worker'

    def restrict(context):
        blocked = []
        def route(request_route):
            parsed = urlparse(request_route.request.url)
            if parsed.scheme in ('http', 'https') and parsed.netloc != urlparse(origin).netloc:
                blocked.append(request_route.request.url)
                request_route.abort('blockedbyclient')
            else:
                request_route.continue_()
        context.route('**/*', route)
        return blocked

    try:
        with tempfile.TemporaryDirectory(prefix='sentlog-delta-browser-') as profile, sync_playwright() as p:
            engine = getattr(p, args.browser)
            launch = {'headless': True}
            if args.browser == 'chromium' and not Path(engine.executable_path).exists() and Path('/usr/bin/chromium').exists():
                launch.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            context = engine.launch_persistent_context(profile, **launch)
            blocked = restrict(context)
            page = context.pages[0] if context.pages else context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url)
            try:
                names = page.evaluate(CHECKS, args.browser)
            except Exception:
                report['cases'] = page.evaluate('window.__deltaResults || []')
                report['passed'] = len(report['cases'])
                raise
            for name in names:
                print(f'PASS {args.browser}: {name}', flush=True)
            report['cases'] = names

            # The same migration cases also run with fake-indexeddb in Node.
            # Here every copy/checkpoint/abort uses the engine's real storage.
            migration_names = page.evaluate('async engine => await runDeltaMigrationCases(engine)', args.browser)
            for name in migration_names:
                print(f'PASS {args.browser} migration: {name}', flush=True)
            report['cases'].extend('migration: ' + name for name in migration_names)

            second = context.new_page()
            second.goto(url)
            setup = """async()=>{
              const scope={ownerId:'tab-owner',projectId:'tab-project',deviceId:'tab-device'};
              window.tabStore=SentlogDeltaIndexedDB.createStore({...scope,databaseName:'sentlog-delta-test-two-tabs'});
              window.tabState={version:2,scope,cursor:0,records:{},outbox:[]};
              return await tabStore.read();
            }"""
            assert page.evaluate(setup) is None
            assert second.evaluate(setup) is None
            page.evaluate("async()=>{tabState.records.a={memo:'先の画面'};await tabStore.write(tabState);}")
            assert second.evaluate("""async()=>{
              tabState.records.b={memo:'後の画面'};
              try{await tabStore.write(tabState);return 'unexpected success';}catch(error){return error.code;}
            }""") == 'DELTA_STORE_STALE'
            assert second.evaluate('async()=>await tabStore.read()') == page.evaluate('async()=>await tabStore.read()')
            page.evaluate('tabStore.close()')
            second.evaluate('tabStore.close()')
            second.close()
            name = 'two actual browser tabs reject a stale overwrite'
            report['cases'].append(name)
            print(f'PASS {args.browser}: {name}', flush=True)

            saved = page.evaluate(PERSIST)
            page.reload()
            page.wait_for_function('!!navigator.serviceWorker.controller')
            assert page.evaluate("""async()=>{
              const files=[location.href,'../sentlog/record-collaboration.js','../sentlog/delta-sync-core.js','../sentlog/delta-sync-indexeddb.js'];
              return (await Promise.all(files.map(path=>caches.match(new URL(path,location.href).href)))).every(Boolean);
            }"""), 'offline fixture resources are not cached'

            # The original strict offline-flag gate is retained. Playwright
            # fixed its WebKit worker-navigation bug in the 1.64 line; this
            # job pins the fixed browser/package together. Never ignore a
            # failed emulated-offline navigation or count it as a success.
            report['playwright_offline_probe'] = {'status': 'running'}
            context.set_offline(True)
            cached_navigation(page.reload())
            assert page.evaluate(RESTORE) == saved, 'emulated-offline reload changed durable state'
            name = 'emulated-offline reload reads durable unsent state through test worker'
            report['cases'].append(name)
            print(f'PASS {args.browser}: {name}', flush=True)
            assert not errors, errors
            assert not blocked, blocked
            context.close()

            context = engine.launch_persistent_context(profile, **launch)
            blocked = restrict(context)
            page = context.pages[0] if context.pages else context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            context.set_offline(True)
            cached_navigation(page.goto(url))
            assert page.evaluate(RESTORE) == saved, 'emulated-offline browser restart changed durable state'
            name = 'new browser process with offline flag reopens committed state'
            report['cases'].append(name)
            print(f'PASS {args.browser}: {name}', flush=True)
            report['playwright_offline_probe'] = {'status': 'passed', 'reload': True, 'new_process': True}
            context.set_offline(False)
            page.goto(url)
            assert page.evaluate(RESTORE) == saved, 'offline-flag probe damaged saved state'

            # Shut down the actual origin, verify its port is unreachable, and
            # require a worker-only marker. The browser cannot fetch fixture JS
            # or HTML from a network fallback. This is an unavailable-origin
            # test, not a claim to emulate physical iPhone airplane mode.
            stop_origin()
            cached_navigation(page.reload())
            assert page.evaluate(RESTORE) == saved, 'offline reload changed durable state'
            name = 'origin-unavailable reload reads durable unsent state through test worker'
            report['cases'].append(name)
            print(f'PASS {args.browser}: {name}', flush=True)
            assert not errors, errors
            assert not blocked, blocked
            context.close()

            # A new browser process with the same disposable profile verifies
            # storage survives more than an in-memory page/context restart.
            context = engine.launch_persistent_context(profile, **launch)
            blocked = restrict(context)
            page = context.pages[0] if context.pages else context.new_page()
            cached_navigation(page.goto(url))
            assert page.evaluate(RESTORE) == saved, 'browser restart changed durable state'
            name = 'new browser process reopens committed state while origin is unreachable'
            report['cases'].append(name)
            print(f'PASS {args.browser}: {name}', flush=True)
            assert not blocked, blocked
            context.close()
            report.update(status='passed', passed=len(report['cases']))
            print(json.dumps(report, ensure_ascii=False), flush=True)
    except Exception as error:
        if report['playwright_offline_probe']['status'] == 'running':
            report['playwright_offline_probe'] = {'status': 'failed', 'error': str(error)}
        report.update(status='failed', passed=len(report['cases']), error=str(error))
        raise
    finally:
        if not origin_stopped:
            server.shutdown()
            server.server_close()
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()

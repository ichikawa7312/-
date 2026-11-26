"""Exercise the standalone startup diagnostic in isolated native browsers.

Only synthetic data in fresh temporary profiles is used. The real HTML and JS
are served from a loopback server, with every other browser request blocked.
No production application build, account, user profile, or remote service is
loaded. Missing native browser dependencies are a nonzero BLOCKED result.

Usage: python tests/startup_storage_diagnostics_ui.py --engine chromium --report /tmp/startup-chromium.json
       python tests/startup_storage_diagnostics_ui.py --engine webkit --report /tmp/startup-webkit.json
"""

import argparse
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
PAGE = "/sentlog/storage-check.html"
CORE = "/sentlog/startup-storage-diagnostics.js"
FIXTURE = "/__startup_storage_fixture__"
FORBIDDEN_CONNECT = "/__startup_storage_forbidden_connect__"
DATABASE_NAMES = (
    "surveyFieldNoteDB", "sentlog-original-photos-v1",
    "sentlog-delta-migration-v1", "sentlog-delta-assets-v1",
    "sentlog-delta-v1", "sentlogSyncTrafficV1", "sentlog-pc-sync",
)
KINDS = {"records", "originals", "migration", "assets", "replicas", "receipts", "pc"}
PRIVATE = "PRIVATE_STARTUP_"


class Handler(BaseHTTPRequestHandler):
    """Serve the two real repository files, plus an inert synthetic seed page."""

    def do_GET(self):
        path = urlparse(self.path).path
        if path in (PAGE, CORE):
            body = (ROOT / path.lstrip("/")).read_bytes()
            content_type = "text/html; charset=utf-8" if path == PAGE else "text/javascript; charset=utf-8"
        elif path == FIXTURE:
            body = b'<!doctype html><meta charset="utf-8"><title>Isolated startup fixture</title>'
            content_type = "text/html; charset=utf-8"
        elif path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


# Native API wrappers observe the diagnostic, not the fixture's seed/snapshot.
# Snapshot traversal and Blob hashing run only before and after that boundary.
FIXTURE_HELPERS = r"""(() => {
  const known = new Set(['surveyFieldNoteDB','sentlog-original-photos-v1',
    'sentlog-delta-migration-v1','sentlog-delta-assets-v1','sentlog-delta-v1',
    'sentlogSyncTrafficV1','sentlog-pc-sync']);
  const marker='sentlogRecordsReadyV130';
  const fixedKeys=new Set(['__sentlog_records_meta_v130__',
    '__sentlog_record__:surveyFieldNoteWorkspaceV1','__sentlog_records_archive_v130__']);
  const request=q=>new Promise((resolve,reject)=>{
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });
  const completed=tx=>new Promise((resolve,reject)=>{
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||Error('Synthetic transaction aborted'));
    tx.onerror=()=>{};
  });
  async function create(name,stores,version=1){
    const q=indexedDB.open(name,version);
    q.onupgradeneeded=()=>{
      for(const name of Object.keys(stores)){
        const store=q.result.createObjectStore(name);
        if(name==='meta')store.createIndex('createdAt','createdAt');
      }
    };
    const db=await request(q);
    try{
      const tx=db.transaction(Object.keys(stores),'readwrite'),done=completed(tx);
      for(const [name,rows]of Object.entries(stores))
        for(const [key,value]of rows)tx.objectStore(name).put(value,key);
      await done;
    }finally{db.close();}
  }
  async function seed(){
    const file=new File(['PRIVATE_STARTUP_PDF_BYTES'],'PRIVATE_STARTUP_drawing.pdf',
      {type:'application/pdf',lastModified:1700000000123});
    // Deliberately no META, while the migration marker and other data remain.
    // The ordinary app cannot initialize this fixture; the diagnostic must.
    await create('surveyFieldNoteDB',{
      files:[
        ['__sentlog_record__:surveyFieldNoteWorkspaceV1',JSON.stringify({projects:[{id:'PRIVATE_STARTUP_project',name:'PRIVATE_STARTUP_name',drawings:[]}]})],
        ['__sentlog_records_archive_v130__',{entries:[['PRIVATE_STARTUP_key','PRIVATE_STARTUP_old-record']]}],
        ['photo:PRIVATE_STARTUP_drawing:PRIVATE_STARTUP_photo',file],
        ['PRIVATE_STARTUP_file-key',{memo:'PRIVATE_STARTUP_record',bytes:new Uint8Array([7,8,9])}]
      ],
      sentlog_delta_journal_v1:[[1,{kind:'sentlog-app-intent',files:[{before:file,after:new Blob(['PRIVATE_STARTUP_after'])}]}]],
      sentlog_delta_control_v1:[['PRIVATE_STARTUP_control',{value:file,scope:{ownerId:'PRIVATE_STARTUP_owner'}}]],
      PRIVATE_STARTUP_unknown_store:[['PRIVATE_STARTUP_unknown-key','PRIVATE_STARTUP_unknown-value']]
    },2);
    await create('sentlog-original-photos-v1',{
      photos:[['PRIVATE_STARTUP_original',new File(['PRIVATE_STARTUP_ORIGINAL_BYTES'],'PRIVATE_STARTUP_original.jpg',
        {type:'image/jpeg',lastModified:1700000000456})]],
      meta:[['PRIVATE_STARTUP_original',{projectName:'PRIVATE_STARTUP_project-name',createdAt:1700000000000}]]
    });
    await create('sentlog-delta-migration-v1',{
      sessions:[['PRIVATE_STARTUP_session',{phase:'staging',private:'PRIVATE_STARTUP_session-data'}]],
      items:[['PRIVATE_STARTUP_item',{blob:file}]]
    });
    await create('sentlog-delta-assets-v1',{assets:[['PRIVATE_STARTUP_asset',{blob:file,status:'received'}]]});
    await create('sentlog-delta-v1',{replicas:[['PRIVATE_STARTUP_replica',{outbox:[{memo:'PRIVATE_STARTUP_日本語😀'}]}]]});
    await create('sentlogSyncTrafficV1',{acks:[['PRIVATE_STARTUP_ack',{owner:'PRIVATE_STARTUP_owner'}]]});
    await create('sentlog-pc-sync',{kv:[['PRIVATE_STARTUP_pc-key',{folder:'PRIVATE_STARTUP_folder'}]]});
    await create('PRIVATE_STARTUP_unrelated_database',{
      PRIVATE_STARTUP_unrelated_store:[['PRIVATE_STARTUP_unrelated_key',new Blob(['PRIVATE_STARTUP_unrelated_blob'])]]
    });
    localStorage.setItem(marker,'PRIVATE_STARTUP_marker-value');
    localStorage.setItem('PRIVATE_STARTUP_auth-key','PRIVATE_STARTUP_auth-value');
    for(const name of ['sentlog-pwa-v701','sentlog-pwa-v702','PRIVATE_STARTUP_cache']){
      const cache=await caches.open(name);
      await cache.put(location.origin+'/PRIVATE_STARTUP_cached-resource',new Response('PRIVATE_STARTUP_cached-body',
        {headers:{'Content-Type':'text/plain','X-Synthetic':'PRIVATE_STARTUP_header'}}));
    }
  }
  async function digest(buffer){
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function summarize(value){
    if(value instanceof Blob)return {kind:value instanceof File?'File':'Blob',size:value.size,type:value.type,
      name:value instanceof File?value.name:null,lastModified:value instanceof File?value.lastModified:null,
      sha256:await digest(await value.arrayBuffer())};
    if(value instanceof ArrayBuffer)return {kind:'ArrayBuffer',bytes:[...new Uint8Array(value)]};
    if(ArrayBuffer.isView(value))return {kind:value.constructor.name,bytes:[...new Uint8Array(value.buffer,value.byteOffset,value.byteLength)]};
    if(value instanceof Date)return {kind:'Date',value:value.toISOString()};
    if(Array.isArray(value))return Promise.all(value.map(summarize));
    if(value&&typeof value==='object'){
      const out={};for(const key of Object.keys(value).sort())out[key]=await summarize(value[key]);return out;
    }
    return value;
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
            indexes:Array.from(store.indexNames).map(name=>{const index=store.index(name);
              return {name,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};})};
          const cursor=store.openCursor();cursor.onsuccess=()=>{const c=cursor.result;
            if(c){rows.push({key:c.primaryKey,value:c.value});c.continue();}};
          await done;stores.push({...descriptor,rows:await summarize(rows)});
        }
        databases.push({name:db.name,version:db.version,stores});
      }finally{db.close();}
    }
    const local=[];for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);local.push([key,localStorage.getItem(key)]);
    }local.sort((a,b)=>a[0].localeCompare(b[0]));
    const cacheValues=[];
    for(const name of (await caches.keys()).sort()){
      const cache=await caches.open(name),entries=[];
      for(const key of await cache.keys()){
        const response=await cache.match(key);entries.push({url:key.url,method:key.method,
          status:response.status,headers:[...response.headers],sha256:await digest(await response.arrayBuffer())});
      }
      entries.sort((a,b)=>a.url.localeCompare(b.url));cacheValues.push({name,entries});
    }
    return {databases,local,cacheValues};
  }
  function guard(options={}){
    const probe={enumerations:0,enumerationCompleted:0,opens:[],counts:[],transactions:[],
      activeTransactions:0,liveConnections:0,markerReads:0,cacheLists:0,forbidden:[]};
    const restores=[],opened=new Set();let releaseEnumeration=null;
    function replace(owner,key,value){
      const before=Object.getOwnPropertyDescriptor(owner,key);
      Object.defineProperty(owner,key,{configurable:true,writable:true,value});
      restores.push(()=>before?Object.defineProperty(owner,key,before):delete owner[key]);
    }
    const forbid=label=>function(){probe.forbidden.push(label);throw Error('Synthetic diagnostic boundary violation');};
    for(const [owner,keys]of [
      [IDBFactory.prototype,['deleteDatabase']],
      [IDBDatabase.prototype,['createObjectStore','deleteObjectStore']],
      [IDBObjectStore.prototype,['put','add','delete','clear','get','getKey','getAll','getAllKeys','openCursor','openKeyCursor','index','createIndex','deleteIndex']],
      [IDBCursor.prototype,['update','delete']],
      [Blob.prototype,['arrayBuffer','text','stream','slice']],
      [FileReader.prototype,['readAsArrayBuffer','readAsBinaryString','readAsDataURL','readAsText']],
      [Storage.prototype,['setItem','removeItem','clear','key']]
    ])for(const key of keys)if(typeof owner[key]==='function')replace(owner,key,forbid(key));
    const enumerate=IDBFactory.prototype.databases;
    replace(IDBFactory.prototype,'databases',function(){
      probe.enumerations++;
      return enumerate.call(this).then(value=>{
        probe.enumerationCompleted++;
        if(options.blockEnumeration)return new Promise(resolve=>{releaseEnumeration=()=>resolve(value);});
        return value;
      });
    });
    const open=IDBFactory.prototype.open;
    replace(IDBFactory.prototype,'open',function(name,...args){
      if(!probe.enumerationCompleted||!known.has(name)||args.length)return forbid('unsafe-open')();
      probe.opens.push(name);const q=open.call(this,name);
      q.addEventListener('success',()=>{opened.add(q.result);probe.liveConnections=opened.size;});return q;
    });
    const close=IDBDatabase.prototype.close;
    replace(IDBDatabase.prototype,'close',function(){opened.delete(this);probe.liveConnections=opened.size;return close.call(this);});
    const transaction=IDBDatabase.prototype.transaction;
    replace(IDBDatabase.prototype,'transaction',function(names,mode,...args){
      if(mode!=='readonly')return forbid('writable-transaction')();
      probe.transactions.push({database:this.name,mode});const tx=transaction.call(this,names,mode,...args);
      probe.activeTransactions++;let ended=false;
      const end=()=>{if(!ended){ended=true;probe.activeTransactions--;}};
      tx.addEventListener('complete',end);tx.addEventListener('abort',end);return tx;
    });
    const count=IDBObjectStore.prototype.count;
    replace(IDBObjectStore.prototype,'count',function(...args){
      if(args.length&&(this.name!=='files'||args.length!==1||!fixedKeys.has(args[0])))return forbid('nonfixed-key-count')();
      probe.counts.push({store:this.name,key:args.length?args[0]:null});return count.apply(this,args);
    });
    const getItem=Storage.prototype.getItem;
    replace(Storage.prototype,'getItem',function(key){
      if(this!==localStorage||key!==marker)return forbid('private-storage-read')();
      probe.markerReads++;return getItem.call(this,key);
    });
    const cachePrototype=Object.getPrototypeOf(caches),keys=cachePrototype.keys;
    replace(cachePrototype,'keys',function(){probe.cacheLists++;return keys.call(this);});
    for(const method of ['open','delete','has','match'])replace(cachePrototype,method,forbid('cache-'+method));
    if(navigator.storage&&typeof navigator.storage.persist==='function')replace(navigator.storage,'persist',forbid('persist-request'));
    if(navigator.serviceWorker)replace(navigator.serviceWorker,'register',forbid('service-worker-registration'));
    return {probe,releaseEnumeration:()=>releaseEnumeration?.(),restore(){for(const restore of restores.reverse())restore();}};
  }
  window.__startupFixture={seed,snapshot,guard};
})();"""


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def two_frames(page):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def check_layout(page):
    layout = page.evaluate("""() => ({
      width:innerWidth,scroll:document.documentElement.scrollWidth,
      buttons:[...document.querySelectorAll('button')].filter(button=>!button.hidden).map(button=>{
        const r=button.getBoundingClientRect();return {x:r.x,width:r.width,height:r.height};
      })
    })""")
    check(layout["width"] == 375 and layout["scroll"] <= 376, "Diagnostic page overflows the 375px viewport")
    check(all(b["x"] >= 0 and b["x"] + b["width"] <= 376 and b["height"] >= 44 for b in layout["buttons"]),
          "A diagnostic control is clipped or too small")


def download_report(page, folder):
    page.wait_for_function("""() => !document.getElementById('storageCheckStart').disabled &&
      !document.getElementById('storageCheckSave').disabled""")
    check(page.locator("#storageCheckStop").is_hidden(), "Cancel control remained visible after completion")
    check(page.locator("#storageCheckResult").get_attribute("aria-busy") is None, "Diagnostic still claims it is busy")
    with page.expect_download() as observed:
        page.get_by_role("button", name="診断JSONを保存", exact=True).click()
    download = observed.value
    check(download.suggested_filename.startswith("sentlog-storage-check-"), "Unexpected diagnostic download name")
    target = folder / "diagnostic.json"
    download.save_as(str(target))
    text = target.read_text(encoding="utf-8")
    report = json.loads(text)
    rendered = page.locator("body").inner_text()
    check(PRIVATE not in text and PRIVATE not in rendered, "Diagnostic disclosed a synthetic private value or name")
    check(all(name not in text and name not in rendered for name in DATABASE_NAMES), "Diagnostic disclosed a database name")
    check(report["format"] == "sentlog-startup-storage-diagnostics" and report["version"] == 1 and report["readOnly"] is True,
          "Unexpected diagnostic report format")
    check({row["kind"] for row in report["indexedDB"]["databases"]} == KINDS, "Diagnostic omitted a database category")
    return report


def run_case(browser, temporary, base, name, *, populated=False, cancel=False, screenshot_path=None):
    folder = temporary / name
    folder.mkdir()
    context = browser.launch_persistent_context(str(folder / "profile"), headless=True,
        viewport={"width": 375, "height": 812}, accept_downloads=True)
    page_errors, console_errors, unexpected_requests = [], [], []
    expected_csp = {"active": False}
    allowed = {PAGE, CORE, FIXTURE, "/favicon.ico"}

    def route_request(route):
        parsed = urlparse(route.request.url)
        if f"{parsed.scheme}://{parsed.netloc}" == base and parsed.path in allowed:
            route.continue_()
        else:
            unexpected_requests.append("unexpected-request")
            route.abort()

    def console(message):
        if message.type != "error":
            return
        text = message.text
        if expected_csp["active"] and (FORBIDDEN_CONNECT in text or "content security policy" in text.lower() or "connect-src" in text):
            return
        console_errors.append("unexpected-console-error")

    try:
        context.route("**/*", route_request)
        page = context.pages[0] if context.pages else context.new_page()
        page.set_default_timeout(15000)
        page.on("pageerror", lambda _error: page_errors.append("pageerror"))
        page.on("console", console)
        page.goto(base + FIXTURE)
        page.evaluate(FIXTURE_HELPERS)
        if populated:
            page.evaluate("() => __startupFixture.seed()")
        before = page.evaluate("() => __startupFixture.snapshot()")
        if not populated:
            check(before["databases"] == [] and before["local"] == [] and before["cacheValues"] == [],
                  "An empty-case profile was not fresh")
        context.add_init_script(FIXTURE_HELPERS + "\nif(location.pathname===" + json.dumps(PAGE) +
            "){window.__startupGuard=__startupFixture.guard(" + json.dumps({"blockEnumeration": cancel}) + ");}")
        page.goto(base + PAGE)
        page.get_by_role("button", name="保存領域を確認する", exact=True).wait_for(state="visible")
        two_frames(page)
        initial = page.evaluate("__startupGuard.probe")
        check(initial["enumerations"] == 0 and initial["opens"] == [] and initial["markerReads"] == 0 and initial["cacheLists"] == 0,
              "Loading the standalone page accessed storage before the user started diagnosis")
        check(page.locator("#storageCheckSave").is_disabled(), "Download was available before a scan")
        check(page.evaluate("() => [...document.scripts].every(s=>s.src.includes('/startup-storage-diagnostics.js'))"),
              "Standalone page loaded an application dependency")
        csp = page.locator('meta[http-equiv="Content-Security-Policy"]').get_attribute("content") or ""
        check("connect-src 'none'" in csp and "worker-src 'none'" in csp, "Diagnostic CSP permits connections or workers")
        check_layout(page)
        page.get_by_role("button", name="保存領域を確認する", exact=True).click()
        if cancel:
            page.wait_for_function("__startupGuard.probe.enumerationCompleted === 1")
            page.get_by_role("button", name="確認を中止", exact=True).click()
        report = download_report(page, folder)
        if cancel:
            check(report["status"] == "cancelled" and report["indexedDB"]["status"] == "cancelled",
                  "Cancelled enumeration was reported as a completed scan")
            check(all(row["status"] == "cancelled" for row in report["indexedDB"]["databases"]),
                  "Cancelled database results were presented as confirmed")
            page.evaluate("() => __startupGuard.releaseEnumeration()")
            two_frames(page)
        else:
            check(report["indexedDB"]["status"] == "complete", "Native database inventory was incomplete")
            rows = {row["kind"]: row for row in report["indexedDB"]["databases"]}
            if populated:
                check(report["indexedDB"]["listedSentlogDatabaseCount"] == 7 and report["indexedDB"]["excludedDatabaseCount"] == 1,
                      "Known and private databases were not distinguished")
                check(all(row["status"] == "complete" for row in rows.values()), "A seeded database was not counted")
                check(rows["records"]["presence"] == {"status": "complete", "meta": False, "workspace": True, "legacyArchive": True},
                      "The missing-META startup state was not reported correctly")
                counts = {row["name"]: row["count"] for row in rows["records"]["stores"]}
                check(counts == {"files": 4, "sentlog_delta_journal_v1": 1, "sentlog_delta_control_v1": 1, None: 1},
                      "Native store counts or unknown-store anonymization differ")
                check(all(store["count"] == 1 for kind, row in rows.items() if kind != "records" for store in row["stores"]),
                      "A retained or auxiliary store was counted incorrectly")
                check(report["marker"] == {"status": "complete", "present": True}, "Marker presence was not reported")
                check(report["cache"] == {"status": "complete", "count": 2, "generations": [701, 702]},
                      "Cache inventory included a private name or altered known generations")
                check("起動用管理項目（META）：なし" in page.locator("#storageCheckResult").inner_text(),
                      "Missing META was not explained in the UI")
            else:
                check(all(row["status"] == "missing" and row["stores"] == [] for row in rows.values()),
                      "Missing databases were reported as existing empty databases")
                check(report["marker"] == {"status": "complete", "present": False}, "An absent marker was not reported")
                check(report["indexedDB"]["listedSentlogDatabaseCount"] == 0, "Empty profile gained a known database")
        check_layout(page)
        two_frames(page)
        probe = page.evaluate("__startupGuard.probe")
        check(probe["forbidden"] == [], "Diagnostic attempted a value read, mutation, or unapproved API")
        check(probe["enumerations"] == 1 and probe["markerReads"] == 1 and probe["cacheLists"] == 1,
              "Diagnostic repeated or bypassed an inventory boundary")
        check(probe["activeTransactions"] == 0 and probe["liveConnections"] == 0, "Diagnostic left a transaction or connection open")
        check(all(row["mode"] == "readonly" for row in probe["transactions"]), "Diagnostic opened a writable transaction")
        if populated and not cancel:
            check(set(probe["opens"]) == set(DATABASE_NAMES) and len(probe["opens"]) == 7, "Diagnostic opened outside the exact database allowlist")
            check(len(probe["counts"]) == 15, "Diagnostic did not use only store counts and the three fixed-key counts")
        else:
            check(probe["opens"] == [] and probe["transactions"] == [], "Empty or cancelled inventory opened a database")
        page.evaluate("() => __startupGuard.restore()")
        check(page.evaluate("() => __startupFixture.snapshot()") == before,
              "Diagnostic changed native records, Blob hashes, schema, localStorage, or cache contents")
        # Exercise the actual CSP after the diagnosis. The fixture route also
        # blocks this URL, so an ineffective CSP cannot reach any service.
        expected_csp["active"] = True
        blocked = page.evaluate("""async path => {
          const violations=[];const observed=e=>violations.push(e.effectiveDirective);
          document.addEventListener('securitypolicyviolation',observed);
          let rejected=false;try{await fetch(location.origin+path);}catch{rejected=true;}
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          document.removeEventListener('securitypolicyviolation',observed);
          return {rejected,violations};
        }""", FORBIDDEN_CONNECT)
        check(blocked["rejected"] and "connect-src" in blocked["violations"], "Actual CSP did not reject a connection")
        expected_csp["active"] = False
        if screenshot_path:
            screenshot_path.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(screenshot_path), full_page=True)
        check(not unexpected_requests and not page_errors and not console_errors,
              "Standalone diagnostic produced an unexpected request or browser error")
        return {"case": name, "status": "passed", "nativeDataUnchanged": True,
                "databaseOpens": len(probe["opens"]), "countRequests": len(probe["counts"]),
                "jsonDownloaded": True, "viewportWidth": 375, "cspConnectionBlocked": True}
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("chromium", "webkit"), default="chromium")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = {"suite": "startup-storage-diagnostics-ui", "engine": args.engine,
              "status": "running", "isolatedSyntheticProfiles": True, "physicalDeviceTest": False, "cases": []}
    stage = "dependencies"
    server = None
    try:
        from playwright.sync_api import sync_playwright
        stage = "server"
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = "http://127.0.0.1:" + str(server.server_port)
        with tempfile.TemporaryDirectory(prefix="sentlog-startup-native-") as temporary, sync_playwright() as playwright:
            browser = getattr(playwright, args.engine)
            for name, populated, cancel in [("missing-meta-with-retained-data", True, False),
                                             ("empty-profile-no-database-created", False, False),
                                             ("cancelled-enumeration-cleanup", True, True)]:
                stage = name
                screenshot = (args.report.parent / ("startup-storage-" + args.engine + ".png")
                    if args.report and populated and not cancel else None)
                report["cases"].append(run_case(browser, Path(temporary), base, name,
                    populated=populated, cancel=cancel, screenshot_path=screenshot))
        report["status"] = "passed"
        result = 0
    except Exception as error:
        # Keep failure artifacts free of browser dumps, fixture values and IDs.
        missing_runtime = stage == "dependencies" or (not report["cases"] and not isinstance(error, AssertionError)
            and any(token in str(error).lower() for token in ("executable doesn't exist", "host system is missing", "browser was not found")))
        report.update(status="blocked" if missing_runtime else "failed", stage=stage, failureType=type(error).__name__)
        if isinstance(error, AssertionError):
            report["reason"] = str(error)
        else:
            report["reason"] = "Native runtime unavailable" if missing_runtime else "Native browser execution failed"
        result = 2 if missing_runtime else 1
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False))
    return result


if __name__ == "__main__":
    sys.exit(main())

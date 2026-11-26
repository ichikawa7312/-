"""Native storage-diagnostic checks against synthetic, loopback-only fixtures.

Usage: python tests/storage_diagnostics_ui.py --browser chromium
       python tests/storage_diagnostics_ui.py --browser webkit

Requires the official Python Playwright package, its selected browser binary,
and the browser's normal OS dependencies. A missing browser/dependency is a
BLOCKED result and a nonzero exit, never a passing or silently skipped test.
Each case uses a fresh disposable persistent profile, not the user's profile.
This does not measure physical disk usage or test a physical iPad/iPhone.
"""

import argparse
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "/source/storage-diagnostics.js": ROOT / "sentlog/storage-diagnostics.js",
    "/source/storage-diagnostics-ui.js": ROOT / "sentlog/storage-diagnostics-ui.js",
    "/source/record-store.js": ROOT / "sentlog/record-store.js",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path in SOURCES:
            body = SOURCES[path].read_bytes()
            content_type = "text/javascript; charset=utf-8"
        elif path in ("/sentlog/", "/sentlog-pc/"):
            container = (
                '<main><h1>Disposable PC fixture</h1></main>'
                if path == "/sentlog-pc/"
                else '<div id="sentlogSettingsModal" aria-hidden="false">'
                '<div class="modal-card"><details id="sentlogStorageSection">'
                '<summary>保存容量</summary></details></div></div>'
            )
            body = (
                '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                '<title>Disposable storage diagnostic fixture</title>'
                '<style>body{font-family:sans-serif;margin:8px}*{box-sizing:border-box}</style>'
                '</head><body>' + container + '</body></html>'
            ).encode("utf-8")
            content_type = "text/html; charset=utf-8"
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


FIXTURE_HELPERS = r"""(() => {
  const request=q=>new Promise((resolve,reject)=>{
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });
  const finished=tx=>new Promise((resolve,reject)=>{
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||Error('fixture transaction aborted'));
  });
  async function create(name,stores,version=1){
    const q=indexedDB.open(name,version);
    q.onupgradeneeded=()=>{for(const name of Object.keys(stores))q.result.createObjectStore(name);};
    const db=await request(q);
    try{
      const tx=db.transaction(Object.keys(stores),'readwrite'),done=finished(tx);
      for(const [name,rows]of Object.entries(stores))
        for(const [key,value]of rows)tx.objectStore(name).put(value,key);
      await done;
    }finally{db.close();}
  }
  async function seed(journalRows=1){
    const file=new File(['0123456789'],'PRIVATE-fixture.pdf',{
      type:'application/pdf',lastModified:1700000000000
    });
    const journal=[[1,{kind:'sentlog-file-retention',at:1700000000000,
      files:[{before:file,after:file}],note:'PRIVATE field record'}]];
    for(let n=2;n<=journalRows;n++)journal.push([n,{
      kind:'sentlog-app-intent',at:1700000000000+n,payload:{memo:'PRIVATE fixture '+n}
    }]);
    await create('surveyFieldNoteDB',{
      files:[['photo:d:p',file]],sentlog_delta_journal_v1:journal,
      sentlog_delta_control_v1:[['cutoff',{kind:'cutoff-file',value:file}]]
    },3);
    await create('sentlog-original-photos-v1',{
      photos:[['p',new File(['01234567890123456789'],'PRIVATE-original.jpg',{
        type:'image/jpeg',lastModified:1700000000100
      })]],meta:[['p',{size:20,storedAt:1700000000100}]]
    });
    await create('sentlog-delta-migration-v1',{
      sessions:[['s',{status:'copying',createdAt:1700000000000}]],
      items:[[0,{descriptor:{kind:'photo',size:10},value:file}]]
    });
    await create('sentlog-delta-assets-v1',{
      assets:[['p',{state:'received',blob:file}]]
    });
    await create('sentlog-delta-v1',{replicas:[['r',{outbox:[{memo:'PRIVATE fixture 日本語😀'}]}]]});
    await create('unrelated-fixture-app',{private:[['secret','PRIVATE unrelated value']]});
  }
  async function summarize(value){
    if(value instanceof Blob)return {
      type:value instanceof File?'File':'Blob',size:value.size,mimeType:value.type,
      name:value instanceof File?value.name:null,
      lastModified:value instanceof File?value.lastModified:null,
      // Only small synthetic fixtures are read by this test, outside the diagnostic.
      text:await value.text()
    };
    if(Array.isArray(value))return Promise.all(value.map(summarize));
    if(value&&typeof value==='object'){
      const out={};for(const key of Object.keys(value).sort())out[key]=await summarize(value[key]);
      return out;
    }
    return value;
  }
  async function snapshot(){
    const out=[];
    for(const entry of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
      const db=await request(indexedDB.open(entry.name));
      try{
        const stores=[];
        for(const name of Array.from(db.objectStoreNames)){
          const tx=db.transaction(name,'readonly'),done=finished(tx),store=tx.objectStore(name),values=[];
          const meta={name,keyPath:store.keyPath,autoIncrement:store.autoIncrement,
            indexes:Array.from(store.indexNames).map(name=>{
              const index=store.index(name);return {name,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};
            })};
          const q=store.openCursor();q.onsuccess=()=>{const c=q.result;
            if(c){values.push({key:c.primaryKey,value:c.value});c.continue();}};
          await done;stores.push({...meta,values:await summarize(values)});
        }
        out.push({name:db.name,version:db.version,stores});
      }finally{db.close();}
    }
    return out;
  }
  function guard(){
    const probe={opens:[],enumerations:0,transactions:[],forbidden:[]},restores=[];
    const replace=(owner,key,value)=>{
      const prior=Object.getOwnPropertyDescriptor(owner,key);
      Object.defineProperty(owner,key,{value,configurable:true,writable:true});
      restores.push(()=>prior?Object.defineProperty(owner,key,prior):delete owner[key]);
    };
    const forbid=label=>function(){probe.forbidden.push(label);throw Error('Forbidden during diagnostic: '+label);};
    for(const [owner,keys]of [
      [IDBFactory.prototype,['deleteDatabase']],
      [IDBDatabase.prototype,['createObjectStore','deleteObjectStore']],
      [IDBObjectStore.prototype,['put','add','delete','clear','getAll','getAllKeys','createIndex','deleteIndex']],
      [IDBCursor.prototype,['update','delete']],
      [Blob.prototype,['arrayBuffer','text','stream']]
    ])for(const key of keys)if(typeof owner[key]==='function')replace(owner,key,forbid(key));
    const open=IDBFactory.prototype.open;
    replace(IDBFactory.prototype,'open',function(name,...args){
      probe.opens.push(name);if(args.length)throw Error('Diagnostic requested an IndexedDB version');
      return open.call(this,name,...args);
    });
    const enumerate=IDBFactory.prototype.databases;
    replace(IDBFactory.prototype,'databases',function(){probe.enumerations++;return enumerate.call(this);});
    const transaction=IDBDatabase.prototype.transaction;
    replace(IDBDatabase.prototype,'transaction',function(names,mode,...args){
      probe.transactions.push({database:this.name,names:Array.isArray(names)?names:[names],mode:mode||'readonly'});
      if(mode&&mode!=='readonly')return forbid('readwrite transaction')();
      return transaction.call(this,names,mode,...args);
    });
    return {probe,restore:()=>{for(const restore of restores.reverse())restore();}};
  }
  function wrapScan(options={}){
    const original=window.__nativeStorageDiagnostics||SentlogStorageDiagnostics;
    window.__nativeStorageDiagnostics=original;
    window.__scanCalls=0;window.__scanResult=null;window.__scanProgress=null;
    window.SentlogStorageDiagnostics={...original,scan:async uiOptions=>{
      window.__scanCalls++;
      const result=await original.scan({...uiOptions,...options,onProgress:value=>{
        window.__scanProgress=value;uiOptions.onProgress?.(value);
      }});
      window.__scanResult=result;return result;
    }};
  }
  window.fixture={seed,snapshot,guard,wrapScan};
})();"""


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def prepare(page, base, pc=False, rows=1):
    page.goto(base + ("/sentlog-pc/" if pc else "/sentlog/"))
    page.add_script_tag(content=FIXTURE_HELPERS)
    page.evaluate("rows => fixture.seed(rows)", rows)
    before = page.evaluate("() => fixture.snapshot()")
    page.evaluate("() => { window.__guard=fixture.guard(); }")
    page.add_script_tag(url=base + "/source/storage-diagnostics.js")
    return before


def install_ui(page, base, options=None):
    page.evaluate("options => fixture.wrapScan(options)", options or {})
    page.add_script_tag(url=base + "/source/storage-diagnostics-ui.js")
    page.locator("#sentlogStorageDiagnosticSection").wait_for(state="visible")


def begin(page):
    page.locator("#sentlogStorageDiagnosticSection > summary").click()
    page.locator("#sentlogStorageDiagnosticStart").click()


def result(page):
    page.wait_for_function("window.__scanResult !== null")
    page.wait_for_function("!document.getElementById('sentlogStorageDiagnosticStart').disabled")
    return page.evaluate("window.__scanResult")


def unchanged(page, before):
    probe = page.evaluate("window.__guard.probe")
    check(probe["forbidden"] == [], "Diagnostic attempted a mutation, bulk read, or Blob content read")
    check("unrelated-fixture-app" not in probe["opens"], "Diagnostic opened an unrelated database")
    check(all(row["mode"] == "readonly" for row in probe["transactions"]), "Writable transaction detected")
    page.evaluate("() => __guard.restore()")
    check(page.evaluate("() => fixture.snapshot()") == before, "Diagnostic changed data, metadata, or schema")


def manual_complete(page, base, pc=False):
    before = prepare(page, base, pc=pc)
    install_ui(page, base)
    # Two rendered frames allow install/toggle/MutationObserver work to finish.
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    check(page.evaluate("__scanCalls") == 0, "Loading the UI started a scan")
    check(page.evaluate("__guard.probe.enumerations") == 0, "Loading the UI enumerated databases")
    check(page.evaluate("__guard.probe.opens.length") == 0, "Loading the UI opened a database")
    page.locator("#sentlogStorageDiagnosticSection > summary").click()
    check(page.evaluate("__scanCalls") == 0, "Expanding the section started a scan")
    page.locator("#sentlogStorageDiagnosticStart").click()
    report = result(page)
    check(report["status"] == "complete" and report["complete"], "Complete fixture was not completely scanned")
    check(report["records"] == 9 and report["blobBytes"] == 80, "Native File/Blob logical totals differ")
    check(report["blobCount"] == 7, "Logical Blob references were not counted independently")
    check(report["excludedDatabaseCount"] == 1, "Unrelated database was not reported as excluded")
    check(len(report["databases"]) == 5, "A known retention database was omitted")
    text = page.locator("#sentlogStorageDiagnosticResult").inner_text()
    check("同期移行の控え" in text and "編集・ファイルの保持履歴" in text, "Hidden stores were not rendered")
    check("物理使用量" in text and "本体の使用量" in text, "Physical-versus-logical limitation was omitted")
    check("PRIVATE" not in text and "PRIVATE" not in json.dumps(report), "Diagnostic exposed fixture contents")
    check(page.get_by_role("button", name="確認を中止", exact=True).is_hidden(), "Cancel button remained enabled")
    box = page.locator("#sentlogStorageDiagnosticSection").bounding_box()
    check(box and box["x"] >= 0 and box["x"] + box["width"] <= page.viewport_size["width"], "Diagnostic overflows viewport")
    # Exercise the real copy formatter without an OS clipboard permission prompt.
    page.evaluate("""() => Object.defineProperty(navigator,'clipboard',{
      configurable:true,value:{writeText:async text=>{window.__copied=text;}}
    })""")
    page.get_by_role("button", name="診断結果をコピー", exact=True).click()
    copied = page.evaluate("window.__copied")
    check(copied and "物理的な重複" in copied and "PRIVATE" not in copied, "Copy result is unsafe or incomplete")
    unchanged(page, before)


def partial_limit(page, base):
    before = prepare(page, base)
    install_ui(page, base, {"maxRows": 2})
    begin(page)
    report = result(page)
    check(report["status"] == "partial" and not report["complete"], "Row-limited scan was presented as complete")
    check(report["records"] == 2, "Row limit was not applied")
    text = page.locator("#sentlogStorageDiagnosticResult").inner_text()
    check("確認できた分：" in text and "診断は完了していません" in text, "Partial result lacks its limitation")
    check("件数" in report["reason"], "Partial result omitted its stop reason")
    unchanged(page, before)


def unsupported(page, base):
    before = prepare(page, base)
    install_ui(page, base)
    page.evaluate("""() => fixture.wrapScan({indexedDB:{
      open(){throw Error('Unsupported branch must not open anything');}
    }})""")
    begin(page)
    report = result(page)
    check(report["status"] == "unsupported", "Missing databases() was not refused")
    total = page.locator(".sl-diagnosis-total").inner_text()
    check(total == "未計測", "Unsupported diagnostic misleadingly reported 0 B")
    check(page.evaluate("__guard.probe.opens.length") == 0, "Unsupported diagnostic opened a database")
    check("未計測" in page.evaluate("SentlogStorageDiagnosticsUI.format(__scanResult)"), "Copied unsupported result reports a size")
    unchanged(page, before)


def cancel_in_progress(page, base):
    before = prepare(page, base, rows=1200)
    install_ui(page, base, {"yieldEvery": 1})
    begin(page)
    page.wait_for_function("window.__scanProgress?.records >= 3 && !window.__scanResult")
    page.get_by_role("button", name="確認を中止", exact=True).click()
    report = result(page)
    check(report["status"] == "cancelled" and not report["complete"], "Cancel did not stop the scan")
    check(0 < report["records"] < 1208, "Cancel did not leave a partial count")
    check("確認できた分：" in page.locator(".sl-diagnosis-total").inner_text(), "Cancelled partial count lacks a label")
    unchanged(page, before)


def cancel_before_measurement(page, base, close_modal=False):
    before = prepare(page, base)
    install_ui(page, base)
    page.evaluate("""() => fixture.wrapScan({requestTimeoutMs:30000,indexedDB:{
      databases(){return new Promise(()=>{});},
      open(){throw Error('Cancelled enumeration must not open anything');}
    }})""")
    begin(page)
    page.wait_for_function("document.getElementById('sentlogStorageDiagnosticSection').getAttribute('aria-busy') === 'true'")
    if close_modal:
        page.evaluate("document.getElementById('sentlogSettingsModal').setAttribute('aria-hidden','true')")
    else:
        page.locator("#sentlogStorageDiagnosticSection > summary").click()
    report = result(page)
    check(report["status"] == "cancelled" and report["records"] == 0, "Closing diagnostics did not cancel pending enumeration")
    check(page.locator(".sl-diagnosis-total").text_content() == "未計測", "Unmeasured cancellation misleadingly reports 0 B")
    check(page.evaluate("__guard.probe.opens.length") == 0, "Pending enumeration opened a database")
    unchanged(page, before)


def file_metadata(page, base):
    page.goto(base + "/sentlog/")
    page.add_script_tag(content=FIXTURE_HELPERS)
    page.evaluate("""() => {
      localStorage.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify({projects:[{id:'p',drawings:[{id:'d',name:'D'}]}]}));
      localStorage.setItem('surveyFieldNoteDrawingV1:d',JSON.stringify({shapes:[],collabDeletedRecords:[]}));
    }""")
    page.add_script_tag(url=base + "/source/record-store.js")
    check(page.evaluate("SentlogRecords.getFileWriteCapabilities().fileWriteDedupVersion") == 1,
          "Updated writer capability must be available before initialization")
    outcome = page.evaluate(r"""async () => {
      const r=SentlogRecords;await r.init();const scope={ownerId:'o',projectId:'c',deviceId:'t'};
      await r.deltaJournal.begin({scope,localProjectId:'p',actor:{deviceId:'t'},serverRevision:1});
      await r.deltaJournal.activate({scope,localProjectId:'p',baselineId:'b'});
      const file=(name,time,bytes='same')=>new File([bytes],name,{type:'application/pdf',lastModified:time});
      const key='background:d';await r.writeFile(key,file('original.pdf',123));
      const equal=await r.writeFile(key,file('original.pdf',123),{validate:()=>true});
      const rename=await r.writeFile(key,file('renamed.pdf',123),{validate:()=>true});
      const modified=await r.writeFile(key,file('renamed.pdf',456),{validate:()=>true});
      const changed=await r.writeFile(key,file('renamed.pdf',456,'diff'),{validate:()=>true});
      const db=await r.openFilesDatabase();
      try{
        const data=await new Promise((resolve,reject)=>{
          const tx=db.transaction(['files','sentlog_delta_journal_v1'],'readonly');let saved,count;
          tx.objectStore('files').get(key).onsuccess=e=>saved=e.target.result;
          tx.objectStore('sentlog_delta_journal_v1').count().onsuccess=e=>count=e.target.result;
          tx.oncomplete=()=>resolve({saved,count});tx.onabort=()=>reject(tx.error);
        });
        return {identicalSuppressed:equal.written===false,renameWritten:rename.written===true,
          timestampWritten:modified.written===true,changedBytesWritten:changed.written===true,
          rows:data.count,isFile:data.saved instanceof File,name:data.saved.name,
          lastModified:data.saved.lastModified,text:await data.saved.text()};
      }finally{db.close();}
    }""")
    check(outcome == {
        "identicalSuppressed": True, "renameWritten": True, "timestampWritten": True,
        "changedBytesWritten": True, "rows": 4, "isFile": True, "name": "renamed.pdf",
        "lastModified": 456, "text": "diff"
    }, "Native IndexedDB File identity or byte-change handling failed: " + json.dumps(outcome))
    before = page.evaluate("() => fixture.snapshot()")
    page.evaluate("() => { window.__guard=fixture.guard(); }")
    page.add_script_tag(url=base + "/source/storage-diagnostics.js")
    report = page.evaluate("() => SentlogStorageDiagnostics.scan()")
    check(report["status"] == "complete", "Diagnostic could not scan a native record-store database")
    unchanged(page, before)


CASES = [
    ("mobile manual start, all stores, copy, readonly and File metadata", lambda p, b: manual_complete(p, b)),
    ("PC manual start and readonly diagnosis", lambda p, b: manual_complete(p, b, pc=True)),
    ("row limit is an explicitly partial result", partial_limit),
    ("unsupported enumeration is unmeasured, not zero", unsupported),
    ("cancel during native readonly enumeration preserves data", cancel_in_progress),
    ("collapsing the section cancels before measurement", cancel_before_measurement),
    ("closing settings cancels before measurement", lambda p, b: cancel_before_measurement(p, b, close_modal=True)),
    ("native File metadata is preserved by same-byte write suppression", file_metadata),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=["chromium", "webkit"], required=True)
    parser.add_argument("--output", type=Path, help="Optional JSON verification report")
    args = parser.parse_args()
    report = {"browser": args.browser, "scope": "loopback synthetic fixtures only",
              "physical_ios_tested": False, "physical_disk_usage_measured": False,
              "status": "running", "passed": [], "failures": []}
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            engine = getattr(playwright, args.browser)
            for name, run in CASES:
                with tempfile.TemporaryDirectory(prefix="sentlog-storage-native-") as profile:
                    try:
                        context = engine.launch_persistent_context(
                            profile, headless=True, viewport={"width": 390, "height": 844},
                            service_workers="block", accept_downloads=False,
                        )
                    except PlaywrightError as error:
                        report["status"] = "blocked"
                        report["blocker"] = str(error)
                        print(f"BLOCKED {args.browser}: {error}", file=sys.stderr)
                        break
                    try:
                        # Any unexpected request, including a production URL, is refused.
                        context.route("**/*", lambda route: route.continue_()
                                      if route.request.url.startswith(base + "/") else route.abort())
                        page = context.pages[0] if context.pages else context.new_page()
                        page.set_default_timeout(20000)
                        run(page, base)
                        report["passed"].append(name)
                        print(f"PASS {args.browser}: {name}", flush=True)
                    except Exception as error:
                        report["failures"].append({"name": name, "error": str(error)})
                        print(f"FAIL {args.browser}: {name}: {error}", file=sys.stderr)
                    finally:
                        context.close()
            if report["status"] != "blocked":
                report["status"] = "failed" if report["failures"] else "passed"
    finally:
        server.shutdown()
        server.server_close()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"browser": args.browser, "status": report["status"],
                      "passed": len(report["passed"]), "failures": len(report["failures"])}, ensure_ascii=False))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

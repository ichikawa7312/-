"""One native record-store scale scenario, using synthetic loopback data only.

Save 100 drawings containing 7,707,034 UTF-8 bytes (approximately 7.35 MiB),
create 52 real staging bindings plus the clock row, reload, and compare every
record and the native control-store SHA-256. No quota errors are injected.
This does not test physical iOS hardware, real accounts, or a full-disk device.
Missing browser binaries or OS dependencies are BLOCKED, never passing tests.
StorageManager.estimate() is optional diagnostic information; unsupported,
failed or timed-out measurements never skip the mandatory storage/hash checks.
"""
import argparse
import hashlib
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
RECORD_BYTES = 7_707_034
CHECKS = r"""
(() => {
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',PREFIX='__sentlog_record__:';
  const CONTROL='sentlog_delta_control_v1',LOG='sentlog_delta_journal_v1';
  const target=7707034,projectCount=52,drawingCount=100,encoder=new TextEncoder();
  const bytes=value=>encoder.encode(value).length;
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value)))))
    .map(value=>value.toString(16).padStart(2,'0')).join('');
  async function storageEstimate(){
    let timer;
    try{
      const storage=navigator.storage;
      if(typeof storage?.estimate!=='function')return {status:'unsupported'};
      const result=await Promise.race([storage.estimate(),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(Error('Storage estimate exceeded 2 seconds'),{name:'TimeoutError'})),2000);
      })]);
      return {...result,status:'available'};
    }catch(error){return {status:'error',error:{name:error?.name||'Error',message:String(error?.message||error)}};}
    finally{clearTimeout(timer);}
  }
  function text(length,seed){
    const output=new Uint8Array(length),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let state=seed|0;
    for(let i=0;i<length;i++){
      state^=state<<13;state^=state>>>17;state^=state<<5;
      output[i]=alphabet.charCodeAt((state>>>0)%alphabet.length);
    }
    return new TextDecoder().decode(output);
  }
  function entries(){
    const drawings=Array.from({length:drawingCount},(_,i)=>({id:'synthetic-drawing-'+i,name:'Synthetic drawing '+i}));
    const projects=Array.from({length:projectCount},(_,i)=>({id:'synthetic-project-'+i,name:'Synthetic project '+i,
      drawings:drawings.filter((_,j)=>j%projectCount===i)}));
    const values=[[WS,JSON.stringify({projects})]];
    let used=bytes(values[0][1]);
    for(let i=0;i<drawingCount;i++){
      const state={shapes:[{id:'synthetic-record-'+i,type:'point',x:10,y:20,memo:'',photos:[]}],collabDeletedRecords:[]};
      const size=Math.floor((target-used)/(drawingCount-i)),empty=JSON.stringify(state);
      assert(size>=bytes(empty),'Fixture target too small');
      state.shapes[0].memo=text(size-bytes(empty),0x12345678+i);
      const value=JSON.stringify(state);values.push([DRAW+drawings[i].id,value]);used+=bytes(value);
    }
    assert(used===target,'Fixture record byte count mismatch');
    return values;
  }
  async function readNative(){
    const db=await SentlogRecords.openFilesDatabase();
    try{
      assert(db.version===2,'Expected the real version-2 records schema');
      const data=await new Promise((resolve,reject)=>{
        const tx=db.transaction(['files',CONTROL,LOG],'readonly'),result={};
        for(const name of ['files',CONTROL,LOG]){
          const rows=[];result[name]=rows;
          const query=tx.objectStore(name).openCursor();
          query.onsuccess=()=>{const cursor=query.result;if(cursor){rows.push([cursor.key,cursor.value]);cursor.continue();}};
        }
        tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
      });
      return data;
    }finally{db.close();}
  }
  async function inspect(){
    const expected=entries(),native=await readNative(),rows=native.files.filter(([key])=>String(key).startsWith(PREFIX));
    const stored=new Map(rows.map(([key,value])=>[String(key).slice(PREFIX.length),value]));
    assert(stored.size===101&&SentlogRecords.keys().length===101,'Expected one workspace and 100 drawing records');
    let recordBytes=0;
    for(const [key,value] of expected){
      assert(stored.get(key)===value,'Native record bytes changed');
      assert(SentlogRecords.getItem(key)===value,'Editor mirror differs from native records');
      recordBytes+=bytes(value);
    }
    assert(recordBytes===target,'Saved record byte count changed');
    const controls=native[CONTROL],bindings=controls.filter(([,row])=>row?.kind==='binding');
    assert(controls.length===53&&bindings.length===52,'Expected exactly 52 bindings plus one clock row');
    assert(controls.some(([key,value])=>key==='clock'&&Number.isSafeInteger(value)),'Missing native clock');
    assert(bindings.every(([,row])=>row.phase==='staging'),'Synthetic binding phase changed');
    assert(native[LOG].length===0,'This scale fixture should not create edit history');
    SentlogRecords.assertSafe();
    assert(SentlogRecords.ready&&!SentlogRecords.pending&&!SentlogRecords.failed,'Writer is not durably settled');
    return {schemaVersion:2,drawings:drawingCount,projects:projectCount,managedEntries:stored.size,
      recordBytes,controlRows:controls.length,bindingRows:bindings.length,journalRows:native[LOG].length,
      controlJsonBytes:bytes(JSON.stringify(controls)),recordsSHA256:await hash(rows),controlsSHA256:await hash(controls),
      storageEstimate:await storageEstimate(),ready:SentlogRecords.ready,pending:SentlogRecords.pending,failed:SentlogRecords.failed};
  }
  window.nativeScaleProbe={
    async save(){
      const before=await storageEstimate(),start=performance.now();
      await SentlogRecords.init();
      SentlogRecords.batch(entries());await SentlogRecords.settled();
      const recordSaveMs=Math.round(performance.now()-start);
      for(let i=0;i<projectCount;i++)await SentlogRecords.deltaJournal.begin({
        scope:{ownerId:'synthetic-owner',projectId:'synthetic-cloud-'+i,deviceId:'synthetic-device'},
        localProjectId:'synthetic-project-'+i,actor:{deviceId:'synthetic-device',deviceName:'Synthetic native scale fixture'},serverRevision:1
      });
      await SentlogRecords.settled();
      return {before,recordSaveMs,totalSaveMs:Math.round(performance.now()-start),result:await inspect()};
    },
    async reload(){
      const start=performance.now();await SentlogRecords.init();
      return {initMs:Math.round(performance.now()-start),result:await inspect()};
    }
  };
})();
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=["chromium", "webkit"], required=True)
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or Path(tempfile.gettempdir()) / "sentlog-delta-app-record-scale" / f"{args.engine}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    source = (args.built_root / "sentlog/record-store.js").resolve()
    writer = source.read_bytes()
    report = {
        "engine": args.engine, "status": "running", "scope": "synthetic loopback data only",
        "physicalDeviceTested": False, "quotaFailureInjected": False,
        "playwrightVersion": package_version("playwright"), "sourceSHA256": hashlib.sha256(writer).hexdigest(),
        "expected": {"drawings": 100, "projects": 52, "recordBytes": RECORD_BYTES, "controlRows": 53},
        "blockedRequests": [],
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/record-store.js":
                body, mime = writer, "text/javascript; charset=utf-8"
            elif path == "/checks.js":
                body, mime = CHECKS.encode(), "text/javascript; charset=utf-8"
            elif path == "/":
                body, mime = (b'<!doctype html><title>Synthetic native storage scale</title>'
                              b'<script src="/record-store.js"></script><script src="/checks.js"></script>'), "text/html; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'none'")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    phase = "launch"
    try:
        with tempfile.TemporaryDirectory(prefix="sentlog-record-scale-") as profile, sync_playwright() as playwright:
            context = None
            try:
                context = getattr(playwright, args.engine).launch_persistent_context(
                    profile, headless=True, service_workers="block", accept_downloads=False,
                    viewport={"width": 390, "height": 844},
                )
                phase = "save"

                def route_request(route):
                    if route.request.url.startswith(base + "/"):
                        route.continue_()
                    else:
                        report["blockedRequests"].append(route.request.url)
                        route.abort()

                context.route("**/*", route_request)
                page = context.pages[0] if context.pages else context.new_page()
                page.set_default_timeout(30_000)
                report["browserVersion"] = context.browser.version if context.browser else None
                page.goto(base + "/")
                report["saved"] = page.evaluate("""() => Promise.race([
                    nativeScaleProbe.save(), new Promise((_,reject)=>setTimeout(()=>reject(Error('Native scale save exceeded 90 seconds')),90000))
                ])""")
                output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
                phase = "reload"
                page.reload()
                report["reloaded"] = page.evaluate("""() => Promise.race([
                    nativeScaleProbe.reload(), new Promise((_,reject)=>setTimeout(()=>reject(Error('Native scale reload exceeded 60 seconds')),60000))
                ])""")
                before, after = report["saved"]["result"], report["reloaded"]["result"]
                for key in ["recordsSHA256", "controlsSHA256", "recordBytes", "controlRows", "bindingRows", "managedEntries"]:
                    if before[key] != after[key]:
                        raise AssertionError(f"Native {key} changed after page reload")
                if report["blockedRequests"]:
                    raise AssertionError("The synthetic fixture attempted an unexpected external request")
                report["status"] = "passed"
                report["allHashesMatch"] = True
                print(f"PASS {args.engine}: 100 drawings, {RECORD_BYTES} record bytes, 53 control rows; all SHA-256 values survived reload", flush=True)
            finally:
                if context:
                    context.close()
    except Exception as error:
        report["status"] = "blocked" if phase == "launch" else "failed"
        report["phase"] = phase
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        print(f"{report['status'].upper()} {args.engine} ({phase}): {error}", file=sys.stderr, flush=True)
    finally:
        server.shutdown()
        server.server_close()
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"engine": args.engine, "status": report["status"], "report": str(output)}), flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

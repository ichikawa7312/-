"""Compare native Blob lifetime in frozen/current writers without retrying failures.

Twelve independent, synthetic-only persistent profiles exercise the unchanged
native-files-and-backups PREPARE: old/current writer x probe on/off x 3. Optional
readonly probes hash the live photo and seq 7 preimage/postimage before/after its
overwrite and after real replay/compaction. A probe failure remains a failure
even if the final snapshot succeeds. Every existing PREPARE assertion and the
complete native-byte snapshot still run. No maintenance UI operation is run.

Early reads may change scheduling, Blob references and garbage collection. The
unprobed arm deliberately installs no hook; comparison is diagnostic evidence,
not a claim that early hashing repairs the browser or proves a product cause.
Browser processes run only in the GitHub native-browser workflow.
"""
import argparse
import functools
import hashlib
import json
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from pathlib import Path
from urllib.parse import urlparse

from storage_maintenance_ui import (
    HTML, MODULES, PREPARE, bounded_playwright, deadline, evaluate_async,
    record_progress, write_json,
)

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SHA256 = "fa82b9f297c44ddaa91b9d72b9465da540bef422b23534190d278612a45f611a"
PROBE_PHASES = ("before-distinct-write", "after-distinct-write", "after-real-drain")
PHOTO_BYTES = 128 * 1024

INSTALL_PROBE = r"""expected => {
  const database='surveyFieldNoteDB',log='sentlog_delta_journal_v1',key='photo:one:different',seq=7;
  const state=window.__blobLifetime={events:[],phases:[]};
  const describe=error=>({name:error?.name||'Error',message:String(error?.message||error)});
  async function report(event){
    const detail={stage:'blob-probe/'+event.phase,elapsedMs:Math.round(performance.now()),...event};
    state.events.push(detail);
    // Send only plain metadata, never a Blob or its contents, to the report.
    if(typeof window.__blobLifetimeProgress==='function')await window.__blobLifetimeProgress(detail);
  }
  async function inspect(phase,value,path,sha256){
    const event={phase,database,path,expectedSHA256:sha256,present:value!==undefined,ok:false};
    try{
      if(!(value instanceof Blob))throw Error('Expected native Blob at '+path);
      Object.assign(event,{size:value.size,type:value.type});
      const bytes=await value.arrayBuffer();
      event.sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
      if(value.size!==expected.size||value.type!=='image/jpeg'||event.sha256!==sha256)
        throw Error('Native Blob bytes, size or MIME changed at '+path);
      event.ok=true;
    }catch(error){event.error=describe(error);}
    await report(event);
  }
  window.__maintenanceBlobProbe=async phase=>{
    state.phases.push(phase);let db;
    try{
      db=await SentlogRecords.openFilesDatabase();
      const raw=await new Promise((resolve,reject)=>{
        const tx=db.transaction(['files',log],'readonly');let live,row;
        tx.objectStore('files').get(key).onsuccess=e=>live=e.target.result;
        tx.objectStore(log).get(seq).onsuccess=e=>row=e.target.result;
        tx.oncomplete=()=>resolve({live,row});
        tx.onabort=()=>reject(tx.error||Error('Native probe transaction aborted'));
      });
      await inspect(phase,raw.live,database+'/files/'+key,
        phase==='before-distinct-write'?expected.oldSHA256:expected.currentSHA256);
      const path=database+'/'+log+'/'+seq;
      if(phase==='before-distinct-write'){
        await report({phase,database,path,present:raw.row!==undefined,ok:raw.row===undefined,
          ...(raw.row===undefined?{}:{error:{name:'Error',message:'Journal seq 7 existed before the distinct overwrite'}})});
      }else{
        const kind=phase==='after-real-drain'?'sentlog-file-retention':'sentlog-app-intent';
        const index=Array.isArray(raw.row?.files)?raw.row.files.findIndex(file=>file?.key===key):-1;
        const valid=raw.row?.kind===kind&&index>=0;
        await report({phase,database,path,present:raw.row!==undefined,kind:raw.row?.kind||null,
          expectedKind:kind,fileIndex:index,ok:valid,
          ...(valid?{}:{error:{name:'Error',message:'Expected journal kind or photo entry is missing'}})});
        if(index>=0){
          await inspect(phase,raw.row.files[index].before,path+'.files['+index+'].before',expected.oldSHA256);
          await inspect(phase,raw.row.files[index].after,path+'.files['+index+'].after',expected.currentSHA256);
        }
      }
    }catch(error){await report({phase,database,path:database+'/probe-read',ok:false,error:describe(error)});}
    finally{if(db)db.close();}
  };
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("chromium", "webkit"), required=True)
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--baseline-writer", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=3)
    args = parser.parse_args()
    args.out = args.out.resolve()
    if not args.out.is_relative_to(Path("/tmp")):
        parser.error("--out must be under /tmp; existing user profiles are never used")
    if args.repetitions < 1 or args.repetitions > 10:
        parser.error("--repetitions must be between 1 and 10")
    args.out.mkdir(parents=True, exist_ok=True)
    expected = {"size": PHOTO_BYTES,
                "oldSHA256": hashlib.sha256(bytes([66]) * PHOTO_BYTES).hexdigest(),
                "currentSHA256": hashlib.sha256(bytes([65]) * PHOTO_BYTES).hexdigest()}
    summary = {"format": "sentlog-native-blob-lifetime-diagnostic-v1", "status": "running",
               "engine": args.engine, "repetitions": args.repetitions, "expectedCases": args.repetitions * 4,
               "cases": [], "expectedPhoto": expected, "customerDataUsed": False,
               "productionOriginAccessed": False, "physicalDeviceTested": False,
               "externalTrafficBlocked": True, "freshPersistentProfilePerCase": True,
               "retries": 0, "existingPrepareAndSnapshotUnchanged": True,
               "maintenanceUIOperated": False, "probeMayAffectBlobLifetimeAndScheduling": True,
               "fixtureSHA256": hashlib.sha256((Path(__file__).parent / "storage_maintenance_ui.py").read_bytes()).hexdigest(),
               "diagnosticSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    summary_path = args.out / "summary.json"
    write_json(summary_path, summary)
    server = None
    try:
        from playwright.sync_api import sync_playwright
        summary["playwrightVersion"] = package_version("playwright")
        if summary["playwrightVersion"] != "1.62.0":
            raise RuntimeError("Playwright 1.62.0 is required; a different package is not a verified substitute")
        writers = {"v215": args.baseline_writer.read_bytes(),
                   "current": (args.built_root.resolve() / "sentlog" / "record-store.js").read_bytes()}
        if hashlib.sha256(writers["v215"]).hexdigest() != BASELINE_SHA256:
            raise RuntimeError("The supplied baseline writer does not match frozen public v2.15")
        with tempfile.TemporaryDirectory(prefix="sentlog-blob-diagnostic-", dir="/tmp") as temporary, \
                tempfile.TemporaryDirectory(prefix="sentlog-blob-profiles-", dir="/tmp") as profiles:
            summary["sourceModules"] = {}
            for variant, writer in writers.items():
                package = Path(temporary) / variant
                package.mkdir()
                (package / "index.html").write_text(HTML)
                summary["sourceModules"][variant] = []
                for name in MODULES[:-1]:
                    data = writer if name == "record-store.js" else (args.built_root.resolve() / "sentlog" / name).read_bytes()
                    (package / name).write_bytes(data)
                    summary["sourceModules"][variant].append({"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})

            class Handler(SimpleHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def end_headers(self):
                    self.send_header("Cache-Control", "no-store")
                    super().end_headers()

            server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=temporary))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            with bounded_playwright(sync_playwright) as playwright:
                # Interleave writer/probe arms instead of batching one writer's
                # runs together. Each receives a new browser/profile and no retry.
                for repetition in range(1, args.repetitions + 1):
                    for probed in (False, True):
                        for variant in ("v215", "current"):
                            name = f"{variant}-{'probed' if probed else 'unprobed'}-{repetition}"
                            case = {"name": name, "status": "running", "writer": variant, "probeEnabled": probed,
                                    "repetition": repetition, "blockedRequests": [], "pageErrors": [], "crashes": [],
                                    "probes": [], "startedAtUnix": round(time.time(), 3)}
                            destination = args.out / (name + ".json")
                            entry = {"name": name, "status": "running", "report": destination.name}
                            summary["cases"].append(entry)
                            write_json(summary_path, summary)
                            record_progress(case, destination, "case-start")
                            context = page = None
                            try:
                                with deadline(45, "fresh native diagnostic profile"):
                                    context = getattr(playwright, args.engine).launch_persistent_context(
                                        str(Path(profiles) / name), headless=True, timeout=30000,
                                        service_workers="block", viewport={"width": 320, "height": 760}, locale="ja-JP")
                                    page = context.pages[0] if context.pages else context.new_page()
                                if context.browser:
                                    case["browserVersion"] = context.browser.version
                                    summary["browserVersion"] = context.browser.version
                                page.set_default_timeout(30000)

                                def progress(detail, current=case, path=destination):
                                    record_progress(current, path, "browser:" + str(detail.get("stage", "unknown")), detail)

                                def probe_progress(detail, current=case, path=destination):
                                    current["probes"].append(detail)
                                    record_progress(current, path, "browser:" + str(detail.get("stage", "unknown")), detail)

                                def route_request(route, current=case):
                                    url = urlparse(route.request.url)
                                    if f"{url.scheme}://{url.netloc}" == origin:
                                        route.continue_()
                                    else:
                                        current["blockedRequests"].append({"scheme": url.scheme, "host": url.hostname})
                                        route.abort()

                                context.route("**/*", route_request)
                                page.on("pageerror", lambda error, current=case: current["pageErrors"].append(str(error)[:1000]))
                                page.on("crash", lambda _page, current=case: current["crashes"].append({"atUnix": time.time()}))
                                page.expose_function("__maintenanceProgress", progress)
                                record_progress(case, destination, "loading-real-modules")
                                page.goto(origin + "/" + variant + "/", wait_until="load")
                                for module in MODULES[:-1]:
                                    page.add_script_tag(url=origin + "/" + variant + "/" + module)
                                if probed:
                                    page.expose_function("__blobLifetimeProgress", probe_progress)
                                    page.evaluate(INSTALL_PROBE, expected)
                                record_progress(case, destination, "running-unchanged-native-prepare")
                                case["setup"] = evaluate_async(page, PREPARE, "native-files-and-backups", label=name + " native preparation")
                                if probed:
                                    observed = page.evaluate("({phases:__blobLifetime.phases,events:__blobLifetime.events})")
                                    case["probes"] = observed["events"]
                                    case["probePhases"] = observed["phases"]
                                    assert observed["phases"] == list(PROBE_PHASES), "One or more native probe phases did not run"
                                    assert len(observed["events"]) == 10, "Not every expected native Blob path was observed"
                                    assert all(event.get("ok") is True for event in observed["events"]), "A native Blob probe failed; all observations are retained"
                                assert not case["blockedRequests"], "Unexpected external network request"
                                assert not case["pageErrors"] and not case["crashes"], "Browser error/crash observed"
                                case["status"] = "passed"
                            except Exception as error:
                                case["status"] = "failed"
                                case["error"] = str(error)[:6000]
                            finally:
                                record_progress(case, destination, "closing-native-context")
                                if context:
                                    try:
                                        with deadline(15, "native diagnostic context close"):
                                            context.close()
                                    except Exception as error:
                                        case["status"] = "failed"
                                        case["cleanupError"] = str(error)[:1000]
                                record_progress(case, destination, "case-finished")
                                entry.update(status=case["status"], sha256=hashlib.sha256(destination.read_bytes()).hexdigest())
                                write_json(summary_path, summary)
            summary["status"] = "passed" if len(summary["cases"]) == summary["expectedCases"] and all(case["status"] == "passed" for case in summary["cases"]) else "failed"
    except Exception as error:
        summary["status"] = "blocked" if not summary["cases"] else "failed"
        summary["error"] = str(error)[:6000]
    finally:
        if server:
            server.shutdown()
            server.server_close()
        write_json(summary_path, summary)
    print(json.dumps({"status": summary["status"], "engine": args.engine, "cases": summary["cases"]}), flush=True)
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

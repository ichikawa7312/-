"""Diagnose synthetic Cache API response inputs in four fresh disposable profiles.

This probe does not load Sentlog's writer or staging code and is not a complete
reproduction of the record/cache boundary case or the user's storage failure.
It never inspects browser profile files, internal quota information or user data.
Every variant attempts eight puts and records readback after put 1 and put 8.
Failures remain failures; later variants still collect their own diagnostics.
"""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from pathlib import Path
from urllib.parse import urlparse


MIB = 1024 * 1024
VARIANTS = ["string", "uint8array", "blob", "http-fetch"]


def binary_payload(index):
    # Same xorshift32 byte series as the existing boundary fixture's cache seed.
    state = 0x12457812 + index
    result = bytearray(MIB)
    for offset in range(MIB):
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        result[offset] = state & 255
    return bytes(result)


def short_text(index):
    return f"synthetic-cache-response-{index}\n"


INPUTS = r"""
  const MIB=1024*1024;
  function binaryBytes(index){
    const output=new Uint8Array(MIB);let state=(0x12457812+index)|0;
    for(let i=0;i<output.length;i++){
      state^=state<<13;state^=state>>>17;state^=state<<5;output[i]=(state>>>0)&255;
    }
    return output;
  }
  const shortText=index=>'synthetic-cache-response-'+index+'\n';
  async function makeResponse(variant,index,url){
    const headers={'Content-Type':'application/octet-stream'};
    if(variant==='string')return new Response(shortText(index),{headers});
    if(variant==='uint8array')return new Response(binaryBytes(index),{headers});
    if(variant==='blob')return new Response(new Blob([binaryBytes(index)],{type:headers['Content-Type']}),{headers});
    if(variant==='http-fetch')return fetch(url,{cache:'no-store'});
    throw Error('Unknown synthetic variant');
  }
"""

PROBE = "async config=>{\n" + INPUTS + r"""
  const started=performance.now(),deadline=started+60000,operationTimeoutMs=5000;
  const elapsed=()=>Math.round(performance.now()-started);
  const errors=[],result={variant:config.variant,cacheName:config.cacheName,variantBudgetMs:60000,
    operationTimeoutMs,puts:[],checkpoints:[],apiErrors:errors,collectionStatus:'collecting'};
  window.__cacheResponseProbeResult=result;
  const errorJSON=e=>({name:e?.name||'Error',message:String(e?.message||e),code:e?.code||null});
  async function attempt(label,fn){
    const entry={label,startedAtMs:elapsed()},remaining=deadline-performance.now();let timer;
    if(remaining<=0){
      Object.assign(entry,{status:'not_started',error:{name:'ProbeDeadlineError',message:'Variant diagnostic budget exhausted',code:'PROBE_DEADLINE'}});
      errors.push(entry);return entry;
    }
    try{
      entry.value=await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{
        timer=setTimeout(()=>{const e=Error('Diagnostic operation timed out');e.name='ProbeTimeoutError';e.code='PROBE_TIMEOUT';reject(e);},Math.min(operationTimeoutMs,remaining));
      })]);entry.status='fulfilled';
    }catch(error){entry.status='rejected';entry.error=errorJSON(error);errors.push(entry);
      if(error?.code==='PROBE_TIMEOUT')entry.inFlightOperationMayContinue=true;
    }finally{clearTimeout(timer);entry.completedAtMs=elapsed();}
    return entry;
  }
  const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  const metadata=response=>response?{present:true,status:response.status,statusText:response.statusText,
    type:response.type,url:response.url,bodyUsed:response.bodyUsed,redirected:response.redirected,
    headers:[...response.headers.entries()].sort(([a],[b])=>a.localeCompare(b))}:
    {present:false,status:null,statusText:null,type:null,url:null,bodyUsed:null,redirected:null,headers:null};
  async function describe(response,label){
    const value={...metadata(response),body:null};
    if(response){
      const read=await attempt(label+' body',async()=>{const bytes=await response.clone().arrayBuffer();return {bytes:bytes.byteLength,sha256:await digest(bytes)};});
      if(read.status==='fulfilled')value.body=read.value;else value.bodyReadError=read.error;
    }
    return value;
  }
  const matches=(read,expected)=>read.status==='fulfilled'&&read.value?.present===true&&read.value.status===200&&
    read.value.body?.bytes===expected.bytes&&read.value.body?.sha256===expected.sha256;
  let cache;
  result.initialCacheNames=await attempt('initial cache names',()=>caches.keys());
  result.open=await attempt('open synthetic cache',async()=>{cache=await caches.open(config.cacheName);return {cacheName:config.cacheName};});
  async function checkpoint(label,count){
    const snapshot={label,startedAtMs:elapsed(),reads:[]};
    snapshot.cacheNames=await attempt(label+' cache names',()=>caches.keys());
    snapshot.handleKeys=await attempt(label+' seeded handle keys',async()=>{
      if(!cache)throw Error('Seeded cache handle is unavailable');
      return (await cache.keys()).map(request=>({url:request.url,method:request.method}));
    });
    for(let index=0;index<count;index++){
      const url=location.origin+'/synthetic-cache/'+index,expected=config.expected[index];
      const row={index,url,expected};
      row.handleMatch=await attempt(label+' handle match '+index,async()=>{
        if(!cache)throw Error('Seeded cache handle is unavailable');return describe(await cache.match(url),label+' handle '+index);
      });
      row.namedMatch=await attempt(label+' named match '+index,async()=>describe(await caches.match(url,{cacheName:config.cacheName}),label+' named '+index));
      row.unfilteredMatch=await attempt(label+' unfiltered match '+index,async()=>describe(await caches.match(url),label+' unfiltered '+index));
      row.matchesExpected={handle:matches(row.handleMatch,expected),named:matches(row.namedMatch,expected),unfiltered:matches(row.unfilteredMatch,expected)};
      snapshot.reads.push(row);
    }
    const expectedKeys=Array.from({length:count},(_,index)=>location.origin+'/synthetic-cache/'+index).sort();
    snapshot.keysMatchExpected=snapshot.handleKeys.status==='fulfilled'&&
      JSON.stringify(snapshot.handleKeys.value.map(row=>row.url).sort())===JSON.stringify(expectedKeys);
    snapshot.allReadbacksMatch=snapshot.reads.every(row=>Object.values(row.matchesExpected).every(Boolean));
    snapshot.completedAtMs=elapsed();result.checkpoints.push(snapshot);
  }
  for(let index=0;index<8;index++){
    const url=location.origin+'/synthetic-cache/'+index,entry={index,url,expected:config.expected[index]};let response;
    entry.construct=await attempt('construct response '+index,async()=>{response=await makeResponse(config.variant,index,url);return metadata(response);});
    entry.seedResponse=await attempt('inspect seed response '+index,()=>describe(response,'seed '+index));
    entry.seedMatchesExpected=matches(entry.seedResponse,entry.expected);
    entry.put=await attempt('put '+index,async()=>{
      if(!cache||!response)throw Error('Seed response or cache handle is unavailable');
      await cache.put(url,response);return {putPromiseResolved:true};
    });
    result.puts.push(entry);
    if(index===0)await checkpoint('after-first-put',1);
  }
  await checkpoint('after-eight-puts',8);
  result.finishedAtMs=elapsed();
  result.collectionStatus=errors.some(error=>error.error?.code==='PROBE_DEADLINE')?'partial':'completed';
  const allMatched=result.initialCacheNames.status==='fulfilled'&&result.initialCacheNames.value.length===0&&
    result.puts.length===8&&result.puts.every(entry=>entry.seedMatchesExpected&&entry.put.status==='fulfilled')&&
    result.checkpoints.every(snapshot=>snapshot.keysMatchExpected&&snapshot.allReadbacksMatch);
  result.outcome=errors.length?'api_error':allMatched?'matched':'mismatch';
  return result;
}
"""


def input_manifest(payloads):
    return {variant: [{"index": index, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                      for index, data in enumerate([short_text(i).encode() for i in range(8)]
                                                   if variant == "string" else payloads)]
            for variant in VARIANTS}


def check_inputs(payloads, manifest):
    program = """
const assert=require('assert/strict'),crypto=require('crypto');
const expected=EXPECTED;
(async()=>{
INPUTS
  const rows=[];
  for(const variant of ['string','uint8array','blob'])for(let index=0;index<8;index++){
    const response=await makeResponse(variant,index,'http://127.0.0.1/synthetic-cache/'+index);
    const bytes=Buffer.from(await response.clone().arrayBuffer());
    const actual={index,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
    assert.deepEqual(actual,expected[variant][index]);assert.equal(response.status,200);assert.equal(response.bodyUsed,false);rows.push({variant,...actual});
  }
  assert.deepEqual(expected['http-fetch'],expected.uint8array);assert.deepEqual(expected.blob,expected.uint8array);
  console.log(JSON.stringify({status:'input_checks_completed',nativeBrowserExecuted:false,httpFetchExecuted:false,responseChecks:rows},null,2));
})().catch(error=>{console.error(error);process.exit(1);});
"""
    program = program.replace("EXPECTED", json.dumps(manifest), 1).replace("INPUTS", INPUTS, 1)
    subprocess.run(["node", "--check"], input="(" + PROBE + ");", text=True, check=True)
    subprocess.run(["node", "-e", program], check=True)
    assert len(payloads) == 8 and all(len(data) == MIB for data in payloads)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=["chromium", "webkit"])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check-inputs", action="store_true")
    args = parser.parse_args()
    if not args.engine and not args.check_inputs:
        parser.error("--engine is required for native diagnostics")
    payloads = [binary_payload(index) for index in range(8)]
    manifest = input_manifest(payloads)
    if args.check_inputs:
        check_inputs(payloads, manifest)
        return 0
    output = args.output or Path("/tmp/sentlog-delta-app-cache-response-probe") / (args.engine + ".json")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"format": "sentlog-synthetic-cache-response-probe-v1", "engine": args.engine,
              "status": "collecting", "allVariantsMatched": False, "capturedErrorCount": 0,
              "scope": "Cache API only; each variant has a new disposable profile. Sentlog writer and staging are not loaded.",
              "fullBoundaryCaseReproduced": False, "actualUserStorageFailureReproduced": False,
              "profileFilesInspected": False, "quotaOverridesUsed": False, "internalBrowserInformationRead": False,
              "physicalDeviceTested": False, "fixtureSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "probeSourceSHA256": hashlib.sha256(PROBE.encode()).hexdigest(), "inputs": manifest,
              "blockedRequests": [], "httpPayloadsServed": [],
              "variants": [{"variant": variant, "collectionStatus": "not_run"} for variant in VARIANTS]}

    def save():
        temporary = output.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(output)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            path = urlparse(self.path).path
            match = re.fullmatch(r"/synthetic-cache/([0-7])", path)
            if path == "/":
                body, mime = b'<!doctype html><meta charset="utf-8"><title>Synthetic Cache API response probe</title>', "text/html; charset=utf-8"
            elif match:
                index = int(match.group(1))
                body, mime = payloads[index], "application/octet-stream"
                report["httpPayloadsServed"].append({"index": index, "bytes": len(body), "sha256": manifest["http-fetch"][index]["sha256"]})
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            if path == "/":
                self.send_header("Content-Security-Policy", "default-src 'none'; connect-src 'self'; worker-src 'none'")
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    save()
    try:
        from playwright.sync_api import sync_playwright
        report["playwrightVersion"] = package_version("playwright")
        with sync_playwright() as playwright:
            for entry in report["variants"]:
                context = page = None
                started = time.monotonic()
                diagnostics = {"events": [], "dropped": 0, "errorCount": 0, "warningCount": 0,
                               "maxEvents": 100, "maxMessageChars": 4096}
                entry["pageDiagnostics"] = diagnostics
                entry["collectionStatus"] = "running"
                save()

                def page_event(kind, message, location=None):
                    diagnostics["warningCount" if kind == "warning" else "errorCount"] += 1
                    if len(diagnostics["events"]) >= diagnostics["maxEvents"]:
                        diagnostics["dropped"] += 1
                        return
                    text = str(message)
                    event = {"kind": kind, "elapsedMs": round((time.monotonic()-started)*1000),
                             "message": text[:4096], "truncated": len(text) > 4096}
                    if location is not None:
                        event["location"] = location
                    diagnostics["events"].append(event)

                with tempfile.TemporaryDirectory(prefix="sentlog-cache-response-") as profile:
                    try:
                        context = getattr(playwright, args.engine).launch_persistent_context(
                            profile, headless=True, service_workers="block", accept_downloads=False,
                            viewport={"width": 390, "height": 844}, timeout=15000)
                        entry["browserVersion"] = context.browser.version if context.browser else None

                        def route_request(route):
                            if route.request.url.startswith(origin + "/"):
                                route.continue_()
                            else:
                                report["blockedRequests"].append(route.request.url)
                                route.abort()

                        context.route("**/*", route_request)
                        page = context.pages[0] if context.pages else context.new_page()
                        page.on("console", lambda message: page_event(message.type, message.text, message.location)
                                if message.type in ["warning", "error"] else None)
                        page.on("pageerror", lambda error: page_event("pageerror", error))
                        page.goto(origin + "/", timeout=15000)
                        config = {"variant": entry["variant"], "cacheName": "sentlog-synthetic-response-" + entry["variant"],
                                  "expected": manifest[entry["variant"]]}
                        entry["result"] = page.evaluate(PROBE, config)
                        entry["collectionStatus"] = entry["result"]["collectionStatus"]
                    except Exception as error:
                        entry["collectionStatus"] = "incomplete"
                        entry["error"] = {"type": type(error).__name__, "message": str(error)}
                    finally:
                        if context:
                            try:
                                context.close()
                            except Exception as error:
                                entry["closeError"] = str(error)
                                entry["collectionStatus"] = "incomplete"
                        entry["elapsedSeconds"] = round(time.monotonic()-started, 3)
                        save()
                print(json.dumps({"variant": entry["variant"], "collectionStatus": entry["collectionStatus"],
                                  "outcome": entry.get("result", {}).get("outcome", "setup_error")}), flush=True)
        complete = all(entry["collectionStatus"] == "completed" for entry in report["variants"])
        report["status"] = "diagnostics_completed" if complete else "diagnostics_incomplete"
        report["allVariantsMatched"] = complete and not report["blockedRequests"] and all(
            entry.get("result", {}).get("outcome") == "matched" for entry in report["variants"])
        report["capturedErrorCount"] = sum(entry["pageDiagnostics"]["errorCount"] for entry in report["variants"])
        return 0 if report["allVariantsMatched"] and not report["capturedErrorCount"] else 1
    except Exception as error:
        report["status"] = "diagnostics_incomplete"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        return 1
    finally:
        server.shutdown()
        server.server_close()
        save()
        print(json.dumps({"engine": args.engine, "status": report["status"],
                          "allVariantsMatched": report["allVariantsMatched"],
                          "capturedErrorCount": report["capturedErrorCount"], "report": str(output)}), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())

"""Synthetic native record/cache comparison; never an actual-quota reproduction.

Reuse the production recovery/writer and native SHA checks from the existing
pressure fixture. Five fresh profiles compare non-source CacheStorage payloads,
reported usage below/across 64 MiB, and large versus small existing workspaces.
No worker, customer data, quota override, internal browser page, retry or connected
profile is used. Unsupported estimates never count as measured boundary coverage.
"""
import argparse
import ast
import hashlib
import json
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
MIB = 1024 * 1024
BOUNDARY = 64 * MIB
MODULES = ["blob-sha256.js", "backup-format.js", "startup-backup-recovery.js", "record-store.js"]
BASE_FIXTURE = Path(__file__).with_name("record_storage_pressure_ui.py")
CASES = [
    {"id": "no-cache-below-large", "cacheMiB": 0, "targetMiB": 56, "smallWorkspace": False},
    {"id": "cache-below-large", "cacheMiB": 8, "targetMiB": 56, "smallWorkspace": False},
    {"id": "no-cache-cross-large", "cacheMiB": 0, "targetMiB": 63.75, "smallWorkspace": False},
    {"id": "cache-cross-large", "cacheMiB": 8, "targetMiB": 63.75, "smallWorkspace": False},
    {"id": "cache-cross-small", "cacheMiB": 8, "targetMiB": 63.75, "smallWorkspace": True},
]

# All content and identifiers are synthetic. Aggregate sizes follow the observed
# nine-value batch; the large before-image size is a reconstruction, not a direct
# independent measurement of the affected durable workspace.
MODEL = r"""
  async function makeModel(includeBackup){
    const config=window.__boundaryCase;
    assert(config&&typeof config.smallWorkspace==='boolean','Missing synthetic case');
    const projects=Array.from({length:6},(_,i)=>({id:'synthetic-project-'+i,name:'Synthetic project '+i,
      updatedAt:100,drawings:[{id:'synthetic-drawing-'+i,name:'Synthetic drawing '+i}]}));
    const states=new Map(projects.map((project,i)=>[project.drawings[0].id,
      {shapes:[{id:'synthetic-record-'+i,type:'point',x:10,y:20,memo:'',photos:[]}],collabDeletedRecords:[]}]));
    const attachmentManifest=[],backupFiles=[];
    for(let i=0;i<4;i++){
      const drawing=projects[i<2?0:1].drawings[0],key='photo:'+drawing.id+':synthetic-photo-'+i;
      const blob=new Blob([randomBytes(MIB,0x34567812+i)],{type:'image/jpeg'}),sha256=await blobHash(blob);
      states.get(drawing.id).shapes[0].photos.push({id:'synthetic-photo-'+i,size:MIB,type:blob.type,sha256});
      attachmentManifest.push({key,size:MIB,type:blob.type,name:null,lastModified:null,sha256});
      if(includeBackup)backupFiles.push({key,type:blob.type,name:'',data:await dataUrl(blob)});
    }
    const largeWorkspace={projects};
    const largeBefore=padded(largeWorkspace,projects[5],'syntheticPadding',2362793,0x23456789);
    let before=largeBefore;
    if(config.smallWorkspace){
      const small=JSON.parse(largeBefore);
      before=padded(small,small.projects[5],'syntheticPadding',16384,0x23456789);
    }
    const workspace=JSON.parse(before),initial=new Map([[WS,before]]);
    for(const project of projects)initial.set(SYNC+project.id,JSON.stringify({revision:0,restored_backup:true,local_updated_at:100}));
    for(const [id,state]of states)initial.set(DRAW+id,JSON.stringify(state));
    const project={id:'synthetic-project-6',name:'Synthetic receiving project',updatedAt:200,drawings:[]};
    const incoming=new Map(),newDrawings=[];
    for(let i=0;i<7;i++){
      const meta={id:'synthetic-incoming-drawing-'+i,name:'Synthetic incoming drawing '+i};
      const state={shapes:[{id:'synthetic-incoming-record-'+i,type:'point',x:30,y:40,memo:'',photos:[]}],collabDeletedRecords:[]};
      const target=Math.floor(790390*(i+1)/7)-Math.floor(790390*i/7);
      incoming.set(DRAW+meta.id,padded(state,state.shapes[0],'memo',target,0x45678123+i));
      project.drawings.push(meta);newDrawings.push({meta,state});
    }
    const afterWorkspace={projects:[...projects,project]};
    incoming.set(WS,padded(afterWorkspace,project,'syntheticPadding',2438857,0x32145678));
    const sync={revision:1,base_snapshot:{version:1,project,drawings:newDrawings}};
    incoming.set(SYNC+project.id,padded(sync,sync,'syntheticPadding',869336,0x56781234));
    const final=new Map(initial);for(const [key,value]of incoming)final.set(key,value);
    assert(incoming.size===9&&[...incoming.values()].reduce((n,value)=>n+bytes(value),0)===4098583,
      'Synthetic nine-value batch byte shape changed');
    assert(bytes(incoming.get(WS))===2438857,'Synthetic after workspace changed');
    return {initial,final,incoming,attachmentManifest,cutoffManifest:attachmentManifest.slice(0,2),
      backup:includeBackup?new Blob([JSON.stringify({format:'sentlog-backup',version:1,exportedAt:'2026-01-01T00:00:00.000Z',
        workspace,drawingStates:Object.fromEntries(states),files:backupFiles})],{type:'application/json'}):null};
  }
"""

AUXILIARY = r"""
(() => {
  'use strict';
  const B=window.__boundaryInternals,MIB=1024*1024;
  const BALLAST='sentlog_synthetic_boundary_ballast',CACHE='sentlog-synthetic-boundary-cache';
  const MARKER='sentlogRecordsReadyV130',SENTINEL='sentlogSyntheticBoundarySentinel';
  const assert=(yes,message,details)=>{if(!yes){const error=Error(message);if(details)error.details=details;throw error;}};
  const errorJSON=e=>({name:e?.name||'Error',message:String(e?.message||e),code:e?.code||null,
    ...(e?.details?{details:e.details}:{})});
  const writerEvents=[],start=performance.now();
  const cacheSeedPuts=[];
  let ballast=[],watching=false,cacheHandleRef=null,cacheHandleState='not-seeded',firstCacheReadFailure=null;
  const writer=()=>({ready:SentlogRecords.ready,pending:SentlogRecords.pending,failed:SentlogRecords.failed,
    issues:SentlogRecords.issues,recordFailureDetails:SentlogRecords.recordFailureDetails});
  const sorted=value=>[...value].sort(([a],[b])=>a<b?-1:a>b?1:0);
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Native transaction aborted'));tx.onerror=()=>{};});
  async function inventory(){
    assert(typeof indexedDB.databases==='function','Read-only database listing is unavailable');
    return (await indexedDB.databases()).map(item=>({name:item.name,version:item.version})).sort((a,b)=>a.name.localeCompare(b.name));
  }
  // A race between listing and open aborts upgrade rather than recreating a DB.
  window.boundaryStrictReadOpen=async name=>{
    assert((await inventory()).some(item=>item.name===name),'READ_ONLY_DATABASE_MISSING: '+name);
    return new Promise((resolve,reject)=>{
      let finished=false;const q=indexedDB.open(name);
      const fail=error=>{if(finished)return;finished=true;clearTimeout(timer);reject(error);};
      const timer=setTimeout(()=>fail(Error('Read-only open timed out')),5000);
      q.onupgradeneeded=()=>{q.transaction.abort();fail(Error('READ_ONLY_DATABASE_DISAPPEARED: '+name));};
      q.onerror=()=>fail(q.error||Error('Read-only open failed'));
      q.onblocked=()=>fail(Error('Read-only open blocked'));
      q.onsuccess=()=>{if(finished){q.result.close();return;}finished=true;clearTimeout(timer);resolve(q.result);};
    });
  };
  async function readBallast(){
    const db=await window.boundaryStrictReadOpen(BALLAST);
    try{
      assert(db.version===1&&JSON.stringify([...db.objectStoreNames])==='["payload"]','Ballast schema changed');
      const rows=await new Promise((resolve,reject)=>{
        const tx=db.transaction('payload','readonly'),result=[],q=tx.objectStore('payload').openCursor();
        q.onsuccess=()=>{const c=q.result;if(c){result.push([c.key,c.value]);c.continue();}};
        tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||Error('Ballast read aborted'));
      });
      const manifest=[];for(const [key,value]of rows){
        assert(value instanceof Blob,'Ballast payload is not a Blob');
        manifest.push({key,size:value.size,sha256:await B.blobHash(value)});
      }
      const expected=[...ballast].sort((a,b)=>a.key.localeCompare(b.key));
      assert(JSON.stringify(manifest)===JSON.stringify(expected),'Ballast SHA-256 manifest changed');
      return {rows:manifest.length,bytes:manifest.reduce((n,item)=>n+item.size,0),sha256:await B.hash(manifest),manifest};
    }finally{db.close();}
  }
  const responseMetadata=response=>response?{present:true,status:response.status,type:response.type,
    url:response.url,headers:[...response.headers.entries()].sort(([a],[b])=>a.localeCompare(b))}:
    {present:false,status:null,type:null,url:null,headers:null};
  async function responseDetails(response){
    const result={...responseMetadata(response),body:null};
    if(response)try{
      const value=await response.clone().arrayBuffer();
      result.body={bytes:value.byteLength,sha256:await B.digest(value)};
    }catch(error){result.bodyReadError=errorJSON(error);}
    return result;
  }
  async function cacheReadDetails(url,response){
    const read=async fn=>{try{return await fn();}catch(error){return {error:errorJSON(error)};}};
    // Do not keep a strong reference alive between seed and failed readback.
    const handle=cacheHandleRef?.deref();
    const details={url,cacheName:CACHE,elapsedMs:Math.round(performance.now()-start),
      namedMatch:await read(()=>responseDetails(response)),
      unfilteredMatch:await read(async()=>responseDetails(await caches.match(url))),
      seededHandle:{status:cacheHandleRef?(handle?'available':'collected'):cacheHandleState}};
    if(handle){
      details.seededHandle.keys=await read(async()=>(await handle.keys()).map(request=>({url:request.url,method:request.method})));
      details.seededHandle.match=await read(async()=>responseDetails(await handle.match(url)));
    }
    return details;
  }
  async function inspectCache(){
    const count=window.__boundaryCase.cacheMiB,names=(await caches.keys()).sort();
    assert(JSON.stringify(names)===JSON.stringify(count?[CACHE]:[]),'CacheStorage names changed');
    const manifest=[];
    for(let i=0;i<count;i++){
      const path='/synthetic-cache/'+i;
      // match reads a named cache without creating a missing cache.
      const url=location.origin+path,response=await caches.match(url,{cacheName:CACHE});
      let details=null;
      if(!(response&&response.status===200)){
        details=await cacheReadDetails(url,response);
        if(!firstCacheReadFailure)firstCacheReadFailure=details;
      }
      assert(response&&response.status===200,'Synthetic cache response is missing',details);
      const value=await response.arrayBuffer(),expected=await B.digest(B.randomBytes(MIB,0x12457812+i));
      const sha256=await B.digest(value);assert(value.byteLength===MIB&&sha256===expected,'Cache payload SHA-256 changed');
      manifest.push({path,size:value.byteLength,sha256});
    }
    return {names,entries:manifest.length,bytes:manifest.reduce((n,item)=>n+item.size,0),sha256:await B.hash(manifest),manifest};
  }
  async function origin(deep=false){
    const result={elapsedMs:Math.round(performance.now()-start),writer:writer(),writerEvents:[...writerEvents],
      marker:localStorage.getItem(MARKER),sentinel:localStorage.getItem(SENTINEL),
      cacheSeedPuts:[...cacheSeedPuts],...(firstCacheReadFailure?{firstCacheReadFailure}:{})};
    for(const [name,fn]of [['databases',inventory],['cacheNames',()=>caches.keys()],['estimate',B.storageEstimate]]){
      try{result[name]=await fn();}catch(error){result[name]={error:errorJSON(error)};}
    }
    if(deep){
      try{
        const native=await B.readNative(),stores={};
        for(const [name,value]of Object.entries(native.stores))stores[name]={rows:value.rows.length,sha256:await B.hash(await B.normalized(value))};
        result.stores=stores;
        const fixture=await B.model(),records=native.stores.files.rows.filter(([key])=>String(key).startsWith('__sentlog_record__:'))
          .map(([key,value])=>[key.slice('__sentlog_record__:'.length),value]);
        result.durableMatchesBefore=JSON.stringify(records)===JSON.stringify(sorted(fixture.initial));
        result.durableMatchesAfter=JSON.stringify(records)===JSON.stringify(sorted(fixture.final));
      }catch(error){result.durableReadError=errorJSON(error);}
      try{result.cache=await inspectCache();}catch(error){result.cacheReadError=errorJSON(error);}
      try{result.ballast=await readBallast();}catch(error){result.ballastReadError=errorJSON(error);}
      try{
        const fixture=await B.model(),memory=[];
        for(const [key,value]of fixture.incoming)memory.push({expectedSHA256:await B.hash(value),
          actualSHA256:await B.hash(SentlogRecords.getItem(key)),matches:SentlogRecords.getItem(key)===value});
        result.incomingMemory=memory;
      }catch(error){result.memoryReadError=errorJSON(error);}
    }
    return result;
  }
  window.nativeBoundaryProbe={
    configure(config){
      window.__boundaryCase=config;ballast=config.ballast||[];
      if(!watching){watching=true;SentlogRecords.subscribe(()=>writerEvents.push({elapsedMs:Math.round(performance.now()-start),...writer()}));}
    },
    async mark(){
      assert((await inventory()).length===0,'Case profile must be new');
      assert((await caches.keys()).length===0,'Case cache storage must be new');
      localStorage.setItem(SENTINEL,'synthetic-only');
    },
    async seedCache(){
      const count=window.__boundaryCase.cacheMiB;
      if(count){
        const cache=await caches.open(CACHE);
        cacheHandleState=typeof WeakRef==='function'?'weak-reference':'weakref-unavailable';
        if(typeof WeakRef==='function')cacheHandleRef=new WeakRef(cache);
        for(let i=0;i<count;i++){
          const url=location.origin+'/synthetic-cache/'+i,
            response=new Response(B.randomBytes(MIB,0x12457812+i),{headers:{'Content-Type':'application/octet-stream'}});
          const put={url,response:responseMetadata(response),startedAtMs:Math.round(performance.now()-start),completedAtMs:null};
          cacheSeedPuts.push(put);
          try{await cache.put(url,response);put.completedAtMs=Math.round(performance.now()-start);}
          catch(error){put.error=errorJSON(error);throw error;}
        }
      }
      return inspectCache().then(result=>({...result,seedPuts:[...cacheSeedPuts]}));
    },
    async fill(){
      const config=window.__boundaryCase,target=Math.round(config.targetMiB*MIB);
      const fixture=await B.model(),initial=await B.storageEstimate();
      const measured=initial.status==='available'&&Number.isFinite(initial.usage);
      const knownPayload=[...fixture.initial.values()].reduce((n,v)=>n+new TextEncoder().encode(v).length,0)
        +(6+config.cacheMiB)*MIB;
      let remaining=Math.max(0,target-knownPayload),current=initial,added=0;
      assert(!(await inventory()).some(item=>item.name===BALLAST),'Ballast database already exists');
      const q=indexedDB.open(BALLAST,1);q.onupgradeneeded=()=>q.result.createObjectStore('payload');
      const db=await new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      try{
        for(let i=0;i<128;i++){
          if(measured?current.usage>=target:remaining<=0)break;
          const size=Math.max(1,Math.min(MIB,Math.floor(measured?target-current.usage:remaining)));
          const key='payload-'+String(i).padStart(3,'0'),value=new Blob([B.randomBytes(size,0x71234567+i)]);
          let tx;try{tx=db.transaction('payload','readwrite',{durability:'strict'});}
          catch(error){if(error.name!=='TypeError')throw error;tx=db.transaction('payload','readwrite');}
          const done=complete(tx);tx.objectStore('payload').add(value,key);await done;
          ballast.push({key,size,sha256:await B.blobHash(value)});added+=size;remaining-=size;
          if(measured){await delay(40);current=await B.storageEstimate();
            assert(current.status==='available'&&Number.isFinite(current.usage),'Estimate became unavailable during calibration');}
        }
      }finally{db.close();}
      if(!measured)assert(remaining<=0,'Fixed synthetic payload was not fully written');
      const finalEstimate=await B.storageEstimate();
      return {mode:measured?'measured-origin-calibration':'fixed-logical-input',targetBytes:target,
        knownPayloadBytes:knownPayload,ballastBytes:added,ballast:[...ballast],before:initial,
        estimate:finalEstimate,cache:await inspectCache(),ballastProof:await readBallast()};
    },
    async retained(){return {cache:await inspectCache(),ballast:await readBallast(),estimate:await B.storageEstimate()};},
    origin,
    async inputAudit(){
      const fixture=await B.model(),incoming=[...fixture.incoming],ws='surveyFieldNoteWorkspaceV1';
      const textBytes=value=>new TextEncoder().encode(value).length;
      const actual={beforeWorkspaceBytes:new TextEncoder().encode(fixture.initial.get(ws)).length,
        afterWorkspaceBytes:new TextEncoder().encode(fixture.incoming.get(ws)).length,
        changedValues:incoming.length,changedBytes:incoming.reduce((n,[,v])=>n+new TextEncoder().encode(v).length,0),
        incomingSHA256:await B.hash(incoming),liveBlobCount:fixture.attachmentManifest.length,
        cutoffBlobCount:fixture.cutoffManifest.length,initialEntries:fixture.initial.size,finalEntries:fixture.final.size,
        drawingBytes:incoming.filter(([key])=>key.startsWith('surveyFieldNoteDrawingV1:')).reduce((n,[,value])=>n+textBytes(value),0),
        syncBytes:incoming.filter(([key])=>key.startsWith('sentlogCloudProjectSyncV2:')).reduce((n,[,value])=>n+textBytes(value),0)};
      assert(actual.changedValues===9&&actual.changedBytes===4098583,'Wrong synthetic incoming shape');
      assert(actual.drawingBytes===790390&&actual.syncBytes===869336,'Wrong synthetic incoming component sizes');
      assert(actual.beforeWorkspaceBytes===(window.__boundaryCase.smallWorkspace?16384:2362793),'Wrong before workspace');
      assert(actual.afterWorkspaceBytes===2438857,'Wrong after workspace');
      return actual;
    }
  };
})();
"""


def checks_source():
    tree = ast.parse(BASE_FIXTURE.read_text())
    source = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == "CHECKS" for target in node.targets))
    start = source.index("  async function makeModel(includeBackup){")
    end = source.index("  async function seedEmptyRecoveryTarget(){", start)
    source = source[:start] + MODEL + source[end:]
    replacements = {
        "const db=await SentlogRecords.openFilesDatabase();": "const db=await window.boundaryStrictReadOpen(DB);",
        "assert(cutoffs.length===20,": "assert(cutoffs.length===2,",
        "controls.length===(afterReceive?23:22)": "controls.length===(afterReceive?5:4)",
        "projects:afterReceive?6:5,drawings:afterReceive?238:200": "projects:afterReceive?7:6,drawings:afterReceive?13:6",
        "plan.summary.includedFiles===35&&plan.summary.includedBytes===32*MIB": "plan.summary.includedFiles===4&&plan.summary.includedBytes===4*MIB",
        "assert(cutoff.files.length===20,": "assert(cutoff.files.length===2,",
        "Expected exactly 20 protected cutoff file rows": "Expected exactly 2 protected cutoff file rows",
        "Protected cutoff must include all 20 first-project files": "Protected cutoff must include both first-project files",
        "  window.nativePressureProbe={": "  window.__boundaryInternals={model,storageEstimate,digest,hash,randomBytes,blobHash,normalized,readNative};\n  window.nativePressureProbe={",
    }
    for old, new in replacements.items():
        if source.count(old) != 1:
            raise AssertionError("Existing pressure fixture changed; review reuse anchor: " + old)
        source = source.replace(old, new, 1)
    return source + AUXILIARY


def boundary_result(case, before, after):
    available = all(item.get("status") == "available" and isinstance(item.get("usage"), (int, float))
                    for item in (before, after))
    if not available:
        return {"status": "unsupported", "reason": "StorageManager usage estimate unavailable",
                "before": before, "after": after, "measured64MiBCrossing": False}
    target = round(case["targetMiB"] * MIB)
    in_window = target <= before["usage"] <= target + 192 * 1024
    crossing = before["usage"] < BOUNDARY <= after["usage"]
    below = before["usage"] < BOUNDARY and after["usage"] < BOUNDARY
    covered = in_window and (crossing if case["targetMiB"] > 60 else below)
    return {"status": "verified" if covered else "not_covered", "targetBeforeBytes": target,
            "before": before, "after": after, "beforeInTargetWindow": in_window,
            "measured64MiBCrossing": crossing, "bothBelow64MiB": below,
            "scope": "Reported origin usage; not physical allocation or a browser quota limit"}


def check_inputs(source):
    program = """
const vm=require('vm'),crypto=require('crypto'),{performance}=require('perf_hooks');
const source=SOURCE,cases=CASES;
(async()=>{
  const rows=[];
  for(const config of cases){
    const box={window:{__boundaryCase:config},TextEncoder,TextDecoder,Blob,crypto:crypto.webcrypto,
      setTimeout,clearTimeout,performance};
    vm.runInNewContext(source,box);
    const row=await box.window.nativeBoundaryProbe.inputAudit();rows.push({id:config.id,...row});
  }
  if(new Set(rows.map(row=>row.incomingSHA256)).size!==1)throw Error('After-images differ between controls');
  console.log(JSON.stringify({status:'input_checks_passed',nativeBrowserExecuted:false,cases:rows},null,2));
})().catch(error=>{console.error(error);process.exit(1);});
"""
    program = program.replace("SOURCE", json.dumps(source), 1).replace("CASES", json.dumps(CASES), 1)
    subprocess.run(["node", "-e", program], check=True)
    available = lambda value: {"status": "available", "usage": value}
    assert boundary_result(CASES[0], available(56*MIB), available(58*MIB))["status"] == "verified"
    assert boundary_result(CASES[2], available(63.75*MIB), available(65*MIB))["status"] == "verified"
    assert boundary_result(CASES[2], available(63.75*MIB), available(63.9*MIB))["status"] == "not_covered"
    assert boundary_result(CASES[2], available(65*MIB), available(66*MIB))["status"] == "not_covered"
    assert boundary_result(CASES[0], available(56*MIB), {"status": "unsupported"})["status"] == "unsupported"
    print("PASS boundary classification: below, crossing, not reached, already above, unsupported; no native run")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=["chromium", "webkit"])
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check-inputs", action="store_true")
    parser.add_argument("--observation-seconds", type=int, default=240)
    args = parser.parse_args()
    source = checks_source()
    if args.check_inputs:
        check_inputs(source)
        return 0
    if not args.engine:
        parser.error("--engine is required for native execution")
    if not 0 <= args.observation_seconds <= 240:
        parser.error("--observation-seconds must be between 0 and 240")
    output = args.output or Path("/tmp/sentlog-delta-app-record-cache-boundary") / (args.engine + ".json")
    output.parent.mkdir(parents=True, exist_ok=True)
    modules = {name: (args.built_root / "sentlog" / name).read_bytes() for name in MODULES}
    report = {"engine": args.engine, "status": "running", "dataStatus": "running", "boundaryCoverage": "pending",
              "scope": "Synthetic loopback comparison using normal Web APIs in new disposable profiles",
              "physicalDeviceTested": False, "actualFailureReproduced": False, "quotaLimitProven": False,
              "quotaFailureInjected": False, "serviceWorkerRegistered": False, "manualRetries": 0,
              "fixtureSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "baseFixtureSHA256": hashlib.sha256(BASE_FIXTURE.read_bytes()).hexdigest(),
              "executedChecksSHA256": hashlib.sha256(source.encode()).hexdigest(),
              "sourceSHA256": {name: hashlib.sha256(value).hexdigest() for name, value in modules.items()},
              "cases": [{"config": case, "dataStatus": "not_run", "boundaryCoverage": {"status": "not_run"}}
                        for case in CASES], "blockedRequests": []}

    def save():
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            path = urlparse(self.path).path
            if path[1:] in modules:
                body, mime = modules[path[1:]], "text/javascript; charset=utf-8"
            elif path == "/checks.js":
                body, mime = source.encode(), "text/javascript; charset=utf-8"
            elif path == "/":
                body = ('<!doctype html><meta charset="utf-8"><title>Synthetic cache boundary comparison</title>'
                        + ''.join(f'<script src="/{name}"></script>' for name in MODULES)
                        + '<script src="/checks.js"></script>').encode()
                mime = "text/html; charset=utf-8"
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
    context = page = None
    try:
        from playwright.sync_api import sync_playwright
        report["playwrightVersion"] = package_version("playwright")
        with sync_playwright() as playwright:
            for index, entry in enumerate(report["cases"]):
                config = dict(entry["config"])
                phase = "launch"
                case_started = time.monotonic()
                diagnostics = {"events": [], "dropped": 0, "maxEvents": 100, "maxMessageChars": 4096}
                entry["pageDiagnostics"] = diagnostics

                def page_event(kind, message, location=None):
                    if len(diagnostics["events"]) >= diagnostics["maxEvents"]:
                        diagnostics["dropped"] += 1
                        return
                    text = str(message)
                    event = {"kind": kind, "phase": phase,
                             "elapsedMs": round((time.monotonic()-case_started)*1000),
                             "message": text[:diagnostics["maxMessageChars"]],
                             "truncated": len(text) > diagnostics["maxMessageChars"]}
                    if location is not None:
                        event["location"] = location
                    diagnostics["events"].append(event)

                try:
                    with tempfile.TemporaryDirectory(prefix="sentlog-cache-boundary-") as profile:
                        def launch():
                            ctx = getattr(playwright, args.engine).launch_persistent_context(
                                profile, headless=True, service_workers="block", accept_downloads=False,
                                viewport={"width": 390, "height": 844})
                            def route_request(route):
                                if route.request.url.startswith(base + "/"):
                                    route.continue_()
                                else:
                                    report["blockedRequests"].append(route.request.url)
                                    route.abort()
                            ctx.route("**/*", route_request)
                            return ctx

                        def open_page():
                            target = context.pages[0] if context.pages else context.new_page()
                            target.on("console", lambda message: page_event(message.type, message.text, message.location)
                                      if message.type in ["warning", "error"] else None)
                            target.on("pageerror", lambda error: page_event("pageerror", error))
                            target.set_default_timeout(30_000)
                            target.goto(base + "/")
                            target.evaluate("config=>nativeBoundaryProbe.configure(config)", config)
                            return target

                        def call(probe, method, limit=90_000):
                            return page.evaluate("""({probe,method,limit})=>Promise.race([
                                window[probe][method](),new Promise((_,reject)=>
                                setTimeout(()=>reject(Error(method+' exceeded '+limit+' ms')),limit))])""",
                                                 {"probe": probe, "method": method, "limit": limit})

                        try:
                            context = launch()
                            entry["browserVersion"] = context.browser.version if context.browser else None
                            page = open_page()
                            call("nativeBoundaryProbe", "mark")
                            for phase, probe, method in [
                                ("restore", "nativePressureProbe", "restore"),
                                ("input", "nativeBoundaryProbe", "inputAudit"),
                                ("stage", "nativePressureProbe", "stage"),
                                ("cache", "nativeBoundaryProbe", "seedCache"),
                                ("prefill", "nativeBoundaryProbe", "fill"),
                                ("receive", "nativePressureProbe", "receive"),
                                ("retained", "nativeBoundaryProbe", "retained"),
                            ]:
                                entry[phase] = call(probe, method, 120_000 if phase in ["restore", "prefill"] else 90_000)
                                save()
                            before, received = entry["stage"]["result"], entry["receive"]["result"]
                            if entry["restore"]["result"]["stores"]["files"] != before["stores"]["files"]:
                                raise AssertionError("Staging changed the live files store")
                            for key in ["liveBlobs", "cutoffBlobs", "controlsWithoutClockSHA256"]:
                                if before[key] != received[key]:
                                    raise AssertionError("Receive changed protected " + key)
                            for key in ["cache", "ballastProof"]:
                                actual_key = "ballast" if key == "ballastProof" else key
                                if entry["prefill"][key] != entry["retained"][actual_key]:
                                    raise AssertionError("Receive changed " + actual_key)
                            entry["boundaryCoverage"] = boundary_result(
                                config, entry["prefill"]["estimate"], received["storageEstimate"])
                            config["ballast"] = entry["prefill"]["ballast"]
                            phase = "close-browser"
                            context.close()
                            context = None
                            phase = "relaunch"
                            context = launch()
                            page = open_page()
                            phase = "restart-guard"
                            listed = call("nativeBoundaryProbe", "origin")
                            if not any(item["name"] == "surveyFieldNoteDB" for item in listed["databases"]):
                                raise AssertionError("Records database missing before restart; refusing init")
                            if listed["marker"] != "1" or listed["sentinel"] != "synthetic-only":
                                raise AssertionError("Persistent local markers changed")
                            phase = "restart"
                            entry["restart"] = call("nativePressureProbe", "restart")
                            entry["restartRetained"] = call("nativeBoundaryProbe", "retained")
                            restarted = entry["restart"]["result"]
                            for key in ["stores", "recordsSHA256", "recordBytes", "managedEntries",
                                        "liveBlobs", "cutoffBlobs", "controlsWithoutClockSHA256"]:
                                if received[key] != restarted[key]:
                                    raise AssertionError("Browser process restart changed " + key)
                            for key in ["cache", "ballast"]:
                                if entry["retained"][key] != entry["restartRetained"][key]:
                                    raise AssertionError("Browser process restart changed " + key)
                            entry["dataStatus"] = "passed"
                            entry["browserProcessRestarted"] = True
                            coverage = entry["boundaryCoverage"]["status"]
                            if coverage == "not_covered" or (coverage == "unsupported" and args.engine != "webkit"):
                                phase = "boundary-coverage"
                                raise AssertionError("Required measured boundary condition was not covered")
                            print(f"PASS data {args.engine} {config['id']}; boundary={coverage}", flush=True)
                            save()
                        except Exception as error:
                            entry["error"] = {"type": type(error).__name__, "message": str(error)}
                            entry["phase"] = phase
                            if entry["dataStatus"] != "passed":
                                entry["dataStatus"] = "blocked" if phase == "launch" else "failed"
                            entry["observation"] = {"readOnly": True, "retryPerformed": False,
                                                    "databaseRecreationAllowed": False, "snapshots": []}
                            save()
                            started = time.monotonic()
                            limit = args.observation_seconds if phase not in ["launch", "boundary-coverage"] else 0
                            offsets = sorted(set([0] + [value for value in [1, 5, 15, 30, 60, 120, 180, max(0, limit-10)]
                                                       if value <= max(0, limit-10)]))
                            for offset in offsets:
                                if page is None or page.is_closed():
                                    entry["observation"]["unavailable"] = "Page unavailable; no replacement page opened"
                                    break
                                while time.monotonic() - started < offset:
                                    time.sleep(max(0, min(1, offset - (time.monotonic() - started))))
                                try:
                                    snapshot = page.evaluate("""deep=>Promise.race([
                                        nativeBoundaryProbe.origin(deep),new Promise((_,reject)=>
                                        setTimeout(()=>reject(Error('Read-only observation exceeded 10 seconds')),10000))])""",
                                                             offset in [0, offsets[-1]])
                                    entry["observation"]["snapshots"].append(snapshot)
                                except Exception as observation_error:
                                    entry["observation"]["snapshots"].append({"error": str(observation_error)})
                                save()
                            entry["observation"]["elapsedSeconds"] = round(time.monotonic()-started, 3)
                            for rest in report["cases"][index+1:]:
                                rest["dataStatus"] = "not_run_due_to_prior_failure"
                                rest["boundaryCoverage"] = {"status": "not_run_due_to_prior_failure"}
                            report["status"] = "unsupported" if phase == "boundary-coverage" else entry["dataStatus"]
                            report["dataStatus"] = "incomplete" if entry["dataStatus"] == "passed" else entry["dataStatus"]
                            report["boundaryCoverage"] = "incomplete"
                            save()
                            return 2 if phase == "boundary-coverage" else 1
                        finally:
                            if context:
                                try:
                                    context.close()
                                except Exception as close_error:
                                    entry["browserCloseError"] = str(close_error)
                                context = None
                            page = None
                except Exception as error:
                    entry.update(dataStatus="blocked", phase=phase, error={"type": type(error).__name__, "message": str(error)})
                    for rest in report["cases"][index+1:]:
                        rest["dataStatus"] = "not_run_due_to_prior_failure"
                        rest["boundaryCoverage"] = {"status": "not_run_due_to_prior_failure"}
                    raise
        if report["blockedRequests"]:
            raise AssertionError("Fixture attempted an external request")
        statuses = {entry["boundaryCoverage"]["status"] for entry in report["cases"]}
        report["dataStatus"] = "passed"
        report["boundaryCoverage"] = "verified" if statuses == {"verified"} else "unsupported"
        report["status"] = "passed" if statuses == {"verified"} else "data_passed_boundary_unsupported"
        print(f"PASS mandatory data checks {args.engine}: 5/5; boundaryCoverage={report['boundaryCoverage']}", flush=True)
        return 0
    except Exception as error:
        blocked = all(e["dataStatus"] != "passed" for e in report["cases"])
        report.update(status="blocked" if blocked else "failed",
                      dataStatus="blocked" if blocked else "incomplete", boundaryCoverage="incomplete",
                      error={"type": type(error).__name__, "message": str(error)})
        for entry in report["cases"]:
            if entry["dataStatus"] == "not_run":
                entry["dataStatus"] = "not_run_due_to_setup_failure"
                entry["boundaryCoverage"] = {"status": "not_run_due_to_setup_failure"}
        return 1
    finally:
        server.shutdown()
        server.server_close()
        save()
        print(json.dumps({"engine": args.engine, "status": report["status"], "dataStatus": report["dataStatus"],
                          "boundaryCoverage": report["boundaryCoverage"], "report": str(output)}), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())

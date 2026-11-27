"""Native storage comparison after synthetic restore, staging and remote receive.

Restore 10 MiB of records and 32 MiB in 35 Blob attachments with the production
startup recovery module. Protect 20 attachments (12 MiB) in a real staging
cutoff, then use the production record writer to commit 40 changed values
containing 4 MiB for a different, unbound project. Close the browser process,
relaunch the same disposable profile and compare all three native stores,
every record and every live/cutoff Blob SHA-256.

This supplements the record-only scale case. It is a comparison experiment,
not a reproduction of a particular user's QuotaExceededError. It does not
test authentication, real cloud traffic, physical iOS or full-disk conditions.
No customer backup, connected profile or quota injection is used. A missing
browser is BLOCKED/nonzero; StorageManager.estimate is optional diagnostics.
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
MIB = 1024 * 1024
MODULES = ["blob-sha256.js", "backup-format.js", "startup-backup-recovery.js", "record-store.js"]
CHECKS = r"""
(() => {
  'use strict';
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',SYNC='sentlogCloudProjectSyncV2:';
  const DB='surveyFieldNoteDB',PREFIX='__sentlog_record__:',CONTROL='sentlog_delta_control_v1',LOG='sentlog_delta_journal_v1';
  const INTENT='startup-backup-recovery:v1',MIB=1024*1024,STORES=['files',CONTROL,LOG];
  const encoder=new TextEncoder(),decoder=new TextDecoder(),bytes=value=>encoder.encode(value).length;
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const same=(actual,expected,message)=>assert(JSON.stringify(actual)===JSON.stringify(expected),message);
  const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value)))
    .map(value=>value.toString(16).padStart(2,'0')).join('');
  const hash=async value=>digest(encoder.encode(JSON.stringify(value)));
  const blobHash=async value=>digest(await value.arrayBuffer());
  async function storageEstimate(){
    let timer;
    try{
      if(typeof navigator.storage?.estimate!=='function')return {status:'unsupported'};
      const result=await Promise.race([navigator.storage.estimate(),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(Error('Storage estimate exceeded 2 seconds'),{name:'TimeoutError'})),2000);
      })]);
      return {...result,status:'available'};
    }catch(error){return {status:'error',error:{name:error?.name||'Error',message:String(error?.message||error)}};}
    finally{clearTimeout(timer);}
  }
  function randomBytes(length,seed,alphabet){
    const output=new Uint8Array(length);let state=seed|0;
    for(let i=0;i<length;i++){
      state^=state<<13;state^=state>>>17;state^=state<<5;
      output[i]=alphabet?alphabet.charCodeAt((state>>>0)%alphabet.length):(state>>>0)&255;
    }
    return output;
  }
  const text=(length,seed)=>decoder.decode(randomBytes(length,seed,'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'));
  function padded(object,holder,key,target,seed){
    holder[key]='';const empty=bytes(JSON.stringify(object));
    assert(target>=empty,'Synthetic target is too small');holder[key]=text(target-empty,seed);
    const value=JSON.stringify(object);assert(bytes(value)===target,'Synthetic UTF-8 byte target changed');return value;
  }
  const dataUrl=blob=>new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);
  });
  function sortedEntries(map){return [...map].sort(([a],[b])=>a<b?-1:a>b?1:0);}
  let modelPromise;
  function model(includeBackup=false){
    if(!modelPromise)modelPromise=makeModel(includeBackup);return modelPromise;
  }
  async function makeModel(includeBackup){
    const projects=Array.from({length:5},(_,i)=>({id:'synthetic-project-'+i,name:'Synthetic project '+i,
      updatedAt:100,drawings:[]}));
    const drawings=Array.from({length:200},(_,i)=>({id:'synthetic-drawing-'+i,name:'Synthetic drawing '+i}));
    const states=new Map(drawings.map((drawing,i)=>[drawing.id,{shapes:[{id:'synthetic-record-'+i,type:'point',
      x:10,y:20,memo:'',photos:[]}],collabDeletedRecords:[]}]));
    drawings.forEach((drawing,i)=>projects[i<4?0:1+Math.floor((i-4)/49)].drawings.push(drawing));
    const attachmentManifest=[],backupFiles=[];
    for(let i=0;i<35;i++){
      const first=i<20,count=first?20:15,index=first?i:i-20,total=(first?12:20)*MIB;
      const size=Math.floor(total*(index+1)/count)-Math.floor(total*index/count),drawingIndex=first?i%4:4+i-20;
      const key='photo:'+drawings[drawingIndex].id+':synthetic-photo-'+i;
      const blob=new Blob([randomBytes(size,0x34567812+i)],{type:'image/jpeg'}),sha256=await blobHash(blob);
      states.get(drawings[drawingIndex].id).shapes[0].photos.push({id:'synthetic-photo-'+i,size,type:blob.type,sha256});
      attachmentManifest.push({key,size,type:blob.type,name:null,lastModified:null,sha256});
      if(includeBackup)backupFiles.push({key,type:blob.type,name:'',data:await dataUrl(blob)});
    }
    assert(attachmentManifest.reduce((n,file)=>n+file.size,0)===32*MIB,'Expected 32 MiB in live files');
    assert(attachmentManifest.slice(0,20).reduce((n,file)=>n+file.size,0)===12*MIB,'Expected 12 MiB in cutoff files');
    const workspace={projects};
    const initial=new Map([[WS,padded(workspace,projects[4],'syntheticPadding',2*MIB,0x23456789)]]);
    for(const project of projects)initial.set(SYNC+project.id,JSON.stringify({revision:0,restored_backup:true,local_updated_at:100}));
    const syncBytes=[...initial].filter(([key])=>key.startsWith(SYNC)).reduce((n,[,value])=>n+bytes(value),0);
    let stateBytes=0;
    for(let i=0;i<drawings.length;i++){
      const first=i<4,count=first?4:196,index=first?i:i-4,total=first?MIB:7*MIB-syncBytes;
      const target=Math.floor(total*(index+1)/count)-Math.floor(total*index/count),state=states.get(drawings[i].id);
      const value=padded(state,state.shapes[0],'memo',target,0x12345678+i);
      initial.set(DRAW+drawings[i].id,value);stateBytes+=bytes(value);
    }
    assert(stateBytes+2*MIB+syncBytes===10*MIB,'Expected 10 MiB of restored managed values');
    const project={id:'synthetic-project-5',name:'Synthetic project 5',updatedAt:200,drawings:[]};
    const newDrawings=[];const incoming=new Map();
    for(let i=0;i<38;i++){
      const meta={id:'synthetic-incoming-drawing-'+i,name:'Synthetic incoming drawing '+i};
      const state={shapes:[{id:'synthetic-incoming-record-'+i,type:'point',x:30,y:40,memo:'',photos:[]}],collabDeletedRecords:[]};
      const target=Math.floor(3*MIB/4*(i+1)/38)-Math.floor(3*MIB/4*i/38);
      incoming.set(DRAW+meta.id,padded(state,state.shapes[0],'memo',target,0x45678123+i));
      project.drawings.push(meta);newDrawings.push({meta,state});
    }
    incoming.set(WS,JSON.stringify({projects:[...projects,project]}));
    const used=[...incoming.values()].reduce((n,value)=>n+bytes(value),0);
    const baseline={version:1,project,drawings:newDrawings};
    const sync={revision:1,base_snapshot:baseline,syntheticPadding:''};
    incoming.set(SYNC+project.id,padded(sync,sync,'syntheticPadding',4*MIB-used,0x56781234));
    assert(incoming.size===40&&[...incoming.values()].reduce((n,value)=>n+bytes(value),0)===4*MIB,
      'Expected exactly 40 changed managed values containing 4 MiB');
    const final=new Map(initial);for(const [key,value] of incoming)final.set(key,value);
    assert([...incoming].every(([key,value])=>initial.get(key)!==value),'Every incoming value must change');
    return {initial,final,incoming,attachmentManifest,cutoffManifest:attachmentManifest.slice(0,20),
      backup:includeBackup?new Blob([JSON.stringify({format:'sentlog-backup',version:1,exportedAt:'2026-01-01T00:00:00.000Z',
        workspace,drawingStates:Object.fromEntries(states),files:backupFiles})],{type:'application/json'}):null};
  }
  async function seedEmptyRecoveryTarget(){
    // Only this new disposable profile is initialized; the production recovery
    // module itself must continue to refuse creation/clearing of user storage.
    assert((await indexedDB.databases()).length===0,'Fixture profile must be new and empty');
    localStorage.setItem('sentlogRecordsReadyV130','1');
    const q=indexedDB.open(DB,2);
    q.onupgradeneeded=()=>{q.result.createObjectStore('files');
      for(const name of [CONTROL,LOG])q.result.createObjectStore(name).createIndex('kind','kind');};
    const db=await new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});db.close();
  }
  async function readNative(){
    const db=await SentlogRecords.openFilesDatabase();
    try{
      assert(db.version===2,'Expected the production records schema version 2');
      same([...db.objectStoreNames].sort(),[...STORES].sort(),'Native store set changed');
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORES,'readonly'),result={version:db.version,stores:{}};
        for(const name of STORES){
          const store=tx.objectStore(name),entry={keyPath:store.keyPath,autoIncrement:store.autoIncrement,
            indexes:[...store.indexNames].map(name=>{const index=store.index(name);return {name,keyPath:index.keyPath,
              unique:index.unique,multiEntry:index.multiEntry};}),rows:[]};result.stores[name]=entry;
          const q=store.openCursor();q.onsuccess=()=>{const cursor=q.result;if(cursor){entry.rows.push([cursor.key,cursor.value]);cursor.continue();}};
        }
        tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||Error('Native inspection aborted'));
      });
    }finally{db.close();}
  }
  async function blobDescriptor(key,value){
    assert(value instanceof Blob,'Expected a native Blob');
    return {key,size:value.size,type:value.type,name:typeof value.name==='string'?value.name:null,
      lastModified:Number.isFinite(value.lastModified)?value.lastModified:null,sha256:await blobHash(value)};
  }
  async function normalized(value){
    if(value instanceof Blob){const descriptor=await blobDescriptor('',value);delete descriptor.key;return {kind:'Blob',...descriptor};}
    if(Array.isArray(value)){const result=[];for(const item of value)result.push(await normalized(item));return result;}
    if(value&&typeof value==='object'){const result={};for(const key of Object.keys(value).sort())result[key]=await normalized(value[key]);return result;}
    return value===undefined?{kind:'undefined'}:value;
  }
  const sortManifest=items=>[...items].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  async function inspect(phase){
    const fixture=await model(),native=await readNative(),afterReceive=phase==='received'||phase==='restarted';
    const expected=afterReceive?fixture.final:fixture.initial,files=native.stores.files.rows;
    const records=files.filter(([key])=>String(key).startsWith(PREFIX)).map(([key,value])=>[key.slice(PREFIX.length),value]);
    same(records,sortedEntries(expected),'Native managed values differ from the synthetic expected bytes');
    assert(SentlogRecords.keys().length===expected.size,'Editor record count differs from native storage');
    for(const [key,value]of expected)assert(SentlogRecords.getItem(key)===value,'Editor record differs from durable storage');
    const live=[];for(const [key,value]of files)if(value instanceof Blob)live.push(await blobDescriptor(key,value));
    same(sortManifest(live),sortManifest(fixture.attachmentManifest),'A restored Blob is missing or changed');
    const controls=native.stores[CONTROL].rows,bindings=controls.filter(([,row])=>row?.kind==='binding');
    const cutoffs=controls.filter(([,row])=>row?.kind==='cutoff-file'),cutoffFiles=[];
    for(const [,row]of cutoffs)cutoffFiles.push(await blobDescriptor(row.key,row.value));
    const intent=controls.filter(([key])=>key===INTENT);
    assert(intent.length===1&&intent[0][1].kind==='startup-backup-recovery','Missing native restore intent');
    if(phase==='restored')assert(controls.length===1&&bindings.length===0&&cutoffs.length===0,'Restore must not create binding/file generation rows');
    else{
      assert(bindings.length===1&&bindings[0][1].phase==='staging','Expected one durable staging binding');
      assert(bindings[0][1].localProjectId==='synthetic-project-0','Wrong project was bound');
      assert(cutoffs.length===20,'Expected exactly 20 protected cutoff file rows');
      same(sortManifest(cutoffFiles),sortManifest(fixture.cutoffManifest),'A protected cutoff Blob is missing or changed');
      assert(controls.length===(afterReceive?23:22),'Unexpected native control rows');
      const clock=controls.filter(([key])=>key==='clock');
      assert(afterReceive?clock.length===1&&clock[0][1]===1:clock.length===0,'Unexpected control clock sequence');
    }
    assert(native.stores[LOG].rows.length===0,'An unbound remote project must not add bound-project journal entries');
    SentlogRecords.assertSafe();
    assert(SentlogRecords.ready&&!SentlogRecords.pending&&!SentlogRecords.failed,'Writer is not durably settled');
    const stores={};for(const name of STORES){const value=await normalized(native.stores[name]);
      stores[name]={rows:value.rows.length,sha256:await hash(value),normalizedJsonBytes:bytes(JSON.stringify(value))};}
    const controlsWithoutClock=controls.filter(([key])=>key!=='clock');
    return {phase,schemaVersion:2,projects:afterReceive?6:5,drawings:afterReceive?238:200,managedEntries:records.length,
      recordBytes:records.reduce((n,[,value])=>n+bytes(value),0),recordsSHA256:await hash(records),
      liveBlobBytes:live.reduce((n,file)=>n+file.size,0),cutoffBlobBytes:cutoffFiles.reduce((n,file)=>n+file.size,0),
      liveBlobs:sortManifest(live),cutoffBlobs:sortManifest(cutoffFiles),
      controlsWithoutClockSHA256:await hash(await normalized(controlsWithoutClock)),stores,
      storageEstimate:await storageEstimate(),ready:SentlogRecords.ready,pending:SentlogRecords.pending,failed:SentlogRecords.failed};
  }
  window.nativePressureProbe={
    async restore(){
      const before=await storageEstimate(),start=performance.now(),fixture=await model(true);
      await seedEmptyRecoveryTarget();
      const recovery=SentlogStartupBackupRecovery.create(),plan=await recovery.prepare(fixture.backup);
      assert(plan.summary.includedFiles===35&&plan.summary.includedBytes===32*MIB&&plan.summary.missingFiles===0,
        'Restore plan does not contain all synthetic attachments');
      assert((await recovery.inspect(plan)).mode==='empty','Synthetic restore target is not empty');
      const result=await recovery.restore(plan,{confirmedOtherTabsClosed:true});
      assert(result.verified===true&&!result.resumed,'Production startup recovery did not finish a new restore');
      fixture.backup=null;await SentlogRecords.init();
      return {before,durationMs:Math.round(performance.now()-start),recovery:result,result:await inspect('restored')};
    },
    async stage(){
      const start=performance.now();
      const cutoff=await SentlogRecords.deltaJournal.begin({
        scope:{ownerId:'synthetic-owner',projectId:'synthetic-cloud-0',deviceId:'synthetic-device'},
        localProjectId:'synthetic-project-0',actor:{deviceId:'synthetic-device',deviceName:'Synthetic storage comparison'},serverRevision:1
      });
      assert(cutoff.files.length===20,'Protected cutoff must include all 20 first-project files');
      await SentlogRecords.settled();return {durationMs:Math.round(performance.now()-start),result:await inspect('staged')};
    },
    async receive(){
      const start=performance.now(),fixture=await model();
      SentlogRecords.batch([...fixture.incoming],{origin:'remote',operation:'synthetic-legacy-receive'});
      await SentlogRecords.settled();
      return {durationMs:Math.round(performance.now()-start),changedManagedValues:fixture.incoming.size,
        changedRecordBytes:[...fixture.incoming.values()].reduce((n,value)=>n+bytes(value),0),result:await inspect('received')};
    },
    async restart(){
      const start=performance.now();await SentlogRecords.init();return {durationMs:Math.round(performance.now()-start),result:await inspect('restarted')};
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
    output = args.output or Path(tempfile.gettempdir()) / "sentlog-delta-app-record-pressure" / f"{args.engine}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    modules = {name: (args.built_root / "sentlog" / name).read_bytes() for name in MODULES}
    report = {
        "engine": args.engine, "status": "running", "scope": "synthetic loopback comparison only",
        "physicalDeviceTested": False, "quotaFailureInjected": False, "actualFailureReproduced": False,
        "browserProcessRestarted": False, "playwrightVersion": package_version("playwright"),
        "restartMethod": "close persistent context and launch a new browser with the same profile and loopback origin",
        "fixtureSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "sourceSHA256": {name: hashlib.sha256(source).hexdigest() for name, source in modules.items()},
        "expected": {"restoredDrawings": 200, "restoredProjects": 5, "restoredRecordBytes": 10 * MIB,
                     "liveBlobCount": 35, "liveBlobBytes": 32 * MIB, "cutoffBlobCount": 20,
                     "cutoffBlobBytes": 12 * MIB, "changedManagedValues": 40, "changedRecordBytes": 4 * MIB},
        "blockedRequests": [],
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            path = urlparse(self.path).path
            if path[1:] in modules:
                body, mime = modules[path[1:]], "text/javascript; charset=utf-8"
            elif path == "/checks.js":
                body, mime = CHECKS.encode(), "text/javascript; charset=utf-8"
            elif path == "/":
                body = ('<!doctype html><meta charset="utf-8"><title>Synthetic native storage comparison</title>'
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
    phase = "launch"
    try:
        with tempfile.TemporaryDirectory(prefix="sentlog-record-pressure-") as profile, sync_playwright() as playwright:
            context = None
            try:
                def launch():
                    ctx = getattr(playwright, args.engine).launch_persistent_context(
                        profile, headless=True, service_workers="block", accept_downloads=False,
                        viewport={"width": 390, "height": 844},
                    )

                    def route_request(route):
                        if route.request.url.startswith(base + "/"):
                            route.continue_()
                        else:
                            report["blockedRequests"].append(route.request.url)
                            route.abort()

                    ctx.route("**/*", route_request)
                    return ctx

                def open_page(ctx):
                    page = ctx.pages[0] if ctx.pages else ctx.new_page()
                    page.set_default_timeout(30_000)
                    page.goto(base + "/")
                    return page

                context = launch()
                report["browserVersion"] = context.browser.version if context.browser else None
                page = open_page(context)
                for phase, method, limit in [("restore", "restore", 120_000), ("stage", "stage", 60_000), ("receive", "receive", 60_000)]:
                    report[phase] = page.evaluate("""({method,limit})=>Promise.race([
                        nativePressureProbe[method](),new Promise((_,reject)=>setTimeout(()=>reject(Error(method+' exceeded '+limit+' ms')),limit))
                    ])""", {"method": method, "limit": limit})
                    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
                restored, staged, received = (report[key]["result"] for key in ["restore", "stage", "receive"])
                if restored["stores"]["files"] != staged["stores"]["files"]:
                    raise AssertionError("Creating the protected cutoff changed the live native files store")
                for key in ["liveBlobs", "cutoffBlobs", "controlsWithoutClockSHA256"]:
                    if staged[key] != received[key]:
                        raise AssertionError(f"Remote receive changed protected {key}")
                phase = "close-browser"
                context.close()
                context = None
                phase = "relaunch"
                context = launch()
                report["browserProcessRestarted"] = True
                phase = "restart-verify"
                page = open_page(context)
                report["restart"] = page.evaluate("""()=>Promise.race([
                    nativePressureProbe.restart(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Restart inspection exceeded 90 seconds')),90000))
                ])""")
                restarted = report["restart"]["result"]
                for key in ["stores", "recordsSHA256", "recordBytes", "managedEntries", "liveBlobs", "cutoffBlobs", "controlsWithoutClockSHA256"]:
                    if received[key] != restarted[key]:
                        raise AssertionError(f"Native {key} changed across browser process restart")
                if report["blockedRequests"]:
                    raise AssertionError("Synthetic fixture attempted an unexpected external request")
                report["status"] = "passed"
                report["allHashesMatch"] = True
                print(f"PASS {args.engine}: restore 32 MiB files, protect 20 files, receive 4 MiB; all 3 native stores and Blob SHA-256 values survived browser restart", flush=True)
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

"""Full app operations and standalone maintenance over a large native journal.

All profiles/data are disposable. Production HTML, writer, replay and UI run on
loopback; network services are blocked. The regression oracle observes real IDB
requests, without replacing their results or imposing simulated quota failures.
The frozen v2.15 writer must exhibit the former unbounded reads in the same
fixture. Browser processes run only in the GitHub native-browser workflow.
"""
import argparse
import functools
import hashlib
import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from pathlib import Path
from urllib.parse import urlparse

from storage_maintenance_ui import MODULES, PREPARE, bounded_playwright, deadline, evaluate_async

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SHA256 = "fa82b9f297c44ddaa91b9d72b9465da540bef422b23534190d278612a45f611a"
FIXTURE = "/__storage_operation_fixture__.html"
CASES = ("v215-read-amplification", "full-app-large-journal", "standalone-large-journal")

AUDIT = r"""(() => {
  const a=window.__storageAudit={phase:'startup',suspended:false,events:[],writes:[],opens:0,transactions:0,
    bulkJournal:0,bulkRecords:0,bulkControls:0,journalValues:0,oldJournalValues:0,blobValues:0,
    floor:0,documentId:crypto.randomUUID(),clicks:[]};
  const add=(list,value)=>{if(list.length<160)list.push({phase:a.phase,...value});};
  a.reset=(phase,floor=0)=>{Object.assign(a,{phase,floor,events:[],writes:[],opens:0,transactions:0,
    bulkJournal:0,bulkRecords:0,bulkControls:0,journalValues:0,oldJournalValues:0,blobValues:0});};
  a.report=()=>Object.fromEntries(Object.entries(a).filter(([k,v])=>typeof v!=='function'&&k!=='suspended'));
  const open=indexedDB.open.bind(indexedDB);indexedDB.open=function(...args){if(!a.suspended){a.opens++;add(a.events,{method:'open',database:args[0]});}return open(...args);};
  const transaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){
    if(!a.suspended){a.transactions++;if((args[1]||'readonly')!=='readonly')add(a.writes,{method:'transaction',database:this.name,mode:args[1]});}
    return transaction.apply(this,args);
  };
  const range=q=>q instanceof IDBKeyRange?{lower:q.lower,upper:q.upper,lowerOpen:q.lowerOpen,upperOpen:q.upperOpen}:q;
  for(const proto of [IDBObjectStore.prototype,IDBIndex.prototype])for(const method of ['getAll','get','openCursor','openKeyCursor']){
    const native=proto[method];if(!native)continue;proto[method]=function(...args){
      const store=this.objectStore||this;
      if(!a.suspended&&store.transaction.db.name==='surveyFieldNoteDB'){
        const count=method==='getAll'?args[1]:undefined;
        add(a.events,{method,store:store.name,index:this.objectStore?this.name:null,range:range(args[0]),count});
        if(method==='getAll'&&!Number.isSafeInteger(count)){
          if(store.name==='sentlog_delta_journal_v1')a.bulkJournal++;
          if(store.name==='sentlog_delta_control_v1'&&!this.objectStore&&args[0]===undefined)a.bulkControls++;
          if(store.name==='files')a.bulkRecords++;
        }
      }
      return native.apply(this,args);
    };
  }
  const descriptor=Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype,'value');
  if(!descriptor?.get)throw Error('Native cursor observation is unavailable');
  Object.defineProperty(IDBCursorWithValue.prototype,'value',{...descriptor,get(){
    const value=descriptor.get.call(this),store=this.source.objectStore||this.source;
    if(!a.suspended&&store.transaction.db.name==='surveyFieldNoteDB'){
      if(store.name==='sentlog_delta_journal_v1'){a.journalValues++;if(Number(this.primaryKey)<=a.floor)a.oldJournalValues++;}
      if(value instanceof Blob)a.blobValues++;
    }return value;
  }});
  for(const method of ['put','add','delete','clear']){const native=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){
    if(!a.suspended)add(a.writes,{method,database:this.transaction.db.name,store:this.name,key:method==='put'||method==='add'?args[1]:args[0]});
    return native.apply(this,args);
  };}
  for(const method of ['update','delete']){const native=IDBCursor.prototype[method];IDBCursor.prototype[method]=function(...args){
    const store=this.source.objectStore||this.source;if(!a.suspended)add(a.writes,{method:'cursor.'+method,database:store.transaction.db.name,store:store.name,key:this.primaryKey});
    return native.apply(this,args);
  };}
  a.bindClicks=()=>document.addEventListener('click',event=>{const target=event.target.closest?.('button,a,.manager-card');if(target)add(a.clicks,{id:target.id||target.className,trusted:event.isTrusted});},true);
  a.bindClicks();
})();"""

HELPERS = r"""(() => {
  const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const completed=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Native transaction aborted'));});
  async function digest(value){const bytes=value instanceof Blob?await value.arrayBuffer():new TextEncoder().encode(value);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
  async function normalize(value,path='$'){
    if(value===undefined)return {undefined:true};
    if(value instanceof Blob){try{return {blob:true,size:value.size,type:value.type,sha256:await digest(value),
      ...(value instanceof File?{name:value.name,lastModified:value.lastModified}:{})};}
      catch(error){throw Error('Native Blob read failed at '+path+' (size='+value.size+', type='+value.type+'): '+(error?.name||'Error')+': '+(error?.message||error));}}
    if(Array.isArray(value)){const out=[];for(let i=0;i<value.length;i++)out.push(await normalize(value[i],path+'['+i+']'));return out;}
    if(value&&typeof value==='object'){const out={};for(const key of Object.keys(value).sort())out[key]=await normalize(value[key],path+'.'+key);return out;}
    return value;
  }
  const fingerprint=async (value,path)=>digest(JSON.stringify(await normalize(value,path)));
  async function snapshot(){
    // Fixture proof reads one native value at a time, outside the measured
    // product phase. It never materializes the entire heavy journal in memory.
    const prior=__storageAudit.suspended;__storageAudit.suspended=true;
    try{const databases={};for(const info of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
      const db=await request(indexedDB.open(info.name));try{const stores={};
        for(const name of [...db.objectStoreNames]){
          let tx=db.transaction(name,'readonly'),done=completed(tx),keys=await request(tx.objectStore(name).getAllKeys());await done;
          const rows=[];for(const key of keys){tx=db.transaction(name,'readonly');done=completed(tx);const value=await request(tx.objectStore(name).get(key));await done;
            rows.push([key,await fingerprint(value,info.name+'/'+name+'/'+String(key))]);}
          stores[name]={count:rows.length,rows,sha256:await fingerprint(rows)};
        }databases[info.name]={version:db.version,stores};
      }finally{db.close();}}
      return {databases,localStorage:Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])};
    }finally{__storageAudit.suspended=prior;}
  }
  window.__operationHelpers={request,completed,digest,normalize,fingerprint,snapshot};
})();"""

EXPAND = r"""async ({pendingEdits})=>{
  const R=SentlogRecords,C=SentlogRecordCollaboration,D=SentlogDeltaSyncCore,M=SentlogDeltaMetadata;
  const h=__operationHelpers,s=__maintenance,WS=s.WS,DRAW=s.DRAW,LOG=s.LOG,CONTROL=s.CONTROL;
  const pid='operation-project',id='operation-one',scope={ownerId:'synthetic-owner',projectId:'operation-cloud',deviceId:'operation-device'};
  const ws=JSON.parse(R.getItem(WS)),project={id:pid,name:'通常操作の合成案件',drawings:[{id,name:'通常操作の合成図面',sourceType:'image',fileName:'fixture.svg',pageCount:1}]};
  ws.projects.push(project);
  const current={sourceType:'image',fileName:'fixture.svg',width:1200,height:800,pageCount:1,currentPage:1,
    shapes:[C.upgrade({id:'operation-record',memo:'保存済みの所見',photos:[],page:1})],collabDeletedRecords:[]};
  const writes=[[WS,JSON.stringify(ws)],[DRAW+id,JSON.stringify(current)]];
  for(let i=0;i<32;i++){const key='unrelated-'+i;ws.projects[0].drawings.push({id:key,name:'別案件の合成図面 '+i});
    writes.push([DRAW+key,JSON.stringify({shapes:[],collabDeletedRecords:[],syntheticPadding:'R'.repeat(65536)})]);}
  writes[0][1]=JSON.stringify(ws);R.batch(writes);await R.settled();
  await R.writeFile('background:'+id,new File(['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="white"/></svg>'],'fixture.svg',{type:'image/svg+xml',lastModified:1}));
  const old=JSON.parse(R.getItem(DRAW+'one'));old.shapes[0].memo='Synthetic journal template';R.setItem(DRAW+'one',JSON.stringify(old));await R.settled();
  const entries=await s.disk(LOG),template=[...entries.values()].reverse().find(row=>row.mutationKind==='batch'&&row.changes.some(c=>c.key===DRAW+'one'));
  if(!template)throw Error('Actual writer did not create a record-intent template');
  const db=await R.openFilesDatabase();let floor,clock,trimSeqs=[];const expectedTrim={};
  try{
    let tx=db.transaction(CONTROL,'readonly'),done=h.completed(tx);clock=await h.request(tx.objectStore(CONTROL).get('clock'));await done;
    tx=db.transaction([LOG,CONTROL,'files'],'readwrite');done=h.completed(tx);let previous=R.getItem(DRAW+'one');
    for(let i=0;i<384;i++){
      const seq=++clock,next=JSON.stringify({...old,syntheticPadding:'J'.repeat(32768),syntheticGeneration:i});
      const row={...structuredClone(template),id:'synthetic-large-intent-'+seq,seq,at:1700000000000+i,
        changes:[{key:DRAW+'one',before:previous,after:next}],projectIds:[s.pid],drawingIds:['one'],files:[]};
      delete row.workspaceBefore;delete row.workspaceAfter;tx.objectStore(LOG).add(row,seq);previous=next;
    }
    tx.objectStore('files').put(previous,'__sentlog_record__:'+DRAW+'one');
    for(let i=0;i<64;i++)tx.objectStore('files').put(new Blob([new Uint8Array(65536).fill(90+i%20)],{type:'application/octet-stream'}),'synthetic-held-file:'+i);
    tx.objectStore(CONTROL).put(clock,'clock');await done;
  }finally{db.close();}
  const cutoff=await R.deltaJournal.begin({scope,localProjectId:pid,actor:{deviceId:scope.deviceId,deviceName:'Synthetic'}});floor=cutoff.cutoffSeq;
  if(floor!==clock)throw Error('Target cutoff does not follow the unrelated history');
  const initial={...await M.seed(cutoff.snapshot)};
  for(const drawing of cutoff.snapshot.drawings)for(const record of drawing.state.shapes)initial[D.keyOf(drawing.meta.id,record.id)]=C.upgrade(record);
  const replicaStore=SentlogDeltaIndexedDB.createStore({...scope});await replicaStore.read();await replicaStore.write({version:2,scope:structuredClone(scope),cursor:0,records:initial,outbox:[]});replicaStore.close();
  await R.deltaJournal.activate({scope,localProjectId:pid,baselineId:'synthetic-operation-baseline',baselineSnapshot:cutoff.snapshot,metadataRecords:M.metadataRecords(initial)});
  for(let i=0;i<pendingEdits;i++){const value=JSON.parse(R.getItem(DRAW+id));value.shapes[0].memo='未送信の所見 '+i;R.setItem(DRAW+id,JSON.stringify(value));await R.settled();}
  if(pendingEdits){const all=await s.disk(LOG),target=[...all].filter(([seq,row])=>seq>floor&&row.projectIds?.includes(pid));
    const connection=await R.openFilesDatabase();try{const tx=connection.transaction(LOG,'readwrite'),done=h.completed(tx);
      for(const [index,[seq,row]]of target.entries()){
        row.workspaceBefore=row.workspaceAfter=index<2?R.getItem(WS):JSON.stringify({projects:[],uniqueHistoricalText:'keep this unique historical workspace'});
        tx.objectStore(LOG).put(row,seq);if(index<2){trimSeqs.push(seq);const trimmed=structuredClone(row);delete trimmed.workspaceBefore;delete trimmed.workspaceAfter;expectedTrim[seq]=trimmed;}
      }await done;
    }finally{connection.close();}}
  const hashes={};for(const [seq,row]of Object.entries(expectedTrim))hashes[seq]=await h.fingerprint(row);
  const currentControl=await s.disk(CONTROL),maintenanceSequence=currentControl.get('clock')+1;
  const maintenanceControlHash=await h.fingerprint(maintenanceSequence),foreignProjects={};
  for(const project of JSON.parse(R.getItem(WS)).projects)if(project.id!==pid)foreignProjects[project.id]=await h.fingerprint(project);
  const state={pid,id,scope,floor,trimSeqs,trimHashes:hashes,exactSeq:s.exactSeq,differentSeq:s.differentSeq,
    metadataRecords:M.metadataRecords(initial),maintenanceControlHash,foreignProjects,
    historyRows:384,historyPaddingCharsPerSide:32768,unrelatedDrawings:32,heldBlobBytes:64*65536,pendingEdits};
  window.__operationFixture=state;return state;
}"""

OPERATE = r"""async ({fixture,baseline})=>{
  const R=SentlogRecords,a=__storageAudit,{scope,pid,id,floor}=fixture,DRAW='surveyFieldNoteDrawingV1:',WS='surveyFieldNoteWorkspaceV1';
  const reports=[];const sample=(phase)=>reports.push({...a.report(),phase});
  a.reset('current-project-pending',floor);const pending=await R.deltaJournal.pending({scope,localProjectId:pid});sample('pending');
  if(pending.count!==0)throw Error('Fresh current project unexpectedly has pending records');
  const key=DRAW+id,raw=R.getItem(key),workspace=R.getItem(WS);
  a.reset('current-project-projection',floor);
  const projected=await R.deltaJournal.applyProjection({scope,localProjectId:pid,writes:[[key,raw]],expectedRecords:[[WS,workspace],[key,raw]],metadataRecords:fixture.metadataRecords,validate:()=>true});
  sample('projection');if(!projected.applied)throw Error('Unchanged projection unexpectedly deferred');
  if(baseline)return {reports,pending,projectionApplied:projected.applied};
  a.reset('current-project-save',floor);const value=JSON.parse(raw);value.shapes[0].memo='通常画面で保存した新しい所見';R.setItem(key,JSON.stringify(value));await R.settled();R.assertSafe();sample('save');
  a.reset('current-project-pending-after-save',floor);const after=await R.deltaJournal.pending({scope,localProjectId:pid});sample('pending-after-save');
  if(after.count!==1)throw Error('One real save did not create exactly one pending intent');
  a.reset('current-project-real-replay',floor);
  const D=SentlogDeltaSyncCore,M=SentlogDeltaMetadata,store=SentlogDeltaIndexedDB.createStore({...scope});
  const transport={online:()=>false,push:async()=>{throw Error('Unexpected push');},pushGroup:async()=>{throw Error('Unexpected group push');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
  const replica=D.createReplica({...scope,store,transport,reconcileIntervalMs:0});
  const bridge=SentlogDeltaAppBridge.createBridge({replica,scope,localProjectId:pid,currentScope:()=>scope});
  const controller=SentlogDeltaAppJournal.createController({records:R,scope,localProjectId:pid,replica,replicaStore:store,bridge,metadata:M,currentScope:()=>scope});
  try{await controller.drain();}finally{controller.close();bridge.close();replica.close();store.close();}
  sample('real-replay');
  a.reset('current-project-pending-after-replay',floor);const drained=await R.deltaJournal.pending({scope,localProjectId:pid});sample('pending-after-replay');
  const savedMemo=JSON.parse(R.getItem(key)).shapes[0].memo;
  if(drained.count!==0||savedMemo!=='保存済みの所見\n\n通常画面で保存した新しい所見')throw Error('Real replay lost the original or appended comment, or did not acknowledge the edit');
  const foreignProjects={};for(const project of JSON.parse(R.getItem(WS)).projects)if(project.id!==pid)foreignProjects[project.id]=await __operationHelpers.fingerprint(project);
  return {reports,pendingBefore:pending.count,pendingAfterSave:after.count,pendingAfterReplay:drained.count,realReplay:true,foreignProjects};
}"""


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def store_rows(snapshot, name, database="surveyFieldNoteDB"):
    return dict(snapshot["databases"][database]["stores"][name]["rows"])


def assert_preserved(before, after, fixture, *, maintained=False):
    for database in before["databases"]:
        if database == "sentlog-original-photos-v1":
            assert before["databases"][database] == after["databases"][database], "Original photos changed"
    exempt_files = {"__sentlog_records_meta_v130__", "__sentlog_record__:surveyFieldNoteWorkspaceV1", "__sentlog_record__:surveyFieldNoteDrawingV1:" + fixture["id"]}
    if maintained:
        exempt_files = {"page-replace-backup:one", "page-replace-backup-meta:one"}
    for key, digest in store_rows(before, "files").items():
        if key not in exempt_files:
            assert store_rows(after, "files").get(key) == digest, ("Existing live record/file changed", key)
    old_rows, new_rows = store_rows(before, "sentlog_delta_journal_v1"), store_rows(after, "sentlog_delta_journal_v1")
    for key, digest in old_rows.items():
        if maintained and key == fixture["exactSeq"]:
            assert key not in new_rows, "Proven redundant retained file was not removed"
        elif maintained and key in fixture["trimSeqs"]:
            assert new_rows.get(key) == fixture["trimHashes"][str(key)], "Unsent intent changed beyond redundant workspace fields"
        else:
            assert new_rows.get(key) == digest, ("Existing journal bytes changed", key)
    if maintained:
        assert len(old_rows) == len(new_rows) + 1, "Unexpected whole journal removal"
        assert len(store_rows(before, "files")) == len(store_rows(after, "files")) + 2, "Unexpected live-file change"
        for key in exempt_files:
            assert key not in store_rows(after, "files"), "Exact inactive backup was not removed"
        old_control, new_control = store_rows(before, "sentlog_delta_control_v1"), store_rows(after, "sentlog_delta_control_v1")
        assert old_control.keys() == new_control.keys(), "Maintenance changed control-row membership"
        for key, digest in old_control.items():
            expected = fixture["maintenanceControlHash"] if key in {"clock", "file:page-replace-backup:one", "file:page-replace-backup-meta:one"} else digest
            assert new_control[key] == expected, ("Maintenance changed protected control data", key)
        assert before["localStorage"] == after["localStorage"], "Maintenance changed local preferences"
        for database in before["databases"]:
            if database != "surveyFieldNoteDB":
                assert before["databases"][database] == after["databases"][database], ("Maintenance changed another database", database)


def assert_bounded(report):
    assert report["bulkJournal"] == 0, ("Unbounded journal value read", report)
    assert report["bulkRecords"] == 0, ("Whole current-record mirror was rehydrated", report)
    # pending/projection share the legacy orphan threshold. The fixture makes
    # cutoffSeq == ackedSeq, so these phases must not touch any older row.
    if report["phase"] in ("pending", "projection", "pending-after-save", "pending-after-replay"):
        assert report["oldJournalValues"] == 0, ("Read history below the current cutoff", report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("chromium", "webkit"), required=True)
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--baseline-writer", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    if not args.out.is_relative_to(Path("/tmp")):
        parser.error("--out must be under /tmp")
    args.out.mkdir(parents=True, exist_ok=True)
    root = args.built_root.resolve()
    baseline = args.baseline_writer.read_bytes()
    assert hashlib.sha256(baseline).hexdigest() == BASELINE_SHA256, "The frozen v2.15 reproduction source changed"
    summary = {"format": "sentlog-operation-scale-v1", "status": "running", "engine": args.engine,
               "playwrightVersion": package_version("playwright"), "viewport": {"width": 320, "height": 760},
               "productionHTML": True, "nativeIndexedDB": True, "persistentFreshProfiles": True,
               "externalTrafficBlocked": True, "externalWritesCompleted": 0,
               "customerDataUsed": False, "physicalDeviceTested": False, "physicalMemoryMeasured": False,
               "baselineWriterSHA256": BASELINE_SHA256, "fixtureSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "cases": []}
    write_json(args.out / "summary.json", summary)
    assert summary["playwrightVersion"] == "1.62.0", "Pinned Playwright 1.62.0 required"
    summary["sourceModules"] = [{"path": "sentlog/" + name, "sha256": hashlib.sha256((root / "sentlog" / name).read_bytes()).hexdigest()}
                                for name in (*MODULES, "index.html", "storage-maintenance.html", "startup-storage-maintenance.js")]

    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            path = urlparse(self.path).path
            if path in (FIXTURE, "/__writer_v215__.js"):
                body = baseline if path.endswith(".js") else b'<!doctype html><meta charset="utf-8"><title>Synthetic native fixture</title>'
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript" if path.endswith(".js") else "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                super().do_GET()

        def log_message(self, *_args):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    try:
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory(prefix="sentlog-operation-profiles-", dir="/tmp") as profiles, bounded_playwright(sync_playwright) as playwright:
            for name in CASES:
                case = {"name": name, "status": "running", "blockedRequests": [], "pageErrors": [], "crashes": [], "phases": []}
                destination = args.out / (name + ".json")

                def progress(phase):
                    case["phase"] = phase
                    case["phases"].append(phase)
                    write_json(destination, case)
                    print(json.dumps({"case": name, "phase": phase, "status": case["status"]}), flush=True)

                def route(request):
                    url = request.request.url
                    if url.startswith(origin + "/"):
                        request.continue_()
                    elif url.startswith("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/"):
                        asset = "export-pdf.worker.min.js" if "worker" in url else "export-pdf.min.js"
                        request.fulfill(content_type="text/javascript", body=(root / "sentlog/vendor" / asset).read_bytes())
                    else:
                        case["blockedRequests"].append({"host": urlparse(url).hostname, "method": request.request.method})
                        request.abort()

                def launch():
                    with deadline(45, "fresh persistent browser"):
                        context = getattr(playwright, args.engine).launch_persistent_context(
                            str(Path(profiles) / name), headless=True, viewport={"width": 320, "height": 760},
                            is_mobile=True, has_touch=True, service_workers="block", timeout=30000)
                    context.route("**/*", route)
                    context.add_init_script(AUDIT + HELPERS)
                    page = context.pages[0] if context.pages else context.new_page()
                    page.set_default_timeout(30000)
                    page.on("pageerror", lambda error: case["pageErrors"].append(str(error)[:800]))
                    page.on("crash", lambda *_args: case["crashes"].append(case.get("phase")))
                    return context, page

                def close(context):
                    with deadline(15, "native context close"):
                        context.close()

                def shot(page, label):
                    with deadline(12, "native screenshot"):
                        page.screenshot(path=str(args.out / (name + "-" + label + ".png")), full_page=True, timeout=10000)

                context = None
                progress("start")
                try:
                    context, page = launch()
                    page.goto(origin + FIXTURE, wait_until="load")
                    for module in MODULES[:-1]:
                        page.add_script_tag(url=origin + "/sentlog/" + module)
                    progress("seed-real-retention-and-originals")
                    evaluate_async(page, PREPARE, "native-files-and-backups", label=name + " native seed")
                    progress("seed-large-unrelated-journal")
                    fixture = evaluate_async(page, EXPAND, {"pendingEdits": 3 if name == "standalone-large-journal" else 0}, label=name + " large history")
                    case["fixture"] = fixture
                    before = evaluate_async(page, "async()=>__operationHelpers.snapshot()", label=name + " original byte proof")
                    case["beforeSHA256"] = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()
                    close(context)
                    context = None
                    context, page = launch()
                    if name == "v215-read-amplification":
                        progress("load-frozen-v215-writer")
                        page.goto(origin + FIXTURE, wait_until="load")
                        page.add_script_tag(url=origin + "/__writer_v215__.js")
                        evaluate_async(page, "async()=>SentlogRecords.init()", label="v215 native init")
                        result = evaluate_async(page, OPERATE, {"fixture": fixture, "baseline": True}, label="v215 read amplification")
                        assert all(r["bulkJournal"] > 0 and r["bulkRecords"] > 0 for r in result["reports"]), "The v2.15 source did not reproduce the former unbounded reads"
                        case["observedOldRegression"] = result
                    elif name == "full-app-large-journal":
                        progress("load-real-production-app")
                        page.goto(origin + "/sentlog/", wait_until="domcontentloaded")
                        page.wait_for_function("window.sentlogAppReady&&window.SentlogDeltaAppJournal&&document.getElementById('sentlogSettingsBtn')", timeout=45000)
                        evaluate_async(page, "async()=>await sentlogAppReady", label="full app readiness")
                        # The production loader calls document.open/write,
                        # which removes document listeners from init_script.
                        page.evaluate("__storageAudit.bindClicks()")
                        assert page.evaluate("SentlogRecords.journalReadBudgetVersion===1&&SentlogRecords.maintenanceInitVersion===1"), "Current bounded reader capabilities missing"
                        assert page.locator("#projectsView").is_visible()
                        case["startupReads"] = page.evaluate("__storageAudit.report()")
                        document_id = page.evaluate("__storageAudit.documentId")
                        shot(page, "top")
                        progress("trusted-full-app-navigation")
                        page.evaluate("__storageAudit.reset('full-app-navigation')")
                        for cycle in range(3):
                            page.locator("#sentlogSettingsBtn").click()
                            assert page.locator("#sentlogSettingsModal").get_attribute("aria-hidden") == "false"
                            if cycle == 0:
                                shot(page, "settings")
                            page.locator("#sentlogSettingsClose").click()
                            page.locator("#projectsGrid .manager-card").filter(has_text="通常操作の合成案件").click()
                            assert page.locator("#drawingsView").is_visible()
                            assert page.locator("#drawingProjectTitle").inner_text() == "通常操作の合成案件"
                            if cycle == 0:
                                shot(page, "project")
                            page.locator("#navBackBtn").click()
                            assert page.locator("#projectsView").is_visible()
                        case["navigationReads"] = page.evaluate("__storageAudit.report()")
                        assert_bounded(case["navigationReads"])
                        assert case["navigationReads"]["blobValues"] == 0, "Ordinary navigation scanned native file values"
                        case["trustedClicks"] = case["navigationReads"]["clicks"]
                        assert len(case["trustedClicks"]) >= 12 and all(c["trusted"] for c in case["trustedClicks"]), "Trusted navigation audit is missing or incomplete"
                        assert page.evaluate("__storageAudit.documentId") == document_id, "An ordinary operation unexpectedly reloaded the page"
                        progress("real-save-pending-projection-replay")
                        result = evaluate_async(page, OPERATE, {"fixture": fixture, "baseline": False}, label="full app native operations")
                        for report in result["reports"]:
                            assert_bounded(report)
                        assert result["foreignProjects"] == fixture["foreignProjects"], "Current-project replay changed another project"
                        case["operations"] = result
                        after = evaluate_async(page, "async()=>__operationHelpers.snapshot()", label="full app preserved bytes")
                        assert_preserved(before, after, fixture)
                        case["protectedNativeBytesPreserved"] = True
                    else:
                        progress("load-real-standalone-page")
                        page.goto(origin + "/sentlog/storage-maintenance.html", wait_until="load")
                        page.locator("#startupMaintenancePrepare").wait_for(state="visible")
                        page.wait_for_function("!document.getElementById('startupMaintenancePrepare').disabled")
                        page.set_viewport_size({"width": 320, "height": 568})
                        bounds = page.locator("#startupMaintenancePrepare").bounding_box()
                        assert bounds and bounds["y"] + bounds["height"] <= 400 and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 320, ("Prepare action is outside the initial small screen", bounds)
                        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"), "Standalone page overflows at 320 px"
                        case["initialPrepareBounds320x568"] = bounds
                        unopened = page.evaluate("__storageAudit.report()")
                        assert unopened["opens"] == unopened["transactions"] == 0 and not unopened["writes"], "Standalone page touched IndexedDB before the explicit action"
                        assert page.locator("#startupMaintenanceHost").is_hidden()
                        case["beforeExplicitAction"] = unopened
                        shot(page, "before-init")
                        progress("explicit-readonly-maintenance-init")
                        page.locator("#startupMaintenancePrepare").click()
                        page.locator("#startupMaintenanceHost").wait_for(state="visible")
                        ready = page.evaluate("__storageAudit.report()")
                        assert ready["bulkControls"] == ready["bulkJournal"] == ready["bulkRecords"] == ready["journalValues"] == 0 and not ready["writes"], ("Maintenance initialization hydrated or mutated retained data", ready)
                        case["maintenanceInit"] = ready
                        shot(page, "ready")
                        page.evaluate("""()=>{window.__maintenanceCalls=[];for(const method of ['compactRedundantRecords','compactRedundantFiles','compactRedundantPageBackups']){
                          const native=SentlogRecords.deltaJournal[method];SentlogRecords.deltaJournal[method]=async function(options){const result=await native.call(this,options);__maintenanceCalls.push({method,dryRun:options.dryRun,result});return result;};}}""")
                        progress("real-standalone-preview")
                        page.evaluate("__storageAudit.reset('maintenance-preview')")
                        page.locator("#sentlogStorageMaintenanceReview").click()
                        page.wait_for_function("!SentlogStorageMaintenanceUI.busy&&!document.getElementById('sentlogStorageMaintenanceReview').disabled")
                        assert not page.evaluate("__storageAudit.writes"), "Preview made native write requests"
                        preview = evaluate_async(page, "async()=>__operationHelpers.snapshot()", label="standalone readonly preview proof")
                        assert before == preview, "Opening or previewing maintenance changed an existing native value"
                        assert page.evaluate("__maintenanceCalls.filter(c=>c.dryRun).reduce((n,c)=>n+c.result.eligible,0)") == 4
                        shot(page, "preview")
                        progress("real-standalone-cleanup")
                        page.locator("#sentlogStorageMaintenanceRun").click()
                        page.wait_for_function("!SentlogStorageMaintenanceUI.busy&&!document.getElementById('sentlogStorageMaintenanceReview').disabled")
                        assert page.locator("#sentlogStorageMaintenanceStatus").inner_text() == "重複分の整理が完了しました。"
                        after = evaluate_async(page, "async()=>__operationHelpers.snapshot()", label="standalone retained bytes proof")
                        assert_preserved(before, after, fixture, maintained=True)
                        case["protectedNativeBytesPreserved"] = True
                        case["calls"] = page.evaluate("__maintenanceCalls")
                        shot(page, "result")
                        case["trustedClicks"] = page.evaluate("__storageAudit.clicks")
                        assert len(case["trustedClicks"]) >= 3 and all(c["trusted"] for c in case["trustedClicks"]), "Standalone click audit is missing or incomplete"
                        progress("ordinary-return-link")
                        assert page.locator("#startupMaintenanceOpenApp").evaluate("e=>e.href===location.origin+'/sentlog/'")
                        page.locator("#startupMaintenanceOpenApp").click()
                        page.wait_for_function("window.sentlogAppReady&&document.getElementById('sentlogSettingsBtn')", timeout=45000)
                        evaluate_async(page, "async()=>await sentlogAppReady", label="return to ordinary app")
                        assert page.locator("#projectsGrid .manager-card").filter(has_text="通常操作の合成案件").is_visible()
                        retained_pending = evaluate_async(page, "async f=>SentlogRecords.deltaJournal.pending({scope:f.scope,localProjectId:f.pid})", fixture, label="preserved pending edits after return")
                        assert retained_pending["count"] == 3, "Standalone cleanup removed an unacknowledged edit"
                        case["unacknowledgedEditsAfterReturn"] = retained_pending["count"]
                        case["ordinaryReturnSucceeded"] = True
                    assert not case["crashes"], case["crashes"]
                    assert not case["pageErrors"], case["pageErrors"]
                    case["status"] = "passed"
                except Exception as error:
                    case["status"] = "failed"
                    case["error"] = str(error)[:3500]
                    if context:
                        try:
                            with deadline(5, "failure-phase readback"):
                                case["lastNativeReads"] = page.evaluate("window.__storageAudit?.report()")
                            shot(page, "failure")
                        except Exception:
                            pass
                finally:
                    if context:
                        try:
                            close(context)
                        except Exception as error:
                            case["status"] = "failed"
                            case["cleanupError"] = str(error)[:600]
                    progress("finished")
                    summary["cases"].append({"name": name, "status": case["status"], "report": destination.name,
                                             "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
    except Exception as error:
        summary["error"] = str(error)[:3500]
    finally:
        server.shutdown()
        server.server_close()
        summary["status"] = "passed" if len(summary["cases"]) == len(CASES) and all(c["status"] == "passed" for c in summary["cases"]) else "failed"
        write_json(args.out / "summary.json", summary)
    print(json.dumps({"status": summary["status"], "engine": args.engine, "cases": summary["cases"]}), flush=True)
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

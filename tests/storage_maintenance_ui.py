"""Native, offline capacity-maintenance UI verification with disposable data.

Runs the unmodified built writer and maintenance UI in fresh Chromium/WebKit
contexts. Native IndexedDB, Blob reads and trusted button clicks are required.
Only scheduling gates and a declared native cursor failure are injected; the
maintenance APIs and their returned results are never replaced. No account,
production origin, external network, user profile or physical iPad is used.

Run in the existing GitHub browser workflow with Playwright exactly 1.62.0:
  python tests/storage_maintenance_ui.py --engine webkit --built-root . \
      --out /tmp/sentlog-storage-maintenance-webkit
Missing packages/engines and failed assertions return nonzero, never a skip.
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

ROOT = Path(__file__).resolve().parents[1]
CASES = ("records-preview-run", "claim-after-preview", "native-files-and-backups",
         "cancel-preview", "cancel-partial-run", "native-update-failure")
MODULES = ("record-collaboration.js", "delta-sync-core.js", "delta-sync-indexeddb.js",
           "delta-sync-metadata.js", "delta-sync-app-bridge.js", "delta-sync-app-journal.js",
           "record-store.js", "storage-maintenance-ui.js")
PREFIX = "sentlogStorageMaintenance"

HTML = """<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>合成データ：容量整理の確認</title><style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#eef2f6}
.modal-card{width:calc(100% - 16px);max-width:720px;margin:8px auto;padding:8px;background:white}
h1{font-size:18px;margin:8px}button{font:inherit;border:1px solid #64748b;border-radius:6px;background:#f8fafc}
</style><div id="sentlogSettingsModal" aria-hidden="false"><div class="modal-card">
<h1>合成データの設定画面</h1><section id="sentlogStorageSection">端末内の保存領域</section>
</div></div></html>"""

PREPARE = r"""async caseName=>{
  const R=SentlogRecords,C=SentlogRecordCollaboration,D=SentlogDeltaSyncCore,M=SentlogDeltaMetadata;
  const need=(value,message)=>{if(!value)throw Error(message);},copy=structuredClone,json=JSON.stringify;
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
  const scope={ownerId:'synthetic-owner',projectId:'synthetic-cloud',deviceId:'synthetic-device'},pid='synthetic-project';
  need(R.storageMaintenanceVersion===1&&R.projectionNoopVersion===1,'Current maintenance writer capabilities are required');
  const ids=['one','different','undo'],project={id:pid,name:'Synthetic project',drawings:ids.map(id=>({id,name:'Synthetic '+id}))};
  localStorage.setItem(WS,json({projects:[project],padding:'合成資料 日本語 😀 '.repeat(60)}));
  for(const id of ids)localStorage.setItem(DRAW+id,json({shapes:[C.upgrade({id:'record-'+id,memo:'Synthetic initial '+id,photos:[]})],collabDeletedRecords:[],pageSettings:{1:{scale:100}}}));
  localStorage.setItem('synthetic-do-not-change','unrelated local preference');
  await R.init();
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value instanceof Blob?await value.arrayBuffer():new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
  const blob=(size,byte,type)=>new Blob([new Uint8Array(size).fill(byte)],{type});
  const photo=blob(128*1024,65,'image/jpeg'),oldPhoto=blob(128*1024,66,'image/jpeg'),pdf=blob(32*1024,80,'application/pdf'),otherPdf=blob(32*1024,81,'application/pdf');
  for(const id of ids)await R.writeFile('background:'+id,pdf);
  await R.writeFile('photo:one:source',photo);
  if(caseName==='native-files-and-backups')await R.writeFile('photo:one:different',oldPhoto);
  const source=await new Promise((resolve,reject)=>{const q=indexedDB.open('sentlog-original-photos-v1',1);
    q.onupgradeneeded=()=>{q.result.createObjectStore('photos');q.result.createObjectStore('meta');};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  await new Promise((resolve,reject)=>{const tx=source.transaction(['photos','meta'],'readwrite');tx.objectStore('photos').put(photo,'synthetic-original');
    tx.objectStore('meta').put({id:'synthetic-original',exportedAt:null,size:photo.size},'synthetic-original');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});source.close();
  const cutoff=await R.deltaJournal.begin({scope,localProjectId:pid,actor:{deviceId:scope.deviceId,deviceName:'Synthetic'}});
  const s=window.__maintenance={caseName,WS,DRAW,LOG,CONTROL,scope,pid,need,hash,trimSeqs:[],keptSeqs:[],calls:[],mutations:[],clicks:[],faultAt:0,faultSeen:0,gate:null};
  async function disk(name='files'){
    const db=await R.openFilesDatabase();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(name,'readonly'),store=tx.objectStore(name);let keys,values;
      store.getAllKeys().onsuccess=e=>keys=e.target.result;store.getAll().onsuccess=e=>values=e.target.result;
      tx.oncomplete=()=>resolve(new Map(keys.map((key,index)=>[key,values[index]])));tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  async function snapshot(){
    async function normalized(value){
      if(value instanceof Blob)return {nativeBlob:true,size:value.size,type:value.type,sha256:await hash(value),
        ...(value instanceof File?{name:value.name,lastModified:value.lastModified}:{})};
      if(Array.isArray(value))return Promise.all(value.map(normalized));
      if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.keys(value).sort().map(async key=>[key,await normalized(value[key])])));
      return value;
    }
    const out={localStorage:Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)]),databases:{}};
    for(const info of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
      const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(info.name);q.onupgradeneeded=()=>q.transaction.abort();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      try{const names=Array.from(db.objectStoreNames),raw=await new Promise((resolve,reject)=>{const tx=db.transaction(names,'readonly'),stores={};
        for(const name of names){const rows=stores[name]=[],q=tx.objectStore(name).openCursor();q.onsuccess=()=>{const c=q.result;if(c){rows.push([c.key,c.value]);c.continue();}};}
        tx.oncomplete=()=>resolve(stores);tx.onabort=()=>reject(tx.error);});out.databases[info.name]={version:db.version,stores:await normalized(raw)};
      }finally{db.close();}
    }return out;
  }
  s.disk=disk;s.snapshot=snapshot;
  if(caseName==='native-files-and-backups'){
    const initial={...await M.seed(cutoff.snapshot)};
    for(const drawing of cutoff.snapshot.drawings)for(const record of drawing.state.shapes)initial[D.keyOf(drawing.meta.id,record.id)]=C.upgrade(record);
    const store=SentlogDeltaIndexedDB.createStore({...scope});await store.read();await store.write({version:2,scope:copy(scope),cursor:0,records:initial,outbox:[]});
    await R.deltaJournal.activate({scope,localProjectId:pid,baselineId:'synthetic-baseline',baselineSnapshot:cutoff.snapshot,metadataRecords:M.metadataRecords(initial)});
    const transport={online:()=>false,push:async()=>{throw Error('Unexpected network push');},pushGroup:async()=>{throw Error('Unexpected group push');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
    const replica=D.createReplica({...scope,store,transport,reconcileIntervalMs:0});
    const bridge=SentlogDeltaAppBridge.createBridge({replica,scope,localProjectId:pid,currentScope:()=>scope});
    const controller=SentlogDeltaAppJournal.createController({records:R,scope,localProjectId:pid,replica,replicaStore:store,bridge,metadata:M,currentScope:()=>scope});
    await R.writeFile('photo:one:exact',photo);await R.writeFile('photo:one:different',photo);
    await controller.drain();controller.close();bridge.close();replica.close();store.close();
    const rows=await disk(LOG);s.exactSeq=[...rows].find(([,row])=>row.files?.some(file=>file.key==='photo:one:exact'))?.[0];
    s.differentSeq=[...rows].find(([,row])=>row.files?.some(file=>file.key==='photo:one:different'))?.[0];
    need(Number.isSafeInteger(s.exactSeq)&&Number.isSafeInteger(s.differentSeq)&&[...rows.values()].every(row=>row.kind==='sentlog-file-retention'),'Actual replay did not create native retention rows');
    await R.writeFile('photo:one:unsent',oldPhoto);
    for(const id of ids){const backup=id==='different'?otherPdf:pdf,applied=id==='undo';
      await R.writeFile('page-replace-backup:'+id,backup);
      await R.writeFile('page-replace-backup-meta:'+id,new Blob([json({version:1,drawingId:id,applied,sourceSize:backup.size,sourceHash:await hash(backup)})],{type:'application/json'}));
    }
    s.expectedEligible=2;
  }else{
    if(caseName==='claim-after-preview')await R.deltaJournal.activate({scope,localProjectId:pid,baselineId:'synthetic-baseline',baselineSnapshot:cutoff.snapshot});
    const count=caseName==='cancel-partial-run'?41:caseName==='claim-after-preview'?3:3;
    for(let index=0;index<count;index++){
      const current=JSON.parse(R.getItem(DRAW+'one'));current.shapes[0].memo='Synthetic unsent edit '+index;R.setItem(DRAW+'one',json(current));await R.settled();
    }
    const rows=await disk(LOG),last=[...rows.keys()].at(-1),hasUnique=caseName!=='claim-after-preview',workspace=R.getItem(WS);
    const db=await R.openFilesDatabase();try{await new Promise((resolve,reject)=>{const tx=db.transaction(LOG,'readwrite'),log=tx.objectStore(LOG);
      for(const [seq,row]of rows){const unique=hasUnique&&seq===last;row.workspaceBefore=row.workspaceAfter=unique?json({projects:[],uniqueHistoricalText:'preserve this earlier snapshot'}):workspace;
        log.put(row,seq);(unique?s.keptSeqs:s.trimSeqs).push(seq);}
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
    s.expectedEligible=s.trimSeqs.length;
  }
  R.assertSafe();s.pendingBefore=await R.deltaJournal.pending({scope,localProjectId:pid});
  s.memoryBefore=R.keys().sort().map(key=>[key,R.getItem(key)]);s.before=await snapshot();
  s.resetObservations=()=>{s.calls=[];s.mutations=[];s.faultSeen=0;};
  s.armGate=dryRun=>{s.gate={dryRun,entered:false,released:false};};
  s.releaseGate=()=>{need(s.gate?.entered&&typeof s.gate.resolve==='function','No native result is waiting at the scheduling gate');s.gate.released=true;s.gate.resolve();};
  s.claimAfterPreview=async()=>{
    const claim=await R.deltaJournal.claim({scope,localProjectId:pid});need(claim&&claim.rowIds.length===s.trimSeqs.length,'Real claim did not pin every old row');
    s.claimId=claim.id;s.before=await snapshot();s.resetObservations();return {rowCount:claim.rowIds.length};
  };
  for(const method of ['compactRedundantRecords','compactRedundantFiles','compactRedundantPageBackups']){
    const native=R.deltaJournal[method];need(typeof native==='function','Missing actual maintenance API '+method);
    R.deltaJournal[method]=async function(options){
      const detail={method,options:{cursor:options.cursor,dryRun:options.dryRun,scanLimit:options.scanLimit,limit:options.limit}};
      try{const result=await native.call(this,options);detail.result=copy(result);s.calls.push(detail);
        if(method==='compactRedundantRecords'&&s.gate&&!s.gate.entered&&s.gate.dryRun===options.dryRun){s.gate.entered=true;await new Promise(resolve=>s.gate.resolve=resolve);}
        return result;
      }catch(error){detail.error={name:error.name,code:error.code||null};s.calls.push(detail);throw error;}
    };
  }
  for(const method of ['put','add','delete','clear']){const native=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){
    s.mutations.push({database:this.transaction.db.name,store:this.name,method,key:method==='put'||method==='add'?args[1]:args[0]});return native.apply(this,args);};}
  for(const method of ['update','delete']){const native=IDBCursor.prototype[method];IDBCursor.prototype[method]=function(...args){
    const store=this.source.objectStore||this.source;s.mutations.push({database:store.transaction.db.name,store:store.name,method:'cursor.'+method,key:this.primaryKey});
    if(method==='update'&&store.name===LOG&&s.faultAt&&++s.faultSeen===s.faultAt)throw new DOMException('Synthetic native maintenance update failure','UnknownError');
    return native.apply(this,args);};}
  for(const method of ['setItem','removeItem','clear']){const native=Storage.prototype[method];Storage.prototype[method]=function(...args){
    s.mutations.push({database:'web-storage',store:'storage',method,key:args[0]});return native.apply(this,args);};}
  document.addEventListener('click',event=>{if(event.target.id?.startsWith('sentlogStorageMaintenance'))s.clicks.push({id:event.target.id,trusted:event.isTrusted});},true);
  return {caseName,expectedEligible:s.expectedEligible,unacknowledgedIntents:s.pendingBefore.count,
    initialSnapshotSHA256:await hash(json(s.before)),nativeIndexedDB:true,nativeBlobBytesCompared:true,syntheticLargestPhotoBytes:photo.size};
}"""

PROVE = r"""async mode=>{
  const s=__maintenance,R=SentlogRecords,{need}=s,copy=structuredClone,json=JSON.stringify;
  const actual=await s.snapshot(),expected=copy(s.before),main=expected.databases.surveyFieldNoteDB.stores;
  let trimmed=0;
  if(mode==='records-complete'||mode==='records-partial'){
    const completed=s.calls.filter(call=>call.method==='compactRedundantRecords'&&call.options.dryRun===false&&call.result).reduce((sum,call)=>sum+call.result.updated,0);
    need(completed===(mode==='records-partial'?32:s.expectedEligible),'Unexpected count of completed native row updates');
    for(const [key,row]of main[s.LOG])if(s.trimSeqs.slice(0,completed).includes(key)){delete row.workspaceBefore;delete row.workspaceAfter;trimmed++;}
  }else if(mode==='files-complete'){
    main[s.LOG]=main[s.LOG].filter(([key])=>key!==s.exactSeq);
    const removed=['page-replace-backup:one','page-replace-backup-meta:one'];main.files=main.files.filter(([key])=>!removed.includes(key));
    const control=new Map(main[s.CONTROL]),sequence=control.get('clock')+1;
    for(const key of removed)control.set('file:'+key,sequence);control.set('clock',sequence);
    main[s.CONTROL]=[...control].sort(([a],[b])=>a<b?-1:a>b?1:0);
    need(actual.databases.surveyFieldNoteDB.stores[s.LOG].some(([key])=>key===s.differentSeq),'Different native file preimage was deleted');
    for(const key of ['page-replace-backup:different','page-replace-backup-meta:different','page-replace-backup:undo','page-replace-backup-meta:undo'])
      need(actual.databases.surveyFieldNoteDB.stores.files.some(([saved])=>saved===key),'Distinct or undo-active backup was lost');
    need(s.calls.some(call=>call.method==='compactRedundantFiles'&&call.result?.updated===1),'Native file retention was not exercised');
    need(s.calls.some(call=>call.method==='compactRedundantPageBackups'&&call.result?.updated===1),'Native redundant page backup was not exercised');
    trimmed=2;
  }
  need(json(actual)===json(expected),'Native state differs beyond the exact redundant fields/copies authorized by this scenario');
  need(json(R.keys().sort().map(key=>[key,R.getItem(key)]))===json(s.memoryBefore),'Maintenance changed the current record mirror');
  need(!R.pending&&!R.failed,'Maintenance left a writer failure or pending save');
  const pending=await R.deltaJournal.pending({scope:s.scope,localProjectId:s.pid});need(pending.count===s.pendingBefore.count,'Maintenance lost unacknowledged edits');
  if(mode==='preview'||mode==='unchanged'||mode==='cancel-preview')need(s.mutations.length===0,'Read-only/blocked operation made native mutation requests');
  need(s.clicks.every(click=>click.trusted),'UI verification used an untrusted programmatic button click');
  const status=document.getElementById('sentlogStorageMaintenanceStatus').textContent,result=document.getElementById('sentlogStorageMaintenanceResult').textContent;
  if(mode==='cancel-preview'||mode==='records-partial')need(status.startsWith('処理を中止しました。')&&result.includes('途中')&&!status.includes('完了'),'Cancellation was advertised as completed maintenance');
  if(mode==='failure')need(status.startsWith('整理を完了できませんでした：')&&!status.includes('整理が完了'),'Native failure was advertised as success');
  if(mode==='records-complete'||mode==='files-complete')need(status==='重複分の整理が完了しました。','Successful native maintenance did not finish in the real UI');
  return {mode,status,trimmedItems:trimmed,snapshotSHA256:await s.hash(json(actual)),allNativeStoresCompared:true,
    originalPhotoDatabasePreserved:true,currentRecordsAndLiveBlobsPreserved:true,unacknowledgedIntents:pending.count,
    mutations:copy(s.mutations),calls:copy(s.calls),trustedClicks:copy(s.clicks)};
}"""


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def click_control(page, suffix, case):
    control = page.locator("#" + PREFIX + suffix)
    control.wait_for(state="visible")
    control.scroll_into_view_if_needed()
    geometry = control.evaluate("""node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,
      viewport:innerWidth,visible:!!node.offsetParent,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1};}""")
    assert geometry["visible"] and geometry["hit"], f"{suffix} cannot receive a user click"
    assert geometry["height"] >= 44, f"{suffix} is too short for the intended touch UI"
    assert geometry["x"] >= -1 and geometry["x"] + geometry["width"] <= 321, f"{suffix} is clipped at 320px"
    assert not geometry["horizontalOverflow"], "The settings content overflows a 320px viewport"
    case["controls"].append({"button": suffix, **geometry})
    control.click()


def wait_finished(page):
    page.wait_for_function("document.getElementById('sentlogStorageMaintenanceSection').getAttribute('aria-busy')!=='true' && !document.getElementById('sentlogStorageMaintenanceReview').disabled")


def review(page, case):
    click_control(page, "Review", case)
    wait_finished(page)
    assert page.locator("#" + PREFIX + "Status").inner_text() == "確認が終わりました。内容を確認してから整理できます。"


def verify_repeat_empty(page, case):
    page.evaluate("async()=>{const s=__maintenance;s.before=await s.snapshot();s.resetObservations();}")
    review(page, case)
    assert page.locator("#" + PREFIX + "Run").is_hidden(), "A repeated empty review still offered deletion"
    assert "整理できる重複はありません" in page.locator("#" + PREFIX + "Result").inner_text()
    case["proofs"].append(page.evaluate(PROVE, "preview"))
    assert page.evaluate("__maintenance.calls.reduce((n,c)=>n+(c.result?.eligible||0),0)") == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("chromium", "webkit"), required=True)
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    if not args.out.is_relative_to(Path("/tmp")):
        parser.error("--out must be under /tmp; profiles and customer workspace files are never used")
    args.out.mkdir(parents=True, exist_ok=True)
    summary = {"format": "sentlog-storage-maintenance-native-ui-v1", "status": "running", "engine": args.engine,
               "viewport": {"width": 320, "height": 760}, "cases": [], "customerDataUsed": False,
               "productionOriginAccessed": False, "physicalDeviceTested": False, "physicalBytesReclaimedMeasured": False,
               "fullApplicationStarted": False, "settingsHostFixture": True, "externalTrafficBlocked": True,
               "fixtureSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    server = None
    try:
        from playwright.sync_api import sync_playwright
        summary["playwrightVersion"] = package_version("playwright")
        if summary["playwrightVersion"] != "1.62.0":
            raise RuntimeError("Playwright 1.62.0 is required; a different package is not a verified substitute")
        with tempfile.TemporaryDirectory(prefix="sentlog-native-maintenance-", dir="/tmp") as temporary:
            package = Path(temporary)
            (package / "index.html").write_text(HTML)
            summary["sourceModules"] = []
            for name in MODULES:
                data = (args.built_root.resolve() / "sentlog" / name).read_bytes()
                (package / name).write_bytes(data)
                summary["sourceModules"].append({"path": "sentlog/" + name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})

            class Handler(SimpleHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def end_headers(self):
                    self.send_header("Cache-Control", "no-store")
                    super().end_headers()

            server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=temporary))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            with sync_playwright() as playwright:
                browser = getattr(playwright, args.engine).launch(headless=True)
                summary["browserVersion"] = browser.version
                try:
                    for name in CASES:
                        case = {"name": name, "status": "running", "blockedRequests": [], "pageErrors": [], "controls": [], "proofs": []}
                        context = browser.new_context(service_workers="block", viewport={"width": 320, "height": 760}, locale="ja-JP")
                        page = context.new_page()
                        page.set_default_timeout(30000)

                        def route_request(route):
                            url = urlparse(route.request.url)
                            if f"{url.scheme}://{url.netloc}" == origin:
                                route.continue_()
                            else:
                                case["blockedRequests"].append({"scheme": url.scheme, "host": url.hostname})
                                route.abort()

                        context.route("**/*", route_request)
                        page.on("pageerror", lambda error: case["pageErrors"].append(str(error)[:600]))
                        try:
                            page.goto(origin + "/", wait_until="load")
                            for module in MODULES[:-1]:
                                page.add_script_tag(url=origin + "/" + module)
                            case["setup"] = page.evaluate(PREPARE, name)
                            page.add_script_tag(url=origin + "/storage-maintenance-ui.js")
                            page.locator("#" + PREFIX + "Section > summary").click()
                            assert page.locator("#" + PREFIX + "Run").is_hidden()
                            assert page.locator("#" + PREFIX + "Stop").is_hidden()
                            if name == "cancel-preview":
                                page.evaluate("__maintenance.armGate(true)")
                                click_control(page, "Review", case)
                                page.wait_for_function("__maintenance.gate.entered")
                                click_control(page, "Stop", case)
                                page.evaluate("__maintenance.releaseGate()")
                                wait_finished(page)
                                case["proofs"].append(page.evaluate(PROVE, "cancel-preview"))
                                assert page.locator("#" + PREFIX + "Review").inner_text() == "続きの重複を確認"
                                assert page.locator("#" + PREFIX + "Run").is_visible(), "Already reviewed candidates cannot be organized after a bounded preview"
                                review(page, case)
                                case["proofs"].append(page.evaluate(PROVE, "preview"))
                                assert page.evaluate("__maintenance.calls.filter(c=>c.method==='compactRedundantRecords').length") == 1, "Resuming the preview restarted the already completed record scan"
                            else:
                                review(page, case)
                                case["proofs"].append(page.evaluate(PROVE, "preview"))
                                assert page.evaluate("__maintenance.calls.reduce((n,c)=>n+(c.result?.eligible||0),0)") == case["setup"]["expectedEligible"]
                                page.screenshot(path=str(args.out / (name + "-preview.png")), full_page=True)
                                if name == "claim-after-preview":
                                    case["claim"] = page.evaluate("__maintenance.claimAfterPreview()")
                                else:
                                    page.evaluate("__maintenance.resetObservations()")
                                if name == "cancel-partial-run":
                                    page.evaluate("__maintenance.armGate(false)")
                                elif name == "native-update-failure":
                                    page.evaluate("__maintenance.faultAt=2")
                                click_control(page, "Run", case)
                                if name == "cancel-partial-run":
                                    page.wait_for_function("__maintenance.gate.entered")
                                    click_control(page, "Stop", case)
                                    page.evaluate("__maintenance.releaseGate()")
                                wait_finished(page)
                                mode = {"records-preview-run": "records-complete", "claim-after-preview": "unchanged",
                                        "native-files-and-backups": "files-complete", "cancel-partial-run": "records-partial",
                                        "native-update-failure": "failure"}[name]
                                case["proofs"].append(page.evaluate(PROVE, mode))
                                if name == "cancel-partial-run":
                                    assert page.locator("#" + PREFIX + "Run").inner_text() == "整理を続ける"
                                    click_control(page, "Run", case)
                                    wait_finished(page)
                                    case["proofs"].append(page.evaluate(PROVE, "records-complete"))
                                    assert page.evaluate("(()=>{const c=__maintenance.calls.filter(c=>c.method==='compactRedundantRecords');return c.length===2&&c[1].options.cursor===c[0].result.nextCursor;})()"), "Run continuation did not resume at its completed native cursor"
                                if name == "native-update-failure":
                                    assert page.evaluate("__maintenance.faultSeen") == 2
                                    assert page.locator("#" + PREFIX + "Run").inner_text() == "整理を続ける"
                                    page.evaluate("__maintenance.faultAt=0;__maintenance.resetObservations()")
                                    click_control(page, "Run", case)
                                    wait_finished(page)
                                    case["proofs"].append(page.evaluate(PROVE, "records-complete"))
                                if name in ("records-preview-run", "claim-after-preview", "native-files-and-backups", "cancel-partial-run", "native-update-failure"):
                                    verify_repeat_empty(page, case)
                            page.locator("#" + PREFIX + "Section > details > summary").click()
                            assert page.get_by_text("会社PCで案件一式を照合してから実行します。", exact=False).is_visible()
                            page.screenshot(path=str(args.out / (name + "-result.png")), full_page=True)
                            assert not case["blockedRequests"], "An external request was attempted"
                            assert not case["pageErrors"], "An unhandled browser error occurred"
                            case["status"] = "passed"
                        except Exception as error:
                            case["status"] = "failed"
                            case["error"] = str(error)[:3000]
                            try:
                                page.screenshot(path=str(args.out / (name + "-failure.png")), full_page=True)
                            except Exception:
                                pass
                        finally:
                            try:
                                context.close()
                            except Exception as error:
                                case["status"] = "failed"
                                case["cleanupError"] = str(error)[:600]
                            destination = args.out / (name + ".json")
                            write_json(destination, case)
                            summary["cases"].append({"name": name, "status": case["status"], "report": destination.name,
                                                     "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
                finally:
                    browser.close()
            summary["status"] = "passed" if len(summary["cases"]) == len(CASES) and all(case["status"] == "passed" for case in summary["cases"]) else "failed"
    except Exception as error:
        summary["status"] = "blocked" if not summary["cases"] else "failed"
        summary["error"] = str(error)[:3000]
    finally:
        if server:
            server.shutdown()
            server.server_close()
        write_json(args.out / "summary.json", summary)
    print(json.dumps({"status": summary["status"], "engine": args.engine, "cases": summary["cases"]}))
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

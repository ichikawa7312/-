"""Focused native storage checks using only synthetic disposable data.

--scenario writer runs the real record-store against native IndexedDB in either
engine. --scenario pc runs the real archive modules against Chromium OPFS and
native Web Locks/FileSystemWritableFileStream. Only the root queryPermission
answer is shimmed; this is not an OS folder-picker or physical-device test.
RPC replies are fixed local stubs, all external traffic is blocked, archive poll
timers are suppressed while its module loads, and its actual button is clicked.
Every case gets a fresh browser context. Profiles and sources are never exported.

Usage: python tests/storage_preservation_native_ui.py --engine chromium
       --scenario pc --built-root . --out /tmp/sentlog-native-pc
       python tests/storage_preservation_native_ui.py --engine webkit
       --scenario writer --built-root . --out /tmp/sentlog-native-writer
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
PC_CASES = ("normal-and-exact-retry", "conflicting-file", "conflicting-manifest",
            "exclusive-contention", "file-at-acquisition", "manifest-at-acquisition")
REGULAR_PC_CASES = ("normal", "foreign-at-acquisition", "matching-at-acquisition")

REGULAR_PC_CASE = r"""async scenario=>{
  const need=(condition,message)=>{if(!condition)throw Error(message);};
  const hash=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),x=>x.toString(16).padStart(2,'0')).join('');
  const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('synthetic-regular-pc',{create:true});
  const original=new Blob(['Synthetic regular PC original 日本語']),foreign=new Blob(['Synthetic unrelated file that must survive']);
  const asset={id:'00000000-0000-4000-8000-000000000001',sha256:await hash(original),byte_size:original.size};
  const preferredName='original.jpg',name=SentlogPcSafeBackup.versionedName(preferredName,asset);
  const handle=await directory.getFileHandle(name,{create:true}),nativeOpen=FileSystemFileHandle.prototype.createWritable;
  const operations=[],fixtureWrites=[];
  FileSystemFileHandle.prototype.createWritable=async function(options){
    need(this.name===name&&options?.mode==='exclusive','Unexpected normal-PC write target or mode');
    operations.push('open');
    if(scenario!=='normal'){
      const stream=await nativeOpen.call(this,{mode:'exclusive'});
      await stream.write(scenario==='foreign-at-acquisition'?foreign:original);await stream.close();fixtureWrites.push(this.name);
    }
    const stream=await nativeOpen.call(this,options);
    return new Proxy(stream,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
      return (...args)=>{if(['write','close','abort'].includes(key))operations.push(key);return value.apply(target,args);};}});
  };
  let result=null,errorCode=null,downloads=0;
  try{result=await SentlogPcSafeBackup.save({directory,preferredName,asset,download:async()=>{downloads++;return original;},hash,locks:navigator.locks});}
  catch(error){errorCode=error.code||error.name;}
  finally{FileSystemFileHandle.prototype.createWritable=nativeOpen;}
  const file=await handle.getFile(),sha256=await hash(file);
  if(scenario==='normal'){
    need(!errorCode&&result?.name===name&&sha256===asset.sha256,'Normal native PC save failed');
    need(JSON.stringify(operations)===JSON.stringify(['open','write','close']),'Normal native write did not commit once');
  }else{
    need(fixtureWrites.length===1,'Competing native file commit was not performed');
    need(JSON.stringify(operations)===JSON.stringify(['open','abort']),'Occupied native stream was not aborted before write/close');
    if(scenario==='foreign-at-acquisition')need(errorCode==='PC_BACKUP_COLLISION'&&sha256===await hash(foreign)&&result===null,'A foreign native file was replaced or accepted');
    else need(!errorCode&&result?.name===name&&sha256===asset.sha256,'Matching native file was not reused');
  }
  need(downloads===1,'Unexpected repeated source download');
  return {status:'passed',scenario,nativeFileSystem:true,nativeWebLocks:true,helperCalledDirectly:true,
    osFolderPickerTested:false,physicalDeviceTested:false,externalOsWriterTested:false,
    file:{size:file.size,sha256},errorCode,downloads,operations,fixtureWrites:fixtureWrites.length};
}"""

PC_PREPARE = r"""async scenario=>{
  const C=SentlogArchiveCore,need=(condition,message)=>{if(!condition)throw Error(message);};
  need(typeof navigator.storage.getDirectory==='function','Native OPFS is required');
  need(typeof navigator.locks?.request==='function','Native Web Locks are required');
  const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('synthetic-root',{create:true});
  const original=await root.getDirectoryHandle('original',{create:true});
  const blob=new Blob(['Synthetic native archive PDF 日本語'],{type:'application/pdf'});
  async function put(dir,name,value){const handle=await dir.getFileHandle(name,{create:true}),writer=await handle.createWritable({mode:'exclusive'});await writer.write(value);await writer.close();return handle;}
  await put(original,'drawing.pdf',blob);
  const job={id:'synthetic-job',project_id:'synthetic-project',revision:1,catalog_hash:'a'.repeat(64),
    payload:{project:{id:'local-project',name:'Synthetic project',drawings:[{id:'drawing'}]},drawings:[{meta:{id:'drawing'},state:{shapes:[],collabDeletedRecords:[]}}]},
    manifest:[{id:'synthetic-asset',key:'background:drawing',kind:'drawing',file_name:'drawing.pdf',byte_size:blob.size,sha256:await C.hash(blob),status:'storage_deleted',pc_path:'synthetic-root\\original\\drawing.pdf'}]};
  const recovery=await root.getDirectoryHandle('復旧用',{create:true}),project=await recovery.getDirectoryHandle(job.project_id,{create:true});
  const generation=await project.getDirectoryHandle(job.id,{create:true}),files=await generation.getDirectoryHandle('files',{create:true});
  const foreign=new Blob(['Synthetic different file that must survive']),foreignManifest=new Blob(['{"synthetic":"different manifest that must survive"}']);
  if(scenario==='conflicting-file')await put(files,'synthetic-asset',foreign);
  if(scenario==='conflicting-manifest')await put(generation,'manifest.sentlog.json',foreignManifest);
  if(['exclusive-contention','file-at-acquisition'].includes(scenario))await files.getFileHandle('synthetic-asset',{create:true});
  if(scenario==='manifest-at-acquisition')await generation.getFileHandle('manifest.sentlog.json',{create:true});
  const state=window.__nativePc={scenario,job,root,generation,files,foreign,foreignManifest,calls:[],clicks:{trusted:0,untrusted:0},
    operations:[],sourceReads:0,lockRequests:[],activeLocks:0,fixtureRaceWrites:0,openErrors:[],suppressedPolls:0};
  window.rootHandle=new Proxy(root,{get(target,key){if(key==='queryPermission')return async()=> 'granted';const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  window.session={user:{id:'synthetic-owner'}};window.ensureSession=async()=>{};window.ensureDevice=async()=> 'synthetic-pc';window.authHeaders=()=>({});
  window.SUPABASE_URL='https://example.invalid';window.BUCKET='synthetic';
  window.rest=async(path,options)=>{need(path==='/rest/v1/rpc/sentlog_archive_v1','Unexpected RPC path');const body=JSON.parse(options.body);
    need(['pc_jobs','pc_complete','pc_error'].includes(body.p_action),'Unexpected RPC action');
    state.calls.push({action:body.p_action,data:body.p_data,insideFileLock:state.activeLocks>0});return body.p_action==='pc_jobs'?[structuredClone(job)]:{};};
  const nativeGet=FileSystemFileHandle.prototype.getFile,nativeOpen=FileSystemFileHandle.prototype.createWritable;
  const nativeLock=navigator.locks.request.bind(navigator.locks);
  if(scenario==='exclusive-contention'){
    const handle=await files.getFileHandle('synthetic-asset');state.heldWriter=await nativeOpen.call(handle,{mode:'exclusive'});
    let entered;const held=new Promise(resolve=>entered=resolve);
    state.heldLock=nativeLock('sentlog-pc-safe-backup-v2',{mode:'exclusive'},()=>{entered();return new Promise(resolve=>state.releaseLock=resolve);});await held;
  }
  FileSystemFileHandle.prototype.getFile=function(){if(this.name==='drawing.pdf')state.sourceReads++;return nativeGet.call(this);};
  FileSystemFileHandle.prototype.createWritable=async function(options){
    const target=this.name==='synthetic-asset'||this.name==='manifest.sentlog.json';
    if(target)state.operations.push({name:this.name,operation:'open',mode:options?.mode||null});
    const inject=(scenario==='file-at-acquisition'&&this.name==='synthetic-asset')||
      (scenario==='manifest-at-acquisition'&&this.name==='manifest.sentlog.json');
    if(inject&&!state.fixtureRaceWrites){const external=await nativeOpen.call(this,{mode:'exclusive'});
      await external.write(this.name==='synthetic-asset'?foreign:foreignManifest);await external.close();state.fixtureRaceWrites++;}
    let stream;try{stream=await nativeOpen.call(this,options);}catch(error){if(target)state.openErrors.push({name:this.name,errorName:error.name});throw error;}
    if(!target)return stream;
    const name=this.name;
    return new Proxy(stream,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
      return (...args)=>{if(['write','close','abort'].includes(key))state.operations.push({name,operation:key});return value.apply(target,args);};}});
  };
  navigator.locks.request=(name,options,callback)=>{state.lockRequests.push({name,mode:options?.mode||null});return nativeLock(name,options,async lock=>{
    state.activeLocks++;try{return await callback(lock);}finally{state.activeLocks--;}
  });};
  // Suppress only the module's two automatic run registrations. Restore the
  // real timers immediately after the unmodified source has been loaded.
  const timeout=window.setTimeout,interval=window.setInterval;
  window.setTimeout=(fn,delay,...args)=>{if(fn.name==='run'&&delay===3000){state.suppressedPolls++;return 0;}return timeout(fn,delay,...args);};
  window.setInterval=(fn,delay,...args)=>{if(fn.name==='run'&&delay===15000){state.suppressedPolls++;return 0;}return interval(fn,delay,...args);};
  window.__finishPcModule=()=>{window.setTimeout=timeout;window.setInterval=interval;
    document.querySelector('main button').addEventListener('click',event=>state.clicks[event.isTrusted?'trusted':'untrusted']++);};
  state.expectedFileSHA=await C.hash(blob);state.foreignSHA=await C.hash(foreign);state.foreignManifestSHA=await C.hash(foreignManifest);
  return {scenario,expectedFileSHA:state.expectedFileSHA,sourceBytes:blob.size,permissionShim:'root queryPermission only',automaticPollsSuppressed:true};
}"""

PC_RELEASE_WEB_LOCK = r"""async()=>{
  const state=__nativePc,status=await navigator.locks.query(),name='sentlog-pc-safe-backup-v2';
  if(!status.held.some(x=>x.name===name&&x.mode==='exclusive')||!status.pending.some(x=>x.name===name&&x.mode==='exclusive')||state.operations.length)
    throw Error('The archive did not wait for the actual competing native Web Lock');
  const proof={heldExclusive:true,pendingExclusive:true,productWritableAttemptsWhileBlocked:state.operations.length};
  state.releaseLock();await state.heldLock;state.webLockProof=proof;return proof;
}"""

PC_PROOF = r"""async retry=>{
  const s=__nativePc,C=SentlogArchiveCore,need=(condition,message)=>{if(!condition)throw Error(message);};
  async function read(dir,name){try{const file=await(await dir.getFileHandle(name)).getFile();return {size:file.size,sha256:await C.hash(file),text:await file.text()};}
    catch(error){if(error.name==='NotFoundError')return null;throw error;}}
  const file=await read(s.files,'synthetic-asset'),manifest=await read(s.generation,'manifest.sentlog.json');
  const completed=s.calls.filter(x=>x.action==='pc_complete'),errors=s.calls.filter(x=>x.action==='pc_error');
  const successful=s.scenario==='normal-and-exact-retry'||retry;
  need(s.clicks.untrusted===0&&s.clicks.trusted===(retry?2:1),'Actual trusted button clicks are required');
  need(s.suppressedPolls===2,'Unexpected archive poll setup');
  need(s.lockRequests.length===(retry?2:1)&&s.lockRequests.every(x=>x.name==='sentlog-pc-safe-backup-v2'&&x.mode==='exclusive'),'Actual shared exclusive Web Lock not requested');
  need(s.operations.filter(x=>x.operation==='open').every(x=>x.mode==='exclusive'),'Native file opens must request exclusive access');
  if(successful){
    need(completed.length===(s.scenario==='normal-and-exact-retry'&&retry?2:1),'Missing completion receipt');
    need(completed.every(x=>!x.insideFileLock),'Network acknowledgement retained the filesystem lock');
    need(file?.sha256===s.expectedFileSHA&&manifest,'Saved native bytes do not match');
    const pack=JSON.parse(manifest.text);C.validatePack(pack,s.job);
    need(manifest.text===JSON.stringify(C.backupPack(s.job,{[s.job.manifest[0].key]:'files/synthetic-asset'})),'Manifest bytes changed');
    need(completed.at(-1).data.package_sha256===manifest.sha256&&completed.at(-1).data.file_count===1,'Receipt does not prove the saved native manifest');
    if(s.scenario==='normal-and-exact-retry'){
      need(errors.length===0,'Normal archive reported an error');
      need(s.operations.filter(x=>x.operation==='write').length===2&&s.operations.filter(x=>x.operation==='close').length===2,'Exact retry rewrote an existing file');
      if(retry)need(s.sourceReads===s.firstSourceReads,'Exact retry loaded the source again');
    }else need(errors.length===1,'The earlier exclusive collision must remain recorded');
  }else{
    need(completed.length===0&&errors.length===1,'Failure must not acknowledge completion');
    if(s.scenario==='conflicting-file'){
      need(file?.sha256===s.foreignSHA&&!manifest,'Conflicting native file was changed');need(s.operations.length===0&&s.sourceReads===0,'Conflicting file opened a writer or read its source');
    }else if(s.scenario==='conflicting-manifest'){
      need(manifest?.sha256===s.foreignManifestSHA&&!file,'Conflicting native manifest was changed');need(s.operations.length===0&&s.sourceReads===0,'Conflicting manifest opened a writer or read its source');
    }else if(s.scenario==='exclusive-contention'){
      need(file?.size===0&&!manifest,'Competing native writer changed committed bytes');
      need(s.operations.filter(x=>x.operation==='write'||x.operation==='close').length===0,'Exclusive collision still wrote bytes');
      need(s.openErrors.length===1&&s.openErrors[0].errorName==='NoModificationAllowedError','Actual native exclusive collision was not observed');
      need(s.webLockProof?.pendingExclusive===true,'Native Web Lock contention was not checked');
    }else{
      const target=s.scenario==='file-at-acquisition'?'synthetic-asset':'manifest.sentlog.json';
      need(s.fixtureRaceWrites===1,'The real synthetic competing write did not occur');
      need((target==='synthetic-asset'?file?.sha256===s.foreignSHA:manifest?.sha256===s.foreignManifestSHA),'File committed just before acquisition was overwritten');
      const operations=s.operations.filter(x=>x.name===target).map(x=>x.operation);
      need(JSON.stringify(operations)===JSON.stringify(['open','abort']),'Occupied native writer must abort without write or close');
      if(target==='manifest.sentlog.json')need(file?.sha256===s.expectedFileSHA,'Verified file copy was changed during manifest conflict');
    }
  }
  s.firstSourceReads=s.sourceReads;
  return {status:'passed',scenario:s.scenario,retry:!!retry,clicks:{...s.clicks},file:file&&{size:file.size,sha256:file.sha256},
    manifest:manifest&&{size:manifest.size,sha256:manifest.sha256},completed:completed.length,errors:errors.length,
    operations:structuredClone(s.operations),sourceReads:s.sourceReads,lockRequests:structuredClone(s.lockRequests),
    openErrors:structuredClone(s.openErrors),webLockProof:s.webLockProof||null,fixtureRaceWrites:s.fixtureRaceWrites,
    nativeFileSystem:true,rootPermissionAnswerShimmed:true,osFolderPickerTested:false,externalOsWriterTested:false};
}"""

WRITER_CASE = r"""async()=>{
  const r=SentlogRecords,need=(condition,message)=>{if(!condition)throw Error(message);};
  await r.init();await r.deltaJournal.begin({scope:{ownerId:'synthetic-owner',projectId:'synthetic-cloud',deviceId:'synthetic-device'},
    localProjectId:'synthetic-project',actor:{deviceId:'synthetic-device',deviceName:'Synthetic'},serverRevision:1});
  await r.deltaJournal.activate({scope:{ownerId:'synthetic-owner',projectId:'synthetic-cloud',deviceId:'synthetic-device'},localProjectId:'synthetic-project',baselineId:'synthetic-baseline'});
  const names=['files','sentlog_delta_journal_v1','sentlog_delta_control_v1'],meta='__sentlog_records_meta_v130__',key='surveyFieldNoteDrawingV1:synthetic-drawing';
  const db=await r.openFilesDatabase();
  async function read(){return new Promise((resolve,reject)=>{const tx=db.transaction(names,'readonly'),out={};
    for(const name of names){const rows=out[name]=[],q=tx.objectStore(name).openCursor();q.onsuccess=()=>{const c=q.result;if(c){rows.push([c.key,c.value]);c.continue();}};}
    tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error||Error('Native readonly proof aborted'));});}
  const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data)))),x=>x.toString(16).padStart(2,'0')).join('');
  const before=await read(),original=r.getItem(key),nativeTx=IDBDatabase.prototype.transaction,methods={},mutations=[],transactions=[];
  for(const method of ['put','add','delete','clear']){methods[method]=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){
    if(this.transaction.db.name==='surveyFieldNoteDB')mutations.push({store:this.name,method});return methods[method].apply(this,args);};}
  IDBDatabase.prototype.transaction=function(...args){const tx=nativeTx.apply(this,args);
    if(this.name==='surveyFieldNoteDB'&&args[1]==='readwrite')transactions.push({mode:args[1],requestedDurability:args[2]?.durability||null,nativeDurability:tx.durability||null});return tx;};
  try{
    r.setItem(key,JSON.stringify({shapes:[],collabDeletedRecords:[],memo:'temporary'}));r.setItem(key,original);await r.settled();r.assertSafe();
    const afterNoop=await read(),revision=new Map(before.files).get(meta).revision,clock=new Map(before[names[2]]).get('clock')||0;
    need(mutations.length===0&&transactions.length===1,'Net-zero input still created native mutation requests');
    need(JSON.stringify(afterNoop)===JSON.stringify(before),'Net-zero input changed native stored rows');
    need(!r.pending&&!r.failed,'Net-zero input left a false save failure or pending state');
    const noop={mutationRequests:0,readwriteTransactions:1,revision,clock,beforeSHA256:await hash(before),afterSHA256:await hash(afterNoop)};
    const changed=JSON.stringify({shapes:[],collabDeletedRecords:[],memo:'real subsequent edit'});r.setItem(key,changed);await r.settled();r.assertSafe();
    const after=await read(),files=new Map(after.files),control=new Map(after[names[2]]),rows=after[names[1]];
    need(transactions.length===2&&mutations.length===4,'A real edit must atomically write one intent, clock, record and META');
    need(files.get(meta).revision===revision+1&&(control.get('clock')||0)===clock+1,'No-op desynchronized the writer revision or journal clock');
    need(files.get('__sentlog_record__:'+key)===changed&&rows.length===1,'Subsequent real edit or its replay intent was lost');
    need(rows[0][1].changes.length===1&&rows[0][1].changes[0].before===original&&rows[0][1].changes[0].after===changed,'Replay before/after image changed');
    need(!r.pending&&!r.failed,'Real edit did not settle safely');
    return {status:'passed',nativeIndexedDB:true,noop,realEdit:{mutationRequests:mutations.length,readwriteTransactions:transactions.length-1,
      revision:files.get(meta).revision,clock:control.get('clock'),journalRows:rows.length,mutations,afterSHA256:await hash(after)},transactions,
      quotaInjected:false,nativeEvictionInduced:false,physicalStorageUsageMeasured:false};
  }finally{IDBDatabase.prototype.transaction=nativeTx;for(const [method,value]of Object.entries(methods))IDBObjectStore.prototype[method]=value;db.close();}
}"""


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("chromium", "webkit"), required=True)
    parser.add_argument("--scenario", choices=("writer", "pc", "regular-pc"), required=True)
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.scenario in ("pc", "regular-pc") and args.engine != "chromium":
        parser.error("The PC archive fixture targets Chromium OPFS; it must not be treated as a WebKit pass or skipped assertion")
    args.out.mkdir(parents=True, exist_ok=True)
    summary = {"format": "sentlog-storage-preservation-native-v1", "engine": args.engine, "scenario": args.scenario,
               "status": "running", "cases": [], "customerDataUsed": False, "productionOriginAccessed": False,
               "physicalDeviceTested": False, "nativeProfileFilesInspected": False,
               "fixtureSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    server = None
    try:
        from playwright.sync_api import sync_playwright
        summary["playwrightVersion"] = package_version("playwright")
        module_names = {"pc": ("archive-core.js", "archive-pc.js"), "regular-pc": ("pc-safe-backup.js",), "writer": ("record-store.js",)}[args.scenario]
        with tempfile.TemporaryDirectory(prefix="sentlog-native-preservation-assets-") as temporary:
            package = Path(temporary)
            (package / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>Synthetic native storage verification</title><main></main>')
            summary["sourceModules"] = []
            for name in module_names:
                source = args.built_root.resolve() / "sentlog" / name
                data = source.read_bytes()
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
                    case_names={"pc": PC_CASES, "regular-pc": REGULAR_PC_CASES, "writer": ("net-zero-and-real-edit",)}[args.scenario]
                    for case_name in case_names:
                        case = {"name": case_name, "status": "running", "blockedRequests": [], "pageErrors": [], "proofs": []}
                        context = browser.new_context(service_workers="block")
                        page = context.new_page()
                        page.set_default_timeout(20000)

                        def route_request(route):
                            url = urlparse(route.request.url)
                            if f"{url.scheme}://{url.netloc}" == origin:
                                route.continue_()
                            elif args.scenario == "regular-pc":
                                page.add_script_tag(url=origin + "/pc-safe-backup.js")
                                case["proofs"].append(page.evaluate(REGULAR_PC_CASE, case_name))
                            else:
                                case["blockedRequests"].append({"scheme": url.scheme, "host": url.hostname})
                                route.abort()

                        context.route("**/*", route_request)
                        page.on("pageerror", lambda error: case["pageErrors"].append(str(error)[:600]))
                        try:
                            page.goto(origin + "/", wait_until="load")
                            if args.scenario == "pc":
                                page.add_script_tag(url=origin + "/archive-core.js")
                                case["setup"] = page.evaluate(PC_PREPARE, case_name)
                                page.add_script_tag(url=origin + "/archive-pc.js")
                                page.evaluate("__finishPcModule()")
                                button = page.get_by_role("button", name="保管の確認を実行", exact=True)
                                button.click()
                                if case_name == "exclusive-contention":
                                    page.wait_for_function("__nativePc.lockRequests.length===1")
                                    case["webLockContention"] = page.evaluate(PC_RELEASE_WEB_LOCK)
                                page.wait_for_function("!document.querySelector('main button').disabled && __nativePc.calls.some(x=>x.action==='pc_complete'||x.action==='pc_error')")
                                case["proofs"].append(page.evaluate(PC_PROOF, False))
                                if case_name in ("normal-and-exact-retry", "exclusive-contention"):
                                    if case_name == "exclusive-contention":
                                        page.evaluate("async()=>{await __nativePc.heldWriter.abort();__nativePc.heldWriter=null;}")
                                    button.click()
                                    page.wait_for_function("!document.querySelector('main button').disabled && __nativePc.calls.filter(x=>x.action==='pc_complete'||x.action==='pc_error').length===2")
                                    case["proofs"].append(page.evaluate(PC_PROOF, True))
                            else:
                                page.evaluate("""()=>{
                                  localStorage.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify({projects:[{id:'synthetic-project',name:'Synthetic',drawings:[{id:'synthetic-drawing',name:'Synthetic drawing'}]}]}));
                                  localStorage.setItem('surveyFieldNoteDrawingV1:synthetic-drawing',JSON.stringify({shapes:[],collabDeletedRecords:[],memo:'original'}));
                                }""")
                                page.add_script_tag(url=origin + "/record-store.js")
                                case["proofs"].append(page.evaluate(WRITER_CASE))
                            assert not case["blockedRequests"], "An unexpected external request was attempted"
                            assert not case["pageErrors"], "The native module raised an unhandled page error"
                            case["status"] = "passed"
                        except Exception as error:
                            case["status"] = "failed"
                            case["error"] = str(error)[:3000]
                        finally:
                            try:
                                context.close()
                            except Exception as error:
                                case["status"] = "failed"
                                case["cleanupError"] = str(error)[:600]
                            destination = args.out / (case_name + ".json")
                            write_json(destination, case)
                            summary["cases"].append({"name": case_name, "status": case["status"], "report": destination.name,
                                                     "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
                finally:
                    browser.close()
            summary["status"] = "passed" if all(case["status"] == "passed" for case in summary["cases"]) else "failed"
    except Exception as error:
        summary["status"] = "blocked" if not summary["cases"] else "failed"
        summary["error"] = str(error)[:3000]
    finally:
        if server:
            server.shutdown()
            server.server_close()
        write_json(args.out / "summary.json", summary)
    print(json.dumps({"status": summary["status"], "engine": args.engine, "scenario": args.scenario, "cases": summary["cases"]}))
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

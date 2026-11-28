"""Authenticated normal startup, real touch edits and bounded live runtimes.

The actual production entry, IndexedDB, migration, replicas and photo previews
run unchanged. Existing disposable PostgreSQL/Auth/Storage/Realtime fixtures
terminate every service request. No importing flag or Blob fallback is used.
"""
import argparse
import base64
import copy
import functools
import hashlib
import json
import struct
import tempfile
import threading
import time
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import collaboration_ui as collaboration
import delta_app_ui as delta
import edit_sync_ui as base
from storage_maintenance_ui import bounded_playwright, deadline, evaluate_async
from storage_operation_scale_ui import AUDIT, HELPERS

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = "/__normal_residency_fixture__.html"
PROJECTS = 8
MEMO = "通常画面で端末内保存と自動共有を確認。"
PENDING_MEMO = "再起動前に保存した未送信の所見。"

OBSERVE = r"""(() => {
  const a=__storageAudit,n=window.__normalResidency={factories:{},events:[],init:[],touch:[],inputs:[],requests:[]};
  const add=(list,v)=>{if(list.length<500)list.push(v);};
  const counts=()=>({bulkControls:a.bulkControls,bulkJournal:a.bulkJournal,bulkRecords:a.bulkRecords});
  let records,firstInit=false;
  Object.defineProperty(window,'SentlogRecords',{configurable:true,get:()=>records,set(value){records=value;
    const init=value.init;value.init=function(...args){const measured=!firstInit;firstInit=true;const before=counts();
      return Promise.resolve(init.apply(this,args)).then(result=>{if(measured){const after=counts();
        n.init.push(Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-before[k]])));}return result;});};
  }});
  const hooks=[['SentlogDeltaSyncCore','createReplica','replica'],['SentlogDeltaAppJournal','createController','controller'],
    ['SentlogDeltaAppBridge','createBridge','bridge'],['SentlogDeltaAssetRuntime','createRuntime','assets']];
  for(const [name,method,kind]of hooks){let value;Object.defineProperty(window,name,{configurable:true,get:()=>value,set(next){value=next;
    const create=next[method];next[method]=function(...args){const result=create.apply(this,args);if(a.suspended)return result;
      const c=n.factories[kind]||(n.factories[kind]={created:0,closed:0,live:0,peak:0});c.created++;c.live++;c.peak=Math.max(c.peak,c.live);
      add(n.events,{kind,event:'create',project:args[0]?.scope?.projectId||args[0]?.projectId,live:c.live});
      const close=result.close;let closed=false;result.close=function(...values){if(!closed){closed=true;c.closed++;c.live--;
        add(n.events,{kind,event:'close',live:c.live});}return close?.apply(this,values);};return result;};
  }});}
  n.bind=()=>{
    a.bindClicks();
    for(const type of ['touchstart','touchend','pointerdown','pointerup'])document.addEventListener(type,e=>
      add(n.touch,{type,trusted:e.isTrusted,pointerType:e.pointerType||null,id:e.target?.id||null}),{capture:true,passive:true});
    document.addEventListener('input',e=>add(n.inputs,{id:e.target?.id,trusted:e.isTrusted}),true);
  };
})();"""

SEED = r"""async ({packs,encoded,owner,device})=>{
  const R=SentlogRecords,C=SentlogRecordCollaboration,h=__operationHelpers;
  // Large existing records belong in the application's native store. Staging
  // all upgraded histories in localStorage would test its separate quota.
  await R.init();const writes=[];
  for(const pack of packs){pack.project.collaborationVersion=1;for(const drawing of pack.drawings){
    drawing.state.shapes=drawing.state.shapes.map(record=>C.upgrade(record));
    writes.push(['surveyFieldNoteDrawingV1:'+drawing.meta.id,JSON.stringify(drawing.state)]);}}
  writes.unshift(['surveyFieldNoteWorkspaceV1',JSON.stringify({projects:packs.map(p=>p.project)})]);
  R.batch(writes);await R.settled();
  const image=new File(['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="white"/></svg>'],
    'fixture.svg',{type:'image/svg+xml',lastModified:1});
  const photo=new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],'synthetic.png',{type:'image/png',lastModified:1});
  for(const pack of packs)for(const drawing of pack.drawings)await R.writeFile('background:'+drawing.meta.id,image);
  for(const p of packs[0].drawings[0].state.shapes[0].photos)await R.writeFile('photo:'+packs[0].drawings[0].meta.id+':'+p.id,photo);
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('sentlog-original-photos-v1',1);
    q.onupgradeneeded=()=>{q.result.createObjectStore('photos');const m=q.result.createObjectStore('meta',{keyPath:'key'});
      for(const key of ['createdAt','exportedAt','projectId'])m.createIndex(key,key);};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{const tx=db.transaction(['photos','meta'],'readwrite'),done=h.completed(tx),drawing=packs[0].drawings[0],key=drawing.meta.id+':original';
    tx.objectStore('photos').put(photo,key);tx.objectStore('meta').put({key,drawingId:drawing.meta.id,photoId:'original',
      projectId:packs[0].project.id,projectName:packs[0].project.name,drawingName:drawing.meta.name,shapeId:'survey-a',shapeLabel:'調査-1',
      exportName:'original.png',originalName:'original.png',type:photo.type,size:photo.size,lastModified:1,
      createdAt:1,storedAt:1,originalRevision:'synthetic-preserved-original',exportedAt:null,packageName:null});await done;
  }finally{db.close();}
  localStorage.setItem('sentlogCloudSessionV1',JSON.stringify({access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',
    expires_at:4102444800,user:{id:owner,email:'fixture@example.invalid'}}));
  localStorage.setItem('sentlogCloudDeviceV1',device);await R.settled();R.assertSafe();return packs;
}"""

RETAIN_HISTORY = r"""async ({drawingId,memo})=>{
  const R=SentlogRecords,h=__operationHelpers,key='surveyFieldNoteDrawingV1:'+drawingId;
  const drawing=JSON.parse(R.getItem(key));drawing.shapes[0]=SentlogRecordCollaboration.appendComment(drawing.shapes[0],memo,
    {commentId:'pre-restart-unsent',revisionId:'pre-restart-unsent-v1',at:Date.now(),
      actor:{deviceId:localStorage.getItem('sentlogCloudDeviceV1'),deviceName:'合成iPhone'}});
  R.setItem(key,JSON.stringify(drawing));await R.settled();
  const db=await R.openFilesDatabase();try{
    let tx=db.transaction(['sentlog_delta_journal_v1','sentlog_delta_control_v1'],'readonly'),done=h.completed(tx);
    const rows=await h.request(tx.objectStore('sentlog_delta_journal_v1').getAll());await done;
    const template=rows.find(row=>row.kind==='sentlog-app-intent'&&row.changes.some(c=>c.key===key));
    if(!template)throw Error('Offline edit did not reach the real write-ahead journal');
    tx=db.transaction('sentlog_delta_control_v1','readonly');done=h.completed(tx);
    let clock=await h.request(tx.objectStore('sentlog_delta_control_v1').get('clock'));await done;
    tx=db.transaction(['sentlog_delta_journal_v1','sentlog_delta_control_v1'],'readwrite');done=h.completed(tx);const retained=[];
    for(let i=0;i<64;i++){const seq=++clock;retained.push(seq);tx.objectStore('sentlog_delta_journal_v1').add({...structuredClone(template),
      id:'preserve-unbound-history-'+i,seq,projectIds:['preserved-unbound-project'],drawingIds:['preserved-unbound-plan'],files:[],
      changes:[{key:'surveyFieldNoteDrawingV1:preserved-unbound-plan',before:JSON.stringify({shapes:[],memo:'P'.repeat(4096),generation:i}),
        after:JSON.stringify({shapes:[],memo:'P'.repeat(4096),generation:i+1})}]},seq);}
    tx.objectStore('sentlog_delta_control_v1').put(clock,'clock');await done;return retained;
  }finally{db.close();}
}"""

PROOF = r"""async ({retained,ids})=>{
  const prior=__storageAudit.suspended;__storageAudit.suspended=true;
  try{
    const h=__operationHelpers,all=await h.snapshot(),main=all.databases.surveyFieldNoteDB.stores;
    return {originals:all.databases['sentlog-original-photos-v1'],
      liveFiles:main.files.rows.filter(([key])=>typeof key==='string'&&(key.startsWith('photo:')||key.startsWith('background:'))),
      cutoffFiles:main.sentlog_delta_control_v1.rows.filter(([key])=>typeof key==='string'&&key.startsWith('cutoff-file:')),
      retainedHistory:main.sentlog_delta_journal_v1.rows.filter(([key])=>retained.includes(key)),
      records:ids.map(id=>[id,JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:'+id))]),
      session:localStorage.getItem('sentlogCloudSessionV1'),device:localStorage.getItem('sentlogCloudDeviceV1')};
  }finally{__storageAudit.suspended=prior;}
}"""


def png():
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 1024, 768, 8, 2, 0, 0, 0))
            + chunk(b"tEXt", b"SyntheticPadding\0" + b"P" * 98304)
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\x80\xa0\xc0" * 1024) * 768)) + chunk(b"IEND", b""))


def packs(photo):
    result = []
    for index in range(PROJECTS):
        pack = base.payload("residency-project-" + str(index), "residency-plan-" + str(index))
        pack["project"]["name"] = "合成案件 " + str(index)
        drawing = pack["drawings"][0]
        drawing["state"]["project"] = pack["project"]["name"]
        original = copy.deepcopy(drawing["state"]["shapes"][0])
        drawing["state"]["shapes"] = []
        for number in range(32):
            record = copy.deepcopy(original)
            record.update(id="survey-a" if number == 0 else "survey-" + str(number),
                          memo="保存済みの所見 " + str(index) + ":" + str(number) + " " + "R" * 4096,
                          recordNo=number+1, typeNo=number+1, globalNo=number+1,
                          autoLabel="調査-" + str(number+1), photos=[])
            point = {"x": 280+(number % 8)*80, "y": 220+(number // 8)*100}
            record.update(point=point, points=[copy.deepcopy(point), copy.deepcopy(point)])
            if index == number == 0:
                record["photos"] = [dict(id="preview-"+str(i), name="合成写真 "+str(i)+".png", type="image/png",
                    size=len(photo), sha256=hashlib.sha256(photo).hexdigest(), createdAt=i+1) for i in range(14)]
            drawing["state"]["shapes"].append(record)
        drawing["state"]["nextGlobalNo"] = 33
        drawing["meta"].update(shapeCount=32, photoCount=14 if index == 0 else 0)
        pack["project"]["drawings"] = [copy.deepcopy(drawing["meta"])]
        result.append(pack)
    return result


class Cloud(delta.Cloud):
    def __init__(self, origin, root, engine, backend):
        super().__init__(origin, root, engine, backend)
        self.hold_project, self.held, self.traffic = None, [], []
        self.built_root = root

    def route(self, route, device):
        request, url = route.request, urlparse(route.request.url)
        if request.url.startswith("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/"):
            name = "export-pdf.worker.min.js" if "worker" in url.path else "export-pdf.min.js"
            route.fulfill(content_type="text/javascript", body=(self.built_root / "sentlog/vendor" / name).read_bytes())
            return
        if url.netloc == "wiulvaqixphuobdielyy.supabase.co" and request.method != "OPTIONS":
            self.traffic.append({"path": url.path, "method": request.method})
            assert len(self.traffic) < 8000, "Unexpected synthetic request storm"
            body = json.loads(request.post_data) if request.post_data and "/storage/" not in url.path else None
            if url.path.endswith(("/rpc/sentlog_delta_append_v1", "/rpc/sentlog_delta_append_group_v1")) and self.hold_project == (body or {}).get("p_project_id"):
                self.held.append((route, device))
                return
            if url.path.endswith(("/rpc/sentlog_capacity_v1", "/rpc/sentlog_management_v1", "/rpc/sentlog_device_registration_v1", "/sentlog_pc_receipts")):
                response = self.backend.call(op="request", ownerId=collaboration.OWNER, deviceId=device,
                    method=request.method, path=url.path, query=parse_qs(url.query), body=body, headers=dict(request.headers))
                if not response["ok"]:
                    self.sql_errors.append({"path": url.path, **response["error"]})
                self.respond(route, response.get("data") if response["ok"] else response["error"], response.get("status", 200 if response["ok"] else 400))
                return
        before = len(self.notifications)
        result = super().route(route, device)
        if len(self.notifications) > before and "/storage/" not in url.path and request.post_data:
            body = json.loads(request.post_data)
            for notice in self.notifications[before:]:
                if body.get("p_project_id"):
                    notice["project_id"] = body["p_project_id"]
        return result

    def release(self):
        self.hold_project = None
        held, self.held = self.held, []
        for route, device in held:
            self.route(route, device)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("chromium", "webkit"), required=True)
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root, out = args.built_root.resolve(), args.out.resolve()
    assert out.is_relative_to(Path("/tmp"))
    out.mkdir(parents=True, exist_ok=True)
    assert package_version("playwright") == "1.62.0"
    report = dict(format="sentlog-normal-startup-residency-v1", status="running", engine=args.engine,
        importingOverride=False, syntheticServices=True, externalWritesCompleted=0, nativeIndexedDB=True,
        physicalDeviceTested=False, physicalMemoryMeasured=False, phases=[], actions=[], pageErrors=[], crashes=[], observations=[])
    destination = out / "result.json"
    def progress(phase):
        report["phase"] = phase; report["phases"].append(phase); write_json(destination, report)
        print(json.dumps({"phase": phase, "status": report["status"]}), flush=True)
    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            if urlparse(self.path).path == FIXTURE:
                body=b'<!doctype html><meta charset="utf-8"><title>Synthetic existing profile</title>'
                self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body)))
                self.end_headers(); self.wfile.write(body)
            else: super().do_GET()
        def log_message(self, *_args): pass
        def end_headers(self): self.send_header("Cache-Control", "no-store"); super().end_headers()
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    backend = context = page = cloud = None
    try:
        progress("start-existing-postgresql-fixture")
        with deadline(60, "PostgreSQL fixture startup"):
            backend = delta.Backend(root)
        cloud = Cloud(origin, root, args.engine, backend)
        photo = png(); raw = packs(photo)
        ids = [p["drawings"][0]["meta"]["id"] for p in raw]
        cps = [dict(id="55555555-5555-4555-8555-"+str(555555555550+i), client_key=p["project"]["id"], name=p["project"]["name"], status="active") for i,p in enumerate(raw)]
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory(prefix="sentlog-normal-residency-", dir="/tmp") as profile, bounded_playwright(sync_playwright) as playwright:
            def launch():
                with deadline(45, "persistent native browser"):
                    ctx = getattr(playwright, args.engine).launch_persistent_context(profile, headless=True,
                        viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, service_workers="block", timeout=30000)
                ctx.add_init_script(AUDIT + HELPERS + OBSERVE + collaboration.SOCKET.replace("revision:v.revision}", "revision:v.revision,seq:v.seq}"))
                if args.engine == "webkit": ctx.add_init_script(collaboration.WEBKIT_STORAGE_BODY)
                ctx.route("**/*", lambda route: cloud.route(route, collaboration.B))
                tab = ctx.pages[0] if ctx.pages else ctx.new_page(); tab.set_default_timeout(30000)
                tab.on("pageerror", lambda error: report["pageErrors"].append(str(error)[:1000]))
                tab.on("crash", lambda *_: report["crashes"].append(report.get("phase")))
                cloud.pages = [tab]
                return ctx, tab
            def wait(predicate, label, seconds=45):
                limit = time.monotonic() + seconds
                while not predicate():
                    if time.monotonic() >= limit: raise AssertionError(label)
                    cloud.pump(); page.wait_for_timeout(50)
            def shot(label):
                with deadline(12, "native screenshot"): page.screenshot(path=str(out/(label+".png")), full_page=True, timeout=10000)
            def ready():
                page.locator("#sentlogSettingsBtn").wait_for(state="visible", timeout=45000)
                evaluate_async(page, "async()=>await sentlogAppReady", label="normal app readiness")
                wait(lambda: page.evaluate("!!window.sentlogDeltaRuntime"), "Actual delta runtime did not load")
                assert page.evaluate("window.SENTLOG_LOCAL_WORK!==true && window.sentlogImporting!==true"), "The normal startup was suppressed"
                page.evaluate("__normalResidency.bind()")
            def tap(selector, label):
                # The locator's native action resolves its target again if the
                # normal sync renderer replaces it before input is dispatched.
                page.locator(selector).tap(); report["actions"].append(label)
            def open_record():
                tap('#projectsGrid .manager-card:has-text("合成案件 0") button.sl-archive-main', "project")
                page.locator("#drawingsView").wait_for(state="visible")
                tap('#drawingsGrid [data-drawing-group-id="residency-plan-0"] .manager-card-title', "drawing")
                tap('[data-field-record-id="survey-a"]', "record")
                tap("#mobileHandle", "record-details")
                page.locator("#slCollabDraft").wait_for(state="visible")

            def observe_failure():
                if page and not page.is_closed():
                    try:
                        with deadline(5,"failure observation"):
                            report["lastNativeState"]=page.evaluate("({audit:window.__storageAudit?.report(),residency:window.__normalResidency,photo:window.SentlogPhotoThumbnails?.status()})")
                        page.screenshot(path=str(out/"failure.png"),timeout=5000,full_page=True)
                    except Exception as failure:
                        report["observationError"]=str(failure)[:1000]

            try:
                context, page = launch()
                progress("seed-real-existing-records-and-originals")
                page.goto(origin+FIXTURE, wait_until="load")
                for module in ["blob-sha256.js", "record-collaboration.js", "record-store.js"]:
                    page.add_script_tag(url=origin+"/sentlog/"+module)
                canonical = evaluate_async(page, SEED, dict(packs=raw, encoded=base64.b64encode(photo).decode(), owner=collaboration.OWNER, device=collaboration.B), label="native fixture seed")
                assets=[]
                for index, metadata in enumerate(canonical[0]["drawings"][0]["state"]["shapes"][0]["photos"]):
                    aid="77777777-7777-4777-8777-"+str(777777777700+index); path="synthetic/residency/"+aid+".png"
                    asset=dict(id=aid, owner_id=collaboration.OWNER, project_id=cps[0]["id"], client_key="photo:"+ids[0]+":"+metadata["id"],
                        kind="photo", file_name=metadata["name"], mime_type="image/png", byte_size=len(photo), sha256=hashlib.sha256(photo).hexdigest(),
                        status="uploaded", source_device_id=collaboration.B, storage_path=path,
                        metadata=dict(local_project_key=cps[0]["client_key"], drawing_id=ids[0], photo_id=metadata["id"]))
                    assets.append(asset); cloud.assets[aid]=asset; cloud.blobs[path]=photo
                backend.admin(op="seed", ownerId=collaboration.OWNER, devices=[dict(id=collaboration.B,name="合成iPhone")],
                    projects=[dict(**cp,payload=pack) for cp,pack in zip(cps,canonical)], assets=assets, rollout=True)
                progress("normal-authenticated-automatic-migration")
                page.goto(origin+"/sentlog/", wait_until="domcontentloaded"); ready()
                wait(lambda: page.evaluate("ids=>ids.every(id=>SentlogRecords.deltaJournal.bindingStateFor(id)?.phase==='active' && sentlogDeltaRuntime.isActive(id))", [cp["client_key"] for cp in cps]), "Automatic normal startup did not activate every synthetic project", 120)
                evaluate_async(page, "async()=>{await SentlogRecords.settled();await sentlogCloudIdle();}", label="initial automatic synchronization")

                progress("retain-offline-edit-and-unique-history")
                context.set_offline(True)
                retained = evaluate_async(page, RETAIN_HISTORY, dict(drawingId=ids[-1],memo=PENDING_MEMO), label="pre-existing unsent edit")
                parameters=dict(retained=retained,ids=ids)
                before=evaluate_async(page, PROOF, parameters, label="protected native byte proof")
                report["fixture"] = dict(projects=PROJECTS,recordsPerProject=32,visiblePhotoMetadata=14,photoBytes=len(photo),protectedRows=len(retained),cutoffFiles=len(before["cutoffFiles"]))
                with deadline(15,"close seeded native profile"): context.close()
                context=None

                progress("ordinary-restart-with-background-sync")
                cloud.hold_project=cps[-1]["id"]
                context,page=launch(); page.goto(origin+"/sentlog/",wait_until="domcontentloaded"); ready()
                assert page.evaluate("SentlogRecords.startupReadBudgetVersion===1"), "Normal startup read budget capability missing"
                wait(lambda: bool(cloud.held), "The saved unsent edit did not enter real automatic delta transport", 90)
                startup=page.evaluate("__normalResidency")
                assert startup["init"] and all(v==0 for v in startup["init"][0].values()), ("Normal initialization used unbounded getAll",startup["init"])
                report["observations"].append(dict(phase="background-sync-active",**startup))
                shot("normal-top")
                tap("#sentlogSettingsBtn","settings-during-sync")
                page.locator('#sentlogSettingsModal[aria-hidden="false"]').wait_for(state="visible",timeout=5000)
                shot("normal-settings"); tap("#sentlogSettingsClose","close-settings")
                assert cloud.held, "The touch input did not overlap the real pending synchronization"
                progress("trusted-touch-memo-save-and-photo-preview")
                original_document=page.evaluate("__storageAudit.documentId")
                open_record(); tap("#slCollabDraft","comment-focus"); page.locator("#slCollabDraft").fill(MEMO)
                tap('#slCollabComments [data-actions] button:text-is("保存")',"save-comment-during-sync")
                evaluate_async(page,"async()=>{await SentlogRecords.settled();SentlogRecords.assertSafe();}",label="local save during automatic sharing")
                assert cloud.held, "The real record save did not overlap the held automatic synchronization"
                assert page.evaluate("text=>JSON.parse(SentlogRecords.getItem('surveyFieldNoteDrawingV1:residency-plan-0')).shapes[0].memo.includes(text)",MEMO)
                report["editSavedWhileAutomaticAppendPending"]=True
                cloud.release()
                page.locator("#photoGrid .photo-thumb").first.scroll_into_view_if_needed()
                wait(lambda: page.evaluate("(()=>{const s=window.SentlogPhotoThumbnails?.status();return !!s&&s.visible>0&&s.ready===s.visible&&s.queued===0&&s.decoding===0;})()"),"The initially visible photos did not all finish decoding")
                photo_status=page.evaluate("SentlogPhotoThumbnails.status()")
                assert photo_status["maxDecoding"] <= 1 and photo_status["urls"] <= photo_status["visible"], photo_status
                assert page.locator("#photoGrid img").count()==14, "Lazy previews removed photo entries"
                wait(lambda: page.locator("#photoGrid img[src]").evaluate_all("nodes=>nodes.length>0&&nodes.every(n=>n.complete&&n.naturalWidth>0)"),"Thumbnail images did not finish displaying")
                image_sizes=page.locator("#photoGrid img[src]").evaluate_all("nodes=>nodes.map(n=>({width:n.naturalWidth,height:n.naturalHeight}))")
                assert image_sizes and all(0<max(v["width"],v["height"])<=384 for v in image_sizes), image_sizes
                report["photoPreview"]=photo_status; shot("normal-edited-record")
                tap("#mobileHandle","close-record-details");tap("#navBackBtn","save-and-close-drawing")
                page.locator("#drawingsView").wait_for(state="visible")
                evaluate_async(page,"async()=>{await SentlogRecords.settled();SentlogRecords.assertSafe();}",label="native edit commit")
                wait(lambda: page.evaluate("SentlogPhotoThumbnails.status().urls===0 && !SentlogPhotoThumbnails.status().active"),"Leaving the editor retained preview URLs")
                tap("#navBackBtn","return-to-projects");open_record()
                assert MEMO in page.locator("#slCollabComments [data-list]").inner_text(),"Reopening lost the real UI edit"
                assert page.evaluate("__storageAudit.documentId")==original_document,"A normal touch action reloaded the page"
                tap("#mobileHandle","close-details-after-reopen");tap("#navBackBtn","close-reopened-drawing");tap("#navBackBtn","finish-at-top")
                evaluate_async(page,"async()=>{await SentlogRecords.settled();await sentlogCloudIdle();}",label="automatic sharing after editing")
                wait(lambda: page.evaluate("Object.values(__normalResidency.factories).every(x=>x.live<=1)"),"Completed projects retained more than one heavy runtime",30)
                assert page.evaluate("ids=>ids.every(id=>sentlogDeltaRuntime.isActive(id))",[cp["client_key"] for cp in cps]),"Parking changed project ownership/mode"
                observed=page.evaluate("__normalResidency");report["observations"].append(dict(phase="idle-after-edit",**observed))
                assert observed["factories"].get("replica",{}).get("created",0)>=PROJECTS,"The fixture did not exercise every real project replica"
                touches=[e for e in observed["touch"] if e["type"]=="touchstart"]
                assert len(touches)>=len(report["actions"]) and all(e["trusted"] for e in touches),"Navigation was not real touch input"
                assert any(e["id"]=="slCollabDraft" and e["trusted"] for e in observed["inputs"]),"Comment edit bypassed native input"
                after=evaluate_async(page,PROOF,parameters,label="originals, history and record preservation")
                for key in ["originals","liveFiles","cutoffFiles","retainedHistory","session","device"]:
                    assert after[key]==before[key],("Protected state changed",key)
                before_records,after_records=dict(before["records"]),dict(after["records"])
                for did in ids[1:-1]: assert after_records[did]==before_records[did],("Another saved drawing changed",did)
                target=after_records[ids[0]]["shapes"][0]
                assert MEMO in target["memo"] and before_records[ids[0]]["shapes"][0]["memo"] in target["memo"]
                assert target["photos"]==before_records[ids[0]]["shapes"][0]["photos"]
                assert after_records[ids[0]]["shapes"][1:]==before_records[ids[0]]["shapes"][1:],"An untouched record in the edited drawing changed"
                # Replaying the pre-existing journal edit may normalize
                # that record's collaboration history. Every business value and
                # every other record must remain exact; only that history may differ.
                old_last,new_last=before_records[ids[-1]],after_records[ids[-1]]
                assert new_last["shapes"][1:]==old_last["shapes"][1:],"Another record in the pending drawing changed"
                assert {k:v for k,v in new_last.items() if k!="shapes"}=={k:v for k,v in old_last.items() if k!="shapes"}
                previous,current=old_last["shapes"][0],new_last["shapes"][0]
                assert PENDING_MEMO in current["memo"] and current["memo"]==previous["memo"],"The pre-restart unsent edit was lost"
                assert {k:v for k,v in current.items() if k!="collab"}=={k:v for k,v in previous.items() if k!="collab"},"Pending edit changed business values"
                report["preservedNativeBytesAndUnsentEdit"]=True
                report["sourceModules"]=[dict(path="sentlog/"+name,sha256=hashlib.sha256((root/"sentlog"/name).read_bytes()).hexdigest())
                    for name in ["index.html","record-store.js","delta-sync-app-runtime.js","delta-sync-core.js","delta-sync-indexeddb.js","photo-thumbnails.js","cloud-sync.js"]]
                assert not cloud.unexpected and not cloud.sql_errors and not report["pageErrors"] and not report["crashes"],dict(unexpected=cloud.unexpected,sql=cloud.sql_errors,errors=report["pageErrors"],crashes=report["crashes"])
                report["status"]="passed"
            except Exception:
                observe_failure()
                raise
            finally:
                if context:
                    with deadline(15,"native context close"):context.close()
                if report["pageErrors"] or report["crashes"]:report["status"]="failed"
    except Exception as error:
        report["status"]="failed";report["error"]=str(error)[:5000]
    finally:
        if cloud:report["traffic"]=cloud.traffic;report["sqlErrors"]=cloud.sql_errors;report["unexpectedRequests"]=cloud.unexpected
        if backend:backend.close()
        server.shutdown();server.server_close();report["fixtureSHA256"]=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        progress("finished");print(json.dumps(dict(status=report["status"],error=report.get("error"),report=str(destination))),flush=True)
    return 0 if report["status"]=="passed" else 1


if __name__=="__main__":
    raise SystemExit(main())

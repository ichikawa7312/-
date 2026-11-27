"""Native UI contract for the independent cloud-check screen.

Fresh temporary profiles and synthetic auth/REST responses only. No request is
sent to Supabase. The real page CSP stays in force. Native DB/cache/marker and
the shared login are hashed before/after, while page-side storage APIs are
watched. Service workers are blocked in this fixture: current worker fetch
policies need separate source/handler tests. Previously installed root workers
may still cache a first navigation until normally updated; this fixture cannot
prove zero cache writes under all historical worker generations.
--out contains reports/screenshots only, never browser profiles.

python tests/cloud_check_ui.py --engine chromium --out /tmp/cloud-check-chromium
python tests/cloud_check_ui.py --engine webkit --out /tmp/cloud-check-webkit
"""

import argparse
import asyncio
import hashlib
import json
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://wiulvaqixphuobdielyy.supabase.co"
PAGE = "/sentlog/cloud-check.html"
OWN = "sentlogCloudCheckSessionV1"
SHARED = "sentlogCloudSessionV1"
OWNER = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"
PROJECT = "10000000-0000-4000-8000-000000000001"
EMAIL = "fixture@example.invalid"
PASSWORD = "SYNTHETIC_FIXTURE_PASSWORD"
ASSETS = ("sentlog/cloud-check.html", "sentlog/cloud-check.js", "sentlog/cloud-check-auth.js")


def sha(data):
    return hashlib.sha256(data).hexdigest()


SEED = r"""(async()=>{
  const q=new URLSearchParams(location.search),mode=q.get('mode');
  const owner='00000000-0000-4000-8000-000000000001';
  const current={access_token:'synthetic-main-access',refresh_token:'synthetic-main-refresh',
    expires_at:Math.floor(Date.now()/1000)+(mode==='borrowed'||mode==='errors'?3600:-60),
    user:{id:owner,email:'fixture@example.invalid'}};
  localStorage.setItem('sentlogRecordsReadyV130','1');
  localStorage.setItem('sentlogCloudSessionV1',JSON.stringify(current));
  localStorage.setItem('sentlogCloudDeviceV1','SYNTHETIC_DEVICE');
  localStorage.setItem('synthetic-unrelated-key','SYNTHETIC_KEEP');
  if(mode==='refresh')localStorage.setItem('sentlogCloudCheckSessionV1',JSON.stringify({
    ...current,access_token:'synthetic-owned-expired',refresh_token:'synthetic-owned-refresh',expires_at:Math.floor(Date.now()/1000)-60}));
  const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const open=indexedDB.open('surveyFieldNoteDB',2);open.onupgradeneeded=()=>{
    for(const name of ['files','sentlog_delta_control_v1','sentlog_delta_journal_v1'])open.result.createObjectStore(name);
  };const db=await request(open);
  const tx=db.transaction(['files','sentlog_delta_control_v1','sentlog_delta_journal_v1'],'readwrite');
  const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  // Intentionally absent META with a prior marker: ordinary app startup would
  // remain protected. These nonempty rows must never be overwritten or read.
  tx.objectStore('files').put(JSON.stringify({projects:[{id:'SYNTHETIC_LOCAL',name:'合成の未保存記録'}]}),'__sentlog_record__:surveyFieldNoteWorkspaceV1');
  tx.objectStore('files').put(new File(['SYNTHETIC_PDF_BYTES'],'fixture.pdf',{type:'application/pdf',lastModified:1700000000000}),'SYNTHETIC_PDF');
  tx.objectStore('files').put(new Blob(['SYNTHETIC_PHOTO_BYTES'],{type:'image/png'}),'SYNTHETIC_PHOTO');
  tx.objectStore('sentlog_delta_control_v1').put({kind:'SYNTHETIC_CONTROL',keep:true},'control');
  tx.objectStore('sentlog_delta_journal_v1').put({kind:'SYNTHETIC_JOURNAL',keep:true},'journal');await done;db.close();
  for(const name of ['sentlog-pwa-v-cloud-check-fixture','unrelated-fixture-cache']){
    const cache=await caches.open(name);await cache.put(location.origin+'/__fixture_cache__/'+name,new Response('SYNTHETIC_CACHE_'+name,{headers:{'Content-Type':'text/plain'}}));
  }
  document.body.dataset.seeded='true';document.getElementById('result').textContent='seeded';
})().catch(error=>{document.body.dataset.seedError=String(error);});"""


# The observer is installed only in this disposable profile. It does not relax
# CSP or replace production code. Its own snapshots use captured native methods
# and open only already-listed DB/cache names. The app gets no such references.
OBSERVER = r"""(() => {
  if(!['/sentlog/cloud-check.html','/__cloud_fixture__'].includes(location.pathname))return;
  const watching=location.pathname==='/sentlog/cloud-check.html';
  const own='sentlogCloudCheckSessionV1',shared='sentlogCloudSessionV1';
  const audit={violations:[],authWrites:[],authReads:[],csp:[]};
  const native={get:Storage.prototype.getItem,set:Storage.prototype.setItem,remove:Storage.prototype.removeItem,
    open:IDBFactory.prototype.open,databases:IDBFactory.prototype.databases,transaction:IDBDatabase.prototype.transaction,
    cacheKeys:CacheStorage.prototype.keys,cacheOpen:CacheStorage.prototype.open,
    keys:Cache.prototype.keys,match:Cache.prototype.match};
  const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const hashText=value=>digest(new TextEncoder().encode(JSON.stringify(value)));
  const violation=label=>{audit.violations.push(label);throw Error('Synthetic read-only contract: '+label);};
  if(watching){
    for(const name of ['open','deleteDatabase','databases'])IDBFactory.prototype[name]=function(){return violation('indexedDB.'+name);};
    for(const name of ['open','delete','keys','match','has'])if(typeof CacheStorage.prototype[name]==='function')CacheStorage.prototype[name]=function(){return violation('caches.'+name);};
    for(const name of ['transaction'])IDBDatabase.prototype[name]=function(){return violation('database.'+name);};
    Storage.prototype.getItem=function(key){audit.authReads.push(String(key));if(this!==localStorage||![own,shared].includes(key))return violation('storage.read:'+key);return native.get.call(this,key);};
    Storage.prototype.setItem=function(key,value){if(this!==localStorage||key!==own)return violation('storage.write:'+key);audit.authWrites.push('set-own-auth');return native.set.call(this,key,value);};
    Storage.prototype.removeItem=function(key){if(this!==localStorage||key!==own)return violation('storage.remove:'+key);audit.authWrites.push('remove-own-auth');return native.remove.call(this,key);};
    Storage.prototype.clear=function(){return violation('storage.clear');};
    Storage.prototype.key=function(){return violation('storage.enumerate');};
    if(navigator.serviceWorker){const proto=Object.getPrototypeOf(navigator.serviceWorker);for(const name of ['register','getRegistrations'])if(typeof proto[name]==='function')proto[name]=function(){return violation('serviceWorker.'+name);};}
    document.addEventListener('securitypolicyviolation',e=>audit.csp.push({directive:e.violatedDirective,blocked:e.blockedURI}));
  }
  const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  async function norm(value){
    if(value instanceof Blob)return {kind:value instanceof File?'File':'Blob',size:value.size,type:value.type,name:value instanceof File?value.name:null,lastModified:value instanceof File?value.lastModified:null,sha256:await digest(await value.arrayBuffer())};
    if(Array.isArray(value))return Promise.all(value.map(norm));
    if(value&&typeof value==='object'){const out={};for(const key of Object.keys(value).sort())out[key]=await norm(value[key]);return out;}
    return value;
  }
  async function inspect(){
    const databases=[];
    for(const row of (await native.databases.call(indexedDB)).sort((a,b)=>a.name.localeCompare(b.name))){
      const q=native.open.call(indexedDB,row.name);q.onupgradeneeded=()=>q.transaction.abort();const db=await request(q);
      const data={name:row.name,version:row.version,stores:[]};
      try{for(const name of [...db.objectStoreNames]){
        const tx=native.transaction.call(db,name,'readonly'),store=tx.objectStore(name);
        const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
        const [keys,values]=await Promise.all([request(store.getAllKeys()),request(store.getAll())]);await done;
        data.stores.push({name,keys,values:await norm(values)});
      }}finally{db.close();}databases.push(data);
    }
    const cacheRows=[];
    for(const name of (await native.cacheKeys.call(caches)).sort()){
      const cache=await native.cacheOpen.call(caches,name),entries=[];
      for(const req of (await native.keys.call(cache)).sort((a,b)=>a.url.localeCompare(b.url))){const response=await native.match.call(cache,req);if(!response)throw Error('Synthetic cache entry disappeared');const bytes=await response.arrayBuffer();entries.push({url:new URL(req.url).pathname,status:response.status,bytes:bytes.byteLength,sha256:await digest(bytes)});}
      cacheRows.push({name,entries});
    }
    const local=['sentlogRecordsReadyV130',shared,'sentlogCloudDeviceV1','synthetic-unrelated-key'].map(key=>[key,native.get.call(localStorage,key)]);
    const owned=native.get.call(localStorage,own),parsed=owned?JSON.parse(owned):null;
    return {status:'complete',databaseCount:databases.length,databaseSha256:await hashText(databases),storeCounts:databases.map(d=>d.stores.map(s=>({name:s.name,count:s.keys.length}))),
      cacheCount:cacheRows.length,cacheSha256:await hashText(cacheRows),cacheEntries:cacheRows.reduce((n,c)=>n+c.entries.length,0),
      protectedLocalSha256:await hashText(local),marker:native.get.call(localStorage,'sentlogRecordsReadyV130'),
      ownSessionPresent:!!owned,ownSessionSha256:owned?await hashText(owned):null,ownSessionFields:parsed?Object.keys(parsed).sort():[],
      viewport:{width:innerWidth,documentWidth:document.documentElement.scrollWidth},audit:{violations:[...audit.violations],authWriteCount:audit.authWrites.length,authWrites:[...audit.authWrites],authReadKeys:[...new Set(audit.authReads)].sort(),csp:[...audit.csp]}};
  }
  addEventListener('DOMContentLoaded',()=>{
    const controls=document.createElement('details');controls.id='nativeCloudControls';controls.style.cssText='margin:20px;padding:8px;font:12px sans-serif';
    const title=document.createElement('summary');title.textContent='合成試験の照合';const button=document.createElement('button');button.id='nativeCloudInspect';button.textContent='合成保存領域を照合';button.type='button';
    const pre=document.createElement('pre');pre.id='nativeCloudAudit';pre.hidden=true;let serial=0;
    button.onclick=async()=>{button.disabled=true;try{const value=await inspect();value.serial=++serial;pre.textContent=JSON.stringify(value);}catch(error){pre.textContent=JSON.stringify({status:'error',message:String(error)});}finally{button.disabled=false;}};
    controls.append(title,button,pre);document.body.append(controls);
  });
})();"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path.lstrip("/") in ASSETS:
            body = (ROOT / path.lstrip("/")).read_bytes()
            content_type = "text/html; charset=utf-8" if path == PAGE else "text/javascript; charset=utf-8"
        elif path == "/__cloud_fixture__":
            body = ('<!doctype html><html lang="ja"><meta charset="utf-8"><title>合成試験</title><body><pre id="result"></pre><script src="/__cloud_seed__.js"></script></body></html>').encode()
            content_type = "text/html; charset=utf-8"
        elif path == "/__cloud_seed__.js":
            body, content_type = SEED.encode(), "text/javascript; charset=utf-8"
        elif path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
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


async def inspect(page):
    report = page.locator("#nativeCloudAudit")
    before = await report.text_content()
    controls = page.locator("#nativeCloudControls")
    if await controls.get_attribute("open") is None:
        await controls.locator("summary").click()
    await page.locator("#nativeCloudInspect").click()
    for _ in range(200):
        current = await report.text_content()
        if current and current != before:
            value = json.loads(current)
            assert value["status"] == "complete", value
            return value
        await asyncio.sleep(0.025)
    raise AssertionError("Synthetic native snapshot did not finish")


async def settled(page, status):
    await page.locator(f'body[data-ready="true"][data-busy="false"][data-status="{status}"]').wait_for(timeout=30000)


async def exercise(playwright, engine, origin, mode, output, executable):
    result = {"condition": mode, "scope": "Synthetic auth and metadata transport; no real account was authenticated", "status": "running", "requests": [], "blockedRequests": [], "console": [], "pageErrors": [], "snapshots": []}
    context = page = None
    phase = "normal"
    started = asyncio.Event()
    release = asyncio.Event()
    with tempfile.TemporaryDirectory(prefix="sentlog-cloud-check-native-") as profile:
        try:
            settings = {"headless": True, "viewport": {"width": 1100, "height": 850}, "service_workers": "block"}
            if executable:
                settings["executable_path"] = executable
            context = await getattr(playwright, engine).launch_persistent_context(profile, **settings)
            result["browserVersion"] = context.browser.version if context.browser else "unavailable"
            await context.add_init_script(OBSERVER)

            async def route(request_route):
                request = request_route.request
                parsed = urlparse(request.url)
                if request.url.startswith(origin + "/") and (parsed.path.lstrip("/") in ASSETS or parsed.path in ("/__cloud_fixture__", "/__cloud_seed__.js", "/favicon.ico")):
                    await request_route.continue_()
                    return
                allowed_paths = ("/auth/v1/token", "/auth/v1/user", "/rest/v1/sentlog_projects", "/rest/v1/sentlog_project_snapshots")
                if not request.url.startswith(BASE + "/") or parsed.path not in allowed_paths:
                    result["blockedRequests"].append({"method": request.method, "path": parsed.path})
                    await request_route.abort()
                    return
                headers = {"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "apikey,authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Cache-Control": "no-store"}
                if request.method == "OPTIONS":
                    await request_route.fulfill(status=204, headers=headers)
                    return
                query = parse_qs(parsed.query)
                item = {"method": request.method, "path": parsed.path, "phase": phase}
                result["requests"].append(item)
                status = 200
                if parsed.path == "/auth/v1/token":
                    assert request.method == "POST"
                    body = request.post_data_json
                    grant = query.get("grant_type", [None])[0]
                    item["grantType"] = grant
                    if grant == "password":
                        assert body == {"email": EMAIL, "password": PASSWORD}
                    else:
                        assert grant == "refresh_token" and body == {"refresh_token": "synthetic-owned-refresh"}
                    payload = {"access_token": "synthetic-owned-access", "refresh_token": "synthetic-owned-new-refresh", "expires_in": 3600, "user": {"id": OWNER, "email": EMAIL}}
                elif parsed.path == "/auth/v1/user":
                    assert request.method == "GET"
                    if phase == "cancel":
                        started.set()
                        await release.wait()
                    if phase == "offline":
                        await request_route.abort()
                        return
                    payload = {"id": OTHER if phase == "wrong-user" else OWNER, "email": EMAIL}
                elif parsed.path == "/rest/v1/sentlog_projects":
                    assert request.method == "GET" and query == {"select": ["id,owner_id,name,status,updated_at"], "owner_id": ["eq." + OWNER], "order": ["id.asc"], "limit": ["100"]}
                    item["ownerFilterMatches"] = True
                    payload = [{"id": PROJECT, "owner_id": OWNER, "name": "合成案件 <img src=x onerror=alert(1)>", "status": "active", "updated_at": "2026-11-27T10:00:00Z"}]
                    if phase == "denied":
                        status, payload = 403, {"message": "SYNTHETIC_RAW_ERROR_MUST_NOT_RENDER"}
                else:
                    assert request.method == "GET" and query == {"select": ["project_id,owner_id,revision,updated_at"], "owner_id": ["eq." + OWNER], "project_id": ["in.(" + PROJECT + ")"], "order": ["project_id.asc"]}
                    item["ownerFilterMatches"] = True
                    payload = [{"project_id": PROJECT, "owner_id": OWNER, "revision": 9, "updated_at": "2026-11-27T11:00:00Z"}]
                try:
                    await request_route.fulfill(status=status, headers={**headers, "Content-Type": "application/json"}, body=json.dumps(payload, ensure_ascii=False))
                except Exception:
                    if phase != "cancel":
                        raise

            await context.route("**/*", route)
            page = await context.new_page()
            page.on("console", lambda message: result["console"].append({"type": message.type, "text": message.text[:400]}) if message.type in ("warning", "error") and len(result["console"]) < 30 else None)
            page.on("pageerror", lambda error: result["pageErrors"].append(str(error)[:400]))
            await page.goto(origin + "/__cloud_fixture__?mode=" + mode)
            await page.locator('body[data-seeded="true"]').wait_for(timeout=15000)
            baseline = await inspect(page)
            result["baseline"] = baseline
            await page.goto(origin + PAGE)
            await settled(page, "idle")
            assert len(result["requests"]) == 0, "Opening the page must not start auth or project requests"

            async def preserved(label, owned=None):
                value = await inspect(page)
                for key in ("databaseCount", "databaseSha256", "cacheCount", "cacheSha256", "cacheEntries", "protectedLocalSha256", "marker", "storeCounts"):
                    assert value[key] == baseline[key], f"{label}: changed {key}"
                assert not value["audit"]["violations"] and not value["audit"]["csp"], value["audit"]
                if owned is not None:
                    assert value["ownSessionPresent"] is owned, label
                assert value["viewport"]["documentWidth"] <= value["viewport"]["width"], "Horizontal overflow"
                result["snapshots"].append({"phase": label, **value})
                return value

            async def visible_ready():
                await settled(page, "ready")
                assert await page.locator("#cloudCheckWho").text_content() == EMAIL
                assert await page.locator("#cloudCheckProjects article").count() == 1
                assert await page.locator("#cloudCheckProjects img").count() == 0, "Project text must not become markup"
                text = await page.locator("main").inner_text()
                assert "案件情報の更新日時" in text and "記録の控えの更新日時" in text
                for forbidden in (PASSWORD, "synthetic-main-access", "synthetic-owned-access", "SYNTHETIC_RAW_ERROR_MUST_NOT_RENDER"):
                    assert forbidden not in text

            async def sign_in(remember=False):
                await page.locator("#cloudCheckEmail").fill(EMAIL)
                await page.locator("#cloudCheckPassword").fill(PASSWORD)
                await page.locator("#cloudCheckRemember").set_checked(remember)
                await page.locator("#cloudCheckLogin").click()
                await visible_ready()
                assert await page.locator("#cloudCheckPassword").input_value() == ""

            if mode == "borrowed":
                await page.locator("#cloudCheckUseMain").click()
                await visible_ready()
                value = await preserved("borrowed-ready", False)
                assert value["audit"]["authWriteCount"] == 0
                await page.locator("main").screenshot(path=str(output / "borrowed-desktop.png"))
                await page.set_viewport_size({"width": 390, "height": 844})
                await preserved("borrowed-mobile", False)
                await page.locator("main").screenshot(path=str(output / "borrowed-mobile.png"))
                await page.locator("#cloudCheckEnd").click()
                await settled(page, "idle")
                assert await page.locator("#cloudCheckProjects article").count() == 0
                value = await preserved("borrowed-ended", False)
                assert value["audit"]["authWriteCount"] == 0
                assert all(row["method"] == "GET" for row in result["requests"])
            elif mode == "dedicated":
                assert not await page.locator("#cloudCheckUseMain").is_visible()
                assert not await page.locator("#cloudCheckRemember").is_checked()
                await sign_in()
                value = await preserved("memory-login", False)
                assert value["audit"]["authWriteCount"] == 0
                await page.locator("#cloudCheckEnd").click()
                await settled(page, "idle")
                await sign_in(True)
                await preserved("remembered-login", True)
                previous_requests = len(result["requests"])
                await page.reload()
                await settled(page, "idle")
                assert len(result["requests"]) == previous_requests
                await page.locator("#cloudCheckResume").click()
                await visible_ready()
                await preserved("remembered-reload", True)
                await page.locator("#cloudCheckEnd").click()
                await settled(page, "idle")
                await preserved("remembered-ended", False)
            elif mode == "refresh":
                await page.locator("#cloudCheckResume").click()
                await visible_ready()
                value = await preserved("dedicated-refreshed", True)
                assert value["ownSessionSha256"] != baseline["ownSessionSha256"]
                assert result["requests"][0].get("grantType") == "refresh_token"
                assert len(result["requests"]) == 4
                await page.locator("#cloudCheckEnd").click()
                await settled(page, "idle")
                await preserved("dedicated-ended", False)
            else:
                for phase_name in ("denied", "wrong-user", "offline"):
                    phase = phase_name
                    await page.locator("#cloudCheckUseMain").click()
                    await settled(page, "error")
                    assert await page.locator("#cloudCheckProjects article").count() == 0
                    assert "SYNTHETIC_RAW_ERROR_MUST_NOT_RENDER" not in await page.locator("main").inner_text()
                    await preserved(phase, False)
                phase = "cancel"
                await page.locator("#cloudCheckUseMain").click()
                await asyncio.wait_for(started.wait(), timeout=10)
                await page.locator("#cloudCheckCancel").click()
                await settled(page, "error")
                release.set()
                await asyncio.sleep(0.1)
                assert await page.locator("#cloudCheckProjects article").count() == 0
                value = await preserved("cancelled-late-response", False)
                assert value["audit"]["authWriteCount"] == 0
            assert not result["blockedRequests"], result["blockedRequests"]
            assert not result["pageErrors"], result["pageErrors"]
            result["status"] = "passed"
        except Exception as error:
            result["status"] = "failed"
            result["error"] = {"type": type(error).__name__, "message": str(error)[:1000]}
            if page:
                try:
                    await page.screenshot(path=str(output / (mode + "-failure.png")), full_page=True)
                except Exception:
                    pass
        finally:
            release.set()
            if context:
                await context.close()
    return result


async def main(args):
    from playwright.async_api import async_playwright
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"schema": "sentlog-cloud-check-native/v1", "engine": args.engine, "scope": "Synthetic auth/REST, fresh disposable profiles; no production account or user data", "serviceWorkers": "blocked", "workerLimit": "This fixture checks page behavior and unchanged seeded storage. Current worker policies are verified separately; previously installed root workers may cache first navigation and are not forcibly updated or cleared.", "source": {name: {"bytes": (ROOT / name).stat().st_size, "sha256": sha((ROOT / name).read_bytes())} for name in ASSETS}, "conditions": [], "startedAtEpoch": time.time()}
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    try:
        async with async_playwright() as playwright:
            for mode in ("borrowed", "dedicated", "refresh", "errors"):
                result = await exercise(playwright, args.engine, origin, mode, output, args.browser_executable)
                report["conditions"].append(result)
                (output / (mode + ".json")).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
                print(json.dumps({"condition": mode, "status": result["status"], "requests": len(result["requests"]), "snapshots": len(result["snapshots"])}, ensure_ascii=False), flush=True)
    finally:
        server.shutdown()
        server.server_close()
        report["finishedAtEpoch"] = time.time()
        report["status"] = "passed" if len(report["conditions"]) == 4 and all(row["status"] == "passed" for row in report["conditions"]) else "failed"
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("chromium", "webkit"), required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--browser-executable", default=None)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args)))

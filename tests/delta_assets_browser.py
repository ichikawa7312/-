"""Disposable Chromium/WebKit checks for atomic photo queue and receipts.

Only loopback HTTP, synthetic image bytes and a new temporary browser context
are used. This does not test a physical iPhone/iPad or the real company PC.
"""
import argparse
import functools
import json
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


PRIVATE_PROBE = r"""async () => {
    const scope={ownerId:'probe-owner',projectId:'probe-project',deviceId:'probe-device'};
    const blob=new Blob(['isolated private-context photo'],{type:'image/jpeg'});
    const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    const ref={ownerId:scope.ownerId,projectId:scope.projectId,assetId:'probe-asset',
        drawingId:'probe-drawing',photoId:'probe-photo',variant:'shared',mimeType:'image/jpeg',
        size:blob.size,sha256:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')};
    const store=SentlogDeltaAssets.createIndexedDBStore({...scope,
        databaseName:'sentlog-delta-assets-test-private-probe'});
    let acknowledgements=0,downloaded=0,localDurableBeforeAck=false;
    const queue=SentlogDeltaAssets.createQueue({scope,store,currentScope:()=>scope,
        transport:{online:()=>true,
            download:async()=>{downloaded++;return blob;},
            acknowledge:async reference=>{
                const saved=await store.read(reference);
                if(saved?.phase!=='received')throw Error('ack before committed local receipt');
                await SentlogDeltaAssets.verifyBlob(saved.blob,reference);
                localDurableBeforeAck=true;acknowledgements++;
                return {...reference,deviceId:scope.deviceId,durable:true};
            }}});
    let outcome,error=null;
    try {
        try {outcome=await queue.sync([ref]);}
        catch(cause){error={name:String(cause.name||''),code:cause.code??null,
            message:String(cause.message||cause),stack:String(cause.stack||'')};}
        const row=await store.read(ref),status=await queue.status([ref]);
        if(!error){
            const success=outcome?.complete===true&&status.complete===true&&
                row?.phase==='acknowledged'&&acknowledgements===1&&localDurableBeforeAck;
            return {success,behavior:'private-blob-storage-supported',downloaded,acknowledgements,
                localDurableBeforeAck,phase:row?.phase||null};
        }
        // An ephemeral browser may reject Blob persistence. That is a failed
        // save, never a reason to skip byte checks or publish a receipt.
        const expectedStorageFailure=['UnknownError','QuotaExceededError','NotSupportedError','DataCloneError','SecurityError'].includes(error.name);
        const safe=expectedStorageFailure&&downloaded===1&&acknowledgements===0&&row?.phase==='waiting'&&
            row.blob===null&&row.localReceipt===null&&row.remoteReceipt===null&&status.complete===false&&status.waiting===1;
        return {success:safe,behavior:safe?'private-blob-storage-rejected-safely':'unexpected-private-failure',
            error,downloaded,acknowledgements,localDurableBeforeAck,phase:row?.phase||null,status};
    } catch(cause) {
        return {success:false,behavior:'private-probe-failed',downloaded,acknowledgements,error,
            probe_error:{name:String(cause.name||''),message:String(cause.message||cause),stack:String(cause.stack||'')}};
    } finally {queue.close();store.close();}
}"""


PERSISTENCE_SEED = r"""async () => {
    const scope={ownerId:'restart-owner',projectId:'restart-project',deviceId:'restart-device'};
    const blob=new Blob(['photo bytes surviving a real browser process restart'],{type:'image/jpeg'});
    const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    const ref={ownerId:scope.ownerId,projectId:scope.projectId,assetId:'restart-asset',
        drawingId:'restart-drawing',photoId:'restart-photo',variant:'shared',mimeType:'image/jpeg',
        size:blob.size,sha256:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')};
    const databaseName='sentlog-delta-assets-test-restart-probe';
    const store=SentlogDeltaAssets.createIndexedDBStore({...scope,databaseName});
    const queue=SentlogDeltaAssets.createQueue({scope,store,currentScope:()=>scope,
        transport:{online:()=>true,download:async()=>blob,
            acknowledge:async reference=>({...reference,deviceId:scope.deviceId,durable:true})}});
    try {
        const status=await queue.sync([ref]);
        if(!status.complete)throw Error('photo was not durable before process restart');
        return {scope,ref,databaseName};
    } finally {queue.close();store.close();}
}"""


PERSISTENCE_REOPEN = r"""async ({scope,ref,databaseName}) => {
    const store=SentlogDeltaAssets.createIndexedDBStore({...scope,databaseName});
    let downloads=0,acknowledgements=0;
    const queue=SentlogDeltaAssets.createQueue({scope,store,currentScope:()=>scope,
        transport:{online:()=>true,
            download:async()=>{downloads++;throw Error('saved photo was lost on browser restart');},
            acknowledge:async()=>{acknowledgements++;throw Error('saved acknowledgement was lost on browser restart');}}});
    try {
        const row=await store.read(ref);
        if(row?.phase!=='acknowledged')throw Error('photo receipt did not survive process restart');
        await SentlogDeltaAssets.verifyBlob(row.blob,ref);
        const status=await queue.sync([ref]);
        return {success:status.complete&&downloads===0&&acknowledgements===0,
            downloads,acknowledgements,phase:row.phase,size:row.blob.size,sha256:ref.sha256,
            localReceipt:row.localReceipt.verified,remoteReceipt:row.remoteReceipt.durable};
    } finally {queue.close();store.close();}
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=["chromium", "webkit"], required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    report = {"browser": args.browser, "scope": "isolated synthetic photo delivery", "success": False,
              "storage_profile": "disposable persistent profile", "physical_ios_tested": False}
    try:
        with sync_playwright() as playwright:
            engine = getattr(playwright, args.browser)
            # Match the established IndexedDB/migration durability suite. An
            # incognito context is a distinct storage mode, not the default
            # model for the installed offline app.
            with tempfile.TemporaryDirectory(prefix="sentlog-photo-delivery-") as profile:
                context = engine.launch_persistent_context(profile, headless=True)
                restart_seed = None
                try:
                    page = context.new_page()
                    page.set_default_timeout(120000)
                    page.on("console", lambda message: print(message.text, flush=True))
                    page.goto(f"http://127.0.0.1:{server.server_port}/tests/delta_assets_fixture.html")
                    outcome = page.evaluate("""async engine => {
                        const cases=[];let currentCase=null;
                        try {
                            await SentlogAssetTestCases.run({
                                API: SentlogDeltaAssets, CORE: SentlogDeltaSyncCore,
                                indexedDB, IDBObjectStore, suffix: engine,
                                onStart: name => {currentCase=name;console.log('RUN '+name);},
                                onPass: name => {cases.push(name);console.log('PASS '+name);},
                                onStage: name => console.log('STAGE '+name)
                            });
                            await runDeltaAssetRuntimeCases({
                                A: SentlogDeltaAssets, T: SentlogDeltaAssetTransport,
                                R: SentlogDeltaAssetRuntime, D: SentlogDeltaSyncCore,
                                C: SentlogRecordCollaboration, indexedDB, IDBObjectStore,
                                suffix: engine,
                                actualFiles: async () => {
                                    const records=SentlogRecords,owners=new Map();await records.init();
                                    return {
                                        assertExclusive:key=>{
                                            const state=records.writerState(key,{ownerToken:owners.get(key)});
                                            return state.exclusive&&!state.foreignPending&&!state.failed&&state.journaled;
                                        },
                                        getCapabilities:()=>records.getFileWriteCapabilities(),
                                        write:(key,blob,options)=>records.writeFile(key,blob,{...options,ownerToken:owners.get(key)}),
                                        async withLock(key,fn){
                                            if(owners.has(key))throw Error('fixture file lock must not overlap');
                                            const token={};owners.set(key,token);
                                            try{return await fn();}finally{if(owners.get(key)===token)owners.delete(key);}
                                        },
                                        async read(key){
                                            const db=await records.openFilesDatabase();
                                            try{return await new Promise((resolve,reject)=>{
                                                const tx=db.transaction('files','readonly'),q=tx.objectStore('files').get(key);let value;
                                                q.onsuccess=()=>{value=q.result;};
                                                tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);
                                            });}finally{db.close();}
                                        }
                                    };
                                },
                                onStart: name => {currentCase='runtime: '+name;console.log('RUN '+currentCase);},
                                onPass: name => {currentCase='runtime: '+name;cases.push(currentCase);console.log('PASS '+currentCase);}
                            });
                            return {cases, success:true};
                        } catch(error) {
                            return {cases, success:false, failed_case:currentCase,
                                browser_error:{
                                    name:String(error.name||''),message:String(error.message||error),
                                    stack:String(error.stack||''),
                                    original_name:error.originalName||error.name||'',
                                    original_message:error.originalMessage||error.message||'',
                                    original_code:error.originalCode??error.code??null,
                                    original_stack:error.originalStack||error.stack||''
                                }};
                        }
                    }""", args.browser)
                    report.update(outcome)
                    if report["success"]:
                        restart_seed = page.evaluate(PERSISTENCE_SEED)
                finally:
                    context.close()
                if restart_seed is not None:
                    # Closing launch_persistent_context also closes that browser
                    # process. Reopen the same profile and origin in a new one.
                    reopened = engine.launch_persistent_context(profile, headless=True)
                    try:
                        reopened_page = reopened.new_page()
                        reopened_page.goto(f"http://127.0.0.1:{server.server_port}/tests/delta_assets_fixture.html")
                        report["persistent_restart_probe"] = reopened_page.evaluate(PERSISTENCE_REOPEN, restart_seed)
                        print("PERSISTENT_RESTART_PROBE " + json.dumps(report["persistent_restart_probe"], ensure_ascii=False), flush=True)
                    finally:
                        reopened.close()
            browser = engine.launch(headless=True)
            try:
                private_context = browser.new_context()
                private_page = private_context.new_page()
                private_page.goto(f"http://127.0.0.1:{server.server_port}/tests/delta_assets_fixture.html")
                report["private_probe"] = private_page.evaluate(PRIVATE_PROBE)
                print("PRIVATE_PROBE " + json.dumps(report["private_probe"], ensure_ascii=False), flush=True)
                private_context.close()
            finally:
                browser.close()
            if not report["success"]:
                details = json.dumps(report["browser_error"], ensure_ascii=False)
                raise RuntimeError(f"Photo delivery failed in {report['failed_case']}: {details}")
            if not report["private_probe"]["success"]:
                report["success"] = False
                raise RuntimeError("Private storage safety probe failed: " + json.dumps(report["private_probe"], ensure_ascii=False))
            if not report.get("persistent_restart_probe", {}).get("success"):
                report["success"] = False
                raise RuntimeError("Photo bytes and receipt did not pass persistent browser restart verification")
    except Exception as error:
        report["success"] = False
        report["error"] = str(error)
        raise
    finally:
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        server.shutdown()
        server.server_close()
    print(f"PASS photo delivery on {args.browser}: {len(report['cases'])} cases")


if __name__ == "__main__":
    main()

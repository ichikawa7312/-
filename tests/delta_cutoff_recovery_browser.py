"""Native Blob/IndexedDB migration recovery in disposable browser profiles.

Loopback fixtures only. This verifies browser storage/reload, not an actual
iPhone, its memory limit, its files, or the user's authenticated cloud account.
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
PHOTO = b"native-recovery-photo:" + bytes(range(256)) * 512


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/synthetic-recovery-photo":
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(PHOTO)))
            self.end_headers()
            self.wfile.write(PHOTO)
        else:
            super().do_GET()


PREPARE = r"""async()=>{
  const R=SentlogRecords,WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
  const scope={ownerId:'native-owner',projectId:'native-cloud',deviceId:'native-device'},localProjectId='native-local';
  const sha=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
  const reference=await(await fetch('/synthetic-recovery-photo')).blob(),sha256=await sha(reference),size=reference.size;
  const record=SentlogRecordCollaboration.upgrade({id:'native-record',kind:'point',memo:'Original note',photos:[{id:'native-photo',name:'native.jpg',size,sha256}]});
  const project={id:localProjectId,name:'Native recovery',drawings:[{id:'native-drawing',name:'Drawing'}]};
  const originalRaw=JSON.stringify({sourceType:null,fileName:'',shapes:[record],collabDeletedRecords:[]});
  localStorage.setItem(WS,JSON.stringify({projects:[project]}));localStorage.setItem(DRAW+'native-drawing',originalRaw);
  await R.init();
  const cutoff=await R.deltaJournal.begin({scope,localProjectId,actor:{deviceId:scope.deviceId,deviceName:'Native test'},serverRevision:9});
  const source=SentlogDeltaLegacySource.createSource({journal:R.deltaJournal});
  const blocked=await source.capture(localProjectId,{recordCutoff:cutoff});
  if(blocked.readyForStaging||!blocked.issues.some(i=>i.code==='LEGACY_SOURCE_FILE_MISSING'))throw Error('Missing cutoff did not block');
  const blob=await(await fetch('/synthetic-recovery-photo')).blob(),key='photo:native-drawing:native-photo';
  const result=await R.deltaJournal.restoreMissingCutoffFile({scope,localProjectId,bindingId:cutoff.bindingId,key,blob,size,sha256,
    proof:{assetId:'native-asset',projectId:scope.projectId,clientKey:key,kind:'photo',drawingId:'native-drawing',photoId:'native-photo',size,sha256},validate:()=>true});
  if(!result.restored||!result.liveWritten)throw Error('Native recovery did not commit');
  const ready=await source.capture(localProjectId,{recordCutoff:cutoff});if(!ready.readyForStaging)throw Error('Native cutoff still blocked');source.close();
  const changed=JSON.parse(R.getItem(DRAW+'native-drawing'));changed.shapes[0].memo='Unsent note after recovery';R.setItem(DRAW+'native-drawing',JSON.stringify(changed));await R.settled();
  return {scope,localProjectId,bindingId:cutoff.bindingId,cutoffSeq:cutoff.cutoffSeq,originalRaw,key,size,sha256};
}"""

VERIFY = r"""async expected=>{
  const R=SentlogRecords;await R.init();
  const cutoff=await R.deltaJournal.readCutoff(expected),source=SentlogDeltaLegacySource.createSource({journal:R.deltaJournal});
  if(cutoff.bindingId!==expected.bindingId||cutoff.cutoffSeq!==expected.cutoffSeq)throw Error('Cutoff identity changed on reload');
  if(new Map(cutoff.rawEntries).get('surveyFieldNoteDrawingV1:native-drawing')!==expected.originalRaw)throw Error('Original cutoff records changed');
  const captured=await source.capture(expected.localProjectId,{recordCutoff:cutoff});source.close();
  if(!captured.readyForStaging)throw Error('Recovered native bytes did not survive reload');
  const file=captured.files.find(f=>f.key===expected.key);if(file?.sha256!==expected.sha256||file?.size!==expected.size)throw Error('Recovered native bytes changed');
  const state=JSON.parse(R.getItem('surveyFieldNoteDrawingV1:native-drawing'));if(state.shapes[0].memo!=='Unsent note after recovery')throw Error('Newer unsent edit lost');
  if((await R.deltaJournal.missingCutoffFiles(expected)).length)throw Error('Recovery would download saved bytes again');
  const db=await R.openFilesDatabase();const check=await new Promise((resolve,reject)=>{
    const tx=db.transaction(['files','sentlog_delta_journal_v1'],'readonly');let blob,rows;
    tx.objectStore('files').get(expected.key).onsuccess=e=>blob=e.target.result;
    tx.objectStore('sentlog_delta_journal_v1').getAll().onsuccess=e=>rows=e.target.result;
    tx.oncomplete=()=>resolve({blob,rows});tx.onabort=()=>reject(tx.error);
  });db.close();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await check.blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
  if(digest!==expected.sha256)throw Error('Live native photo differs from protected copy');
  if(!check.rows.some(row=>row.mutationKind==='cutoff-file-recovery')||!check.rows.some(row=>row.changes.some(c=>c.key==='surveyFieldNoteDrawingV1:native-drawing')))
    throw Error('Recovery or later edit was not journaled');
  return {ready:true,bytes:file.size,journalRows:check.rows.length,originalRecordsPreserved:true,laterEditPreserved:true};
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=["chromium", "webkit"], required=True)
    parser.add_argument("--executable-path")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="sentlog-recovery-native-") as profile, sync_playwright() as playwright:
            launch = {"headless": True}
            if args.executable_path:
                launch["executable_path"] = args.executable_path
            context = getattr(playwright, args.browser).launch_persistent_context(profile, **launch)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(f"http://127.0.0.1:{server.server_port}/tests/delta_indexeddb_fixture.html")
                expected = page.evaluate(PREPARE)
                page.reload()
                result = page.evaluate(VERIFY, expected)
                report = {"browser": args.browser, "result": "PASS", **result}
                if args.output:
                    args.output.parent.mkdir(parents=True, exist_ok=True)
                    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                print(json.dumps(report, ensure_ascii=False))
            finally:
                context.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()

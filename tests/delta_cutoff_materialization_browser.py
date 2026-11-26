"""Native IndexedDB/File regression for startup conversion of old cutoffs.

Only a disposable browser profile and loopback synthetic data are used. Desktop
WebKit is not an iPhone and does not reproduce an iPhone's process memory limit.
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


SEED = r"""async()=>{
  const R=SentlogRecords,H=SentlogBlobSha256,WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
  const scope={ownerId:'native-owner',projectId:'native-cloud',deviceId:'native-device'},localProjectId='native-local';
  const photo=new Blob(['native-photo'],{type:'image/jpeg'}),photoHash=await H.digest(photo);
  const file=new File([new Uint8Array(9*1024*1024+123).fill(17)],'native-large.pdf',
    {type:'application/pdf',lastModified:1700000000123}),sha256=await H.digest(file);
  const drawing={id:'native-drawing',name:'Drawing',sourceType:'pdf',fileName:file.name};
  const record=SentlogRecordCollaboration.upgrade({id:'record',kind:'point',memo:'Protected original note',
    photos:[{id:'photo',name:'native.jpg',size:photo.size,sha256:photoHash}]});
  const state={sourceType:'pdf',fileName:file.name,shapes:[record],collabDeletedRecords:[]};
  const project={id:localProjectId,name:'Native cutoff',drawings:[drawing]},workspaceRaw=JSON.stringify({projects:[project]}),drawingRaw=JSON.stringify(state);
  localStorage.setItem(WS,workspaceRaw);localStorage.setItem(DRAW+drawing.id,drawingRaw);await R.init();
  const db=await R.openFilesDatabase(),bindingId='binding:native-embedded';
  const meta=await new Promise((resolve,reject)=>{const q=db.transaction('files','readonly').objectStore('files').get('__sentlog_records_meta_v130__');
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const snapshot={version:1,kind:'sentlog-app-project',localProjectId,project,drawings:[{meta:drawing,state}]};
  const cutoff={version:1,kind:'sentlog-journal-cutoff',bindingId,scope,localProjectId,cutoffSeq:0,sourceRevision:meta.revision,
    sourceMeta:meta,snapshot,rawEntries:[[WS,workspaceRaw],[DRAW+drawing.id,drawingRaw]],
    files:[{key:'background:'+drawing.id,value:file},{key:'photo:'+drawing.id+':photo',value:photo}],metadataRecords:{},serverRevision:9};
  const binding={version:1,kind:'binding',id:bindingId,scope,localProjectId,phase:'staging',cutoffSeq:0,ackedSeq:0,
    actor:{deviceId:scope.deviceId,deviceName:'Native test'},metadataRecords:{},createdAt:1,cutoff};
  await new Promise((resolve,reject)=>{const tx=db.transaction(['files','sentlog_delta_control_v1'],'readwrite');
    tx.objectStore('files').put(file,'background:'+drawing.id);tx.objectStore('files').put(photo,'photo:'+drawing.id+':photo');
    tx.objectStore('sentlog_delta_control_v1').put(binding,'binding:'+localProjectId);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });db.close();
  return {scope,localProjectId,bindingId,drawingRaw,sha256,size:file.size,type:file.type,name:file.name,lastModified:file.lastModified};
}"""

VERIFY = r"""async ({expected,interrupt=false})=>{
  const R=SentlogRecords,H=SentlogBlobSha256,chunk=2*1024*1024,originalArrayBuffer=Blob.prototype.arrayBuffer,originalAdd=IDBObjectStore.prototype.add;
  let largestBuffer=0,readCount=0,added=0,error=null;
  Blob.prototype.arrayBuffer=function(){
    largestBuffer=Math.max(largestBuffer,this.size);readCount++;
    if(this.size>chunk)throw Error('whole-file ArrayBuffer forbidden: '+this.size);
    return originalArrayBuffer.call(this);
  };
  IDBObjectStore.prototype.add=function(value,...args){
    if(this.name==='sentlog_delta_control_v1'&&value?.kind==='cutoff-file'){
      added++;if(interrupt&&added===2)throw Error('synthetic stop after durable large PDF');
    }return originalAdd.call(this,value,...args);
  };
  try{
    try{await R.init();}catch(e){error=e.message;}
    if(interrupt&&!String(error).includes('synthetic stop'))throw Error('Expected interruption, received '+error);
    if(!interrupt&&error)throw Error(error);
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('surveyFieldNoteDB',2);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    const saved=await new Promise((resolve,reject)=>{const tx=db.transaction(['files','sentlog_delta_control_v1'],'readonly');let control,live;
      tx.objectStore('sentlog_delta_control_v1').getAll().onsuccess=e=>control=e.target.result;
      tx.objectStore('files').get('background:native-drawing').onsuccess=e=>live=e.target.result;
      tx.oncomplete=()=>resolve({control,live});tx.onabort=()=>reject(tx.error);
    });db.close();
    const binding=saved.control.find(row=>row?.kind==='binding'),rows=saved.control.filter(row=>row?.kind==='cutoff-file');
    if(binding.id!==expected.bindingId||new Map(binding.cutoff.rawEntries).get('surveyFieldNoteDrawingV1:native-drawing')!==expected.drawingRaw)
      throw Error('Protected source identity or note changed');
    if(rows.length!==(interrupt?1:2))throw Error('Unexpected immutable cutoff row count '+rows.length);
    if(await H.digest(saved.live)!==expected.sha256)throw Error('Live source bytes changed');
    let file;
    if(interrupt){
      file=binding.cutoff.files.find(f=>f.key==='background:native-drawing').value;
      if(!(file instanceof Blob))throw Error('Interrupted startup lost the embedded original');
    }else{
      if(binding.cutoff.files.some(f=>'value' in f))throw Error('Final binding still embeds photo bytes');
      file=(await R.deltaJournal.readCutoff(expected)).files.find(f=>f.key==='background:native-drawing').value;
    }
    if(await H.digest(file)!==expected.sha256||file.size!==expected.size||file.type!==expected.type||
      file.name!==expected.name||file.lastModified!==expected.lastModified)throw Error('PDF content or File metadata changed');
    const stored=rows.find(row=>row.key==='background:native-drawing');
    if(stored.sha256!==expected.sha256||stored.revision!==1||await H.digest(stored.value)!==expected.sha256)
      throw Error('Saved large PDF control row was replaced or damaged');
    return {interrupted:interrupt,largestBuffer,readCount,added,cutoffRows:rows.length,bytes:file.size,
      originalBytesPreserved:true,fileMetadataPreserved:true,protectedNotePreserved:true};
  }finally{Blob.prototype.arrayBuffer=originalArrayBuffer;IDBObjectStore.prototype.add=originalAdd;}
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
        with tempfile.TemporaryDirectory(prefix="sentlog-cutoff-native-") as profile, sync_playwright() as playwright:
            launch = {"headless": True}
            if args.executable_path:
                launch["executable_path"] = args.executable_path
            context = getattr(playwright, args.browser).launch_persistent_context(profile, **launch)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(f"http://127.0.0.1:{server.server_port}/tests/delta_indexeddb_fixture.html")
                expected = page.evaluate(SEED)
                page.reload()
                interrupted = page.evaluate(VERIFY, {"expected": expected, "interrupt": True})
                page.reload()
                resumed = page.evaluate(VERIFY, {"expected": expected})
                if resumed["added"] != 1:
                    raise AssertionError("Resume must only add the previously unfinished photo")
                page.reload()
                reopened = page.evaluate(VERIFY, {"expected": expected})
                if reopened["added"] != 0:
                    raise AssertionError("Completed conversion must not write any cutoff again")
                report = {"browser": args.browser, "result": "PASS", "interrupted": interrupted,
                          "resumed": resumed, "reopened": reopened, "actualIPhoneTest": False}
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

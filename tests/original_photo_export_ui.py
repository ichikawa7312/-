"""One project, one real ZIP, using the complete production application.

CI only. Native IndexedDB, Worker, OPFS and browser downloads stay real. The
large fixture contains 320 distinct 1.5 MiB originals (480 MiB), including
already-exported originals. Only external services and selected I/O failures
are controlled. Python independently checks every downloaded ZIP entry.
"""
import argparse
import base64
import functools
import hashlib
import io
import json
import os
import platform
import re
import sys
import tempfile
import threading
import time
import unicodedata
import zipfile
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlencode, urlparse

from PIL import Image
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BIG = 'original-export-large'
SMALL = 'original-export-small'
FOREIGN = 'original-export-foreign'
NAMESPACE = 'sentlog-original-photo-exports-v1'
BASE_TIME = 1795262400000
BIG_COUNT = 320
BIG_SIZE = 1536 * 1024
SMALL_COUNT = 16
SMALL_SIZE = 256 * 1024
CHUNK = 256 * 1024


def fixture_catalog():
    image = Image.new('RGB', (32, 24), (30, 90, 170))
    buffer = io.BytesIO()
    image.save(buffer, format='JPEG', quality=85)
    prefix = buffer.getvalue()
    pattern = bytes(((i * 31) ^ (i >> 8)) & 255 for i in range(65536))
    projects = [
        {'id': BIG, 'name': '宮沢橋/2:原本?試験', 'drawings': [
            {'id': f'original-large-d{i}', 'name': '上/流面' if i % 2 else '上\\流面'} for i in range(4)]},
        {'id': SMALL, 'name': 'Cafe\u0301 カ\u3099 保存確認と失敗復旧', 'drawings': [
            {'id': 'original-small-d0', 'name': '試験/図面'}, {'id': 'original-small-d1', 'name': '試験\\図面'}]},
        {'id': FOREIGN, 'name': '混入してはいけない別案件', 'drawings': [{'id': 'original-foreign-d0', 'name': '別図面'}]},
    ]
    rows = []
    for project, count, size, start in ((projects[0], BIG_COUNT, BIG_SIZE, 0),
                                      (projects[1], SMALL_COUNT, SMALL_SIZE, 1000),
                                      (projects[2], 7, 64 * 1024, 2000)):
        for index in range(count):
            number = start + index
            drawing = project['drawings'][index % len(project['drawings'])]
            marker = number.to_bytes(4, 'little')
            transformed = pattern.translate(bytes((i + number) & 255 for i in range(256)))
            body_size = size - len(prefix) - len(marker)
            payload = prefix + marker + (transformed * ((body_size + 65535) // 65536))[:body_size]
            photo_id = f'original-{number:04d}'
            name = 'IMG:撮影?.jpg' if index % 2 else 'IMG?撮影*.jpg'
            rows.append({'number': number, 'projectId': project['id'], 'projectName': project['name'],
                         'drawingId': drawing['id'], 'drawingName': drawing['name'],
                         'photoId': photo_id, 'key': drawing['id'] + ':' + photo_id,
                         'shapeId': 'overview-' + str(index % 2), 'shapeLabel': '全景:1' if index % 2 else '全景?1',
                         'exportName': name, 'originalName': name, 'size': size,
                         'createdAt': BASE_TIME + number, 'lastModified': BASE_TIME + number,
                         'type': 'image/jpeg', 'alreadyExported': index % 4 == 0,
                         'expectedSha256': hashlib.sha256(payload).hexdigest(),
                         'expectedCrc32': zlib.crc32(payload) & 0xffffffff})
    assert sum(row['size'] for row in rows if row['projectId'] == BIG) == 480 * 1024 * 1024
    assert len({row['expectedSha256'] for row in rows}) == len(rows)
    return {'projects': projects, 'rows': rows, 'jpegPrefix': base64.b64encode(prefix).decode('ascii')}


TRACE = r"""(() => {
  const trace=window.originalExportTrace={workers:[],urls:new Map(),ticks:0,maxTickGap:0};let lastTick=performance.now();
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker {
    constructor(url,options){
      super(url,options);
      if(!String(url).includes('original-photo-export-worker.js'))return;
      const row={url:String(url),native:this,messages:[],starts:[],terminated:false,file:null};trace.workers.push(row);
      const send=this.postMessage;
      this.postMessage=(message,...rest)=>{
        if(message?.type==='start')row.starts.push({requestId:message.requestId,projectId:message.projectId,
          rows:message.rows?.length,acknowledgedPreviousExports:message.acknowledgedPreviousExports||[]});
        return send.call(this,message,...rest);
      };
      this.addEventListener('message',event=>{
        const message=event.data||{},out={};
        for(const key of ['type','requestId','phase','doneFiles','totalFiles','doneBytes','totalBytes','fileName',
          'entryCount','originalBytes','zipBytes','zip64','code','message','cleanupComplete','writes','writtenBytes',
          'maxWrite','reads','readBytes','maxRead','faults','paused','previousExports'])if(message[key]!==undefined)out[key]=message[key];
        if(message.file)out.file={name:message.file.name,size:message.file.size,type:message.file.type};
        row.messages.push(out);
        if(message.type==='ready'&&String(url).includes('fixture_contract=1'))row.file=message.file;
      });
      const terminate=this.terminate;
      this.terminate=()=>{row.terminated=true;row.file=null;return terminate.call(this);};
    }
  };
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  URL.createObjectURL=function(blob){const url=create.apply(this,arguments);
    if(blob?.type==='application/zip')trace.urls.set(url,{size:blob.size});return url;};
  URL.revokeObjectURL=function(url){trace.urls.delete(url);return revoke.apply(this,arguments);};
  trace.snapshot=()=>({zipUrls:trace.urls.size,ticks:trace.ticks,maxTickGap:trace.maxTickGap,workers:trace.workers.map(w=>({
    url:w.url,terminated:w.terminated,starts:w.starts,messages:w.messages.slice(-35)}))});
  setInterval(()=>{const now=performance.now();trace.maxTickGap=Math.max(trace.maxTickGap,now-lastTick);lastTick=now;trace.ticks++;},25);
})()"""


NATIVE_ENVIRONMENT = r"""async()=>{
  const main={href:location.href,origin:location.origin,isSecureContext,storageType:typeof navigator.storage,
    getDirectoryType:typeof navigator.storage?.getDirectory,estimateType:typeof navigator.storage?.estimate,
    locksType:typeof navigator.locks?.request,userAgent:navigator.userAgent};
  const script=`(async()=>{const features={href:location.href,origin:location.origin,isSecureContext,
    storageType:typeof navigator.storage,getDirectoryType:typeof navigator.storage?.getDirectory,
    estimateType:typeof navigator.storage?.estimate,locksType:typeof navigator.locks?.request,
    syncAccessHandleType:typeof self.FileSystemSyncAccessHandle};
    const probe=features.syncAccessHandleProbe={ok:false,cleanupComplete:false,operations:[]};
    const phase=value=>{probe.phase=value;probe.operations.push(value);};
    let root,handle,created=false;const name='sentlog-export-native-probe-'+crypto.randomUUID();
    try{
      phase('getDirectory');root=await navigator.storage.getDirectory();
      phase('getFileHandle');const file=await root.getFileHandle(name,{create:true});created=true;
      features.createSyncAccessHandleType=typeof file.createSyncAccessHandle;
      phase('createSyncAccessHandle');handle=await file.createSyncAccessHandle();
      const expected=new TextEncoder().encode('native OPFS write/read/flush verification'),actual=new Uint8Array(expected.length);
      phase('truncate');await handle.truncate(0);
      phase('write');probe.writtenBytes=await handle.write(expected,{at:0});
      phase('flush');await handle.flush();phase('read');probe.readBytes=await handle.read(actual,{at:0});
      phase('close');await handle.close();handle=null;phase('getFile');
      const persisted=new Uint8Array(await (await file.getFile()).arrayBuffer());probe.persistedBytes=persisted.length;
      probe.ok=probe.writtenBytes===expected.length&&probe.readBytes===expected.length&&persisted.length===expected.length&&
        expected.every((value,index)=>actual[index]===value&&persisted[index]===value);
      if(!probe.ok)throw Error('Native OPFS bytes did not round trip');
    }catch(error){probe.error={name:error.name,message:error.message,phase:probe.phase};}
    finally{
      try{
        if(handle){phase('cleanup-close');await handle.close();}
        if(created){phase('remove');await root.removeEntry(name);}probe.cleanupComplete=true;
      }catch(error){probe.cleanupError={name:error.name,message:error.message,phase:probe.phase};}
    }
    postMessage(features);
  })();`;
  const url=URL.createObjectURL(new Blob([script],{type:'text/javascript'})),worker=new Worker(url);let timer;
  try{const features=await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('Native worker capability probe timed out')),10000);
    worker.onmessage=event=>resolve(event.data);worker.onerror=event=>{event.preventDefault();reject(Error(event.message));};
  });return {main,worker:features};}
  finally{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);}
}"""


# This shim surrounds real native I/O, then imports the unmodified production
# worker. It never substitutes a ZIP writer, IndexedDB, OPFS file, or result.
WORKER_BOUNDARY = r"""(() => {
  const mode=__MODE__,post=self.postMessage.bind(self);
  const io={writes:0,writtenBytes:0,maxWrite:0,reads:0,readBytes:0,maxRead:0,faults:0,paused:false};
  let requestId='',resume=null;
  self.addEventListener('message',event=>{
    if(event.data?.type==='start')requestId=event.data.requestId;
    if(['fixture-resume','cancel','release'].includes(event.data?.type)){resume?.();resume=null;}
  });
  const access=self.FileSystemSyncAccessHandle?.prototype;
  if(!access)throw Error('Native FileSystemSyncAccessHandle is unavailable');
  const write=access.write;
  access.write=function(bytes,options){
    if(io.writtenBytes>=512*1024&&['quota','zero-write'].includes(mode)&&!io.faults){
      io.faults++;post({type:'fixture-fault',requestId,...io});
      if(mode==='quota')throw new DOMException('Synthetic quota failure at native OPFS write','QuotaExceededError');
      return 0;
    }
    const record=written=>{io.writes++;io.writtenBytes+=Number(written)||0;io.maxWrite=Math.max(io.maxWrite,bytes.byteLength);return written;};
    const value=write.call(this,bytes,options);return value&&typeof value.then==='function'?value.then(record):record(value);
  };
  const arrayBuffer=Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer=async function(){
    if(mode==='pause'&&io.writtenBytes>=2*1024*1024&&!io.paused){
      io.paused=true;post({type:'fixture-paused',requestId,...io});
      await new Promise(resolve=>resume=resolve);
    }
    const result=await arrayBuffer.apply(this,arguments);io.reads++;io.readBytes+=result.byteLength;io.maxRead=Math.max(io.maxRead,result.byteLength);return result;
  };
  self.postMessage=function(message,...rest){
    if(['ready','error','cancelled','released'].includes(message?.type))post({type:'fixture-io',requestId,...io});
    return post(message,...rest);
  };
})();
importScripts(__SOURCE__);
"""


SEED = r"""async fixture=>{
  await sentlogAppReady;window.sentlogImporting=true;
  workspace={projects:fixture.projects.map(project=>({...project,drawings:project.drawings.map(d=>({...d,
    sourceType:null,fileName:'',pageCount:1,shapeCount:0,photoCount:0}))}))};
  SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(workspace));
  for(const project of workspace.projects)for(const drawing of project.drawings)
    SentlogRecords.setItem(drawingStorageKey(drawing.id),JSON.stringify(freshDrawingState(project.name)));
  await SentlogRecords.settled();showDrawings(fixture.projects[0].id);
  const prefix=Uint8Array.from(atob(fixture.jpegPrefix),x=>x.charCodeAt(0)),pattern=new Uint8Array(65536);
  for(let i=0;i<pattern.length;i++)pattern[i]=((i*31)^(i>>>8))&255;
  const exported=[];window.originalFixture={done:0,backups:new Map(),rows:fixture.rows};
  for(const row of fixture.rows){
    const value=new Uint8Array(row.size);value.set(prefix);new DataView(value.buffer).setUint32(prefix.length,row.number,true);
    const tile=Uint8Array.from(pattern,x=>(x+row.number)&255);
    for(let at=prefix.length+4;at<value.length;at+=tile.length)value.set(tile.subarray(0,Math.min(tile.length,value.length-at)),at);
    const file=new File([value],row.originalName,{type:row.type,lastModified:row.lastModified});
    const {number,alreadyExported,expectedSha256,expectedCrc32,...meta}=row;
    await SentlogOriginalPhotos.saveOriginal(row.drawingId,row.photoId,file,meta);
    if(alreadyExported)exported.push(row.key);originalFixture.done++;
  }
  await SentlogOriginalPhotos.markExported(exported,'previous-device-export.zip');
  // Use the same native API generation as the real exporter; main-thread
  // createWritable support is not a prerequisite for Worker SyncAccessHandle.
  const source=`(async()=>{try{const root=await navigator.storage.getDirectory(),
    dir=await root.getDirectoryHandle('unrelated-export-test',{create:true}),
    file=await dir.getFileHandle('keep.txt',{create:true}),handle=await file.createSyncAccessHandle();
    try{await handle.truncate(0);await handle.write(new TextEncoder().encode('unrelated OPFS content must survive export cleanup'),{at:0});await handle.flush();}
    finally{await handle.close();}postMessage({ok:true});}catch(e){postMessage({error:e.message});}})();`;
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'})),worker=new Worker(url);
  try{await new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.ok?resolve():reject(Error(e.data.error));worker.onerror=e=>reject(Error(e.message));});}
  finally{worker.terminate();URL.revokeObjectURL(url);}
  return {count:fixture.rows.length,alreadyExported:exported.length,quota:await navigator.storage.estimate()};
}"""


READ_NATIVE = r"""async projectId=>{
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('sentlog-original-photos-v1');
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const read=(stores,fn)=>new Promise((resolve,reject)=>{const tx=db.transaction(stores,'readonly');let value;
    fn(tx,x=>value=x);tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});
  try{
    const metas=await read('meta',(tx,done)=>{tx.objectStore('meta').getAll().onsuccess=e=>done(e.target.result);});
    const keys=await read('photos',(tx,done)=>{tx.objectStore('photos').getAllKeys().onsuccess=e=>done(e.target.result);});
    const entries=[];
    for(const meta of metas.filter(m=>!projectId||m.projectId===projectId).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)){
      const blob=await read('photos',(tx,done)=>{tx.objectStore('photos').get(meta.key).onsuccess=e=>done(e.target.result);});
      const digest=blob?[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join(''):null;
      entries.push({key:meta.key,meta,size:blob?.size??null,sha256:digest});
    }
    return {entries,photoKeys:keys.sort(),metaKeys:metas.map(m=>m.key).sort()};
  }finally{db.close();}
}"""


MUTATE_NATIVE = r"""async ({key,mode})=>{
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('sentlog-original-photos-v1');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{
    if(mode!=='restore'){
      const saved=await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','photos'],'readonly'),out={};
        tx.objectStore('meta').get(key).onsuccess=e=>out.meta=e.target.result;
        tx.objectStore('photos').get(key).onsuccess=e=>out.blob=e.target.result;
        tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error);});
      if(!saved.meta||!(saved.blob instanceof Blob))throw Error('Mutation fixture source missing');
      originalFixture.backups.set(key,saved);
    }
    const saved=originalFixture.backups.get(key);if(!saved)throw Error('Missing mutation backup');
    await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','photos'],'readwrite');
      if(mode==='missing')tx.objectStore('photos').delete(key);
      else if(mode==='changed')tx.objectStore('meta').put({...saved.meta,exportName:'changed-during-export.jpg',storedAt:saved.meta.storedAt+1});
      else if(mode==='restore'){tx.objectStore('meta').put(saved.meta);tx.objectStore('photos').put(saved.blob,key);}
      else throw Error('Unknown fixture mutation');
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});
    if(mode==='restore')originalFixture.backups.delete(key);
  }finally{db.close();}
}"""


OPFS_STATE = r"""async()=>{
  const root=await navigator.storage.getDirectory(),jobs=[];let lease=false;
  try{const directory=await root.getDirectoryHandle('sentlog-original-photo-exports-v1');
    for await(const [name,handle] of directory.entries()){
      if(name==='lease')lease=true;
      if(name.startsWith('job-')){const entries=[];for await(const [child]of handle.entries())entries.push(child);jobs.push({name,entries:entries.sort()});}
    }
  }catch(error){if(error.name!=='NotFoundError')throw error;}
  const other=await root.getDirectoryHandle('unrelated-export-test'),file=await other.getFileHandle('keep.txt');
  return {jobs:jobs.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),lease,sentinel:await (await file.getFile()).text()};
}"""


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def capture_failure(page, report, report_path, error):
    report.update(status='failed', error=str(error))
    if page is not None:
        try:
            if not page.is_closed():
                page.screenshot(path=str(report_path.with_suffix('')) + '-failure.png', full_page=True, timeout=10000)
                report['failureTrace'] = page.evaluate('originalExportTrace?.snapshot()')
                if page.locator('#slOriginalExportStatus').count():
                    report['failureStatus'] = page.locator('#slOriginalExportStatus').text_content(timeout=3000)
                report['failureOpfs'] = page.evaluate(OPFS_STATE)
        except Exception as diagnostic_error:
            report['diagnosticError'] = str(diagnostic_error)
    save_json(report_path, report)


def safe_segment(value):
    value = unicodedata.normalize('NFC', value)
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', '_', value).strip().rstrip('. ')
    return value or '_'


def verify_zip(path, expected):
    by_hash = {row['expectedSha256']: row for row in expected}
    assert len(by_hash) == len(expected)
    found = set()
    results = []
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        assert len(entries) == len(expected), (len(entries), len(expected))
        folded = set()
        for entry in entries:
            assert not entry.is_dir() and entry.compress_type == zipfile.ZIP_STORED, entry.filename
            parts = PurePosixPath(entry.filename).parts
            assert len(parts) == 6 and not entry.filename.startswith('/') and '..' not in parts, entry.filename
            assert not re.search(r'[<>:"\\|?*\x00-\x1f\x7f]', entry.filename), entry.filename
            normalized = unicodedata.normalize('NFC', entry.filename).casefold()
            assert normalized not in folded, entry.filename
            folded.add(normalized)
            digest, crc, size = hashlib.sha256(), 0, 0
            with archive.open(entry) as source:
                while block := source.read(1024 * 1024):
                    digest.update(block)
                    crc = zlib.crc32(block, crc)
                    size += len(block)
            sha = digest.hexdigest()
            assert sha in by_hash and sha not in found, (entry.filename, sha)
            found.add(sha)
            row = by_hash[sha]
            assert size == entry.file_size == row['size']
            assert (crc & 0xffffffff) == entry.CRC == row['expectedCrc32']
            assert parts[:5] == ('2026', safe_segment(row['projectName']), '写真',
                                 safe_segment(row['drawingName']), safe_segment(row['shapeLabel'])), (entry.filename, row)
            assert parts[-1].startswith('IMG_撮影_') and parts[-1].endswith('.jpg'), entry.filename
            results.append({'sourceKey': row['key'], 'path': entry.filename, 'expectedSize': row['size'], 'actualSize': size,
                            'expectedSha256': row['expectedSha256'], 'actualSha256': sha,
                            'expectedCrc32': row['expectedCrc32'], 'actualCrc32': entry.CRC})
    assert found == set(by_hash)
    return {'entryCount': len(results), 'originalBytes': sum(row['size'] for row in expected),
            'zipBytes': path.stat().st_size, 'entries': results}


def check_native(snapshot, expected):
    by_key = {row['key']: row for row in expected}
    assert snapshot['photoKeys'] == snapshot['metaKeys'] == sorted(by_key)
    assert len(snapshot['entries']) == len(expected)
    for entry in snapshot['entries']:
        row = by_key[entry['key']]
        assert entry['size'] == row['size'] and entry['sha256'] == row['expectedSha256'], entry
        assert entry['meta']['projectId'] == row['projectId']
        assert entry['meta']['drawingId'] == row['drawingId'] and entry['meta']['photoId'] == row['photoId']


def worker_messages(page, index):
    return page.evaluate('index=>originalExportTrace.workers[index].messages', index)


def wait_message(page, index, kind, timeout=120000):
    page.wait_for_function("""({index,kind})=>originalExportTrace.workers[index]?.messages.some(m=>
      m.type===kind||m.type==='error'||(kind==='fixture-paused'&&m.type==='ready'))""",
                           arg={'index': index, 'kind': kind}, timeout=timeout)
    messages = worker_messages(page, index)
    found = next((message for message in reversed(messages) if message['type'] == kind), None)
    assert found is not None, {'expectedMessage': kind, 'messages': messages[-12:]}
    return found


def latest_worker(page, previous):
    page.wait_for_function('n=>originalExportTrace.workers.length>n', arg=previous)
    return page.evaluate('originalExportTrace.workers.length-1')


def check_layout(page):
    return page.evaluate("""()=>{
      const dialog=document.getElementById('slOriginalPhotoExportDialog'),rect=dialog.getBoundingClientRect();
      const visible=['slOriginalExportStart','slOriginalExportSave','slOriginalExportCancel','slOriginalExportClose','slOriginalExportConfirm','slOriginalExportDiscard']
        .map(id=>document.getElementById(id)).filter(el=>el&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');
      return {viewport:[innerWidth,innerHeight],pageWidth:document.documentElement.scrollWidth,
        dialog:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
        buttons:visible.map(el=>({id:el.id,text:el.textContent,disabled:!!el.disabled||el.getAttribute('aria-disabled')==='true',rect:el.getBoundingClientRect().toJSON()}))};
    }""")


def assert_layout(layout):
    width, height = layout['viewport']
    assert layout['pageWidth'] <= width + 1, layout
    assert layout['dialog']['left'] >= -1 and layout['dialog']['right'] <= width + 1, layout
    assert layout['buttons'], layout
    for button in layout['buttons']:
        assert button['rect']['left'] >= -1 and button['rect']['right'] <= width + 1, layout
        assert button['rect']['width'] >= 44 and button['rect']['height'] >= 40, layout
    assert layout['dialog']['top'] < height and layout['dialog']['bottom'] > 0, layout
    assert any(not button['disabled'] and button['rect']['top'] >= 0 and button['rect']['bottom'] <= height + 1
               for button in layout['buttons']), layout


def open_ui(page, project_id):
    page.evaluate('id=>showDrawings(id)', project_id)
    button = page.locator('#slOriginalPhotoExportBtn')
    expect(button).to_be_visible()
    button.click()
    expect(page.locator('#slOriginalPhotoExportDialog')).to_be_visible()
    page.locator('#slOriginalExportProject').select_option(project_id)
    expect(page.locator('#slOriginalExportStart')).to_be_enabled(timeout=30000)
    assert page.locator('#slOriginalExportProject').input_value() == project_id
    assert_layout(check_layout(page))


def open_settings_ui(page, project_id):
    # The preceding export scenarios leave the real app in its drawing list.
    # Settings is a home-screen control (the production header hides it on
    # other views), so exercise the actual back button before opening it.
    assert page.evaluate('currentView') == 'drawings'
    expect(page.locator('#navBackBtn')).to_be_visible()
    page.locator('#navBackBtn').click()
    page.wait_for_function("currentView==='projects'")
    expect(page.locator('#sentlogSettingsBtn')).to_be_visible()
    page.locator('#sentlogSettingsBtn').click()
    expect(page.locator('#sentlogSettingsModal')).to_have_attribute('aria-hidden', 'false')
    section = page.locator('#sentlogOriginalPhotosSection')
    if not section.evaluate('element=>element.open'):
        section.locator('summary').click()
    select = section.locator('[data-role=project]')
    page.wait_for_function("id=>[...document.querySelector('#sentlogOriginalPhotosSection [data-role=project]').options].some(o=>o.value===id)", arg=project_id)
    select.select_option(project_id)
    start = section.locator('[data-role=projectExport]')
    expect(start).to_be_enabled()
    start.click()
    expect(page.locator('#slOriginalPhotoExportDialog')).to_be_visible()
    expect(page.locator('#slOriginalExportStart')).to_be_enabled()
    assert page.locator('#slOriginalExportProject').input_value() == project_id
    assert not page.locator('#slOriginalPhotoExportDialog').evaluate('element=>element.inert')


def begin_ui(page):
    previous = page.evaluate('originalExportTrace.workers.length')
    page.locator('#slOriginalExportStart').click()
    return latest_worker(page, previous)


def close_ui(page, index, *, discard=False):
    page.locator('#slOriginalExportDiscard' if discard else '#slOriginalExportClose').click()
    page.wait_for_function('!SentlogOriginalPhotoExport.busy')
    page.wait_for_function('i=>originalExportTrace.workers[i].terminated', arg=index)
    wait_clean(page)


def wait_clean(page):
    page.wait_for_function('async()=>{const s=await (' + OPFS_STATE + ')();return s.jobs.length===0;}', timeout=30000)
    state = page.evaluate(OPFS_STATE)
    assert not state['jobs'], state
    assert state['sentinel'] == 'unrelated OPFS content must survive export cleanup', state
    assert page.evaluate('originalExportTrace.urls.size') == 0
    return state


def assert_io(page, index, *, fault=False):
    messages = worker_messages(page, index)
    samples = [m for m in messages if m['type'] == 'fixture-io']
    assert samples, messages
    sample = samples[-1]
    assert sample['writes'] > 0 and sample['writtenBytes'] > 0, sample
    assert 0 < sample['maxWrite'] <= CHUNK and 0 < sample['maxRead'] <= CHUNK, sample
    assert sample['faults'] == int(fault), sample
    return sample


def download_ui(page, path, *, close_race=False):
    expect(page.locator('#slOriginalExportSave')).to_be_visible(timeout=180000)
    expect(page.locator('#slOriginalExportConfirm')).to_be_disabled()
    if close_race:
        page.locator('#slOriginalExportSave').evaluate("""element=>element.addEventListener('click',()=>{
          window.originalCloseRace={attempted:true};
          void SentlogOriginalPhotoExport.close().then(()=>originalCloseRace.returned=true);
        },{once:true})""")
    with page.expect_download(timeout=180000) as pending:
        page.locator('#slOriginalExportSave').click()
    download = pending.value
    if close_race:
        page.wait_for_function('originalCloseRace.returned===true')
        expect(page.locator('#slOriginalPhotoExportDialog')).to_be_visible()
        expect(page.locator('#slOriginalExportSave')).to_be_visible()
        assert page.evaluate('SentlogOriginalPhotoExport.busy')
        assert page.evaluate('originalExportTrace.urls.size') == 1
        assert len(page.evaluate(OPFS_STATE)['jobs']) == 1
    download.save_as(str(path))
    assert download.failure() is None
    expect(page.locator('#slOriginalExportConfirm')).to_be_enabled()
    return download.suggested_filename


def direct_start(page, origin, project_id, rows, mode='normal', *, acknowledged=None):
    return page.evaluate("""({url,projectId,rows,acknowledged})=>{
      const index=originalExportTrace.workers.length,worker=new Worker(url),requestId=crypto.randomUUID();
      const acknowledgedPreviousExports=acknowledged;
      worker.postMessage({type:'start',requestId,projectId,rows,fileName:'worker-contract.zip',
        ...(acknowledgedPreviousExports?{acknowledgedPreviousExports}:{})});
      return {index,requestId};
    }""", {'url': origin + '/sentlog/original-photo-export-worker.js?' + urlencode({'fixture_contract': '1', 'fixture_mode': mode}),
             'projectId': project_id, 'rows': rows, 'acknowledged': acknowledged})


def direct_message(page, worker, kind):
    page.evaluate('({index,requestId,type})=>originalExportTrace.workers[index].native.postMessage({requestId,type})',
                  {**worker, 'type': kind})


def direct_terminate(page, worker):
    page.evaluate('index=>originalExportTrace.workers[index].native.terminate()', worker['index'])


def start_after_worker_exit(page, origin, project_id, rows, *, acknowledged=None):
    # The browser may finish terminating the previous worker asynchronously.
    # Only an actual busy response allows this short bounded wait; the fixture
    # never removes or bypasses the native lease or any completed output.
    retries = 0
    deadline = time.monotonic() + 15
    while True:
        worker = direct_start(page, origin, project_id, rows, acknowledged=acknowledged)
        page.wait_for_function("i=>originalExportTrace.workers[i].messages.some(m=>m.type==='ready'||m.type==='error')", arg=worker['index'])
        terminal = next(m for m in worker_messages(page, worker['index']) if m['type'] in ('ready', 'error'))
        if terminal.get('code') != 'EXPORT_BUSY':
            return worker, terminal, retries
        assert time.monotonic() < deadline, terminal
        retries += 1
        direct_terminate(page, worker)
        page.wait_for_timeout(100)


def download_worker_file(page, worker, path):
    with page.expect_download() as pending:
        page.evaluate("""index=>{
          const file=originalExportTrace.workers[index].file;
          if(!(file instanceof File)||!file.size)throw Error('Ready must contain a real File before release');
          const anchor=document.createElement('a');anchor.download=file.name;anchor.href=URL.createObjectURL(file);
          anchor.id='fixture-contract-download';document.body.appendChild(anchor);anchor.click();
        }""", worker['index'])
    download = pending.value
    download.save_as(str(path))
    assert download.failure() is None
    page.evaluate("""()=>{const a=document.getElementById('fixture-contract-download');URL.revokeObjectURL(a.href);a.remove();}""")


def download_retained_ready_file(page, path):
    with page.expect_download() as pending:
        page.evaluate("""()=>{
          const file=window.originalReadyCrashFile;
          if(!(file instanceof File)||!file.size)throw Error('Original ready File must remain available after worker termination');
          const anchor=document.createElement('a');anchor.id='fixture-contract-download';anchor.download='retained-after-worker-crash.zip';
          anchor.href=URL.createObjectURL(file);document.body.appendChild(anchor);anchor.click();
        }""")
    download = pending.value
    download.save_as(str(path))
    assert download.failure() is None
    page.evaluate("""()=>{const a=document.getElementById('fixture-contract-download');URL.revokeObjectURL(a.href);a.remove();delete window.originalReadyCrashFile;}""")


def run(page, context, origin, route_state, fixture, report, report_path, directory):
    prefix = report_path.with_suffix('')
    expected = fixture['rows']
    big = [row for row in expected if row['projectId'] == BIG]
    small = [row for row in expected if row['projectId'] == SMALL]
    report['seed'] = page.evaluate(SEED, fixture)
    print('SEEDED native originals: 320 large / 480 MiB plus isolated small and foreign projects', flush=True)
    report['sourceBefore'] = page.evaluate(READ_NATIVE, None)
    check_native(report['sourceBefore'], expected)
    before_meta = {entry['key']: entry['meta'] for entry in report['sourceBefore']['entries']}
    assert sum(bool(before_meta[row['key']]['exportedAt']) for row in big) == 80
    records_before = page.evaluate('SentlogRecords.keys().sort().map(key=>[key,SentlogRecords.getItem(key)])')
    expect(page.locator('#slOriginalPhotoExportBtn')).to_be_visible()
    page.screenshot(path=str(prefix) + '-drawing-entry.png')
    save_json(report_path, report)

    # Fail fast on the real product loader, drawing-list button and download.
    report['stage'] = 'small-ui-export'
    open_ui(page, SMALL)
    index = begin_ui(page)
    wait_message(page, index, 'ready')
    path = directory / 'small-ui.zip'
    name = download_ui(page, path, close_race=True)
    report['smallUiExport'] = {'fileName': name, **verify_zip(path, small), 'io': assert_io(page, index)}
    report['downloadCloseRace'] = {'retainedUntilAcknowledgement': True, 'downloadedAndVerified': True}
    repeated = page.locator('#slOriginalExportSave').evaluate("""element=>{
      const event=new MouseEvent('click',{bubbles:true,cancelable:true});
      return {defaultAllowed:element.dispatchEvent(event),defaultPrevented:event.defaultPrevented,ariaDisabled:element.getAttribute('aria-disabled')};
    }""")
    assert repeated == {'defaultAllowed': False, 'defaultPrevented': True, 'ariaDisabled': 'true'}, repeated
    report['repeatedSave'] = repeated
    page.screenshot(path=str(prefix) + '-portrait-ready.png')
    report['portraitLayout'] = check_layout(page)
    assert_layout(report['portraitLayout'])
    page.set_viewport_size({'width': 844, 'height': 390})
    expect(page.locator('#slOriginalExportSave')).to_be_visible()
    page.locator('#slOriginalExportSave').scroll_into_view_if_needed()
    report['landscapeLayout'] = check_layout(page)
    assert_layout(report['landscapeLayout'])
    page.screenshot(path=str(prefix) + '-landscape-ready.png')
    page.set_viewport_size({'width': 390, 'height': 844})

    # A second independent tab runs the same built source store. It must be
    # unable to delete exported originals or begin another source session.
    probe = context.new_page()
    try:
        probe.goto(origin + '/fixtures/original-export-lock.html', wait_until='domcontentloaded')
        probe.wait_for_function('window.SentlogOriginalPhotos')
        report['crossTabGuards'] = probe.evaluate("""async projectId=>{
          const result={};for(const [key,fn]of [['export',()=>SentlogOriginalPhotos.beginExportSession(projectId)],
            ['cleanup',()=>SentlogOriginalPhotos.deleteExported()]]){
            try{const value=await fn();if(key==='export')SentlogOriginalPhotos.releaseExportSession(value);result[key]={blocked:false};}
            catch(error){result[key]={blocked:true,message:error.message};}
          }return result;
        }""", SMALL)
        assert all(result['blocked'] for result in report['crossTabGuards'].values()), report['crossTabGuards']
        assert '別の画面' in report['crossTabGuards']['export']['message'], report['crossTabGuards']
        assert 'ZIP保存画面' in report['crossTabGuards']['cleanup']['message'], report['crossTabGuards']
        assert {m['key']: m for m in page.evaluate('SentlogOriginalPhotos.listMeta()')} == before_meta
    finally:
        probe.close()

    # Change the last source only after ready/download. Confirmation has to
    # roll back its entire transaction, including earlier rows it inspected.
    key = small[-1]['key']
    page.evaluate(MUTATE_NATIVE, {'key': key, 'mode': 'changed'})
    injected = page.evaluate(READ_NATIVE, SMALL)
    page.locator('#slOriginalExportConfirm').click()
    expect(page.locator('#slOriginalExportStatus')).to_contain_text('保存確認は付けていません')
    assert page.evaluate('SentlogOriginalPhotoExport.state.confirmed') is False
    assert page.evaluate('SentlogOriginalPhotoExport.state.saveAcknowledged') is True
    assert page.locator('#slOriginalExportSave').count() == 0
    assert page.evaluate(READ_NATIVE, SMALL) == injected, 'failed confirmation must roll back all previously checked rows'
    report['conditionalConfirmation'] = {'changedKey': key, 'allOrNothing': True, 'confirmed': False}
    page.evaluate(MUTATE_NATIVE, {'key': key, 'mode': 'restore'})
    close_ui(page, index)
    path.unlink()
    assert {m['key']: m for m in page.evaluate('SentlogOriginalPhotos.listMeta()')} == before_meta
    save_json(report_path, report)

    report['largeExports'] = []
    for number in (1, 2):
        report['stage'] = f'large-ui-export-{number}'
        save_json(report_path, report)
        open_ui(page, BIG)
        before_downloads = report['downloadEvents']
        before_ticks = page.evaluate('originalExportTrace.ticks')
        started = time.perf_counter()
        index = begin_ui(page)
        ready = wait_message(page, index, 'ready', 300000)
        interactive_ticks = page.evaluate('originalExportTrace.ticks') - before_ticks
        assert interactive_ticks >= 2, 'the page event loop must continue while the Worker builds the large ZIP'
        assert ready['entryCount'] == BIG_COUNT and ready['originalBytes'] == BIG_COUNT * BIG_SIZE, ready
        assert ready['zipBytes'] > 400 * 1024 * 1024 and ready['file']['size'] == ready['zipBytes'], ready
        path = directory / f'large-{number}.zip'
        name = download_ui(page, path)
        checked = verify_zip(path, big)
        assert report['downloadEvents'] == before_downloads + 1, 'one action must produce exactly one download'
        assert checked['entryCount'] > 250 and checked['originalBytes'] > 400 * 1024 * 1024
        progress = [m for m in worker_messages(page, index) if m['type'] == 'progress']
        assert any(m['phase'] == 'writing' and m['doneBytes'] > 0 for m in progress), progress
        assert any(m['phase'] == 'finalizing' for m in progress), progress
        assert all(m['totalFiles'] == BIG_COUNT and m['totalBytes'] == BIG_COUNT * BIG_SIZE for m in progress)
        report['largeExports'].append({'fileName': name, 'elapsedMs': round((time.perf_counter() - started) * 1000, 2),
                                       'ready': ready, **checked, 'io': assert_io(page, index),
                                       'alreadyExportedIncluded': 80, 'pageHeartbeatsDuringWorker': interactive_ticks})
        close_ui(page, index, discard=True)
        path.unlink()
        assert {m['key']: m for m in page.evaluate('SentlogOriginalPhotos.listMeta()')} == before_meta
        save_json(report_path, report)
        print(f'PASS large export {number}: one ZIP, 320 entries, 480 MiB, exact bytes, 80 previously exported originals', flush=True)

    # Force a real page lifecycle boundary after two 480 MiB exports. This
    # checks durable originals and metadata across reload and prevents
    # transient WebKit File/download/page resources from polluting the
    # subsequent small-project fault-injection checks.
    report['stage'] = 'reload-after-large-exports'
    save_json(report_path, report)
    print('START reload after two full ZIP downloads', flush=True)
    page.reload(wait_until='domcontentloaded')
    page.wait_for_function('window.sentlogAppReady&&window.SentlogOriginalPhotos&&window.SentlogOriginalPhotoExport', timeout=60000)
    page.evaluate('sentlogAppReady')
    page.evaluate('id=>showDrawings(id)', SMALL)
    assert {m['key']: m for m in page.evaluate('SentlogOriginalPhotos.listMeta()')} == before_meta
    assert page.evaluate('SentlogRecords.keys().sort().map(key=>[key,SentlogRecords.getItem(key)])') == records_before
    print('PASS reload after large exports: all local originals and shared records preserved', flush=True)
    save_json(report_path, report)

    # Hold a real chunk read after data has reached OPFS. Cancel must drain the
    # worker and release its temporary file; it cannot report a completed ZIP.
    report['stage'] = 'cancel-after-progress'
    route_state['mode'] = 'pause'
    open_ui(page, SMALL)
    index = begin_ui(page)
    paused = wait_message(page, index, 'fixture-paused')
    assert paused['writtenBytes'] >= 2 * 1024 * 1024
    assert any(m['type'] == 'progress' and m.get('doneBytes', 0) > 0 for m in worker_messages(page, index))
    page.locator('#slOriginalExportCancel').click()
    cancelled = wait_message(page, index, 'cancelled')
    assert cancelled['cleanupComplete'] is True
    page.wait_for_function('!SentlogOriginalPhotoExport.busy')
    assert not any(m['type'] == 'ready' for m in worker_messages(page, index))
    expect(page.locator('#slOriginalExportSave')).not_to_be_visible()
    report['cancel'] = {'paused': paused, 'result': cancelled, 'cleanup': wait_clean(page), 'io': assert_io(page, index)}
    page.locator('#slOriginalExportClose').click()
    route_state['mode'] = 'normal'
    save_json(report_path, report)

    report['writeFailures'] = []
    for mode, code in (('quota', 'STORAGE_FULL'), ('zero-write', 'ZIP_WRITE_INCOMPLETE')):
        report['stage'] = 'write-failure-' + mode
        route_state['mode'] = mode
        open_ui(page, SMALL)
        index = begin_ui(page)
        failed = wait_message(page, index, 'error')
        assert failed['code'] == code and failed['cleanupComplete'] is True, failed
        assert not any(m['type'] == 'ready' for m in worker_messages(page, index))
        page.wait_for_function('!SentlogOriginalPhotoExport.busy')
        expect(page.locator('#slOriginalExportSave')).not_to_be_visible()
        expect(page.locator('#slOriginalExportStatus')).to_contain_text(re.compile('元写真|原本'))
        report['writeFailures'].append({'mode': mode, 'error': failed, 'cleanup': wait_clean(page), 'io': assert_io(page, index, fault=True)})
        page.locator('#slOriginalExportClose').click()
        route_state['mode'] = 'normal'
        assert {m['key']: m for m in page.evaluate('SentlogOriginalPhotos.listMeta()')} == before_meta
        save_json(report_path, report)

    # A newer native metadata transaction invalidates the worker's real saved
    # snapshot. Restoration below is test-fixture repair, never app recovery.
    report['sourceFailures'] = []
    for mode, code in (('changed', 'SOURCE_CHANGED'), ('missing', 'SOURCE_MISSING')):
        report['stage'] = 'source-' + mode
        route_state['mode'] = 'pause'
        open_ui(page, SMALL)
        index = begin_ui(page)
        paused = wait_message(page, index, 'fixture-paused')
        request_id = next(m['requestId'] for m in worker_messages(page, index) if m['type'] == 'progress')
        # The last key is still unread when the chunk hold starts after 2 MiB.
        key = small[-1]['key']
        page.evaluate(MUTATE_NATIVE, {'key': key, 'mode': mode})
        injected = page.evaluate(READ_NATIVE, SMALL)
        direct_message(page, {'index': index, 'requestId': request_id}, 'fixture-resume')
        failed = wait_message(page, index, 'error')
        assert failed['code'] == code and failed['cleanupComplete'] is True, failed
        assert not any(m['type'] == 'ready' for m in worker_messages(page, index))
        page.wait_for_function('!SentlogOriginalPhotoExport.busy')
        assert page.evaluate(READ_NATIVE, SMALL) == injected
        report['sourceFailures'].append({'mode': mode, 'key': key, 'error': failed, 'cleanup': wait_clean(page)})
        page.evaluate(MUTATE_NATIVE, {'key': key, 'mode': 'restore'})
        page.locator('#slOriginalExportClose').click()
        route_state['mode'] = 'normal'
        save_json(report_path, report)

    report['stage'] = 'worker-lease-ready-crash'
    metadata = page.evaluate('SentlogOriginalPhotos.listMeta()')
    small_rows = [m for m in metadata if m['projectId'] == SMALL]
    first_rows = small_rows[:3]
    first_keys = {m['key'] for m in first_rows}
    first_expected = [row for row in small if row['key'] in first_keys]
    # Keep the first worker alive after ready: its returned File must remain
    # readable and its lease must protect it from another export's cleanup.
    first = direct_start(page, origin, SMALL, first_rows)
    ready = wait_message(page, first['index'], 'ready')
    held = page.evaluate(OPFS_STATE)
    assert len(held['jobs']) == 1 and set(held['jobs'][0]['entries']) == {'archive.zip', 'ready.json'}, held
    competitor = direct_start(page, origin, SMALL, first_rows)
    busy = wait_message(page, competitor['index'], 'error')
    assert busy['code'] == 'EXPORT_BUSY', busy
    assert page.evaluate(OPFS_STATE) == held, 'a competing exporter must not delete the current output'
    direct_terminate(page, competitor)
    representative = Path(str(prefix) + '-representative.zip')
    download_worker_file(page, first, representative)
    report['readyFileContract'] = {'ready': ready, 'competitor': busy, **verify_zip(representative, first_expected)}
    direct_message(page, first, 'release')
    released = wait_message(page, first['index'], 'released')
    assert released['cleanupComplete'] is True
    direct_terminate(page, first)
    wait_clean(page)

    # A completed ZIP might still be in the browser's save flow when a worker
    # dies. A successor must preserve it until this exact staged job is named
    # in an explicit acknowledgement; a generic/wrong acknowledgement is not
    # permission to delete it.
    ready_crash = direct_start(page, origin, SMALL, first_rows)
    completed = wait_message(page, ready_crash['index'], 'ready')
    completed_state = page.evaluate(OPFS_STATE)
    assert len(completed_state['jobs']) == 1 and 'ready.json' in completed_state['jobs'][0]['entries']
    completed_job = completed_state['jobs'][0]['name']
    page.evaluate('i=>window.originalReadyCrashFile=originalExportTrace.workers[i].file', ready_crash['index'])
    direct_terminate(page, ready_crash)
    previous_exports = None
    rejected = []
    for acknowledgement in (None, ['not-the-staged-export']):
        following, failed, busy_retries = start_after_worker_exit(page, origin, SMALL, first_rows, acknowledged=acknowledgement)
        assert failed['code'] == 'PREVIOUS_EXPORT_PENDING', failed
        assert len(failed['previousExports']) == 1, failed
        previous_exports = failed['previousExports']
        assert previous_exports[0]['id'] == completed_job, failed
        assert previous_exports[0]['zipBytes'] == completed['zipBytes'], failed
        assert page.evaluate(OPFS_STATE) == completed_state
        rejected.append({'acknowledged': acknowledgement, 'error': failed, 'nativeLeaseReleaseWaits': busy_retries})
        direct_terminate(page, following)
    retained = directory / 'retained-after-ready-crash.zip'
    download_retained_ready_file(page, retained)
    retained_proof = verify_zip(retained, first_expected)
    retained.unlink()
    open_ui(page, SMALL)
    pending_index = begin_ui(page)
    pending_error = wait_message(page, pending_index, 'error')
    assert pending_error['code'] == 'PREVIOUS_EXPORT_PENDING'
    page.wait_for_function('!SentlogOriginalPhotoExport.busy')
    expect(page.locator('#slOriginalExportPrevious')).to_be_visible()
    expect(page.locator('#slOriginalExportPrevious')).to_contain_text('worker-contract.zip')
    assert page.evaluate(OPFS_STATE) == completed_state
    previous_count = page.evaluate('originalExportTrace.workers.length')
    page.locator('#slOriginalExportAcknowledgePrevious').click()
    acknowledged_index = latest_worker(page, previous_count)
    acknowledged_ready = wait_message(page, acknowledged_index, 'ready')
    sent = page.evaluate('i=>originalExportTrace.workers[i].starts[0]', acknowledged_index)
    assert sent['acknowledgedPreviousExports'] == [previous_exports[0]['id']], sent
    acknowledged_state = page.evaluate(OPFS_STATE)
    assert len(acknowledged_state['jobs']) == 1 and acknowledged_state['jobs'][0]['name'] != completed_job
    acknowledged_zip = directory / 'acknowledged-previous.zip'
    download_ui(page, acknowledged_zip)
    acknowledged_proof = verify_zip(acknowledged_zip, small)
    acknowledged_zip.unlink()
    report['readyCrashRecovery'] = {'completed': completed, 'rejected': rejected, 'retainedZip': retained_proof,
                                     'acknowledgedIds': [previous_exports[0]['id']], 'successorReady': acknowledged_ready,
                                     'explicitUiAcknowledgement': sent, 'newZip': acknowledged_proof}
    close_ui(page, acknowledged_index, discard=True)

    crashed = direct_start(page, origin, SMALL, small_rows, 'pause')
    wait_message(page, crashed['index'], 'fixture-paused')
    residue = page.evaluate(OPFS_STATE)
    assert len(residue['jobs']) == 1
    direct_terminate(page, crashed)  # genuine worker termination; no cancel/release hook
    assert page.evaluate(OPFS_STATE)['jobs'] == residue['jobs'], 'crash fixture must actually leave a temp file'
    successor, next_ready, busy_retries = start_after_worker_exit(page, origin, SMALL, first_rows)
    assert next_ready['type'] == 'ready', next_ready
    recovered = page.evaluate(OPFS_STATE)
    assert len(recovered['jobs']) == 1 and recovered['jobs'][0]['name'] != residue['jobs'][0]['name'], recovered
    second_zip = directory / 'crash-recovery.zip'
    download_worker_file(page, successor, second_zip)
    report['crashRecovery'] = {'residue': residue, 'recovered': recovered, 'ready': next_ready, 'nativeLeaseReleaseWaits': busy_retries,
                               **verify_zip(second_zip, first_expected)}
    second_zip.unlink()
    direct_message(page, successor, 'release')
    assert wait_message(page, successor['index'], 'released')['cleanupComplete'] is True
    direct_terminate(page, successor)
    wait_clean(page)
    save_json(report_path, report)

    # A fresh real UI run succeeds after all failures. Only this explicit
    # confirmation may update exportedAt/packageName, and only for its project.
    report['stage'] = 'recovery-and-explicit-confirmation'
    open_settings_ui(page, SMALL)
    index = begin_ui(page)
    wait_message(page, index, 'ready')
    path = directory / 'after-failures.zip'
    name = download_ui(page, path)
    report['afterFailures'] = {'fileName': name, **verify_zip(path, small)}
    page.locator('#slOriginalExportConfirm').click()
    page.wait_for_function("SentlogOriginalPhotoExport.state.phase==='confirmed'")
    assert page.evaluate('SentlogOriginalPhotoExport.busy') is True, 'the ready File remains leased until explicit close'
    close_ui(page, index)
    page.locator('#sentlogSettingsClose').click()
    expect(page.locator('#sentlogSettingsModal')).to_have_attribute('aria-hidden', 'true')
    path.unlink()
    report['sourceAfter'] = page.evaluate(READ_NATIVE, None)
    check_native(report['sourceAfter'], expected)
    after_meta = {entry['key']: entry['meta'] for entry in report['sourceAfter']['entries']}
    for row in expected:
        before, after = before_meta[row['key']], after_meta[row['key']]
        if row['projectId'] == SMALL:
            assert after['exportedAt'] and after['packageName'] == name, after
            assert {k: v for k, v in after.items() if k not in ('exportedAt', 'packageName')} == {
                k: v for k, v in before.items() if k not in ('exportedAt', 'packageName')}
        else:
            assert after == before, row['key']
    assert page.evaluate('SentlogRecords.keys().sort().map(key=>[key,SentlogRecords.getItem(key)])') == records_before
    report['finalCleanup'] = wait_clean(page)
    report['workerTrace'] = page.evaluate('originalExportTrace.snapshot()')
    assert all(row['terminated'] for row in report['workerTrace']['workers']), report['workerTrace']
    report['confirmation'] = {'projectId': SMALL, 'markedRows': SMALL_COUNT, 'otherProjectRowsUnchanged': len(expected) - SMALL_COUNT,
                              'allOriginalBytesUnchanged': True, 'sharedRecordsUnchanged': True}
    print('PASS native worker/OPFS cancel, write failures, source races, ready-file lease, crash cleanup, explicit confirmation', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if os.environ.get('SITES_MANAGED_LINUX_CONTAINER') == '1' and os.environ.get('GITHUB_ACTIONS') != 'true':
        raise SystemExit('Browser/server execution is restricted to GitHub Actions; use py_compile locally.')
    report_path = args.report or Path(f'/tmp/sentlog-heavy-originals-{args.engine}.json')
    root = args.built_root.resolve()
    report = {'engine': args.engine, 'status': 'running', 'stage': 'boot', 'downloadEvents': 0,
              'hostPlatform': {'sys': sys.platform, 'system': platform.system(),
                               'release': platform.release(), 'machine': platform.machine()},
              'workload': {'largeOriginals': BIG_COUNT, 'largeOriginalBytes': BIG_COUNT * BIG_SIZE,
                           'largeDrawings': 4, 'alreadyExportedLargeOriginals': 80},
              'storage': 'native IndexedDB originals, native Worker, native OPFS, actual browser downloads',
              'faultModel': 'injected failures/delays only at native OPFS write and Blob chunk read boundaries',
              'crashModel': 'Worker.terminate while real temporary output and exclusive lease are open'}
    # Native OPFS coverage runs on macOS WebKit, whose Cocoa defaults enable
    # these APIs. Keep Linux-only preferences available for diagnostics, but
    # require the real I/O probe too: an exposed API does not establish backend
    # support. Never pass MiniBrowser's Linux arguments to the Cocoa browser.
    native_features = ['--features=StorageAPI,StorageAPIEstimate,FileSystem,AccessHandle'] if args.engine == 'webkit' and sys.platform == 'linux' else []
    report['nativeFeatureArguments'] = native_features
    save_json(report_path, report)

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *unused):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    route_state = {'mode': 'normal'}
    page = None
    errors, blocked, requests = [], [], []
    try:
        fixture = fixture_catalog()
        with tempfile.TemporaryDirectory(prefix='sentlog-onezip-browser-') as temporary, sync_playwright() as playwright:
            directory = Path(temporary)
            context = getattr(playwright, args.engine).launch_persistent_context(
                str(directory / 'profile'), headless=True, viewport={'width': 390, 'height': 844},
                has_touch=True, is_mobile=True, device_scale_factor=2, accept_downloads=True, service_workers='block',
                timezone_id='UTC', args=native_features)

            def route(request):
                url = request.request.url
                parsed = urlparse(url)
                if url.startswith(origin + '/'):
                    if parsed.path == '/fixtures/original-export-lock.html':
                        request.fulfill(content_type='text/html', body='<!doctype html><meta charset="utf-8"><title>Independent source lease probe</title><script src="/sentlog/original-photo-store.js"></script>')
                        return
                    if parsed.path.endswith('/original-photo-export-worker.js'):
                        query = parse_qs(parsed.query)
                        if query.get('fixture_source') == ['1']:
                            request.fulfill(content_type='text/javascript', body=(root / 'sentlog/original-photo-export-worker.js').read_bytes())
                            return
                        mode = query.get('fixture_mode', [route_state['mode']])[0]
                        source = origin + '/sentlog/original-photo-export-worker.js?' + urlencode({'fixture_source': '1'})
                        body = WORKER_BOUNDARY.replace('__MODE__', json.dumps(mode)).replace('__SOURCE__', json.dumps(source))
                        requests.append({'url': url, 'mode': mode})
                        request.fulfill(content_type='text/javascript', body=body)
                        return
                    request.continue_()
                elif url.startswith(('blob:', 'data:')):
                    request.continue_()
                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    name = 'export-pdf.worker.min.js' if 'worker' in url else 'export-pdf.min.js'
                    request.fulfill(content_type='text/javascript', body=(root / 'sentlog/vendor' / name).read_bytes())
                else:
                    blocked.append(url.split('?')[0])
                    request.abort()

            context.route('**/*', route)
            context.add_init_script(TRACE)
            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(45000)
            page.on('pageerror', lambda error: errors.append(str(error)))

            def downloaded(_):
                report['downloadEvents'] += 1

            page.on('download', downloaded)
            try:
                page.goto(origin + '/sentlog/', wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogAppReady&&window.SentlogOriginalPhotos&&window.SentlogOriginalPhotoExport', timeout=60000)
                page.evaluate('sentlogAppReady')
                report['nativeEnvironment'] = page.evaluate(NATIVE_ENVIRONMENT)
                report['capabilities'] = page.evaluate("""()=>({worker:typeof Worker==='function',
                  opfs:typeof navigator.storage?.getDirectory==='function',nativeIndexedDB:!!indexedDB,
                  exportButton:!!document.getElementById('slOriginalPhotoExportBtn')})""")
                report['capabilities']['workerOpfs'] = report['nativeEnvironment']['worker']['getDirectoryType'] == 'function'
                report['capabilities']['workerSyncAccessHandle'] = report['nativeEnvironment']['worker']['syncAccessHandleType'] == 'function'
                native_io = report['nativeEnvironment']['worker']['syncAccessHandleProbe']
                report['capabilities']['nativeOpfsRoundTrip'] = native_io['ok'] is True and native_io['cleanupComplete'] is True
                report['capabilities']['sourceLease'] = report['nativeEnvironment']['main']['locksType'] == 'function'
                assert all(report['capabilities'].values()), report['capabilities']
                run(page, context, origin, route_state, fixture, report, report_path, directory)
                assert not errors, errors
                report.update(status='passed', stage='complete', browserErrors=errors, blockedExternalRequests=blocked, workerRequests=requests)
                save_json(report_path, report)
                print('PASS ' + args.engine + ': one complete original-project ZIP without count/size splitting', flush=True)
            except Exception as error:
                # Capture while the real page/browser is still alive. Exiting
                # sync_playwright first would destroy the failure evidence.
                report.update(browserErrors=errors, blockedExternalRequests=blocked, workerRequests=requests)
                capture_failure(page, report, report_path, error)
                raise
            finally:
                context.close()
    except Exception as error:
        report.update(status='failed', error=str(error), browserErrors=errors, blockedExternalRequests=blocked, workerRequests=requests)
        save_json(report_path, report)
        raise
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()

/* Dedicated worker: read originals, stage one ZIP in OPFS, retain it until release. */
'use strict';
{
  const dependency=new URL('original-photo-zip.js',self.location.href);
  dependency.search=new URL(self.location.href).search;importScripts(dependency.href);
}
(function(){
  'use strict';
  const DB='sentlog-original-photos-v1',PHOTOS='photos',META='meta';
  const NAMESPACE='sentlog-original-photo-exports-v1',LEASE='lease',READY='ready.json';
  const IDENTITY=['key','drawingId','photoId','projectId','projectName','drawingName','shapeId','shapeLabel','exportName','originalName','type','size','lastModified','createdAt','storedAt','originalRevision'];
  const zip=self.SentlogOriginalPhotoZip;let active=null;
  function fault(code,message){const e=new Error(message);e.code=code;return e;}
  function post(job,type,values={}){self.postMessage({type,requestId:job.requestId,...values});}
  function checked(job){if(job.abort.signal.aborted)throw job.abort.signal.reason||fault('EXPORT_CANCELLED','書き出しをキャンセルしました');}
  function normalized(value){return value===undefined||value===null?null:value;}
  function validateMeta(actual,expected){
    if(!actual)throw fault('SOURCE_MISSING','対象の原本写真が見つかりません。もう一度一覧を確認してください。');
    for(const field of IDENTITY)if(normalized(actual[field])!==normalized(expected[field]))throw fault('SOURCE_CHANGED','書き出し中に原本写真の情報が変わりました。もう一度書き出してください。');
  }
  function validateInput(message){
    if(typeof message.projectId!=='string'||!message.projectId||!Array.isArray(message.rows)||!message.rows.length)throw fault('EXPORT_TARGET','書き出す案件と原本写真を選んでください。');
    const keys=new Set();let totalBytes=0;
    for(const row of message.rows){
      if(!row||typeof row.key!=='string'||!row.key||typeof row.drawingId!=='string'||!row.drawingId||typeof row.photoId!=='string'||!row.photoId||row.key!==row.drawingId+':'+row.photoId||row.projectId!==message.projectId||!Number.isSafeInteger(row.size)||row.size<0||!Number.isFinite(row.storedAt)||row.storedAt<0||keys.has(row.key))throw fault('EXPORT_TARGET','書き出す原本写真の情報を確認できません。もう一度一覧を開いてください。');
      totalBytes+=row.size;if(!Number.isSafeInteger(totalBytes))throw fault('ZIP_LIMIT','原本写真の合計容量が書き出し可能な範囲を超えています。');keys.add(row.key);
    }
    return totalBytes;
  }
  function openSource(){
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB);let absent=false,settled=false;
      // Never create or migrate the originals database from an export worker.
      request.onupgradeneeded=()=>{absent=true;request.transaction.abort();};
      request.onerror=()=>{if(settled)return;settled=true;reject(fault(absent?'SOURCE_MISSING':'SOURCE_READ_FAILED',absent?'この端末に原本写真がありません。':'原本写真の保存領域を開けませんでした。'));};
      request.onblocked=()=>{if(settled)return;settled=true;reject(fault('SOURCE_READ_FAILED','別の画面が原本写真の保存領域を変更中です。'));};
      request.onsuccess=()=>{const db=request.result;if(settled){db.close();return;}settled=true;if(!db.objectStoreNames.contains(PHOTOS)||!db.objectStoreNames.contains(META)){db.close();reject(fault('SOURCE_MISSING','この端末の原本写真を確認できません。'));return;}resolve(db);};
    });
  }
  function readOriginal(job,expected){
    checked(job);
    return new Promise((resolve,reject)=>{
      let actual,blob;
      const tx=job.db.transaction([META,PHOTOS],'readonly'),meta=tx.objectStore(META).get(expected.key),photo=tx.objectStore(PHOTOS).get(expected.key);
      meta.onsuccess=()=>{actual=meta.result;};photo.onsuccess=()=>{blob=photo.result;};
      tx.onabort=()=>reject(fault('SOURCE_READ_FAILED','原本写真を読み取れませんでした。'));tx.onerror=()=>{};
      tx.oncomplete=()=>{try{checked(job);validateMeta(actual,expected);if(!(blob instanceof Blob))throw fault('SOURCE_MISSING','対象の原本写真のデータが見つかりません。');if(blob.size!==expected.size)throw fault('SOURCE_CHANGED','原本写真の容量が変わりました。もう一度書き出してください。');resolve(blob);}catch(e){reject(e);}};
    });
  }
  function validateFinalSnapshot(job){
    checked(job);
    return new Promise((resolve,reject)=>{
      const tx=job.db.transaction(META,'readonly'),store=tx.objectStore(META);let mismatch=null;
      const abort=()=>{try{tx.abort();}catch(_){}};job.abort.signal.addEventListener('abort',abort,{once:true});
      for(const expected of job.rows){const request=store.get(expected.key);request.onsuccess=()=>{try{validateMeta(request.result,expected);}catch(e){mismatch=mismatch||e;}};}
      tx.onabort=()=>{job.abort.signal.removeEventListener('abort',abort);reject(job.abort.signal.reason||fault('SOURCE_READ_FAILED','原本写真の最終確認が中断されました。'));};tx.onerror=()=>{};
      tx.oncomplete=()=>{job.abort.signal.removeEventListener('abort',abort);try{checked(job);if(mismatch)throw mismatch;resolve();}catch(e){reject(e);}};
    });
  }
  async function previousReady(directory,id){
    let handle;
    try{handle=await directory.getFileHandle(READY);}catch(e){if(e?.name==='NotFoundError')return null;throw e;}
    // Existence alone protects the ZIP: a crash while writing the marker must
    // never turn a potentially downloadable file into an automatic cleanup.
    const previous={id,fileName:'前回の原本写真ZIP',createdAt:null,zipBytes:null};
    try{
      const file=await handle.getFile();if(file.size>8192)return previous;
      const value=JSON.parse(await file.text());
      if(typeof value.fileName==='string')previous.fileName=zip.safeSegment(value.fileName);
      if(Number.isFinite(value.createdAt))previous.createdAt=value.createdAt;
      if(Number.isSafeInteger(value.zipBytes)&&value.zipBytes>=0)previous.zipBytes=value.zipBytes;
    }catch(_){}
    return previous;
  }
  async function cleanPrevious(job){
    const entries=[];for await(const [name,handle] of job.namespace.entries())if(name.startsWith('job-'))entries.push({name,handle});
    const completed=[];
    for(const {name,handle} of entries){
      checked(job);const previous=handle.kind==='directory'?await previousReady(handle,name):null;
      if(previous)completed.push(previous);else await job.namespace.removeEntry(name,{recursive:true});
    }
    const pending=completed.filter(previous=>!job.acknowledgedPreviousExports.has(previous.id));
    if(pending.length){
      const e=fault('PREVIOUS_EXPORT_PENDING','前回のZIPが残っています。保存が完了したか、中止したことを確認してから続けてください。');
      e.previousExports=completed;throw e;
    }
    // Acknowledgements name exactly the inspected jobs. A newer download left
    // by another page can never be removed by an older confirmation.
    for(const previous of completed){checked(job);await job.namespace.removeEntry(previous.id,{recursive:true});}
  }
  async function takeLease(job){
    if(!navigator.storage?.getDirectory)throw fault('OPFS_UNAVAILABLE','このブラウザでは一括ZIPの一時保存を利用できません。');
    const root=await navigator.storage.getDirectory();checked(job);
    job.namespace=await root.getDirectoryHandle(NAMESPACE,{create:true});
    const file=await job.namespace.getFileHandle(LEASE,{create:true});checked(job);
    if(typeof file.createSyncAccessHandle!=='function')throw fault('OPFS_UNAVAILABLE','このブラウザでは一括ZIPの一時保存を利用できません。');
    try{job.lease=await file.createSyncAccessHandle();}
    catch(e){if(e?.name==='NoModificationAllowedError'||e?.name==='InvalidStateError')throw fault('EXPORT_BUSY','別の画面で原本写真を書き出しています。そちらを閉じてから、もう一度お試しください。');throw e;}
    checked(job);
    // The lease protects active exports; persistent ready markers also protect
    // native downloads that can outlive their page/worker after a crash.
    await cleanPrevious(job);
    let estimate=null;
    try{if(navigator.storage.estimate)estimate=await navigator.storage.estimate();}catch(_){}
    checked(job);
    if(Number.isFinite(estimate?.quota)&&Number.isFinite(estimate?.usage)&&estimate.quota>=0&&estimate.usage>=0&&estimate.quota-estimate.usage<job.totalBytes)throw fault('STORAGE_FULL','一括ZIPを作るための空き容量が足りません。原本写真は変更していません。');
  }
  function progress(job,phase,force=false){
    const now=Date.now();if(!force&&now-job.lastProgress<100)return;job.lastProgress=now;
    post(job,'progress',{phase,doneFiles:job.doneFiles,totalFiles:job.rows.length,doneBytes:job.doneBytes,totalBytes:job.totalBytes});
  }
  async function writeChunk(job,bytes){
    checked(job);let cursor=0;
    while(cursor<bytes.length){
      checked(job);const written=await job.output.write(bytes.subarray(cursor),{at:job.position});
      if(!Number.isInteger(written)||written<=0||written>bytes.length-cursor)throw fault('ZIP_WRITE_INCOMPLETE','ZIPを一時保存領域へ書き込めませんでした。');
      cursor+=written;job.position+=written;
      if(!Number.isSafeInteger(job.position))throw fault('ZIP_LIMIT','ZIPの容量が保存可能な範囲を超えています。');
    }
    return bytes.length;
  }
  async function retainCompleted(job,directory,zipBytes){
    const handle=await directory.getFileHandle(READY,{create:true});job.marker=await handle.createSyncAccessHandle();await job.marker.truncate(0);
    const bytes=new TextEncoder().encode(JSON.stringify({version:1,state:'ready',id:job.directoryName,fileName:job.fileName,createdAt:Date.now(),zipBytes}));let offset=0;
    while(offset<bytes.length){
      checked(job);const written=await job.marker.write(bytes.subarray(offset),{at:offset});
      if(!Number.isInteger(written)||written<=0||written>bytes.length-offset)throw fault('ZIP_WRITE_INCOMPLETE','ZIPの保存準備を記録できませんでした。');offset+=written;
    }
    await job.marker.flush();await job.marker.close();job.marker=null;checked(job);
  }
  async function cleanup(job){
    if(job.cleanupPromise)return job.cleanupPromise;
    job.cleanupPromise=(async()=>{
      let problem=null;
      if(job.db){job.db.close();job.db=null;}
      if(job.output){try{await job.output.close();}catch(e){problem=e;}job.output=null;}
      if(job.marker){try{await job.marker.close();}catch(e){problem=problem||e;}job.marker=null;}
      job.file=null;
      if(job.directoryName&&job.namespace&&job.lease){try{await job.namespace.removeEntry(job.directoryName,{recursive:true});}catch(e){if(e?.name!=='NotFoundError')problem=problem||e;}}
      if(job.lease){try{await job.lease.close();}catch(e){problem=problem||e;}job.lease=null;}
      if(active===job)active=null;
      if(problem)throw fault('TEMP_CLEANUP_FAILED','一時ZIPの後片付けを完了できませんでした。原本写真は変更していません。');
    })();
    return job.cleanupPromise;
  }
  function failure(error){
    if(error?.name==='QuotaExceededError')return {code:'STORAGE_FULL',message:'一括ZIPを作るための空き容量が足りません。原本写真は変更していません。'};
    return {code:typeof error?.code==='string'?error.code:'EXPORT_FAILED',message:typeof error?.code==='string'?error.message:'一括ZIPを作成できませんでした。原本写真は変更していません。',...(Array.isArray(error?.previousExports)?{previousExports:error.previousExports}:{})};
  }
  async function terminate(job,type,error){
    job.state='releasing';let cleanupComplete=true;
    try{await cleanup(job);}catch(e){cleanupComplete=false;error=error||e;}
    if(error){post(job,'error',{...failure(error),cleanupComplete});return;}
    post(job,type,{cleanupComplete});
  }
  async function start(message){
    const requestId=typeof message.requestId==='string'?message.requestId:'';
    if(active){post({requestId},'error',{code:'EXPORT_BUSY',message:'原本写真の書き出しがすでに進行中です。'});return;}
    const acknowledged=Array.isArray(message.acknowledgedPreviousExports)?message.acknowledgedPreviousExports.filter(id=>typeof id==='string'&&/^job-[a-f0-9-]{36}$/i.test(id)):[];
    const job={requestId,rows:message.rows,acknowledgedPreviousExports:new Set(acknowledged),abort:new AbortController(),state:'preparing',doneFiles:0,doneBytes:0,totalBytes:0,lastProgress:0,position:0};active=job;
    try{
      if(!requestId)throw fault('EXPORT_TARGET','書き出し操作を確認できません。');
      job.totalBytes=validateInput(message);
      job.fileName=zip.safeSegment(message.fileName||'セントログ_原本写真.zip');if(!/\.zip$/i.test(job.fileName))job.fileName+='.zip';
      progress(job,'preparing',true);await takeLease(job);checked(job);
      job.directoryName='job-'+crypto.randomUUID();const directory=await job.namespace.getDirectoryHandle(job.directoryName,{create:true});checked(job);
      const fileHandle=await directory.getFileHandle('archive.zip',{create:true});job.output=await fileHandle.createSyncAccessHandle();await job.output.truncate(0);checked(job);
      job.db=await openSource();job.db.onversionchange=()=>{job.abort.abort(fault('SOURCE_CHANGED','原本写真の保存領域が変更されました。もう一度書き出してください。'));job.db?.close();};
      const writer=zip.createWriter({signal:job.abort.signal,write:bytes=>writeChunk(job,bytes),onProgress:info=>{job.doneBytes=Number(info.originalBytes);progress(job,'writing');}});
      job.state='writing';
      for(const expected of job.rows){
        checked(job);const blob=await readOriginal(job,expected);await writer.add({path:zip.pathForOriginal(expected),blob,modifiedAt:expected.lastModified??expected.createdAt});
        job.doneFiles++;progress(job,'writing',true);
      }
      progress(job,'finalizing',true);const result=await writer.close();checked(job);
      await job.output.flush();await job.output.close();job.output=null;checked(job);
      const file=await fileHandle.getFile();checked(job);
      if(file.size!==job.position||BigInt(file.size)!==result.byteLength)throw fault('ZIP_WRITE_INCOMPLETE','ZIPを最後まで一時保存できませんでした。');
      await retainCompleted(job,directory,file.size);await validateFinalSnapshot(job);checked(job);
      job.db.close();job.db=null;job.file=new File([file],job.fileName,{type:'application/zip',lastModified:Date.now()});job.state='ready';
      post(job,'ready',{file:job.file,fileName:job.fileName,entryCount:result.entryCount,originalBytes:Number(result.originalBytes),zipBytes:file.size,zip64:result.zip64});
      // Keep the OPFS file and lease alive until the main thread releases them.
    }catch(e){await terminate(job,e?.code==='EXPORT_CANCELLED'?'cancelled':'error',e?.code==='EXPORT_CANCELLED'?null:e);}
  }
  self.onmessage=event=>{
    const message=event.data||{};
    if(message.type==='start'){void start(message);return;}
    const job=active;if(!job||message.requestId!==job.requestId)return;
    if(message.type==='cancel'){
      if(job.state==='releasing')return;job.abort.abort(fault('EXPORT_CANCELLED','書き出しをキャンセルしました'));
      if(job.state==='ready')void terminate(job,'cancelled');
    }else if(message.type==='release'){
      if(job.state==='ready')void terminate(job,'released');
      else if(job.state!=='releasing')job.abort.abort(fault('EXPORT_CANCELLED','書き出しをキャンセルしました'));
    }
  };
})();

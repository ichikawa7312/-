/* One versioned, reread-and-verified project backup per archive request.
 * Existing nonempty files are immutable, including interrupted partial files. */
(function(){
  'use strict';
  const C=window.SentlogArchiveCore;
  let running=false,lastNotice='',tokenFlight=null;
  const oldEnsure=ensureSession;
  ensureSession=function(){if(!tokenFlight)tokenFlight=Promise.resolve().then(()=>oldEnsure()).finally(()=>{tokenFlight=null;});return tokenFlight;};
  const status=document.createElement('section');status.className='card';
  const heading=document.createElement('h2');heading.textContent='保管前の案件一式バックアップ';
  const label=document.createElement('p');label.className='muted';label.textContent='アプリで保管の確認を始めると、最新の記録・PDF・写真を復旧用の別フォルダへ保存し、内容を読み直して照合します。元のファイルは削除しません。';
  const result=document.createElement('p');result.setAttribute('role','status');
  const check=document.createElement('button');check.type='button';check.textContent='保管の確認を実行';
  status.append(heading,label,result,check);document.querySelector('main').prepend(status);
  const say=text=>{if(lastNotice!==text){lastNotice=text;result.textContent=text;}};
  const rpc=async(action,project=null,data={})=>rest('/rest/v1/rpc/sentlog_archive_v1',{method:'POST',body:JSON.stringify({p_action:action,p_project_id:project,p_device_id:await ensureDevice(),p_data:data})});
  async function readRelative(path){const parts=C.receiptParts(path,rootHandle.name);let dir=rootHandle;for(const p of parts.slice(0,-1))dir=await dir.getDirectoryHandle(p);return (await dir.getFileHandle(parts.at(-1))).getFile();}
  async function source(f){
    if(f.pc_path){try{const blob=await readRelative(f.pc_path);if(await C.matches(blob,f))return blob;}catch{}}
    // The main app on this PC may also hold a verified copy in IndexedDB.
    try{const connection=await new Promise((resolve,reject)=>{const q=indexedDB.open('surveyFieldNoteDB');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      try{if(connection.objectStoreNames.contains('files')){const blob=await new Promise((resolve,reject)=>{const q=connection.transaction('files').objectStore('files').get(f.key);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});if(await C.matches(blob,f))return blob;}}finally{connection.close();}
    }catch{}
    if(f.status!=='storage_deleted'){
      const parts=String(f.storage_path).split('/').map(encodeURIComponent).join('/');
      const c=new AbortController(),timeout=setTimeout(()=>c.abort(),120000);
      try{const response=await fetch(SUPABASE_URL+'/storage/v1/object/authenticated/'+BUCKET+'/'+parts,{headers:authHeaders(),signal:c.signal,cache:'no-store'});
        if(response.ok){const blob=await response.blob();if(await C.matches(blob,f))return blob;}
      }finally{clearTimeout(timeout);}
    }
    throw Error('必要なファイルが見つからないか、内容が異なります：'+f.file_name+'。端末のデータは消していません。');
  }
  const collision=name=>Object.assign(Error('PCの保管先に内容が異なるファイルがあります。既存の内容は変更しません：'+name),{code:'PC_ARCHIVE_COLLISION'});
  async function existingFile(directory,name){
    try{const handle=await directory.getFileHandle(name);return {handle,file:await handle.getFile()};}
    catch(e){if(e?.name==='NotFoundError')return null;throw e;}
  }
  async function preserveFile(directory,name,matches,loadVerified,label){
    const previous=await existingFile(directory,name);
    if(previous&&await matches(previous.file))return previous;
    if(previous?.file.size>0)throw collision(label);
    // source() has already checked the registered hash and size. Do not create
    // a destination until those bytes are available. Empty placeholders can retry.
    const blob=await loadVerified(),handle=await directory.getFileHandle(name,{create:true});
    const current=await handle.getFile();
    if(await matches(current))return {handle,file:current};
    if(current.size>0)throw collision(label);
    let writer;
    try{
      writer=await handle.createWritable({keepExistingData:false,mode:'exclusive'});
      // Another writer may have committed after the preflight read but before
      // exclusive acquisition. Opening only creates a temporary stream; abort
      // it without write/close if the current file is now occupied.
      const locked=await handle.getFile();
      if(await matches(locked)){await writer.abort();writer=null;return {handle,file:locked};}
      if(locked.size>0)throw collision(label);
      await writer.write(blob);await writer.close();writer=null;
    }
    catch(e){if(writer)try{await writer.abort();}catch{}throw e;}
    const file=await handle.getFile();
    if(!await matches(file))throw Error('PCへの書き込み照合に失敗しました：'+label);
    return {handle,file};
  }
  async function save(job){
    if(typeof navigator.locks?.request!=='function')throw Error('PC保管の排他制御を利用できません。EdgeまたはChromeで開いてください。');
    // Coordinate with the regular PC backup and other archive tabs. A filename
    // collision still fails closed; the lock is not permission to replace bytes.
    const completed=await navigator.locks.request('sentlog-pc-safe-backup-v2',{mode:'exclusive'},()=>saveLocked(job));
    // Network acknowledgement must not retain the filesystem lock and stall
    // unrelated normal PC saves while the server response is pending.
    await rpc('pc_complete',job.project_id,completed.receipt);
    return completed.message;
  }
  async function saveLocked(job){
    if(!rootHandle||await rootHandle.queryPermission({mode:'readwrite'})!=='granted')throw Error('以前のセントログ保管フォルダを選び、「保存許可を確認」を押してください。');
    let dir=await rootHandle.getDirectoryHandle('復旧用',{create:true});
    dir=await dir.getDirectoryHandle(job.project_id,{create:true});dir=await dir.getDirectoryHandle(job.id,{create:true});
    const paths=Object.fromEntries(job.manifest.map(f=>[f.key,'files/'+f.id]));
    const pack=C.backupPack(job,paths);C.validatePack(pack,job);
    const text=JSON.stringify(pack),previousManifest=await existingFile(dir,'manifest.sentlog.json');
    if(previousManifest?.file.size>0&&await previousManifest.file.text()!==text)throw collision('manifest.sentlog.json');
    const folder=await dir.getDirectoryHandle('files',{create:true});
    for(const f of job.manifest){
      await preserveFile(folder,f.id,blob=>C.matches(blob,f),()=>source(f),f.file_name);
    }
    const manifest=await preserveFile(dir,'manifest.sentlog.json',async blob=>await blob.text()===text,async()=>new Blob([text],{type:'application/json'}),'manifest.sentlog.json');
    // Recheck actual files, not an earlier database receipt, on every checkpoint.
    for(const f of job.manifest)if(!await C.matches(await (await folder.getFileHandle(f.id)).getFile(),f))throw Error('確認中にPCのファイルが変更されました：'+f.file_name);
    const saved=await manifest.handle.getFile();
    if(await saved.text()!==text)throw Error('確認中にPCのmanifestが変更されました。既存の内容は変更しません。');
    C.validatePack(JSON.parse(await saved.text()),job);
    return {receipt:{job_id:job.id,catalog_hash:job.catalog_hash,
      file_count:job.manifest.length,package_sha256:await C.hash(saved),path:[rootHandle.name,'復旧用',job.project_id,job.id,'manifest.sentlog.json'].join('\\')},
      message:job.payload.project.name+'：案件一式をPCに保存・内容照合済み（'+job.manifest.length+'ファイル）。アプリで保管を確定してください。'};
  }
  async function run(){
    if(running||!navigator.onLine||document.hidden||!session?.user)return;
    running=true;check.disabled=true;
    try{await ensureSession();const jobs=await rpc('pc_jobs');if(!jobs.length){say('保管の確認依頼はありません。');return;}
      const messages=[];
      for(const job of jobs){try{messages.push(await save(job));}catch(e){messages.push(e.message);await rpc('pc_error',job.project_id,{job_id:job.id,reason:e.message}).catch(()=>{});}}
      say(messages.join('\n'));
    }catch(e){say('保管を確認できません：'+e.message);}finally{running=false;check.disabled=false;}
  }
  check.onclick=run;setTimeout(run,3000);setInterval(run,15000);
  window.addEventListener('online',run);document.addEventListener('visibilitychange',()=>{if(!document.hidden)run();});
})();

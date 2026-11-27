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
  const rpc=async(action,project=null,data={},validate=null)=>{const device=await ensureDevice();validate?.();return rest('/rest/v1/rpc/sentlog_archive_v1',{method:'POST',body:JSON.stringify({p_action:action,p_project_id:project,p_device_id:device,p_data:data})},validate);};
  function captureRoot(){
    const root=rootHandle,name=root?.name;
    return {root,name,check(){if(rootHandle!==root)throw Object.assign(Error('確認中にPCの保存先が変更されました。作成済みのコピーは元の保存先に残し、保管の完了通知を中止しました。'),{code:'PC_ARCHIVE_ROOT_CHANGED'});}};
  }
  async function fromRoot(target,operation){
    target.check();
    try{const value=await operation();target.check();return value;}catch(error){target.check();throw error;}
  }
  async function readRelative(path,target){
    target.check();const parts=C.receiptParts(path,target.name);let dir=target.root;
    for(const p of parts.slice(0,-1))dir=await fromRoot(target,()=>dir.getDirectoryHandle(p));
    const file=await fromRoot(target,()=>dir.getFileHandle(parts.at(-1)));
    return fromRoot(target,()=>file.getFile());
  }
  function openExistingRecords(target){
    target.check();
    return new Promise((resolve,reject)=>{
      let settled=false,upgrade=false;
      const fail=error=>{if(!settled){settled=true;reject(error);}};
      const q=indexedDB.open('surveyFieldNoteDB');
      // This is only a source lookup. An absent database must stay absent,
      // including when it disappears immediately before this open request.
      q.onupgradeneeded=()=>{upgrade=true;try{q.transaction.abort();}catch(error){fail(error);}};
      q.onerror=()=>fail(q.error||Error('端末内の保存先を読み取れません。'));
      q.onblocked=()=>fail(Error('端末内の保存先を別の画面が変更中です。'));
      q.onsuccess=()=>{
        const db=q.result;
        // A blocked request can still succeed after the lookup has fallen
        // back to Storage. Never leak that late connection or use its rows.
        if(settled||upgrade){db.close();if(!settled)fail(Error('端末内の保存先は作成しません。'));return;}
        try{target.check();}catch(error){db.close();fail(error);return;}
        db.onversionchange=()=>db.close();settled=true;resolve(db);
      };
    });
  }
  async function source(f,target){
    target.check();
    if(f.pc_path){try{const blob=await fromRoot(target,()=>readRelative(f.pc_path,target));if(await fromRoot(target,()=>C.matches(blob,f)))return blob;}catch{target.check();}}
    // The main app on this PC may also hold a verified copy in IndexedDB.
    try{const connection=await openExistingRecords(target);
      // Take ownership before checking: even a stale opened connection closes.
      try{target.check();if(connection.objectStoreNames.contains('files')){const blob=await fromRoot(target,()=>new Promise((resolve,reject)=>{const q=connection.transaction('files').objectStore('files').get(f.key);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);}));if(await fromRoot(target,()=>C.matches(blob,f)))return blob;}}finally{connection.close();}
    }catch{target.check();}
    if(f.status!=='storage_deleted'){
      const parts=String(f.storage_path).split('/').map(encodeURIComponent).join('/');
      const c=new AbortController(),timeout=setTimeout(()=>c.abort(),120000);
      try{const response=await fromRoot(target,()=>fetch(SUPABASE_URL+'/storage/v1/object/authenticated/'+BUCKET+'/'+parts,{headers:authHeaders(),signal:c.signal,cache:'no-store'}));
        if(response.ok){const blob=await fromRoot(target,()=>response.blob());if(await fromRoot(target,()=>C.matches(blob,f)))return blob;}
      }finally{clearTimeout(timeout);}
    }
    throw Error('必要なファイルが見つからないか、内容が異なります：'+f.file_name+'。端末のデータは消していません。');
  }
  const collision=name=>Object.assign(Error('PCの保管先に内容が異なるファイルがあります。既存の内容は変更しません：'+name),{code:'PC_ARCHIVE_COLLISION'});
  async function existingFile(directory,name,target){
    try{const handle=await fromRoot(target,()=>directory.getFileHandle(name));return {handle,file:await fromRoot(target,()=>handle.getFile())};}
    catch(e){target.check();if(e?.name==='NotFoundError')return null;throw e;}
  }
  async function preserveFile(directory,name,matches,loadVerified,label,target){
    const previous=await fromRoot(target,()=>existingFile(directory,name,target));
    if(previous&&await fromRoot(target,()=>matches(previous.file)))return previous;
    if(previous?.file.size>0)throw collision(label);
    // source() has already checked the registered hash and size. Do not create
    // a destination until those bytes are available. Empty placeholders can retry.
    const blob=await fromRoot(target,loadVerified),handle=await fromRoot(target,()=>directory.getFileHandle(name,{create:true}));
    const current=await fromRoot(target,()=>handle.getFile());
    if(await fromRoot(target,()=>matches(current)))return {handle,file:current};
    if(current.size>0)throw collision(label);
    let writer;
    try{
      target.check();writer=await handle.createWritable({keepExistingData:false,mode:'exclusive'});target.check();
      // Another writer may have committed after the preflight read but before
      // exclusive acquisition. Opening only creates a temporary stream; abort
      // it without write/close if the current file is now occupied.
      const locked=await fromRoot(target,()=>handle.getFile());
      if(await fromRoot(target,()=>matches(locked))){await writer.abort();writer=null;target.check();return {handle,file:locked};}
      if(locked.size>0)throw collision(label);
      target.check();await writer.write(blob);target.check();await writer.close();writer=null;target.check();
    }
    // Always release an acquired stream, including after the selected root changed.
    catch(e){if(writer)try{await writer.abort();}catch{}target.check();throw e;}
    const file=await fromRoot(target,()=>handle.getFile());
    if(!await fromRoot(target,()=>matches(file)))throw Error('PCへの書き込み照合に失敗しました：'+label);
    return {handle,file};
  }
  async function save(job){
    if(rest.sentlogArchiveSendGuardVersion!==1)throw Object.assign(Error('PCの保管処理を更新する必要があります。画面を更新してから再確認してください。'),{code:'PC_ARCHIVE_SEND_GUARD_REQUIRED'});
    const target=captureRoot();
    if(typeof navigator.locks?.request!=='function')throw Error('PC保管の排他制御を利用できません。EdgeまたはChromeで開いてください。');
    // Coordinate with the regular PC backup and other archive tabs. A filename
    // collision still fails closed; the lock is not permission to replace bytes.
    const completed=await navigator.locks.request('sentlog-pc-safe-backup-v2',{mode:'exclusive'},()=>saveLocked(job,target));target.check();
    // Network acknowledgement must not retain the filesystem lock and stall
    // unrelated normal PC saves while the server response is pending.
    target.check();await rpc('pc_complete',job.project_id,completed.receipt,target.check);
    // The server has accepted the verified, fixed-root receipt. A later root
    // selection cannot retract that request or turn its success into pc_error.
    return completed.message;
  }
  async function saveLocked(job,target){
    target.check();
    if(!target.root||await fromRoot(target,()=>target.root.queryPermission({mode:'readwrite'}))!=='granted')throw Error('以前のセントログ保管フォルダを選び、「保存許可を確認」を押してください。');
    let dir=await fromRoot(target,()=>target.root.getDirectoryHandle('復旧用',{create:true}));
    dir=await fromRoot(target,()=>dir.getDirectoryHandle(job.project_id,{create:true}));dir=await fromRoot(target,()=>dir.getDirectoryHandle(job.id,{create:true}));
    const paths=Object.fromEntries(job.manifest.map(f=>[f.key,'files/'+f.id]));
    const pack=C.backupPack(job,paths);C.validatePack(pack,job);
    const text=JSON.stringify(pack),previousManifest=await fromRoot(target,()=>existingFile(dir,'manifest.sentlog.json',target));
    if(previousManifest?.file.size>0&&await fromRoot(target,()=>previousManifest.file.text())!==text)throw collision('manifest.sentlog.json');
    const folder=await fromRoot(target,()=>dir.getDirectoryHandle('files',{create:true}));
    for(const f of job.manifest){
      await fromRoot(target,()=>preserveFile(folder,f.id,blob=>C.matches(blob,f),()=>source(f,target),f.file_name,target));
    }
    const manifest=await fromRoot(target,()=>preserveFile(dir,'manifest.sentlog.json',async blob=>await fromRoot(target,()=>blob.text())===text,async()=>new Blob([text],{type:'application/json'}),'manifest.sentlog.json',target));
    // Recheck actual files, not an earlier database receipt, on every checkpoint.
    for(const f of job.manifest){
      const handle=await fromRoot(target,()=>folder.getFileHandle(f.id)),blob=await fromRoot(target,()=>handle.getFile());
      if(!await fromRoot(target,()=>C.matches(blob,f)))throw Error('確認中にPCのファイルが変更されました：'+f.file_name);
    }
    const saved=await fromRoot(target,()=>manifest.handle.getFile());
    if(await fromRoot(target,()=>saved.text())!==text)throw Error('確認中にPCのmanifestが変更されました。既存の内容は変更しません。');
    C.validatePack(JSON.parse(await fromRoot(target,()=>saved.text())),job);
    return {receipt:{job_id:job.id,catalog_hash:job.catalog_hash,
      file_count:job.manifest.length,package_sha256:await fromRoot(target,()=>C.hash(saved)),path:[target.name,'復旧用',job.project_id,job.id,'manifest.sentlog.json'].join('\\')},
      message:job.payload.project.name+'：案件一式をPCに保存・内容照合済み（'+job.manifest.length+'ファイル、保存先：'+target.name+'）。アプリで保管を確定してください。'};
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

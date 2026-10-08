/* v1.33: one versioned, reread-and-verified project backup per archive request. */
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
  async function save(job){
    if(!rootHandle||await rootHandle.queryPermission({mode:'readwrite'})!=='granted')throw Error('以前のセントログ保管フォルダを選び、「保存許可を確認」を押してください。');
    let dir=await rootHandle.getDirectoryHandle('復旧用',{create:true});
    dir=await dir.getDirectoryHandle(job.project_id,{create:true});dir=await dir.getDirectoryHandle(job.id,{create:true});
    const folder=await dir.getDirectoryHandle('files',{create:true}),paths={};
    for(const f of job.manifest){
      const handle=await folder.getFileHandle(f.id,{create:true});let present=await handle.getFile();
      if(!await C.matches(present,f)){const blob=await source(f);const writer=await handle.createWritable();try{await writer.write(blob);await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}present=await handle.getFile();}
      if(!await C.matches(present,f))throw Error('PCへの書き込み照合に失敗しました：'+f.file_name);
      paths[f.key]='files/'+f.id;
    }
    const pack=C.backupPack(job,paths);C.validatePack(pack,job);
    const text=JSON.stringify(pack),handle=await dir.getFileHandle('manifest.sentlog.json',{create:true});
    let saved=await handle.getFile();
    if(await saved.text()!==text){const writer=await handle.createWritable();try{await writer.write(text);await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}saved=await handle.getFile();}
    C.validatePack(JSON.parse(await saved.text()),job);
    // Recheck actual files, not an earlier database receipt, on every checkpoint.
    for(const f of job.manifest)if(!await C.matches(await (await folder.getFileHandle(f.id)).getFile(),f))throw Error('確認中にPCのファイルが変更されました：'+f.file_name);
    await rpc('pc_complete',job.project_id,{job_id:job.id,catalog_hash:job.catalog_hash,
      file_count:job.manifest.length,package_sha256:await C.hash(saved),path:[rootHandle.name,'復旧用',job.project_id,job.id,'manifest.sentlog.json'].join('\\')});
    return job.payload.project.name+'：案件一式をPCに保存・内容照合済み（'+job.manifest.length+'ファイル）。アプリで保管を確定してください。';
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

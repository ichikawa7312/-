/* Sentlog v1.37 - company PC archive checkpoint and one-time restoration transport.
 * Only the versioned, previously verified PC bundle is a valid source.
 * Never remove the PC bundle, annotations, photographs or PDF originals. */
(function(){
  'use strict';
  const C=window.SentlogArchiveCore;
  if(!C)throw Error('保管ファイルの照合機能を確認してください。');
  const section=document.createElement('section');section.className='card';
  const heading=document.createElement('h2');heading.textContent='端末の容量整理・PCからの復旧';
  const note=document.createElement('p');note.className='muted';
  note.textContent='保管済み案件の整理依頼を受けたら、会社PCの復旧用フォルダを読み直して照合します。復旧では一時ファイルを送信し、端末の受信が終わった後に一時ファイルだけ削除します。PCの元データは消しません。';
  const message=document.createElement('p');message.setAttribute('role','status');message.style.whiteSpace='pre-wrap';
  const button=document.createElement('button');button.textContent='端末からの依頼を再確認';button.type='button';
  section.append(heading,note,message,button);
  document.querySelector('main')?.prepend(section);
  let busy=false,lastMessage='';
  const say=t=>{if(lastMessage!==t){lastMessage=t;message.textContent=t;}};
  const setStatus=t=>{say(t);if(typeof log==='function')log(t);};
  async function rpc(action,project=null,data={}){
    await ensureSession();
    const id=await ensureDevice();
    return rest('/rest/v1/rpc/sentlog_capacity_v1',{method:'POST',body:JSON.stringify({
      p_action:action,p_project_id:project,p_device_id:id,p_data:data
    })});
  }
  async function readBundle(job){
    if(!rootHandle)throw Error('PC保管フォルダが未選択です。「保存先を選ぶ」で以前の保管先を指定してください。');
    if(typeof rootHandle.queryPermission!=='function'||await rootHandle.queryPermission({mode:'readwrite'})!=='granted')
      throw Error('PCの保存先への許可がありません。「保存許可を確認」を押してください。');
    const receipt=job.pc_receipt;
    if(!receipt?.path||!receipt.package_sha256||receipt.package_sha256.length!==64)
      throw Error('以前の保管時にPCで作成した控えの記録がありません。');
    const parts=C.receiptParts(receipt.path,rootHandle.name);
    if(parts.length<4||parts[0]!=='復旧用'||parts[1]!==job.project_id||
       parts[2]!==job.id||parts.at(-1)!=='manifest.sentlog.json')
      throw Error('復旧用フォルダの場所が記録と一致しません。');
    let folder=rootHandle;
    for(const name of parts.slice(0,-1))folder=await folder.getDirectoryHandle(name);
    const file=await (await folder.getFileHandle(parts.at(-1))).getFile();
    if(await C.hash(file)!==String(receipt.package_sha256).toLowerCase())
      throw Error('PCのバックアップの内容が保管時と異なります。削除せず確認してください。');
    let pack;try{pack=JSON.parse(await file.text());}catch{throw Error('PCのバックアップを読み取れません。');}
    C.validatePack(pack,job);
    const filesFolder=await folder.getDirectoryHandle('files');
    const checked=[];
    for(const f of job.manifest||[]){
      if(!/^[0-9a-f-]{36}$/i.test(f.id)||!['drawing','photo'].includes(f.kind))
        throw Error('保管ファイルの登録内容が不正です。');
      const found=pack.files.find(x=>x.id===f.id&&x.key===f.key);
      if(!found||found.path!=='files/'+f.id)throw Error('PCの復旧ファイル一覧が一致しません。');
      const stored=await (await filesFolder.getFileHandle(f.id)).getFile();
      if(!await C.matches(stored,f))throw Error('PCの保管ファイルが破損・欠損しています：'+f.file_name);
      if(stored.size>22*1024*1024)throw Error('22MBを超えるファイルがあり、自動復旧できません：'+f.file_name);
      checked.push({f,stored});
    }
    return checked;
  }
  const path=(op,f)=>op.owner_id+'/archive-restore/'+op.id+'/'+f.id;
  const encoded=p=>p.split('/').map(encodeURIComponent).join('/');
  async function uploadVerified(op,f,stored){
    const target=path(op,f),url=SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+encoded(target);
    // Repeated PC polls are idempotent: an existing object is accepted only
    // when its SHA-256 matches the immutable archive manifest.
    const existing=await fetch(SUPABASE_URL+'/storage/v1/object/authenticated/'+BUCKET+'/'+encoded(target),
      {headers:authHeaders(),cache:'no-store'}).catch(()=>null);
    if(existing?.ok){
      if(await C.matches(await existing.blob(),f))return;
    }
    const response=await fetch(url,{
      method:'POST',headers:authHeaders({'Content-Type':f.mime_type||stored.type||'application/octet-stream','x-upsert':'true'}),
      body:stored
    });
    if(!response.ok)throw Error('復旧用ファイルをクラウドへ一時送信できません：'+f.file_name+'（'+response.status+'）');
    const check=await fetch(SUPABASE_URL+'/storage/v1/object/authenticated/'+BUCKET+'/'+encoded(target),
      {headers:authHeaders(),cache:'no-store'});
    if(!check.ok||!await C.matches(await check.blob(),f))
      throw Error('一時送信したファイルを照合できません：'+f.file_name);
  }
  async function process(entry){
    const op=entry.operation,job=entry.job;
    if(!op||!job||op.project_id!==job.project_id||op.job_id!==job.id||
       job.pc_receipt?.package_sha256?.length!==64)throw Error('保管確認の内容が一致しません。');
    if(!['verify','restore'].includes(op.action))throw Error('未対応の依頼です。');
    if(op.expires_at&&Date.parse(op.expires_at)<=Date.now())return;
    say(job.payload?.project?.name+'：PCバックアップを検証しています…');
    try{
      const files=await readBundle(job);
      if(op.action==='restore'){
        let n=0;
        for(const {f,stored} of files){
          say(job.payload?.project?.name+'：復旧ファイルを一時送信中 '+(++n)+' / '+files.length);
          await uploadVerified(op,f,stored);
        }
      }
      await rpc('pc_ready',job.project_id,{operation_id:op.id,catalog_hash:job.catalog_hash,
        package_sha256:job.pc_receipt.package_sha256,file_count:files.length});
      setStatus(job.payload?.project?.name+'：'+(op.action==='verify'?'PCの全ファイルを再照合済み。端末側で削除を確定できます。':'復旧用データを一時送信済み。端末の受信を待っています。'));
    }catch(e){
      setStatus(job.payload?.project?.name+'：'+e.message);
      await rpc('pc_error',job.project_id,{operation_id:op.id,reason:e.message}).catch(()=>{});
    }
  }
  async function cleanTemp(entry){
    const id=entry?.id;
    if(!id||entry.action!=='restore')return;
    const prefixes=(entry.manifest||[]).map(f=>entry.owner_id+'/archive-restore/'+id+'/'+f.id);
    // Storage API Delete Objects: at most 1000 prefixes per request.
    for(let index=0;index<prefixes.length;index+=500){
      const batch=prefixes.slice(index,index+500);
      const response=await fetch(SUPABASE_URL+'/storage/v1/object/'+BUCKET,{
        method:'DELETE',headers:authHeaders({'Content-Type':'application/json'}),
        body:JSON.stringify({prefixes:batch})
      });
      if(!response.ok)throw Error('一時ファイルの削除待ち（'+response.status+'）');
    }
    await rpc('pc_cleaned',null,{operation_id:id});
  }
  async function run(){
    if(busy||!navigator.onLine||document.hidden||!session?.user)return;
    busy=true;button.disabled=true;
    try{
      await ensureSession();const pending=await rpc('pc_jobs');
      for(const entry of pending||[])await process(entry);
      const cleanup=await rpc('pc_cleanup');
      for(const entry of cleanup||[]){
        try{await cleanTemp(entry);}catch(e){setStatus('復旧用の一時ファイル削除を再試行します：'+e.message);}
      }
      if(!(pending||[]).length&&!(cleanup||[]).length)say('現在、容量整理・復旧の確認依頼はありません。');
    }catch(e){say('端末からの依頼を確認できません：'+e.message);}
    finally{busy=false;button.disabled=false;}
  }
  button.onclick=run;
  setTimeout(run,3000);setInterval(run,15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)run();});
  window.addEventListener('online',run);
  window.sentlogCapacityPcCheck=run;
})();
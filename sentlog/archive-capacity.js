/* Sentlog v1.39. Device-only archived capacity release and verified PC restoration.
   No automatic purge; no mutation of company PC backup or other devices. */
(function(){
  'use strict';
  const C=window.SentlogArchiveCore,S=window.SentlogRecords;
  if(!C||!S)throw Error('保管・保存機能を確認してください。');
  const BASE='https://wiulvaqixphuobdielyy.supabase.co';
  const KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
  const WORKSPACE='surveyFieldNoteWorkspaceV1',LOCAL='sentlogArchiveLocalV1',PREFIX='surveyFieldNoteDrawingV1:';
  const BUCKET='sentlog-temp';
  const SINGLE_LIMIT=22*1024*1024,CHUNK_SIZE=4*1024*1024,FILE_LIMIT=128*1024*1024;
  const storageUsage=async()=>{try{const e=await navigator.storage?.estimate?.();return Number.isFinite(e?.usage)?e.usage:null;}catch{return null;}};
  const partPath=(path,i)=>path+'.part'+String(i).padStart(5,'0');
  const session=()=>{try{return JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null')}catch{return null}};
  const device=()=>localStorage.getItem('sentlogCloudDeviceV1');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let active=false;
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  function state(){
    const raw=S.getItem(LOCAL);
    if(!raw)return {};
    try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}
    catch{throw Error('この端末の保管整理記録を読み取れません。データを変更せず停止しました。');}
  }
  function current(id){return state()[id]||null;}
  function isCleared(id){return !!current(id)?.mode;}
  function isWholeRemoved(id){return current(id)?.mode==='project';}
  function canonicalSnapshot(p){
    return {project:p,drawings:(p.drawings||[]).map(d=>({meta:d,state:JSON.parse(S.getItem(PREFIX+d.id)||'null')}))};
  }
  async function rpc(action,project=null,data={}){
    if(!navigator.onLine)throw Error('オンラインで操作してください。');
    await window.sentlogManagementSession?.();
    const s=session(),id=device();
    if(!s?.access_token||!s?.user?.id||!id)throw Error('ログインしてから操作してください。');
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
    try{
      const response=await fetch(BASE+'/rest/v1/rpc/sentlog_capacity_v1',{
        method:'POST',cache:'no-store',signal:controller.signal,
        headers:{apikey:KEY,Authorization:'Bearer '+s.access_token,'Content-Type':'application/json'},
        body:JSON.stringify({p_action:action,p_project_id:project,p_device_id:id,p_data:data})
      });
      const result=await response.json().catch(()=>null);
      if(!response.ok)throw Error(result?.message||'容量整理の確認に失敗しました。');
      if(s.user.id!==session()?.user?.id||id!==device())throw Error('途中でログインまたは端末が変更されました。');
      return result;
    }catch(error){
      if(error?.name==='AbortError')throw Error('通信がタイムアウトしました。結果が不明なため、保管状態を再確認してください。');
      throw error;
    }finally{clearTimeout(timeout);}
  }
  function contextCheck(cp){
    if(!cp||cp.status!=='archived'||cp.retired||cp.checking)
      throw Error('通常の保管が完了した案件だけ整理できます。使用終了（不要）は対象外です。');
    if(currentView!=='projects')throw Error('図面を閉じ、案件一覧の保管フォルダに戻ってください。');
    if(window.sentlogImporting||S.pending||S.failed)
      throw Error('未保存の記録があります。同期・保存を確認してから操作してください。');
  }
  function validate(info,cp){
    const op=info?.operation,job=info?.job,files=info?.files;
    if(!op||!job||!Array.isArray(files)||op.project_id!==cp.id||job.project_id!==cp.id||
       job.id!==op.job_id||job.pc_receipt?.package_sha256?.length!==64)
      throw Error('保管資料の管理情報を照合できません。');
    const unique=new Set();
    for(const f of files){
      if(!f||!['drawing','photo'].includes(f.kind)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(f.id)||
         !/^(background:[^:]+|photo:[^:]+:[^:]+)$/.test(f.key)||
         !Number.isSafeInteger(Number(f.byte_size))||Number(f.byte_size)<0||
         !/^[a-f0-9]{64}$/i.test(f.sha256)||unique.has(f.key)||
         f.temp_path!==op.owner_id+'/archive-restore/'+op.id+'/'+f.id)
        throw Error('復旧対象のファイル一覧が不正です。');
      unique.add(f.key);
    }
    if(files.length!==job.manifest?.length)throw Error('保管ファイルの件数が一致しません。');
    return info;
  }
  function modal(title){
    const d=el('dialog');d.className='sl-capacity-dialog';
    const h=el('h2',title),msg=el('p','準備しています…');msg.className='sl-capacity-message';msg.setAttribute('role','status');msg.setAttribute('aria-live','polite');
    const detail=el('p','会社PCの「PC自動同期」を開いて、保存先の許可を確認してください。');detail.className='sl-capacity-hint';
    const actions=el('div');actions.className='sl-capacity-buttons';
    const close=el('button','中止して閉じる');close.type='button';
    actions.append(close);d.append(h,msg,detail,actions);document.body.append(d);
    let opId=null,stopped=false,working=false;
    d.addEventListener('cancel',e=>{if(working)e.preventDefault();});
    const stop=async()=>{if(working)return;stopped=true;close.disabled=true;
      try{if(opId)await rpc('cancel',null,{operation_id:opId});}catch(e){msg.textContent='中止の通知を確認できません：'+e.message;}
      d.close();};
    close.onclick=stop;
    d.addEventListener('close',()=>{stopped=true;setTimeout(()=>d.remove(),0);});
    d.showModal();
    return {d,msg,detail,actions,close,setOp:id=>opId=id,cancelled:()=>stopped,
      locked:v=>{working=v;close.disabled=v;},message:v=>msg.textContent=v,
      done:()=>{close.disabled=false;close.textContent='閉じる';close.onclick=()=>d.close();},
      addButton:(label,handler)=>{const b=el('button',label);b.type='button';b.onclick=handler;actions.prepend(b);return b;}};
  }
  async function waitForPc(v,project,opId){
    let prev='';const until=Date.now()+1000*60*15;
    for(;;){
      if(v.cancelled())throw Error('操作は中止されました。');
      const info=await rpc('inspect',project,{operation_id:opId});
      if(info.operation.state==='ready')return info;
      if(info.operation.state!=='requested'||Date.now()>until||Date.parse(info.operation.expires_at)<=Date.now())
        throw Error('PCの確認が間に合いませんでした。会社PCを確認し、改めてお試しください。');
      if(info.operation.last_error&&info.operation.last_error!==prev){
        prev=info.operation.last_error;
        v.message('会社PCで確認できません：'+prev+'\nPCの資料や保存許可を確認してください。');
      }else if(!prev)v.message('会社PCのバックアップを照合しています…\nPC自動同期の画面を開いてください。');
      await sleep(4000);
    }
  }
  async function countLocal(files){
    const deletions=[],missing=[],known=[];
    for(const f of files){
      const blob=await getDBFile(f.key);
      if(!(blob instanceof Blob)){missing.push(f);continue;}
      if(!await C.matches(blob,f))throw Error('この端末に保管時と異なるファイルがあります：'+f.file_name+'。削除しません。');
      deletions.push({key:f.key,size:blob.size});known.push(f);
    }
    return {deletions,missing,known,bytes:deletions.reduce((n,x)=>n+x.size,0)};
  }
  function freshRecordCheck(info,cp,mode){
    const raw=S.getItem(WORKSPACE);let ws;
    try{ws=JSON.parse(raw||'null');}catch{throw Error('案件一覧が読み取れません。');}
    if(!ws||!Array.isArray(ws.projects))throw Error('案件一覧を照合できません。');
    const p=ws.projects.find(x=>x.id===cp.client_key);
    if(!p)throw Error('この端末には案件の記録がありません。すでに端末から外している場合は復旧を選んでください。');
    if(C.snapshotText(canonicalSnapshot(p))!==C.snapshotText(info.job.payload))
      throw Error('この端末の変状記録が保管時と異なります。データを消さず中止しました。');
    if(isWholeRemoved(cp.id))throw Error('案件全体を端末から外しています。先に復旧してください。');
    return {raw,ws,p};
  }
  async function ensureServerArchive(cp,opId){
    await window.SentlogArchive.refresh();
    const next=window.SentlogArchive.byCloud(cp.id);
    contextCheck(next);
    const info=validate(await rpc('inspect',cp.id,{operation_id:opId}),next);
    if(info.operation.state!=='ready')throw Error('PCの最新確認が取れません。');
    if(info.operation.device_id!==device())throw Error('別端末の確認を使うことはできません。');
    return info;
  }
  function bytes(n){return n<1024**2?(n/1024).toFixed(0)+'KB':n<1024**3?(n/1024**2).toFixed(1)+'MB':(n/1024**3).toFixed(2)+'GB';}
  async function cleanup(cp,mode){
    if(active)return;active=true;let view,opId=null,applied=false;
    try{
      contextCheck(cp);
      if(current(cp.id)?.mode==='project')throw Error('すでに案件を端末から外しています。');
      view=modal(mode==='files'?'端末のPDF・写真を整理':'この端末から案件を外す');
      const started=await rpc('begin',cp.id,{action:'verify',mode});opId=started.id;view.setOp(opId);
      let info=validate(await rpc('inspect',cp.id,{operation_id:opId}),cp);
      const local=freshRecordCheck(info,cp,mode),counter=await countLocal(info.files);
      view.detail.textContent='対象：'+counter.known.length+'ファイル／約'+bytes(counter.bytes)+'。会社PCのバックアップを読み直し、完全一致した場合だけ次へ進みます。端末内の変状記録は、PDF・写真だけ整理する場合は残します。';
      info=validate(await waitForPc(view,cp.id,opId),cp);
      if(view.cancelled())return;
      const ready=await ensureServerArchive(cp,opId);
      freshRecordCheck(ready,cp,mode);
      view.message('PCのバックアップ照合が完了しました。操作内容を確認して実行してください。');
      const confirm=view.addButton(mode==='files'?'照合済みのPDF・写真を端末から削除':'この端末から案件一式を外す',async()=>{
        confirm.disabled=true;view.locked(true);
        try{
          const currentInfo=await ensureServerArchive(cp,opId);
          const before=freshRecordCheck(currentInfo,cp,mode),counter2=await countLocal(currentInfo.files);
          const mark=state();
          if(mode==='files'&&counter2.deletions.length===0)throw Error('この端末で整理できるPDF・写真はありません。');
          if(!window.confirm('会社PCに案件一式があることを再確認済みです。\nこの端末から'+(mode==='files'?'PDF・写真だけを外しますか？':'案件の記録・PDF・写真を外しますか？')+'\n会社PCやほかの端末の資料は変更しません。')){confirm.disabled=false;return;}
          const beforeUsage=await storageUsage();
          const item={mode,project_id:cp.id,job_id:currentInfo.job.id,revision:currentInfo.job.revision,at:Date.now(),
            removed_bytes:counter2.bytes,removed_count:counter2.deletions.length,estimate_before:beforeUsage};
          mark[cp.id]=item;
          const writes=[[LOCAL,JSON.stringify(mark)]];
          let nextWs=null;
          if(mode==='project'){
            nextWs={...before.ws,projects:before.ws.projects.filter(p=>p.id!==cp.client_key)};
            writes.push([WORKSPACE,JSON.stringify(nextWs)]);
            for(const d of before.p.drawings||[])writes.push([PREFIX+d.id,null]);
          }
          await S.archiveAtomic({writes,deleteFiles:counter2.deletions,expectedWorkspace:before.raw});
          applied=true;
          const afterUsage=await storageUsage();
          if(nextWs){workspace=nextWs;activeProjectId=null;activeDrawingId=null;}
          if(typeof renderProjects==='function')renderProjects();
          try{await rpc('finish',cp.id,{operation_id:opId});}catch(e){view.message('この端末の整理は完了しましたが、完了通知が届きませんでした。PCの控えは残っています：'+e.message);}
          view.message('この端末の整理が完了しました。対象ファイル：'+counter2.deletions.length+'件／合計'+bytes(counter2.bytes)+'。'+
            (beforeUsage!=null&&afterUsage!=null?'端末全体の推定使用量：'+bytes(beforeUsage)+' → '+bytes(afterUsage)+'（ブラウザの反映には時間差があります）。':'端末全体の使用量は設定の容量バーで確認してください。')+
            '\n会社PCと他端末の資料は残しています。');
          view.detail.textContent='必要になったら保管フォルダから「PCから復旧」を押してください。';
          view.done();confirm.remove();
          const setting=document.getElementById('sentlogStorageRefresh');if(setting&&!setting.disabled)setting.click();
        }catch(e){view.message('削除せず停止、または完了状況の確認が必要です：'+e.message);confirm.disabled=false;}
        finally{view.locked(false);}
      });
    }catch(e){if(view&&!view.cancelled()){view.message('容量整理は完了していません：'+e.message);view.done();}
      if(!applied&&opId)await rpc('cancel',cp?.id,{operation_id:opId}).catch(()=>{});
      if(!view)alert(e.message||String(e));
    }finally{active=false;}
  }
  async function restore(cp){
    if(active)return;active=true;let view,opId=null,finished=false;
    try{
      contextCheck(cp);
      const mark=current(cp.id),wsStart=JSON.parse(S.getItem(WORKSPACE)||'{"projects":[]}');
      if(!Array.isArray(wsStart.projects))throw Error('この端末の案件一覧を確認できません。');
      const localProject=wsStart.projects.some(p=>p.id===cp.client_key);
      const fresh=!mark?.mode&&!localProject;
      if(!mark?.mode&&!fresh)throw Error('端末に案件が残っています。上書きせず中止しました。');
      if(mark?.mode==='files'&&!localProject)throw Error('整理履歴と端末の案件情報が一致しません。上書きせず中止しました。');
      const restoreMode=mark?.mode||'project';
      view=modal(fresh?'新しい端末へPCから案件を復旧':'PCの控えから案件を復旧');
      const started=await rpc('begin',cp.id,{action:'restore',mode:restoreMode});opId=started.id;view.setOp(opId);
      let info=validate(await rpc('inspect',cp.id,{operation_id:opId}),cp);
      if(mark&&(info.job.id!==mark.job_id||info.job.revision!==mark.revision))throw Error('保管時の資料が変更されています。自動復旧を止めました。');
      const beforeRaw=S.getItem(WORKSPACE);
      if(restoreMode==='files')freshRecordCheck(info,cp,'files');
      else if((JSON.parse(beforeRaw||'{"projects":[]}').projects||[]).some(p=>p.id===cp.client_key))
        throw Error('すでに同じ案件が端末に存在します。自動で上書きしません。');
      view.detail.textContent='会社PCにある案件一式を照合して、PDF・写真をこの端末に取り戻します。会社PCの「PC自動同期」を開いてください。';
      info=validate(await waitForPc(view,cp.id,opId),cp);
      if(view.cancelled())return;
      info=await ensureServerArchive(cp,opId);
      if(info.operation.action!=='restore'||info.operation.mode!==restoreMode)throw Error('復旧の操作種別が一致しません。');
      view.locked(true);
      view.message('PCからの受信を開始しています。画面を閉じないでください。');
      let received=0;
      for(const f of info.files){
        const local=await getDBFile(f.key);
        if(await C.matches(local,f)){received++;continue;}
        if(local instanceof Blob&&local.size>0)throw Error('この端末に別のファイルが存在します：'+f.file_name+'。上書きせず中止しました。');
        if(Number(f.byte_size)>FILE_LIMIT)throw Error('128MBを超えるファイルは、この版では自動復旧できません：'+f.file_name);
        const multipart=Number(f.byte_size)>SINGLE_LIMIT;
        const partCount=multipart?Math.ceil(Number(f.byte_size)/CHUNK_SIZE):1;
        const parts=[];
        for(let i=0;i<partCount;i++){
          const s=session(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
          try{
            const rawPath=multipart?partPath(f.temp_path,i):f.temp_path;
            const encoded=rawPath.split('/').map(encodeURIComponent).join('/');
            const response=await fetch(BASE+'/storage/v1/object/authenticated/'+BUCKET+'/'+encoded,{cache:'no-store',signal:controller.signal,
              headers:{apikey:KEY,Authorization:'Bearer '+s.access_token}});
            if(!response.ok)throw Error('PCからのファイル取得に失敗（'+response.status+'）：'+f.file_name);
            const part=await response.blob();
            if(multipart&&part.size!==Math.min(CHUNK_SIZE,Number(f.byte_size)-i*CHUNK_SIZE))
              throw Error('受信した分割ファイルのサイズが一致しません：'+f.file_name);
            parts.push(part);
            if(multipart)view.message('大容量ファイルを受信中：'+f.file_name+'（'+(i+1)+' / '+partCount+'分割）');
          }finally{clearTimeout(timer);}
        }
        const blob=multipart?new Blob(parts,{type:f.mime_type||'application/octet-stream'}):parts[0];
        if(!await C.matches(blob,f))throw Error('受信ファイルの内容照合に失敗：'+f.file_name);
        const named=f.file_name&&typeof File==='function'?new File([blob],f.file_name,{type:f.mime_type||blob.type}):blob;
        await S.writeFile(f.key,named);
        if(!await C.matches(await getDBFile(f.key),f))throw Error('端末への保存照合に失敗：'+f.file_name);
        received++;view.message('PCからファイルを復旧中：'+received+' / '+info.files.length);
      }
      await S.settled();S.assertSafe();
      const markNow=current(cp.id);
      if(mark&&(markNow?.job_id!==mark.job_id||markNow?.mode!==mark.mode))
        throw Error('復旧中に整理状態が変更されました。');
      const wsText=S.getItem(WORKSPACE);
      let ws=JSON.parse(wsText||'{"projects":[]}');
      const writes=[];
      if(restoreMode==='project'){
        if(ws.projects.some(p=>p.id===cp.client_key))throw Error('復旧中に案件が追加されました。自動上書きはしません。');
        const project=info.job.payload.project;
        if(project.id!==cp.client_key)throw Error('案件IDが一致しません。');
        ws={...ws,projects:[...ws.projects,project]};writes.push([WORKSPACE,JSON.stringify(ws)]);
        for(const d of info.job.payload.drawings||[]){
          if(!d.meta?.id||!d.state)throw Error('図面の変状記録が不足しています。');
          if(S.getItem(PREFIX+d.meta.id)!==null)throw Error('別の図面記録が端末に残っています。上書きせず中止しました。');
          writes.push([PREFIX+d.meta.id,JSON.stringify(d.state)]);
        }
      }else freshRecordCheck(info,cp,'files');
      if(mark){const nextMark=state();delete nextMark[cp.id];writes.push([LOCAL,JSON.stringify(nextMark)]);}
      await S.archiveAtomic({writes,deleteFiles:[],expectedWorkspace:wsText});
      if(restoreMode==='project'){workspace=ws;activeProjectId=null;activeDrawingId=null;}
      finished=true;
      try{await rpc('finish',cp.id,{operation_id:opId});}catch(e){view.message('端末への復旧は完了しましたが、完了通知は再確認が必要です：'+e.message);}
      if(typeof renderProjects==='function')renderProjects();
      view.message('復旧完了！ '+info.files.length+'件のファイルと案件記録を確認しました。'+(fresh?' 新しい端末に案件を追加しました。':''));
      view.detail.textContent='ほかの使用中案件や会社PCの控えには触れていません。保管中の自動同期は停止したままです。';
      view.done();
      const setting=document.getElementById('sentlogStorageRefresh');if(setting&&!setting.disabled)setting.click();
    }catch(e){if(view&&!view.cancelled()){view.message('復旧は完了していません。途中まで保存したファイルがあっても、案件の状態は維持しています：'+e.message);view.done();}
      if(opId&&!finished)await rpc('cancel',cp?.id,{operation_id:opId}).catch(()=>{});
      if(!view)alert(e.message||String(e));
    }finally{if(view)view.locked(false);active=false;}
  }
  function renderActions(host,cp,p){
    if(!cp||cp.status!=='archived')return;
    const saved=current(cp.id);
    const unavailable=!!cp.retired||!!cp.checking;
    const cleared=!!saved?.mode;
    let hasLocal=true;
    try{hasLocal=(JSON.parse(S.getItem(WORKSPACE)||'{"projects":[]}').projects||[]).some(x=>x.id===cp.client_key);}catch{}
    const newDevice=!cleared&&!hasLocal;
    const disableRelease=unavailable||cleared||!hasLocal;
    const disableRestore=unavailable||(!cleared&&!newDevice);
    const reason=cp.retired
      ?'使用終了（不要）の案件は、会社PCへの復旧用一式が確認されていないため操作できません。'
      :cp.checking?'保管前の確認中です。確認が完了するまで操作できません。'
      :cleared?'この端末は容量整理済みです。再び整理するには先に復旧してください。'
      :newDevice?'この端末に案件がありません。会社PCの保管内容を再照合して復旧できます。'
      :'この端末には案件が残っています。復旧は容量整理後に利用できます。';
    function control(label,handler,disabled){
      const button=el('button',label);button.type='button';button.className='sl-capacity-button';
      button.disabled=disabled;
      if(disabled)button.title=reason;
      else button.onclick=handler;
      host.append(button);
    }
    control('PDF・写真を端末から外す',()=>cleanup(cp,'files'),disableRelease);
    control('この端末から案件を外す',()=>cleanup(cp,'project'),disableRelease);
    control('PCからこの端末に復旧',()=>restore(cp),disableRestore);
    const note=el('small',cp.retired
      ?'使用終了（不要）：復旧用の一式バックアップが未確認のため、容量整理・復旧はできません。'
      :cp.checking?'保管の安全確認中です。完了してから操作してください。'
      :saved?.mode==='project'?'この端末では案件を外しています（'+(saved.removed_count||0)+'件・'+bytes(saved.removed_bytes||0)+'）。PCから復旧できます。'
      :saved?.mode==='files'?'この端末のPDF・写真は整理済み（'+(saved.removed_count||0)+'件・'+bytes(saved.removed_bytes||0)+'）。PCから復旧できます。'
      :newDevice?'この端末に案件はありません。PCに照合済みの控えがあれば、この端末に復旧できます。'
      :'通常保管：PCにある原本を照合してから端末の容量を空けます。復旧は整理後に使用できます。');
    note.className='sl-capacity-note';
    host.append(note);
  }
  async function install(){
    await window.sentlogAppReady;
    const css=el('style');
    css.textContent='#projectsGrid .sl-capacity-note{display:block;width:100%;font-size:11px;color:#475569;line-height:1.5} .sl-capacity-button{background:#f8fafc;border:1px solid #94a3b8;border-radius:7px;padding:9px;min-height:44px}.sl-capacity-dialog{box-sizing:border-box;width:min(570px,calc(100vw - 24px));max-height:85vh;overflow:auto;border-radius:12px;border:1px solid #cbd5e1;padding:20px;background:white;color:#111827;font:14px/1.65 system-ui}.sl-capacity-dialog::backdrop{background:#0008}.sl-capacity-dialog h2{font-size:18px}.sl-capacity-dialog .sl-capacity-message{white-space:pre-wrap;overflow-wrap:anywhere}.sl-capacity-dialog .sl-capacity-hint{font-size:12px;color:#475569}.sl-capacity-dialog .sl-capacity-buttons{display:flex;flex-direction:column;gap:8px}.sl-capacity-dialog button{min-height:44px}.sl-capacity-dialog button:disabled{opacity:.5}';
    document.head.append(css);
    if(typeof renderProjects==='function')renderProjects();
  }
  window.SentlogCapacity={isCleared,isWholeRemoved,renderActions,cleanup,restore};
  install().catch(e=>console.warn('Capacity actions',e));
})();

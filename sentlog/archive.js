/* v1.33 archive stage 1. Classification only: never remove local records/files. */
(function(){
  'use strict';
  const C=window.SentlogArchiveCore;
  if(!C)throw Error('保管機能の読み込みを確認してください。');
  const BASE='https://wiulvaqixphuobdielyy.supabase.co';
  const KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
  let controls=[],owner='',fresh=false,flight=null,archiveView=false,currentJob=null,acting=false,installed=false;
  const checked=new Map();
  const session=()=>{try{return JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null');}catch{return null;}};
  const device=()=>localStorage.getItem('sentlogCloudDeviceV1');
  function account(){const id=session()?.user?.id||'';if(owner!==id){owner=id;fresh=false;controls=[];checked.clear();try{controls=JSON.parse(localStorage.getItem('sentlogArchiveControlV1:'+id)||'[]');}catch{};}return id;}
  async function net(path,body){
    const s=session();if(!s?.access_token)throw Error('ログインしてから操作してください。');
    const c=new AbortController(),timer=setTimeout(()=>c.abort(),20000);
    try{const r=await fetch(BASE+'/rest/v1/'+path,{method:body===undefined?'GET':'POST',cache:'no-store',signal:c.signal,
      headers:{apikey:KEY,Authorization:'Bearer '+s.access_token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      const j=await r.json().catch(()=>null);if(!r.ok)throw Error(j?.message||'保管状態を確認できません。通信とログインを確認してください。');return j;
    }finally{clearTimeout(timer);}
  }
  const rpc=(action,project=null,data={})=>net('rpc/sentlog_archive_v1',{p_action:action,p_project_id:project,p_device_id:device(),p_data:data});
  const byLocal=id=>controls.find(c=>c.client_key===id);
  const byCloud=id=>controls.find(c=>c.id===id);
  const isAuto=id=>fresh&&C.maySync(byCloud(id),null);
  function localSnapshot(p){return {project:p,drawings:(p.drawings||[]).map(d=>({meta:d,state:JSON.parse(window.SentlogRecords.getItem('surveyFieldNoteDrawingV1:'+d.id)||'null')}))};}
  async function prove(job){
    if(window.sentlogImporting||window.SentlogRecords.failed||window.SentlogRecords.pending)throw Error('この端末に未保存の変更があります。');
    const pid=job.payload.project.id;
    if(currentView==='editor'&&activeProjectId===pid)throw Error('この案件の図面を閉じ、案件一覧に戻ってください。');
    const p=getProject(pid);
    if(!p){
      for(const d of job.payload.project.drawings||[])if(window.SentlogRecords.getItem('surveyFieldNoteDrawingV1:'+d.id))throw Error('一覧にない端末内の記録があります。確認が必要です。');
      return;
    }
    const before=C.snapshotText(localSnapshot(p));
    if(before!==C.snapshotText(job.payload))throw Error('この端末に未同期の変更、または未受信の記録があります。確認を中止して同期してください。');
    for(const f of job.manifest){const blob=await getDBFile(f.key);if(!await C.matches(blob,f))throw Error('未同期・未受信、または内容が異なるファイル：'+f.file_name);}
    if(currentView==='editor'&&activeProjectId===pid||window.SentlogRecords.pending||window.SentlogRecords.failed||C.snapshotText(localSnapshot(getProject(pid)))!==before)throw Error('確認中に変更されました。もう一度確認します。');
  }
  async function report(control){
    if(!control.checking||!device())return;
    const at=checked.get(control.job_id)||0;if(Date.now()-at<10000)return;
    const job=await rpc('inspect',control.id,{job_id:control.job_id});
    if(!job.required_devices.some(d=>d.id===device()))return;
    let clean=true,reason='未同期の変更なし';
    try{await prove(job);}catch(e){clean=false;reason=e.message;}
    await rpc('report',control.id,{job_id:job.id,catalog_hash:job.catalog_hash,clean,reason});
    checked.set(control.job_id,Date.now());
    if(currentJob?.id===job.id){currentJob=await rpc('inspect',control.id,{job_id:job.id});renderJob();}
  }
  async function refresh(){
    account();if(!owner){fresh=false;return [];}
    if(flight)return flight;
    flight=(async()=>{try{
      const uid=owner,rows=await rpc('list');if(uid!==session()?.user?.id)throw Error('ログインが変更されました。');
      const changed=C.stable(rows)!==C.stable(controls);controls=rows;fresh=true;
      try{localStorage.setItem('sentlogArchiveControlV1:'+owner,JSON.stringify(rows));}catch{}
      if(installed&&changed){if(currentView==='projects')renderProjects();renderBanner();}
      for(const row of rows)if(row.checking)await report(row);
      return rows;
    }catch(e){fresh=false;throw e;}finally{flight=null;}})();return flight;
  }
  function canSync(cp,manual){
    if(!fresh)return false;
    const c=byCloud(cp.id)||{...cp,checking:false};
    return C.maySync(c,manual);
  }
  function includeLocal(id,manual){if(!fresh)return false;const c=byLocal(id);return c?C.maySync(c,manual):!manual;}
  function createButton(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;return b;}
  function tell(message){const e=document.getElementById('slArchiveMessage');if(e)e.textContent=message;else alert(message);}
  async function action(fn){if(acting)return;acting=true;try{await fn();}catch(e){tell(e.message||String(e));}finally{acting=false;}}
  async function start(p){
    if(!navigator.onLine)throw Error('保管する前にオンラインで同期を確認してください。');
    await window.sentlogCloudIdle?.();await window.sentlogArchiveSync?.();await window.sentlogCloudIdle?.();await refresh();
    await window.SentlogRecords.settled();window.SentlogRecords.assertSafe();
    const cp=byLocal(p.id);if(!cp)throw Error('案件の送信がまだ完了していません。「今すぐ同期」を実行してください。');
    if(cp.checking){currentJob=await rpc('inspect',cp.id,{job_id:cp.job_id});openJob();return;}
    const snapshots=await net('sentlog_project_snapshots?project_id=eq.'+encodeURIComponent(cp.id)+'&select=revision,payload');
    const s=snapshots?.[0];if(!s||C.snapshotText(localSnapshot(getProject(p.id)))!==C.snapshotText(s.payload))throw Error('未同期の記録があります。同期を完了してから保管してください。');
    currentJob=await rpc('begin',cp.id,{revision:s.revision});checked.clear();openJob();await refresh();
  }
  async function manual(cp){
    if(cp.checking)throw Error('保管確認中です。先に確認を完了、または中止してください。');
    tell('この案件だけ同期を確認しています…');
    await window.sentlogCloudIdle?.();await window.sentlogArchiveSync?.({manualProject:cp.id});await window.sentlogCloudIdle?.();
    const local=getProject(cp.client_key);
    if(!local)throw Error('案件の記録を受信できません。通信と同期状況を確認してください。');
    if(cp.job_id){const job=await rpc('inspect',cp.id,{job_id:cp.job_id});try{await prove(job);}catch(e){throw Error('手動同期の確認：'+e.message+' PCの控えからの案件復旧は次の段階で追加します。');}}
    tell('選んだ案件の同期を確認しました。保管中の自動同期は停止したままです。');renderProjects();
  }
  async function reopen(cp){
    if(!navigator.onLine)throw Error('オンラインで操作してください。');
    if(!confirm('この案件を全端末で使用中に戻し、自動同期を再開します。PCの控えは残します。'))return;
    await rpc('reopen',cp.id);await refresh();archiveView=false;showProjects();tell('使用中に戻しました。');
    await window.sentlogArchiveSync?.();
  }
  function renderJob(){
    const box=document.getElementById('slArchiveJobBody');if(!box||!currentJob)return;
    const ready=C.readiness(currentJob);box.replaceChildren();
    const h=document.createElement('p');h.textContent='まだ保管には移していません。確認中は対象案件への送信を一時停止します。データは消しません。';box.append(h);
    const p=document.createElement('p');p.textContent=ready.ready?'全端末と会社PCの確認が揃いました。下のボタンで保管を確定できます。':ready.reasons.join('\n');p.style.whiteSpace='pre-wrap';box.append(p);
    const note=document.createElement('p');note.className='muted';note.textContent='過去の端末登録も、未確認のまま無視しません。使わなくなった登録がある場合は、未送信のデータがないことを確認してから整理が必要です。10分で確認は失効します。';box.append(note);
    const done=document.getElementById('slArchiveFinalize');done.disabled=!ready.ready||currentJob.initiator!==device();
  }
  function openJob(){let dialog=document.getElementById('slArchiveDialog');if(!dialog){
    dialog=document.createElement('dialog');dialog.id='slArchiveDialog';dialog.setAttribute('aria-labelledby','slArchiveDialogTitle');
    const h=document.createElement('h2');h.id='slArchiveDialogTitle';h.textContent='保管前の安全確認';
    const b=document.createElement('div');b.id='slArchiveJobBody';const msg=document.createElement('p');msg.id='slArchiveDialogMsg';msg.setAttribute('role','status');
    const finish=createButton('確認済みの案件を保管へ移す',()=>action(async()=>{try{await rpc('finalize',currentJob.project_id,{job_id:currentJob.id});dialog.close();currentJob=null;await refresh();tell('保管へ移しました。全端末に反映され、自動同期は停止します。PDF・写真は端末に残しています。');}catch(e){msg.textContent=e.message;}}));finish.id='slArchiveFinalize';
    const recheck=createButton('再確認',()=>action(async()=>{checked.clear();await refresh();currentJob=await rpc('inspect',currentJob.project_id,{job_id:currentJob.id});renderJob();}));
    const cancel=createButton('確認を中止して使用中のままにする',()=>action(async()=>{await rpc('cancel',currentJob.project_id,{job_id:currentJob.id});dialog.close();currentJob=null;checked.clear();await refresh();tell('保管の確認を中止しました。使用中のままです。');}));
    const close=createButton('閉じる（確認は継続）',()=>dialog.close());dialog.append(h,b,msg,finish,recheck,cancel,close);document.body.append(dialog);
    dialog.addEventListener('close',()=>{const e=document.getElementById('slArchiveMessage');if(e&&currentJob)e.textContent='保管を確認中です。「保管を確認」から続けられます。';});
  }renderJob();if(!dialog.open)dialog.showModal();}
  function renderBanner(){
    const banner=document.getElementById('slArchiveProjectBanner');if(!banner)return;
    const c=byLocal(activeProjectId);banner.replaceChildren();banner.hidden=!c||(!c.checking&&c.status!=='archived');
    if(banner.hidden)return;
    const label=document.createElement('span');label.textContent=c.checking?'保管の安全確認中です。図面を閉じてください。未同期があれば確認を中止してください。':'保管中・自動同期停止。この段階では閲覧のみです。編集する場合は「使用中に戻す」を選んでください。';
    banner.append(label);
    if(c.status==='archived')banner.append(createButton('使用中に戻す',()=>action(()=>reopen(c))));
    else banner.append(createButton('保管を確認',()=>action(async()=>{currentJob=await rpc('inspect',c.id,{job_id:c.job_id});openJob();})));
  }
  function locked(){const c=byLocal(activeProjectId);return !!c&&(c.status==='archived'||c.checking);}
  async function install(){
    await window.sentlogAppReady;account();
    const shell=document.querySelector('#projectsView .manager-shell');if(!shell)return;
    const style=document.createElement('style');style.textContent=`
.sl-archive-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:14px 0}.sl-archive-tools h2{margin:0;font-size:17px}.sl-archive-tools button,.sl-archive-actions button{min-height:44px;font-size:12px;width:auto}.sl-archive-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}.sl-archive-main{width:100%;text-align:left;background:transparent;border:0;padding:0;color:inherit}.sl-archive-folder{background:#f0f5fa;border:1px dashed #94a3b8;min-height:130px}.sl-archive-hint{font-size:12px;line-height:1.6;color:#475569}#slArchiveMessage,#slArchiveProjectBanner{font-size:13px;line-height:1.65;white-space:pre-wrap}#slArchiveProjectBanner{background:#fff7ed;padding:10px;margin:8px 12px;border:1px solid #fed7aa;border-radius:8px}#slArchiveProjectBanner[hidden]{display:none}#slArchiveDialog{box-sizing:border-box;width:min(600px,calc(100vw - 24px));max-height:85vh;overflow:auto;border:1px solid #cbd5e1;border-radius:14px;padding:20px;color:#111827;background:#fff;font:14px/1.7 system-ui}#slArchiveDialog::backdrop{background:#0008}#slArchiveDialog h2{font-size:19px}#slArchiveDialog button{display:block;width:100%;min-height:44px;margin-top:10px}#slArchiveDialog .muted{font-size:12px;color:#64748b}`;document.head.append(style);
    const tools=document.createElement('div');tools.className='sl-archive-tools';const title=document.createElement('h2');title.id='slArchiveListTitle';title.textContent='使用中の案件';
    const back=createButton('← 案件一覧へ',()=>{archiveView=false;renderProjects();});back.id='slArchiveBack';back.hidden=true;tools.append(title,back);
    const msg=document.createElement('p');msg.id='slArchiveMessage';msg.setAttribute('role','status');shell.querySelector('#projectsGrid').before(tools,msg);
    const banner=document.createElement('div');banner.id='slArchiveProjectBanner';banner.hidden=true;document.querySelector('header')?.after(banner);
    renderProjects=function(){
      const grid=document.getElementById('projectsGrid');grid.replaceChildren();
      title.textContent=archiveView?'保管':'使用中の案件';back.hidden=!archiveView;
      const all=new Map((workspace.projects||[]).map(p=>[p.id,p]));
      if(archiveView)for(const cp of controls.filter(c=>c.status==='archived'))if(!all.has(cp.client_key))all.set(cp.client_key,{id:cp.client_key,name:cp.name,drawings:[]});
      const items=[...all.values()].filter(p=>(byLocal(p.id)?.status==='archived')===archiveView).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
      const empty=document.getElementById('projectsEmpty');empty.classList.toggle('hidden',items.length>0);if(archiveView)empty.textContent='保管中の案件はありません。';else empty.textContent='使用中の案件はありません。「新しい案件」から追加できます。';
      for(const p of items){const cp=byLocal(p.id),card=document.createElement('article');card.className='manager-card';
        const open=createButton('',()=>action(async()=>{if(!getProject(p.id)){if(!cp)throw Error('案件を確認できません。');await manual(cp);}showDrawings(p.id);renderBanner();}));open.className='sl-archive-main';
        const icon=document.createElement('div');icon.className='manager-folder';icon.textContent='📁';const name=document.createElement('div');name.className='manager-card-title';name.textContent=p.name;
        const detail=document.createElement('div');detail.className='sl-archive-hint';detail.textContent=cp?.checking?'保管確認中（まだ使用中）':archiveView?'保管中・手動同期／端末データは保持':'自動同期';open.append(icon,name,detail);card.append(open);
        const actions=document.createElement('div');actions.className='sl-archive-actions';
        if(archiveView){actions.append(createButton('この案件を手動同期',()=>action(()=>manual(cp))),createButton('使用中に戻す',()=>action(()=>reopen(cp))));}
        else actions.append(createButton(cp?.checking?'保管を確認':'保管へ移す',()=>action(()=>start(p))));
        card.append(actions);grid.append(card);
      }
      if(!archiveView){const folder=createButton('',()=>{archiveView=true;tell('保管中は自動同期を停止します。この版では端末のデータは削除しません。');renderProjects();});folder.className='manager-card sl-archive-folder';const text=document.createElement('strong');text.textContent='📁 保管';const count=document.createElement('p');count.textContent=controls.filter(c=>c.status==='archived').length+'件';folder.append(text,count);grid.append(folder);}
    };
    // Guard edits, not reads, without removing/replacing existing data.
    for(const name of ['addShape','addPhotosToSelected','removeSelectedPhoto','createDrawingFromFile','savePageSettings','resetPageSettings']){
      try{const old=window[name];if(typeof old==='function')window[name]=function(){if(locked()){tell('この案件は保管中、または保管確認中です。編集前に使用中へ戻してください。');return;}return old.apply(this,arguments);};}catch{}
    }
    document.addEventListener('click',event=>{if(!locked())return;const el=event.target.closest('button');if(!el)return;
      if(['applyBtn','deleteBtn','undoBtn','redoBtn','cameraBtn','photoAddBtn','clearBtn','rotateLeftBtn','rotateRightBtn','pageSettingsSideBtn'].includes(el.id)||el.dataset.tool||el.closest('.photo-del')){event.preventDefault();event.stopImmediatePropagation();tell('保管中は変更しません。使用中に戻して編集してください。');}},true);
    document.addEventListener('pointerdown',event=>{if(!locked()||!event.target.closest('#stageWrap'))return;const hit=event.target.closest('[data-id]');if(tool!=='pan'||hit){event.preventDefault();event.stopImmediatePropagation();if(hit&&typeof selectShape==='function')selectShape(hit.dataset.id);}},true);
    document.addEventListener('keydown',event=>{if(locked()&&((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())||['Delete','Backspace'].includes(event.key)&&event.target.closest('#editorView')&&!event.target.matches('input,textarea'))){event.preventDefault();event.stopImmediatePropagation();}},true);
    document.addEventListener('change',event=>{if(locked()&&event.target.matches('#leaderMarkerSelect,#inspector input,#inspector select,#inspector textarea')){event.stopImmediatePropagation();if(typeof selected!=='undefined'&&selected&&typeof selectShape==='function')selectShape(selected);if(event.target.id==='leaderMarkerSelect')event.target.value=state.leaderMarker||'open-circle';}},true);
    for(const id of ['fileInput','drawingAddInput','cameraInput','photoInput'])document.getElementById(id)?.addEventListener('change',event=>{if(locked()){event.stopImmediatePropagation();event.target.value='';tell('保管中のファイル変更は停止しています。');}},true);
    const oldDrawings=showDrawings;showDrawings=function(){const result=oldDrawings.apply(this,arguments);renderBanner();return result;};
    const oldProjects=showProjects;showProjects=function(){const result=oldProjects.apply(this,arguments);renderBanner();return result;};
    installed=true;renderProjects();
  }
  window.SentlogArchive={refresh,canSync,includeLocal,isAuto,byCloud,byLocal,get ready(){return fresh;},core:C};
  install().catch(e=>console.error('Archive UI',e));
  window.addEventListener('online',()=>refresh().catch(()=>{}));
})();

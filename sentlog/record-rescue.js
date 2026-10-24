/* SentlogRecordRescue v1.95: visible single-project local rescue. */
(function(root){
  'use strict';
  if(!root.document||root.SentlogRecordRescue)return;
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
  const getWorkspace=()=>JSON.parse(root.SentlogRecords.getItem(WS)||'{"projects":[]}');
  const clone=x=>JSON.parse(JSON.stringify(x));
  const safe=v=>String(v||'案件').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim()||'案件';
  function stamp(){const d=new Date(),p=n=>String(n).padStart(2,'0');return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());}
  async function build(projectId){
    await root.SentlogRecords.settled();root.SentlogRecords.assertSafe();
    const full=getWorkspace(),project=(full.projects||[]).find(p=>p.id===projectId);
    if(!project)throw Error('案件が見つかりません。');
    const drawingStates={};let shapes=0,photos=0;
    for(const d of project.drawings||[]){
      const raw=root.SentlogRecords.getItem(DRAW+d.id);if(!raw)continue;
      const state=JSON.parse(raw);drawingStates[d.id]=state;
      const list=Array.isArray(state.shapes)?state.shapes:[];
      shapes+=list.length;photos+=list.reduce((n,s)=>n+(Array.isArray(s.photos)?s.photos.length:0),0);
    }
    return {payload:{format:'sentlog-record-rescue',version:1,exportedAt:new Date().toISOString(),workspace:{...clone(full),projects:[clone(project)]},drawingStates},
      stats:{project:project.name||'案件',projects:1,drawings:Object.keys(drawingStates).length,shapes,photos}};
  }
  async function save(projectId){
    const {payload,stats}=await build(projectId),blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
    const file=new File([blob],'セントログ_'+safe(stats.project)+'_記録救出_'+stamp()+'.json',{type:'application/json',lastModified:Date.now()});
    if(navigator.canShare?.({files:[file]})&&navigator.share)await navigator.share({files:[file],title:'セントログ 記録救出'});
    else{const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
    return stats;
  }
  function chooseProject(){
    const projects=getWorkspace().projects||[];
    if(!projects.length){alert('端末内に案件がありません。');return;}
    const overlay=document.createElement('div');overlay.className='modal-backdrop open';
    const card=document.createElement('div');card.className='modal-card';
    const h=document.createElement('h2');h.textContent='救出する案件を選択';
    const note=document.createElement('div');note.className='hint-box';note.textContent='選んだ案件だけを書き出します。PDF・写真画像そのものは含めず、変状・メモ・写真リンクを保存します。';
    const select=document.createElement('select');for(const p of projects)select.append(new Option(p.name||'案件',p.id));
    const actions=document.createElement('div');actions.className='modal-actions';
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='キャンセル';cancel.onclick=()=>overlay.remove();
    const go=document.createElement('button');go.type='button';go.textContent='この案件だけ保存';go.style.cssText='background:#111827;color:#fff';
    go.onclick=async()=>{go.disabled=true;try{const s=await save(select.value);overlay.remove();alert(s.project+'だけを保存しました。\n図面 '+s.drawings+'枚 / 記録 '+s.shapes+'件 / 写真リンク '+s.photos+'件');}catch(e){if(e?.name!=='AbortError')alert('保存できませんでした。端末内データは変更していません。\n'+(e?.message||e));}finally{go.disabled=false;}};
    actions.append(cancel,go);card.append(h,note,select,actions);overlay.append(card);document.body.append(overlay);
  }
  function install(){
    if(document.getElementById('sentlogRecordRescueBtn'))return;
    const shell=document.querySelector('#projectsView .manager-shell');
    const legacy=document.querySelector('#projectsView .manager-subbar');
    if(!shell&&!legacy)return;
    const b=document.createElement('button');b.id='sentlogRecordRescueBtn';b.type='button';b.className='small';
    b.textContent='緊急：案件を選んで救出';b.style.cssText='border-color:#f59e0b;background:#fffbeb;color:#92400e;min-height:44px;';
    b.onclick=chooseProject;
    if(shell){
      const panel=document.createElement('div');panel.id='sentlogRecordRescuePanel';
      panel.style.cssText='display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;padding:12px 14px;border:1px solid #f59e0b;border-radius:10px;background:#fffbeb;';
      const label=document.createElement('strong');label.textContent='記録救出';
      const note=document.createElement('span');note.className='manager-card-meta';note.textContent='端末内の1案件だけを書き出します';
      panel.append(label,b,note);
      const grid=document.getElementById('projectsGrid');
      if(grid&&grid.parentElement===shell)shell.insertBefore(panel,grid);else shell.append(panel);
    }else legacy.append(b);
  }
  root.SentlogRecordRescue={build,save,install};
  Promise.resolve(root.sentlogAppReady).catch(()=>{}).then(install);
})(typeof globalThis!=='undefined'?globalThis:this);

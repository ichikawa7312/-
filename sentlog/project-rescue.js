/* SentlogProjectRescue v1.95: choose one local project and export records only. */
(function(root){
  'use strict';
  if(!root.document||root.SentlogProjectRescue)return;
  const WS='surveyFieldNoteWorkspaceV1', DRAW='surveyFieldNoteDrawingV1:';
  const clone=x=>JSON.parse(JSON.stringify(x));
  function stamp(){const d=new Date(),p=n=>String(n).padStart(2,'0');return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());}
  function safe(v){return String(v||'案件').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim()||'案件';}
  function workspace(){return JSON.parse(root.SentlogRecords.getItem(WS)||'{"projects":[]}');}
  async function build(projectId){
    await root.SentlogRecords.settled();root.SentlogRecords.assertSafe();
    const full=workspace(),project=(full.projects||[]).find(p=>p.id===projectId);
    if(!project)throw Error('案件が見つかりません。');
    const states={};let shapes=0,photos=0;
    for(const d of project.drawings||[]){
      const raw=root.SentlogRecords.getItem(DRAW+d.id);if(!raw)continue;
      const st=JSON.parse(raw);states[d.id]=st;
      const list=Array.isArray(st.shapes)?st.shapes:[];
      shapes+=list.length;photos+=list.reduce((n,s)=>n+(Array.isArray(s.photos)?s.photos.length:0),0);
    }
    return {payload:{format:'sentlog-project-rescue',version:1,exportedAt:new Date().toISOString(),workspace:{...clone(full),projects:[clone(project)]},drawingStates:states},
      stats:{project:project.name||'案件',drawings:Object.keys(states).length,shapes,photos}};
  }
  async function save(projectId){
    const {payload,stats}=await build(projectId),text=JSON.stringify(payload),blob=new Blob([text],{type:'application/json'});
    const file=new File([blob],'セントログ_'+safe(stats.project)+'_記録救出_'+stamp()+'.json',{type:'application/json',lastModified:Date.now()});
    if(navigator.canShare?.({files:[file]})&&navigator.share)await navigator.share({files:[file],title:'セントログ '+stats.project+' 記録救出'});
    else{const u=URL.createObjectURL(file),a=document.createElement('a');a.href=u;a.download=file.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000);}
    return stats;
  }
  function install(){
    const host=document.querySelector('#projectsView .manager-subbar');
    if(!host||document.getElementById('sentlogProjectRescueBtn'))return;
    const b=document.createElement('button');b.id='sentlogProjectRescueBtn';b.type='button';b.className='small';b.textContent='緊急：案件を選んで救出';
    b.style.cssText='border-color:#f59e0b;background:#fffbeb;color:#92400e;';
    b.onclick=async()=>{
      const projects=workspace().projects||[];
      if(!projects.length){alert('端末内に案件がありません。');return;}
      const overlay=document.createElement('div');overlay.className='modal-backdrop open';
      const card=document.createElement('div');card.className='modal-card';
      const h=document.createElement('h2');h.textContent='救出する案件を選択';
      const note=document.createElement('div');note.className='hint-box';note.textContent='選んだ案件だけを書き出します。PDF・写真画像そのものは含めず、変状・メモ・写真リンクを保存します。クラウド同期は行いません。';
      const select=document.createElement('select');for(const p of projects)select.append(new Option(p.name||'案件',p.id));
      const actions=document.createElement('div');actions.className='modal-actions';
      const cancel=document.createElement('button');cancel.textContent='キャンセル';cancel.onclick=()=>overlay.remove();
      const go=document.createElement('button');go.textContent='この案件だけ保存';go.style.cssText='background:#111827;color:#fff';
      go.onclick=async()=>{go.disabled=true;try{const s=await save(select.value);overlay.remove();alert(s.project+'だけを保存しました。\n図面 '+s.drawings+'枚 / 記録 '+s.shapes+'件 / 写真リンク '+s.photos+'件\n\n共有先で「ファイルに保存」を選んでください。');}catch(e){if(e?.name!=='AbortError')alert('保存できませんでした。端末内データは変更していません。\n'+(e?.message||e));}finally{go.disabled=false;}};
      actions.append(cancel,go);card.append(h,note,select,actions);overlay.append(card);document.body.append(overlay);
    };
    host.append(b);
  }
  root.SentlogProjectRescue={build,save,install};
  Promise.resolve(root.sentlogAppReady).catch(()=>{}).then(install);
})(typeof globalThis!=='undefined'?globalThis:this);

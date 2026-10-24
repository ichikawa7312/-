/* SentlogRecordRescue v2.01: header emergency rescue for project list. */
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
    const oldPanel=document.getElementById('sentlogRecordRescuePanel');if(oldPanel)oldPanel.remove();
    if(document.getElementById('sentlogRecordRescueBtn'))return;
    const header=document.querySelector('header');if(!header)return;
    const b=document.createElement('button');b.id='sentlogRecordRescueBtn';b.type='button';b.className='small';
    b.textContent='緊急救出';b.title='端末内の案件記録を緊急書き出し';b.setAttribute('aria-label',b.title);
    b.style.cssText='border-color:#f59e0b;background:#fffbeb;color:#92400e;min-height:34px;padding:6px 10px;white-space:nowrap;';
    b.onclick=chooseProject;
    const save=document.getElementById('saveStatus');
    if(save)header.insertBefore(b,save);else header.append(b);
    const style=document.createElement('style');style.id='sentlogRecordRescueHeaderStyle';
    style.textContent='#sentlogRecordRescueBtn{display:none}#projectsView:not(.hidden)~*{} body:has(#projectsView:not(.hidden)) #sentlogRecordRescueBtn{display:inline-flex;align-items:center;justify-content:center}@media(max-width:700px){body:has(#projectsView:not(.hidden)) #sentlogRecordRescueBtn{font-size:0;width:54px;min-width:54px;padding:0 7px}body:has(#projectsView:not(.hidden)) #sentlogRecordRescueBtn::after{content:"救出";font-size:11px}}';
    document.head.append(style);
  }
  root.SentlogRecordRescue={build,save,install};
  Promise.resolve(root.sentlogAppReady).catch(()=>{}).then(install);
})(typeof globalThis!=='undefined'?globalThis:this);

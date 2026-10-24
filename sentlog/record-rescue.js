/* SentlogRecordRescue v1.94: small local-only emergency backup via iOS share sheet. */
(function(root){
  'use strict';
  if(!root.document||root.SentlogRecordRescue)return;

  const WORKSPACE_KEY='surveyFieldNoteWorkspaceV1';
  const DRAWING_PREFIX='surveyFieldNoteDrawingV1:';

  function stamp(){
    const d=new Date(),p=n=>String(n).padStart(2,'0');
    return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
  }
  function safeName(value){
    return String(value||'案件').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim()||'案件';
  }
  async function build(){
    await root.SentlogRecords.settled();
    root.SentlogRecords.assertSafe();
    const raw=root.SentlogRecords.getItem(WORKSPACE_KEY);
    if(!raw)throw Error('案件一覧を読み取れません。');
    const workspace=JSON.parse(raw);
    const drawingStates={};
    let shapeCount=0,photoCount=0;
    for(const p of workspace.projects||[])for(const d of p.drawings||[]){
      const stateRaw=root.SentlogRecords.getItem(DRAWING_PREFIX+d.id);
      if(!stateRaw)continue;
      const state=JSON.parse(stateRaw);
      drawingStates[d.id]=state;
      const shapes=Array.isArray(state.shapes)?state.shapes:[];
      shapeCount+=shapes.length;
      photoCount+=shapes.reduce((n,s)=>n+(Array.isArray(s.photos)?s.photos.length:0),0);
    }
    return {
      payload:{
        format:'sentlog-record-rescue',
        version:1,
        exportedAt:new Date().toISOString(),
        workspace,
        drawingStates
      },
      stats:{projects:(workspace.projects||[]).length,drawings:Object.keys(drawingStates).length,shapes:shapeCount,photos:photoCount}
    };
  }
  async function save(){
    const {payload,stats}=await build();
    const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
    const file=new File([blob],'セントログ_緊急記録バックアップ_'+stamp()+'.json',{type:'application/json',lastModified:Date.now()});
    if(navigator.canShare?.({files:[file]})&&navigator.share){
      await navigator.share({files:[file],title:'セントログ 緊急記録バックアップ'});
    }else{
      const url=URL.createObjectURL(file),a=document.createElement('a');
      a.href=url;a.download=file.name;document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),60000);
    }
    return stats;
  }
  function install(){
    const host=document.querySelector('#projectsView .manager-subbar');
    if(!host||document.getElementById('sentlogRecordRescueBtn'))return;
    const b=document.createElement('button');b.id='sentlogRecordRescueBtn';b.type='button';b.className='small';
    b.textContent='緊急：記録だけバックアップ';
    b.style.cssText='border-color:#f59e0b;background:#fffbeb;color:#92400e;';
    b.onclick=async()=>{
      b.disabled=true;const before=b.textContent;b.textContent='記録をまとめています…';
      try{
        const stats=await save();
        alert('緊急バックアップを作成しました。\n案件 '+stats.projects+'件 / 図面 '+stats.drawings+'枚 / 記録 '+stats.shapes+'件 / 写真リンク '+stats.photos+'件\n\n共有先で「ファイルに保存」を選んでください。');
      }catch(e){
        if(e?.name!=='AbortError')alert('緊急バックアップを書き出せませんでした。端末内データは変更していません。\n'+(e?.message||e));
      }finally{b.disabled=false;b.textContent=before;}
    };
    host.append(b);
  }

  root.SentlogRecordRescue={build,save,install};
  Promise.resolve(root.sentlogAppReady).catch(()=>{}).then(install);
})(typeof globalThis!=='undefined'?globalThis:this);

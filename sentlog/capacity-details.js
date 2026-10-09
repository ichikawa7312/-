/* Sentlog v1.39: read-only backup inventory and durable audit timeline. */
(function(){
  'use strict';
  const capacity=window.SentlogCapacity;
  if(!capacity)throw Error('容量整理機能より前に詳細画面を読み込めません。');
  const BASE='https://wiulvaqixphuobdielyy.supabase.co',KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
  const el=(tag,value)=>{const node=document.createElement(tag);if(value!==undefined)node.textContent=value;return node;};
  const bytes=n=>{n=Number(n)||0;return n<1024**2?(n/1024).toFixed(1)+'KB':n<1024**3?(n/1024**2).toFixed(1)+'MB':(n/1024**3).toFixed(2)+'GB';};
  const date=t=>{if(!t)return '記録なし';const d=new Date(t);return Number.isNaN(+d)?'記録なし':d.toLocaleString('ja-JP');};
  const labels={
    project_active:'案件を使用中に変更',project_archived:'案件を保管に変更',
    archive_archived:'案件の保管完了',archive_cancelled:'保管の確認を中止',
    capacity_requested:'容量整理・復旧を申請',capacity_ready:'会社PCの現物照合完了',
    capacity_finished:'端末への操作が完了',capacity_cancelled:'容量整理・復旧を中止',
    reopened_by_device:'使用中へ戻す操作を実行'
  };
  async function summary(id){
    await window.sentlogManagementSession?.();
    const session=JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null');
    const device=localStorage.getItem('sentlogCloudDeviceV1');
    if(!session?.access_token||!device||!session.user?.id)throw Error('ログインと端末登録を確認してください。');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    try{
      const r=await fetch(BASE+'/rest/v1/rpc/sentlog_backup_status_v2',{
        method:'POST',cache:'no-store',signal:controller.signal,
        headers:{apikey:KEY,Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},
        body:JSON.stringify({p_project_id:id,p_device_id:device})
      });
      const j=await r.json().catch(()=>null);
      if(!r.ok)throw Error(j?.message||'バックアップ状況を取得できません。');
      if(session.user.id!==JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null')?.user?.id)
        throw Error('途中でログインが変更されました。');
      return j;
    }catch(e){if(e.name==='AbortError')throw Error('通信の応答が遅いため中止しました。');throw e;}
    finally{clearTimeout(timer);}
  }
  function item(parent,title,text){
    const box=el('div');box.className='sl-detail-line';
    const strong=el('strong',title);const value=el('span',text);
    box.append(strong,value);parent.append(box);
  }
  async function open(cp){
    const d=el('dialog');d.className='sl-details-dialog';
    const title=el('h2','保管状況・操作履歴');
    const note=el('p','会社PCの保管履歴を確認します。表示は過去の照合記録です。PCの実ファイルは、削除・復旧の操作時に再照合します。');
    note.className='sl-detail-note';
    const content=el('div','読み込んでいます…');content.setAttribute('role','status');
    const close=el('button','閉じる');close.type='button';close.onclick=()=>d.close();
    d.append(title,note,content,close);document.body.append(d);
    d.addEventListener('close',()=>d.remove());
    d.showModal();
    try{
      const info=await summary(cp.id);if(!d.open)return;
      content.replaceChildren();const b=info?.backup;
      item(content,'案件',info.name||cp.name||'');
      item(content,'案件の状態',info.retired?'使用終了（不要）':info.status==='archived'?'保管中':'使用中');
      if(b){
        item(content,'最後のPC照合',date(b.last_verified_at));
        item(content,'図面PDF',String(b.pdf_count)+'件');
        item(content,'写真',String(b.photo_count)+'件');
        item(content,'保管ファイル合計',String(b.file_count)+'件／'+bytes(b.total_bytes));
        item(content,'記録の版',String(b.revision)+(b.is_current_revision?'（最新と一致）':'（現在の編集内容と相違）'));
        const hint=el('p','復旧可能性は会社PCの原本・保存権限・空き容量を再確認して判定します。この表示だけで復旧を保証するものではありません。');
        hint.className='sl-detail-note';content.append(hint);
      }else{
        const missing=el('p','PCで照合済みの復旧用バックアップがありません。');missing.className='sl-detail-note';content.append(missing);
      }
      const history=el('h3','操作履歴（最新30件）');content.append(history);
      if(!info.events?.length)content.append(el('p','この版で記録した操作履歴はまだありません。'));
      for(const event of info.events||[]){
        const action=event.detail?.action==='restore'?'復旧':event.detail?.mode==='files'?'PDF・写真整理':'案件一式整理';
        const row=el('div');row.className='sl-detail-event';
        row.append(el('strong',labels[event.type]||'案件の操作'),
          el('small',date(event.at)+' ／ '+(event.device||'端末情報なし')+
          (event.type?.startsWith('capacity_')?' ／ '+action:'')));
        content.append(row);
      }
    }catch(e){if(d.open)content.textContent='表示できませんでした：'+(e.message||String(e));}
  }
  const original=capacity.renderActions;
  capacity.renderActions=function(host,cp,p){
    original(host,cp,p);
    if(!cp||cp.status!=='archived')return;
    const b=el('button','バックアップ・操作履歴を確認');b.type='button';
    b.className='sl-capacity-button';b.onclick=()=>open(cp);host.append(b);
  };
  const style=el('style');
  style.textContent='.sl-details-dialog{box-sizing:border-box;width:min(580px,calc(100vw - 24px));max-height:85vh;overflow:auto;border-radius:12px;padding:18px;background:#fff;color:#0f172a;border:1px solid #94a3b8;font:14px/1.7 system-ui}.sl-details-dialog::backdrop{background:#0009}.sl-details-dialog h2{font-size:18px;margin:0 0 12px}.sl-details-dialog h3{font-size:14px;margin:20px 0 8px}.sl-details-dialog button{min-height:44px;margin-top:18px;width:100%}.sl-detail-note{font-size:12px;color:#475569}.sl-detail-line{padding:7px 0;display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #e2e8f0}.sl-detail-line span{text-align:right;overflow-wrap:anywhere}.sl-detail-event{display:flex;flex-direction:column;gap:2px;border-bottom:1px solid #e2e8f0;padding:8px 0}.sl-detail-event small{color:#64748b;overflow-wrap:anywhere}';
  document.head.append(style);
  window.SentlogDetails={open,summary};
  Promise.resolve(window.sentlogAppReady).then(()=>{if(typeof renderProjects==='function')renderProjects();}).catch(()=>{});
})();

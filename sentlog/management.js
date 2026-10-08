/* v1.35 management. Reversible classification and device settings; no data deletion. */
(function(){
  'use strict';
  const BASE='https://wiulvaqixphuobdielyy.supabase.co';
  const KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
  const session=()=>{try{return JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null');}catch{return null;}};
  const device=()=>localStorage.getItem('sentlogCloudDeviceV1');
  let listFlight=null,rows=[],requestNo=0;
  async function rpc(action,project=null,payload={}){
    if(!navigator.onLine)throw Error('通信できる状態で操作してください。');
    if(window.sentlogManagementSession)await window.sentlogManagementSession();
    const s=session();if(!s?.access_token||!s?.user?.id)throw Error('ログインしてから操作してください。');
    const actor=device(),owner=s.user.id,c=new AbortController(),timeout=setTimeout(()=>c.abort(),20000);
    try{
      const response=await fetch(BASE+'/rest/v1/rpc/sentlog_management_v1',{
        method:'POST',cache:'no-store',signal:c.signal,
        headers:{apikey:KEY,Authorization:'Bearer '+s.access_token,'Content-Type':'application/json'},
        body:JSON.stringify({p_action:action,p_project_id:project,p_device_id:actor,p_data:payload})
      });
      const data=await response.json().catch(()=>null);
      if(!response.ok)throw Error(data?.message||'管理操作を完了できませんでした。');
      if(owner!==session()?.user?.id||actor!==device())throw Error('ログイン情報が変わりました。画面を開き直して結果を確認してください。');
      return data;
    }catch(error){
      if(error.name==='AbortError')throw Error('通信の結果を確認できません。処理済みの可能性があるため、一覧を再確認してください。');
      throw error;
    }finally{clearTimeout(timeout);}
  }
  function button(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;return b;}
  function paragraph(text){const p=document.createElement('p');p.textContent=text;return p;}
  function openDecision({title,description,confirmText,checkboxText,run}){
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='sl-management-dialog';
      const heading=document.createElement('h2');heading.textContent=title;
      const desc=paragraph(description);desc.style.whiteSpace='pre-wrap';
      const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';
      label.className='sl-management-confirm';label.append(input,document.createTextNode(checkboxText));
      const msg=paragraph('');msg.className='sl-management-error';msg.setAttribute('role','status');msg.setAttribute('aria-live','polite');
      let busy=false,finished=false;
      const cancel=button('やめる',()=>dialog.close());
      const ok=button(confirmText,async()=>{
        if(busy||!input.checked)return;busy=true;ok.disabled=true;cancel.disabled=true;input.disabled=true;msg.textContent='処理しています…';
        try{await run();finished=true;dialog.close();}
        catch(e){msg.textContent=e.message||String(e);}
        finally{busy=false;if(dialog.isConnected){ok.disabled=!input.checked;cancel.disabled=false;input.disabled=false;}}
      });ok.disabled=true;input.onchange=()=>{ok.disabled=!input.checked;};
      dialog.append(heading,desc,label,msg,ok,cancel);document.body.append(dialog);
      dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
      dialog.addEventListener('close',()=>{dialog.remove();resolve(finished);},{once:true});
      dialog.showModal();cancel.focus();
    });
  }
  async function refreshArchive(){
    await window.SentlogArchive.refresh();
    if(typeof renderProjects==='function')renderProjects();
  }
  async function retire(local){
    const cp=window.SentlogArchive.byLocal(local.id);
    if(!cp)throw Error('案件の登録が未確認です。同期後に、もう一度操作してください。');
    const done=await openDecision({title:'「'+cp.name+'」を使用終了にする',
      description:'全端末の使用中一覧から外し、自動同期とPDFの再取得を止めます。\n残っている記録・写真・PDFやPCのファイルは消しません。容量は減りません。\n資料一式が揃った「保管」とは異なります。すでに削除されたPDFや未同期のデータを、バックアップ済みとは扱いません。',
      checkboxText:'案件全体が不要で、不足ファイルの復旧が保証されないことを確認しました。',confirmText:'削除せずに使用終了にする',
      run:async()=>{await rpc('project_retire',cp.id,{confirm_name:cp.name,confirmed:true});await refreshArchive();}
    });
    if(done)document.getElementById('slArchiveMessage').textContent='使用終了にしました。「保管」に表示します。残っているデータは削除していません。';
  }
  async function resume(cp){
    const done=await openDecision({title:'「'+cp.name+'」を使用中に戻す',
      description:'全端末で使用中に戻し、自動同期を再開します。\nこの操作は、紛失・削除したファイルを復元するものではありません。不足ファイルの案内が再び表示される場合があります。',
      checkboxText:'不足ファイルが自動復旧されないことを確認しました。',confirmText:'使用中に戻す',
      run:async()=>{await rpc('project_resume',cp.id,{confirm_name:cp.name,confirmed:true});await refreshArchive();}
    });
    if(done)document.getElementById('slArchiveMessage').textContent='使用中に戻しました。不足ファイルがないか確認してください。';
  }
  async function deviceAction(row,action){
    if(action==='device_rename'){
      const name=prompt('端末名を入力してください（1～120文字）。',row.name);
      if(name===null)return;
      if(!name.trim()||name.trim().length>120)throw Error('端末名を1～120文字で入力してください。');
      await rpc(action,null,{device_id:row.id,name:name.trim()});
    }else{
      const stopping=action==='device_stop';
      const done=await openDecision({title:'「'+row.name+'」の登録を'+(stopping?'停止':'再開')+'する',
        description:stopping?'この登録の自動同期を止め、今後の保管確認の対象から外します。\n端末内の写真・PDF・記録やPCの控えは削除しません。未送信データは、こちらからは確認できない場合があります。\n保管確認が進行中なら、その確認を中止してやり直せる状態にします。\nこれはアカウントのログアウトやアクセス権の取り消しではありません。すべての端末を最新版に更新してください。':'この登録の同期を再開し、保管確認の対象に戻します。\n進行中の保管確認は、端末構成が変わるためやり直しになります。',
        checkboxText:stopping?'対象の登録を確認し、必要な未送信データが残っていないことを確認しました。':'この端末登録を再開することを確認しました。',confirmText:stopping?'この登録を停止する':'この登録を再開する',
        run:()=>rpc(action,null,{device_id:row.id,confirmed:true})
      });if(!done)return;
    }
    await loadDevices();await refreshArchive();
  }
  function formatDate(value){const n=Date.parse(value);return Number.isFinite(n)?new Date(n).toLocaleString('ja-JP'):'記録なし';}
  function renderDevices(){
    const list=document.getElementById('slDeviceList');if(!list)return;list.replaceChildren();
    const id=device(),pc=localStorage.getItem('sentlogPcWebDeviceV1');
    const totals=document.getElementById('slDeviceCounts');totals.textContent='使用中 '+rows.filter(r=>r.active).length+'件 ／ 停止中 '+rows.filter(r=>!r.active).length+'件';
    for(const row of rows){
      const item=document.createElement('article');item.className='sl-device-row';item.dataset.deviceId=row.id;
      const name=document.createElement('strong');name.textContent=row.name+(row.id===id?'（この端末）':row.id===pc?'（このブラウザのPC自動同期）':'');
      const info=paragraph((row.active?'使用中':'停止中')+' ／ '+({iphone:'iPhone',ipad:'iPad',pc:'PC自動同期',browser:'ブラウザ'}[row.type]||'その他')+'\n最終接続：'+formatDate(row.last_seen_at)+'\n登録日：'+formatDate(row.created_at)+'\n登録番号：'+row.id.slice(0,8));
      const actions=document.createElement('div');actions.className='sl-device-actions';
      const error=paragraph('');error.className='sl-management-error';error.setAttribute('role','status');
      let busy=false;const doAction=action=>async()=>{if(busy)return;busy=true;error.textContent='';for(const b of actions.children)b.disabled=true;try{await deviceAction(row,action);}catch(e){error.textContent=e.message||String(e);}finally{busy=false;if(item.isConnected){for(const b of actions.children)b.disabled=false;if(row.active&&row.id===id)actions.lastChild.disabled=true;}}};
      const rename=button('名前を変更',doAction('device_rename'));
      const active=button(row.active?'登録を停止':'登録を再開',doAction(row.active?'device_stop':'device_resume'));
      if(row.active&&row.id===id){active.disabled=true;active.title='今操作している端末は別の端末から停止してください。';}
      actions.append(rename,active);item.append(name,info,actions,error);list.append(item);
    }
    if(!rows.length)list.append(paragraph('このアカウントの登録端末はありません。'));
  }
  async function loadDevices(){
    if(listFlight)return listFlight;
    const msg=document.getElementById('slDeviceMessage'),refresh=document.getElementById('slDeviceRefresh');
    const generation=++requestNo;
    msg.textContent='登録端末を確認しています…';refresh.disabled=true;
    document.getElementById('slDeviceList').replaceChildren();document.getElementById('slDeviceCounts').textContent='';
    listFlight=(async()=>{try{
      const result=await rpc('device_list');if(!Array.isArray(result))throw Error('登録端末を確認できません。');
      if(generation!==requestNo)return;rows=result;renderDevices();msg.textContent='';
    }catch(e){rows=[];msg.textContent=e.message||String(e);throw e;}finally{listFlight=null;refresh.disabled=false;}})();return listFlight;
  }
  async function install(){
    await window.sentlogAppReady;
    const backup=document.getElementById('sentlogBackupSection');if(!backup||document.getElementById('slDeviceSection'))return;
    const style=document.createElement('style');style.textContent=`
#slDeviceSection{border:1px solid #d1d5db;border-radius:10px;padding:0 14px;margin-bottom:12px;text-align:left}#slDeviceSection summary{padding:12px 0;min-height:44px;font-size:14px;font-weight:600;cursor:pointer}#slDeviceSection p{font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}#slDeviceSection .sl-device-row{border-top:1px solid #e5e7eb;padding:14px 0}#slDeviceSection strong{font-size:13px;overflow-wrap:anywhere}.sl-device-actions{display:flex;flex-wrap:wrap;gap:8px}#slDeviceSection button{min-height:44px;font-size:12px;width:auto}#slDeviceMessage,.sl-management-error{color:#991b1b;white-space:pre-wrap;overflow-wrap:anywhere}.sl-management-dialog{box-sizing:border-box;width:min(520px,calc(100vw - 24px));max-height:90vh;overflow-y:auto;border:1px solid #cbd5e1;border-radius:14px;padding:20px;background:white;color:#111827;font:14px/1.65 system-ui;text-align:left}.sl-management-dialog::backdrop{background:#0008}.sl-management-dialog h2{font-size:18px}.sl-management-dialog button{display:block;width:100%;min-height:44px;margin-top:12px}.sl-management-confirm{display:flex;align-items:flex-start;gap:10px;margin:16px 0;font-size:13px}.sl-management-confirm input{width:20px;height:20px;flex:0 0 20px;margin:2px 0;accent-color:#1f2937}.sl-management-dialog button:disabled{opacity:.45}
`;document.head.append(style);
    const section=document.createElement('details');section.id='slDeviceSection';
    const summary=document.createElement('summary');summary.textContent='登録端末';
    const help=paragraph('同じ端末でも、ブラウザや登録し直しにより別の登録が残る場合があります。登録番号と最終接続を見て、1件ずつ整理してください。\n停止してもデータは消しません。アカウントのログアウト機能ではありません。古い版は先に更新してください。');
    const counts=paragraph('');counts.id='slDeviceCounts';const msg=paragraph('');msg.id='slDeviceMessage';msg.setAttribute('role','status');
    const refresh=button('登録端末を再確認',()=>loadDevices().catch(()=>{}));refresh.id='slDeviceRefresh';
    const list=document.createElement('div');list.id='slDeviceList';section.append(summary,help,refresh,msg,counts,list);backup.before(section);
    section.addEventListener('toggle',e=>{if(e.target===section&&section.open)loadDevices().catch(()=>{});});
    document.getElementById('sentlogSettingsBtn')?.addEventListener('click',()=>{if(section.open)loadDevices().catch(()=>{});});
  }
  window.SentlogManagement={retire,resume,loadDevices};
  install().catch(e=>console.error('Device settings',e));
})();

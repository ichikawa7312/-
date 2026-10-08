/* v1.30: capacity and durability diagnostics live under Settings. */
(function () {
  'use strict';
  const store=window.SentlogRecords;
  const modal=document.querySelector('#sentlogSettingsModal .modal-card');
  if(!store||!modal||document.getElementById('sentlogStorageSection'))return;
  const style=document.createElement('style');
  style.textContent=`
#saveStatus{display:none!important;}
.sentlog-phone header{grid-template-columns:auto minmax(0,1fr);}
.sentlog-phone #headerTitle{grid-column:2;}
@media (orientation:landscape) and (max-height:500px){.sentlog-phone header{grid-template-columns:auto minmax(0,1fr) auto 120px;} .sentlog-phone #sentlogCloudStatus{grid-column:4;}}
#sentlogStorageSection{border:1px solid var(--line);border-radius:10px;padding:0 14px;margin-bottom:12px;}
#sentlogStorageSection summary{padding:12px 0;min-height:48px;font-size:14px;font-weight:600;cursor:pointer;}
#sentlogStorageSection p{font-size:12px;line-height:1.65;margin:10px 0;color:#4b5563;overflow-wrap:anywhere;}
#sentlogStorageRows{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;font-size:12px;margin:14px 0;line-height:1.5;}
#sentlogStorageRows dt,#sentlogStorageRows dd{margin:0;}#sentlogStorageRows dd{text-align:right;font-variant-numeric:tabular-nums;}
#sentlogStorageSection progress{display:block;width:100%;height:12px;margin:8px 0;}
#sentlogStorageSection .sl-storage-actions{display:flex;flex-wrap:wrap;gap:8px;padding-bottom:12px;}
#sentlogStorageSection button{font-size:12px;padding:8px 10px;}
#sentlogStorageWarning{position:fixed;z-index:11000;bottom:calc(8px + env(safe-area-inset-bottom,0px));left:12px;right:12px;max-width:740px;margin:0 auto;padding:14px;border:2px solid #b91c1c;border-radius:12px;background:#fff1f2;color:#881337;box-shadow:0 4px 20px #0003;font-size:13px;line-height:1.6;}
#sentlogStorageWarning[hidden]{display:none!important;}#sentlogStorageWarning p{margin:6px 0;}
#sentlogStorageWarning button{margin:6px 6px 0 0;min-height:44px;font-size:12px;}
`;
  document.head.appendChild(style);
  const section=document.createElement('details');section.id='sentlogStorageSection';
  section.innerHTML=`<summary>保存容量</summary>
<p><b>記録の保存先：IndexedDB（大容量の保存領域）</b><br>案件・変状・メモ・図面ごとの設定を保存します。PDF・写真も同じ保存領域を使用します。</p>
<p id="sentlogMigrationInfo"></p><dl id="sentlogStorageRows"></dl>
<p id="sentlogQuotaInfo">容量は、この画面を開いたときに計測します。</p>
<progress id="sentlogQuotaProgress" max="100" hidden></progress>
<p>ブラウザの使用量・上限は同じサイトの他のデータやキャッシュも含む概算です。上限分の空き容量が確保されているわけではありません。</p>
<p id="sentlogPersistenceInfo"></p>
<p>「保護済み」でも、端末の故障・サイトデータの手動削除は防げません。大切な記録はバックアップも残してください。</p>
<div class="sl-storage-actions"><button type="button" id="sentlogStorageRefresh">容量を再確認</button><button type="button" id="sentlogStorageProtect">保存データの保護を要求</button></div>`;
  modal.querySelector('#sentlogBackupSection').before(section);
  const rows=section.querySelector('#sentlogStorageRows'),quota=section.querySelector('#sentlogQuotaInfo');
  const progress=section.querySelector('progress'),refresh=section.querySelector('#sentlogStorageRefresh');
  const protection=section.querySelector('#sentlogPersistenceInfo'),protect=section.querySelector('#sentlogStorageProtect');
  const bytes=n=>{if(!Number.isFinite(n))return '取得不可';if(n<1024)return Math.round(n)+' B';if(n<1024**2)return (n/1024).toFixed(1)+' KB';if(n<1024**3)return (n/1024**2).toFixed(1)+' MB';return (n/1024**3).toFixed(2)+' GB';};
  function row(name,value){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;rows.append(dt,dd);}
  let measuring=false;
  async function update(){
    if(measuring)return;measuring=true;refresh.disabled=true;
    try{
      const sizes=await store.stats();rows.replaceChildren();
      row('案件・変状などの記録',bytes(sizes.records));
      row('PDF・図面（'+sizes.drawingCount+'件）',bytes(sizes.drawings));
      row('写真（'+sizes.photoCount+'枚）',bytes(sizes.photos));
      row('移行前の控え',bytes(sizes.archive));
      if(sizes.other)row('その他のファイル',bytes(sizes.other));
      row('セントログ内データ量（目安）',bytes(sizes.records+sizes.drawings+sizes.photos+sizes.archive+sizes.other));
      section.querySelector('#sentlogMigrationInfo').textContent='大容量保存への移行：完了。移行前の記録の控えも端末内に保持しています。';
      let estimate=null;try{estimate=await navigator.storage?.estimate?.();}catch(_){}
      if(estimate && Number.isFinite(estimate.usage) && estimate.quota>0){
        const ratio=Math.min(100,Math.max(0,100*estimate.usage/estimate.quota));
        quota.textContent='ブラウザ全体ではなく、このサイトの使用量（概算）：'+bytes(estimate.usage)+' ／ 上限（概算） '+bytes(estimate.quota)+(ratio>=80?'。使用率が高くなっています。バックアップを確認してください。':'');
        progress.hidden=false;progress.value=ratio;progress.setAttribute('aria-label','このサイトの使用率（概算） '+ratio.toFixed(1)+'%');
      }else{quota.textContent='このブラウザでは保存枠の上限を取得できません。上記はセントログ内のデータ量の目安です。';progress.hidden=true;}
      let persisted=null;try{persisted=await navigator.storage?.persisted?.();}catch(_){}
      protection.textContent='ブラウザによる自動削除への保護：'+(persisted===true?'保護済み':persisted===false?'通常保存（保護未承認）':'確認できません');
      protect.disabled=!navigator.storage?.persist || persisted===true;
      refresh.textContent='容量を再確認';
    }catch(error){quota.textContent='容量を確認できませんでした：'+(error.message||error);}
    finally{measuring=false;refresh.disabled=false;}
  }
  section.addEventListener('toggle',()=>{if(section.open)update();});refresh.onclick=update;
  protect.onclick=async()=>{
    protect.disabled=true;
    try{const granted=await navigator.storage.persist();await update();if(!granted)protection.textContent='保護は今回は承認されませんでした。通常保存とバックアップは引き続き利用できます。';}
    catch(error){protection.textContent='保護を要求できませんでした：'+(error.message||error);protect.disabled=false;}
  };
  const warning=document.createElement('aside');warning.id='sentlogStorageWarning';warning.hidden=true;warning.setAttribute('role','alert');
  warning.innerHTML='<strong>この端末に保存できていないデータがあります</strong><p class="message"></p><p>画面を閉じたり更新したりせず、端末の空き容量を確認してください。</p><button type="button" class="retry">記録を再保存</button><button type="button" class="rescue">未保存の記録を含む控えを書き出す</button>';
  document.body.appendChild(warning);
  const retry=warning.querySelector('.retry'),rescue=warning.querySelector('.rescue');
  function showFailure(){
    warning.hidden=!store.failed;
    if(store.failed){
      const messages=store.issues.map(([key,msg])=>(key.startsWith('file:')?'PDF・写真の保存：':key==='records'?'変状・案件の保存：':'復元の確認：')+msg);
      const content=messages.join(' ／ ')+(store.issues.some(([k])=>k.startsWith('file:'))?' PDF・写真は、空き容量を確保してから同じ操作で追加し直してください。':'');
      const label=warning.querySelector('.message');if(label.textContent!==content)label.textContent=content;
    }
  }
  store.subscribe(showFailure);showFailure();
  retry.onclick=async()=>{retry.disabled=true;try{await store.retry();}catch(_){}finally{retry.disabled=false;showFailure();}};
  rescue.onclick=async()=>{rescue.disabled=true;try{await exportSentlogBackup({allowPending:true});}catch(e){warning.querySelector('.message').textContent+=' 控えの書き出しも完了していません：'+e.message;}finally{rescue.disabled=false;}};
  window.addEventListener('beforeunload',event=>{if(store.pending||store.failed){event.preventDefault();event.returnValue='';}});
})();

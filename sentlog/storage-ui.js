/* v1.32: always compare used space against browser quota. Display only. */
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
#sentlogStorageSection{border:1px solid var(--line);border-radius:10px;padding:0 14px;margin-bottom:12px;text-align:left;}
#sentlogStorageSection summary{padding:12px 0;min-height:48px;font-size:14px;font-weight:600;cursor:pointer;}
#sentlogStorageSection p{font-size:12px;line-height:1.65;margin:8px 0;color:#4b5563;overflow-wrap:anywhere;}
#sentlogStorageSection [hidden]{display:none!important;}
#sentlogStorageSection .sl-storage-total{font-size:30px;line-height:1.25;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:#111827;margin:2px 0 14px;}
#sentlogStorageSection .sl-storage-total small{font-size:12px;font-weight:400;letter-spacing:0;display:block;margin-top:4px;color:#6b7280;}
#sentlogStorageSection .sl-storage-bar-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px;font-size:12px;margin:14px 0 8px;}
#sentlogStorageSection .sl-storage-usage{font-weight:600;font-variant-numeric:tabular-nums;}
#sentlogStorageBar{display:flex;direction:ltr;isolation:isolate;width:100%;height:26px;overflow:hidden;border-radius:8px;background:#edf0f3;box-shadow:inset 0 0 0 1px #cbd5e1;}
#sentlogStorageBar .sl-storage-used{display:flex;height:100%;min-width:0;flex:0 0 auto;overflow:hidden;}
#sentlogStorageBar .sl-storage-segment{height:100%;min-width:0;flex:0 0 auto;transition:none;}
#sentlogStorageSection [data-category="records"]{--sl-storage-color:#2563eb;}
#sentlogStorageSection [data-category="drawings"]{--sl-storage-color:#0d9488;}
#sentlogStorageSection [data-category="photos"]{--sl-storage-color:#e99717;}
#sentlogStorageSection [data-category="archive"]{--sl-storage-color:#64748b;}
#sentlogStorageSection [data-category="other"]{--sl-storage-color:#8b5cf6;}
#sentlogStorageBar .sl-storage-segment,#sentlogStorageSection .sl-storage-dot{background:var(--sl-storage-color);}
#sentlogStorageSection .sl-storage-legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 10px;margin:16px 0;padding:0;list-style:none;}
#sentlogStorageSection .sl-storage-legend li{display:grid;grid-template-columns:10px minmax(0,1fr);column-gap:7px;align-content:start;font-size:12px;line-height:1.5;}
#sentlogStorageSection .sl-storage-dot{width:10px;height:10px;display:block;border-radius:3px;margin-top:4px;}
#sentlogStorageSection .sl-storage-legend b{display:block;font-size:13px;font-weight:600;color:#1f2937;font-variant-numeric:tabular-nums;}
#sentlogStorageSection .sl-storage-count{font-size:11px;font-weight:400;color:#6b7280;margin-left:4px;}
#sentlogStorageSection .sl-storage-caption{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#6b7280;margin:7px 0;}
#sentlogStorageSection .sl-storage-notice[data-level="warn"]{color:#92400e;background:#fffbeb;padding:8px;border-radius:6px;}
#sentlogStorageSection .sl-storage-notice[data-level="error"]{color:#991b1b;background:#fef2f2;padding:8px;border-radius:6px;}
#sentlogStorageSection .sl-storage-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px;}
#sentlogStorageSection button{font-size:12px;padding:8px 10px;min-height:44px;width:auto;touch-action:manipulation;}
#sentlogStorageDetails{border-top:1px solid var(--line);}
#sentlogStorageDetails summary{font-size:12px;font-weight:500;color:#6b7280;}
#sentlogStorageWarning{position:fixed;z-index:11000;bottom:calc(8px + env(safe-area-inset-bottom,0px));left:12px;right:12px;max-width:740px;margin:0 auto;padding:14px;border:2px solid #b91c1c;border-radius:12px;background:#fff1f2;color:#881337;box-shadow:0 4px 20px #0003;font-size:13px;line-height:1.6;}
#sentlogStorageWarning[hidden]{display:none!important;}#sentlogStorageWarning p{margin:6px 0;}
#sentlogStorageWarning button{margin:6px 6px 0 0;min-height:44px;font-size:12px;}
`;
  document.head.appendChild(style);
  const section=document.createElement('details');section.id='sentlogStorageSection';
  section.innerHTML=`<summary>保存容量</summary>
<p id="sentlogStorageScope">この端末のセントログ</p>
<div class="sl-storage-total"><span id="sentlogStorageTotal">計測前</span><small id="sentlogStorageTotalNote">保存データの合計（目安）</small></div>
<div class="sl-storage-bar-head"><span id="sentlogStorageBarTitle">保存容量（上限の目安）</span><span id="sentlogStorageUsage" class="sl-storage-usage"></span></div>
<div id="sentlogStorageBar" role="img" aria-label="保存容量を計測する前のバー" hidden></div>
<div class="sl-storage-caption"><span id="sentlogStorageBarStart"></span><span id="sentlogStorageBarEnd"></span></div>
<p id="sentlogStorageRemaining"></p>
<p id="sentlogStorageNotice" class="sl-storage-notice" role="status" aria-live="polite">容量は、この項目を開いたときに計測します。</p>
<ul id="sentlogStorageLegend" class="sl-storage-legend" aria-label="色ごとの保存データ量"></ul>
<div class="sl-storage-actions"><button type="button" id="sentlogStorageRefresh">容量を再確認</button></div>
<details id="sentlogStorageDetails"><summary>詳しい情報</summary>
<p id="sentlogQuotaInfo"></p><p id="sentlogStorageMethod"></p>
<p>記録・メモ、PDF・図面、写真、移行前の控えは端末内で集計した目安です。「その他」には、確認できた範囲で同じサイトのキャッシュなども含めます。圧縮・丸め・計測時刻の違いで、ブラウザの報告値とは一致しないことがあります。</p>
<p>保存枠の上限はブラウザが示す概算です。その分の空き容量が本体に確保されているわけではありません。</p>
<p id="sentlogMigrationInfo"></p><p id="sentlogPersistenceInfo"></p>
<p>「保護済み」でも、端末の故障・サイトデータの手動削除は防げません。大切な記録はバックアップも残してください。</p>
<div class="sl-storage-actions"><button type="button" id="sentlogStorageProtect">保存データの保護を要求</button></div>
</details>`;
  modal.querySelector('#sentlogBackupSection').before(section);
  const get=id=>section.querySelector('#'+id);
  const refresh=get('sentlogStorageRefresh');
  const protection=get('sentlogPersistenceInfo'),protect=get('sentlogStorageProtect');
  const bar=get('sentlogStorageBar'),legend=get('sentlogStorageLegend'),notice=get('sentlogStorageNotice');
  const bytes=n=>{if(!Number.isFinite(n))return '取得不可';if(n<1024)return Math.round(n)+' B';if(n<1024**2)return (n/1024).toFixed(1)+' KB';if(n<1024**3)return (n/1024**2).toFixed(1)+' MB';return (n/1024**3).toFixed(2)+' GB';};
  const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const percent=n=>n>0&&n<0.1?'0.1%未満':n.toFixed(1)+'%';
  // Optional browser diagnostics must not leave the panel stuck in "measuring".
  async function optional(task){let timer;try{return await Promise.race([Promise.resolve().then(task).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),2500);})]);}finally{clearTimeout(timer);}}
  let measuring=false,sample=null;
  function setNotice(message,level=''){notice.textContent=message;notice.dataset.level=level;}
  function renderCapacity(){
    if(!sample)return;
    const {sizes,estimate}=sample;
    const categories=[
      {key:'records',name:'記録・メモ',amount:sizes.records},
      {key:'drawings',name:'PDF・図面',amount:sizes.drawings,count:sizes.drawingCount+'件'},
      {key:'photos',name:'写真',amount:sizes.photos,count:sizes.photoCount+'枚'},
      {key:'archive',name:'移行前の控え',amount:sizes.archive},
      {key:'other',name:'その他',amount:sizes.other}
    ];
    const total=categories.reduce((n,c)=>n+c.amount,0);
    const usageKnown=!!estimate&&valid(estimate.usage);
    const quotaKnown=!!estimate&&valid(estimate.quota)&&estimate.quota>0;
    const known=usageKnown&&quotaKnown;
    const ratio=known?100*(estimate.usage/estimate.quota):null;
    const normalized=usageKnown&&estimate.usage<total;
    // Browser estimates and local byte totals can differ. The outer used width
    // ALWAYS follows usage/quota, never local composition. Only its inner colors
    // are proportional when local totals exceed reported usage; do not invent
    // negative "other" bytes or inflate tiny categories with minimum widths.
    if(usageKnown&&estimate.usage>total)categories[4].amount+=estimate.usage-total;
    const colorTotal=categories.reduce((n,c)=>n+c.amount,0);
    const visibleCategories=categories.filter(c=>c.key!=='other'||c.amount>0);
    get('sentlogStorageScope').textContent=usageKnown?'このサイトで使用中（この端末）':'この端末のセントログ';
    get('sentlogStorageTotal').textContent=bytes(usageKnown?estimate.usage:total);
    get('sentlogStorageTotalNote').textContent=usageKnown?'セントログ内の集計：'+bytes(total)+'（目安）':'保存データの合計（目安）';
    get('sentlogStorageBarTitle').textContent=quotaKnown?'保存容量（上限の目安）':'保存容量：上限不明';
    get('sentlogStorageUsage').textContent=known?'使用 '+percent(ratio):'使用率は取得できません';
    get('sentlogStorageBarStart').textContent=known?'色付き：使用中':'';
    get('sentlogStorageBarEnd').textContent=quotaKnown?'上限目安 '+bytes(estimate.quota):'';
    get('sentlogStorageRemaining').textContent=known?'空き（保存枠の残り）：約 '+bytes(Math.max(0,estimate.quota-estimate.usage))+'（目安）':'空き容量：不明';
    bar.hidden=!known;bar.dataset.mode=known?'quota':'unknown';bar.replaceChildren();
    if(known){
      const used=document.createElement('span');used.className='sl-storage-used';
      used.style.width=Math.max(0,Math.min(100,ratio))+'%';used.setAttribute('aria-hidden','true');
      for(const category of visibleCategories){
        if(category.amount<=0||colorTotal<=0)continue;
        const segment=document.createElement('span');segment.className='sl-storage-segment';segment.dataset.category=category.key;
        segment.style.width=(100*(category.amount/colorTotal))+'%';
        segment.title=category.name+'：'+bytes(category.amount)+(normalized?'（端末内集計の目安）':'');used.appendChild(segment);
      }
      bar.appendChild(used);
    }
    const description=visibleCategories.map(c=>c.name+' '+bytes(c.amount)).join('、');
    bar.setAttribute('aria-label',known?'保存上限の目安 '+bytes(estimate.quota)+'、使用 '+bytes(estimate.usage)+'、使用率 '+percent(ratio)+'、空きの目安 '+bytes(Math.max(0,estimate.quota-estimate.usage))+'。'+(normalized?'色分けは端末内集計の比率による目安。':'')+description:'保存上限または使用量を取得できないため、容量バーは表示していません。');
    legend.replaceChildren();
    for(const c of visibleCategories){
      const item=document.createElement('li');item.dataset.category=c.key;
      const dot=document.createElement('span');dot.className='sl-storage-dot';dot.setAttribute('aria-hidden','true');
      const content=document.createElement('div'),name=document.createElement('span'),amount=document.createElement('b');
      name.textContent=c.name;amount.textContent=bytes(c.amount);
      if(c.count){const count=document.createElement('span');count.className='sl-storage-count';count.textContent=c.count;amount.appendChild(count);}
      content.append(name,amount);item.append(dot,content);legend.appendChild(item);
    }
    let message=known?'バー全体が保存上限の目安です。色付きが使用中、薄い部分が空きの目安です。本体の空き容量ではありません。':
      quotaKnown?'ブラウザの使用量を取得できないため、容量バーは表示していません。':'上限不明：このブラウザでは保存上限を取得できないため、容量バーは表示していません。';
    if(normalized)message+=' ブラウザの使用量と端末内の集計が異なるため、色分けは内訳の比率による目安です。';
    if(known&&ratio>0&&ratio<1)message+=' 使用量が少ないため、色の部分は細くなります。';
    let level='';
    if(known&&ratio>=90){level='error';message+=' 保存枠の上限に近づいています。バックアップと本体の空き容量を確認してください。';}
    else if(known&&ratio>=80){level='warn';message+=' 保存枠の使用率が80%以上です。バックアップと本体の空き容量を確認してください。';}
    setNotice(message,level);
    get('sentlogQuotaInfo').textContent='ブラウザ報告（このサイトの概算）：使用 '+(usageKnown?bytes(estimate.usage):'取得不可')+' ／ 上限 '+(quotaKnown?bytes(estimate.quota):'不明')+(known?'。使用率 '+percent(ratio):'')+'。';
    get('sentlogStorageMethod').textContent=known?'バー全体＝ブラウザの上限目安。塗りつぶしの長さ＝ブラウザの使用量÷上限。'+(normalized?'色分けは端末内集計の比率で配分しています。内訳の数値は圧縮・丸めなどにより上の使用量と一致しないことがあります。':'セントログ内の合計との差を「その他」に含めています。'):'上限または使用量が不明なときは、使用率・空き容量を推定したり、内訳でバー全体を埋めたりしません。';
    get('sentlogMigrationInfo').textContent='保存先：IndexedDB。大容量保存への移行は完了しています。移行前の記録の控えも端末内に保持しています。';
  }
  async function update(){
    if(measuring)return;measuring=true;refresh.disabled=true;refresh.textContent='確認中…';section.setAttribute('aria-busy','true');
    try{
      const sizes=await store.stats();
      if(!sizes||!['records','drawings','photos','archive','other','drawingCount','photoCount'].every(k=>valid(sizes[k])))throw Error('保存データ量を取得できませんでした。');
      const [estimate,persisted]=await Promise.all([
        optional(()=>navigator.storage?.estimate?.()),optional(()=>navigator.storage?.persisted?.())
      ]);
      sample={sizes,estimate};renderCapacity();
      protection.textContent='ブラウザによる自動削除への保護：'+(persisted===true?'保護済み':persisted===false?'通常保存（保護未承認）':'確認できません');
      protect.disabled=!navigator.storage?.persist||persisted===true;
    }catch(error){
      // Never leave the previous successful measurement looking current after failure.
      sample=null;bar.hidden=true;legend.replaceChildren();get('sentlogStorageTotal').textContent='取得できません';get('sentlogStorageTotalNote').textContent='';
      for(const id of ['sentlogStorageUsage','sentlogStorageBarStart','sentlogStorageBarEnd','sentlogStorageRemaining','sentlogQuotaInfo','sentlogStorageMethod','sentlogMigrationInfo','sentlogPersistenceInfo'])get(id).textContent='';
      setNotice('容量を確認できませんでした。「容量を再確認」を押してください。'+(error.message||error),'error');
    }finally{measuring=false;refresh.disabled=false;refresh.textContent='容量を再確認';section.setAttribute('aria-busy','false');}
  }
  section.addEventListener('toggle',event=>{if(event.target===section&&section.open)update();});refresh.onclick=update;
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
      const content=messages.join(' ／ ')+(store.issues.some(([k])=>k.startsWith('file:'))?' PDF・写真もこの画面を開いている間は再保存できます。':'');
      const label=warning.querySelector('.message');if(label.textContent!==content)label.textContent=content;
    }
  }
  store.subscribe(showFailure);showFailure();
  retry.onclick=async()=>{retry.disabled=true;try{await store.retry();if(typeof renderSelectedPhotos==='function')renderSelectedPhotos();}catch(_){}finally{retry.disabled=false;showFailure();}};
  rescue.onclick=async()=>{rescue.disabled=true;try{await exportSentlogBackup({allowPending:true});}catch(e){warning.querySelector('.message').textContent+=' 控えの書き出しも完了していません：'+e.message;}finally{rescue.disabled=false;}};
  window.addEventListener('beforeunload',event=>{if(store.pending||store.failed){event.preventDefault();event.returnValue='';}});
})();

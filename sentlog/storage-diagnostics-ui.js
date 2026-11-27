/* On-demand, read-only inventory. No diagnostics run during app startup. */
(function(root){
  'use strict';
  if(!root.document||root.SentlogStorageDiagnosticsUI)return;
  const doc=root.document;
  const bytes=n=>{
    if(!Number.isFinite(n)||n<0)return '不明';
    if(n<1024)return Math.round(n)+' B';
    if(n<1024**2)return (n/1024).toFixed(1)+' KiB';
    if(n<1024**3)return (n/1024**2).toFixed(1)+' MiB';
    return (n/1024**3).toFixed(2)+' GiB';
  };
  const number=n=>Number.isFinite(n)?n.toLocaleString('ja-JP'):'不明';
  const node=(tag,text)=>{const value=doc.createElement(tag);if(text!==undefined)value.textContent=text;return value;};
  const roles={
    'surveyFieldNoteDB/files':'使用中の記録・図面・共有写真',
    'surveyFieldNoteDB/sentlog_delta_journal_v1':'編集・ファイルの保持履歴',
    'surveyFieldNoteDB/sentlog_delta_control_v1':'同期開始時の控え・管理情報',
    'sentlog-original-photos-v1/photos':'この端末で撮影した元写真',
    'sentlog-original-photos-v1/meta':'元写真の管理情報',
    'sentlog-delta-migration-v1/items':'同期移行の控え（写真・図面など）',
    'sentlog-delta-migration-v1/sessions':'同期移行の管理情報',
    'sentlog-delta-assets-v1/assets':'同期受信・保管用のファイル',
    'sentlog-delta-v1/replicas':'差分同期の記録・送信待ち情報'
  };
  const databaseLabels={
    'surveyFieldNoteDB':'記録・図面・共有写真',
    'sentlog-original-photos-v1':'この端末で撮影した元写真',
    'sentlog-delta-migration-v1':'同期移行の控え',
    'sentlog-delta-assets-v1':'同期受信・保管用のファイル',
    'sentlog-delta-v1':'差分同期の記録・送信待ち情報'
  };
  function missingText(result){
    const names=result.missingDatabases||[];if(!names.length)return null;
    return '一覧で確認できない保存先：'+names.map(name=>databaseLabels[name]||name).join('、')+'。未作成・未使用の場合もあります。この一覧だけで、保存データが空、または消えたとは判断できません。';
  }
  const states={complete:'確認済み',partial:'一部のみ',cancelled:'中止',unsupported:'非対応',failed:'確認できません',busy:'別の確認を実行中'};
  let section,output,status,start,cancel,copy,active=null,lastResult=null,observer=null;
  function rows(result){return (result?.databases||[]).flatMap(database=>(database.stores||[]).map(store=>({database,store})));}
  function label(database,store){return roles[database.name+'/'+store.name]||store.role||'その他の保存情報';}
  function measured(result){return result.complete||result.records>0||rows(result).some(({store})=>store.status==='complete');}
  function amount(result){return measured(result)?(result.complete&&!result.missingDatabases?.length?'':'確認できた分：')+bytes(result.logicalBytes):'未計測';}
  function storeAmount(store){return store.status==='complete'?bytes(store.logicalBytes)+' / '+number(store.records)+'項目':
    store.records>0?'確認できた分：'+bytes(store.logicalBytes)+' / '+number(store.records)+'項目（途中）':'未計測';}
  function timestamp(value){if(value===null||value===undefined)return '不明';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ja-JP'):String(value);}
  function resultText(result){
    const lines=['セントログ 内部保存の診断',
      '状態：'+(result.complete&&result.missingDatabases?.length?'一覧で確認できた保存先のみ確認済み':states[result.status]||result.status),
      '確認開始：'+result.startedAt,'確認終了：'+result.finishedAt,
      '保存データの集計：'+amount(result)+'（同じ内容の保持分も含む目安）',
      'これは本体の使用量・空き容量ではありません。物理的な重複の有無は判定していません。'];
    for(const {database,store}of rows(result)){
      lines.push(label(database,store)+'：'+storeAmount(store)+' / '+(states[store.status]||store.status));
      lines.push('  保存先：'+database.name+' / '+store.name);
      if(store.reason)lines.push('  確認状況：'+store.reason);
      if(store.earliestTimestamp||store.latestTimestamp)lines.push('  記録日時：'+timestamp(store.earliestTimestamp)+' ～ '+timestamp(store.latestTimestamp));
      if(store.states&&Object.keys(store.states).length)lines.push('  保持状態：'+JSON.stringify(store.states));
      if(store.kinds&&Object.keys(store.kinds).length)lines.push('  記録種類：'+JSON.stringify(store.kinds));
    }
    for(const database of result.databases||[])if(database.reason)lines.push('保存先の確認状況：'+database.name+' / '+database.reason);
    const missing=missingText(result);if(missing)lines.push(missing);
    if(result.reason)lines.push('全体の確認状況：'+result.reason);
    for(const warning of result.warnings||[])lines.push('補足：'+warning);
    if(result.excludedDatabases?.length)lines.push('集計対象外の同サイト保存先：'+result.excludedDatabases.map(d=>d.name).join('、'));
    return lines.join('\n');
  }
  function render(result){
    output.replaceChildren();
    const total=node('p',amount(result));total.className='sl-diagnosis-total';
    output.append(total,node('p','保存データの集計（同じ内容の保持分も含む目安）'));
    if(!result.complete)output.append(node('p','診断は完了していません。未確認の保存先があるため、上の数値から空き容量や保存データ全体の量は判断できません。'));
    const warning=node('p','本体の使用量や、削除して空く容量を表す数値ではありません。確認中の保存・同期によって内訳が変わることがあります。');
    warning.className='sl-diagnosis-note';output.append(warning);
    const list=node('div');list.className='sl-diagnosis-list';
    for(const {database,store}of rows(result)){
      const card=node('div');card.className='sl-diagnosis-row';
      card.append(node('strong',label(database,store)),node('span',storeAmount(store)),node('span',states[store.status]||store.status));
      const detail=node('details');detail.append(node('summary','保存先と確認状況'));
      detail.append(node('p',database.name+' / '+store.name),node('p',states[store.status]||store.status));
      if(store.reason)detail.append(node('p',store.reason));
      if(store.earliestTimestamp||store.latestTimestamp)detail.append(node('p','記録日時：'+timestamp(store.earliestTimestamp)+' ～ '+timestamp(store.latestTimestamp)));
      if(store.states&&Object.keys(store.states).length)detail.append(node('p','保持状態：'+JSON.stringify(store.states)));
      if(store.kinds&&Object.keys(store.kinds).length)detail.append(node('p','記録種類：'+JSON.stringify(store.kinds)));
      card.append(detail);list.append(card);
    }
    output.append(list);
    const missing=missingText(result);if(missing)output.append(node('p',missing));
    if(result.reason)output.append(node('p','確認状況：'+result.reason));
    for(const database of result.databases||[])if(database.reason)output.append(node('p',database.name+'：'+database.reason));
    for(const warning of result.warnings||[])output.append(node('p',warning));
    if(result.excludedDatabases?.length)output.append(node('p','同じサイトの別の保存先 '+number(result.excludedDatabases.length)+'件は、この集計に含めていません。'));
  }
  function stop(){if(active&&!active.signal.aborted){active.abort();status.textContent='確認を中止しています…';}}
  async function run(){
    if(active)return;
    if(!root.SentlogStorageDiagnostics?.scan){status.textContent='診断機能を読み込めませんでした。保存中でなければ、通信できる場所で画面を更新してください。';return;}
    const controller=new AbortController();active=controller;lastResult=null;
    start.disabled=true;cancel.hidden=false;copy.hidden=true;output.replaceChildren();
    status.textContent='内部の保存先を確認しています…';section.setAttribute('aria-busy','true');
    try{
      let lastUpdate=0;
      const result=await root.SentlogStorageDiagnostics.scan({signal:controller.signal,onProgress:progress=>{
        if(active!==controller||Date.now()-lastUpdate<150)return;lastUpdate=Date.now();
        status.textContent='確認中：'+number(progress.records||0)+'項目 / '+bytes(progress.logicalBytes||0)+'。中止しても保存データは変更されません。';
      }});
      if(active!==controller)return;
      lastResult=result;render(result);
      status.textContent=result.complete?(result.missingDatabases?.length?'一覧で確認できた保存先の診断が終わりました。確認できない保存先があります。':'内部保存の確認が終わりました。'):
        result.status==='cancelled'?'確認を中止しました。ここまで確認できた範囲を表示します。':
        result.status==='unsupported'?'この端末では保存先の一覧を安全に取得できないため、診断を開始していません。':
        '全ては確認できませんでした。確認できた範囲を表示します。';
      copy.hidden=false;
    }catch(error){status.textContent='確認できませんでした：'+(error?.message||String(error));}
    finally{if(active===controller){active=null;start.disabled=false;cancel.hidden=true;section.removeAttribute('aria-busy');}}
  }
  function install(){
    if(section)return true;
    const settings=doc.querySelector('#sentlogSettingsModal .modal-card');
    const pc=/\/sentlog-pc(?:\/|$)/.test(root.location?.pathname||'');
    const host=settings||(pc?doc.querySelector('main')||doc.body:null);
    if(!host)return false;
    const style=node('style');style.textContent=`
#sentlogStorageDiagnosticSection{border:1px solid #cbd5e1;border-radius:10px;padding:0 14px;margin:12px 0;text-align:left;color:#1f2937;background:#fff}
#sentlogStorageDiagnosticSection>summary{padding:12px 0;min-height:24px;font-size:14px;font-weight:600;cursor:pointer}
#sentlogStorageDiagnosticSection p{font-size:12px;line-height:1.7;overflow-wrap:anywhere;margin:8px 0}
#sentlogStorageDiagnosticSection .sl-diagnosis-total{font-size:25px;font-weight:700;margin-bottom:0}
#sentlogStorageDiagnosticSection .sl-diagnosis-note{color:#475569}
#sentlogStorageDiagnosticSection .sl-diagnosis-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
#sentlogStorageDiagnosticSection button{width:auto;min-height:44px;font-size:12px;padding:8px 12px;touch-action:manipulation}
#sentlogStorageDiagnosticSection [hidden]{display:none!important}
#sentlogStorageDiagnosticSection .sl-diagnosis-row{padding:12px 0;border-top:1px solid #e2e8f0;display:flex;flex-direction:column;gap:5px;font-size:13px}
#sentlogStorageDiagnosticSection .sl-diagnosis-row strong{font-size:13px}
#sentlogStorageDiagnosticSection .sl-diagnosis-row summary{font-size:11px;color:#475569;cursor:pointer;padding:6px 0}
#sentlogStorageDiagnosticSection .sl-diagnosis-row p{font-size:11px}
`;
    doc.head.append(style);section=node('details');section.id='sentlogStorageDiagnosticSection';
    section.append(node('summary','内部の保存データを詳しく確認'));
    section.append(node('p','写真・図面に加え、同期の控えやファイル履歴を確認します。写真の書き出しやデータの整理は行いません。項目が多いと時間がかかります。'));
    section.append(node('p','ブラウザ内の集計です。本体の空き容量、OSの一時データ、PC保管フォルダの容量は含みません。'));
    const actions=node('div');actions.className='sl-diagnosis-actions';
    start=node('button','内部保存を診断する');start.id='sentlogStorageDiagnosticStart';start.type='button';start.onclick=run;
    cancel=node('button','確認を中止');cancel.type='button';cancel.hidden=true;cancel.onclick=stop;
    copy=node('button','診断結果をコピー');copy.type='button';copy.hidden=true;
    copy.onclick=async()=>{
      if(!lastResult)return;
      try{if(!root.navigator?.clipboard?.writeText)throw Error('コピー非対応');await root.navigator.clipboard.writeText(resultText(lastResult));status.textContent='診断結果をコピーしました。写真や記録の内容は含まれていません。';}
      catch(_){status.textContent='この端末ではコピーできませんでした。表示された結果を確認してください。';}
    };
    actions.append(start,cancel,copy);section.append(actions);
    status=node('p','ボタンを押したときに確認します。');status.setAttribute('role','status');status.setAttribute('aria-live','polite');section.append(status);
    output=node('div');output.id='sentlogStorageDiagnosticResult';section.append(output);
    if(settings){const storage=doc.getElementById('sentlogStorageSection');if(storage?.parentNode===host)storage.after(section);else host.append(section);}
    else host.append(section);
    section.addEventListener('toggle',event=>{if(event.target===section&&!section.open)stop();});
    const modal=doc.getElementById('sentlogSettingsModal');
    if(modal&&root.MutationObserver)new MutationObserver(()=>{if(modal.getAttribute('aria-hidden')==='true')stop();}).observe(modal,{attributes:true,attributeFilter:['aria-hidden']});
    return true;
  }
  root.SentlogStorageDiagnosticsUI={install,stop,format:resultText};
  if(!install()&&root.MutationObserver&&doc.documentElement){
    observer=new MutationObserver(()=>{if(install()){observer.disconnect();observer=null;}});
    observer.observe(doc.documentElement,{childList:true,subtree:true});
  }
  root.addEventListener?.('pagehide',stop);
})(typeof globalThis!=='undefined'?globalThis:window);

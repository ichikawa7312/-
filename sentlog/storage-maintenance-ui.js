/* Explicit, device-local maintenance. Review is read-only; every write pass
 * independently proves that it removes only redundant retained information. */
(function(root){
  'use strict';
  if(!root.document||root.SentlogStorageMaintenanceUI)return;
  const doc=root.document,MAX_RUN_MS=180000;
  const bytes=n=>n<1024?Math.round(n)+' B':n<1024**2?(n/1024).toFixed(1)+' KiB':n<1024**3?(n/1024**2).toFixed(1)+' MiB':(n/1024**3).toFixed(2)+' GiB';
  const node=(tag,text)=>{const value=doc.createElement(tag);if(text!==undefined)value.textContent=text;return value;};
  const phases=[
    {method:'compactRedundantRecords',cursor:0,label:'記録の重複履歴'},
    {method:'compactRedundantFiles',cursor:0,label:'PDF・写真の重複履歴'},
    {method:'compactRedundantPageBackups',cursor:'',label:'使用済みのPDF退避データ'}
  ];
  let section,review,run,stop,status,result,active=null,reviewed=false,observer=null,reviewProgress=null,cleanupProgress=null,standalone=false;
  const empty=()=>({scanned:0,eligible:0,updated:0,logicalBytesEligible:0,logicalBytesRemoved:0,skippedClaims:0,skippedUnproven:0,skippedLarge:0});
  const progress=()=>({phaseIndex:0,cursor:phases[0].cursor,total:empty(),before:null});
  function writer(){
    const value=root.SentlogRecords;
    if(value?.storageMaintenanceVersion!==1||!phases.every(p=>typeof value.deltaJournal?.[p.method]==='function'))
      throw Error('容量整理の最新版を読み込めませんでした。保存中でなければ、通信できる場所でもう一度開いてください。');
    value.assertSafe();
    if(value.pending)throw Error('保存処理が進行中です。保存が終わってから、もう一度確認してください。');
    return value;
  }
  function checked(value){
    for(const key of ['scanned','eligible','updated','logicalBytesEligible','logicalBytesRemoved'])
      if(!Number.isSafeInteger(value?.[key])||value[key]<0)throw Error('整理結果を確認できません。処理を止めました。');
    if(typeof value.done!=='boolean')throw Error('整理範囲を確認できません。処理を止めました。');
    return value;
  }
  function add(total,value){
    for(const key of Object.keys(total)){
      const next=total[key]+(value[key]||0);
      if(!Number.isSafeInteger(next)||next<0)throw Error('整理結果の合計を確認できません。処理を止めました。');
      total[key]=next;
    }
  }
  function cancel(){if(active){active.cancelled=true;active.controller.abort();stop.disabled=true;status.textContent='処理を区切って中止しています…';}}
  async function estimate(){
    let timer;
    try{return await Promise.race([Promise.resolve().then(()=>root.navigator?.storage?.estimate?.()).catch(()=>null),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);}
    finally{clearTimeout(timer);}
  }
  function outcome(total,dryRun,complete,before,after){
    result.replaceChildren();
    result.append(node('p',(dryRun?'整理できる重複分：':'整理した重複分：')+
      bytes(dryRun?total.logicalBytesEligible:total.logicalBytesRemoved)+' / '+(dryRun?total.eligible:total.updated).toLocaleString('ja-JP')+'項目'));
    result.append(node('p','重複していた保存データの量です。本体の空き容量の増加量ではありません。ブラウザ内の整理が本体の容量表示へ反映されるまで時間がかかる場合があります。'));
    if(!complete)result.append(node('p',dryRun?'確認は途中です。確認できた分から整理を開始できます。全体の整理対象量はまだ分かりません。':
      '整理は途中です。ここまで完了した分は保持されます。「整理を続ける」で残りを確認しながら進められます。'));
    if(!dryRun&&Number.isFinite(before?.usage)&&Number.isFinite(after?.usage))
      result.append(node('p','このサイトの推定使用量：'+bytes(before.usage)+' → '+bytes(after.usage)));
    if(total.skippedLarge)result.append(node('p','一度に照合する量を超えた '+total.skippedLarge.toLocaleString('ja-JP')+'項目は、データを残して整理対象から外しています。'));
    if(complete&&dryRun&&!total.eligible)
      result.append(node('p','今回の条件で整理できる重複はありません。内容の異なる旧版や未送信の変更、原本は残しています。'));
  }
  async function execute(dryRun){
    if(active)return;
    const task={cancelled:false,controller:new AbortController()};active=task;reviewed=false;
    const current=(dryRun?reviewProgress:cleanupProgress)||progress();
    if(dryRun)cleanupProgress=null;else reviewProgress=null;
    review.disabled=true;run.disabled=true;run.hidden=true;stop.hidden=false;stop.disabled=false;
    section.setAttribute('aria-busy','true');result.replaceChildren();
    const total=current.total,started=Date.now();let complete=false,after=null,failure=null;
    try{
      const records=writer();
      if(!dryRun&&current.before===null)current.before=await estimate();
      while(current.phaseIndex<phases.length){
        if(task.cancelled||Date.now()-started>MAX_RUN_MS)break;
        const phase=phases[current.phaseIndex],cursor=current.cursor;
        writer();
        status.textContent=(dryRun?'確認中：':'整理中：')+phase.label+' / '+total.scanned.toLocaleString('ja-JP')+'項目を確認';
        const value=checked(await records.deltaJournal[phase.method]({cursor,scanLimit:standalone?32:128,limit:standalone?8:32,dryRun,signal:task.controller.signal}));
        if(dryRun&&(value.updated!==0||value.logicalBytesRemoved!==0))throw Error('読取り確認の結果が不正です。処理を止めました。');
        add(total,value);
        if(value.done){current.phaseIndex++;current.cursor=phases[current.phaseIndex]?.cursor??null;}
        else{
          if(value.nextCursor===cursor||typeof value.nextCursor!==typeof phase.cursor)
            throw Error('整理の進行位置を確認できません。処理を止めました。');
          current.cursor=value.nextCursor;
        }
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      complete=current.phaseIndex===phases.length;
      if(!dryRun)after=await estimate();
      status.textContent=complete?(dryRun?'確認が終わりました。内容を確認してから整理できます。':'重複分の整理が完了しました。'):
        Date.now()-started>MAX_RUN_MS?'時間がかかったため、ここで区切りました。続きの位置から再開できます。':'処理を中止しました。続きの位置から再開できます。';
    }catch(error){
      if(task.cancelled)status.textContent='処理を中止しました。続きの位置から再開できます。';
      else{failure=error;status.textContent=(dryRun?'確認を完了できませんでした：':'整理を完了できませんでした：')+(error?.message||String(error));}
    }finally{
      if(dryRun)reviewProgress=complete?null:current;else cleanupProgress=complete?null:current;
      reviewed=dryRun&&total.eligible>0&&!failure;
      outcome(total,dryRun,complete&&!failure,current.before,after);
      active=null;review.disabled=false;
      review.textContent=reviewProgress?'続きの重複を確認':'整理できる重複を確認';
      run.textContent=cleanupProgress?'整理を続ける':'重複分を整理';
      run.hidden=!(reviewed||cleanupProgress);run.disabled=run.hidden;stop.hidden=true;section.removeAttribute('aria-busy');
    }
  }
  function install(){
    if(section)return true;
    const dedicated=doc.getElementById('startupMaintenanceHost');
    const host=dedicated||doc.querySelector('#sentlogSettingsModal .modal-card');if(!host)return false;
    standalone=!!dedicated;
    section=node('details');section.id='sentlogStorageMaintenanceSection';
    if(standalone)section.open=true;
    section.append(node('summary','容量を整理（記録・原本を保持）'));
    section.append(node('p','同じ内容を重ねて持っている保存履歴を整理します。現在の記録・PDF・写真、未送信の変更、内容が異なる旧版は保持します。ログインや会社PCへの接続は必要ありません。'));
    const actions=node('div');actions.className='sl-maintenance-actions';
    review=node('button','整理できる重複を確認');review.id='sentlogStorageMaintenanceReview';review.type='button';review.onclick=()=>execute(true);
    run=node('button','重複分を整理');run.id='sentlogStorageMaintenanceRun';run.type='button';run.hidden=true;run.disabled=true;
    run.onclick=()=>{if(reviewed||cleanupProgress)execute(false);};
    stop=node('button','中止');stop.id='sentlogStorageMaintenanceStop';stop.type='button';stop.hidden=true;stop.onclick=cancel;
    actions.append(review,run,stop);section.append(actions);
    status=node('p','最初の確認では保存データを変更しません。');status.id='sentlogStorageMaintenanceStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');section.append(status);
    result=node('div');result.id='sentlogStorageMaintenanceResult';section.append(result);
    if(!standalone){
      const entry=node('p'),link=node('a','通常画面が重いときは、軽い整理画面を開く');
      link.id='sentlogStandaloneMaintenanceLink';link.href='./storage-maintenance.html?v=20261128-operation-memory-216';
      link.onclick=event=>{
        if(active||root.SentlogRecords?.pending||root.SentlogRecords?.failed){
          event.preventDefault();
          status.textContent=active?'整理処理が進行中です。中止または完了してから開いてください。':
            '保存が完了していないため、この画面は開いたままにしてください。保存警告がある場合は、まず「未保存の記録を含む控えを書き出す」で控えを残してください。';
        }
      };
      entry.append(link);section.append(entry);
    }
    const further=node('details');further.append(node('summary','さらに容量を空ける方法'));
    further.append(node('p','保管済み案件のPDF・写真は、保管フォルダの「PDF・写真を端末から外す」で整理できます。会社PCで案件一式を照合してから実行します。'));
    further.append(node('p','この端末で撮影した元写真は、設定の「元写真をまとめて保存（この端末）」でZIPを保存し、保存先のファイルを確認してから、保存確認済みの元写真を整理できます。'));
    section.append(further);
    const style=node('style');style.textContent=`
#sentlogStorageMaintenanceSection{border:1px solid #94a3b8;border-radius:10px;padding:0 14px;margin:12px 0;color:#1f2937;background:#fff;text-align:left}
#sentlogStorageMaintenanceSection>summary{padding:12px 0;min-height:44px;font-size:14px;font-weight:600;cursor:pointer}
#sentlogStorageMaintenanceSection p{font-size:12px;line-height:1.7;overflow-wrap:anywhere;margin:8px 0}
#sentlogStorageMaintenanceSection .sl-maintenance-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
#sentlogStorageMaintenanceSection button{width:auto;max-width:100%;min-height:44px;padding:8px 12px;font-size:12px;touch-action:manipulation}
#sentlogStorageMaintenanceSection [hidden]{display:none!important}
#sentlogStorageMaintenanceSection>details{border-top:1px solid #e2e8f0;margin:10px 0;padding-top:8px}
#sentlogStorageMaintenanceSection>details>summary{font-size:12px;min-height:32px;cursor:pointer}
`;
    doc.head.append(style);
    const storage=doc.getElementById('sentlogStorageSection');if(storage?.parentNode===host)storage.before(section);else host.append(section);
    const modal=doc.getElementById('sentlogSettingsModal');
    if(modal&&root.MutationObserver)new MutationObserver(()=>{if(modal.getAttribute('aria-hidden')==='true')cancel();})
      .observe(modal,{attributes:true,attributeFilter:['aria-hidden']});
    return true;
  }
  root.SentlogStorageMaintenanceUI={version:1,install,cancel,get busy(){return !!active;}};
  if(!install()&&root.MutationObserver&&doc.documentElement){
    observer=new MutationObserver(()=>{if(install()){observer.disconnect();observer=null;}});
    observer.observe(doc.documentElement,{childList:true,subtree:true});
  }
  root.addEventListener?.('pagehide',cancel);
})(typeof globalThis!=='undefined'?globalThis:window);

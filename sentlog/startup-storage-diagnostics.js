/* Standalone startup diagnosis. Only database names, count() and API metadata
 * are inspected. No application, session, record reader or writer is loaded. */
(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.SentlogStartupStorageDiagnostics=api;api.mount(root.document);}
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';
  // Exact production names from the records, original-photo, delta, receipt and
  // PC stores. Test/custom databaseName overrides are intentionally excluded.
  const DATABASES=[
    {name:'surveyFieldNoteDB',kind:'records',label:'記録・図面・共有写真',stores:['files','sentlog_delta_journal_v1','sentlog_delta_control_v1']},
    {name:'sentlog-original-photos-v1',kind:'originals',label:'端末原本',stores:['photos','meta']},
    {name:'sentlog-delta-migration-v1',kind:'migration',label:'同期移行の控え',stores:['sessions','items']},
    {name:'sentlog-delta-assets-v1',kind:'assets',label:'同期用ファイル',stores:['assets']},
    {name:'sentlog-delta-v1',kind:'replicas',label:'差分同期の記録',stores:['replicas']},
    {name:'sentlogSyncTrafficV1',kind:'receipts',label:'受信確認の控え',stores:['acks']},
    {name:'sentlog-pc-sync',kind:'pc',label:'PC保存先の設定',stores:['kv']}
  ];
  const PRESENCE={meta:'__sentlog_records_meta_v130__',workspace:'__sentlog_record__:surveyFieldNoteWorkspaceV1',legacyArchive:'__sentlog_records_archive_v130__'};
  const MARKER='sentlogRecordsReadyV130';
  const ERROR_NAMES=new Set(['AbortError','ConstraintError','DataError','InvalidAccessError','InvalidStateError','NotAllowedError',
    'NotFoundError','NotReadableError','QuotaExceededError','ReadOnlyError','SecurityError','TimeoutError','TransactionInactiveError','UnknownError','VersionError','TypeError','Error']);
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const option=(options,key,fallback)=>own(options,key)?options[key]:fallback();
  const bound=(value,fallback,max)=>Number.isFinite(value)?Math.max(1,Math.min(max,Math.floor(value))):fallback;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const problem=code=>Object.assign(new Error(code),{diagnosticCode:code});
  const presentUnknown=()=>({status:'unconfirmed',meta:null,workspace:null,legacyArchive:null});
  // A Safari tab and an installed iPhone Home Screen web app use isolated
  // IndexedDB/localStorage. Detect only presentation mode, never read data.
  // This cannot prove that another installation's local data is missing.
  function launchContext(){
    try{
      let standalone=null;
      const native=root.navigator?.standalone;
      if(typeof native==='boolean')standalone=native;
      if(typeof root.matchMedia==='function'){
        const query=root.matchMedia('(display-mode: standalone)');
        if(typeof query?.matches==='boolean')standalone=query.matches||standalone===true;
      }
      return {status:standalone===null?'unconfirmed':'complete',
        mode:standalone===true?'home-screen-app':standalone===false?'browser':'unknown'};
    }catch{return {status:'unconfirmed',mode:'unknown'};}
  }
  function failed(error,fallback){
    const code=['CANCELLED','TIME_LIMIT','REQUEST_TIMEOUT','DATABASE_CHANGED','OPEN_BLOCKED','VERSION_CHANGED','INVALID_RESPONSE'].includes(error?.diagnosticCode)?error.diagnosticCode:fallback;
    const status=code==='CANCELLED'?'cancelled':code==='TIME_LIMIT'||code==='REQUEST_TIMEOUT'?'timeout':'error';
    return {status,code,errorName:ERROR_NAMES.has(error?.name)?error.name:'Error'};
  }

  async function scan(options={}){
    const report={format:'sentlog-startup-storage-diagnostics',version:1,readOnly:true,status:'running',
      startedAt:new Date().toISOString(),finishedAt:null,
      launchContext:launchContext(),
      marker:{status:'unconfirmed',present:null},estimate:{status:'unconfirmed',usageBytes:null,quotaBytes:null},
      persisted:{status:'unconfirmed',persisted:null},cache:{status:'unconfirmed',count:null,generations:[]},
      indexedDB:{status:'unconfirmed',listedSentlogDatabaseCount:null,excludedDatabaseCount:null,databases:DATABASES.map(spec=>({
        kind:spec.kind,sequence:1,label:spec.label,status:'unconfirmed',version:null,stores:[],
        ...(spec.kind==='records'?{presence:presentUnknown()}:{})}))}};
    const timeout=bound(options.requestTimeoutMs,5000,30000),deadline=Date.now()+bound(options.maxDurationMs,30000,60000);
    const signal=options.signal,waiting=new Set(),connections=new Set();let stopped=false;
    const emit=()=>{if(typeof options.onProgress==='function')try{options.onProgress(copy(report));}catch{}};
    function check(){if(stopped||signal?.aborted)throw problem('CANCELLED');if(Date.now()>=deadline)throw problem('TIME_LIMIT');}
    function wait(start){
      return new Promise((resolve,reject)=>{
        let ended=false,cancelTask=()=>{},timer;
        const done=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);waiting.delete(cancel);error?reject(error):resolve(value);};
        const cancel=error=>{if(ended)return;try{cancelTask();}catch{}done(error||problem('CANCELLED'));};
        waiting.add(cancel);
        try{
          check();const remaining=deadline-Date.now(),timeoutCode=remaining<=timeout?'TIME_LIMIT':'REQUEST_TIMEOUT';
          timer=setTimeout(()=>cancel(problem(timeoutCode)),Math.max(1,Math.min(timeout,remaining)));
          cancelTask=start(done,()=>ended)||cancelTask;
        }catch(error){done(error);}
      });
    }
    function promiseRead(read){return wait(done=>{Promise.resolve().then(()=>{check();return read();}).then(value=>done(null,value),error=>done(error));});}
    const abort=()=>{for(const cancel of [...waiting])cancel(problem('CANCELLED'));};
    signal?.addEventListener?.('abort',abort,{once:true});

    async function marker(){
      try{check();const storage=option(options,'localStorage',()=>root.localStorage);
        if(typeof storage?.getItem!=='function')report.marker={status:'unsupported',present:null};
        else{const value=storage.getItem(MARKER);if(value!==null&&typeof value!=='string')throw problem('INVALID_RESPONSE');report.marker={status:'complete',present:value!==null};}
      }catch(error){report.marker={...failed(error,'MARKER_READ_FAILED'),present:null};}emit();
    }
    async function storageProbe(method){
      const key=method==='estimate'?'estimate':'persisted';
      try{
        check();const storage=option(options,'storageManager',()=>root.navigator?.storage);
        if(typeof storage?.[method]!=='function'){report[key].status='unsupported';emit();return;}
        const value=await promiseRead(()=>storage[method]());check();
        if(method==='persisted'){
          if(typeof value!=='boolean')throw problem('INVALID_RESPONSE');report.persisted={status:'complete',persisted:value};
        }else{
          const number=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
          const usageBytes=number(value?.usage),quotaBytes=number(value?.quota);
          if(usageBytes===null&&quotaBytes===null)throw problem('INVALID_RESPONSE');
          report.estimate={status:'complete',usageBytes,quotaBytes};
        }
      }catch(error){report[key]={...report[key],...failed(error,'STORAGE_PROBE_FAILED')};}emit();
    }
    async function cacheInventory(){
      try{
        check();const cache=option(options,'caches',()=>root.caches);
        if(typeof cache?.keys!=='function'){report.cache.status='unsupported';emit();return;}
        const names=await promiseRead(()=>cache.keys());check();if(!Array.isArray(names)||names.some(name=>typeof name!=='string'))throw problem('INVALID_RESPONSE');
        const generations=names.flatMap(name=>{
          const match=typeof name==='string'&&/^sentlog-pwa-v([1-9][0-9]{0,8})$/.exec(name);return match?[Number(match[1])]:[];
        }).sort((a,b)=>a-b);
        report.cache={status:'complete',count:generations.length,generations};
      }catch(error){report.cache={...report.cache,...failed(error,'CACHE_LIST_FAILED')};}emit();
    }
    function openExisting(factory,name,listedVersion){
      return wait((done,ended)=>{
        let changed=false;const request=factory.open(name); // No version: never upgrade an existing database.
        request.onupgradeneeded=()=>{changed=true;try{request.transaction.abort();}catch{};};
        request.onerror=()=>done(changed?problem('DATABASE_CHANGED'):request.error||problem('OPEN_FAILED'));
        request.onblocked=()=>done(problem('OPEN_BLOCKED'));
        request.onsuccess=()=>{
          const db=request.result;
          // Open requests cannot be cancelled. Close a late result, and always
          // abort a late upgrade, so a disappeared database is never retained.
          if(ended()||changed||signal?.aborted||stopped||Date.now()>=deadline){db.close();done(problem('DATABASE_CHANGED'));return;}
          if(Number.isSafeInteger(listedVersion)&&db.version!==listedVersion){db.close();done(problem('VERSION_CHANGED'));return;}
          const handle={db,changed:false,cancel:null};connections.add(db);
          db.onversionchange=()=>{handle.changed=true;handle.cancel?.(problem('VERSION_CHANGED'));db.close();connections.delete(db);};
          done(null,handle);
        };
        return ()=>{if(request.readyState==='done')try{request.result?.close();}catch{}};
      });
    }
    function countStores(handle,spec){
      if(handle.changed)return Promise.reject(problem('VERSION_CHANGED'));
      return wait(done=>{
        const db=handle.db,names=Array.from(db.objectStoreNames),stores=names.map((name,i)=>({
          name:spec.stores.includes(name)?name:null,sequence:i+1,status:'complete',count:null}));
        let presence=spec.kind==='records'?presentUnknown():undefined;
        if(!names.length){done(null,{stores,...(presence?{presence:{...presence,status:'missing-store'}}:{})});return;}
        const tx=db.transaction(names,'readonly');let requestError=null,complete=false;
        const rememberError=error=>{
          // Aborting a transaction also fails its remaining requests. Keep the
          // first actual failure instead of replacing it with those AbortErrors.
          if(error&&(!requestError||(requestError.name==='AbortError'&&error.name!=='AbortError')))requestError=error;
        };
        const finish=(error,value)=>{if(complete)return;complete=true;handle.cancel=null;done(error,value);};
        handle.cancel=error=>{try{tx.abort();}catch{}finish(error);};
        tx.onabort=()=>finish(requestError||tx.error||problem('COUNT_FAILED'));
        tx.onerror=()=>{}; // Do not suppress IndexedDB's normal abort on request errors.
        tx.oncomplete=()=>{
          if(handle.changed){finish(problem('VERSION_CHANGED'));return;}
          if(requestError){finish(requestError);return;}
          if(stores.some(store=>!Number.isSafeInteger(store.count)||store.count<0)||
            (presence?.status==='complete'&&Object.keys(PRESENCE).some(key=>typeof presence[key]!=='boolean'))){finish(problem('INVALID_RESPONSE'));return;}
          finish(null,{stores,...(presence?{presence}: {})});
        };
        try{
          for(let i=0;i<names.length;i++){
            const store=tx.objectStore(names[i]),q=store.count();
            q.onsuccess=()=>{stores[i].count=q.result;};q.onerror=()=>rememberError(q.error);
            if(spec.kind==='records'&&names[i]==='files'){
              presence={status:'complete',meta:null,workspace:null,legacyArchive:null};
              for(const [label,key]of Object.entries(PRESENCE)){
                const request=store.count(key);
                request.onsuccess=()=>{
                  if(request.result!==0&&request.result!==1){rememberError(problem('INVALID_RESPONSE'));return;}
                  presence[label]=request.result===1;
                };request.onerror=()=>rememberError(request.error);
              }
            }
          }
          if(presence?.status==='unconfirmed')presence.status='missing-store';
        }catch(error){try{tx.abort();}catch{};finish(error);}
        return ()=>{try{tx.abort();}catch{};handle.cancel=null;};
      });
    }
    async function databaseInventory(){
      const section=report.indexedDB;
      try{
        check();const factory=option(options,'indexedDB',()=>root.indexedDB);
        if(typeof factory?.databases!=='function'||typeof factory?.open!=='function'){
          section.status='unsupported';for(const row of section.databases)row.status='unsupported';emit();return;
        }
        const listed=await promiseRead(()=>factory.databases());check();if(!Array.isArray(listed))throw problem('INVALID_RESPONSE');
        const candidates=new Map(),seen=new Set();let excluded=0;
        for(const item of listed){
          if(typeof item?.name!=='string'||!item.name||seen.has(item.name))throw problem('INVALID_RESPONSE');
          seen.add(item.name);
          if(DATABASES.some(spec=>spec.name===item.name)){
            if(!Number.isSafeInteger(item.version)||item.version<1)throw problem('INVALID_RESPONSE');
            candidates.set(item.name,item.version);
          }else excluded++;
        }
        section.listedSentlogDatabaseCount=candidates.size;section.excludedDatabaseCount=excluded;section.status='running';
        for(let i=0;i<DATABASES.length;i++){
          const spec=DATABASES[i],row=section.databases[i];let handle;
          try{
            check();if(!candidates.has(spec.name)){row.status='missing';emit();continue;}
            row.status='running';emit();handle=await openExisting(factory,spec.name,candidates.get(spec.name));check();
            row.version=Number.isSafeInteger(handle.db.version)?handle.db.version:null;
            const result=await countStores(handle,spec);check();Object.assign(row,result,{status:'complete'});
          }catch(error){Object.assign(row,failed(error,'DATABASE_READ_FAILED'));}
          finally{if(handle){handle.cancel=null;handle.db.close();connections.delete(handle.db);}}emit();
        }
        section.status=section.databases.every(row=>row.status==='complete'||row.status==='missing')?'complete':'partial';
      }catch(error){
        Object.assign(section,failed(error,'DATABASE_LIST_FAILED'));
        for(const row of section.databases)if(row.status==='unconfirmed')Object.assign(row,failed(error,'DATABASE_LIST_FAILED'));
      }emit();
    }
    try{await Promise.all([marker(),storageProbe('estimate'),storageProbe('persisted'),cacheInventory(),databaseInventory()]);}
    finally{
      stopped=true;signal?.removeEventListener?.('abort',abort);abort();for(const db of connections)try{db.close();}catch{};connections.clear();
    }
    report.status=signal?.aborted?'cancelled':[report.marker,report.estimate,report.persisted,report.cache,report.indexedDB].every(part=>part.status==='complete')?'complete':'partial';
    report.finishedAt=new Date().toISOString();emit();return copy(report);
  }

  const STORE_LABELS={files:'使用中の記録・図面・写真',sentlog_delta_journal_v1:'編集・ファイルの保持履歴',sentlog_delta_control_v1:'同期の控え・管理情報',
    photos:'原本写真',meta:'原本の管理情報',sessions:'移行の管理情報',items:'移行前の控え',assets:'同期用ファイル',replicas:'同期記録・送信待ち',acks:'受信確認',kv:'PC設定'};
  const STATUS={complete:'確認済み',partial:'一部未確認',unconfirmed:'未確認',running:'確認中',missing:'一覧にありません',unsupported:'未確認（API未対応）',
    error:'未確認（読取りエラー）',timeout:'未確認（時間切れ）',cancelled:'未確認（中止）','missing-store':'未確認（保存先なし）'};
  function mount(doc){
    if(!doc)return;
    const install=()=>{
      const start=doc.getElementById('storageCheckStart');if(!start||start.dataset.installed)return;start.dataset.installed='1';
      const stop=doc.getElementById('storageCheckStop'),save=doc.getElementById('storageCheckSave'),status=doc.getElementById('storageCheckStatus'),output=doc.getElementById('storageCheckResult');
      let controller=null,last=null;
      const node=(tag,text)=>{const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
      const state=part=>STATUS[part?.status]||'未確認';
      const yes=value=>value===true?'あり':value===false?'なし':'未確認';
      const bytes=value=>typeof value==='number'?(value/(1024*1024)).toLocaleString('ja-JP',{maximumFractionDigits:2})+' MiB':'未確認';
      const line=(label,value)=>{const p=node('p');p.append(node('strong',label+'：'),doc.createTextNode(value));return p;};
      function render(report){
        output.replaceChildren();
        const general=node('section');general.className='result-card';general.append(node('h2','この画面の保存情報'));
        const mode=report.launchContext?.mode;
        general.append(line('診断画面の起動元',
          mode==='home-screen-app'?'ホーム画面のWebアプリ':mode==='browser'?'Safari等のブラウザ':'未確認'));
        general.append(node('p','iPhoneのホーム画面アプリとSafariでは保存領域が別です。同じURLでも別の画面のデータは確認できません。'));
        general.append(line('移行済みマーカー',report.marker.status==='complete'?yes(report.marker.present):state(report.marker)));
        general.append(line('使用量の見積り',report.estimate.status==='complete'?bytes(report.estimate.usageBytes):state(report.estimate)));
        general.append(line('保存上限の見積り',report.estimate.status==='complete'?bytes(report.estimate.quotaBytes):state(report.estimate)));
        general.append(line('永続保存の許可状態',report.persisted.status==='complete'?(report.persisted.persisted?'許可あり':'許可なし'):state(report.persisted)));
        general.append(node('p','見積りはこのサイト全体の値です。端末本体の空き容量や、次の保存が成功するかは判断できません。'));
        general.append(line('アプリ用キャッシュ',report.cache.status==='complete'?report.cache.count+' 個'+(report.cache.generations.length?'（'+report.cache.generations.map(n=>'v'+n).join('、')+'）':''):state(report.cache)));
        output.append(general);
        const heading=node('h2','セントログの保存領域');output.append(heading,line('一覧の確認',state(report.indexedDB)));
        if(report.indexedDB.status==='complete'&&report.indexedDB.listedSentlogDatabaseCount===0){
          const warning=node('section');warning.className='result-card';
          warning.append(node('h3','重要：保存データの消失とは断定できません'));
          const message=mode==='browser'
            ?'この結果はSafari等のブラウザ側の保存領域です。ホーム画面のセントログの保存データは確認できていません。元のホーム画面アイコンから開く診断画面で確認する必要があります。'
            :mode==='home-screen-app'
            ?'このホーム画面アプリの現在の保存領域では、セントログのデータベースが一覧にありません。iOS内部に元のファイルが残っているか、復旧できるかはこの診断だけでは分かりません。'
            :'この画面の保存領域では、セントログのデータベースが一覧にありません。Safariとホーム画面アプリのどちらを確認したかは判定できません。';
          warning.append(node('p',message));
          warning.append(node('p','アプリの削除・再インストール、Webサイトデータ削除、バックアップの復元・同期のやり直しは行わず、現状を保持してください。'));
          output.append(warning);
        }
        for(const database of report.indexedDB.databases){
          const card=node('section');card.className='result-card';card.append(node('h3',database.label+' '+database.sequence));
          card.append(line('状態',state(database)));if(database.version!==null)card.append(line('DBバージョン',String(database.version)));
          if(database.code)card.append(line('確認情報',database.code+(database.errorName?' / '+database.errorName:'')));
          if(database.presence){
            const p=database.presence,confirmed=p.status==='complete';
            card.append(line('起動用管理項目（META）',confirmed?yes(p.meta):state(p)));
            card.append(line('案件一覧（WS）',confirmed?yes(p.workspace):state(p)));
            card.append(line('旧記録の移行控え',confirmed?yes(p.legacyArchive):state(p)));
          }
          if(database.status==='complete'&&!database.stores.length)card.append(node('p','この保存領域にはストアがありません。'));
          for(const store of database.stores)card.append(line(STORE_LABELS[store.name]||'その他の保存先 '+store.sequence,store.count.toLocaleString('ja-JP')+' 件'));
          output.append(card);
        }
        if(report.indexedDB.excludedDatabaseCount!==null)output.append(node('p','対象外の保存領域 '+report.indexedDB.excludedDatabaseCount+' 個は開いていません。'));
        if(report.finishedAt)output.append(node('p','確認終了：'+new Date(report.finishedAt).toLocaleString('ja-JP')));
      }
      start.onclick=async()=>{
        if(controller)return;controller=new AbortController();last=null;start.disabled=true;stop.hidden=false;save.disabled=true;
        status.textContent='保存領域の有無と件数を確認しています…';output.setAttribute('aria-busy','true');
        try{
          last=await scan({signal:controller.signal,onProgress:render});render(last);
          status.textContent=last.status==='complete'?'確認が終わりました。':last.status==='cancelled'?'確認を中止しました。確認できた範囲を表示します。':'確認が終わりました。未確認の項目があります。';
          save.disabled=false;
        }catch{status.textContent='診断を完了できませんでした。保存データは変更していません。';}
        finally{controller=null;start.disabled=false;stop.hidden=true;output.removeAttribute('aria-busy');}
      };
      stop.onclick=()=>{controller?.abort();status.textContent='確認を中止しています…';};
      save.onclick=()=>{
        if(!last)return;
        try{
          const blob=new Blob([JSON.stringify(last,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=node('a');
          a.href=url;a.download='sentlog-storage-check-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';doc.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
          status.textContent='診断JSONのダウンロードを開始しました。';
        }catch{status.textContent='診断JSONを書き出せませんでした。画面の結果を確認してください。';}
      };
    };
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',install,{once:true});else install();
  }
  return Object.freeze({version:1,scan,mount});
});

/* Read-only, on-demand inventory. Logical value sizes are not physical disk use. */
(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogStorageDiagnostics=api;
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';
  const DATABASES=Object.freeze([
    'surveyFieldNoteDB','sentlog-original-photos-v1','sentlog-delta-migration-v1',
    'sentlog-delta-assets-v1','sentlog-delta-v1'
  ]);
  const ROLES={
    'surveyFieldNoteDB/files':'現在の写真・図面・記録',
    'surveyFieldNoteDB/sentlog_delta_journal_v1':'編集とファイルの保持履歴',
    'surveyFieldNoteDB/sentlog_delta_control_v1':'移行開始時点の保護データ・同期制御',
    'sentlog-original-photos-v1/photos':'端末原本',
    'sentlog-original-photos-v1/meta':'端末原本の管理情報',
    'sentlog-delta-migration-v1/sessions':'移行用の控えの管理情報',
    'sentlog-delta-migration-v1/items':'移行用の写真・図面・記録の控え',
    'sentlog-delta-assets-v1/assets':'同期用に保持する写真・図面',
    'sentlog-delta-v1/replicas':'同期用の記録・送信待ち'
  };
  const KNOWN_KINDS=new Set(['sentlog-app-intent','sentlog-file-retention','cutoff-file',
    'binding','claim','sentlog-binding-state','sentlog-archived-copy','photo','background',
    'drawing','pdf','json','blob','metadata','project']);
  const KNOWN_STATES=new Set(['copying','verified-copy','needs-review','archived-copy',
    'pending','received','staged','verified','ready','acked','active','staging','paused',
    'queued','uploading','uploaded','committed','failed']);
  const DATE_FIELDS=['at','createdAt','updatedAt','storedAt','receivedAt','savedAt','capturedAt','recoveredAt'];
  const METRICS=['logicalBytes','blobBytes','textBytes','binaryBytes','scalarBytes','blobCount','records'];
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const failure=(code,message)=>Object.assign(new Error(message||code),{code});
  const limit=(value,fallback,min,max)=>Number.isFinite(value)?Math.max(min,Math.min(max,Math.floor(value))):fallback;
  const empty=()=>({logicalBytes:0,blobBytes:0,textBytes:0,binaryBytes:0,scalarBytes:0,blobCount:0,records:0});
  let running=false;

  function snapshot(report){
    return {...report,warnings:[...report.warnings],missingDatabases:[...report.missingDatabases],
      excludedDatabases:report.excludedDatabases.map(row=>({...row})),
      databases:report.databases.map(db=>({...db,stores:db.stores.map(store=>({...store,
        kinds:{...store.kinds},states:{...store.states}}))}))};
  }
  function add(target,source){for(const key of METRICS)target[key]+=source[key]||0;}
  function dates(row,store){
    if(!row||typeof row!=='object')return;
    for(const key of DATE_FIELDS){
      const value=row[key];let millis;
      if(typeof value==='number')millis=value;
      else if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value))millis=Date.parse(value);
      else continue;
      if(!Number.isFinite(millis)||millis<315532800000||millis>4133980800000)continue;
      if(store.earliestTimestamp===null||millis<store.earliestTimestamp)store.earliestTimestamp=millis;
      if(store.latestTimestamp===null||millis>store.latestTimestamp)store.latestTimestamp=millis;
    }
    const kind=typeof row.kind==='string'?row.kind:row.descriptor?.kind;
    if(typeof kind==='string'){const label=KNOWN_KINDS.has(kind)?kind:'other';store.kinds[label]=(store.kinds[label]||0)+1;}
    const state=typeof row.status==='string'?row.status:typeof row.state==='string'?row.state:row.phase;
    if(typeof state==='string'){const label=KNOWN_STATES.has(state)?state:'other';store.states[label]=(store.states[label]||0)+1;}
  }
  function* members(value){
    // No Object.values/entries array containing an entire large replica.
    for(const key in value)if(own(value,key))yield [key,value[key]];
  }
  async function measure(value,control){
    const total=empty(),seen=new WeakSet(),stack=[{type:'value',value}],maxNodes=1000000;
    let nodes=0;
    async function textBytes(text){
      let n=0;
      for(let offset=0;offset<text.length;){
        control.check();const end=Math.min(text.length,offset+32768);
        while(offset<end){
          const code=text.charCodeAt(offset++);
          if(code<0x80)n++;
          else if(code<0x800)n+=2;
          else if(code>=0xd800&&code<=0xdbff&&offset<text.length&&
            text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff){n+=4;offset++;}
          else n+=3; // Includes UTF-8 replacement for an unpaired surrogate.
        }
        await control.maybeYield();
      }
      return n;
    }
    while(stack.length){
      control.check();if(++nodes>maxNodes)throw failure('RECORD_LIMIT','一つの記録が大きいため、この保存先の計測を中止しました。');
      const task=stack.pop();
      if(task.type==='iterator'){
        const next=task.iterator.next();if(!next.done){stack.push(task);stack.push({type:'value',value:next.value[1]});stack.push({type:'value',value:next.value[0]});}
        continue;
      }
      const current=task.value;
      if(typeof current==='string'){total.textBytes+=await textBytes(current);continue;}
      if(current===null||current===undefined)continue;
      if(typeof current==='number'){total.scalarBytes+=8;continue;}
      if(typeof current==='boolean'){total.scalarBytes++;continue;}
      if(typeof current==='bigint'){total.textBytes+=await textBytes(String(current));continue;}
      if(typeof current!=='object')continue;
      // Count each Blob reference logically. Browsers may share its physical bytes.
      if(typeof root.Blob==='function'&&current instanceof root.Blob){total.blobBytes+=current.size;total.blobCount++;continue;}
      if(current instanceof ArrayBuffer){total.binaryBytes+=current.byteLength;continue;}
      if(ArrayBuffer.isView(current)){total.binaryBytes+=current.byteLength;continue;}
      if(seen.has(current))continue;seen.add(current);
      if(current instanceof Date){total.scalarBytes+=8;continue;}
      if(current instanceof RegExp){total.textBytes+=await textBytes(current.source+current.flags);continue;}
      if(current instanceof Map)stack.push({type:'iterator',iterator:current.entries()});
      else if(current instanceof Set)stack.push({type:'iterator',iterator:(function*(){for(const item of current)yield [undefined,item];})()});
      else stack.push({type:'iterator',iterator:members(current)});
      if(nodes%256===0)await control.maybeYield();
    }
    total.logicalBytes=total.blobBytes+total.textBytes+total.binaryBytes+total.scalarBytes;
    return total;
  }

  async function scan(options={}){
    const report={schema:1,status:'running',complete:false,reason:null,startedAt:new Date().toISOString(),finishedAt:null,
      ...empty(),databases:[],excludedDatabases:[],excludedDatabaseCount:0,missingDatabases:[],warnings:[
        '論理サイズの合計です。共有されたBlobを重ねて数える場合があり、本体の物理使用量・削減可能量ではありません。',
        '文字はUTF-8換算、数値等は目安です。保存先のキー・索引・管理領域は合計に含みません。',
        '写真の内容やファイル名を出力せず、サイズと件数を調べます。通常の同期・編集と同時に進むため、一時点の完全なスナップショットではありません。',
        'この診断は既知のセントログ用IndexedDBのみを対象にします。ブラウザ内部の一時ファイル、HTTPキャッシュ、OSの使用量は含みません。'
      ]};
    const finish=(status,reason)=>{report.status=status;report.complete=status==='complete';report.reason=reason||null;report.finishedAt=new Date().toISOString();return snapshot(report);};
    if(running)return finish('busy','別の容量診断が実行中です。');
    const factory=options.indexedDB||root.indexedDB,range=options.IDBKeyRange||root.IDBKeyRange;
    if(typeof factory?.databases!=='function'||typeof factory?.open!=='function'||typeof range?.lowerBound!=='function')
      return finish('unsupported','保存先の一覧を安全に取得できないため、診断を実行しませんでした。');
    const signal=options.signal,maxRows=limit(options.maxRows,100000,1,1000000),
      requestTimeout=limit(options.requestTimeoutMs,5000,50,30000),
      deadline=Date.now()+limit(options.maxDurationMs,120000,50,600000),
      yieldEvery=limit(options.yieldEvery,32,1,256);
    let lastYield=Date.now(),currentDatabase=null,currentStore=null,versionChanged=false,stopped=false;
    const cleanupActions=new Set(),connections=new Set();
    const check=()=>{
      if(signal?.aborted||stopped)throw failure('CANCELLED','診断を中止しました。');
      if(Date.now()>=deadline)throw failure('TIME_LIMIT','計測時間の上限に達しました。表示は途中までの集計です。');
      if(versionChanged)throw failure('VERSION_CHANGED','保存先の変更が始まったため、診断を中止しました。');
    };
    const emit=()=>{if(typeof options.onProgress==='function')try{options.onProgress(snapshot(report));}catch{/* A display error never changes stored data. */}};
    const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
    const control={check,async maybeYield(force=false){if(force||Date.now()-lastYield>=12){await pause();lastYield=Date.now();check();}}};
    function requestWait(task){
      return new Promise((resolve,reject)=>{
        let settled=false,cancelTask=()=>{},timer;
        const complete=(error,value)=>{
          if(settled)return;settled=true;clearTimeout(timer);cleanupActions.delete(cancel);
          if(error)reject(error);else resolve(value);
        };
        const cancel=error=>{if(settled)return;try{cancelTask();}catch{}complete(error||failure('CANCELLED','診断を中止しました。'));};
        cleanupActions.add(cancel);
        const remaining=deadline-Date.now(),globalTimeout=remaining<=requestTimeout;
        timer=setTimeout(()=>cancel(globalTimeout?
          failure('TIME_LIMIT','計測時間の上限に達しました。表示は途中までの集計です。'):
          failure('REQUEST_TIMEOUT','保存先からの応答がないため、この診断を中止しました。')),
          Math.max(1,Math.min(requestTimeout,remaining)));
        try{check();cancelTask=task((error,value)=>complete(error,value),()=>settled)||cancelTask;}catch(error){complete(error);}
      });
    }
    function openExisting(name){
      return requestWait((done,ended)=>{
        let upgrade=false,request=factory.open(name); // Never request a database version.
        request.onupgradeneeded=()=>{upgrade=true;try{request.transaction.abort();}catch{};};
        request.onerror=()=>done(failure(upgrade?'DATABASE_CHANGED':'OPEN_FAILED',upgrade?
          '一覧の取得後に保存先が変更されました。作成・更新せず中止しました。':'保存先を開けませんでした。'));
        request.onblocked=()=>done(failure('OPEN_BLOCKED','別の処理が保存先を変更中のため、開かずに中止しました。'));
        request.onsuccess=()=>{
          const db=request.result;
          if(ended()||upgrade||signal?.aborted||Date.now()>=deadline){db.close();done(failure('CANCELLED','診断を中止しました。'));return;}
          connections.add(db);
          db.onversionchange=()=>{versionChanged=true;db.close();connections.delete(db);
            for(const cancel of [...cleanupActions])cancel(failure('VERSION_CHANGED','保存先の変更が始まったため、診断を中止しました。'));};
          done(null,db);
        };
        // IDBOpenDBRequest cannot be cancelled. Its late upgrade is aborted and
        // its late successful connection is immediately closed by the handlers.
        return ()=>{if(request.readyState==='done')try{request.result?.close();}catch{}};
      });
    }
    function readNext(db,storeName,lastKey,hasLast,includeCount){
      return requestWait(done=>{
        let transaction;
        try{transaction=db.transaction(storeName,'readonly');}catch(error){done(error);return;}
        let result={found:false,recordsAtStart:null},problem=null;
        transaction.oncomplete=()=>done(problem,result);
        transaction.onabort=()=>done(problem||failure('READ_ABORTED','保存先の読取りが中断されました。'));
        transaction.onerror=()=>{};
        try{
          const store=transaction.objectStore(storeName);
          if(includeCount){const count=store.count();count.onsuccess=()=>{result.recordsAtStart=count.result;};}
          const cursor=store.openCursor(hasLast?range.lowerBound(lastKey,true):null);
          cursor.onsuccess=()=>{
            const row=cursor.result;if(row){result.found=true;result.key=row.primaryKey;result.value=row.value;}
            // One record only; let the readonly transaction finish before any
            // async traversal of large text. Never hold a batch of full replicas.
          };
        }catch(error){problem=error;try{transaction.abort();}catch{done(error);}}
        return ()=>{try{transaction.abort();}catch{}};
      });
    }
    const abort=()=>{stopped=true;for(const cancel of [...cleanupActions])cancel(failure('CANCELLED','診断を中止しました。'));};
    running=true;signal?.addEventListener?.('abort',abort,{once:true});
    try{
      check();
      const listed=await requestWait(done=>{Promise.resolve(factory.databases()).then(value=>done(null,value),error=>done(error));});
      check();if(!Array.isArray(listed))throw failure('ENUMERATION_FAILED','保存先の一覧を確認できませんでした。');
      const candidates=new Map();
      for(const row of listed){
        if(!row||typeof row.name!=='string')continue;
        if(DATABASES.includes(row.name))candidates.set(row.name,row);
        else{report.excludedDatabaseCount++;if(report.excludedDatabases.length<128)report.excludedDatabases.push({name:row.name,version:row.version??null});}
      }
      report.missingDatabases=DATABASES.filter(name=>!candidates.has(name));
      // Hidden retention stores first, so a time-limited scan still has useful
      // evidence before traversing the already-visible photo collection.
      const order=['sentlog-delta-migration-v1','surveyFieldNoteDB','sentlog-delta-assets-v1',
        'sentlog-delta-v1','sentlog-original-photos-v1'];
      for(const name of order){
        if(!candidates.has(name))continue;check();
        const row=candidates.get(name),dbReport={name,listedVersion:row.version??null,openedVersion:null,
          status:'running',reason:null,stores:[]};report.databases.push(dbReport);currentDatabase=dbReport;
        const db=await openExisting(name);check();dbReport.openedVersion=db.version;
        const stores=Array.from(db.objectStoreNames).sort((a,b)=>(a==='files'?1:0)-(b==='files'?1:0));
        for(const storeName of stores){
          check();const storeReport={name:storeName,role:ROLES[name+'/'+storeName]||'この保存先のその他の情報',
            status:'running',reason:null,recordsAtStart:null,...empty(),earliestTimestamp:null,latestTimestamp:null,kinds:{},states:{}};
          dbReport.stores.push(storeReport);currentStore=storeReport;emit();
          let hasLast=false,lastKey;
          while(true){
            check();if(report.records>=maxRows)throw failure('ROW_LIMIT','計測件数の上限に達しました。表示は途中までの集計です。');
            const row=await readNext(db,storeName,lastKey,hasLast,!hasLast);check();
            if(!hasLast)storeReport.recordsAtStart=row.recordsAtStart;
            if(!row.found)break;
            const metrics=await measure(row.value,control);check();metrics.records=1;
            add(storeReport,metrics);add(report,metrics);dates(row.value,storeReport);
            lastKey=row.key;hasLast=true;
            if(report.records%yieldEvery===0){emit();await control.maybeYield(true);}
          }
          storeReport.status='complete';currentStore=null;emit();
        }
        dbReport.status='complete';currentDatabase=null;db.close();connections.delete(db);emit();
      }
      return finish('complete');
    }catch(error){
      const cancelled=error?.code==='CANCELLED',reason=error?.message||'容量診断を完了できませんでした。';
      if(currentStore){currentStore.status='partial';currentStore.reason=reason;}
      if(currentDatabase){currentDatabase.status='partial';currentDatabase.reason=reason;}
      return finish(cancelled?'cancelled':report.databases.length?'partial':'failed',reason);
    }finally{
      stopped=true;signal?.removeEventListener?.('abort',abort);
      for(const cancel of [...cleanupActions])cancel(failure('CANCELLED','診断を終了しました。'));
      for(const db of connections)try{db.close();}catch{}
      connections.clear();running=false;
    }
  }
  return Object.freeze({scan,databaseNames:DATABASES});
});

/* v1.30. IndexedDB is the durable source of truth for records, not localStorage.
   The synchronous read mirror supports the existing canvas editor. Writes commit in
   ordered, atomic transactions; sync/export/reload explicitly await flush(). */
(function () {
  'use strict';
  if (window.SentlogRecords) return;
  const DB='surveyFieldNoteDB', STORE='files', PREFIX='__sentlog_record__:', DB_VERSION=2;
  const JOURNAL='sentlog_delta_journal_v1', CONTROL='sentlog_delta_control_v1';
  const META='__sentlog_records_meta_v130__', ARCHIVE='__sentlog_records_archive_v130__';
  const MARKER='sentlogRecordsReadyV130', WS='surveyFieldNoteWorkspaceV1';
  const DRAW='surveyFieldNoteDrawingV1:', SYNC='sentlogCloudProjectSyncV2:';
  const managed=k=>k===WS || k==='surveyFieldNoteV2' || k.startsWith(DRAW) || k.startsWith(SYNC);
  let memory=new Map(), durableMemory=new Map(), pending=new Map(), pendingOptions=[], revision=0, connection=null;
  let initialized=false, boot=null, flight=null, queued=false, inFlight=0, exclusive=false;
  let migrationInfo=null, operation=false, failure=null;
  let recordFailure=null,connectionFailure=null;
  const recordTransactions=new WeakMap();
  const FAILURE_HISTORY_LIMIT=16,failureEvents=[];
  const diagnosticErrorNames=['AbortError','ConstraintError','DataCloneError','DataError','InvalidAccessError','InvalidStateError','NotFoundError',
    'NotReadableError','QuotaExceededError','ReadOnlyError','SecurityError','TimeoutError','TransactionInactiveError','UnknownError','VersionError','TypeError','Error'];
  let failureSequence=0,droppedFailureEvents=0,firstRecordFailureEvent=null,latestRecordFailureEvent=null;
  const listeners=new Set(), failures=new Map(), fileTasks=new Set(), failedFiles=new Map(), fileWriters=new Map(), fileGenerations=new Map(), fileTaskOwners=new Map();
  let bindings=new Map(),cutoffFiles=new Map();
  function notify(){for(const fn of listeners){try{fn()}catch(e){console.warn('Storage status',e)}}}
  function report(key,error){key=String(key);if(key==='records'&&connectionFailure)error=connectionFailure;failures.set(key,error?.message||String(error));notify();}
  function recovered(key){if(String(key)==='records'&&connectionFailure)return;if(failures.delete(String(key)))notify();}
  function assertReady(){if(!initialized)throw Error('保存先の準備が完了していません');}
  function transaction(mode){
    if(connectionFailure)throw connectionFailure;
    if(!connection)throw Error('保存先との接続が切れました。画面を閉じず、再保存を試してください。');
    const stores=[STORE,JOURNAL,CONTROL];
    try{return connection.transaction(stores,mode,{durability:'strict'})}
    catch(e){if(e.name==='TypeError')return connection.transaction(stores,mode);throw e;}
  }
  function complete(tx){return new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.sentlogJournalError||tx.error||Error('端末への保存が中断されました'));
    tx.onerror=()=>{};
  });}
  function diagnosticErrorName(error){try{const name=error?.name;return diagnosticErrorNames.includes(name)?name:'Error';}catch{return 'Error';}}
  function nativeMessageClass(error){
    // Export constants only, never the native message itself: it can contain
    // record keys, account identifiers or filesystem paths. A matched phrase is
    // evidence about the message, not a diagnosis of the underlying cause.
    try{
      const message=error?.message;if(typeof message!=='string'||message.length>1024)return 'unavailable';
      if(!message)return 'empty';
      if(/disk full|no space left|not enough (?:disk )?space/i.test(message))return 'disk-space-mentioned';
      if(/\bi\/?o error\b/i.test(message))return 'io-mentioned';
      if(/(?:database )?connection (?:is |was |has been )?(?:clos(?:ed|ing)|lost)/i.test(message))return 'connection-closed-mentioned';
      if(/\bquota(?:exceedederror)?\b/i.test(message))return 'quota-mentioned';
      if(/\babort(?:ed)?\b/i.test(message))return 'abort-mentioned';
      return 'unclassified';
    }catch{return 'unavailable';}
  }
  function copyFailureEvent(event){return event?{...event,...(event.detail?{detail:{...event.detail}}:{})}:null;}
  function rememberFailureEvent(kind,fields={}){
    // This history lives only in this page's memory. Never open storage, retry,
    // or change exception handling in order to record a diagnostic event.
    try{
      const event={sequence:++failureSequence,observedAt:new Date().toISOString(),kind,...fields};
      failureEvents.push(event);if(failureEvents.length>FAILURE_HISTORY_LIMIT){failureEvents.shift();droppedFailureEvents++;}
      if(kind==='record-save-failed'){firstRecordFailureEvent=firstRecordFailureEvent||event;latestRecordFailureEvent=event;}
    }catch{}
  }
  function rememberVersionChange(event){
    let oldVersion=null,newVersion=null,change='unknown';
    try{
      const old=event?.oldVersion,next=event?.newVersion;
      if(Number.isSafeInteger(old)&&old>=0)oldVersion=old;
      if(next===null)change='delete-request';
      else if(Number.isSafeInteger(next)&&next>0){newVersion=next;change='upgrade-request';}
    }catch{}
    rememberFailureEvent('database-versionchange',{change,oldVersion,newVersion});
  }
  function failureHistory(){return {version:1,scope:'current-page-memory',capacity:FAILURE_HISTORY_LIMIT,droppedEvents:droppedFailureEvents,
    firstRecordFailure:copyFailureEvent(firstRecordFailureEvent),latestRecordFailure:copyFailureEvent(latestRecordFailureEvent),
    current:{connection:connectionFailure?'unexpected-close':connection?'open':'not-open',recordsFailed:failures.has('records')},
    events:failureEvents.map(copyFailureEvent)};}
  // Observe record batches without changing request/transaction error handling.
  // No keys, values, account IDs, messages or Blob contents enter this detail.
  function recordStoreName(source){
    const name=source?.name;return [STORE,JOURNAL,CONTROL].includes(name)?name:null;
  }
  function observeRecordTransaction(tx){
    const probe={requested:0,succeeded:0,queued:false,covered:true,cause:null};recordTransactions.set(tx,probe);
    try{tx.addEventListener('error',event=>{
      try{const request=event.target;
        if(request!==tx&&!probe.cause&&request.error?.name!=='AbortError')probe.cause={phase:'request',
          store:recordStoreName(request.source)||recordStoreName(request.source?.objectStore),operation:null};
      }catch{}
    });}catch{probe.covered=false;}
    return probe;
  }
  function recordRequest(tx,store,operation,...args){
    const probe=recordTransactions.get(tx);if(!probe)return store[operation](...args);
    let request;
    try{request=store[operation](...args);}
    catch(error){probe.cause=probe.cause||{phase:'request-create',store:recordStoreName(store),operation};throw error;}
    probe.requested++;
    try{
      request.addEventListener('success',()=>{probe.succeeded++;});
      request.addEventListener('error',()=>{
        try{if(!probe.cause&&request.error?.name!=='AbortError')probe.cause={phase:'request',store:recordStoreName(store),operation};}catch{}
      });
    }catch{probe.covered=false;}
    return request;
  }
  function rememberRecordFailure(error,batch,tx){
    // Diagnostics are secondary: even failure to measure a large string must
    // preserve the original exception and the retryable editor state.
    try{
      const probe=tx&&recordTransactions.get(tx),cause=probe?.cause||{
        phase:!tx?'transaction-open':probe?.covered&&probe.queued&&probe.requested>0&&probe.succeeded===probe.requested&&!tx.sentlogJournalError?'commit':'transaction',
        store:null,operation:null};
      let recordValueBytes=0,recordsToWrite=0,recordsToDelete=0;
      for(const value of batch.values()){
        if(value===null){recordsToDelete++;continue;}recordsToWrite++;
        if(recordValueBytes!==null)try{recordValueBytes+=new Blob([value]).size;}catch{recordValueBytes=null;}
      }
      recordFailure={error,detail:{version:1,errorName:diagnosticErrorName(error),...cause,
        requestedRecords:batch.size,recordsToWrite,recordsToDelete,recordValueBytes}};
    }catch{recordFailure=null;}
    rememberFailureEvent('record-save-failed',{errorName:diagnosticErrorName(error),nativeMessageClass:nativeMessageClass(error),detail:recordFailure?{...recordFailure.detail}:null});
  }
  async function connect(){
    if(connectionFailure)throw connectionFailure;
    if(connection)return;
    connection=await new Promise((resolve,reject)=>{
      const q=indexedDB.open(DB,DB_VERSION);
      q.onupgradeneeded=()=>{for(const name of [STORE,JOURNAL,CONTROL]){
        const store=q.result.objectStoreNames.contains(name)?q.transaction.objectStore(name):q.result.createObjectStore(name);
        if(name!==STORE&&!store.indexNames.contains('kind'))store.createIndex('kind','kind');
      }};
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
      q.onblocked=()=>reject(Error('別のセントログ画面が保存先を使用中です。ほかの画面を閉じて再試行してください。'));
    });
    const db=connection;
    db.onversionchange=event=>{if(connection!==db)return;rememberVersionChange(event);db.close();connection=null;failure=Error('保存先が別の画面で更新されました。未保存の記録を退避してから更新してください。');report('records',failure);};
    db.onclose=()=>{
      if(connection!==db)return;
      rememberFailureEvent('database-unexpected-close',{reason:'not-reported'});
      // An unexpected close does not authorize opening a new database or
      // replaying this tab's memory into it. Keep the editable mirror for rescue.
      connection=null;connectionFailure=Object.assign(Error('端末内の保存先との接続が予期せず終了しました。保存を停止しています。画面を閉じたり更新したりせず、まず記録の控えを書き出してください。'),{code:'RECORD_CONNECTION_CLOSED'});
      failure=connectionFailure;report('records',failure);
    };
  }
  async function editorLock(){
    if(!navigator.locks?.request)return;
    await new Promise((resolve,reject)=>{
      navigator.locks.request('sentlog-record-writer-v130',{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock){reject(Error('同じブラウザでセントログが別に開いています。ほかのセントログ本体を閉じて再読み込みしてください。PC自動同期の画面は閉じなくて大丈夫です。'));return;}
        resolve();await new Promise(()=>{});
      }).catch(reject);
    });
  }
  async function readAll(){
    const tx=transaction('readonly'),done=complete(tx),s=tx.objectStore(STORE);
    let meta=null,archive=null,metaExists=false,archiveExists=false,journalCount=0,controlCount=0,keys=[],values=[];
    s.get(META).onsuccess=e=>meta=e.target.result;
    s.get(ARCHIVE).onsuccess=e=>archive=e.target.result;
    s.count(META).onsuccess=e=>metaExists=e.target.result>0;
    s.count(ARCHIVE).onsuccess=e=>archiveExists=e.target.result>0;
    tx.objectStore(JOURNAL).count().onsuccess=e=>journalCount=e.target.result;
    tx.objectStore(CONTROL).count().onsuccess=e=>controlCount=e.target.result;
    const range=IDBKeyRange.bound(PREFIX,PREFIX+'\uffff');
    s.getAllKeys(range).onsuccess=e=>keys=e.target.result;
    s.getAll(range).onsuccess=e=>values=e.target.result;
    await done;
    return {meta,archive,metaExists,archiveExists,recordCount:keys.length,journalCount,controlCount,
      map:new Map(keys.map((k,i)=>[k.slice(PREFIX.length),values[i]]))};
  }
  function legacy(){
    const out=new Map();
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(key && managed(key))out.set(key,localStorage.getItem(key));
    }
    for(const [key,value] of out){
      if(typeof value!=='string')throw Error('旧保存データを読み取れません。元データは削除していません。');
      try{const obj=JSON.parse(value);if(key===WS && (!obj || !Array.isArray(obj.projects)))throw Error();}
      catch(_){throw Error('旧保存データに読み取れない記録があります。元データを残して移行を停止しました。');}
    }
    return out;
  }
  function cleanLegacy(entries){
    // Delete only exact copies verified after the IndexedDB transaction committed.
    for(const [key,value] of entries){if(localStorage.getItem(key)===value)localStorage.removeItem(key);}
  }
  function startupUnsafe(detail){return Object.assign(Error(detail+'保存済みデータを変更せず起動を停止しました。バックアップを保全してから確認してください。'),{code:'RECORD_STARTUP_UNSAFE'});}
  function requireNewStorage(disk){
    // This marker is written only after a completed initialization. Legacy
    // localStorage copies cannot authorize a fresh migration after its DB loss.
    if(localStorage.getItem(MARKER)!==null)throw Error('以前の端末内データを確認できません。空のデータで上書きせず起動を停止しました。バックアップの復旧が必要です。');
    if(disk.metaExists||disk.archiveExists||disk.recordCount||disk.journalCount||disk.controlCount)
      throw startupUnsafe('管理情報と残っている記録の整合を確認できません。');
  }
  function validateStoredRecords(disk){
    if(!disk.metaExists||!disk.meta||typeof disk.meta!=='object'||Array.isArray(disk.meta))
      throw startupUnsafe('端末内の管理情報を確認できません。');
    if(!disk.map.has(WS))throw startupUnsafe('端末内の案件一覧を確認できません。');
    for(const [key,value] of disk.map){
      if(!managed(key)||typeof value!=='string')throw startupUnsafe('保存記録の形式を確認できません。');
      if(key===WS){
        let workspace;try{workspace=JSON.parse(value);}catch{throw startupUnsafe('案件一覧の形式を確認できません。');}
        if(!workspace||typeof workspace!=='object'||Array.isArray(workspace)||!Array.isArray(workspace.projects))
          throw startupUnsafe('案件一覧の形式を確認できません。');
      }else JSON.parse(value);
    }
  }
  async function initialize(){
    await editorLock();await connect();
    let disk=await readAll();
    const old=legacy();let migrated=false;
    if(!disk.metaExists){
      requireNewStorage(disk);
      const tx=transaction('readwrite'),done=complete(tx),s=tx.objectStore(STORE);
      const info={schema:1,revision:0,migratedAt:new Date().toISOString(),legacyCount:old.size};
      const current={metaExists:false,archiveExists:false,recordCount:0,journalCount:0,controlCount:0};let waiting=5;
      const stop=error=>{tx.sentlogJournalError=error;try{tx.abort();}catch{}};
      function checked(field,value){
        current[field]=value;if(--waiting)return;
        try{
          // All five checks share the migration write transaction. A writer
          // arriving after readAll() must be observed before any initialization.
          requireNewStorage(current);
          for(const [key,value] of old)s.put(value,PREFIX+key);
          if(!old.has(WS))s.put('{"projects":[]}',PREFIX+WS);
          s.put({migratedAt:info.migratedAt,entries:[...old]},ARCHIVE);
          s.put(info,META);
        }catch(error){stop(error);}
      }
      try{
        s.count(META).onsuccess=e=>checked('metaExists',e.target.result>0);
        s.count(ARCHIVE).onsuccess=e=>checked('archiveExists',e.target.result>0);
        s.count(IDBKeyRange.bound(PREFIX,PREFIX+'\uffff')).onsuccess=e=>checked('recordCount',e.target.result);
        tx.objectStore(JOURNAL).count().onsuccess=e=>checked('journalCount',e.target.result);
        tx.objectStore(CONTROL).count().onsuccess=e=>checked('controlCount',e.target.result);
      }catch(error){stop(error);}
      await done;disk=await readAll();
      migrated=true;
    }
    // Validate before deleting any old local copies or converting retained files.
    validateStoredRecords(disk);
    if(migrated){
      for(const [key,value] of old)if(disk.map.get(key)!==value)throw Error('移行後の記録照合に失敗しました。元データは削除していません。');
      cleanLegacy(old);
    }else if(old.size){
      // A pre-migration tab must not silently revive/overwrite newer records.
      const archived=new Map(disk.archive?.entries||[]);
      for(const [key,value] of old)if(archived.get(key)!==value && disk.map.get(key)!==value)
        throw Error('旧版の画面で変更された記録があります。どちらも上書きせず停止しました。旧版の控えを書き出してから確認してください。');
      cleanLegacy(old);
    }
    memory=disk.map;durableMemory=new Map(memory);revision=Number(disk.meta.revision)||0;migrationInfo=disk.meta;
    await ensureCutoffFiles();
    try{localStorage.setItem(MARKER,'1');}catch(_){}
    initialized=true;notify();return true;
  }
  function init(){if(!boot)boot=initialize();return boot;}
  const copy=value=>structuredClone(value);
  const scopeKeys=['ownerId','projectId','deviceId'];
  const FILE_CHUNK_BYTES=2*1024*1024;
  const FILE_COMPARE_MS=5000;
  function fileIdentity(value){
    if(!(value instanceof Blob))return null;
    return JSON.stringify([value.size,value.type,typeof value.name==='string'?value.name:null,
      Number.isFinite(value.lastModified)?value.lastModified:null]);
  }
  async function recordBlobHash(blob){
    if(window.SentlogBlobSha256?.digest)return window.SentlogBlobSha256.digest(blob,{crypto});
    if(blob.size>FILE_CHUNK_BYTES)throw journalError('JOURNAL_HASH_UNAVAILABLE','大きなファイルを安全に照合する機能を読み込めません。保存済みデータを保持して停止しました。画面を更新してください。');
    const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  const sameScope=(a,b)=>a&&b&&scopeKeys.every(k=>a[k]===b[k]);
  const cutoffFileKey=(bindingId,index)=>'cutoff-file:'+JSON.stringify([bindingId,index]);
  function checkedCutoffFile(binding,file,index,rows=cutoffFiles){
    const id=cutoffFileKey(binding.id,index),row=rows.get(id);
    if(file.valueRef!==id||!row||row.version!==1||row.kind!=='cutoff-file'||row.id!==id||
      row.bindingId!==binding.id||row.localProjectId!==binding.localProjectId||!sameScope(row.scope,binding.scope)||
      row.key!==file.key||!Number.isSafeInteger(row.revision)||row.revision<1||
      !(row.value instanceof Blob||row.value===null&&row.archiveRelease?.kind==='sentlog-archived-copy'&&
        sameScope(row.archiveRelease.scope,binding.scope)&&row.archiveRelease.localProjectId===binding.localProjectId&&row.archiveRelease.file?.key===file.key))
      throw journalError('JOURNAL_CUTOFF_REF','保護した移行前ファイルの参照を確認できません。元の記録を保持しています');
    return row;
  }
  function hydrateBinding(binding,rows=cutoffFiles){
    if(!binding)return null;const result=copy(binding);
    if(result.cutoff?.files)result.cutoff.files=result.cutoff.files.map((file,index)=>{
      if(!Object.prototype.hasOwnProperty.call(file,'valueRef'))return file;
      const row=checkedCutoffFile(binding,file,index,rows),out={...file,value:copy(row.value)};delete out.valueRef;
      if(row.archiveRelease)out.archiveRelease=copy(row.archiveRelease);return out;
    });
    return result;
  }
  // Ownership and lifecycle checks do not consume migration snapshots or
  // retained photo bytes. Keep their public value deliberately small; the
  // full readers below still validate/hydrate cutoffs when they are required.
  function bindingState(binding){
    if(!binding)return null;
    const cutoff=binding.cutoff;
    if(binding.version!==1||binding.kind!=='binding'||typeof binding.id!=='string'||!binding.id||
      typeof binding.localProjectId!=='string'||!binding.localProjectId||!['staging','active','detached'].includes(binding.phase)||
      !Number.isSafeInteger(binding.cutoffSeq)||binding.cutoffSeq<0||!Number.isSafeInteger(binding.ackedSeq)||binding.ackedSeq<binding.cutoffSeq||
      (binding.baselineId!=null&&(typeof binding.baselineId!=='string'||!binding.baselineId))||
      (binding.phase!=='staging'&&!binding.baselineId)||cutoff?.version!==1||cutoff.kind!=='sentlog-journal-cutoff'||
      cutoff.bindingId!==binding.id||cutoff.localProjectId!==binding.localProjectId||cutoff.cutoffSeq!==binding.cutoffSeq||
      (cutoff.serverRevision!=null&&(!Number.isSafeInteger(cutoff.serverRevision)||cutoff.serverRevision<1))||
      !sameScope(cutoff.scope,binding.scope))throw journalError('JOURNAL_BINDING','案件の保存接続を確認できません');
    return {version:1,kind:'sentlog-binding-state',id:binding.id,localProjectId:binding.localProjectId,
      scope:checkedScope(binding.scope),phase:binding.phase,baselineId:binding.baselineId??null,
      cutoffSeq:binding.cutoffSeq,ackedSeq:binding.ackedSeq,serverRevision:cutoff.serverRevision};
  }
  function cacheControls(rows){
    const files=new Map(rows.filter(row=>row?.kind==='cutoff-file').map(row=>[row.id,row]));
    const next=new Map(rows.filter(row=>row?.kind==='binding').map(row=>[row.localProjectId,row]));
    // Validate references directly. Hydrating and discarding every project's
    // full cutoff cloned all retained record snapshots and Blob handles.
    for(const binding of next.values())for(const [index,file]of (binding.cutoff?.files||[]).entries())
      if(Object.prototype.hasOwnProperty.call(file,'valueRef'))checkedCutoffFile(binding,file,index,files);
    cutoffFiles=files;bindings=next;
  }
  async function readControls(){
    const tx=transaction('readonly'),done=complete(tx);let rows=[];
    tx.objectStore(CONTROL).getAll().onsuccess=e=>rows=e.target.result;await done;return rows;
  }
  async function readControl(key){
    const tx=transaction('readonly'),done=complete(tx);let value;
    tx.objectStore(CONTROL).get(key).onsuccess=e=>value=e.target.result;await done;return value;
  }
  async function readProjectBinding(localProjectId){
    const tx=transaction('readonly'),done=complete(tx),control=tx.objectStore(CONTROL),files=new Map();let binding;
    control.get('binding:'+localProjectId).onsuccess=e=>{
      try{
        binding=e.target.result;if(binding===undefined)return;
        if(!binding||binding.localProjectId!==localProjectId)throw journalError('JOURNAL_BINDING','案件の保存接続を確認できません');
        bindingState(binding);
        for(const [index,file]of (binding.cutoff.files||[]).entries()){
          if(!Object.prototype.hasOwnProperty.call(file,'valueRef'))continue;
          const id=cutoffFileKey(binding.id,index);
          control.get(id).onsuccess=event=>files.set(id,event.target.result);
        }
      }catch(error){tx.sentlogJournalError=error;tx.abort();}
    };await done;
    if(binding===undefined){bindings.delete(localProjectId);return null;}
    // One readonly transaction supplies the binding and all of its protected
    // file rows. Never mix one tab's binding with another tab's newer files.
    const hydrated=hydrateBinding(binding,files);
    bindings.set(localProjectId,binding);for(const [id,row]of files)cutoffFiles.set(id,row);
    return hydrated;
  }
  async function splitEmbeddedCutoff(binding){
    const beforeText=archiveReleaseText(binding),files=binding.cutoff?.files||[],refs=new Map();
    // Old embedded cutoffs are converted once, one file at a time. A crash
    // leaves the original binding intact and add-only staged rows reusable.
    for(const [index,file]of files.entries()){
      if(file.valueRef||!(file.value instanceof Blob))continue;
      const id=cutoffFileKey(binding.id,index),prior=await readControl(id),hasPrior=prior!==undefined;
      let value,sha256;
      if(hasPrior){
        // A partially completed startup already owns an immutable copy. Verify
        // both byte sources before reusing it; do not materialize another large
        // Blob just to discover that the same durable row is already present.
        sha256=await recordBlobHash(file.value);value=file.value;
      }else{
        // Safari cannot reliably re-put some native database-backed Blobs. Keep
        // creating independent byte-backed parts, without one giant JS buffer.
        // This bounds temporary ArrayBuffers, not the final Blob's total bytes.
        const parts=[];
        for(let offset=0;offset<file.value.size;offset+=FILE_CHUNK_BYTES){
          const end=Math.min(offset+FILE_CHUNK_BYTES,file.value.size),bytes=await file.value.slice(offset,end).arrayBuffer();
          if(bytes.byteLength!==end-offset)throw journalError('JOURNAL_CUTOFF_BYTES','移行前の控えを読み取れません');
          parts.push(new Blob([bytes]));
        }
        value=typeof File==='function'&&typeof file.value.name==='string'?
          new File(parts,file.value.name,{type:file.value.type,lastModified:file.value.lastModified}):new Blob(parts,{type:file.value.type});
        parts.length=0;sha256=await recordBlobHash(value);
      }
      const row={version:1,kind:'cutoff-file',id,bindingId:binding.id,
        localProjectId:binding.localProjectId,scope:copy(binding.scope),key:file.key,revision:1,value,sha256};
      const expected=archiveReleaseText(row);
      if(hasPrior&&(archiveReleaseText(prior)!==expected||!await archiveReleaseMatches(prior.value,{size:value.size,sha256})))
        throw journalError('JOURNAL_CUTOFF_COLLISION','移行前のファイル控えに異なる内容があります。両方を保持しています');
      const tx=transaction('readwrite'),done=complete(tx),control=tx.objectStore(CONTROL);let current,existing,waiting=2;
      const ready=()=>{if(--waiting)return;try{
        if(archiveReleaseText(current)!==beforeText)throw journalError('JOURNAL_CUTOFF_STALE','移行前の控えが更新されました。保存済みの内容を再確認します');
        if(existing!==undefined){if(archiveReleaseText(existing)!==expected)throw journalError('JOURNAL_CUTOFF_COLLISION','保護ファイルの保存先が変更されました');}
        else{
          // A verified row disappearing during the read is a changed storage
          // state, not permission to write its native Blob back under that ID.
          if(hasPrior)throw journalError('JOURNAL_CUTOFF_COLLISION','確認した保護ファイルの保存先が変更されました');
          control.add(row,id);
        }
      }catch(error){tx.sentlogJournalError=error;tx.abort();}};
      control.get('binding:'+binding.localProjectId).onsuccess=e=>{current=e.target.result;ready();};
      control.get(id).onsuccess=e=>{existing=e.target.result;ready();};await done;
      refs.set(index,{id,text:expected});
    }
    if(!refs.size)return;
    const next=copy(binding);next.cutoff.files=files.map((file,index)=>{
      const ref=refs.get(index);if(!ref)return copy(file);const out={...file,valueRef:ref.id};delete out.value;return out;
    });
    const tx=transaction('readwrite'),done=complete(tx),control=tx.objectStore(CONTROL);let current,waiting=1+refs.size;const rows=new Map();
    const ready=()=>{if(--waiting)return;try{
      if(archiveReleaseText(current)!==beforeText)throw journalError('JOURNAL_CUTOFF_STALE','確認中に移行前の控えが変わりました');
      for(const ref of refs.values())if(archiveReleaseText(rows.get(ref.id))!==ref.text)
        throw journalError('JOURNAL_CUTOFF_COLLISION','保護したファイルの控えが変わりました');
      control.put(next,'binding:'+binding.localProjectId);
    }catch(error){tx.sentlogJournalError=error;tx.abort();}};
    control.get('binding:'+binding.localProjectId).onsuccess=e=>{current=e.target.result;ready();};
    for(const ref of refs.values())control.get(ref.id).onsuccess=e=>{rows.set(ref.id,e.target.result);ready();};await done;
  }
  async function ensureCutoffFiles(){
    for(let attempt=0;attempt<3;attempt++){
      const rows=await readControls();
      try{for(const binding of rows.filter(row=>row?.kind==='binding'))await splitEmbeddedCutoff(binding);}
      catch(error){if(error.code==='JOURNAL_CUTOFF_STALE'&&attempt<2)continue;throw error;}
      cacheControls(await readControls());return;
    }
  }
  function journalError(code,message){return Object.assign(Error(message),{code});}
  function checkedScope(scope){
    if(!scope||!scopeKeys.every(k=>typeof scope[k]==='string'&&scope[k].length>0&&scope[k].length<=512))
      throw journalError('JOURNAL_SCOPE','共有する利用者・案件・端末を確認できません');
    return Object.fromEntries(scopeKeys.map(k=>[k,scope[k]]));
  }
  function contextOf(options={}){
    return {origin:typeof options.origin==='string'?options.origin:'local',
      operation:typeof options.operation==='string'?options.operation:'edit',
      ...(options.context&&typeof options.context==='object'?{context:copy(options.context)}:{})};
  }
  function journalRows(store){return store.indexNames.contains('kind')?store.index('kind').getAll('sentlog-app-intent'):store.getAll();}
  function journalControls(store){return store.indexNames.contains('kind')?
    store.index('kind').getAll(IDBKeyRange.bound('binding','claim')):store.getAll();}
  function workspaceOf(raw){const out=raw?JSON.parse(raw):{projects:[]};if(!Array.isArray(out?.projects))throw journalError('JOURNAL_WORKSPACE','案件一覧の形式を確認できません');return out;}
  function affectedProjects(changes,workspaceBefore,workspaceAfter,files=[]){
    const before=workspaceOf(workspaceBefore),after=workspaceOf(workspaceAfter),ids=new Set(),drawingIds=new Set();
    for(const change of changes)if(change.key.startsWith(DRAW))drawingIds.add(change.key.slice(DRAW.length));
    for(const file of files){const match=/^(?:background:([^:]+)|photo:([^:]+):)/.exec(file.key);if(match)drawingIds.add(match[1]||match[2]);}
    const old=new Map(before.projects.map(p=>[p.id,p])),next=new Map(after.projects.map(p=>[p.id,p]));
    if(changes.some(x=>x.key===WS))for(const id of new Set([...old.keys(),...next.keys()]))
      if(JSON.stringify(old.get(id))!==JSON.stringify(next.get(id)))ids.add(id);
    for(const project of [...before.projects,...after.projects])if((project.drawings||[]).some(d=>drawingIds.has(d.id)))ids.add(project.id);
    return {projectIds:[...ids],drawingIds:[...drawingIds]};
  }
  function rejectOldRemote(writes,options){
    if(options?.origin!=='remote'||!bindings.size)return;
    const changes=writes.filter(([key,value])=>(memory.get(key)??null)!==value).map(([key,after])=>({key,after}));
    const before=memory.get(WS)||null,workspaceChange=changes.find(x=>x.key===WS),after=workspaceChange?workspaceChange.after:before;
    if(affectedProjects(changes,before,after).projectIds.some(id=>bindings.has(id)))
      throw journalError('JOURNAL_REMOTE_WRITER','この案件は差分共有に移行済みです。旧方式の受信による上書きを止めました');
  }
  function assertLegacyPdfHandover(bound,projectIds,cloudProjectIds,fileKeys){
    if(!fileKeys.some(key=>typeof key==='string'&&key.startsWith('background:')))return;
    if(bound.some(binding=>binding.phase==='staging'&&
      (projectIds.includes(binding.localProjectId)||cloudProjectIds.includes(binding.scope?.projectId))))
      throw journalError('JOURNAL_PDF_HANDOVER','この図面は同期の確認・復旧処理で保護しています。同期画面で図面を確認してください。');
  }
  // Read preimages, append the immutable intent, and mutate the legacy view in
  // ONE transaction. A completed canvas save therefore always has a replayable
  // intent, even if the process dies before the independent replica is written.
  function journalMutation(tx,{writes=[],fileWrites=[],fileDeletes=[],expectedFileStates=[],kind='batch',contexts=[],archiveRelease=null,unchangedFile=null}={},mutate){
    const s=tx.objectStore(STORE),control=tx.objectStore(CONTROL),log=tx.objectStore(JOURNAL);
    const recordKeys=[...new Set(writes.map(x=>x[0]))],fileKeys=[...new Set([...fileWrites.map(x=>x.key),...fileDeletes.map(x=>typeof x==='string'?x:x.key)])];
    const archiveContext=contexts.find(x=>x.operation==='archive-local'&&x.context?.localArchive===true);
    const before=new Map(),oldFiles=new Map(),fileStates=new Map();let workspaceBefore=null,allBindings=[],clock=0,archiveRows=[],rawKeys=new Set(),
      waiting=3+recordKeys.length+fileKeys.length+expectedFileStates.length+(archiveContext?2:0)+(unchangedFile?1:0);
    function stop(error){tx.sentlogJournalError=error;try{tx.abort();}catch{}}
    function ready(){
      if(--waiting)return;
      try{
        for(const expected of expectedFileStates)if(!expected||typeof expected.key!=='string'||!Number.isSafeInteger(expected.sequence)||
          expected.sequence<0||fileStates.get(expected.key)!==expected.sequence)
          throw journalError('JOURNAL_FILE_CHANGED','確認中にファイルが変更されました。削除せず保持しています');
        const changes=writes.map(([key,after])=>({key,before:before.get(key)??null,after})).filter(x=>x.before!==x.after);
        const release=archiveRelease?archiveReleases.get(archiveRelease):null;
        if(archiveRelease&&(!release||release.status!=='committing'||tx.sentlogArchiveRelease!==release))
          throw journalError('JOURNAL_ARCHIVE_RELEASE','保管済みコピーの解放証明を確認できません');
        const fileChanges=fileKeys.map(key=>{
          const before=oldFiles.get(key)??null,after=fileWrites.find(x=>x.key===key)?.value??null;
          if(release?.current.has(key)&&after===null)return {key,before:null,after:null,releasedBefore:archiveReleaseReceipt(release,release.files.get(key))};
          return {key,before,after};
        });
        const workspaceChange=changes.find(x=>x.key===WS),workspaceAfter=workspaceChange?workspaceChange.after:workspaceBefore;
        const affected=affectedProjects(changes,workspaceBefore,workspaceAfter,fileChanges),bound=allBindings.filter(x=>x?.kind==='binding');
        const legacyPdf=contexts.filter(context=>context.operation==='legacy-pdf-receive');
        // The cached lifecycle can be stale when a different tab starts the
        // handover. Check its durable authority in this SAME file/WAL tx.
        if(legacyPdf.length)assertLegacyPdfHandover(bound,affected.projectIds,
          legacyPdf.map(context=>context.context?.projectId),fileKeys);
        if(archiveContext){
          const projectId=archiveContext.context.localProjectId||archiveContext.context.projectId,binding=bound.find(b=>b.localProjectId===projectId);
          if(binding){
            const projects=workspaceOf(workspaceBefore).projects,ownIds=new Set(projects.find(p=>p.id===projectId)?.drawings?.map(d=>d.id)||[]),allIds=new Set(projects.flatMap(p=>(p.drawings||[]).map(d=>d.id)));
            const pendingArchive=archiveRows.some(row=>
              (row.seq>binding.ackedSeq&&(row.projectIds.includes(projectId)||row.drawingIds.some(id=>ownIds.has(id))))||
              (row.seq>Math.max(binding.cutoffSeq,binding.lastLocalArchiveSeq||0)&&!row.projectIds.length&&row.drawingIds.some(id=>!allIds.has(id)&&(rawKeys.has(DRAW+id)||row.files.length))));
            if(pendingArchive||allBindings.some(x=>x?.kind==='claim'&&x.localProjectId===projectId))
              throw journalError('JOURNAL_PENDING','未共有の変更を先に保存・送信してください。端末の記録は残しています');
          }
        }
        if(contexts.some(x=>x.origin==='remote')&&affected.projectIds.some(id=>bound.some(x=>x.localProjectId===id))&&changes.some(x=>x.key===WS||x.key.startsWith(DRAW)))
          throw journalError('JOURNAL_REMOTE_WRITER','旧方式の共有処理がこの案件を変更しようとしたため停止しました');
        // The byte comparison ran outside this transaction. Recheck its durable
        // file revision here, after all ordinary ownership/handover guards. A
        // concurrent write/delete invalidates the proof and follows the normal
        // write path, preserving that intervening file in the journal.
        if(unchangedFile&&kind==='file-write'&&!writes.length&&!fileDeletes.length&&fileWrites.length===1&&
          fileWrites[0].key===unchangedFile.key&&fileStates.get(unchangedFile.key)===unchangedFile.sequence&&
          fileIdentity(oldFiles.get(unchangedFile.key))===unchangedFile.identity&&
          fileIdentity(fileWrites[0].value)===unchangedFile.identity){
          mutate({unchanged:true,value:oldFiles.get(unchangedFile.key)});return;
        }
        const seq=clock+1;
        const ownedIds=new Set(workspaceOf(workspaceAfter).projects.flatMap(project=>(project.drawings||[]).map(d=>d.id)));
        const hasOrphan=affected.drawingIds.some(id=>!ownedIds.has(id));
        if(bound.length&&(changes.length||fileChanges.length)&&(hasOrphan||affected.projectIds.some(id=>bound.some(b=>b.localProjectId===id)))){
          const row={version:1,kind:'sentlog-app-intent',id:'wal:'+crypto.randomUUID(),seq,at:Date.now(),
            sourceRevision:revision,mutationKind:kind,contexts:copy(contexts),changes,files:fileChanges,
            workspaceBefore,workspaceAfter,...affected};
          if(tx.sentlogRestoreProof){const proof=tx.sentlogRestoreProof;
            row.archiveRestore={version:1,scope:copy(proof.scope),localProjectId:proof.localProjectId,jobId:proof.jobId,certificate:copy(proof.certificate)};}
          recordRequest(tx,log,'add',row,seq);
        }
        const archived=archiveContext;
        const restored=contexts.some(x=>x.operation==='restore');
        for(const binding of bound){
          const localArchive=archived&&(archived.context.localProjectId||archived.context.projectId)===binding.localProjectId;
          const localRestore=restored&&binding.phase==='detached'&&workspaceOf(workspaceAfter).projects.some(p=>p.id===binding.localProjectId);
          if(!localArchive&&!localRestore)continue;
          const next={...binding,phase:localArchive&&archived.context.mode==='project'?'detached':'active',
            ...(localArchive?{ackedSeq:seq,lastLocalArchiveSeq:seq,archive:{seq,at:Date.now(),context:copy(archived.context)}}:{restoredAt:Date.now()})};
          recordRequest(tx,control,'put',next,'binding:'+binding.localProjectId);
          (tx.sentlogBindingUpdates||(tx.sentlogBindingUpdates=[])).push(next);
        }
        tx.sentlogFileKeys=fileKeys;
        for(const key of fileKeys)recordRequest(tx,control,'put',seq,'file:'+key);
        recordRequest(tx,control,'put',seq,'clock');mutate();
      }catch(error){stop(error);}
    }
    control.get('clock').onsuccess=e=>{clock=Number(e.target.result)||0;ready();};
    journalControls(control).onsuccess=e=>{allBindings=e.target.result;ready();};
    s.get(PREFIX+WS).onsuccess=e=>{workspaceBefore=e.target.result??null;ready();};
    for(const key of recordKeys)s.get(PREFIX+key).onsuccess=e=>{before.set(key,e.target.result??null);ready();};
    for(const key of fileKeys)s.get(key).onsuccess=e=>{oldFiles.set(key,e.target.result??null);ready();};
    for(const expected of expectedFileStates)control.get('file:'+expected?.key).onsuccess=e=>{fileStates.set(expected?.key,Number(e.target.result)||0);ready();};
    if(unchangedFile)control.get('file:'+unchangedFile.key).onsuccess=e=>{fileStates.set(unchangedFile.key,Number(e.target.result)||0);ready();};
    if(archiveContext){journalRows(log).onsuccess=e=>{archiveRows=e.target.result.filter(x=>x.kind==='sentlog-app-intent');ready();};
      s.getAllKeys(IDBKeyRange.bound(PREFIX,PREFIX+'\uffff')).onsuccess=e=>{rawKeys=new Set(e.target.result.map(key=>key.slice(PREFIX.length)));ready();};}
  }
  function committedBindings(tx){for(const binding of tx.sentlogBindingUpdates||[])bindings.set(binding.localProjectId,binding);
    for(const key of tx.sentlogFileKeys||[])fileGenerations.set(key,(fileGenerations.get(key)||0)+1);
    if(tx.sentlogRestoreProof)tx.sentlogRestoreProof.status='committed';
    if(tx.sentlogArchiveRelease){for(const row of tx.sentlogArchiveRelease.cutoffRows||[])cutoffFiles.set(row.id,row.next);
      tx.sentlogArchiveRelease.status='committed';tx.sentlogArchiveRelease.result={
      releasedCopies:tx.sentlogArchiveRelease.releasedCopies,releasedBytes:tx.sentlogArchiveRelease.releasedBytes,
      avoidedPreimageCopies:tx.sentlogArchiveRelease.current.size};}}
  function collectJournal(tx,callback){
    const data={raw:new Map(),rows:[],controls:[],meta:null,files:[]},s=tx.objectStore(STORE);
    let keys=[],values=[],waiting=5;
    const range=IDBKeyRange.bound(PREFIX,PREFIX+'\uffff');
    function done(){if(--waiting)return;try{
      data.raw=new Map(keys.map((key,i)=>[key.slice(PREFIX.length),values[i]]));
      callback(data);
    }catch(error){tx.sentlogJournalError=error;tx.abort();}}
    s.getAllKeys(range).onsuccess=e=>{keys=e.target.result;done();};s.getAll(range).onsuccess=e=>{values=e.target.result;done();};
    s.get(META).onsuccess=e=>{data.meta=e.target.result;done();};
    journalRows(tx.objectStore(JOURNAL)).onsuccess=e=>{data.rows=e.target.result.filter(x=>x.kind==='sentlog-app-intent');done();};
    journalControls(tx.objectStore(CONTROL)).onsuccess=e=>{data.controls=e.target.result;done();};
  }
  function collectProjectFiles(tx,drawingIds,callback){
    const store=tx.objectStore(STORE),ids=[...drawingIds];
    const fail=error=>{tx.sentlogJournalError=error;tx.abort();};
    store.getAllKeys().onsuccess=e=>{
      try{
        const keys=e.target.result.filter(key=>typeof key==='string'&&ids.some(id=>
          key==='background:'+id||key==='dxf:'+id||key.startsWith('photo:'+id+':')));
        let waiting=keys.length;const files=new Array(waiting);
        if(!waiting){callback([]);return;}
        keys.forEach((key,index)=>{
          store.get(key).onsuccess=event=>{try{
            files[index]={key,value:event.target.result};
            if(!--waiting)callback(files.filter(file=>file.value instanceof Blob));
          }catch(error){fail(error);}};
        });
      }catch(error){fail(error);}
    };
  }
  function projectSnapshot(raw,localProjectId,fallback){
    const workspace=workspaceOf(raw.get(WS)),matches=workspace.projects.filter(p=>p.id===localProjectId);
    if(matches.length>1)throw journalError('JOURNAL_PROJECT','同じ案件IDが複数あります');
    if(!matches.length&&!fallback)throw journalError('JOURNAL_PROJECT','対象案件が見つかりません');
    const project=matches[0]?copy(matches[0]):{...copy(fallback.project),drawings:[]},drawings=[];
    if(!Array.isArray(project.drawings))throw journalError('JOURNAL_DRAWING','図面一覧を確認できません');
    const seen=new Set();
    for(const meta of project.drawings){
      if(!meta?.id||seen.has(meta.id))throw journalError('JOURNAL_DRAWING','図面IDが重複しています');seen.add(meta.id);
      if(workspace.projects.filter(p=>(p.drawings||[]).some(d=>d.id===meta.id)).length!==1)
        throw journalError('JOURNAL_DRAWING','別案件と図面IDが重複しています');
      const value=raw.get(DRAW+meta.id);if(typeof value!=='string')throw journalError('JOURNAL_DRAWING','図面の保存内容を確認できません');
      const state=JSON.parse(value);if(!Array.isArray(state?.shapes))throw journalError('JOURNAL_DRAWING','図面の記録一覧を確認できません');
      drawings.push({meta:copy(meta),state});
    }
    const rawEntries=[[WS,raw.get(WS)??null],...drawings.map(d=>[DRAW+d.meta.id,raw.get(DRAW+d.meta.id)])];
    return {version:1,kind:'sentlog-app-project',localProjectId,project,drawings,rawEntries,source:'durable-app-journal',
      readyForActivation:false,...(!matches.length?{absent:true}:{})};
  }
  function bindingIn(data,localProjectId,scope){
    const binding=data.controls.find(x=>x?.kind==='binding'&&x.localProjectId===localProjectId);
    if(!binding||!sameScope(binding.scope,scope))throw journalError('JOURNAL_SCOPE','案件の共有先が変わっています');return binding;
  }
  const replayProofs=new WeakMap();
  // A ticket is minted only after hashing immutable copy bytes. The final
  // removal uses the same records transaction as archiveAtomic: a failure
  // cannot delete the live file and leave its deletion preimage behind.
  const archiveReleases=new WeakMap();
  function archiveReleaseCheck(validate){
    if(typeof validate!=='function')throw journalError('JOURNAL_ARCHIVE_RELEASE','保管直前の確認が必要です');
    const result=validate();if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
    if(result!==true||result&&typeof result.then==='function')throw journalError('JOURNAL_ARCHIVE_CHANGED','保管対象が更新されました。削除せず中止しました');
  }
  function archiveReleaseText(value){return JSON.stringify(value,(key,item)=>item instanceof Blob?
    {sentlogImmutableBlob:{size:item.size,type:item.type,name:item.name??null,lastModified:item.lastModified??null}}:item);}
  function archiveReleaseReceipt(plan,file){return {version:1,kind:'sentlog-archived-copy',scope:copy(plan.scope),
    localProjectId:plan.localProjectId,jobId:plan.jobId,operationId:plan.operationId,certificate:copy(plan.certificate),file:copy(file)};}
  async function archiveReleaseMatches(blob,file){
    if(!(blob instanceof Blob)||blob.size!==file.size)return false;
    return await recordBlobHash(blob)===file.sha256;
  }
  function archiveReleaseSnapshot(tx,keys,callback,recordKeys=[]){
    const data={rows:[],binding:null,cutoffRows:new Map(),claim:null,clock:0,meta:null,workspace:null,files:new Map(),raw:new Map(),recordKeys:new Set()},s=tx.objectStore(STORE),c=tx.objectStore(CONTROL);
    let waiting=7+keys.length+recordKeys.length;
    const next=()=>{if(--waiting)return;try{callback(data);}catch(error){tx.sentlogJournalError=error;tx.abort();}};
    s.get(META).onsuccess=e=>{data.meta=e.target.result;next();};
    s.get(PREFIX+WS).onsuccess=e=>{data.workspace=e.target.result;next();};
    c.get('clock').onsuccess=e=>{data.clock=Number(e.target.result)||0;next();};
    c.get('binding:'+tx.sentlogArchiveProject).onsuccess=e=>{
      data.binding=e.target.result;const refs=(data.binding?.cutoff?.files||[]).filter(file=>file.valueRef);waiting+=refs.length;
      for(const file of refs)c.get(file.valueRef).onsuccess=event=>{data.cutoffRows.set(file.valueRef,event.target.result);next();};next();
    };
    c.get('claim:'+tx.sentlogArchiveProject).onsuccess=e=>{data.claim=e.target.result;next();};
    tx.objectStore(JOURNAL).getAll().onsuccess=e=>{data.rows=e.target.result;next();};
    s.getAllKeys(IDBKeyRange.bound(PREFIX,PREFIX+'\uffff')).onsuccess=e=>{data.recordKeys=new Set(e.target.result.map(key=>key.slice(PREFIX.length)));next();};
    for(const key of keys)s.get(key).onsuccess=e=>{data.files.set(key,e.target.result);next();};
    for(const key of recordKeys)s.get(PREFIX+key).onsuccess=e=>{data.raw.set(key,e.target.result??null);next();};
  }
  async function prepareArchivedRelease({scope:inputScope,localProjectId,certificate,jobId,operationId,mode,files,validate}={}){
    assertReady();await settled();window.SentlogRecords.assertSafe();archiveReleaseCheck(validate);
    const scope=checkedScope(inputScope);
    if(typeof localProjectId!=='string'||!localProjectId||typeof jobId!=='string'||!jobId||typeof operationId!=='string'||!operationId||
      !['files','project'].includes(mode)||certificate?.schema!==1||certificate.projectId!==scope.projectId||!Number.isSafeInteger(certificate.headSeq)||certificate.headSeq<0||
      !Number.isSafeInteger(certificate.revision)||certificate.revision<1||!/^[a-f0-9]{64}$/.test(certificate.payloadSha256||'')||!Array.isArray(files))
      throw journalError('JOURNAL_ARCHIVE_RELEASE','保管版・ファイルの対応を確認できません');
    const catalog=new Map(),assetIds=new Set();
    for(const file of files){
      if(!file||typeof file.key!=='string'||catalog.has(file.key)||
        typeof file.assetId!=='string'||!file.assetId||assetIds.has(file.assetId)||typeof file.mimeType!=='string'||!file.mimeType||
        !(file.kind==='drawing'&&file.key.startsWith('background:')||file.kind==='photo'&&file.key.startsWith('photo:'))||
        !Number.isSafeInteger(file.size)||file.size<=0||!/^[a-f0-9]{64}$/.test(file.sha256||''))
        throw journalError('JOURNAL_ARCHIVE_RELEASE','照合済み共有ファイルだけを整理できます');
      catalog.set(file.key,copy(file));assetIds.add(file.assetId);
    }
    const pendingState=await deltaJournal.pending({scope,localProjectId});archiveReleaseCheck(validate);
    if(pendingState.count||pendingState.claimId||pendingState.detached)throw journalError('JOURNAL_PENDING','未共有の変更を先に保存・送信してください');
    await connect();const tx=transaction('readonly'),done=complete(tx);let data;
    tx.sentlogArchiveProject=localProjectId;archiveReleaseSnapshot(tx,[...catalog.keys()],result=>data=result);await done;archiveReleaseCheck(validate);
    const binding=data.binding;
    if(!binding||!sameScope(binding.scope,scope)||binding.phase!=='active'||!binding.baselineId||data.claim||Number(data.meta?.revision)!==revision)
      throw journalError('JOURNAL_ARCHIVE_CHANGED','引継ぎ済み記録と保管対象の対応が変わりました');
    const ownProject=workspaceOf(data.workspace).projects.find(p=>p.id===localProjectId),ids=new Set([
      ...(ownProject?.drawings||[]),...(ownProject?.deltaMetadata?.retainedDrawings||[]).map(d=>d.meta)].map(d=>d.id));
    if(!ownProject||workspaceOf(data.workspace).projects.some(p=>p.id!==localProjectId&&
      [...(p.drawings||[]),...(p.deltaMetadata?.retainedDrawings||[]).map(d=>d.meta)].some(d=>ids.has(d?.id))))
      throw journalError('JOURNAL_ARCHIVE_CHANGED','別案件と図面の保存先が重複しています');
    if(data.rows.some(row=>row.kind==='sentlog-app-intent'&&row.seq>binding.ackedSeq&&
      ((row.projectIds||[]).includes(localProjectId)||(row.drawingIds||[]).some(id=>ids.has(id)))))
      throw journalError('JOURNAL_PENDING','未共有の変更を保持しています');
    const plan={status:'prepared',scope,localProjectId,certificate:copy(certificate),jobId,operationId,mode,files:catalog,current:new Map(),
      clock:data.clock,revision:Number(data.meta.revision),workspace:data.workspace,bindingText:archiveReleaseText(binding),
      nextBinding:copy(binding),cutoffRows:[],rows:[],validate,releasedCopies:0,releasedBytes:0};
    for(const [key,blob]of data.files)if(blob!==undefined&&blob!==null){
      if(!await archiveReleaseMatches(blob,catalog.get(key)))throw journalError('JOURNAL_ARCHIVE_FILE_CHANGED','端末のファイルがPC保管版と一致しません');
      archiveReleaseCheck(validate);plan.current.set(key,{size:blob.size,type:blob.type});
    }
    async function releaseFile(entry,field,file,receiptField){
      if(!(entry[field] instanceof Blob)||!file)return;
      if(!await archiveReleaseMatches(entry[field],file))return;
      archiveReleaseCheck(validate);plan.releasedCopies++;plan.releasedBytes+=entry[field].size;
      entry[field]=null;entry[receiptField]=archiveReleaseReceipt(plan,file);
    }
    for(const [index,file]of (plan.nextBinding.cutoff?.files||[]).entries()){
      if(file.valueRef){
        const row=checkedCutoffFile(binding,file,index,data.cutoffRows),next=copy(row),before=plan.releasedCopies;
        await releaseFile(next,'value',catalog.get(file.key),'archiveRelease');
        if(plan.releasedCopies>before){next.revision++;plan.cutoffRows.push({id:row.id,text:archiveReleaseText(row),next});}
      }else await releaseFile(file,'value',catalog.get(file.key),'archiveRelease');
    }
    for(const row of data.rows){
      const owners=row.resolvedProjectIds||row.projectIds||[];
      if(!['sentlog-app-intent','sentlog-file-retention'].includes(row.kind)||!Number.isSafeInteger(row.seq)||row.seq<1||row.seq>binding.ackedSeq||
        !Array.isArray(owners)||owners.length!==1||owners[0]!==localProjectId||!Array.isArray(row.files)||
        row.kind==='sentlog-file-retention'&&(!Array.isArray(row.proofs)||row.proofs.length!==1||
          !row.proofs.every(p=>p?.localProjectId===localProjectId&&sameScope(p.scope,scope))))continue;
      const next=copy(row),before=plan.releasedCopies;
      for(const file of next.files||[]){await releaseFile(file,'before',catalog.get(file.key),'releasedBefore');await releaseFile(file,'after',catalog.get(file.key),'releasedAfter');}
      if(plan.releasedCopies>before)plan.rows.push({seq:row.seq,text:archiveReleaseText(row),next});
    }
    archiveReleaseCheck(validate);const ticket=Object.freeze({});archiveReleases.set(ticket,plan);return ticket;
  }
  function applyArchivedRelease(tx,ticket,{deleteFiles,options},callback){
    if(!ticket){callback();return;}
    const plan=archiveReleases.get(ticket),context=options?.context;
    if(!plan||plan.status!=='prepared'||options.operation!=='archive-local'||context?.localArchive!==true||
      context.projectId!==plan.localProjectId||context.jobId!==plan.jobId||context.mode!==plan.mode||
      archiveReleaseText(context.deltaCheckpoint)!==archiveReleaseText(plan.certificate)||
      deleteFiles.length!==plan.current.size||deleteFiles.some(file=>plan.current.get(file.key)?.size!==file.size))
      throw journalError('JOURNAL_ARCHIVE_RELEASE','整理するファイルと保管証明が一致しません');
    archiveReleaseCheck(plan.validate);plan.status='committing';tx.sentlogArchiveProject=plan.localProjectId;
    archiveReleaseSnapshot(tx,[...plan.current.keys()],data=>{
      archiveReleaseCheck(plan.validate);
      if(data.clock!==plan.clock||Number(data.meta?.revision)!==plan.revision||data.workspace!==plan.workspace||data.claim||
        archiveReleaseText(data.binding)!==plan.bindingText||
        [...plan.current].some(([key,expected])=>!(data.files.get(key) instanceof Blob)||data.files.get(key).size!==expected.size||data.files.get(key).type!==expected.type))
        throw journalError('JOURNAL_ARCHIVE_CHANGED','確認中に記録・ファイル・共有待ちが変わりました');
      const rows=new Map(data.rows.map(row=>[row.seq,row]));
      if(plan.rows.some(row=>archiveReleaseText(rows.get(row.seq))!==row.text))
        throw journalError('JOURNAL_ARCHIVE_CHANGED','確認中に保存控えが更新されました');
      if(plan.cutoffRows.some(row=>archiveReleaseText(data.cutoffRows.get(row.id))!==row.text))
        throw journalError('JOURNAL_ARCHIVE_CHANGED','確認中に移行前の保護ファイルが更新されました');
      for(const row of plan.rows)tx.objectStore(JOURNAL).put(row.next,row.seq);
      for(const row of plan.cutoffRows)tx.objectStore(CONTROL).put(row.next,row.id);
      tx.objectStore(CONTROL).put(plan.nextBinding,'binding:'+plan.localProjectId);
      tx.sentlogArchiveRelease=plan;callback();
    });
  }
  // A PC restoration may write its verified files while the project remains
  // detached. Those file-only intents stay in the WAL until the restored
  // records have undergone ordinary replica replay; this ticket is not an ACK.
  const archiveRestorations=new WeakMap();
  function restorationContext(row,plan){
    const context=row.contexts?.length===1&&row.contexts[0],proof=context?.context?.archiveRestore;
    return context?.origin==='device'&&context.operation==='archive-file-restore'&&proof?.version===1&&
      sameScope(proof.scope,plan.scope)&&proof.localProjectId===plan.localProjectId&&proof.jobId===plan.jobId&&
      typeof proof.operationId==='string'&&proof.operationId&&
      archiveReleaseText(proof.certificate)===archiveReleaseText(plan.certificate);
  }
  function restorationPending(data,binding){
    const owners=new Set(workspaceOf(data.workspace).projects.flatMap(p=>(p.drawings||[]).map(d=>d.id)));
    return data.rows.filter(row=>row.kind==='sentlog-app-intent'&&(
      row.seq>Math.max(binding.cutoffSeq,binding.lastLocalArchiveSeq||0)&&!(row.projectIds||[]).length&&
        (row.drawingIds||[]).some(id=>!owners.has(id)&&(data.recordKeys.has(DRAW+id)||row.files?.length))||
      row.seq>binding.ackedSeq&&(row.projectIds||[]).includes(binding.localProjectId)));
  }
  function assertRestorationSnapshot(plan,data){
    archiveReleaseCheck(plan.validate);
    if(data.clock!==plan.clock||Number(data.meta?.revision)!==plan.revision||data.workspace!==plan.workspace||data.claim||
      archiveReleaseText(data.binding)!==plan.bindingText||[...plan.raw].some(([key,value])=>data.raw.get(key)!==value)||
      [...plan.current].some(([key,value])=>!(data.files.get(key) instanceof Blob)||data.files.get(key).size!==value.size||data.files.get(key).type!==value.type)||
      [...plan.generations].some(([key,value])=>(fileGenerations.get(key)||0)!==value||fileWriters.get(key)?.size||failedFiles.has(key))||
      archiveReleaseText(restorationPending(data,data.binding))!==plan.pendingText)
      throw journalError('JOURNAL_RESTORE_CHANGED','復旧の確認中に記録・ファイル・共有待ちが変わりました');
  }
  async function proveArchiveRestore({scope:inputScope,localProjectId,certificate,jobId,files,snapshot,validate}={}){
    assertReady();await settled();window.SentlogRecords.assertSafe();archiveReleaseCheck(validate);const scope=checkedScope(inputScope);
    if(typeof localProjectId!=='string'||!localProjectId||typeof jobId!=='string'||!jobId||certificate?.schema!==1||certificate.projectId!==scope.projectId||
      !Number.isSafeInteger(certificate.headSeq)||certificate.headSeq<0||!Number.isSafeInteger(certificate.revision)||certificate.revision<1||
      !/^[a-f0-9]{64}$/.test(certificate.payloadSha256||'')||snapshot?.project?.id!==localProjectId||!Array.isArray(snapshot.drawings)||!Array.isArray(files))
      throw journalError('JOURNAL_RESTORE_PROOF','復旧する保管版と案件の対応を確認できません');
    const catalog=new Map(),ids=new Set();
    for(const file of files){
      if(!file||typeof file.key!=='string'||catalog.has(file.key)||typeof file.assetId!=='string'||!file.assetId||ids.has(file.assetId)||
        !(file.kind==='drawing'&&/^background:[^:]+$/.test(file.key)||file.kind==='photo'&&/^photo:[^:]+:[^:]+$/.test(file.key))||
        !Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256||'')||typeof file.mimeType!=='string'||!file.mimeType)
        throw journalError('JOURNAL_RESTORE_PROOF','復旧する共有ファイルの一覧が不正です');
      catalog.set(file.key,copy(file));ids.add(file.assetId);
    }
    const drawingIds=[...new Set([...snapshot.drawings,...(snapshot.project.deltaMetadata?.retainedDrawings||[])].map(d=>d?.meta?.id))];
    if(drawingIds.some(id=>typeof id!=='string'||!id))throw journalError('JOURNAL_RESTORE_PROOF','復旧する図面を確認できません');
    const recordKeys=['sentlogArchiveLocalV1',...drawingIds.map(id=>DRAW+id)],tx=transaction('readonly'),done=complete(tx);let data;
    tx.sentlogArchiveProject=localProjectId;archiveReleaseSnapshot(tx,[...catalog.keys()],value=>data=value,recordKeys);await done;archiveReleaseCheck(validate);
    const binding=data.binding,workspace=workspaceOf(data.workspace);
    if(!binding||!sameScope(binding.scope,scope)||binding.phase!=='detached'||data.claim||Number(data.meta?.revision)!==revision||
      binding.archive?.context?.jobId!==jobId||archiveReleaseText(binding.archive?.context?.deltaCheckpoint)!==archiveReleaseText(certificate)||
      workspace.projects.some(p=>p.id===localProjectId||[...(p.drawings||[]),...(p.deltaMetadata?.retainedDrawings||[]).map(d=>d.meta)].some(d=>drawingIds.includes(d?.id)))||
      drawingIds.some(id=>data.raw.get(DRAW+id)!==null))
      throw journalError('JOURNAL_RESTORE_PENDING','端末から外した案件と復旧先を照合できません。記録を保持しています');
    const plan={status:'prepared',scope,localProjectId,certificate:copy(certificate),jobId,files:catalog,current:new Map(),validate,
      clock:data.clock,revision:Number(data.meta.revision),workspace:data.workspace,bindingText:archiveReleaseText(binding),raw:data.raw,
      snapshot:copy(snapshot),recordKeys,generations:new Map([...catalog.keys()].map(key=>[key,fileGenerations.get(key)||0]))};
    const rows=restorationPending(data,binding);
    for(const row of rows){
      if(!Number.isSafeInteger(row.seq)||row.seq<1||!Array.isArray(row.changes)||row.changes.length||!Array.isArray(row.projectIds)||row.projectIds.length||
        !Array.isArray(row.files)||!row.files.length||row.workspaceBefore!==data.workspace||row.workspaceAfter!==data.workspace||!restorationContext(row,plan))
        throw journalError('JOURNAL_RESTORE_PENDING','PC復旧以外の未共有変更があります。入力を保持しています');
      for(const file of row.files){
        const expected=catalog.get(file.key);
        if(!expected||file.before!==null||!await archiveReleaseMatches(file.after,expected))
          throw journalError('JOURNAL_RESTORE_PENDING','PC復旧以外のファイル変更があります。元の内容を保持しています');
        archiveReleaseCheck(validate);
      }
    }
    for(const [key,expected]of catalog){
      const blob=data.files.get(key);if(!await archiveReleaseMatches(blob,expected))
        throw journalError('JOURNAL_RESTORE_FILE_CHANGED','復旧したファイルがPCの保管版と一致しません');
      archiveReleaseCheck(validate);plan.current.set(key,{size:blob.size,type:blob.type});
    }
    plan.pendingText=archiveReleaseText(rows);archiveReleaseCheck(validate);
    const ticket=Object.freeze({});archiveRestorations.set(ticket,plan);return ticket;
  }
  async function validateArchiveRestore(ticket,{scope,localProjectId,certificate,jobId}={}){
    const plan=archiveRestorations.get(ticket);
    if(!plan||plan.status!=='prepared'||!sameScope(plan.scope,scope)||plan.localProjectId!==localProjectId||plan.jobId!==jobId||
      archiveReleaseText(plan.certificate)!==archiveReleaseText(certificate))throw journalError('JOURNAL_RESTORE_PROOF','復旧の保存証明が一致しません');
    archiveReleaseCheck(plan.validate);await settled();window.SentlogRecords.assertSafe();
    const tx=transaction('readonly'),done=complete(tx);tx.sentlogArchiveProject=plan.localProjectId;
    archiveReleaseSnapshot(tx,[...plan.current.keys()],data=>assertRestorationSnapshot(plan,data),plan.recordKeys);await done;archiveReleaseCheck(plan.validate);return true;
  }
  function applyArchiveRestore(tx,ticket,{writes,deleteFiles,options},callback){
    if(!ticket){callback();return;}
    const plan=archiveRestorations.get(ticket);
    if(!plan||plan.status!=='prepared'||options.operation!=='restore'||deleteFiles.length)
      throw journalError('JOURNAL_RESTORE_PROOF','復旧の保存証明を別の操作には使用できません');
    const expected=new Map(plan.snapshot.drawings.map(d=>[DRAW+d.meta.id,JSON.stringify(d.state)])),before=workspaceOf(plan.workspace);
    expected.set(WS,JSON.stringify({...before,projects:[...before.projects,plan.snapshot.project]}));
    const mark=plan.raw.get('sentlogArchiveLocalV1');if(mark!==null){const next=JSON.parse(mark);delete next[plan.scope.projectId];expected.set('sentlogArchiveLocalV1',JSON.stringify(next));}
    if(writes.length!==expected.size||new Set(writes.map(x=>x[0])).size!==writes.length||writes.some(([key,value])=>expected.get(key)!==value))
      throw journalError('JOURNAL_RESTORE_PROOF','保管版と異なる記録を復旧しようとしたため停止しました');
    archiveReleaseCheck(plan.validate);plan.status='committing';tx.sentlogArchiveProject=plan.localProjectId;
    archiveReleaseSnapshot(tx,[...plan.current.keys()],data=>{
      assertRestorationSnapshot(plan,data);tx.sentlogRestoreProof=plan;callback();
    },plan.recordKeys);
  }
  function cutoffRecoveryReferences(binding){
    bindingState(binding);
    const raw=new Map(binding.cutoff.rawEntries),workspace=workspaceOf(raw.get(WS));
    const projects=workspace.projects.filter(project=>project.id===binding.localProjectId);
    if(projects.length!==1||!Array.isArray(projects[0].drawings))
      throw journalError('JOURNAL_RECOVERY_PROJECT','保護した案件の図面一覧を確認できません');
    const refs=new Map();
    for(const drawing of projects[0].drawings){
      const value=raw.get(DRAW+drawing.id),state=typeof value==='string'?JSON.parse(value):null;
      if(!state||!Array.isArray(state.shapes))throw journalError('JOURNAL_RECOVERY_DRAWING','保護した図面の記録を確認できません');
      const fileState=Object.fromEntries(Object.entries(state).filter(([key])=>!['shapes','collabDeletedRecords'].includes(key)));
      const descriptor={drawingId:drawing.id,drawing:copy(drawing),state:copy(fileState)};
      if(drawing.sourceType||drawing.fileName||state.sourceType||state.fileName){
        const key='background:'+drawing.id;refs.set(key,{key,kind:'background',...descriptor,expected:[]});
      }
      for(const record of state.shapes)for(const photo of record.photos||[]){
        if(typeof photo?.id!=='string'||!photo.id)continue;
        const key='photo:'+drawing.id+':'+photo.id;
        if(!refs.has(key))refs.set(key,{key,kind:'photo',...descriptor,photoId:photo.id,expected:[]});
        refs.get(key).expected.push(copy(photo));
      }
    }
    return refs;
  }
  function cutoffRecoveryCheck(validate){
    if(typeof validate!=='function')throw journalError('JOURNAL_RECOVERY_GUARD','復旧する利用者・案件の確認が必要です');
    const result=validate();
    if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
    if(result===false||result&&typeof result.then==='function')
      throw journalError('JOURNAL_RECOVERY_SCOPE','復旧中に利用者または案件が変わりました');
  }
  function cutoffRecoveryProof(ref,file,scope,serverRevision){
    const proof=file.proof,kind=ref.kind==='background'?'drawing':'photo';
    const clientKey=kind==='drawing'?'drawing:'+ref.drawingId:ref.key;
    if(!(file.blob instanceof Blob)||!Number.isSafeInteger(file.size)||file.size<=0||file.blob.size!==file.size||
      !/^[a-f0-9]{64}$/.test(file.sha256||'')||!proof||typeof proof.assetId!=='string'||!proof.assetId||
      proof.projectId!==scope.projectId||proof.clientKey!==clientKey||proof.kind!==kind||
      proof.drawingId!==ref.drawingId||(kind==='photo'&&proof.photoId!==ref.photoId)||
      proof.sha256!==file.sha256||proof.size!==file.size)
      throw journalError('JOURNAL_RECOVERY_PROOF','復旧ファイルの案件・識別情報・内容証明が一致しません');
    for(const expected of ref.expected){
      if(Object.prototype.hasOwnProperty.call(expected,'size')&&expected.size!==file.size||
        Object.prototype.hasOwnProperty.call(expected,'sha256')&&String(expected.sha256).toLowerCase()!==file.sha256)
        throw journalError('JOURNAL_RECOVERY_MISMATCH','保護した写真情報と復旧ファイルが一致しません。両方を保持しました');
    }
    if(kind==='drawing'){
      const replacement=Object.values(ref.state?.pageReplacements||{}).filter(item=>item&&Number(item.updatedAt)>0)
        .sort((a,b)=>Number(b.updatedAt)-Number(a.updatedAt))[0];
      if(replacement){
        if(!/^[a-f0-9]{64}$/i.test(replacement.pdfHash||'')||String(replacement.pdfHash).toLowerCase()!==file.sha256||
          replacement.pdfSize&&Number(replacement.pdfSize)!==file.size||
          String(proof.drawingRevision?.pdfHash||'').toLowerCase()!==file.sha256||
          Number(proof.drawingRevision?.updatedAt)!==Number(replacement.updatedAt))
          throw journalError('JOURNAL_RECOVERY_REVISION','差替え済み図面と復旧ファイルの版が一致しません');
      }else if(!Number.isSafeInteger(serverRevision)||serverRevision<1||proof.snapshotRevision!==serverRevision||
        proof.sourceType!==(ref.state?.sourceType??ref.drawing?.sourceType??null)||
        proof.fileName!==(ref.state?.fileName??ref.drawing?.fileName??''))
        throw journalError('JOURNAL_RECOVERY_REVISION','保護した図面の保存版・形式・ファイル名を照合できません');
    }
  }
  // A user may choose the current shared PDF when the old, unversioned PDF
  // cannot be identified. Keep that decision distinct from an automatic
  // proof of the original file; the immutable cutoff records are unchanged.
  const drawingRecoveryReviews=new WeakMap();
  function recoveryDrawingSource(ref){
    return {id:ref.drawingId,fileName:ref.state?.fileName??ref.drawing?.fileName??'',
      sourceType:ref.state?.sourceType??ref.drawing?.sourceType??null,
      pageCount:ref.state?.pageCount??ref.drawing?.pageCount??null,
      pageReplacements:ref.state?.pageReplacements??{}};
  }
  function reviewedDrawingCandidate(binding,file,scope,localProjectId,bindingId){
    if(!binding||!sameScope(binding.scope,scope)||binding.localProjectId!==localProjectId||
      binding.id!==bindingId||binding.phase!=='staging')
      throw journalError('JOURNAL_RECOVERY_REVIEW_SCOPE','確認する図面の案件または保存状態が変わりました');
    bindingState(binding);
    const ref=cutoffRecoveryReferences(binding).get(file.key),proof=file.proof;
    if(!ref||ref.kind!=='background'||file.key!=='background:'+ref.drawingId)
      throw journalError('JOURNAL_RECOVERY_REVIEW_KEY','保護した記録にない図面は選択できません');
    if((binding.cutoff.files||[]).some(item=>item.key===file.key))
      throw journalError('JOURNAL_RECOVERY_REVIEW_EXISTS','保護済みの図面は上書きせず保持しています');
    const source=recoveryDrawingSource(ref),markers=source.pageReplacements;
    if(!markers||typeof markers!=='object'||Array.isArray(markers)||Object.keys(markers).length)
      throw journalError('JOURNAL_RECOVERY_REVIEW_VERSION','差替え履歴のある図面は、この操作では変更できません');
    if(!(file.blob instanceof Blob)||!Number.isSafeInteger(file.size)||file.size<=0||file.blob.size!==file.size||
      !/^[a-f0-9]{64}$/.test(file.sha256||'')||!proof||typeof proof.assetId!=='string'||!proof.assetId||
      proof.ownerId!==scope.ownerId||proof.projectId!==scope.projectId||proof.clientKey!=='drawing:'+ref.drawingId||
      proof.kind!=='drawing'||proof.drawingId!==ref.drawingId||proof.sha256!==file.sha256||proof.size!==file.size||
      proof.fileName!==source.fileName||proof.sourceType!==source.sourceType)
      throw journalError('JOURNAL_RECOVERY_REVIEW_PROOF','選択する図面の案件・識別情報・内容を照合できません');
    const selected=proof.source;
    if(!selected||['id','fileName','sourceType','pageCount','pageReplacements'].some(key=>!Object.prototype.hasOwnProperty.call(selected,key))||
      selected.id!==source.id||selected.fileName!==source.fileName||selected.sourceType!==source.sourceType||selected.pageCount!==source.pageCount||
      !selected.pageReplacements||typeof selected.pageReplacements!=='object'||Array.isArray(selected.pageReplacements)||Object.keys(selected.pageReplacements).length)
      throw journalError('JOURNAL_RECOVERY_REVIEW_SOURCE','選択する図面の名前・形式・ページ構成が保護した記録と一致しません');
    const original=binding.cutoff.serverRevision;
    if(!Number.isSafeInteger(original)||original<1||!Number.isSafeInteger(proof.snapshotRevision)||proof.snapshotRevision<original)
      throw journalError('JOURNAL_RECOVERY_REVIEW_REVISION','選択する図面の共有版を確認できません');
    return ref;
  }
  async function readDrawingRecoveryState(localProjectId,key){
    const tx=transaction('readonly'),done=complete(tx),control=tx.objectStore(CONTROL),files=tx.objectStore(STORE);
    const data={};
    control.get('binding:'+localProjectId).onsuccess=e=>data.binding=e.target.result;
    control.get('file:'+key).onsuccess=e=>data.fileSequence=Number(e.target.result)||0;
    files.get(META).onsuccess=e=>data.meta=e.target.result;
    files.get(key).onsuccess=e=>data.live=e.target.result;
    files.get(PREFIX+WS).onsuccess=e=>data.workspace=e.target.result;
    files.get(PREFIX+DRAW+String(key).slice('background:'.length)).onsuccess=e=>data.drawing=e.target.result;
    await done;return data;
  }
  function drawingRecoveryStateCheck(plan,data){
    cutoffRecoveryCheck(plan.validate);
    if(!['prepared','confirming'].includes(plan.status)||failure||failures.size||pending.size||inFlight||operation||exclusive||
      fileWriters.get(plan.file.key)?.size||revision!==plan.recordRevision||Number(data.meta?.revision)!==plan.recordRevision||
      data.fileSequence!==plan.fileSequence||(fileGenerations.get(plan.file.key)||0)!==plan.generation||
      archiveReleaseText(data.binding)!==plan.bindingText||
      (data.live===undefined)!==plan.liveMissing||
      (!plan.liveMissing&&(!(data.live instanceof Blob)||data.live.size!==plan.file.size||data.live.type!==plan.liveType))){
      // Preserve a small, non-content diagnostic for a refused confirmation.
      // The conditions and the user-facing error remain exactly as guarded.
      const recoveryState=[
        ['ticket-status',!['prepared','confirming'].includes(plan.status)],
        ['writer-error',failure||failures.size],['pending-records',pending.size||inFlight],
        ['record-operation',operation||exclusive],['file-writer',fileWriters.get(plan.file.key)?.size],
        ['memory-record-revision',revision!==plan.recordRevision],
        ['stored-record-revision',Number(data.meta?.revision)!==plan.recordRevision],
        ['file-sequence',data.fileSequence!==plan.fileSequence],
        ['file-generation',(fileGenerations.get(plan.file.key)||0)!==plan.generation],
        ['binding',archiveReleaseText(data.binding)!==plan.bindingText],
        ['live-existence',(data.live===undefined)!==plan.liveMissing],
        ['live-bytes',!plan.liveMissing&&(!(data.live instanceof Blob)||data.live.size!==plan.file.size||data.live.type!==plan.liveType)]
      ].filter(([,changed])=>changed).map(([name])=>name);
      throw Object.assign(journalError('JOURNAL_RECOVERY_REVIEW_CHANGED',
        '図面の確認中に記録またはファイルが変わりました。もう一度候補を確認してください'),{recoveryState});
    }
    const ref=reviewedDrawingCandidate(data.binding,plan.file,plan.scope,plan.localProjectId,plan.bindingId);
    const projects=workspaceOf(data.workspace).projects,project=projects.filter(item=>item.id===plan.localProjectId);
    const drawing=project.length===1?(project[0].drawings||[]).filter(item=>item.id===ref.drawingId):[];
    const state=typeof data.drawing==='string'?JSON.parse(data.drawing):null;
    if(drawing.length!==1||!state||projects.filter(item=>(item.drawings||[]).some(d=>d.id===ref.drawingId)).length!==1||
      archiveReleaseText(recoveryDrawingSource({drawingId:ref.drawingId,drawing:drawing[0],state}))!==archiveReleaseText(recoveryDrawingSource(ref)))
      throw journalError('JOURNAL_RECOVERY_REVIEW_CHANGED','端末内で図面の構成が変更されています。新しい記録を保持して確認を中止しました');
  }
  const deltaJournal={
    version:1,
    prepareArchivedRelease,
    proveArchiveRestore,validateArchiveRestore,
    archivedReleaseResult(ticket){const plan=archiveReleases.get(ticket);if(!plan||plan.status!=='committed')
      throw journalError('JOURNAL_ARCHIVE_RELEASE','整理処理の完了を確認できません');return copy(plan.result);},
    bindingFor:localProjectId=>hydrateBinding(bindings.get(localProjectId)),
    listBindingsSync:()=>[...bindings.values()].map(binding=>hydrateBinding(binding)),
    bindingStateFor:localProjectId=>bindingState(bindings.get(localProjectId)),
    listBindingStatesSync:()=>[...bindings.values()].map(bindingState),
    async assertLegacyPdfReceive({projectId,key}={}){
      assertReady();
      if(typeof projectId!=='string'||!projectId||typeof key!=='string'||!/^background:[^:]+$/.test(key))
        throw journalError('JOURNAL_PDF_HANDOVER_SCOPE','受信する図面と案件を確認できません。');
      await connect();const tx=transaction('readonly'),done=complete(tx);
      let raw=null,rows=[],waiting=2;
      function check(){if(--waiting)return;try{
        const affected=affectedProjects([],raw,raw,[{key}]);
        assertLegacyPdfHandover(rows.filter(row=>row?.kind==='binding'),affected.projectIds,[projectId],[key]);
      }catch(error){tx.sentlogJournalError=error;tx.abort();}}
      tx.objectStore(STORE).get(PREFIX+WS).onsuccess=e=>{raw=e.target.result??null;check();};
      journalControls(tx.objectStore(CONTROL)).onsuccess=e=>{rows=e.target.result;check();};
      // This read never hydrates protected files or updates their references.
      await done;return true;
    },
    async readBindingState(localProjectId){
      assertReady();if(typeof localProjectId!=='string'||!localProjectId)
        throw journalError('JOURNAL_PROJECT','端末内の案件を確認できません');
      await connect();const binding=await readControl('binding:'+localProjectId);
      if(binding!==undefined&&(!binding||binding.localProjectId!==localProjectId))
        throw journalError('JOURNAL_BINDING','案件の保存接続を確認できません');
      const state=bindingState(binding);
      if(binding){
        // Another tab may have activated this binding after our startup. The
        // replay/ACK APIs still need its protected file cache when returning a
        // full binding, so populate that cache once before exposing new refs.
        let refresh=bindings.get(localProjectId)?.id!==binding.id;
        if(!refresh)for(const [index,file]of (binding.cutoff.files||[]).entries()){
          if(!Object.prototype.hasOwnProperty.call(file,'valueRef'))continue;
          try{checkedCutoffFile(binding,file,index);}
          catch(error){if(error.code!=='JOURNAL_CUTOFF_REF')throw error;refresh=true;break;}
        }
        if(refresh){await readProjectBinding(localProjectId);return bindingState(bindings.get(localProjectId));}
      }
      if(binding)bindings.set(localProjectId,binding);else bindings.delete(localProjectId);
      return state;
    },
    assertFence({scope,localProjectId}={}){
      const b=bindings.get(localProjectId);
      if(!initialized||!connection||connection.version!==DB_VERSION||!sameScope(b?.scope,scope)||failure)
        throw journalError('JOURNAL_FENCE','変更履歴を同時保存する準備ができていません');
      return true;
    },
    async listBindings(){assertReady();await connect();cacheControls(await readControls());return this.listBindingsSync();},
    async readCutoff({scope:inputScope,localProjectId}={}){
      assertReady();const scope=checkedScope(inputScope);await connect();const binding=await readProjectBinding(localProjectId);
      if(!binding||!sameScope(binding.scope,scope))throw journalError('JOURNAL_SCOPE','保護した控えの共有先が一致しません');
      return binding.cutoff;
    },
    async missingCutoffFiles({scope:inputScope,localProjectId,bindingId}={}){
      assertReady();const scope=checkedScope(inputScope);await connect();
      const binding=await readControl('binding:'+localProjectId);
      if(!binding||!sameScope(binding.scope,scope)||bindingId&&binding.id!==bindingId)
        throw journalError('JOURNAL_RECOVERY_SCOPE','復旧する移行前の控えが一致しません');
      if(binding.phase!=='staging')return [];
      const existing=new Set((binding.cutoff.files||[]).map(file=>file.key));
      // Existing protected bytes, including unreadable/empty ones, are never
      // replaced by recovery. Only an absent referenced key can be appended.
      return [...cutoffRecoveryReferences(binding).values()].filter(ref=>!existing.has(ref.key))
        .map(ref=>({...ref,recoverable:true}));
    },
    confirmedDrawingSource(localProjectId,drawingId){
      assertReady();const binding=bindings.get(localProjectId);if(!binding)return null;bindingState(binding);
      const files=(binding.cutoff.files||[]).filter(file=>file.key==='background:'+drawingId);
      if(files.length>1)throw journalError('JOURNAL_RECOVERY_REVIEW_RECEIPT','選択した図面の保存証明が重複しています');
      const proof=files[0]?.recovery;if(proof?.sourceKind!=='user-confirmed-current-drawing')return null;
      if(proof.kind!=='sentlog-cutoff-recovery'||proof.ownerId!==binding.scope.ownerId||proof.projectId!==binding.scope.projectId||
        proof.clientKey!=='drawing:'+drawingId||proof.drawingId!==drawingId||typeof proof.assetId!=='string'||!proof.assetId||
        !/^[a-f0-9]{64}$/.test(proof.sha256||'')||!Number.isSafeInteger(proof.size)||proof.size<1||proof.exactOriginalVerified!==false||
        proof.originalSnapshotRevision!==binding.cutoff.serverRevision||!Number.isSafeInteger(proof.selectedSnapshotRevision)||
        proof.selectedSnapshotRevision<proof.originalSnapshotRevision||proof.snapshotRevision!==proof.selectedSnapshotRevision)
        throw journalError('JOURNAL_RECOVERY_REVIEW_RECEIPT','選択した図面の保存証明を照合できません');
      return {sha256:proof.sha256,size:proof.size,assetId:proof.assetId,selectedSnapshotRevision:proof.selectedSnapshotRevision};
    },
    async prepareMissingDrawingRecovery({scope:inputScope,localProjectId,bindingId,key,blob,size,sha256,proof,validate}={}){
      assertReady();const scope=checkedScope(inputScope),file={key,blob,size,sha256,proof:copy(proof)};
      cutoffRecoveryCheck(validate);await settled();window.SentlogRecords.assertSafe();await connect();cutoffRecoveryCheck(validate);
      const data=await readDrawingRecoveryState(localProjectId,key);cutoffRecoveryCheck(validate);
      reviewedDrawingCandidate(data.binding,file,scope,localProjectId,bindingId);
      const plan={status:'prepared',scope,localProjectId,bindingId,file,validate,
        recordRevision:Number(data.meta?.revision),fileSequence:data.fileSequence,generation:fileGenerations.get(key)||0,
        bindingText:archiveReleaseText(data.binding),liveMissing:data.live===undefined,liveType:data.live?.type,
        originalSnapshotRevision:data.binding.cutoff.serverRevision};
      drawingRecoveryStateCheck(plan,data);
      if(!await archiveReleaseMatches(blob,{size,sha256})||!plan.liveMissing&&!await archiveReleaseMatches(data.live,{size,sha256}))
        throw journalError('JOURNAL_RECOVERY_REVIEW_BYTES','候補または端末内の図面が確認した内容と異なります。上書きせず保持しています');
      drawingRecoveryStateCheck(plan,await readDrawingRecoveryState(localProjectId,key));
      const ticket=Object.freeze({});drawingRecoveryReviews.set(ticket,plan);return ticket;
    },
    cancelMissingDrawingRecovery(ticket){
      const plan=drawingRecoveryReviews.get(ticket);
      // Once confirmation starts, its guarded transaction owns the decision.
      // Never report a successful cancellation after writes may have begun.
      if(!plan||plan.status!=='prepared')return false;
      plan.status='cancelled';drawingRecoveryReviews.delete(ticket);return true;
    },
    async confirmMissingDrawingRecovery(ticket){
      const plan=drawingRecoveryReviews.get(ticket);
      if(!plan||plan.status!=='prepared')throw journalError('JOURNAL_RECOVERY_REVIEW_TICKET','この図面確認は無効または使用済みです。もう一度候補を確認してください');
      plan.status='confirming';
      try{
        assertReady();cutoffRecoveryCheck(plan.validate);await settled();window.SentlogRecords.assertSafe();await connect();
        let data=await readDrawingRecoveryState(plan.localProjectId,plan.file.key);drawingRecoveryStateCheck(plan,data);
        if(!await archiveReleaseMatches(plan.file.blob,plan.file)||!plan.liveMissing&&!await archiveReleaseMatches(data.live,plan.file))
          throw journalError('JOURNAL_RECOVERY_REVIEW_BYTES','確認した図面の内容が変わりました。上書きせず保持しています');
        data=await readDrawingRecoveryState(plan.localProjectId,plan.file.key);drawingRecoveryStateCheck(plan,data);
        const tx=transaction('readwrite'),done=complete(tx),control=tx.objectStore(CONTROL),files=tx.objectStore(STORE),current={};
        let waiting=6,next,row,result;
        const ready=()=>{if(--waiting)return;try{
          drawingRecoveryStateCheck(plan,current);
          const {key,blob,size,sha256,proof}=plan.file;
          const receipt={...copy(proof),version:1,kind:'sentlog-cutoff-recovery',sourceKind:'user-confirmed-current-drawing',
            originalSnapshotRevision:plan.originalSnapshotRevision,selectedSnapshotRevision:proof.snapshotRevision,
            exactOriginalVerified:false,recoveredAt:Date.now()};
          next=copy(current.binding);const index=next.cutoff.files.length,id=cutoffFileKey(plan.bindingId,index);
          row={version:1,kind:'cutoff-file',id,bindingId:plan.bindingId,localProjectId:plan.localProjectId,scope:copy(plan.scope),
            key,revision:1,value:blob,sha256,recovery:receipt};
          next.cutoff.files.push({key,valueRef:id,recovery:receipt});
          const save=()=>{
            drawingRecoveryStateCheck(plan,current);control.add(row,id);control.put(next,'binding:'+plan.localProjectId);
            if(plan.liveMissing)files.add(blob,key);
            result={restored:true,idempotent:false,liveWritten:plan.liveMissing,sourceKind:receipt.sourceKind};
          };
          if(plan.liveMissing)journalMutation(tx,{fileWrites:[{key,value:blob}],kind:'cutoff-drawing-recovery-confirmed',
            contexts:[contextOf({origin:'remote',operation:'file-recovery',context:{localProjectId:plan.localProjectId,
              assetId:proof.assetId,bindingId:plan.bindingId,sourceKind:receipt.sourceKind}})]},save);
          else save();
        }catch(error){tx.sentlogJournalError=error;tx.abort();}};
        control.get('binding:'+plan.localProjectId).onsuccess=e=>{current.binding=e.target.result;ready();};
        control.get('file:'+plan.file.key).onsuccess=e=>{current.fileSequence=Number(e.target.result)||0;ready();};
        files.get(META).onsuccess=e=>{current.meta=e.target.result;ready();};
        files.get(plan.file.key).onsuccess=e=>{current.live=e.target.result;ready();};
        files.get(PREFIX+WS).onsuccess=e=>{current.workspace=e.target.result;ready();};
        files.get(PREFIX+DRAW+plan.file.proof.drawingId).onsuccess=e=>{current.drawing=e.target.result;ready();};await done;
        plan.status='committed';bindings.set(plan.localProjectId,next);cutoffFiles.set(row.id,row);committedBindings(tx);notify();
        cutoffRecoveryCheck(plan.validate);return result;
      }finally{drawingRecoveryReviews.delete(ticket);if(plan.status!=='committed')plan.status='consumed';}
    },
    async restoreMissingCutoffFile({scope:inputScope,localProjectId,bindingId,key,blob,size,sha256,proof,validate}={}){
      assertReady();const scope=checkedScope(inputScope),file={key,blob,size,sha256,proof};
      cutoffRecoveryCheck(validate);await connect();cutoffRecoveryCheck(validate);
      const initial=await readControl('binding:'+localProjectId);
      if(!initial||!sameScope(initial.scope,scope)||initial.id!==bindingId||initial.phase!=='staging')
        throw journalError('JOURNAL_RECOVERY_SCOPE','復旧する控えの共有先または状態が変わりました');
      const ref=cutoffRecoveryReferences(initial).get(key);
      if(!ref)throw journalError('JOURNAL_RECOVERY_KEY','保護した記録に存在しないファイルは復旧できません');
      cutoffRecoveryProof(ref,file,scope,initial.cutoff.serverRevision);
      if(!await archiveReleaseMatches(blob,{size,sha256}))
        throw journalError('JOURNAL_RECOVERY_BYTES','復旧ファイルの内容照合に失敗しました');
      cutoffRecoveryCheck(validate);
      // One transaction saves the add-only protected copy and, only when
      // absent, the live file plus its journal. A crash cannot strand one half.
      const tx=transaction('readwrite'),done=complete(tx),control=tx.objectStore(CONTROL),files=tx.objectStore(STORE);
      let binding,live,waiting=2,result,row,next;
      const ready=()=>{if(--waiting)return;try{
        cutoffRecoveryCheck(validate);
        if(!binding||!sameScope(binding.scope,scope)||binding.id!==bindingId||binding.phase!=='staging')
          throw journalError('JOURNAL_RECOVERY_SCOPE','保存直前に復旧先が変わりました');
        const currentRef=cutoffRecoveryReferences(binding).get(key);
        if(!currentRef)throw journalError('JOURNAL_RECOVERY_KEY','保存直前に復旧する参照を確認できません');
        cutoffRecoveryProof(currentRef,file,scope,binding.cutoff.serverRevision);
        const prior=(binding.cutoff.files||[]).find(item=>item.key===key);
        if(prior){
          if(prior.recovery?.sha256!==sha256||prior.recovery?.size!==size)
            throw journalError('JOURNAL_RECOVERY_EXISTS','保護済みのファイルを上書きせず保持しました');
          result={restored:false,idempotent:true,liveWritten:false};return;
        }
        next=copy(binding);const index=next.cutoff.files.length,id=cutoffFileKey(bindingId,index);
        const receipt={version:1,kind:'sentlog-cutoff-recovery',...copy(proof),recoveredAt:Date.now()};
        row={version:1,kind:'cutoff-file',id,bindingId,localProjectId,scope:copy(scope),key,revision:1,
          value:blob,sha256,recovery:receipt};
        next.cutoff.files.push({key,valueRef:id,recovery:receipt});
        const save=()=>{
          cutoffRecoveryCheck(validate);control.add(row,id);control.put(next,'binding:'+localProjectId);
          if(live===undefined)files.add(blob,key);
          result={restored:true,idempotent:false,liveWritten:live===undefined};
        };
        if(live===undefined)journalMutation(tx,{fileWrites:[{key,value:blob}],kind:'cutoff-file-recovery',
          contexts:[contextOf({origin:'remote',operation:'file-recovery',context:{localProjectId,assetId:proof.assetId,bindingId}})]},save);
        else save();
      }catch(error){tx.sentlogJournalError=error;tx.abort();}};
      control.get('binding:'+localProjectId).onsuccess=e=>{binding=e.target.result;ready();};
      files.get(key).onsuccess=e=>{live=e.target.result;ready();};await done;
      if(next){bindings.set(localProjectId,next);cutoffFiles.set(row.id,row);committedBindings(tx);notify();}
      cutoffRecoveryCheck(validate);return result;
    },
    async pending({scope:inputScope,localProjectId}={}){
      assertReady();const scope=checkedScope(inputScope);await connect();const tx=transaction('readonly'),done=complete(tx);let result;
      collectJournal(tx,data=>{
        const binding=bindingIn(data,localProjectId,scope),workspace=workspaceOf(data.raw.get(WS)),owners=new Map();
        for(const project of workspace.projects)for(const drawing of project.drawings||[]){if(!owners.has(drawing.id))owners.set(drawing.id,new Set());owners.get(drawing.id).add(project.id);}
        const relevant=data.rows.filter(row=>{
          const orphan=row.seq>Math.max(binding.cutoffSeq,binding.lastLocalArchiveSeq||0)&&!row.projectIds.length&&row.drawingIds.some(id=>!owners.has(id)&&(data.raw.has(DRAW+id)||row.files.length));
          return orphan||(row.seq>binding.ackedSeq&&(row.projectIds.includes(localProjectId)||row.drawingIds.some(id=>owners.get(id)?.has(localProjectId))));
        });
        const claim=data.controls.find(x=>x?.kind==='claim'&&x.localProjectId===localProjectId);
        result={count:relevant.length,durableCount:relevant.length,queuedCount:0,throughSeq:Math.max(binding.ackedSeq,...relevant.map(x=>x.seq)),
          claimId:claim?.id||null,detached:binding.phase==='detached'};
      });await done;
      const changes=[...pending].map(([key,after])=>({key,after}));
      const before=durableMemory.get(WS)||null,after=pending.has(WS)?pending.get(WS):memory.get(WS)||null;
      let queued=changes.length&&affectedProjects(changes,before,after).projectIds.includes(localProjectId)?changes.length:0;
      queued+=inFlight;
      const projects=workspaceOf(memory.get(WS)).projects,ownDrawings=new Set(projects.find(p=>p.id===localProjectId)?.drawings?.map(d=>d.id)||[]),allDrawings=new Set(projects.flatMap(p=>(p.drawings||[]).map(d=>d.id)));
      for(const [key,writers] of fileWriters){const match=/^(?:background:([^:]+)|photo:([^:]+):)/.exec(key),id=match&&(match[1]||match[2]);
        if(!id||ownDrawings.has(id)||!allDrawings.has(id))queued+=writers.size;}
      result.queuedCount=queued;result.count+=queued;return result;
    },
    async begin({scope:inputScope,localProjectId,actor,serverRevision}={}){
      assertReady();const scope=checkedScope(inputScope);if(typeof localProjectId!=='string'||!localProjectId)throw journalError('JOURNAL_PROJECT','端末内の案件を確認できません');
      if(!actor||actor.deviceId!==scope.deviceId||typeof actor.deviceName!=='string')throw journalError('JOURNAL_ACTOR','編集する端末を確認できません');
      await settled();const tx=transaction('readwrite'),done=complete(tx);let result;
      const create=()=>collectJournal(tx,data=>{
        const existing=data.controls.find(x=>x?.kind==='binding'&&x.localProjectId===localProjectId);
        if(existing){if(!sameScope(existing.scope,scope))throw journalError('JOURNAL_SCOPE','この端末の案件は別の共有先に接続済みです');
          result=copy(existing.cutoff);return;}
        if(Number(data.meta?.revision)!==revision)throw journalError('JOURNAL_STALE','保存内容が変更されました。もう一度移行を確認してください');
        const snapshot=projectSnapshot(data.raw,localProjectId),seq=Math.max(0,...data.rows.map(x=>x.seq));
        // The numeric clock may be newer than the last retained row before the
        // first project is bound. Read it in this same transaction.
        const drawingIds=new Set(snapshot.project.drawings.map(d=>d.id));
        for(const drawing of snapshot.project.deltaMetadata?.retainedDrawings||[])if(drawing?.meta?.id)drawingIds.add(drawing.meta.id);
        collectProjectFiles(tx,drawingIds,files=>{tx.objectStore(CONTROL).get('clock').onsuccess=e=>{try{
          const cutoffSeq=Math.max(seq,Number(e.target.result)||0),bindingId='binding:'+crypto.randomUUID();
          const rawEntries=[...data.raw].filter(([key])=>key===WS||key===SYNC+localProjectId||key==='sentlogArchiveLocalV1'||
            (key.startsWith(DRAW)&&drawingIds.has(key.slice(DRAW.length)))||
            [...drawingIds].some(id=>key==='sentlogReplaceBackupV1:'+id)||key.startsWith('sentlogSyncMergeCheckpointV1:'+localProjectId+':'));
          result={version:1,kind:'sentlog-journal-cutoff',bindingId,scope:copy(scope),localProjectId,cutoffSeq,
            sourceRevision:revision,sourceMeta:copy(data.meta),snapshot,rawEntries,files,metadataRecords:{},
            ...(Number.isSafeInteger(serverRevision)&&serverRevision>=1?{serverRevision}:{})};
          const storedCutoff=copy(result);storedCutoff.files=files.map((file,index)=>{
            const id=cutoffFileKey(bindingId,index),row={version:1,kind:'cutoff-file',id,bindingId,localProjectId,scope:copy(scope),key:file.key,revision:1,value:file.value};
            tx.objectStore(CONTROL).add(row,id);return {key:file.key,valueRef:id};
          });
          const binding={version:1,kind:'binding',id:bindingId,scope:copy(scope),localProjectId,phase:'staging',actor:copy(actor),
            cutoffSeq,ackedSeq:cutoffSeq,metadataRecords:{},createdAt:Date.now(),cutoff:storedCutoff};
          tx.objectStore(CONTROL).put(binding,'binding:'+localProjectId);
        }catch(error){tx.sentlogJournalError=error;tx.abort();}};});
      });
      // Most retries already have a protected cutoff. Read that small binding
      // before collecting journal history or touching any live photo Blob.
      tx.objectStore(CONTROL).get('binding:'+localProjectId).onsuccess=e=>{try{
        const existing=e.target.result;
        if(existing!==undefined){if(!sameScope(existing?.scope,scope))throw journalError('JOURNAL_SCOPE','この端末の案件は別の共有先に接続済みです');
          bindingState(existing);return;}
        create();
      }catch(error){tx.sentlogJournalError=error;tx.abort();}};
      await done;const cutoff=await this.readCutoff({scope,localProjectId});notify();return cutoff;
    },
    async activate({scope:inputScope,localProjectId,baselineId,metadataRecords={},baselineSnapshot,proof}={}){
      const scope=checkedScope(inputScope);if(typeof baselineId!=='string'||!baselineId)throw journalError('JOURNAL_BASELINE','共有の基準を確認できません');
      const tx=transaction('readwrite'),done=complete(tx);let result;
      collectJournal(tx,data=>{const binding=bindingIn(data,localProjectId,scope);
        if(binding.baselineId&&binding.baselineId!==baselineId)throw journalError('JOURNAL_BASELINE','異なる共有の基準に変更できません');
        result={...binding,phase:binding.phase==='detached'?'detached':'active',baselineId,activatedAt:binding.activatedAt||Date.now(),
          metadataRecords:copy(metadataRecords),baselineProof:proof?copy(proof):null};
        if(baselineSnapshot&&!binding.replayBaseline)result.replayBaseline={before:copy(binding.cutoff.snapshot),after:copy(baselineSnapshot)};
        tx.objectStore(CONTROL).put(result,'binding:'+localProjectId);
      });await done;bindings.set(localProjectId,result);notify();return hydrateBinding(result);
    },
    async claim({scope:inputScope,localProjectId}={}){
      const scope=checkedScope(inputScope);await settled();const tx=transaction('readwrite'),done=complete(tx);let result=null;
      collectJournal(tx,data=>{
        const binding=bindingIn(data,localProjectId,scope);if(binding.phase!=='active')return;
        const existing=data.controls.find(x=>x?.kind==='claim'&&x.localProjectId===localProjectId);
        if(existing){if(!sameScope(existing.scope,scope))throw journalError('JOURNAL_SCOPE','処理中の共有先が一致しません');result=existing;return;}
        const allRows=data.rows.filter(x=>x.seq>binding.ackedSeq).sort((a,b)=>a.seq-b.seq);
        const restored=allRows.find(row=>row.archiveRestore?.localProjectId===localProjectId);
        const rows=restored?allRows.filter(row=>row.seq<=restored.seq):allRows;
        if(!rows.length)return;
        // Hydration is a distinct replay boundary. A later editor write must
        // be replayed normally after the archived cache has been acknowledged.
        const afterRaw=new Map(data.raw);if(restored)for(const row of [...allRows].reverse())if(row.seq>restored.seq)for(const change of row.changes)
          if(change.before===null)afterRaw.delete(change.key);else afterRaw.set(change.key,change.before);
        const beforeRaw=new Map(afterRaw);for(const row of [...rows].reverse())for(const change of row.changes)
          if(change.before===null)beforeRaw.delete(change.key);else beforeRaw.set(change.key,change.before);
        const before=projectSnapshot(beforeRaw,localProjectId,binding.cutoff.snapshot),after=projectSnapshot(afterRaw,localProjectId,before);
        const owned=new Set([...before.project.drawings,...after.project.drawings].map(x=>x.id));
        const relevant=rows.filter(row=>row.projectIds.includes(localProjectId)||row.drawingIds.some(id=>owned.has(id)));
        if(!relevant.length)return;
        const contexts=relevant.flatMap(row=>row.contexts||[]),operations=contexts.map(x=>x.operation);
        const operation=operations.includes('restore')?'restore':operations.includes('move')?'move':operations.includes('delete')?'delete':'edit';
        const expectedRecords=[...new Set([WS,...before.project.drawings.map(d=>DRAW+d.id),...after.project.drawings.map(d=>DRAW+d.id)])].map(key=>[key,data.raw.get(key)??null]);
        result={version:1,kind:'claim',id:'claim:'+crypto.randomUUID(),scope:copy(scope),localProjectId,
          throughSeq:rows[rows.length-1].seq,rowIds:relevant.map(x=>x.id),before,after,expectedRecords,operation,
          actor:copy(binding.actor),at:relevant[relevant.length-1].at,metadataRecords:copy(binding.metadataRecords),
          // rowIds pin the immutable WAL bytes until this claim is verified.
          // Copying native database-backed Blobs into another control row is
          // unnecessary and can fail on WebKit after a camera File is saved.
          replayBaseline:copy(binding.replayBaseline||null),contexts,
          fileReferences:relevant.flatMap(row=>(row.files||[]).map((file,index)=>({rowId:row.id,seq:row.seq,index,key:file.key}))),createdAt:Date.now(),
          ...(restored?{archiveRestore:copy(restored.archiveRestore)}:{})};
        tx.objectStore(CONTROL).put(result,'claim:'+localProjectId);
      });await done;return copy(result);
    },
    async verifyReplay({scope:inputScope,claimId,replica,replicaStore,requiredRecords={},projection,normalizedAfter,expectedSnapshotToken}={}){
      const scope=checkedScope(inputScope),D=window.SentlogDeltaSyncCore;
      if(typeof replicaStore?.readForVerification!=='function'||typeof replica?.snapshotWithStatus!=='function'||!D?.diffRecord)throw journalError('JOURNAL_PROOF','保存済みの差分履歴を照合する方法がありません');
      let state=null;
      for(let attempt=0;attempt<8;attempt++){
        const before=await replica.snapshotWithStatus(),durable=await replicaStore.readForVerification(),after=await replica.snapshotWithStatus();
        if(before.snapshotToken!==after.snapshotToken)continue;
        if(expectedSnapshotToken!==undefined&&before.snapshotToken!==expectedSnapshotToken)
          throw journalError('JOURNAL_RESTORE_CHANGED','復旧照合の途中で差分保存が変更されました');
        if(durable?.version!==2||!sameScope(durable.scope,scope)||JSON.stringify(durable)!==JSON.stringify(before.snapshot))
          throw journalError('JOURNAL_PROOF','記録・送信待ち・受信位置が同時に保存されていません');
        state=durable;break;
      }
      if(!state)throw journalError('JOURNAL_PROOF_BUSY','共有の更新が続いています。入力を保持し、保存照合を再試行します');
      D.validateState(state,scope,true);
      for(const [key,required] of Object.entries(requiredRecords)){
        const value=state.records[key],parts=JSON.parse(key);if(!value)throw journalError('JOURNAL_PROOF','編集履歴が保存先にありません');
        D.diffRecord(required,value,{eventId:'journal-proof',drawingId:parts[0],projectId:scope.projectId,deviceId:scope.deviceId});
      }
      const requiredSha256=await recordBlobHash(new Blob([JSON.stringify(requiredRecords)]));
      const replicaSha256=await recordBlobHash(new Blob([JSON.stringify(state)]));
      const proof={version:1,kind:'durable-replay-proof',claimId,scope:copy(scope),
        requiredSha256,recordCount:Object.keys(requiredRecords).length,replicaSha256,cursor:state.cursor,outboxCount:state.outbox.length};
      replayProofs.set(proof,{scope:copy(scope),claimId,projection:copy(normalizedAfter||projection)});return proof;
    },
    async acknowledge({scope:inputScope,localProjectId,claimId,proof}={}){
      const scope=checkedScope(inputScope),verified=replayProofs.get(proof);
      if(!verified||verified.claimId!==claimId||!sameScope(verified.scope,scope))throw journalError('JOURNAL_PROOF','端末内への保存を照合した証明が必要です');
      const tx=transaction('readwrite'),done=complete(tx);let result;
      collectJournal(tx,data=>{const binding=bindingIn(data,localProjectId,scope),claim=data.controls.find(x=>x?.kind==='claim'&&x.localProjectId===localProjectId);
        if(!claim||claim.id!==claimId||!sameScope(claim.scope,scope))throw journalError('JOURNAL_CLAIM','保存を確認する操作が変わっています');
        result={...binding,ackedSeq:claim.throughSeq,lastProof:copy(proof),replayBaseline:{before:copy(claim.after),after:copy(verified.projection)}};
        tx.objectStore(CONTROL).put(result,'binding:'+localProjectId);tx.objectStore(CONTROL).delete('claim:'+localProjectId);
      });await done;bindings.set(localProjectId,result);replayProofs.delete(proof);notify();
      // Cleanup is another bounded transaction. A failed cleanup cannot undo a
      // verified ACK; its immutable rows remain available for the next pass.
      try{await this.compact();}catch(error){console.warn('Journal retention cleanup deferred',error);}
      return hydrateBinding(result);
    },
    async compact({limit=256,scanLimit=1024}={}){
      assertReady();if(!Number.isSafeInteger(limit)||limit<1||limit>1024||!Number.isSafeInteger(scanLimit)||scanLimit<limit||scanLimit>8192)
        throw journalError('JOURNAL_COMPACT','履歴整理の件数が不正です');
      await connect();const tx=transaction('readwrite'),done=complete(tx),control=tx.objectStore(CONTROL),log=tx.objectStore(JOURNAL);
      let all=[],workspace=null,start=0,waiting=3;const result={scanned:0,removed:0,retainedFiles:0};
      function ready(){if(--waiting)return;try{
        const bound=new Map(all.filter(x=>x?.kind==='binding').map(x=>[x.localProjectId,x])),claimed=new Set(all.filter(x=>x?.kind==='claim').flatMap(x=>x.rowIds));
        const owners=new Map();for(const project of workspaceOf(workspace).projects)for(const drawing of project.drawings||[]){
          if(!owners.has(drawing.id))owners.set(drawing.id,new Set());owners.get(drawing.id).add(project.id);}
        function covered(binding,row){
          if(!binding||binding.phase==='staging')return false;
          if(binding.ackedSeq>=row.seq&&binding.lastProof?.kind==='durable-replay-proof')return true;
          if(binding.cutoffSeq>=row.seq&&binding.baselineId&&binding.baselineProof)return true;
          const certificate=binding.archive?.context?.deltaCheckpoint;
          return binding.lastLocalArchiveSeq>=row.seq&&certificate?.schema===1&&certificate.projectId===binding.scope.projectId&&
            typeof certificate.payloadSha256==='string'&&/^[0-9a-f]{64}$/.test(certificate.payloadSha256);
        }
        const q=log.openCursor(start?IDBKeyRange.lowerBound(start,true):undefined);q.onsuccess=()=>{
          const cursor=q.result;if(!cursor){control.put(0,'compactCursor');return;}
          const row=cursor.value;result.scanned++;let projectIds=row.projectIds||[],eligible=row.kind==='sentlog-app-intent'&&!claimed.has(row.id);
          if(eligible&&!projectIds.length){
            if(!row.drawingIds?.length)eligible=false;
            else{
              projectIds=[...new Set(row.drawingIds.flatMap(id=>[...(owners.get(id)||[])]))];
              eligible=projectIds.length>0&&row.drawingIds.every(id=>[...(owners.get(id)||[])].some(pid=>
                bound.get(pid)?.replayBaseline?.after?.project?.drawings?.some(d=>d.id===id)));
            }
          }
          if(eligible)eligible=projectIds.every(id=>covered(bound.get(id),row));
          if(eligible){
            if(row.files.length){
              const retained={version:row.version,kind:'sentlog-file-retention',id:row.id,seq:row.seq,at:row.at,mutationKind:row.mutationKind,
                projectIds:row.projectIds,drawingIds:row.drawingIds,resolvedProjectIds:projectIds,files:row.files,
                proofs:projectIds.map(id=>({localProjectId:id,scope:bound.get(id).scope,proof:bound.get(id).lastProof||bound.get(id).baselineProof||bound.get(id).archive.context.deltaCheckpoint}))};
              cursor.update(retained);result.retainedFiles++;
            }else{cursor.delete();result.removed++;}
          }
          if(result.removed+result.retainedFiles>=limit||result.scanned>=scanLimit){control.put(row.seq,'compactCursor');return;}
          cursor.continue();
        };
      }catch(error){tx.sentlogJournalError=error;tx.abort();}}
      journalControls(control).onsuccess=e=>{all=e.target.result;ready();};
      tx.objectStore(STORE).get(PREFIX+WS).onsuccess=e=>{workspace=e.target.result??null;ready();};
      control.get('compactCursor').onsuccess=e=>{start=Number(e.target.result)||0;ready();};
      await done;return result;
    },
    async applyProjection({scope:inputScope,localProjectId,writes,expectedRecords,metadataRecords={},validate}={}){
      const scope=checkedScope(inputScope),updates=[...writes],expected=[...expectedRecords];
      if(typeof validate!=='function')throw journalError('JOURNAL_GUARD','画面の受信前確認が必要です');
      const unchanged=()=>!pending.size&&!inFlight&&!exclusive&&expected.every(([key,value])=>(memory.get(key)??null)===value)&&validate()===true;
      if(!unchanged())return {applied:false,deferred:true};
      const tx=transaction('readwrite'),done=complete(tx);let nextRevision=null,nextBinding=null,deferred=false;
      collectJournal(tx,data=>{
        const binding=bindingIn(data,localProjectId,scope),project=data.raw.get(WS),owned=new Set(workspaceOf(project).projects.find(p=>p.id===localProjectId)?.drawings?.map(d=>d.id)||[]);
        const workspaceWrite=updates.find(x=>x[0]===WS),targetWorkspace=workspaceWrite?workspaceWrite[1]:project;
        const incomingIds=new Set(workspaceOf(targetWorkspace).projects.find(p=>p.id===localProjectId)?.drawings?.map(d=>d.id)||[]);
        const pendingRows=data.rows.some(x=>
          (x.seq>binding.ackedSeq&&(x.projectIds.includes(localProjectId)||x.drawingIds.some(id=>owned.has(id)||incomingIds.has(id))))||
          (x.seq>Math.max(binding.cutoffSeq,binding.lastLocalArchiveSeq||0)&&!x.projectIds.length&&x.drawingIds.some(id=>incomingIds.has(id))));
        if(binding.phase!=='active'||pendingRows||data.controls.some(x=>x?.kind==='claim'&&x.localProjectId===localProjectId)||!unchanged()||
          Number(data.meta?.revision)!==revision||!expected.every(([key,value])=>(data.raw.get(key)??null)===value)){
          deferred=true;return;
        }
        const changed=updates.map(([key,after])=>({key,before:data.raw.get(key)??null,after})).filter(x=>x.before!==x.after);
        const workspaceChange=changed.find(x=>x.key===WS),nextWorkspace=workspaceChange?workspaceChange.after:project;
        if(affectedProjects(changed,project,nextWorkspace).projectIds.some(id=>id!==localProjectId))
          throw journalError('JOURNAL_SCOPE','受信内容に別案件の変更が含まれています');
        const projectedWorkspace=workspaceOf(nextWorkspace),target=projectedWorkspace.projects.find(p=>p.id===localProjectId),targetDrawings=new Set((target?.drawings||[]).map(d=>d.id));
        for(const [key] of updates){
          if((key===WS||key.startsWith(DRAW))&&!expected.some(x=>x[0]===key))throw journalError('JOURNAL_PROJECTION','受信前の記録照合が不足しています');
          if(key.startsWith(DRAW)&&!targetDrawings.has(key.slice(DRAW.length))&&!owned.has(key.slice(DRAW.length)))
            throw journalError('JOURNAL_SCOPE','この案件に属さない図面を受信できません');
        }
        for(const drawingId of targetDrawings)if(projectedWorkspace.projects.filter(p=>(p.drawings||[]).some(d=>d.id===drawingId)).length!==1)
          throw journalError('JOURNAL_DRAWING','受信した図面IDが別案件と重複しています');
        for(const [key,value] of updates){if(!managed(key)||(value!==null&&typeof value!=='string'))throw journalError('JOURNAL_PROJECTION','受信内容の保存形式が不正です');
          if(value===null)tx.objectStore(STORE).delete(PREFIX+key);else tx.objectStore(STORE).put(value,PREFIX+key);}
        nextRevision=revision+1;tx.objectStore(STORE).put({...data.meta,revision:nextRevision,projectedAt:new Date().toISOString()},META);
        nextBinding={...binding,metadataRecords:copy(metadataRecords)};tx.objectStore(CONTROL).put(nextBinding,'binding:'+localProjectId);
      });await done;if(deferred)return {applied:false,deferred:true};
      revision=nextRevision;bindings.set(localProjectId,nextBinding);
      for(const [key,value] of updates){const prior=durableMemory.get(key)??null;if(value===null)durableMemory.delete(key);else durableMemory.set(key,value);
        if(!pending.has(key)&&(memory.get(key)??null)===prior){if(value===null)memory.delete(key);else memory.set(key,value);}}
      notify();return {applied:true,deferredUI:pending.size>0};
    }
  };
  async function commitBatch(batch,options=[]){
    let tx;try{tx=transaction('readwrite');}catch(error){rememberRecordFailure(error,batch,null);throw error;}
    const done=complete(tx),s=tx.objectStore(STORE),probe=observeRecordTransaction(tx);let conflict=false;
    s.get(META).onsuccess=e=>{
      if(!e.target.result || Number(e.target.result.revision)!==revision){conflict=true;tx.abort();return;}
      journalMutation(tx,{writes:[...batch],kind:'batch',contexts:options},()=>{
        for(const [key,value] of batch){if(value===null)recordRequest(tx,s,'delete',PREFIX+key);else recordRequest(tx,s,'put',value,PREFIX+key);}
        recordRequest(tx,s,'put',{...e.target.result,revision:revision+1,updatedAt:new Date().toISOString()},META);probe.queued=true;
      });
    };
    try{await done;}catch(e){const error=conflict?Error('別の画面で記録が変更されています。上書きを止めました。未保存の記録を退避してから画面を更新してください。'):e;
      rememberRecordFailure(error,batch,tx);throw error;}
    if(recordFailure)rememberFailureEvent('record-save-completed',{afterFailureSequence:latestRecordFailureEvent?.sequence??null});
    recordFailure=null;
    committedBindings(tx);revision++;for(const [key,value] of batch)if(value===null)durableMemory.delete(key);else durableMemory.set(key,value);
  }
  function kick(){if(queued || failure)return;queued=true;queueMicrotask(()=>{queued=false;flush().catch(()=>{});});}
  function batch(writes,options={}){
    assertReady();if(exclusive)throw Error('バックアップの復元中です');
    const entries=[...writes];
    for(const [key,value] of entries)if(!managed(key)||(value!==null&&typeof value!=='string'))throw Error('保存する記録の形式が不正です');
    rejectOldRemote(entries,options);
    const context=contextOf(options);
    for(const [key,value] of entries){
      if((memory.get(key)??null)===value)continue;
      if(value===null)memory.delete(key);else memory.set(key,value);
      pending.set(key,value);
    }
    if(pending.size){pendingOptions.push(context);notify();kick();}
  }
  function flush(){
    assertReady();if(flight)return flight;if(failure)return Promise.reject(failure);
    if(!pending.size)return Promise.resolve();
    flight=(async()=>{
      try{
        await connect();
        while(pending.size){
          const write=pending,contexts=pendingOptions;pending=new Map();pendingOptions=[];inFlight=write.size;notify();
          try{await commitBatch(write,contexts);}catch(error){
            for(const [k,v] of write)if(!pending.has(k))pending.set(k,v);
            pendingOptions=contexts.concat(pendingOptions);
            failure=connectionFailure||error;report('records',failure);throw error;
          }finally{inFlight=0;}
        }
        recovered('records');
      }finally{flight=null;notify();}
    })();
    return flight;
  }
  function writeFile(key,value,options={}){
    assertReady();
    if(exclusive) return Promise.reject(Error('復元中です'));
    const guarded=Object.keys(options).length>0;
    const validate=options.validate,onlyIfMissing=options.onlyIfMissing===true,signal=options.signal;
    function fileError(code,message){return Object.assign(Error(message),{code});}
    function check(){
      if(signal?.aborted)throw fileError('FILE_WRITE_ABORTED','ファイルの保存を中止しました');
      if(validate!==undefined){
        if(typeof validate!=='function')throw fileError('FILE_WRITE_GUARD','保存する対象を確認できません');
        const result=validate();
        if(result&&typeof result.then==='function'){
          Promise.resolve(result).catch(()=>{});
          throw fileError('FILE_WRITE_GUARD','保存の直前確認は同期的に行う必要があります');
        }
        if(result===false)throw fileError('FILE_WRITE_GUARD','保存する案件・写真が変更されました。上書きを止めました');
      }
    }
    // This is only a no-op optimization. Do not keep an IndexedDB transaction
    // alive while reading Blob bytes, and never replace changed-file history.
    // A failed comparison uses the existing write path; cancellation and the
    // caller's synchronous guards still reject normally.
    async function unchangedCandidate(){
      // Explicit lifecycle operations may update bindings even when the file
      // bytes match. Preserve their existing transaction side effects.
      const identity=fileIdentity(value);if(onlyIfMissing||identity===null||
        options.operation==='restore'||options.operation==='archive-local')return null;
      if(typeof setTimeout!=='function'||typeof clearTimeout!=='function')return null;
      const deadline=Date.now()+FILE_COMPARE_MS;
      function compareWait(reading,cancelRead){
        return new Promise((resolve,reject)=>{
          let finished=false,timer;
          const finish=(error,result)=>{
            if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
            if(error)try{cancelRead?.();}catch{}
            error?reject(error):resolve(result);
          };
          const cancel=()=>finish(fileError('FILE_WRITE_ABORTED','ファイルの保存を中止しました'));
          // Keep handlers on an uncancellable native Blob read after timeout.
          // Its eventual completion cannot change the subsequent write.
          Promise.resolve(reading).then(result=>finish(null,result),error=>finish(error));
          signal?.addEventListener('abort',cancel,{once:true});
          timer=setTimeout(()=>finish(fileError('FILE_COMPARE_TIMEOUT','同一ファイルの照合を打ち切りました')),Math.max(0,deadline-Date.now()));
          if(signal?.aborted)cancel();
        });
      }
      let before,sequence;
      try{
        const tx=transaction('readonly'),done=complete(tx);
        tx.objectStore(STORE).get(key).onsuccess=e=>{before=e.target.result;};
        tx.objectStore(CONTROL).get('file:'+key).onsuccess=e=>{sequence=Number(e.target.result)||0;};
        await compareWait(done,()=>tx.abort());
      }catch(error){check();return null;}
      check();if(fileIdentity(before)!==identity||!Number.isSafeInteger(sequence)||sequence<0)return null;
      for(let offset=0;offset<value.size;offset+=FILE_CHUNK_BYTES){
        check();if(Date.now()>=deadline)return null;
        const end=Math.min(value.size,offset+FILE_CHUNK_BYTES);let buffers;
        try{
          const parts=[before.slice(offset,end),value.slice(offset,end)];
          if(parts.some(part=>part.size!==end-offset))return null;
          buffers=await compareWait(Promise.all(parts.map(part=>part.arrayBuffer())));
        }catch(error){check();return null;}
        check();if(buffers.some(buffer=>Object.prototype.toString.call(buffer)!=='[object ArrayBuffer]'||buffer.byteLength!==end-offset))return null;
        const a=new Uint8Array(buffers[0]),b=new Uint8Array(buffers[1]);
        for(let i=0;i<a.length;i++)if(a[i]!==b[i])return null;
      }
      check();return {key,sequence,identity};
    }
    let task;fileGenerations.set(key,(fileGenerations.get(key)||0)+1);
    // Register the task before a synchronous guard can reject it. Otherwise
    // finally deletes undefined, leaving a rejected task in fileTasks forever.
    task=Promise.resolve().then(async()=>{
      try{
        check();await connect();check();
        const unchangedFile=await unchangedCandidate();check();
        const result=await new Promise((resolve,reject)=>{
          let tx;
          try{tx=transaction('readwrite');}catch(error){reject(error);return;}
          let reason=null,settled=false,saved;
          function finish(error){
            if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);
            if(error){reject(error);return;}
            try{check();resolve(saved);}catch(e){reject(e);}
          }
          function abort(error){
            if(settled)return;reason=reason||error;
            try{tx.abort();}catch{}
            finish(reason||fileError('FILE_WRITE_ABORTED','ファイルの保存が中断されました'));
          }
          function cancel(){abort(fileError('FILE_WRITE_ABORTED','ファイルの保存を中止しました'));}
          signal?.addEventListener('abort',cancel,{once:true});
          tx.oncomplete=()=>finish(reason);
          tx.onabort=()=>finish(reason||tx.sentlogJournalError||tx.error||fileError('FILE_WRITE_ABORTED','ファイルの保存が中断されました'));
          tx.onerror=()=>{};
          const store=tx.objectStore(STORE);
          function put(){
            if(settled)return;
            try{
              check();
              journalMutation(tx,{fileWrites:[{key,value}],kind:'file-write',contexts:[contextOf(options)],unchangedFile},result=>{
                if(result?.unchanged){check();saved={written:false,value:result.value,unchanged:true};return;}
                check();saved={written:true,value};const q=store.put(value,key);
                q.onerror=()=>{reason=reason||q.error;};
                q.onsuccess=()=>{if(settled)return;try{check();}catch(error){abort(error);}};
              });
            }catch(error){abort(error);}
          }
          if(onlyIfMissing){
            try{
              check();const q=store.get(key);
              q.onerror=()=>{reason=reason||q.error;};
              q.onsuccess=()=>{
                if(settled)return;
                try{check();if(q.result!==undefined){saved={written:false,value:q.result};return;}put();}
                catch(error){abort(error);}
              };
            }catch(error){abort(error);}
          }else put();
        });
        if(!guarded||(result.written&&failedFiles.get(key)===value))failedFiles.delete(key);
        if(!failedFiles.has(key))recovered('file:'+key);
        return guarded?result:undefined;
      }catch(error){
        // A guarded transfer owns its immutable bytes and its retry policy.
        // Never replay it later under a different account via the legacy queue.
        if(!guarded){failedFiles.set(key,value);report('file:'+key,error);}
        throw error;
      }
      finally{fileTasks.delete(task);fileTaskOwners.delete(task);const writers=fileWriters.get(key);writers?.delete(task);if(!writers?.size)fileWriters.delete(key);notify();}
    });fileTasks.add(task);if(!fileWriters.has(key))fileWriters.set(key,new Set());fileWriters.get(key).add(task);fileTaskOwners.set(task,options.ownerToken);notify();return task;
  }
  async function settled(){
    while(fileTasks.size)await Promise.all([...fileTasks]);
    await flush();
  }
  async function retry(){
    if(connectionFailure)throw connectionFailure;
    failure=null;
    for(const [key,value] of [...failedFiles])await writeFile(key,value);
    try{await flush();recovered('import');}catch(e){report('records',e);throw e;}
  }
  async function replaceAll(records,files,options={}){
    await settled();exclusive=true;operation=true;notify();
    try{
      records=[...records];files=[...files];
      for(const [key,value] of records)if(!managed(key)||typeof value!=='string')throw journalError('JOURNAL_RESTORE','復元する記録の形式が不正です');
      const tx=transaction('readwrite'),done=complete(tx),s=tx.objectStore(STORE);let conflict=false;
      let archive=null;
      s.get(ARCHIVE).onsuccess=e=>archive=e.target.result;
      s.get(META).onsuccess=e=>{
        if(!e.target.result || Number(e.target.result.revision)!==revision){conflict=true;tx.abort();return;}
        const oldMeta=e.target.result,q=s.getAllKeys();q.onsuccess=()=>{
          const restored=new Map(records),updates=[...new Set([...durableMemory.keys(),...restored.keys()])].map(k=>[k,restored.get(k)??null]);
          const deleted=q.result.filter(k=>!String(k).startsWith(PREFIX)&&k!==META&&k!==ARCHIVE&&!files.some(f=>f.key===k));
          journalMutation(tx,{writes:updates,fileWrites:files,fileDeletes:deleted,kind:'restore',contexts:[contextOf({...options,operation:'restore'})]},()=>{
            s.clear();s.put(archive,ARCHIVE);
            for(const [k,v] of records)s.put(v,PREFIX+k);
            for(const f of files)s.put(f.value,f.key);
            s.put({...oldMeta,revision:revision+1,restoredAt:new Date().toISOString()},META);
          });
        };
      };
      try{await done;}catch(e){if(conflict)throw Error('別の画面で記録が更新されたため復元を中止しました');throw e;}
      committedBindings(tx);revision++;memory=new Map(records);durableMemory=new Map(memory);failedFiles.clear();failures.clear();notify();
    }catch(e){report('import',e);throw e;}
    finally{exclusive=false;operation=false;notify();}
  }
  async function openFilesDatabase(){
    assertReady();await connect();return new Promise((resolve,reject)=>{
      const q=indexedDB.open(DB,DB_VERSION);q.onupgradeneeded=()=>q.transaction.abort();q.onerror=()=>reject(q.error);
      q.onsuccess=()=>{const db=q.result;if(db.version!==DB_VERSION||![STORE,JOURNAL,CONTROL].every(name=>db.objectStoreNames.contains(name))){db.close();reject(journalError('JOURNAL_SCHEMA','保存先の形式を確認できません'));return;}
        db.onversionchange=()=>db.close();resolve(db);};
    });
  }
  function writerState(key,{ownerToken}={}){const writers=[...(fileWriters.get(key)||[])],foreign=writers.filter(task=>!ownerToken||fileTaskOwners.get(task)!==ownerToken).length;
    return {key,pending:writers.length,foreignPending:foreign,failed:failedFiles.has(key),generation:fileGenerations.get(key)||0,
      exclusive:!exclusive&&!foreign&&!failedFiles.has(key),journaled:connection?.version===DB_VERSION};}
  async function readFileStates(keys){
    assertReady();await connect();const selected=[...new Set(keys)];if(selected.some(key=>typeof key!=='string'))throw journalError('JOURNAL_FILE','ファイルの識別情報が不正です');
    const tx=transaction('readonly'),done=complete(tx),states=new Map();
    for(const key of selected)tx.objectStore(CONTROL).get('file:'+key).onsuccess=e=>states.set(key,Number(e.target.result)||0);
    await done;return selected.map(key=>({key,sequence:states.get(key)}));
  }
  async function removeFiles(keys,options={}){
    assertReady();await settled();if(exclusive)throw journalError('JOURNAL_BUSY','ほかの保存処理が進行しています');
    const selected=[...new Set(keys)];if(selected.some(k=>typeof k!=='string'||k.startsWith(PREFIX)||[META,ARCHIVE].includes(k)))throw journalError('JOURNAL_FILE','削除するファイルを確認できません');
    if(options.validate&&options.validate()!==true)throw journalError('JOURNAL_GUARD','削除する対象が変更されました');
    exclusive=true;operation=true;notify();
    try{const tx=transaction('readwrite'),done=complete(tx);
      journalMutation(tx,{fileDeletes:selected,expectedFileStates:options.expectedFileStates||[],kind:'file-delete',contexts:[contextOf(options)]},()=>{
        if(options.validate&&options.validate()!==true)throw journalError('JOURNAL_GUARD','削除する対象が変更されました');
        for(const key of selected)tx.objectStore(STORE).delete(key);
      });await done;for(const key of selected)fileGenerations.set(key,(fileGenerations.get(key)||0)+1);return {removed:selected.length,retained:true};
    }finally{exclusive=false;operation=false;notify();}
  }
  async function clearFiles(options={}){
    assertReady();await settled();const tx=transaction('readonly'),done=complete(tx),keys=[];
    const q=tx.objectStore(STORE).openCursor();q.onsuccess=()=>{const cursor=q.result;if(!cursor)return;if(cursor.value instanceof Blob)keys.push(String(cursor.key));cursor.continue();};
    await done;return removeFiles(keys,options);
  }
  async function stats(){
    assertReady();const totals={records:0,drawings:0,photos:0,archive:0,other:0,drawingCount:0,photoCount:0};
    const tx=transaction('readonly'),done=complete(tx),q=tx.objectStore(STORE).openCursor();
    q.onsuccess=()=>{
      const c=q.result;if(!c)return;const k=String(c.key),v=c.value;
      if(k.startsWith(PREFIX))totals.records+=new Blob([v]).size;
      else if(k===ARCHIVE)totals.archive+=new Blob([JSON.stringify(v||{})]).size;
      else if(v instanceof Blob){
        if(k.startsWith('background:')||k==='background'){totals.drawings+=v.size;totals.drawingCount++;}
        else if(k.startsWith('photo:')){totals.photos+=v.size;totals.photoCount++;}
        else totals.other+=v.size;
      }c.continue();
    };
    await done;return totals;
  }
  window.SentlogRecords={init,flush,settled,writeFile,retry,batch,replaceAll,stats,
    deltaJournal,openFilesDatabase,removeFiles,clearFiles,writerState,readFileStates,
    startupProtectionVersion:1,
    storageLifecycleVersion:1,
    cutoffResumeVersion:1,
    getFileWriteCapabilities:()=>({guarded:true,onlyIfMissing:true,writerState:true,fileWriteDedupVersion:1,journaled:connection?.version===DB_VERSION}),
    uncommittedFiles:()=>[...failedFiles].map(([key,value])=>({key,value})),
    get ready(){return initialized;},get pending(){return pending.size+inFlight>0||fileTasks.size>0||operation;},get failed(){return failures.size>0;},
    get issues(){return [...failures];},get migration(){return migrationInfo;},
    get recordFailureDetails(){return !connectionFailure&&recordFailure?.error===failure&&failures.has('records')?{...recordFailure.detail}:null;},
    get recordFailureHistory(){return failureHistory();},
    getItem:k=>{assertReady();return memory.get(k)??null;},
    setItem:(k,v,options)=>batch([[k,String(v)]],options),removeItem:(k,options)=>batch([[k,null]],options),keys:()=>[...memory.keys()],
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},report,recovered,
    assertSafe(){assertReady();if(failure || failures.size)throw failure||Error('端末内の保存エラーを確認してください');}
  };
})();

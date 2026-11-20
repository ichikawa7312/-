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
  const listeners=new Set(), failures=new Map(), fileTasks=new Set(), failedFiles=new Map(), fileWriters=new Map(), fileGenerations=new Map(), fileTaskOwners=new Map();
  let bindings=new Map();
  function notify(){for(const fn of listeners){try{fn()}catch(e){console.warn('Storage status',e)}}}
  function report(key,error){failures.set(String(key),error?.message||String(error));notify();}
  function recovered(key){if(failures.delete(String(key)))notify();}
  function assertReady(){if(!initialized)throw Error('保存先の準備が完了していません');}
  function transaction(mode){
    if(!connection)throw Error('保存先との接続が切れました。画面を閉じず、再保存を試してください。');
    const stores=[STORE,JOURNAL,CONTROL];
    try{return connection.transaction(stores,mode,{durability:'strict'})}
    catch(e){if(e.name==='TypeError')return connection.transaction(stores,mode);throw e;}
  }
  function complete(tx){return new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.sentlogJournalError||tx.error||Error('端末への保存が中断されました'));
    tx.onerror=()=>{};
  });}
  async function connect(){
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
    connection.onversionchange=()=>{connection.close();connection=null;failure=Error('保存先が別の画面で更新されました。未保存の記録を退避してから更新してください。');report('records',failure);};
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
    let meta=null,archive=null,keys=[],values=[];
    s.get(META).onsuccess=e=>meta=e.target.result;
    s.get(ARCHIVE).onsuccess=e=>archive=e.target.result;
    const range=IDBKeyRange.bound(PREFIX,PREFIX+'\uffff');
    s.getAllKeys(range).onsuccess=e=>keys=e.target.result;
    s.getAll(range).onsuccess=e=>values=e.target.result;
    await done;
    return {meta,archive,map:new Map(keys.map((k,i)=>[k.slice(PREFIX.length),values[i]]))};
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
  async function initialize(){
    await editorLock();await connect();
    let disk=await readAll();
    const old=legacy();
    if(!disk.meta){
      if(localStorage.getItem(MARKER) && !old.size)throw Error('以前の端末内データを確認できません。空のデータで上書きせず起動を停止しました。バックアップの復旧が必要です。');
      const tx=transaction('readwrite'),done=complete(tx),s=tx.objectStore(STORE);
      const info={schema:1,revision:0,migratedAt:new Date().toISOString(),legacyCount:old.size};
      let already=false;
      s.get(META).onsuccess=e=>{
        if(e.target.result){already=true;return;}
        for(const [key,value] of old)s.put(value,PREFIX+key);
        if(!old.has(WS))s.put('{"projects":[]}',PREFIX+WS);
        s.put({migratedAt:info.migratedAt,entries:[...old]},ARCHIVE);
        s.put(info,META);
      };
      await done;disk=await readAll();
      if(!already){
        for(const [key,value] of old)if(disk.map.get(key)!==value)throw Error('移行後の記録照合に失敗しました。元データは削除していません。');
        cleanLegacy(old);
      }
    }else if(old.size){
      // A pre-migration tab must not silently revive/overwrite newer records.
      const archived=new Map(disk.archive?.entries||[]);
      for(const [key,value] of old)if(archived.get(key)!==value && disk.map.get(key)!==value)
        throw Error('旧版の画面で変更された記録があります。どちらも上書きせず停止しました。旧版の控えを書き出してから確認してください。');
      cleanLegacy(old);
    }
    for(const [key,value] of disk.map){if(!managed(key)||typeof value!=='string')throw Error('保存記録の形式を確認できません');JSON.parse(value);}
    memory=disk.map;durableMemory=new Map(memory);revision=Number(disk.meta.revision)||0;migrationInfo=disk.meta;
    {const tx=transaction('readonly'),done=complete(tx),q=tx.objectStore(CONTROL).getAll();q.onsuccess=()=>{bindings=new Map(q.result.filter(x=>x?.kind==='binding').map(x=>[x.localProjectId,x]));};await done;}
    try{localStorage.setItem(MARKER,'1');}catch(_){}
    initialized=true;notify();return true;
  }
  function init(){if(!boot)boot=initialize();return boot;}
  const copy=value=>structuredClone(value);
  const scopeKeys=['ownerId','projectId','deviceId'];
  const sameScope=(a,b)=>a&&b&&scopeKeys.every(k=>a[k]===b[k]);
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
  function journalControls(store){return store.indexNames.contains('kind')?store.index('kind').getAll():store.getAll();}
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
  // Read preimages, append the immutable intent, and mutate the legacy view in
  // ONE transaction. A completed canvas save therefore always has a replayable
  // intent, even if the process dies before the independent replica is written.
  function journalMutation(tx,{writes=[],fileWrites=[],fileDeletes=[],expectedFileStates=[],kind='batch',contexts=[]}={},mutate){
    const s=tx.objectStore(STORE),control=tx.objectStore(CONTROL),log=tx.objectStore(JOURNAL);
    const recordKeys=[...new Set(writes.map(x=>x[0]))],fileKeys=[...new Set([...fileWrites.map(x=>x.key),...fileDeletes.map(x=>typeof x==='string'?x:x.key)])];
    const archiveContext=contexts.find(x=>x.operation==='archive-local'&&x.context?.localArchive===true);
    const before=new Map(),oldFiles=new Map(),fileStates=new Map();let workspaceBefore=null,allBindings=[],clock=0,archiveRows=[],rawKeys=new Set(),
      waiting=3+recordKeys.length+fileKeys.length+expectedFileStates.length+(archiveContext?2:0);
    function stop(error){tx.sentlogJournalError=error;try{tx.abort();}catch{}}
    function ready(){
      if(--waiting)return;
      try{
        for(const expected of expectedFileStates)if(!expected||typeof expected.key!=='string'||!Number.isSafeInteger(expected.sequence)||
          expected.sequence<0||fileStates.get(expected.key)!==expected.sequence)
          throw journalError('JOURNAL_FILE_CHANGED','確認中にファイルが変更されました。削除せず保持しています');
        const changes=writes.map(([key,after])=>({key,before:before.get(key)??null,after})).filter(x=>x.before!==x.after);
        const fileChanges=fileKeys.map(key=>({key,before:oldFiles.get(key)??null,
          after:fileWrites.find(x=>x.key===key)?.value??null}));
        const workspaceChange=changes.find(x=>x.key===WS),workspaceAfter=workspaceChange?workspaceChange.after:workspaceBefore;
        const affected=affectedProjects(changes,workspaceBefore,workspaceAfter,fileChanges),bound=allBindings.filter(x=>x?.kind==='binding');
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
        const seq=clock+1;
        const ownedIds=new Set(workspaceOf(workspaceAfter).projects.flatMap(project=>(project.drawings||[]).map(d=>d.id)));
        const hasOrphan=affected.drawingIds.some(id=>!ownedIds.has(id));
        if(bound.length&&(changes.length||fileChanges.length)&&(hasOrphan||affected.projectIds.some(id=>bound.some(b=>b.localProjectId===id)))){
          const row={version:1,kind:'sentlog-app-intent',id:'wal:'+crypto.randomUUID(),seq,at:Date.now(),
            sourceRevision:revision,mutationKind:kind,contexts:copy(contexts),changes,files:fileChanges,
            workspaceBefore,workspaceAfter,...affected};
          log.add(row,seq);
        }
        const archived=archiveContext;
        const restored=contexts.some(x=>x.operation==='restore');
        for(const binding of bound){
          const localArchive=archived&&(archived.context.localProjectId||archived.context.projectId)===binding.localProjectId;
          const localRestore=restored&&binding.phase==='detached'&&workspaceOf(workspaceAfter).projects.some(p=>p.id===binding.localProjectId);
          if(!localArchive&&!localRestore)continue;
          const next={...binding,phase:localArchive&&archived.context.mode==='project'?'detached':'active',
            ...(localArchive?{ackedSeq:seq,lastLocalArchiveSeq:seq,archive:{seq,at:Date.now(),context:copy(archived.context)}}:{restoredAt:Date.now()})};
          control.put(next,'binding:'+binding.localProjectId);
          (tx.sentlogBindingUpdates||(tx.sentlogBindingUpdates=[])).push(next);
        }
        tx.sentlogFileKeys=fileKeys;
        for(const key of fileKeys)control.put(seq,'file:'+key);
        control.put(seq,'clock');mutate();
      }catch(error){stop(error);}
    }
    control.get('clock').onsuccess=e=>{clock=Number(e.target.result)||0;ready();};
    journalControls(control).onsuccess=e=>{allBindings=e.target.result;ready();};
    s.get(PREFIX+WS).onsuccess=e=>{workspaceBefore=e.target.result??null;ready();};
    for(const key of recordKeys)s.get(PREFIX+key).onsuccess=e=>{before.set(key,e.target.result??null);ready();};
    for(const key of fileKeys)s.get(key).onsuccess=e=>{oldFiles.set(key,e.target.result??null);ready();};
    for(const expected of expectedFileStates)control.get('file:'+expected?.key).onsuccess=e=>{fileStates.set(expected?.key,Number(e.target.result)||0);ready();};
    if(archiveContext){journalRows(log).onsuccess=e=>{archiveRows=e.target.result.filter(x=>x.kind==='sentlog-app-intent');ready();};
      s.getAllKeys(IDBKeyRange.bound(PREFIX,PREFIX+'\uffff')).onsuccess=e=>{rawKeys=new Set(e.target.result.map(key=>key.slice(PREFIX.length)));ready();};}
  }
  function committedBindings(tx){for(const binding of tx.sentlogBindingUpdates||[])bindings.set(binding.localProjectId,binding);
    for(const key of tx.sentlogFileKeys||[])fileGenerations.set(key,(fileGenerations.get(key)||0)+1);}
  function collectJournal(tx,includeFiles,callback){
    const data={raw:new Map(),rows:[],controls:[],meta:null,files:[]},s=tx.objectStore(STORE);
    let keys=[],values=[],allKeys=[],allValues=[],waiting=includeFiles?7:5;
    const range=IDBKeyRange.bound(PREFIX,PREFIX+'\uffff');
    function done(){if(--waiting)return;try{
      data.raw=new Map(keys.map((key,i)=>[key.slice(PREFIX.length),values[i]]));
      if(includeFiles)data.files=allKeys.map((key,i)=>({key,value:allValues[i]})).filter(x=>x.value instanceof Blob);
      callback(data);
    }catch(error){tx.sentlogJournalError=error;tx.abort();}}
    s.getAllKeys(range).onsuccess=e=>{keys=e.target.result;done();};s.getAll(range).onsuccess=e=>{values=e.target.result;done();};
    s.get(META).onsuccess=e=>{data.meta=e.target.result;done();};
    journalRows(tx.objectStore(JOURNAL)).onsuccess=e=>{data.rows=e.target.result.filter(x=>x.kind==='sentlog-app-intent');done();};
    journalControls(tx.objectStore(CONTROL)).onsuccess=e=>{data.controls=e.target.result;done();};
    if(includeFiles){s.getAllKeys().onsuccess=e=>{allKeys=e.target.result;done();};s.getAll().onsuccess=e=>{allValues=e.target.result;done();};}
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
  const deltaJournal={
    version:1,
    bindingFor:localProjectId=>copy(bindings.get(localProjectId)||null),
    listBindingsSync:()=>copy([...bindings.values()]),
    assertFence({scope,localProjectId}={}){
      const b=bindings.get(localProjectId);
      if(!initialized||!connection||connection.version!==DB_VERSION||!sameScope(b?.scope,scope)||failure)
        throw journalError('JOURNAL_FENCE','変更履歴を同時保存する準備ができていません');
      return true;
    },
    async listBindings(){assertReady();await connect();const tx=transaction('readonly'),done=complete(tx);let result=[];
      tx.objectStore(CONTROL).getAll().onsuccess=e=>result=e.target.result.filter(x=>x?.kind==='binding');await done;return copy(result);},
    async pending({scope:inputScope,localProjectId}={}){
      assertReady();const scope=checkedScope(inputScope);await connect();const tx=transaction('readonly'),done=complete(tx);let result;
      collectJournal(tx,false,data=>{
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
      collectJournal(tx,true,data=>{
        const existing=data.controls.find(x=>x?.kind==='binding'&&x.localProjectId===localProjectId);
        if(existing){if(!sameScope(existing.scope,scope))throw journalError('JOURNAL_SCOPE','この端末の案件は別の共有先に接続済みです');
          result=copy(existing.cutoff);return;}
        if(Number(data.meta?.revision)!==revision)throw journalError('JOURNAL_STALE','保存内容が変更されました。もう一度移行を確認してください');
        const snapshot=projectSnapshot(data.raw,localProjectId),seq=Math.max(0,...data.rows.map(x=>x.seq));
        // The numeric clock may be newer than the last retained row before the
        // first project is bound. Read it in this same transaction.
        tx.objectStore(CONTROL).get('clock').onsuccess=e=>{
          const cutoffSeq=Math.max(seq,Number(e.target.result)||0),bindingId='binding:'+crypto.randomUUID();
          const drawingIds=new Set(snapshot.project.drawings.map(d=>d.id));
          for(const drawing of snapshot.project.deltaMetadata?.retainedDrawings||[])if(drawing?.meta?.id)drawingIds.add(drawing.meta.id);
          const rawEntries=[...data.raw].filter(([key])=>key===WS||key===SYNC+localProjectId||key==='sentlogArchiveLocalV1'||
            (key.startsWith(DRAW)&&drawingIds.has(key.slice(DRAW.length)))||
            [...drawingIds].some(id=>key==='sentlogReplaceBackupV1:'+id)||key.startsWith('sentlogSyncMergeCheckpointV1:'+localProjectId+':'));
          const files=data.files.filter(file=>[...drawingIds].some(id=>file.key==='background:'+id||file.key==='dxf:'+id||file.key.startsWith('photo:'+id+':')));
          result={version:1,kind:'sentlog-journal-cutoff',bindingId,scope:copy(scope),localProjectId,cutoffSeq,
            sourceRevision:revision,sourceMeta:copy(data.meta),snapshot,rawEntries,files,metadataRecords:{},
            ...(Number.isSafeInteger(serverRevision)&&serverRevision>=1?{serverRevision}:{})};
          const binding={version:1,kind:'binding',id:bindingId,scope:copy(scope),localProjectId,phase:'staging',actor:copy(actor),
            cutoffSeq,ackedSeq:cutoffSeq,metadataRecords:{},createdAt:Date.now(),cutoff:copy(result)};
          tx.objectStore(CONTROL).put(binding,'binding:'+localProjectId);
        };
      });
      await done;const list=await this.listBindings();bindings=new Map(list.map(x=>[x.localProjectId,x]));notify();return copy(result);
    },
    async activate({scope:inputScope,localProjectId,baselineId,metadataRecords={},baselineSnapshot,proof}={}){
      const scope=checkedScope(inputScope);if(typeof baselineId!=='string'||!baselineId)throw journalError('JOURNAL_BASELINE','共有の基準を確認できません');
      const tx=transaction('readwrite'),done=complete(tx);let result;
      collectJournal(tx,false,data=>{const binding=bindingIn(data,localProjectId,scope);
        if(binding.baselineId&&binding.baselineId!==baselineId)throw journalError('JOURNAL_BASELINE','異なる共有の基準に変更できません');
        result={...binding,phase:binding.phase==='detached'?'detached':'active',baselineId,activatedAt:binding.activatedAt||Date.now(),
          metadataRecords:copy(metadataRecords),baselineProof:proof?copy(proof):null};
        if(baselineSnapshot&&!binding.replayBaseline)result.replayBaseline={before:copy(binding.cutoff.snapshot),after:copy(baselineSnapshot)};
        tx.objectStore(CONTROL).put(result,'binding:'+localProjectId);
      });await done;bindings.set(localProjectId,result);notify();return copy(result);
    },
    async claim({scope:inputScope,localProjectId}={}){
      const scope=checkedScope(inputScope);await settled();const tx=transaction('readwrite'),done=complete(tx);let result=null;
      collectJournal(tx,false,data=>{
        const binding=bindingIn(data,localProjectId,scope);if(binding.phase!=='active')return;
        const existing=data.controls.find(x=>x?.kind==='claim'&&x.localProjectId===localProjectId);
        if(existing){if(!sameScope(existing.scope,scope))throw journalError('JOURNAL_SCOPE','処理中の共有先が一致しません');result=existing;return;}
        const rows=data.rows.filter(x=>x.seq>binding.ackedSeq).sort((a,b)=>a.seq-b.seq);
        if(!rows.length)return;
        const beforeRaw=new Map(data.raw);for(const row of [...rows].reverse())for(const change of row.changes)
          if(change.before===null)beforeRaw.delete(change.key);else beforeRaw.set(change.key,change.before);
        const before=projectSnapshot(beforeRaw,localProjectId,binding.cutoff.snapshot),after=projectSnapshot(data.raw,localProjectId,before);
        const owned=new Set([...before.project.drawings,...after.project.drawings].map(x=>x.id));
        const relevant=rows.filter(row=>row.projectIds.includes(localProjectId)||row.drawingIds.some(id=>owned.has(id)));
        if(!relevant.length)return;
        const contexts=relevant.flatMap(row=>row.contexts||[]),operations=contexts.map(x=>x.operation);
        const operation=operations.includes('restore')?'restore':operations.includes('move')?'move':operations.includes('delete')?'delete':'edit';
        const expectedRecords=[...new Set([WS,...before.project.drawings.map(d=>DRAW+d.id),...after.project.drawings.map(d=>DRAW+d.id)])].map(key=>[key,data.raw.get(key)??null]);
        result={version:1,kind:'claim',id:'claim:'+crypto.randomUUID(),scope:copy(scope),localProjectId,
          throughSeq:rows[rows.length-1].seq,rowIds:relevant.map(x=>x.id),before,after,expectedRecords,operation,
          actor:copy(binding.actor),at:relevant[relevant.length-1].at,metadataRecords:copy(binding.metadataRecords),
          replayBaseline:copy(binding.replayBaseline||null),contexts,files:relevant.flatMap(x=>x.files),createdAt:Date.now()};
        tx.objectStore(CONTROL).put(result,'claim:'+localProjectId);
      });await done;return copy(result);
    },
    async verifyReplay({scope:inputScope,claimId,replica,replicaStore,requiredRecords={},projection,normalizedAfter}={}){
      const scope=checkedScope(inputScope),D=window.SentlogDeltaSyncCore;
      if(typeof replicaStore?.read!=='function'||typeof replica?.snapshotWithStatus!=='function'||!D?.diffRecord)throw journalError('JOURNAL_PROOF','保存済みの差分履歴を照合する方法がありません');
      let state=null;
      for(let attempt=0;attempt<8;attempt++){
        const before=await replica.snapshotWithStatus(),durable=await replicaStore.read(),after=await replica.snapshotWithStatus();
        if(before.snapshotToken!==after.snapshotToken)continue;
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
      const bytes=await crypto.subtle.digest('SHA-256',await new Blob([JSON.stringify(requiredRecords)]).arrayBuffer());
      const replicaBytes=await crypto.subtle.digest('SHA-256',await new Blob([JSON.stringify(state)]).arrayBuffer());
      const proof={version:1,kind:'durable-replay-proof',claimId,scope:copy(scope),
        requiredSha256:[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join(''),recordCount:Object.keys(requiredRecords).length,
        replicaSha256:[...new Uint8Array(replicaBytes)].map(x=>x.toString(16).padStart(2,'0')).join(''),cursor:state.cursor,outboxCount:state.outbox.length};
      replayProofs.set(proof,{scope:copy(scope),claimId,projection:copy(normalizedAfter||projection)});return proof;
    },
    async acknowledge({scope:inputScope,localProjectId,claimId,proof}={}){
      const scope=checkedScope(inputScope),verified=replayProofs.get(proof);
      if(!verified||verified.claimId!==claimId||!sameScope(verified.scope,scope))throw journalError('JOURNAL_PROOF','端末内への保存を照合した証明が必要です');
      const tx=transaction('readwrite'),done=complete(tx);let result;
      collectJournal(tx,false,data=>{const binding=bindingIn(data,localProjectId,scope),claim=data.controls.find(x=>x?.kind==='claim'&&x.localProjectId===localProjectId);
        if(!claim||claim.id!==claimId||!sameScope(claim.scope,scope))throw journalError('JOURNAL_CLAIM','保存を確認する操作が変わっています');
        result={...binding,ackedSeq:claim.throughSeq,lastProof:copy(proof),replayBaseline:{before:copy(claim.after),after:copy(verified.projection)}};
        tx.objectStore(CONTROL).put(result,'binding:'+localProjectId);tx.objectStore(CONTROL).delete('claim:'+localProjectId);
      });await done;bindings.set(localProjectId,result);replayProofs.delete(proof);notify();
      // Cleanup is another bounded transaction. A failed cleanup cannot undo a
      // verified ACK; its immutable rows remain available for the next pass.
      try{await this.compact();}catch(error){console.warn('Journal retention cleanup deferred',error);}
      return copy(result);
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
      collectJournal(tx,false,data=>{
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
    const tx=transaction('readwrite'),done=complete(tx),s=tx.objectStore(STORE);let conflict=false;
    s.get(META).onsuccess=e=>{
      if(!e.target.result || Number(e.target.result.revision)!==revision){conflict=true;tx.abort();return;}
      journalMutation(tx,{writes:[...batch],kind:'batch',contexts:options},()=>{
        for(const [key,value] of batch){if(value===null)s.delete(PREFIX+key);else s.put(value,PREFIX+key);}
        s.put({...e.target.result,revision:revision+1,updatedAt:new Date().toISOString()},META);
      });
    };
    try{await done;}catch(e){if(conflict)throw Error('別の画面で記録が変更されています。上書きを止めました。未保存の記録を退避してから画面を更新してください。');throw e;}
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
            failure=error;report('records',error);throw error;
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
    let task;fileGenerations.set(key,(fileGenerations.get(key)||0)+1);
    // Register the task before a synchronous guard can reject it. Otherwise
    // finally deletes undefined, leaving a rejected task in fileTasks forever.
    task=Promise.resolve().then(async()=>{
      try{
        check();await connect();check();
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
              journalMutation(tx,{fileWrites:[{key,value}],kind:'file-write',contexts:[contextOf(options)]},()=>{
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
    getFileWriteCapabilities:()=>({guarded:true,onlyIfMissing:true,writerState:true,journaled:connection?.version===DB_VERSION}),
    uncommittedFiles:()=>[...failedFiles].map(([key,value])=>({key,value})),
    get ready(){return initialized;},get pending(){return pending.size+inFlight>0||fileTasks.size>0||operation;},get failed(){return failures.size>0;},
    get issues(){return [...failures];},get migration(){return migrationInfo;},
    getItem:k=>{assertReady();return memory.get(k)??null;},
    setItem:(k,v,options)=>batch([[k,String(v)]],options),removeItem:(k,options)=>batch([[k,null]],options),keys:()=>[...memory.keys()],
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},report,recovered,
    assertSafe(){assertReady();if(failure || failures.size)throw failure||Error('端末内の保存エラーを確認してください');}
  };
})();

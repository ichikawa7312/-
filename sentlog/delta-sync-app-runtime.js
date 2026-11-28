/* Application coordinator. The durable legacy journal owns user intent until
 * the replica transaction proves its exact immutable history was saved.
 * Ownership stays scoped even when an idle project's heavy replica is parked.
 * Authentication changes close all work.
 */
(function(root){
  'use strict';
  const req=name=>typeof module==='object'&&module.exports?require('./'+name+'.js'):null;
  const D=root.SentlogDeltaSyncCore||req('delta-sync-core');
  const C=root.SentlogRecordCollaboration||req('record-collaboration');
  const I=root.SentlogDeltaIndexedDB||req('delta-sync-indexeddb');
  const T=root.SentlogDeltaTransport||req('delta-sync-transport');
  const B=root.SentlogDeltaAppBridge||req('delta-sync-app-bridge');
  const A=root.SentlogDeltaAssets||req('delta-sync-assets');
  const AT=root.SentlogDeltaAssetTransport||req('delta-sync-asset-transport');
  const AR=root.SentlogDeltaAssetRuntime||req('delta-sync-asset-runtime');
  const SCOPE=['ownerId','projectId','deviceId'];
  const copy=x=>root.structuredClone(x),same=(a,b)=>a&&b&&SCOPE.every(k=>a[k]===b[k]);
  const fail=(code,message)=>Object.assign(Error(message),{code});
  function insist(ok,code,message){if(!ok)throw fail(code,message);}
  // Archive proofs outlive one in-memory replica. A fixed-size digest preserves
  // the exact durable-state check across parking without retaining that state.
  async function snapshotDigest(value){
    const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?
      '['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
    const bytes=new TextEncoder().encode(canonical(value));
    return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  function createRuntime({records,url,key,session,ensureSession,authGeneration,subscribeAuth,deviceId,
    install,applyProjection,readFile,withFileLock,actor,onStatus=()=>{},onPhotoReceived=()=>{},onFileJournaled=()=>{},canProject=()=>true,
    network=()=>root.navigator?.onLine!==false,visible=()=>!root.document?.hidden,
    factories={},fetch:fetcher=root.fetch}={}){
    insist(records?.deltaJournal&&[session,ensureSession,authGeneration,subscribeAuth,deviceId,install,
      applyProjection,readFile,withFileLock,actor,canProject,onFileJournaled].every(x=>typeof x==='function'),
      'DELTA_APP_CONFIG','編集・保存・同期の接続方法を確認できません');
    const contexts=new Map();let closed=false,usage=0,trimTimer=null,background=Promise.resolve();
    const heavy=['controller','bridge','replica','assets','assetTransport','assetStore','store'];
    const J=()=>root.SentlogDeltaAppJournal||req('delta-sync-app-journal');
    const M=()=>root.SentlogDeltaMetadata||req('delta-sync-metadata');
    const make={store:I.createStore,transport:T.createTransport,provider:T.createRestProvider,
      replica:D.createReplica,bridge:B.createBridge,assetStore:A.createIndexedDBStore,
      assetTransport:AT.createTransport,assets:AR.createRuntime,...factories};
    function current(c){
      return !closed&&!c.closed&&authGeneration()===c.authGeneration&&session()?.user?.id===c.scope.ownerId&&
        deviceId()===c.scope.deviceId?c.scope:null;
    }
    function check(c){insist(current(c),'DELTA_APP_SCOPE','ログインまたは端末が変わりました。変更は元の案件に保持しています');}
    function report(c,status){if(current(c))try{onStatus({...status,localProjectId:c.localProjectId,scope:copy(c.scope)});}catch{}}
    function retain(c){
      check(c);c.users++;c.lastUsed=++usage;let released=false;
      return ()=>{if(released)return;released=true;c.users--;trimSoon();};
    }
    async function using(c,fn){const release=retain(c);try{return await fn();}finally{release();}}
    // Core reconciliation runs outside the public coordinator calls. Track its
    // actual storage/network promises as well, and close only at a task boundary
    // after their continuations have finished. Never interrupt a durable write.
    function tracked(c,value,names){
      const out=Object.create(value);
      for(const name of names)if(typeof value[name]==='function')out[name]=(...args)=>{
        c.io++;let result;
        try{result=value[name](...args);}catch(error){c.io--;trimSoon();throw error;}
        return Promise.resolve(result).finally(()=>{c.io--;trimSoon();});
      };
      return out;
    }
    function reconcileParked(c){
      if(c.parkTimer||!c.parked||!current(c))return;
      c.parkTimer=setTimeout(()=>{c.parkTimer=null;
        if(c.parked&&current(c)&&network()&&visible())queueParked(c);
        reconcileParked(c);
      },60000);c.parkTimer?.unref?.();
    }
    function queueParked(c){
      if(c.backgroundQueued||!current(c)||!c.mode?.enabled)return;
      c.backgroundQueued=true;
      // A burst of notices must not hydrate every project at once.
      background=background.catch(()=>{}).then(async()=>{
        if(!current(c)||!network()||!visible())return;
        try{await sync(c.cp);}catch(error){if(current(c))report(c,{level:'pending',message:error.message,code:error.code});}
      }).finally(()=>{c.backgroundQueued=false;trimSoon();});
    }
    function park(c){
      if(c.parked&&!c.store&&!c.checkpoint?.payload)return;
      // Keep the small notification connection and ownership summary. Closing a
      // replica must not silently opt the project back into the legacy writer.
      if(!c.parkNotice&&typeof c.transport?.subscribe==='function'){
        try{c.parkNotice=c.transport.subscribe(c.scope.projectId,notice=>{
          if(c.parked&&Number.isSafeInteger(notice?.seq)&&notice.seq>(c.cursor||0))queueParked(c);
        });}catch{} // The normal bounded reconciliation remains available.
      }
      c.parked=true;
      for(const name of heavy){try{c[name]?.close?.();}catch{}c[name]=null;}
      c.snapshotToken=null;c.assetExpectedRaw=null;c.started=false;
      if(c.checkpoint){const {payload,...header}=c.checkpoint;c.checkpoint=header;}
      reconcileParked(c);
    }
    function trimSoon(){
      if(closed||trimTimer!==null)return;
      trimTimer=setTimeout(()=>{
        trimTimer=null;
        const loaded=[...contexts.values()].filter(c=>current(c)&&(c.store||c.checkpoint?.payload));
        const idle=loaded.filter(c=>!c.users&&!c.io&&!c.flight&&!c.assetsFlight&&!c.opening&&!c.projectionTimer);
        idle.sort((a,b)=>b.lastUsed-a.lastUsed);
        // In-flight operations own their replicas. At rest only the most
        // recently used project keeps a materialized copy of its full history.
        // A proof-only read has no running replica notification/reconcile
        // loop. Return it to parked notifications instead of retaining it.
        const keep=loaded.length===idle.length?idle.find(c=>c.started):null;
        for(const c of idle)if(c!==keep)park(c);
      },0);trimTimer?.unref?.();
    }
    function notifyFileJournal(c){
      try{
        if(!c.fileJournalDirty||c.assetsFlight||c.photoPauses||!current(c)||root.SentlogCapacity?.isCleared(c.cp.id))return;
        // Only completed mirror writes request work. Existing ACKs must not
        // trigger metadata -> photo audit -> ACK -> metadata feedback loops.
        c.fileJournalDirty=false;
        onFileJournaled({localProjectId:c.localProjectId});
      }
      catch{c.fileJournalDirty=true;} // An observer cannot undo saved bytes or replace a transfer error.
    }
    function closeContext(c){
      if(c.closed)return;c.closed=true;clearTimeout(c.projectionTimer);clearTimeout(c.parkTimer);
      try{c.parkNotice?.();}catch{}c.parkNotice=null;
      for(const name of [...heavy,'transport']){try{c[name]?.close?.();}catch{}c[name]=null;}
      c.assetExpectedRaw=null;c.checkpoint=null;c.snapshotToken=null;
    }
    function reset(){clearTimeout(trimTimer);trimTimer=null;for(const c of contexts.values())closeContext(c);contexts.clear();root.SentlogDeltaMetadataUI?.clear();}
    const unsubscribe=subscribeAuth(reset);
    async function binding(c){
      const journal=records.deltaJournal;
      const found=typeof journal.readBindingState==='function'?await journal.readBindingState(c.localProjectId):
        (await journal.listBindings()).find(x=>x.localProjectId===c.localProjectId);check(c);
      if(found)insist(same(found.scope,c.scope),'DELTA_APP_BINDING','別のログイン先の未送信変更があります。元の保存先に保持しています');
      return found||null;
    }
    function projectSoon(c){
      if(!c.controller||c.projectionTimer||!current(c))return;
      c.projectionTimer=setTimeout(async()=>{
        c.projectionTimer=null;if(!current(c))return;
        const release=retain(c);
        try{const result=await c.controller.project();check(c);
          if(result?.deferred&&!result?.detached)projectSoon(c);
        }catch(error){if(current(c))report(c,{level:'pending',message:error.message,code:error.code});}
        finally{release();}
      },250);c.projectionTimer?.unref?.();
    }
    async function context(cp){
      insist(!closed&&cp?.id&&cp?.client_key,'DELTA_APP_PROJECT','同期する案件を確認できません');
      const scope={ownerId:session()?.user?.id,projectId:cp.id,deviceId:deviceId()};
      insist(SCOPE.every(k=>typeof scope[k]==='string'&&scope[k]),'DELTA_APP_SCOPE','ログイン・案件・端末の準備が必要です');
      let c=contexts.get(cp.client_key);
      if(c&&(!same(c.scope,scope)||!current(c))){closeContext(c);contexts.delete(cp.client_key);c=null;}
      if(c){c.cp=copy(cp);return c;}
      c={scope,localProjectId:cp.client_key,cp:copy(cp),authGeneration:authGeneration(),closed:false,
        snapshotToken:null,mode:null,flight:null,assetsFlight:null,fileJournalDirty:false,photoGeneration:0,photoPauses:0,checkpoint:null,lastCheckpointAt:0,projectionTimer:null,
        users:0,io:0,lastUsed:++usage,parked:false,parkTimer:null,parkNotice:null,backgroundQueued:false,opening:null,starting:null,started:false,cursor:0};
      const provider=make.provider({url,key,session,refreshSession:ensureSession,subscribeAuth,fetch:fetcher});
      c.transport=tracked(c,make.transport({provider,scope,currentScope:()=>current(c),online:network}),['push','pushGroup','list']);
      contexts.set(cp.client_key,c);return c;
    }
    async function inspect(cp,options){
      const c=await context(cp);return using(c,async()=>{
      const local=await binding(c);
      try{c.mode=await c.transport.inspect(options);check(c);}
      catch(error){
        // Before the server migration is installed, only an explicit missing
        // RPC permits the old writer. A bound project never falls back.
        const missingInspect=error?.code==='PGRST202'&&Number(error?.status)===404||
          error?.code==='DELTA_UPGRADE_REQUIRED'&&error.sqlState==='PGRST202'&&error.httpStatus===404;
        if(!local&&missingInspect)return {enabled:false,canActivate:false,serverInstalled:false};
        throw error;
      }
      insist(!local||!['active','detached'].includes(local.phase)||c.mode.enabled,'DELTA_APP_DOWNGRADE','切替済み案件の旧保存へ戻すことはできません。変更を保持しています');
      return copy(c.mode);
      });
    }
    function assertConfirmable(c,local){
      insist(local?.phase==='active'&&c.mode?.enabled===true,'DELTA_APP_CONFIRM_PENDING',
        '保存方式の切替を確認しています。変更は実行していません。切替が完了してから、もう一度確認してください');
    }
    async function open(c,options={}){
      // A network caller joining a local proof read must still perform its own
      // normal authentication/capability checks after initialization completes.
      if(c.opening){await c.opening;check(c);return open(c,options);}
      let opened;const opening=openInner(c,options);c.opening=opening;
      try{opened=await opening;}finally{if(c.opening===opening)c.opening=null;}
      check(c);
      if(opened&&!options.localOnly&&!c.started){
        const task=c.starting||c.replica.start();c.starting=task;
        try{await task;check(c);c.started=true;}finally{if(c.starting===task)c.starting=null;}
      }
      return opened;
    }
    async function openInner(c,{activate=false,revision,confirmation=false,localOnly=false}={}){
      check(c);let local=await binding(c);
      if(localOnly)insist(local?.phase==='active'&&c.mode?.enabled===true,'DELTA_APP_CHANGED','確認中に案件の保存先が変わりました');
      if(confirmation)assertConfirmable(c,local);
      if(local?.phase==='detached')return null;
      if(!c.mode||activate||local?.phase==='staging')c.mode=await c.transport.inspect();check(c);
      if(!c.mode.enabled&&!activate)return null;
      insist(c.mode.enabled||c.mode.canActivate,'DELTA_APP_ACTIVATION','この案件の切替準備を確認できません');
      if(!c.store)c.store=tracked(c,make.store(c.scope),['read','readForVerification','write','readProvenance','installBaseline']);
      c.parked=false;clearTimeout(c.parkTimer);c.parkTimer=null;
      if(!localOnly){
        await c.transport.ready();check(c);
        const capabilities=c.transport.getCapabilities();
        insist(capabilities.sharedMetadata===true&&capabilities.certifiedArchive===true&&capabilities.writerJournal===2,
          'DELTA_APP_UPGRADE','図面設定・保存履歴・PC保管に対応する共有先が必要です');
      }
      if(local?.phase!=='active'){
        await install({scope:copy(c.scope),localProjectId:c.localProjectId,transport:c.transport,
          store:c.store,mode:copy(c.mode),revision:c.mode.snapshotRevision??revision??local?.serverRevision??local?.cutoff?.serverRevision,currentScope:()=>current(c),actor:actor()});check(c);
        local=await binding(c);c.mode=await c.transport.inspect();check(c);
      }
      insist(local?.phase==='active'&&c.mode.enabled,'DELTA_APP_INSTALL','案件の保存先の切替を確認できません');
      if(c.controller)return c;
      const saved=await c.store.read(),provenance=await c.store.readProvenance();check(c);
      insist(saved&&provenance&&provenance.baseline?.baselineId===local.baselineId&&same(saved.scope,c.scope),
        'DELTA_APP_LOCAL_STATE','引継ぎ済みの差分保存を確認できません。端末の元記録を保持しています');
      c.replica=make.replica({...c.scope,store:c.store,transport:c.transport,visible,
        onStatus:status=>{
          if(!current(c))return;const changed=c.snapshotToken!==status.snapshotToken;c.snapshotToken=status.snapshotToken;
          if(Number.isSafeInteger(status.cursor))c.cursor=status.cursor;
          report(c,status);if(changed)projectSoon(c);
        }});
      c.bridge=make.bridge({replica:c.replica,scope:c.scope,localProjectId:c.localProjectId,currentScope:()=>current(c)});
      const createController=factories.controller||J().createController;
      c.controller=createController({records,scope:c.scope,localProjectId:c.localProjectId,
        replica:c.replica,replicaStore:c.store,bridge:c.bridge,metadata:M(),currentScope:()=>current(c),
        actor:actor(),onStatus:status=>report(c,status),
        canProject:()=>{check(c);return canProject(c.cp)!==false;},
        applyProjection:(projection,options)=>{check(c);return applyProjection(c.cp,projection,{...options,scope:c.scope,
          validate:()=>{check(c);return options.validate()===true;}});}});
      const s=await c.replica.snapshotWithStatus();check(c);c.snapshotToken=s.snapshotToken;
      return c;
    }
    async function sync(cp,options={}){
      const c=await context(cp);return using(c,async()=>{
      if(options.confirmation){
        if(!c.mode)await inspect(cp);check(c);assertConfirmable(c,await binding(c));
        // An older round may already have read the server before the user
        // opened this decision. Complete it, then make a new scoped receive.
        while(c.flight){await c.flight;check(c);}
      }
      if(c.flight)return c.flight;
      const task=(async()=>{
        if(!c.mode)await inspect(cp);check(c);
        const local=await binding(c);check(c);
        if(options.confirmation)assertConfirmable(c,local);
        if(!c.mode?.enabled&&!options.activate&&!local)return {enabled:false};
        const opened=await open(c,{...options,activate:!options.confirmation&&(options.activate===true||local?.phase==='staging')});check(c);
        if(!opened)return {enabled:true,detached:true,deferred:false,pending:0,revision:c.mode.snapshotRevision??c.mode.baseline.snapshotRevision};
        await c.controller.drain();check(c);const received=await c.replica.sync();check(c);
        if(options.confirmation)insist(received?.offline!==true&&network()&&visible(),'DELTA_APP_CONFIRM_OFFLINE','通信が途切れたため最新の記録を確認できません。変更は実行していません');
        const projectedToken=c.snapshotToken,applied=await c.controller.project();check(c);
        const status=await c.replica.snapshotWithStatus();check(c);
        if(!applied?.deferred&&projectedToken===status.snapshotToken){clearTimeout(c.projectionTimer);c.projectionTimer=null;}
        c.snapshotToken=status.snapshotToken;c.cursor=status.snapshot.cursor;
        const pending=status.snapshot.outbox.length+(status.snapshot.blockedOutbox?.length||0);
        return {enabled:true,...(options.confirmation?{fresh:true}:{}),pending,cursor:status.snapshot.cursor,applied:applied?.applied===true,
          deferred:applied?.deferred===true||pending>0,revision:c.mode.snapshotRevision??c.checkpoint?.revision??c.mode.baseline.snapshotRevision};
      })();c.flight=task;try{return await task;}finally{if(c.flight===task)c.flight=null;}
      });
    }
    async function photos(cp){
      const c=await context(cp);return using(c,async()=>{
      if(c.photoPauses||root.SentlogCapacity?.isCleared(cp.id))return {enabled:true,skipped:true,complete:true,issues:[],message:'容量整理した写真はPCからの復旧時に取得します'};
      if(c.assetsFlight)return c.assetsFlight;
      const epoch=c.photoGeneration,currentPhotos=()=>!c.photoPauses&&epoch===c.photoGeneration&&!root.SentlogCapacity?.isCleared(cp.id)?current(c):null;
      const checkPhotos=()=>{check(c);insist(currentPhotos(),'DELTA_PHOTOS_PAUSED','容量整理のため写真の同期を停止しています');};
      const task=(async()=>{
       // A concurrent journal projection can invalidate an otherwise healthy
       // photo batch. Reconcile the new records while retaining this exact
       // authentication/cleanup lease; never reuse the cancelled snapshot.
       for(let attempt=0;attempt<3;attempt++){
        checkPhotos();
        try{
        const result=await sync(cp);checkPhotos();if(result.detached)return {enabled:true,detached:true,skipped:true,complete:true,issues:[],message:'端末から外した案件の写真は取得しません'};
        insist(c.controller,'DELTA_APP_INSTALL','写真の同期前に記録の切替が必要です');
        if(!c.assets){
          const fileOwners=new Map();
          c.assetStore=make.assetStore(c.scope);
          c.assetTransport=make.assetTransport({url,key,scope:c.scope,localProjectId:c.localProjectId,session,ensureSession,
            subscribeAuth,authGeneration,currentScope:currentPhotos,fetch:fetcher,network});
          c.assets=make.assets({scope:c.scope,store:c.assetStore,transport:c.assetTransport,currentScope:currentPhotos,
            // A cleared device can restore shared bytes only after the explicit
            // restore flow removes its marker. currentPhotos also fences a
            // new cleanup or identity change while any request is in flight.
            allowArchivedRestore:true,
            currentSnapshotToken:()=>c.assetExpectedRaw?.every(([key,value])=>records.getItem(key)===value)?c.snapshotToken:null,
            authGeneration,subscribeAuth,onPhotoReceived,
            localFiles:{read:readFile,async write(key,blob,opts){
                const saved=await records.writeFile(key,blob,{...opts,ownerToken:fileOwners.get(key)});
                if(saved?.written===true)c.fileJournalDirty=true;
                return saved;
              },
              withLock:(key,fn)=>withFileLock(key,async()=>{const token={};fileOwners.set(key,token);
                try{return await fn();}finally{if(fileOwners.get(key)===token)fileOwners.delete(key);}}),
              getCapabilities:()=>records.getFileWriteCapabilities(),
              assertExclusive:key=>{checkPhotos();const s=records.writerState(key,{ownerToken:fileOwners.get(key)});
                return s?.exclusive===true&&!s.foreignPending&&!s.failed&&s.journaled===true;}}});
        }
        const currentState=await c.replica.snapshotWithStatus();checkPhotos();c.snapshotToken=currentState.snapshotToken;
        c.assetExpectedRaw=B.captureProject({records,localProjectId:c.localProjectId}).rawEntries;
        const synced=await c.assets.sync(currentState);checkPhotos();return synced;
        }catch(error){
          if(error?.code!=='ASSET_SNAPSHOT_CHANGED'||attempt===2)throw error;
          checkPhotos();
        }
       }
      })();c.assetsFlight=task;try{return await task;}finally{
        if(c.assetsFlight===task){c.assetsFlight=null;notifyFileJournal(c);}
      }
      });
    }
    async function suspendPhotos(cp){
      const c=await context(cp);return using(c,async()=>{
      check(c);if(++c.photoPauses===1)c.photoGeneration++;
      const epoch=c.photoGeneration;
      for(const name of ['assets','assetTransport','assetStore'])try{c[name]?.close?.();}catch{}
      try{if(c.assetsFlight)await c.assetsFlight.catch(()=>{});check(c);}
      catch(error){c.photoPauses--;throw error;}
      finally{c.assets=null;c.assetTransport=null;c.assetStore=null;}
      let released=false;
      const resume=()=>{if(released)return;released=true;c.photoPauses=Math.max(0,c.photoPauses-1);notifyFileJournal(c);};
      resume.validate=()=>{check(c);insist(!released&&c.photoPauses>0&&c.photoGeneration===epoch,
        'DELTA_PHOTOS_LEASE','容量整理の確認状態が変わりました。記録を保持して中止します');return true;};
      return resume;
      });
    }
    async function checkpoint(cp,{force=false}={}){
      const c=await context(cp);return using(c,async()=>{
      // An archived project's certified snapshot remains readable, but a new
      // publication is a mutation and must wait for explicit reopening.
      if(cp.status==='archived'){await inspect(cp);check(c);return null;}
      const result=await sync(cp);check(c);
      if(!result.enabled)return null;
      if(result.detached){
        // Removing a local cache does not prevent the server from publishing
        // its independently verified current projection for the company PC.
        c.mode=await c.transport.inspect();check(c);
        insist(c.mode.enabled,'DELTA_APP_DOWNGRADE','共有先の差分保存を確認できません');
        const certificate=await c.transport.publishCheckpoint(c.mode.headSeq,root.crypto.randomUUID());check(c);
        c.checkpoint=copy(certificate);c.lastCheckpointAt=Date.now();return copy(certificate);
      }
      insist(!result.pending&&!result.deferred,'DELTA_APP_PENDING','端末の変更を保存・共有してからPC保管用の記録を作成します');
      const s=await c.replica.snapshotWithStatus();check(c);
      if(c.checkpoint?.headSeq===s.snapshot.cursor&&c.checkpoint.payload&&!force)return copy(c.checkpoint);
      const requestId=c.checkpoint?.headSeq===s.snapshot.cursor&&c.checkpoint.requestId||root.crypto.randomUUID();
      const certificate=await c.transport.publishCheckpoint(s.snapshot.cursor,requestId);check(c);
      const after=await c.replica.snapshotWithStatus();check(c);
      insist(after.snapshotToken===s.snapshotToken,'DELTA_APP_CHANGED','確認中に記録が更新されました。最新の内容で再確認します');
      c.checkpoint=copy(certificate);c.lastCheckpointAt=Date.now();return copy(certificate);
      });
    }
    async function archiveProof(cp,job,{restorationProof}={}){
      const c=await context(cp);return using(c,async()=>{
      const certificate=job?.delta_checkpoint;
      insist(certificate?.schema===1&&certificate.projectId===cp.id&&certificate.revision===job.revision&&
        Number.isSafeInteger(certificate.headSeq)&&/^[a-f0-9]{64}$/.test(certificate.payloadSha256||''),
        'DELTA_ARCHIVE_CERTIFICATE','PC保管の対象となる記録の版を確認できません');
      const raw=()=>records.getItem('surveyFieldNoteWorkspaceV1'),hasLocal=()=>JSON.parse(raw()||'{"projects":[]}').projects.some(p=>p.id===cp.client_key);
      const absent=()=>{const local=records.deltaJournal.bindingFor(cp.client_key);
        return !hasLocal()&&(!local||(local.phase==='detached'&&same(local.scope,c.scope)))&&
          [...(job.payload.drawings||[]),...(job.payload.project.deltaMetadata?.retainedDrawings||[])].every(d=>
            records.getItem('surveyFieldNoteDrawingV1:'+d.meta.id)===null);};
      async function checkAbsent(){
        check(c);insist(absent(),'DELTA_APP_CHANGED','確認中に端末の記録が変更されました');
        if(records.deltaJournal.bindingFor(cp.client_key)){
          const pending=await records.deltaJournal.pending({scope:c.scope,localProjectId:c.localProjectId});check(c);
          insist(pending.detached&&!pending.claimId,'DELTA_ARCHIVE_PENDING','端末から外した案件に未共有の変更があります。入力を保持しています');
          if(!restorationProof)insist(!pending.count,'DELTA_ARCHIVE_PENDING','端末から外した案件に未共有の変更があります。入力を保持しています');
        }
        if(restorationProof){
          insist(typeof records.deltaJournal.validateArchiveRestore==='function','DELTA_ARCHIVE_PENDING','PC復旧の照合機能を確認できません');
          await records.deltaJournal.validateArchiveRestore(restorationProof,{scope:c.scope,localProjectId:c.localProjectId,
            certificate,jobId:job.id});check(c);
        }
        insist(absent(),'DELTA_APP_CHANGED','確認中に端末の記録が変更されました');
      }
      const proof={schema:1,headSeq:certificate.headSeq,cursor:certificate.headSeq,pending:0,
        revision:certificate.revision,payloadSha256:certificate.payloadSha256};
      if(absent()){await checkAbsent();return {...proof,absent:true,cursor:null,validate:async()=>{
        check(c);await records.settled();records.assertSafe();check(c);
        await checkAbsent();return true;
      }};}
      await open(c);check(c);
      insist(c.controller,'DELTA_APP_INSTALL','この案件の記録を受信してから保管を確認してください');
      await c.controller.drain();check(c);await c.replica.sync();check(c);
      const projection=await c.controller.project();check(c);
      insist(!projection?.deferred,'DELTA_APP_PENDING','未反映の記録があります。図面を閉じてから再確認してください');
      let s=await c.replica.snapshotWithStatus();
      const wal=await records.deltaJournal.pending({scope:c.scope,localProjectId:c.localProjectId});check(c);
      c.snapshotToken=s.snapshotToken;
      insist(certificate&&certificate.headSeq===s.snapshot.cursor&&!s.snapshot.outbox.length&&
        !(s.snapshot.blockedOutbox?.length)&&!wal.count&&!wal.claimId,
        'DELTA_ARCHIVE_PENDING','この端末の未送信・未受信の変更を確認できません。記録を保持しています');
      const expected=B.captureProject({records,localProjectId:c.localProjectId}).rawEntries;
      const files=(job.manifest||[]).map(f=>[f.key,records.writerState(f.key).generation]);
      const expectedToken=s.snapshotToken,expectedDigest=await snapshotDigest(s.snapshot);s=null;check(c);
      return {...proof,validate:()=>using(c,async()=>{
        check(c);await records.settled();records.assertSafe();check(c);
        // A previously issued proof is a local read: parking must not turn
        // its validation into a new network/activation requirement.
        await open(c,{localOnly:true});check(c);
        const pending=await records.deltaJournal.pending({scope:c.scope,localProjectId:c.localProjectId});check(c);
        const latest=await c.replica.snapshotWithStatus();check(c);
        const unchanged=latest.snapshotToken===expectedToken||await snapshotDigest(latest.snapshot)===expectedDigest;check(c);
        insist(unchanged&&c.replica.isSnapshotCurrent(latest.snapshotToken)&&!pending.count&&!pending.claimId&&
          expected.every(([key,value])=>records.getItem(key)===value)&&
          files.every(([key,generation])=>{const state=records.writerState(key);return state.generation===generation&&!state.pending&&!state.failed;}),
          'DELTA_APP_CHANGED','確認中に記録または写真が変わりました。最新の内容で再確認します');return true;
      })};
      });
    }
    async function resolveMetadata(cp,options){
      const c=await context(cp);return using(c,async()=>{
      await sync(cp);check(c);
      insist(c.controller,'DELTA_APP_INSTALL','図面設定の保存先を確認できません');
      const before=await c.replica.snapshotWithStatus();check(c);const operationId=root.crypto.randomUUID();
      const document=before.snapshot.records[D.keyOf('@sentlog:metadata:v1',options.recordId)];
      insist(document&&C.equal(document.collab,options.expectedDocument),'DELTA_METADATA_STALE',
        '確認中に図面設定が更新されました。最新の候補を確認してください');
      const resolver=options.kind==='metadata-membership'?M().resolveMembership:M().resolve;
      insist(typeof resolver==='function','DELTA_METADATA_RESOLUTION','設定の確認処理を読み込めません');
      const resolved=await resolver({...options,records:before.snapshot.records,actor:actor(),operationId});check(c);
      if(resolved.changes.length)await c.replica.changeGroup({changes:resolved.changes,groupId:operationId,expectedSnapshotToken:before.snapshotToken});
      check(c);await c.controller.project();check(c);return {saved:true};
      });
    }
    return {inspect,sync,photos,suspendPhotos,checkpoint,archiveProof,resolveMetadata,
      isActive:id=>contexts.get(id)?.mode?.enabled===true,
      wake(){for(const c of contexts.values())if(current(c)){c.transport.wake();
        if(c.parked)queueParked(c);else{c.replica?.onOnline();projectSoon(c);}}},
      reset,close(){if(closed)return;reset();closed=true;unsubscribe?.();}};
  }
  const api={version:1,createRuntime};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaAppRuntime=api;
})(typeof window!=='undefined'?window:globalThis);

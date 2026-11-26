/* Startup-only, add-only recovery. No app, authentication or synchronization
 * module is imported. A missing META keeps both old and current startup guards
 * closed until durable records and every included Blob have been verified. */
(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.SentlogStartupBackupRecovery=api;api.mount(root.document);}
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';
  const FORMAT=root.SentlogBackupFormat||(typeof module==='object'&&module.exports?require('./backup-format.js'):null);
  const HASH=root.SentlogBlobSha256||(typeof module==='object'&&module.exports?require('./blob-sha256.js'):null);
  const DB='surveyFieldNoteDB',FILES='files',JOURNAL='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
  const PREFIX='__sentlog_record__:',META='__sentlog_records_meta_v130__',ARCHIVE='__sentlog_records_archive_v130__';
  const MARKER='sentlogRecordsReadyV130',INTENT='startup-backup-recovery:v1',LOCK='sentlog-record-writer-v130';
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
  const index=keyPath=>({keyPath,unique:false,multiEntry:false});
  const store=(keyPath=null,indexes={})=>({keyPath,autoIncrement:false,indexes});
  const SPECS=[
    {name:DB,version:2,stores:{[FILES]:store(),[JOURNAL]:store(null,{kind:index('kind')}),[CONTROL]:store(null,{kind:index('kind')})}},
    {name:'sentlog-original-photos-v1',version:1,stores:{photos:store(),meta:store('key',{createdAt:index('createdAt'),exportedAt:index('exportedAt'),projectId:index('projectId')})}},
    {name:'sentlog-delta-migration-v1',version:1,stores:{sessions:store(),items:store()}},
    {name:'sentlog-delta-assets-v1',version:1,stores:{assets:store()}},
    {name:'sentlog-delta-v1',version:1,stores:{replicas:store()}},
    {name:'sentlogSyncTrafficV1',version:1,stores:{acks:store()}},
    {name:'sentlog-pc-sync',version:1,stores:{kv:store()}}
  ];
  const TEXT={
    UNAVAILABLE:'このブラウザでは、安全な復旧に必要な保存機能を確認できません。',
    LOCK_UNAVAILABLE:'ほかのセントログ画面が保存先を使用しています。本体・PC自動同期の画面を閉じてから確認してください。',
    TABS_REQUIRED:'ほかのセントログ本体・PC自動同期画面を閉じたことを確認してください。',
    BACKUP_INVALID:'バックアップの形式・添付データを確認できません。',
    BACKUP_INCOMPLETE:'図面の記録が不足しているため、この画面では復旧できません。元の控えを保持してください。',
    BACKUP_MISMATCH:'添付ファイルと写真の記録の内容が一致しません。',
    OTHER_BACKUP:'別のバックアップによる復旧途中、または識別できない記録が残っています。上書きしません。',
    LEGACY_PRESENT:'以前の形式の端末内記録が残っています。この画面では変更しません。',
    MARKER:'過去の利用状態を確認できません。この画面では保存先を作り直しません。',
    DATABASE_MISSING:'対象の保存領域がありません。この画面では保存領域の作成・更新を行いません。',
    SCHEMA:'保存領域の形式が対応するものと異なります。変更せず停止しました。',
    RESIDUAL:'保存領域にデータが残っています。既存データを上書きしません。',
    OTHER_DATA:'別のセントログ保存領域にデータが残っています。変更せず確認を止めました。',
    OTHER_DATABASE:'ほかの保存領域があるため自動復旧を停止しました。その保存領域は開かず、変更していません。',
    CHANGED:'確認中に保存領域または以前の記録が変わりました。続行しません。',
    OPEN_BLOCKED:'ほかの画面が保存領域を使用しているため確認できません。',
    INVALID_RESPONSE:'保存領域から正しい確認結果を取得できませんでした。',
    VERIFY_FAILED:'保存内容がバックアップと一致しません。通常起動を有効にせず停止しました。',
    REQUEST_TIMEOUT:'保存先からの応答を確認できませんでした。',
    TIME_LIMIT:'確認に使える時間を超えたため停止しました。',
    CANCELLED:'処理を中断しました。',
    STORAGE_FAILED:'端末への保存または照合を完了できませんでした。',
    PLAN:'バックアップを選び直して内容を確認してください。',
    BUSY:'確認または復旧の処理中です。'
  };
  const NAMES=new Set(['AbortError','ConstraintError','DataCloneError','DataError','InvalidStateError','NotFoundError','NotReadableError',
    'QuotaExceededError','ReadOnlyError','SecurityError','TimeoutError','TransactionInactiveError','UnknownError','VersionError','TypeError','Error']);
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const sorted=values=>[...values].sort();
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const fail=(code,cause)=>Object.assign(new Error(TEXT[code]||TEXT.STORAGE_FAILED),{code,errorName:NAMES.has(cause?.name)?cause.name:'Error'});
  const insist=(condition,code)=>{if(!condition)throw fail(code);};
  const managed=key=>key===WS||key==='surveyFieldNoteV2'||key==='sentlogArchiveLocalV1'||
    ['surveyFieldNoteDrawingV1:','sentlogCloudProjectSyncV2:','sentlogReplaceBackupV1:','sentlogSyncMergeCheckpointV1:'].some(p=>key.startsWith(p));
  const fileIdentity=value=>({size:value.size,type:value.type,name:typeof value.name==='string'?value.name:null,
    lastModified:Number.isFinite(value.lastModified)?value.lastModified:null});
  function publicError(error,persistence='none'){
    const code=own(TEXT,error?.code)?error.code:'STORAGE_FAILED';
    return {code,message:TEXT[code],errorName:NAMES.has(error?.errorName)?error.errorName:NAMES.has(error?.name)?error.name:'Error',persistence};
  }

  function create(options={}){
    const factory=own(options,'indexedDB')?options.indexedDB:root.indexedDB;
    const local=own(options,'localStorage')?options.localStorage:root.localStorage;
    const locks=own(options,'locks')?options.locks:root.navigator?.locks;
    const BlobClass=options.Blob||root.Blob,FileClass=options.File||root.File;
    const format=options.format||FORMAT,hashBlob=options.hashBlob||((blob,args)=>HASH.digest(blob,args));
    const finite=(n,d)=>Number.isFinite(n)&&n>0?Math.floor(n):d;
    const requestMs=finite(options.requestTimeoutMs,5000),operationMs=finite(options.operationTimeoutMs,120000),verifyMs=finite(options.verifyTimeoutMs,60000);
    const plans=new WeakMap();let busy=false;
    function emit(phase,detail={}){try{options.onProgress?.({phase,...detail});}catch{}}
    function context(signal){
      const deadline=Date.now()+operationMs,waiting=new Set(),connections=new Set();let reason=null,closed=false;
      const ctx={persistence:'none',connections,
        check(){if(reason)throw reason;if(closed)throw fail('CANCELLED');if(signal?.aborted)throw fail('CANCELLED');if(Date.now()>=deadline)throw fail('TIME_LIMIT');},
        stop(error){if(!reason)reason=error;for(const cancel of [...waiting])cancel(reason);},
        wait(start,limit=requestMs){return new Promise((resolve,reject)=>{
          let ended=false,cleanup=()=>{},timer;
          const done=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);waiting.delete(cancel);error?reject(error):resolve(value);};
          const cancel=error=>{if(ended)return;try{cleanup();}catch{}done(error||fail('CANCELLED'));};
          waiting.add(cancel);
          try{ctx.check();const remaining=deadline-Date.now(),code=remaining<=limit?'TIME_LIMIT':'REQUEST_TIMEOUT';
            timer=setTimeout(()=>cancel(fail(code)),Math.max(1,Math.min(limit,remaining)));
            cleanup=start(done,()=>ended)||cleanup;
          }catch(error){try{cleanup();}catch{}done(error);}
        });},
        async hash(blob){
          return ctx.wait(done=>{const controller=new AbortController();
            Promise.resolve().then(()=>{ctx.check();return hashBlob(blob,{signal:controller.signal,validate:()=>ctx.check()});})
              .then(value=>{try{ctx.check();insist(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),'INVALID_RESPONSE');done(null,value);}catch(e){done(e);}},done);
            return ()=>controller.abort();
          },verifyMs);
        },
        finish(){closed=true;signal?.removeEventListener?.('abort',abort);for(const cancel of [...waiting])cancel(fail('CANCELLED'));
          for(const db of connections)try{db.close();}catch{}connections.clear();}
      };
      const abort=()=>ctx.stop(fail('CANCELLED'));signal?.addEventListener?.('abort',abort,{once:true});return ctx;
    }
    async function operation(signal,fn){
      insist(!busy,'BUSY');busy=true;const ctx=context(signal);
      try{return await fn(ctx);}catch(error){const info=publicError(error,ctx.persistence);throw Object.assign(fail(info.code,error),info);}
      finally{ctx.finish();busy=false;}
    }
    async function exclusive(ctx,fn){
      insist(typeof locks?.request==='function','UNAVAILABLE');
      return ctx.wait(done=>{Promise.resolve().then(()=>locks.request(LOCK,{mode:'exclusive',ifAvailable:true},async lock=>{
        ctx.check();insist(!!lock,'LOCK_UNAVAILABLE');return fn();
      })).then(value=>done(null,value),done);},operationMs);
    }
    function legacy(){
      insist(local&&typeof local.getItem==='function'&&typeof local.key==='function','UNAVAILABLE');
      const marker=local.getItem(MARKER);insist(marker==='1','MARKER');
      const length=local.length;insist(Number.isSafeInteger(length)&&length>=0,'INVALID_RESPONSE');
      for(let i=0;i<length;i++){const key=local.key(i);insist(typeof key==='string','CHANGED');if(managed(key))throw fail('LEGACY_PRESENT');}
      insist(local.length===length&&local.getItem(MARKER)===marker,'CHANGED');return marker;
    }
    async function inventory(ctx){
      insist(typeof factory?.databases==='function'&&typeof factory?.open==='function','UNAVAILABLE');
      const rows=await ctx.wait(done=>{Promise.resolve().then(()=>factory.databases()).then(v=>done(null,v),done);});
      insist(Array.isArray(rows),'INVALID_RESPONSE');const seen=new Set(),found=new Map();
      for(const row of rows){
        insist(typeof row?.name==='string'&&!!row.name&&!seen.has(row.name),'INVALID_RESPONSE');seen.add(row.name);
        const spec=SPECS.find(s=>s.name===row.name);
        if(!spec)throw fail('OTHER_DATABASE');
        insist(row.version===spec.version,'SCHEMA');found.set(row.name,row.version);
      }
      insist(found.has(DB),'DATABASE_MISSING');return found;
    }
    function open(ctx,spec,listed){
      insist(listed.get(spec.name)===spec.version,'CHANGED');
      return ctx.wait((done,ended)=>{
        let upgrade=false,q;try{q=factory.open(spec.name);}catch(e){done(e);return;}
        q.onupgradeneeded=()=>{upgrade=true;try{q.transaction.abort();}catch{}};
        q.onerror=()=>done(upgrade?fail('CHANGED'):q.error);
        q.onblocked=()=>done(fail('OPEN_BLOCKED'));
        q.onsuccess=()=>{
          const db=q.result;
          if(ended()||upgrade){db.close();return;}
          try{ctx.check();insist(db.version===spec.version,'SCHEMA');}
          catch(e){db.close();done(e);return;}
          ctx.connections.add(db);db.onversionchange=()=>{ctx.stop(fail('CHANGED'));db.close();ctx.connections.delete(db);};done(null,db);
        };
        return ()=>{if(q.readyState==='done')try{q.result.close();}catch{}};
      });
    }
    function close(ctx,db){db.close();ctx.connections.delete(db);}
    function schema(db,tx,spec){
      insist(db.version===spec.version&&same(sorted(db.objectStoreNames),sorted(Object.keys(spec.stores))),'SCHEMA');
      for(const [name,want]of Object.entries(spec.stores)){
        const s=tx.objectStore(name);insist(same(s.keyPath,want.keyPath)&&s.autoIncrement===want.autoIncrement&&
          same(sorted(s.indexNames),sorted(Object.keys(want.indexes))),'SCHEMA');
        for(const [name,v]of Object.entries(want.indexes)){const ix=s.index(name);insist(same(ix.keyPath,v.keyPath)&&ix.unique===v.unique&&ix.multiEntry===v.multiEntry,'SCHEMA');}
      }
    }
    function transaction(db,mode){
      const names=Object.keys(SPECS[0].stores);
      insist(same(sorted(db.objectStoreNames),sorted(names)),'SCHEMA');
      if(mode==='readonly')return db.transaction(names,mode);
      try{return db.transaction(names,mode,{durability:'strict'});}catch(e){if(e?.name==='TypeError')return db.transaction(names,mode);throw e;}
    }
    function readCounts(ctx,db,spec,records=false){
      return ctx.wait(done=>{
        let tx,firstError=null,counts={},intent,metaCount;
        try{insist(same(sorted(db.objectStoreNames),sorted(Object.keys(spec.stores))),'SCHEMA');
          tx=db.transaction(Object.keys(spec.stores),'readonly');schema(db,tx,spec);
          tx.oncomplete=()=>{try{ctx.check();insist(Object.values(counts).length===Object.keys(spec.stores).length&&
            Object.values(counts).every(n=>Number.isSafeInteger(n)&&n>=0),'INVALID_RESPONSE');
            if(records)insist(metaCount===0||metaCount===1,'INVALID_RESPONSE');done(firstError,{counts,intent,metaCount});}catch(e){done(e);}};
          tx.onabort=()=>done(firstError||tx.error||fail('STORAGE_FAILED'));tx.onerror=()=>{};
          const observe=q=>{q.onerror=()=>{if(!firstError||firstError.name==='AbortError')firstError=q.error;};return q;};
          for(const name of Object.keys(spec.stores))observe(tx.objectStore(name).count()).onsuccess=e=>{counts[name]=e.target.result;};
          if(records){observe(tx.objectStore(CONTROL).get(INTENT)).onsuccess=e=>{intent=e.target.result;};
            observe(tx.objectStore(FILES).count(META)).onsuccess=e=>{metaCount=e.target.result;};}
        }catch(e){try{tx?.abort();}catch{}done(e);}
        return ()=>{try{tx?.abort();}catch{}};
      });
    }
    async function otherScope(ctx){
      legacy();const listed=await inventory(ctx),signature=[];
      for(const spec of SPECS.slice(1)){
        ctx.check();if(!listed.has(spec.name)){signature.push(false);continue;}
        const db=await open(ctx,spec,listed);
        try{const row=await readCounts(ctx,db,spec);insist(Object.values(row.counts).every(n=>n===0),'OTHER_DATA');signature.push(true);}
        finally{close(ctx,db);}
      }
      legacy();return {listed,signature:JSON.stringify(signature)};
    }
    function planOf(publicPlan){const plan=plans.get(publicPlan);insist(!!plan,'PLAN');return plan;}
    function intentFor(plan,startedAt){return {kind:'startup-backup-recovery',version:1,backupSha256:plan.backupSha256,
      planSha256:plan.planSha256,startedAt,recordCount:plan.records.size,fileCount:plan.files.length,fileBytes:plan.summary.includedBytes};}
    function validIntent(plan,intent){return object(intent)&&typeof intent.startedAt==='string'&&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(intent.startedAt)&&same(intent,intentFor(plan,intent.startedAt));}
    const archiveFor=intent=>({migratedAt:intent.startedAt,entries:[]});
    const metaFor=intent=>({schema:1,revision:0,migratedAt:intent.startedAt,legacyCount:0,restoredAt:intent.startedAt,
      startupRecovery:{version:1,backupSha256:intent.backupSha256}});
    function modeFor(plan,state){
      if(Object.values(state.counts).every(n=>n===0))return 'empty';
      insist(validIntent(plan,state.intent),'OTHER_BACKUP');
      insist(state.counts[JOURNAL]===0&&state.counts[CONTROL]===1&&
        state.counts[FILES]===plan.records.size+plan.files.length+1+state.metaCount,'RESIDUAL');
      return state.metaCount?'complete':'staged';
    }
    async function inspectInternal(ctx,plan){
      const scope=await otherScope(ctx),db=await open(ctx,SPECS[0],scope.listed);
      try{const state=await readCounts(ctx,db,SPECS[0],true),mode=modeFor(plan,state);legacy();return {scope,db,state,mode};}
      catch(error){close(ctx,db);throw error;}
    }
    async function prepare(file,{signal}={}){
      return operation(signal,async ctx=>{
        insist(format?.version===1&&typeof format.decode==='function'&&typeof hashBlob==='function'&&file instanceof BlobClass&&typeof file.text==='function','BACKUP_INVALID');
        emit('preparing');const backupSha256=await ctx.hash(file);
        const text=await ctx.wait(done=>{Promise.resolve().then(()=>file.text()).then(v=>done(null,v),done);},verifyMs);ctx.check();
        let decoded;try{decoded=format.decode(text,{Blob:BlobClass,File:FileClass,now:()=>0});}catch(e){throw fail('BACKUP_INVALID',e);}
        const {pack,records,files}=decoded,states=pack.drawingStates||{};
        const required=new Map(),pairs=new Map();let drawings=0,recordCount=0,unclassifiedDrawings=0;
        function photo(drawingId,value){
          insist(object(value)&&typeof value.id==='string'&&!!value.id,'BACKUP_INVALID');
          const key='photo:'+drawingId+':'+value.id,pair=JSON.stringify([drawingId,value.id]);
          insist(!pairs.has(key)||pairs.get(key)===pair,'BACKUP_INVALID');pairs.set(key,pair);
          const descriptor=required.get(key)||{};
          if(own(value,'sha256')){insist(typeof value.sha256==='string'&&/^[a-f0-9]{64}$/i.test(value.sha256),'BACKUP_INVALID');
            insist(!descriptor.sha256||descriptor.sha256===value.sha256.toLowerCase(),'BACKUP_MISMATCH');descriptor.sha256=value.sha256.toLowerCase();}
          for(const field of ['size','byte_size'])if(own(value,field)){
            insist(Number.isSafeInteger(value[field])&&value[field]>0,'BACKUP_INVALID');
            insist(descriptor.size===undefined||descriptor.size===value[field],'BACKUP_MISMATCH');descriptor.size=value[field];}
          for(const field of ['type','mimeType','mime_type'])if(value[field]!==undefined&&value[field]!==''){
            insist(typeof value[field]==='string','BACKUP_INVALID');const mime=value[field].toLowerCase();
            insist(!descriptor.type||descriptor.type===mime,'BACKUP_MISMATCH');descriptor.type=mime;}
          required.set(key,descriptor);
        }
        for(const project of pack.workspace.projects)for(const drawing of project.drawings){
          drawings++;insist(own(states,drawing.id)&&object(states[drawing.id]),'BACKUP_INCOMPLETE');const state=states[drawing.id];
          const type=state.sourceType||drawing.sourceType;
          if(['pdf','image','dxf'].includes(type))required.set('background:'+drawing.id,{});
          else if(type||drawing.fileName||state.fileName)unclassifiedDrawings++;
          recordCount+=state.shapes.length;
          insist(state.collabDeletedRecords===undefined||Array.isArray(state.collabDeletedRecords),'BACKUP_INVALID');
          for(const shape of [...state.shapes,...(state.collabDeletedRecords||[])]){
            insist(object(shape)&&(shape.photos===undefined||Array.isArray(shape.photos)),'BACKUP_INVALID');
            for(const item of shape.photos||[])photo(drawing.id,item);
            if(shape.collab?.photos!==undefined){insist(object(shape.collab.photos),'BACKUP_INVALID');
              for(const [id,entry]of Object.entries(shape.collab.photos)){
                insist(object(entry)&&Array.isArray(entry.revisions),'BACKUP_INVALID');
                for(const revision of entry.revisions){insist(revision?.value?.id===id,'BACKUP_INVALID');photo(drawing.id,revision.value);}
              }
            }
          }
        }
        let includedBytes=0,matchedFiles=0;const manifest=[];
        for(let i=0;i<files.length;i++){
          ctx.check();const f=files[i],raw=pack.files[i];
          insist(typeof raw.data==='string'&&/^data:[^;,]+;base64,[A-Za-z0-9+/]*={0,2}$/.test(raw.data),'BACKUP_INVALID');
          const sha256=await ctx.hash(f.value),identity=fileIdentity(f.value),descriptor=required.get(f.key);
          if(descriptor){insist((!descriptor.sha256||descriptor.sha256===sha256)&&(descriptor.size===undefined||descriptor.size===identity.size)&&
            (!descriptor.type||descriptor.type===identity.type),'BACKUP_MISMATCH');matchedFiles++;}
          includedBytes+=identity.size;manifest.push({key:f.key,...identity,sha256});
        }
        insist(Number.isSafeInteger(includedBytes),'BACKUP_INVALID');
        const summary={projects:pack.workspace.projects.length,drawings,records:recordCount,
          photoReferences:[...required.keys()].filter(k=>k.startsWith('photo:')).length,
          drawingFileReferences:[...required.keys()].filter(k=>k.startsWith('background:')).length,
          requiredFiles:required.size,includedFiles:files.length,includedBytes,missingFiles:required.size-matchedFiles,
          includedUnreferencedFiles:files.length-matchedFiles,unclassifiedDrawings};
        const planSha256=await ctx.hash(new BlobClass([JSON.stringify({records:[...records],manifest})]));
        const publicPlan=Object.freeze({backupSha256,summary:Object.freeze({...summary})});
        plans.set(publicPlan,{backupSha256,planSha256,records,files,manifest,summary});emit('prepared',summary);return publicPlan;
      });
    }
    async function inspect(publicPlan,{signal}={}){
      const plan=planOf(publicPlan);
      return operation(signal,ctx=>exclusive(ctx,async()=>{
        emit('checking');const found=await inspectInternal(ctx,plan);
        try{const again=await otherScope(ctx);insist(found.scope.signature===again.signature,'CHANGED');
          return {mode:found.mode,summary:{...plan.summary}};}finally{close(ctx,found.db);}
      }));
    }
    function stage(ctx,db,plan,intent){
      return ctx.wait(done=>{
        let tx,error=null,waiting=3;const counts={};
        const abort=reason=>{error=error||reason;try{tx?.abort();ctx.persistence='none';}catch{};};
        try{
          tx=transaction(db,'readwrite');schema(db,tx,SPECS[0]);
          tx.onabort=()=>{ctx.persistence='none';done(error||tx.error||fail('STORAGE_FAILED'));};tx.onerror=()=>{};
          tx.oncomplete=()=>{ctx.persistence='staged';done(error);};
          const observe=q=>{q.onerror=()=>{if(!error||error.name==='AbortError')error=q.error;};return q;};
          for(const name of Object.keys(SPECS[0].stores))observe(tx.objectStore(name).count()).onsuccess=e=>{
            try{
              counts[name]=e.target.result;if(--waiting)return;ctx.check();legacy();
              insist(Object.values(counts).every(n=>n===0),'RESIDUAL');schema(db,tx,SPECS[0]);
              ctx.persistence='unknown';const files=tx.objectStore(FILES);
              for(const [key,value]of plan.records)observe(files.add(value,PREFIX+key));
              for(const f of plan.files)observe(files.add(f.value,f.key));
              observe(files.add(archiveFor(intent),ARCHIVE));observe(tx.objectStore(CONTROL).add(intent,INTENT));
            }catch(e){abort(e);}
          };
        }catch(e){abort(e);done(e);}
        return ()=>abort(fail('CANCELLED'));
      },verifyMs);
    }
    function verifyStored(ctx,db,plan,intent,mode,scopeSignature){
      return ctx.wait(done=>{
        let tx,error=null,proofReady=false,working=false,stopped=false,finished=false,pending=6;
        const values={};
        const abort=reason=>{if(finished)return;error=error||reason;try{tx?.abort();ctx.persistence=mode==='complete'?'complete':'staged';}catch{};};
        const observe=q=>{q.onerror=()=>{if(!error||error.name==='AbortError')error=q.error;};return q;};
        async function verify(){
          const fileRows=new Map(values.fileKeys.map((k,i)=>[k,values.fileValues[i]]));
          insist(values.journalCount===0&&values.controlKeys.length===1&&values.controlKeys[0]===INTENT&&
            same(values.controlValues,[intent]),'VERIFY_FAILED');
          const expectedKeys=[...plan.records.keys()].map(k=>PREFIX+k).concat(plan.files.map(f=>f.key),ARCHIVE,mode==='complete'?[META]:[]);
          insist(same(sorted(values.fileKeys),sorted(expectedKeys))&&fileRows.size===expectedKeys.length,'VERIFY_FAILED');
          for(const [key,value]of plan.records)insist(fileRows.get(PREFIX+key)===value,'VERIFY_FAILED');
          insist(same(fileRows.get(ARCHIVE),archiveFor(intent)),'VERIFY_FAILED');
          if(mode==='complete')insist(same(fileRows.get(META),metaFor(intent)),'VERIFY_FAILED');
          for(let i=0;i<plan.manifest.length;i++){
            ctx.check();const item=plan.manifest[i],value=fileRows.get(item.key);
            insist(value instanceof BlobClass&&same(fileIdentity(value),{size:item.size,type:item.type,name:item.name,lastModified:item.lastModified}),'VERIFY_FAILED');
            insist(await ctx.hash(value)===item.sha256,'VERIFY_FAILED');emit('verifying',{verifiedFiles:i+1,totalFiles:plan.files.length});
          }
          const after=await otherScope(ctx);insist(after.signature===scopeSignature,'CHANGED');ctx.check();legacy();proofReady=true;
        }
        function received(key,value){values[key]=value;if(--pending||working)return;working=true;verify().catch(abort);}
        function pump(){
          if(stopped)return;
          try{ctx.check();observe(tx.objectStore(FILES).count(META)).onsuccess=()=>{
            try{
              ctx.check();if(error){abort(error);return;}
              if(!proofReady){pump();return;}
              // IndexedDB requests must be created in an active request callback,
              // never in the unrelated microtask that finishes async Blob hashing.
              legacy();schema(db,tx,SPECS[0]);
              if(mode!=='complete'){ctx.persistence='unknown';observe(tx.objectStore(FILES).add(metaFor(intent),META));}
              stopped=true; // Let the transaction commit only after the proof.
            }catch(e){abort(e);}
          };}catch(e){abort(e);}
        }
        try{
          tx=transaction(db,mode==='complete'?'readonly':'readwrite');schema(db,tx,SPECS[0]);
          tx.onabort=()=>{finished=true;stopped=true;ctx.persistence=mode==='complete'?'complete':'staged';done(error||tx.error||fail('STORAGE_FAILED'));};tx.onerror=()=>{};
          tx.oncomplete=()=>{finished=true;stopped=true;if(!proofReady||error){done(error||fail('VERIFY_FAILED'));return;}ctx.persistence='complete';done(null,true);};
          observe(tx.objectStore(FILES).getAllKeys()).onsuccess=e=>received('fileKeys',e.target.result);
          observe(tx.objectStore(FILES).getAll()).onsuccess=e=>received('fileValues',e.target.result);
          observe(tx.objectStore(CONTROL).getAllKeys()).onsuccess=e=>received('controlKeys',e.target.result);
          observe(tx.objectStore(CONTROL).getAll()).onsuccess=e=>received('controlValues',e.target.result);
          observe(tx.objectStore(JOURNAL).count()).onsuccess=e=>received('journalCount',e.target.result);
          observe(tx.objectStore(FILES).count(META)).onsuccess=e=>received('metaCount',e.target.result);
          pump();
        }catch(e){abort(e);done(e);}
        return ()=>abort(fail('CANCELLED'));
      },verifyMs);
    }
    async function restore(publicPlan,{signal,confirmedOtherTabsClosed=false}={}){
      insist(confirmedOtherTabsClosed===true,'TABS_REQUIRED');const plan=planOf(publicPlan);
      return operation(signal,ctx=>exclusive(ctx,async()=>{
        emit('checking');const found=await inspectInternal(ctx,plan);let {mode}=found;
        try{
          let intent=found.state.intent;
          if(mode==='empty'){
            intent=intentFor(plan,new Date().toISOString());const again=await otherScope(ctx);
            insist(again.signature===found.scope.signature,'CHANGED');emit('staging');await stage(ctx,found.db,plan,intent);mode='staged';
          }else ctx.persistence=mode==='complete'?'complete':'staged';
          const beforeVerify=await otherScope(ctx);insist(beforeVerify.signature===found.scope.signature,'CHANGED');
          emit('verifying',{verifiedFiles:0,totalFiles:plan.files.length});
          await verifyStored(ctx,found.db,plan,intent,mode,found.scope.signature);
          const last=await readCounts(ctx,found.db,SPECS[0],true);
          insist(modeFor(plan,last)==='complete'&&same(last.intent,intent),'VERIFY_FAILED');
          const finalScope=await otherScope(ctx);insist(finalScope.signature===found.scope.signature,'CHANGED');
          emit('complete',plan.summary);return {verified:true,resumed:found.mode!=='empty',backupSha256:plan.backupSha256,summary:{...plan.summary}};
        }finally{close(ctx,found.db);}
      }));
    }
    return Object.freeze({prepare,inspect,restore});
  }

  function mount(document){
    if(!document?.getElementById('recoveryFile')||document.getElementById('recoveryFile').dataset.mounted)return;
    const $=id=>document.getElementById(id),file=$('recoveryFile'),check=$('recoveryCheck'),restore=$('recoveryRestore'),cancel=$('recoveryCancel');
    const open=$('recoveryOpen'),status=$('recoveryStatus'),summary=$('recoverySummary'),closed=$('recoveryTabsClosed'),understood=$('recoveryUnderstood');
    file.dataset.mounted='1';let plan=null,controller=null,running=false,eligible=false;
    const phase={preparing:'バックアップの内容と添付を確認中です。',checking:'保存領域に残っているデータを確認中です。',
      staging:'空の保存領域へ追加しています。まだ通常起動はできません。',verifying:'保存した内容をバックアップと照合中です。',complete:'保存と全添付の照合が完了しました。'};
    function update(){check.disabled=running||!file.files?.length;restore.disabled=running||!plan||!eligible||!closed.checked||!understood.checked;
      cancel.disabled=!running;file.disabled=running;closed.disabled=running;understood.disabled=running;}
    const api=create({onProgress:p=>{if(phase[p.phase])status.textContent=phase[p.phase]+(p.phase==='verifying'&&p.totalFiles!==undefined?' 添付 '+p.verifiedFiles+' / '+p.totalFiles+' 件':'');}});
    function hideOpen(){open.hidden=true;open.removeAttribute('href');}
    function showSummary(p){const s=p.summary;summary.replaceChildren();
      const rows=[['案件',s.projects+'件'],['図面の記録',s.drawings+'件'],['変状記録',s.records+'件'],['写真リンク',s.photoReferences+'件'],
        ['この控えに含まれる添付',s.includedFiles+'件（'+s.includedBytes.toLocaleString()+' bytes）'],['参照があるが控えにない添付',s.missingFiles+'件'],
        ['原本参照を判定できない図面',s.unclassifiedDrawings+'件'],['参照外も保持する添付',s.includedUnreferencedFiles+'件']];
      const dl=document.createElement('dl');for(const [label,value]of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd);}summary.append(dl);
      const note=document.createElement('p');note.className='warning';note.textContent='この復旧で保存する添付は '+s.includedFiles+' 件だけです。控えにない写真・PDF・図面原本は、この画面では取得しません。'+(s.missingFiles||s.unclassifiedDrawings?' 不足・未判定の資料があります。':'');summary.append(note);
    }
    function errorMessage(error){const info=publicError(error,error?.persistence||'none');
      const persisted=info.persistence==='staged'?'バックアップの内容は保存済みですが、照合が完了していません。通常起動は有効になっていません。同じ控えを選び直すと照合を再開できます。':
        info.persistence==='complete'?'保存と起動情報の追加後に、最終確認を完了できませんでした。同じ控えで再照合してください。':
        info.persistence==='unknown'?'保存が完了したか確認できません。同じ控えを選び直して状態を確認してください。':'今回の復旧による保存は完了していません。';
      status.textContent=info.message+' '+persisted+(info.errorName!=='Error'?'（'+info.errorName+'）':'');status.dataset.code=info.code;}
    file.addEventListener('change',()=>{plan=null;eligible=false;understood.checked=false;summary.replaceChildren();hideOpen();status.textContent='選んだ控えの内容を確認してください。';delete status.dataset.code;update();});
    closed.addEventListener('change',update);understood.addEventListener('change',update);
    check.onclick=async()=>{if(running||!file.files?.[0])return;running=true;eligible=false;hideOpen();controller=new AbortController();update();
      try{plan=await api.prepare(file.files[0],{signal:controller.signal});showSummary(plan);const result=await api.inspect(plan,{signal:controller.signal});eligible=true;
        status.textContent=result.mode==='empty'?'保存領域が空であることを確認しました。内容と注意事項を確認してから復旧してください。':
          '同じバックアップによる保存を確認しました。保存済みの内容を上書きせず、照合を再開できます。';delete status.dataset.code;
      }catch(e){eligible=false;errorMessage(e);}finally{running=false;controller=null;update();}};
    restore.onclick=async()=>{if(running||!plan||!eligible||!closed.checked||!understood.checked)return;running=true;hideOpen();controller=new AbortController();update();
      try{await api.restore(plan,{signal:controller.signal,confirmedOtherTabsClosed:true});eligible=false;
        status.textContent='保存した記録と、控えに含まれる全添付の照合が完了しました。元の保存障害の原因が解決したことを示すものではありません。';
        delete status.dataset.code;open.href='./';open.hidden=false;
      }catch(e){eligible=false;errorMessage(e);}finally{running=false;controller=null;update();}};
    cancel.onclick=()=>controller?.abort();hideOpen();update();
  }
  return Object.freeze({version:1,create,mount,publicError});
});

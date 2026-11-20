/* Experimental delta-sync storage. NOT loaded by the production app.
 * This database is separate from SentlogRecords and does not migrate it.
 * Records, outbox and receive cursor commit together. A per-scope revision
 * prevents two tabs from silently replacing one another's durable state.
 */
(function(root){
  'use strict';
  const DEFAULT_DB='sentlog-delta-v1', STORE='replicas', DB_VERSION=1;
  const scopeFields=['ownerId','projectId','deviceId'];
  const valid=x=>typeof x==='string'&&x.length>0&&x.length<=512;
  const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
  function problem(code,message){const e=Error(message);e.code=code;return e;}
  function assert(ok,code,message){if(!ok)throw problem(code,message);}
  function copy(value){return root.structuredClone(value);}
  const sameScope=(a,b)=>object(a)&&scopeFields.every(k=>a[k]===b[k]);
  function canonical(value,active=new Set()){
    if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
    if(typeof value==='number'){
      assert(Number.isFinite(value),'DELTA_BASELINE_FORMAT','引き継ぐ数値が不正です');return JSON.stringify(value);
    }
    assert(object(value)||Array.isArray(value),'DELTA_BASELINE_FORMAT','引き継ぐデータは JSON 形式である必要があります');
    assert(!active.has(value),'DELTA_BASELINE_FORMAT','引き継ぐデータが循環しています');active.add(value);
    assert(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null,
      'DELTA_BASELINE_FORMAT','ファイル本体は検証済みの移行控えで保持してください');
    const text=Array.isArray(value)?'['+Array.from(value,v=>canonical(v,active)).join(',')+']':
      '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],active)).join(',')+'}';
    active.delete(value);return text;
  }
  async function hash(text){
    assert(root.crypto?.subtle?.digest,'DELTA_HASH_UNAVAILABLE','引き継ぐ内容の照合機能がありません');
    return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  }

  function createStore(options={}){
    const scope=Object.freeze(Object.fromEntries(scopeFields.map(k=>[k,options[k]])));
    assert(scopeFields.every(k=>valid(scope[k])),'DELTA_SCOPE','保存先の利用者・案件・端末を確認できません');
    const name=options.databaseName||DEFAULT_DB;
    // The adapter must never accidentally open or upgrade the legacy app DB.
    assert(name===DEFAULT_DB||(/^sentlog-delta-test-[a-zA-Z0-9_-]{1,120}$/).test(name),
      'DELTA_STORE_CONFIG','差分同期専用の保存先を指定してください');
    const factory=options.indexedDB||root.indexedDB;
    assert(factory&&typeof factory.open==='function'&&typeof root.structuredClone==='function',
      'DELTA_STORE_UNAVAILABLE','端末の保存機能を利用できません');
    const key=JSON.stringify(scopeFields.map(k=>scope[k]));
    let db=null,opening=null,closed=false,expectedRevision=null,chain=Promise.resolve();
    const active=new Map();
    function assertOpen(){assert(!closed,'DELTA_STORE_CLOSED','この保存先は閉じています');}
    function closeWhenIdle(){if(closed&&active.size===0&&db){db.close();db=null;}}
    function serialized(fn){
      const task=chain.then(()=>{assertOpen();return fn();});
      chain=task.catch(()=>{});
      return task;
    }
    function validateState(state){
      assert(object(state)&&state.version===2&&sameScope(state.scope,scope),
        'DELTA_SCOPE','保存データの利用者・案件・端末が一致しません。元のデータは保持しています');
      assert(Number.isSafeInteger(state.cursor)&&state.cursor>=0&&object(state.records)&&Array.isArray(state.outbox),
        'DELTA_LOCAL_STATE','保存データの形式を確認できません');
      for(const event of state.outbox){
        assert(object(event)&&event.projectId===scope.projectId&&event.deviceId===scope.deviceId,
          'DELTA_SCOPE','別の案件・端末の未送信データを保存できません');
      }
      return state;
    }
    function decode(envelope){
      if(envelope===undefined)return {revision:0,state:null,provenance:null};
      assert(object(envelope)&&envelope.storageVersion===1&&Number.isSafeInteger(envelope.revision)&&envelope.revision>0,
        'DELTA_STORE_SCHEMA','保存先の形式を確認できません。初期化せず停止しました');
      assert(sameScope(envelope.scope,scope),'DELTA_SCOPE','保存先の利用者・案件・端末が一致しません');
      const provenance=envelope.provenance===undefined?null:validateProvenance(envelope.provenance);
      return {revision:envelope.revision,state:validateState(envelope.state),provenance};
    }
    function validateProvenance(value){
      const b=value?.baseline,s=value?.source;
      assert(object(value)&&value.version===1&&sameScope(value.scope,scope)&&
        object(b)&&b.schema===1&&valid(b.baselineId)&&b.ownerId===scope.ownerId&&b.projectId===scope.projectId&&
        valid(b.clientProjectId)&&b.state==='active'&&b.deltaEnabled===true&&b.cursor===0&&
        Number.isSafeInteger(b.snapshotRevision)&&b.snapshotRevision>=1&&
        Number.isSafeInteger(b.recordCount)&&b.recordCount>=0&&b.importedCount===b.recordCount&&
        Number.isSafeInteger(b.metadataCount)&&b.metadataCount>=1&&
        ['snapshotSha256','manifestSha256','metadataManifestSha256'].every(k=>digest(b[k]))&&
        b.hashFormat==='postgres-jsonb-text-sha256-v1'&&Array.isArray(b.drawingIds)&&b.drawingIds.every(valid)&&
        new Set(b.drawingIds).size===b.drawingIds.length&&b.metadataCount===b.drawingIds.length+1&&
        b.deviceMigrationVerified===false&&b.assetDeliveryVerified===false&&
        object(s)&&valid(s.migrationId)&&s.localProjectId===b.clientProjectId&&digest(s.fingerprint)&&
        digest(value.planSha256)&&digest(value.initialStateSha256)&&digest(value.metadataSha256)&&object(value.metadata),
        'DELTA_BASELINE_FORMAT','引き継ぎ元と検証結果を確認できません。既存の記録は保持しています');
      canonical(value);return value;
    }
    async function verifyInitialState(value){
      if(value.provenance&&value.revision===1)
        assert(await hash(canonical(value.state))===value.provenance.initialStateSha256,'DELTA_BASELINE_VERIFY',
          '初期記録の保存内容が照合結果と一致しません。既存の内容を保持しています');
    }
    function connect(){
      assertOpen();
      if(db)return Promise.resolve(db);
      if(opening)return opening;
      const task=new Promise((resolve,reject)=>{
        let request,failed=false;
        const fail=e=>{failed=true;reject(e);};
        try{request=factory.open(name,DB_VERSION);}catch(error){fail(error);return;}
        request.onupgradeneeded=()=>{
          // Only a genuinely new database may receive our schema. Do not guess
          // how to reinterpret an existing application's storage layout.
          const target=request.result;
          if(request.transaction.objectStoreNames.length){
            request.transaction.abort();return;
          }
          target.createObjectStore(STORE);
        };
        request.onerror=()=>fail(request.error||problem('DELTA_STORE_OPEN','保存先を開けません'));
        request.onblocked=()=>fail(problem('DELTA_STORE_BLOCKED','別の画面が保存先を使用中です。元のデータは保持しています'));
        request.onsuccess=()=>{
          const target=request.result;
          if(failed||closed){target.close();fail(problem('DELTA_STORE_CLOSED','保存先を開く処理を中止しました'));return;}
          if(!target.objectStoreNames.contains(STORE)){
            target.close();fail(problem('DELTA_STORE_SCHEMA','保存先の形式を確認できません'));return;
          }
          db=target;
          target.onversionchange=()=>{target.close();if(db===target)db=null;};
          target.onclose=()=>{if(db===target)db=null;};
          resolve(target);
        };
      });
      opening=task;
      task.then(()=>{if(opening===task)opening=null;},()=>{if(opening===task)opening=null;});
      return task;
    }
    function transaction(connection,mode){
      try{return connection.transaction(STORE,mode,{durability:'strict'});}
      catch(error){if(error.name==='TypeError')return connection.transaction(STORE,mode);throw error;}
    }
    function operate(connection,mode,action,signal){
      assertOpen();
      assert(!signal?.aborted,'DELTA_STORE_CANCELLED','保存処理を中止しました');
      return new Promise((resolve,reject)=>{
        let tx;
        try{tx=transaction(connection,mode);}catch(error){reject(error);return;}
        const context={reason:null,result:undefined,settled:false,cancel:null};
        active.set(tx,context);
        function finish(reason){
          if(context.settled)return;
          context.settled=true;
          if(reason){reject(reason);return;}
          try{resolve(copy(context.result));}catch(error){reject(error);}
        }
        const abort=error=>{
          if(context.settled)return;
          context.reason=context.reason||error||problem('DELTA_STORE_ABORTED','端末への保存が中断されました');
          try{tx.abort();}catch{/* An ended transaction cannot revive a cancelled caller. */}
          finish(context.reason);
        };
        context.cancel=abort;
        const cancelled=()=>abort(problem('DELTA_STORE_CANCELLED','保存処理を中止しました'));
        signal?.addEventListener('abort',cancelled,{once:true});
        const cleanup=()=>{signal?.removeEventListener('abort',cancelled);active.delete(tx);closeWhenIdle();};
        tx.oncomplete=()=>{finish(context.reason||(closed?problem('DELTA_STORE_CLOSED','この保存先は閉じています'):null));cleanup();};
        tx.onabort=()=>{finish(context.reason||tx.error||problem('DELTA_STORE_ABORTED','端末への保存が中断されました'));cleanup();};
        tx.onerror=()=>{}; // The transaction abort event is the durable outcome.
        try{action(tx.objectStore(STORE),context,abort);}catch(error){abort(error);}
      });
    }
    async function read(){
      return serialized(async()=>{
        const connection=await connect();
        const result=await operate(connection,'readonly',(store,context,abort)=>{
          const request=store.get(key);
          request.onerror=()=>{context.reason=context.reason||request.error;};
          request.onsuccess=()=>{
            if(context.settled)return;
            try{context.result=decode(request.result);}catch(error){abort(error);}
          };
        });
        if(expectedRevision!==null&&expectedRevision>0&&result.revision===0)
          throw problem('DELTA_STORE_MISSING','以前の保存データを確認できません。空のデータでは上書きしません');
        await verifyInitialState(result);assertOpen();
        expectedRevision=result.revision;
        return copy(result.state);
      });
    }
    function write(next){
      // Snapshot before any await, so a caller cannot mutate an in-flight save.
      let candidate;
      try{assertOpen();candidate=copy(validateState(next));}
      catch(error){return Promise.reject(error);}
      return serialized(async()=>{
        assert(expectedRevision!==null,'DELTA_STORE_NOT_READ','保存前に現在の記録を読み込んでください');
        const connection=await connect();
        const revision=await operate(connection,'readwrite',(store,context,abort)=>{
          const request=store.get(key);
          request.onerror=()=>{context.reason=context.reason||request.error;};
          request.onsuccess=()=>{
            if(context.settled)return;
            try{
              const current=decode(request.result);
              assert(current.revision===expectedRevision,'DELTA_STORE_STALE',
                '別の画面で記録が更新されています。上書きを止めました');
              assert(!current.state||candidate.cursor>=current.state.cursor,'DELTA_STORE_CURSOR',
                '受信済みの位置を過去へ戻すことはできません');
              assert(current.revision<Number.MAX_SAFE_INTEGER,'DELTA_STORE_REVISION','保存履歴の上限に達しました');
              context.result=current.revision+1;
              const put=store.put({storageVersion:1,scope:copy(scope),revision:context.result,state:candidate,
                ...(current.provenance?{provenance:current.provenance}:{})},key);
              put.onerror=()=>{context.reason=context.reason||put.error;};
            }catch(error){abort(error);}
          };
        });
        expectedRevision=revision;
      });
    }
    function installBaseline({state,baseline,source,planSha256,metadata,validate,signal}={}){
      let candidate,proof;
      const check=()=>{
        assertOpen();assert(!signal?.aborted,'DELTA_STORE_CANCELLED','引き継ぎを中止しました');
        const result=validate();
        assert(result!==false&&!(result&&typeof result.then==='function'),'DELTA_BASELINE_FENCE',
          '引き継ぎ中の利用者と書き込み停止を確認できません');
      };
      try{
        assert(typeof validate==='function','DELTA_BASELINE_FENCE','引き継ぎ中の書き込み停止を確認する方法が必要です');check();
        candidate=copy(validateState(state));
        const core=root.SentlogDeltaSyncCore||(typeof module==='object'&&module.exports?require('./delta-sync-core.js'):null);
        assert(typeof core?.validateState==='function','DELTA_BASELINE_CONFIG','引き継ぎの検証機能がありません');
        core.validateState(candidate,scope,true);
        assert(candidate.cursor===0&&(!candidate.blockedOutbox||candidate.blockedOutbox.length===0),
          'DELTA_BASELINE_FORMAT','引き継ぎ時の受信位置または確認待ち履歴が不正です');
        canonical(candidate);
        proof=copy({version:1,scope:copy(scope),baseline,source,planSha256,metadata,
          initialStateSha256:'0'.repeat(64),metadataSha256:'0'.repeat(64)});validateProvenance(proof);
      }catch(error){return Promise.reject(error);}
      return serialized(async()=>{
        [proof.initialStateSha256,proof.metadataSha256]=await Promise.all([hash(canonical(candidate)),hash(canonical(proof.metadata))]);check();
        const connection=await connect();check();
        const result=await operate(connection,'readwrite',(store,context,abort)=>{
          const request=store.get(key);
          request.onerror=()=>{context.reason=context.reason||request.error;};
          request.onsuccess=()=>{
            if(context.settled)return;
            try{
              check();const current=decode(request.result);
              assert(expectedRevision===null||current.revision===expectedRevision,'DELTA_STORE_STALE',
                '別の画面で記録が更新されています。上書きを止めました');
              if(current.state){
                assert(current.provenance&&canonical(current.provenance)===canonical(proof),'DELTA_BASELINE_EXISTS',
                  '既に別の記録または引き継ぎ結果が保存されています。上書きは行いません');
                assert(current.revision!==1||canonical(current.state)===canonical(candidate),'DELTA_BASELINE_VERIFY',
                  '初期記録の保存内容が照合結果と一致しません。既存の内容を保持しています');
                context.result={...current,idempotent:true};return;
              }
              context.result={revision:1,state:candidate,provenance:proof,idempotent:false};
              const put=store.add({storageVersion:1,scope:copy(scope),revision:1,state:candidate,provenance:proof},key);
              put.onerror=()=>{context.reason=context.reason||put.error;};
              put.onsuccess=()=>{if(context.settled)return;try{check();}catch(error){abort(error);}};
            }catch(error){abort(error);}
          };
        },signal);
        check();expectedRevision=result.revision;return result;
      });
    }
    function readProvenance(){
      // Merely reading the receipt must not refresh the revision of a stale
      // in-memory replica and let its next write overwrite a different tab.
      return serialized(async()=>{
        const connection=await connect();
        const value=await operate(connection,'readonly',(store,context,abort)=>{
          const request=store.get(key);request.onerror=()=>{context.reason=context.reason||request.error;};
          request.onsuccess=()=>{if(context.settled)return;try{context.result=decode(request.result);}catch(error){abort(error);}};
        });
        await verifyInitialState(value);
        if(value.provenance)assert(await hash(canonical(value.provenance.metadata))===value.provenance.metadataSha256,'DELTA_BASELINE_VERIFY',
          '保存した図面設定の内容が一致しません。既存の記録を保持しています');
        assertOpen();return value.provenance;
      });
    }
    function close(){
      if(closed)return;closed=true;
      for(const context of [...active.values()])context.cancel(problem('DELTA_STORE_CLOSED','保存処理を中止しました'));
      closeWhenIdle();
    }
    return {read,write,installBaseline,readProvenance,close,getScope:()=>copy(scope)};
  }
  const api={version:1,createStore};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaIndexedDB=api;
})(typeof window!=='undefined'?window:globalThis);

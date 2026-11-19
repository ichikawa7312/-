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
  function problem(code,message){const e=Error(message);e.code=code;return e;}
  function assert(ok,code,message){if(!ok)throw problem(code,message);}
  function copy(value){return root.structuredClone(value);}
  const sameScope=(a,b)=>object(a)&&scopeFields.every(k=>a[k]===b[k]);

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
      if(envelope===undefined)return {revision:0,state:null};
      assert(object(envelope)&&envelope.storageVersion===1&&Number.isSafeInteger(envelope.revision)&&envelope.revision>0,
        'DELTA_STORE_SCHEMA','保存先の形式を確認できません。初期化せず停止しました');
      assert(sameScope(envelope.scope,scope),'DELTA_SCOPE','保存先の利用者・案件・端末が一致しません');
      return {revision:envelope.revision,state:validateState(envelope.state)};
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
    function operate(connection,mode,action){
      assertOpen();
      return new Promise((resolve,reject)=>{
        let tx;
        try{tx=transaction(connection,mode);}catch(error){reject(error);return;}
        const context={reason:null,result:undefined};
        active.set(tx,context);
        const abort=error=>{
          context.reason=error;
          try{tx.abort();}catch(abortError){active.delete(tx);reject(error||abortError);}
        };
        tx.oncomplete=()=>{active.delete(tx);resolve(context.result);};
        tx.onabort=()=>{active.delete(tx);reject(context.reason||tx.error||problem('DELTA_STORE_ABORTED','端末への保存が中断されました'));};
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
            try{context.result=decode(request.result);}catch(error){abort(error);}
          };
        });
        if(expectedRevision!==null&&expectedRevision>0&&result.revision===0)
          throw problem('DELTA_STORE_MISSING','以前の保存データを確認できません。空のデータでは上書きしません');
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
            try{
              const current=decode(request.result);
              assert(current.revision===expectedRevision,'DELTA_STORE_STALE',
                '別の画面で記録が更新されています。上書きを止めました');
              assert(!current.state||candidate.cursor>=current.state.cursor,'DELTA_STORE_CURSOR',
                '受信済みの位置を過去へ戻すことはできません');
              assert(current.revision<Number.MAX_SAFE_INTEGER,'DELTA_STORE_REVISION','保存履歴の上限に達しました');
              context.result=current.revision+1;
              const put=store.put({storageVersion:1,scope:copy(scope),revision:context.result,state:candidate},key);
              put.onerror=()=>{context.reason=context.reason||put.error;};
            }catch(error){abort(error);}
          };
        });
        expectedRevision=revision;
      });
    }
    function close(){
      closed=true;
      for(const [tx,context]of active){
        context.reason=problem('DELTA_STORE_CLOSED','保存処理を中止しました。以前の保存内容を保持しています');
        try{tx.abort();}catch(_){}
      }
      if(db)db.close();
      db=null;
    }
    return {read,write,close,getScope:()=>copy(scope)};
  }
  const api={version:1,createStore};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaIndexedDB=api;
})(typeof window!=='undefined'?window:globalThis);

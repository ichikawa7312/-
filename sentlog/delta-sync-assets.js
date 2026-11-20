/* Isolated delta-sync photo delivery prototype. NOT loaded by the live app.
 * Each photo's queue item, immutable bytes and verified receipt commit together.
 * Shared images and originals have separate identities. Nothing is deleted.
 * Transport implementations must authenticate the scope and resolve asset IDs
 * through the server; this module never follows a supplied upload/download URL.
 */
(function(root){
  'use strict';
  const DB='sentlog-delta-assets-v1', STORE='assets', VERSION=1;
  const SCOPE=['ownerId','projectId','deviceId'];
  const IDENTITY=['ownerId','projectId','assetId','drawingId','photoId','variant','sha256','size','mimeType'];
  const MIME=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
  const valid=x=>typeof x==='string'&&x.length>0&&x.length<=512;
  const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const copy=x=>root.structuredClone(x);
  const sameScope=(a,b)=>object(a)&&object(b)&&SCOPE.every(k=>a[k]===b[k]);
  const same=(a,b)=>object(a)&&object(b)&&IDENTITY.every(k=>a[k]===b[k]);
  function problem(code,message){const e=Error(message);e.code=code;return e;}
  function insist(ok,code,message){if(!ok)throw problem(code,message);}
  function reference(input,scope){
    insist(object(input)&&['ownerId','projectId','assetId','drawingId','photoId'].every(k=>valid(input[k])),
      'ASSET_REFERENCE','写真の識別情報を確認できません');
    insist(input.ownerId===scope.ownerId&&input.projectId===scope.projectId,
      'ASSET_SCOPE','別の利用者・案件の写真は受け渡せません');
    insist(['shared','original'].includes(input.variant)&&typeof input.sha256==='string'&&/^[a-f0-9]{64}$/i.test(input.sha256)&&
      Number.isSafeInteger(input.size)&&input.size>0&&MIME.has(input.mimeType),
      'ASSET_REFERENCE','写真の種類・サイズ・照合情報を確認できません');
    const result=Object.fromEntries(IDENTITY.map(k=>[k,input[k]]));
    result.sha256=result.sha256.toLowerCase();
    return result;
  }
  function references(input,scope){
    insist(Array.isArray(input),'ASSET_REFERENCE_SET','現在の写真一覧が必要です');
    const assets=new Map(),targets=new Map();
    for(const item of input){
      const r=reference(item,scope),target=JSON.stringify([r.drawingId,r.photoId,r.variant]);
      insist(!assets.has(r.assetId)||same(assets.get(r.assetId),r),
        'ASSET_COLLISION','同じ写真IDに異なる内容があります。原本は保持しています');
      insist(!targets.has(target)||targets.get(target)===r.assetId,
        'ASSET_COLLISION','同じ写真の保存先に異なる識別情報があります');
      assets.set(r.assetId,r);targets.set(target,r.assetId);
    }
    return [...assets.values()].sort((a,b)=>a.assetId<b.assetId?-1:a.assetId>b.assetId?1:0);
  }
  function receipt(ref,scope){return {...copy(ref),deviceId:scope.deviceId};}
  function matchesReceipt(value,ref,scope){return same(value,ref)&&value.deviceId===scope.deviceId;}
  async function verifyBlob(blob,ref){
    insist(typeof root.Blob==='function'&&blob instanceof root.Blob&&blob.size===ref.size,
      'ASSET_CONTENT_MISMATCH','写真のサイズが登録内容と一致しません。元のファイルは保持しています');
    insist(root.crypto?.subtle?.digest,'ASSET_HASH_UNAVAILABLE','写真の内容を照合できません');
    // File/Blob bytes are immutable, unlike a caller-owned Uint8Array.
    const digest=await root.crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    insist(hash===ref.sha256,'ASSET_CONTENT_MISMATCH','写真の内容が登録内容と一致しません。上書きを止めました');
  }
  function validateRow(row,ref,scope){
    if(row===undefined||row===null)return null;
    insist(object(row)&&row.version===1&&sameScope(row.scope,scope)&&same(row.reference,ref)&&
      Number.isSafeInteger(row.revision)&&row.revision>0&&['waiting','received','acknowledged'].includes(row.phase),
      'ASSET_COLLISION','保存済み写真の識別情報と一致しません。保存先を初期化せず停止しました');
    if(row.phase==='waiting'){
      insist(row.blob===null&&row.localReceipt===null&&row.remoteReceipt===null,
        'ASSET_STORE_INVALID','写真待ちの保存状態を確認できません');
    }else{
      insist(row.blob instanceof root.Blob&&row.blob.size===ref.size&&
        matchesReceipt(row.localReceipt,ref,scope)&&row.localReceipt.verified===true,
        'ASSET_STORE_INVALID','写真本体または受信記録を確認できません');
      insist(row.phase==='received'?row.remoteReceipt===null:
        matchesReceipt(row.remoteReceipt,ref,scope)&&row.remoteReceipt.durable===true,
        'ASSET_STORE_INVALID','写真の受領確認が一致しません');
    }
    return row;
  }

  function createIndexedDBStore(options={}){
    const scope=Object.freeze(Object.fromEntries(SCOPE.map(k=>[k,options[k]])));
    insist(SCOPE.every(k=>valid(scope[k])),'ASSET_SCOPE','写真の保存先を確認できません');
    const name=options.databaseName||DB, factory=options.indexedDB||root.indexedDB;
    insist(name===DB||/^sentlog-delta-assets-test-[a-zA-Z0-9_-]{1,120}$/.test(name),
      'ASSET_STORE_CONFIG','写真同期専用の保存先を指定してください');
    insist(factory&&typeof factory.open==='function'&&typeof root.structuredClone==='function',
      'ASSET_STORE_UNAVAILABLE','写真の端末保存機能を利用できません');
    let db=null,opening=null,closed=false;
    const active=new Map();
    const key=ref=>JSON.stringify([...SCOPE.map(k=>scope[k]),ref.assetId]);
    function alive(){insist(!closed,'ASSET_CLOSED','写真の保存処理を終了しています');}
    function connect(){
      alive();if(db)return Promise.resolve(db);if(opening)return opening;
      const task=new Promise((resolve,reject)=>{
        let request,failed=false;
        const fail=e=>{failed=true;reject(e);};
        try{request=factory.open(name,VERSION);}catch(error){fail(error);return;}
        request.onupgradeneeded=()=>{
          if(request.transaction.objectStoreNames.length){request.transaction.abort();return;}
          request.result.createObjectStore(STORE);
        };
        request.onblocked=()=>fail(problem('ASSET_STORE_BLOCKED','別の画面が写真の保存先を使用中です'));
        request.onerror=()=>fail(request.error||problem('ASSET_STORE_OPEN','写真の保存先を開けません'));
        request.onsuccess=()=>{
          const target=request.result;
          if(failed||closed){target.close();fail(problem('ASSET_CLOSED','写真の保存準備を中止しました'));return;}
          if(!target.objectStoreNames.contains(STORE)){
            target.close();fail(problem('ASSET_STORE_INVALID','写真の保存先の形式を確認できません'));return;
          }
          db=target;target.onversionchange=()=>{target.close();if(db===target)db=null;};
          target.onclose=()=>{if(db===target)db=null;};resolve(target);
        };
      });
      opening=task;task.then(()=>{if(opening===task)opening=null;},()=>{if(opening===task)opening=null;});return task;
    }
    async function operation(ref,mode,mutate){
      const connection=await connect();alive();
      return new Promise((resolve,reject)=>{
        let tx;
        try{try{tx=connection.transaction(STORE,mode,{durability:'strict'});}
          catch(error){if(error.name!=='TypeError')throw error;tx=connection.transaction(STORE,mode);}}
        catch(error){reject(error);return;}
        const context={error:null,result:null};active.set(tx,context);
        const abort=error=>{context.error=error;try{tx.abort();}catch(_){active.delete(tx);reject(error);}};
        tx.oncomplete=()=>{active.delete(tx);resolve(copy(context.result));};
        tx.onabort=()=>{active.delete(tx);reject(context.error||tx.error||problem('ASSET_STORE_ABORTED','写真の保存が中断されました'));};
        tx.onerror=()=>{};
        try{
          const store=tx.objectStore(STORE),q=store.get(key(ref));
          q.onerror=()=>{context.error=context.error||q.error;};
          q.onsuccess=()=>{
            try{
              alive();const current=validateRow(q.result,ref,scope),next=mutate(current);
              context.result=next;
              if(mode==='readwrite'&&next!==current){
                validateRow(next,ref,scope);
                const put=store.put(next,key(ref));put.onerror=()=>{context.error=context.error||put.error;};
              }
            }catch(error){abort(error);}
          };
        }catch(error){abort(error);}
      });
    }
    function nextRevision(row){insist(row.revision<Number.MAX_SAFE_INTEGER,'ASSET_STORE_REVISION','写真の保存履歴が上限に達しました');return row.revision+1;}
    const api={
      getScope:()=>copy(scope),
      ensure(input){
        const ref=reference(input,scope);alive();
        return operation(ref,'readwrite',row=>row||{version:1,scope:copy(scope),reference:ref,revision:1,
          phase:'waiting',blob:null,localReceipt:null,remoteReceipt:null});
      },
      read(input){const ref=reference(input,scope);alive();return operation(ref,'readonly',row=>row);},
      async received(input,blob,{validate=()=>{}}={}){
        const ref=reference(input,scope);alive();await verifyBlob(blob,ref);alive();
        return operation(ref,'readwrite',row=>{
          validate();
          insist(row,'ASSET_NOT_QUEUED','写真の受信予定を確認できません');
          // A repeated response cannot roll back an already acknowledged item.
          if(row.phase!=='waiting')return row;
          return {...row,revision:nextRevision(row),phase:'received',blob,
            localReceipt:{...receipt(ref,scope),verified:true},remoteReceipt:null};
        });
      },
      acknowledged(input,proof,{validate=()=>{}}={}){
        const ref=reference(input,scope),ack=copy(proof);alive();
        insist(matchesReceipt(ack,ref,scope)&&ack.durable===true,
          'ASSET_ACK_MISMATCH','この端末・写真の受領確認が一致しません');
        return operation(ref,'readwrite',row=>{
          validate();
          insist(row&&row.phase!=='waiting','ASSET_NOT_DURABLE','写真本体を端末へ保存する前に完了扱いにはできません');
          if(row.phase==='acknowledged')return row;
          return {...row,revision:nextRevision(row),phase:'acknowledged',remoteReceipt:ack};
        });
      },
      close(){
        closed=true;
        for(const [tx,context]of active){context.error=problem('ASSET_CLOSED','写真の保存を中止しました');try{tx.abort();}catch(_){}}
        if(db)db.close();db=null;
      }
    };
    return api;
  }

  function createQueue({scope:inputScope,store,transport,currentScope,timeoutMs=30000,maxBytes=22*1024*1024,allowOriginals=false}={}){
    const scope=Object.freeze(Object.fromEntries(SCOPE.map(k=>[k,inputScope?.[k]])));
    insist(SCOPE.every(k=>valid(scope[k]))&&store&&sameScope(store.getScope?.(),scope)&&
      ['ensure','read','received','acknowledged'].every(k=>typeof store[k]==='function')&&
      transport&&['online','download','acknowledge'].every(k=>typeof transport[k]==='function')&&typeof currentScope==='function',
      'ASSET_CONFIG','写真の保存・通信・利用者確認の方法が不足しています');
    insist(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&typeof allowOriginals==='boolean',
      'ASSET_CONFIG','写真の通信上限を確認できません');
    let closed=false,desired=null,generation=0,pump=null,pumpGeneration=null;
    const inflight=new Set();
    function alive(epoch){
      insist(!closed,'ASSET_CLOSED','写真同期を終了しています');
      insist(sameScope(currentScope(),scope),'ASSET_SCOPE','写真同期中に利用者・案件・端末が変わりました');
      if(epoch!==undefined)insist(epoch===generation,'ASSET_REFERENCES_CHANGED','写真一覧が更新されました。保存内容を保持して再確認します');
    }
    function select(input){
      alive();const refs=references(input,scope),signature=JSON.stringify(refs);
      if(signature!==desired){desired=signature;generation++;}return {refs,epoch:generation};
    }
    function request(fn,epoch){
      alive(epoch);const controller=new AbortController();let timer,rejectClose;
      const cancelled=new Promise((resolve,reject)=>{rejectClose=reject;});
      const ticket={cancel(){controller.abort();rejectClose(problem('ASSET_CLOSED','写真同期を中止しました'));}};
      inflight.add(ticket);
      const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{
        controller.abort();reject(problem('ASSET_TIMEOUT','写真の通信が時間内に完了しませんでした。再送待ちを保持しています'));
      },timeoutMs);});
      return Promise.race([Promise.resolve().then(()=>{alive(epoch);return fn(controller.signal);}),deadline,cancelled])
        .then(value=>{alive(epoch);return value;}).finally(()=>{clearTimeout(timer);inflight.delete(ticket);});
    }
    async function ensure(refs,epoch){
      for(const ref of refs){alive(epoch);await store.ensure(ref);alive(epoch);}
    }
    async function status(refs,epoch){
      const result={scope:copy(scope),referenceSignature:JSON.stringify(refs),
        total:refs.length,untracked:0,waiting:0,received:0,acknowledged:0,complete:false};
      for(const ref of refs){
        alive(epoch);const row=await store.read(ref);alive(epoch);
        if(!row)result.untracked++;
        else{
          if(row.phase!=='waiting'){await verifyBlob(row.blob,ref);alive(epoch);}
          result[row.phase]++;
        }
      }
      result.pending=result.untracked+result.waiting+result.received;
      result.complete=result.pending===0;
      result.message=result.complete?'写真本体の保存・受領確認が完了しました':
        '写真 '+result.pending+' 件を受信・確認待ちです';
      return result;
    }
    async function run(refs,epoch){
      await ensure(refs,epoch);
      for(const ref of refs){
        alive(epoch);if(!transport.online())break;
        insist(ref.variant!=='original'||allowOriginals,'ASSET_ORIGINAL_NOT_REQUESTED',
          '原本写真の転送には明示的な指定が必要です。通常同期は共有用写真だけを対象とします');
        insist(ref.size<=maxBytes,'ASSET_TOO_LARGE','写真がこの転送経路の上限を超えています。元の写真と受信待ちを保持しています');
        let row=await store.read(ref);alive(epoch);
        if(row.phase==='waiting'){
          const blob=await request(signal=>transport.download(copy(ref),{scope:copy(scope),signal}),epoch);
          // Check again after hashing and before any local mutation. A late
          // response from an old login or old reference set cannot be applied.
          await verifyBlob(blob,ref);alive(epoch);
          await store.received(ref,blob,{validate:()=>alive(epoch)});alive(epoch);
          row=await store.read(ref);alive(epoch);
        }
        insist(row&&row.phase!=='waiting','ASSET_NOT_DURABLE','写真の保存完了を確認できません');
        // A persisted receipt is not enough to send an acknowledgement after a
        // restart: read the committed Blob and verify its actual bytes again.
        await verifyBlob(row.blob,ref);alive(epoch);
        if(row.phase==='acknowledged')continue;
        if(!transport.online())break;
        const proof=await request(signal=>transport.acknowledge(copy(ref),{
          scope:copy(scope),receipt:copy(row.localReceipt),signal
        }),epoch);
        insist(matchesReceipt(proof,ref,scope)&&proof.durable===true,
          'ASSET_ACK_MISMATCH','写真の受領確認が一致しません。受信記録を保持します');
        alive(epoch);await store.acknowledged(ref,proof,{validate:()=>alive(epoch)});alive(epoch);
      }
      return status(refs,epoch);
    }
    return {
      getScope:()=>copy(scope),
      async ensure(input){const {refs,epoch}=select(input);await ensure(refs,epoch);return status(refs,epoch);},
      status(input){const {refs,epoch}=select(input);return status(refs,epoch);},
      sync(input){
        const {refs,epoch}=select(input);
        if(pump){
          if(pumpGeneration===epoch)return pump;
          return Promise.reject(problem('ASSET_REFERENCES_CHANGED','写真一覧が更新されました。前の通信終了後に再確認します'));
        }
        pumpGeneration=epoch;
        pump=run(refs,epoch).finally(()=>{pump=null;pumpGeneration=null;});return pump;
      },
      close(){if(closed)return;closed=true;for(const ticket of inflight)ticket.cancel();}
    };
  }
  function combinedStatus(recordStatus,photoStatus,context){
    const recordComplete=object(recordStatus)&&sameScope(recordStatus.scope,context?.scope)&&
      object(recordStatus.snapshotToken)&&recordStatus.snapshotToken===context?.recordSnapshotToken&&
      recordStatus.level==='ok'&&recordStatus.pending===0&&recordStatus.blocked===0&&recordStatus.conflicts===0;
    let coversCurrentReferences=false;
    try{
      coversCurrentReferences=object(context)&&SCOPE.every(k=>valid(context.scope?.[k]))&&
        sameScope(context.scope,photoStatus?.scope)&&
        JSON.stringify(references(context.references,context.scope))===photoStatus.referenceSignature;
    }catch(_){/* A partial or foreign reference list cannot prove completion. */}
    const photosComplete=coversCurrentReferences&&object(photoStatus)&&photoStatus.complete===true&&photoStatus.pending===0&&
      Number.isSafeInteger(photoStatus.total)&&photoStatus.total>=0&&photoStatus.acknowledged===photoStatus.total&&
      photoStatus.waiting===0&&photoStatus.received===0&&photoStatus.untracked===0;
    return {complete:recordComplete&&photosComplete,recordsComplete:recordComplete,photosComplete,
      level:recordComplete&&photosComplete?'ok':recordComplete?'photos-waiting':'records-waiting'};
  }
  const api={version:1,createIndexedDBStore,createQueue,combinedStatus,verifyBlob};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogDeltaAssets=api;
})(typeof window!=='undefined'?window:globalThis);

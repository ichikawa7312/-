/* Isolated, non-destructive legacy migration staging. NOT loaded by the app.
 * A verified copy is NOT an activated replica or a cloud receipt. Old storage,
 * the normal delta outbox and all originals remain untouched. Cross-database
 * activation needs a separate writer fence and server-baseline reconciliation.
 */
(function(root){
  'use strict';
  const DB='sentlog-delta-migration-v1', SESSIONS='sessions', ITEMS='items';
  const fields=['ownerId','projectId','deviceId'], own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x), valid=x=>typeof x==='string'&&x.length>0&&x.length<=512;
  const digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x), copy=x=>root.structuredClone(x);
  const same=(a,b)=>object(a)&&object(b)&&fields.every(k=>a[k]===b[k]);
  function error(code,message){const e=Error(message);e.code=code;return e;}
  function insist(ok,code,message){if(!ok)throw error(code,message);}
  function canonical(value){
    if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
    if(typeof value==='number'){insist(Number.isFinite(value),'MIGRATION_FORMAT','控えの数値が不正です');return JSON.stringify(value);}
    if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
    insist(object(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),
      'MIGRATION_FORMAT','控えの形式を確認できません');
    return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  }
  // IndexedDB metadata may contain undefined and -0. A plain JSON stringify
  // would silently change that source even if all photo hashes matched.
  function pack(value){
    if(value===undefined)return ['undefined'];
    if(value===null)return ['null'];
    if(typeof value==='boolean'||typeof value==='string')return [typeof value,value];
    if(typeof value==='number'){
      insist(Number.isFinite(value),'MIGRATION_FORMAT','控えの数値が不正です');
      return [Object.is(value,-0)?'negative-zero':'number',value];
    }
    if(Array.isArray(value))return ['array',Array.from({length:value.length},(_,i)=>own(value,i)?pack(value[i]):['hole'])];
    insist(object(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),
      'MIGRATION_FORMAT','控えの形式を確認できません');
    return ['object',Object.keys(value).sort().map(key=>[key,pack(value[key])])];
  }
  function unpack(value){
    insist(Array.isArray(value)&&typeof value[0]==='string','MIGRATION_FORMAT','控えの復元形式が不正です');
    const [type,data]=value;
    if(type==='undefined')return undefined;
    if(type==='null')return null;
    if(type==='negative-zero')return -0;
    if(type==='string'||type==='boolean'||type==='number'){
      insist(typeof data===type&&(type!=='number'||Number.isFinite(data)),'MIGRATION_FORMAT','控えの値が不正です');return data;
    }
    insist(Array.isArray(data),'MIGRATION_FORMAT','控えの一覧が不正です');
    if(type==='array'){
      const result=new Array(data.length);data.forEach((entry,i)=>{if(entry?.[0]!=='hole')result[i]=unpack(entry);});return result;
    }
    insist(type==='object','MIGRATION_FORMAT','控えの型が不正です');
    const result={};
    for(const entry of data){
      insist(Array.isArray(entry)&&typeof entry[0]==='string'&&!own(result,entry[0]),'MIGRATION_FORMAT','控えの項目が不正です');
      Object.defineProperty(result,entry[0],{value:unpack(entry[1]),writable:true,enumerable:true,configurable:true});
    }
    return result;
  }
  async function hash(value){
    insist(root.crypto?.subtle?.digest,'MIGRATION_HASH_UNAVAILABLE','内容の照合機能がありません');
    const bytes=typeof value==='string'?new TextEncoder().encode(value):await value.arrayBuffer();
    return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  function createStore(options={}){
    const scope=Object.freeze(Object.fromEntries(fields.map(k=>[k,options[k]])));
    insist(fields.every(k=>valid(scope[k])),'MIGRATION_SCOPE','控えの利用者・案件・端末を確認できません');
    const name=options.databaseName||DB, factory=options.indexedDB||root.indexedDB;
    insist(name===DB||/^sentlog-delta-test-[a-zA-Z0-9_-]{1,120}$/.test(name),'MIGRATION_STORE_CONFIG','移行控え専用の保存先が必要です');
    insist(factory?.open&&typeof root.structuredClone==='function','MIGRATION_STORE_UNAVAILABLE','移行控えを保存できません');
    const prefix=JSON.stringify(fields.map(k=>scope[k]));
    let db=null,opening=null,closed=false;
    const active=new Map();
    const open=()=>insist(!closed,'MIGRATION_CLOSED','控えの保存処理を終了しました');
    const key=id=>{insist(valid(id),'MIGRATION_ID','移行番号が不正です');return [prefix,id];};
    function connect(){
      open();if(db)return Promise.resolve(db);if(opening)return opening;
      const task=new Promise((resolve,reject)=>{
        let q,failed=false;
        const fail=e=>{failed=true;reject(e);};
        try{q=factory.open(name,1);}catch(e){fail(e);return;}
        q.onupgradeneeded=()=>{
          if(q.transaction.objectStoreNames.length){q.transaction.abort();return;}
          q.result.createObjectStore(SESSIONS);q.result.createObjectStore(ITEMS);
        };
        q.onerror=()=>fail(q.error||error('MIGRATION_STORE_OPEN','控えの保存先を開けません'));
        q.onblocked=()=>fail(error('MIGRATION_STORE_BLOCKED','別の画面が移行控えを使用中です'));
        q.onsuccess=()=>{
          const target=q.result;
          if(failed||closed){target.close();fail(error('MIGRATION_CLOSED','保存先を開く処理を中止しました'));return;}
          if(!target.objectStoreNames.contains(SESSIONS)||!target.objectStoreNames.contains(ITEMS)){
            target.close();fail(error('MIGRATION_STORE_SCHEMA','別用途の保存先を移行控えとして使用できません'));return;
          }
          db=target;target.onversionchange=()=>{target.close();if(db===target)db=null;};
          target.onclose=()=>{if(db===target)db=null;};resolve(target);
        };
      });
      opening=task;task.then(()=>{if(opening===task)opening=null;},()=>{if(opening===task)opening=null;});return task;
    }
    async function transact(mode,action){
      const connection=await connect();open();
      return new Promise((resolve,reject)=>{
        let tx;
        try{try{tx=connection.transaction([SESSIONS,ITEMS],mode,{durability:'strict'});}
          catch(e){if(e.name!=='TypeError')throw e;tx=connection.transaction([SESSIONS,ITEMS],mode);}}
        catch(e){reject(e);return;}
        const ctx={reason:null,result:null};active.set(tx,ctx);
        const abort=e=>{ctx.reason=e;try{tx.abort();}catch{active.delete(tx);reject(e);}};
        tx.oncomplete=()=>{active.delete(tx);resolve(copy(ctx.result));};
        tx.onabort=()=>{active.delete(tx);reject(ctx.reason||tx.error||error('MIGRATION_ABORTED','控えの保存が中断しました'));};
        tx.onerror=()=>{};
        try{action(tx.objectStore(SESSIONS),tx.objectStore(ITEMS),ctx,abort);}catch(e){abort(e);}
      });
    }
    function decode(row,id){
      if(row===undefined)return null;
      insist(object(row)&&row.version===1&&row.id===id&&same(row.scope,scope)&&digest(row.bundleHash)&&
        digest(row.sourceFingerprint)&&valid(row.localProjectId)&&Array.isArray(row.manifest)&&
        Number.isSafeInteger(row.next)&&row.next>=0&&row.next<=row.manifest.length&&
        ['copying','verified-copy','needs-review'].includes(row.status)&&row.readyForActivation===false&&row.readyForCloudSync===false,
        'MIGRATION_STORE_SCHEMA','移行控えの保存状態を確認できません');
      return row;
    }
    function status(id){return transact('readonly',(sessions,items,ctx,abort)=>{
      const q=sessions.get(key(id));q.onsuccess=()=>{try{ctx.result=decode(q.result,id);}catch(e){abort(e);}};
    });}
    function begin(header){
      const candidate=copy(header);
      insist(same(candidate.scope,scope)&&valid(candidate.id)&&valid(candidate.localProjectId)&&digest(candidate.bundleHash)&&
        digest(candidate.sourceFingerprint)&&Array.isArray(candidate.manifest)&&candidate.manifest.length>0&&
        candidate.manifest.every((m,i)=>m.index===i&&['json','blob'].includes(m.type)&&valid(m.key)&&digest(m.sha256)&&
          Number.isSafeInteger(m.size)&&m.size>=0), 'MIGRATION_FORMAT','移行控えの構成が不正です');
      return transact('readwrite',(sessions,items,ctx,abort)=>{
        const q=sessions.get(key(candidate.id));q.onsuccess=()=>{try{
          const previous=decode(q.result,candidate.id);
          if(previous){
            insist(previous.bundleHash===candidate.bundleHash&&previous.sourceFingerprint===candidate.sourceFingerprint&&
              previous.localProjectId===candidate.localProjectId&&canonical(previous.manifest)===canonical(candidate.manifest),
              'MIGRATION_SOURCE_CHANGED','同じ移行番号の元データが変わっています。既存の控えは上書きしません');
            ctx.result=previous;return;
          }
          ctx.result={version:1,id:candidate.id,scope:copy(scope),localProjectId:candidate.localProjectId,
            bundleHash:candidate.bundleHash,sourceFingerprint:candidate.sourceFingerprint,manifest:candidate.manifest,
            next:0,status:'copying',readyForActivation:false,readyForCloudSync:false,issues:[]};
          sessions.add(ctx.result,key(candidate.id));
        }catch(e){abort(e);}};
      });
    }
    function append(id,expectedNext,batch){
      const rows=copy(batch);
      insist(Number.isSafeInteger(expectedNext)&&expectedNext>=0&&Array.isArray(rows)&&rows.length>0&&rows.length<=64,
        'MIGRATION_FORMAT','コピーする範囲が不正です');
      return transact('readwrite',(sessions,items,ctx,abort)=>{
        const q=sessions.get(key(id));q.onsuccess=()=>{try{
          const row=decode(q.result,id);insist(row,'MIGRATION_MISSING','移行控えが見つかりません');
          insist(row.next===expectedNext,'MIGRATION_STALE','別の画面で移行が進んでいます');
          insist(row.status==='copying'&&row.next+rows.length<=row.manifest.length,'MIGRATION_STATE','控えの確定状態が一致しません');
          for(let i=0;i<rows.length;i++){
            const entry=rows[i],index=expectedNext+i,descriptor=row.manifest[index];
            insist(entry.index===index&&canonical(entry.descriptor)===canonical(descriptor)&&
              (descriptor.type==='json'?typeof entry.value==='string':entry.value instanceof root.Blob)&&
              (descriptor.type==='json'?new TextEncoder().encode(entry.value).byteLength:entry.value.size)===descriptor.size,
              'MIGRATION_ITEM','コピーするデータの識別情報が一致しません');
            // add + checkpoint share the transaction; a crash cannot skip a blob.
            items.add(entry,[prefix,id,index]);
          }
          row.next+=rows.length;ctx.result=row;sessions.put(row,key(id));
        }catch(e){abort(e);}};
      });
    }
    function readItems(id,start,limit=32){
      insist(Number.isSafeInteger(start)&&start>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=64,
        'MIGRATION_FORMAT','控えを読む範囲が不正です');
      return transact('readonly',(sessions,items,ctx,abort)=>{
        const q=sessions.get(key(id));q.onsuccess=()=>{try{
          const row=decode(q.result,id);insist(row,'MIGRATION_MISSING','移行控えが見つかりません');ctx.result=[];
          for(let i=start;i<Math.min(row.next,start+limit);i++){
            const r=items.get([prefix,id,i]);r.onsuccess=()=>{
              if(!r.result){abort(error('MIGRATION_ITEM_MISSING','コピー済みの内容が見つかりません'));return;}
              ctx.result[i-start]=r.result;
            };
          }
        }catch(e){abort(e);}};
      });
    }
    function finish(id,bundleHash,issues){
      const savedIssues=copy(issues);
      insist(Array.isArray(savedIssues),'MIGRATION_FORMAT','照合結果が不正です');
      return transact('readwrite',(sessions,items,ctx,abort)=>{
        const q=sessions.get(key(id));q.onsuccess=()=>{try{
          const row=decode(q.result,id);insist(row&&row.bundleHash===bundleHash&&row.next===row.manifest.length,
            'MIGRATION_INCOMPLETE','全部の内容を保存するまで控えを確定できません');
          row.status=savedIssues.some(x=>x.blocking!==false)?'needs-review':'verified-copy';
          row.issues=savedIssues;ctx.result=row;sessions.put(row,key(id));
        }catch(e){abort(e);}};
      });
    }
    function close(){closed=true;for(const [tx,ctx]of active){ctx.reason=error('MIGRATION_CLOSED','控えの保存処理を終了しました');try{tx.abort();}catch{}}
      if(db)db.close();db=null;}
    return {begin,status,append,readItems,finish,close,getScope:()=>copy(scope)};
  }
  function createCoordinator({source,store,localProjectId,currentScope,onProgress=()=>{},batchItems=16,batchBytes=8*1024*1024}={}){
    insist(source?.capture&&source?.recheck&&store?.getScope&&valid(localProjectId)&&typeof currentScope==='function',
      'MIGRATION_CONFIG','移行元と利用者を確認する方法が必要です');
    insist(Number.isSafeInteger(batchItems)&&batchItems>0&&batchItems<=64&&Number.isSafeInteger(batchBytes)&&batchBytes>0,
      'MIGRATION_CONFIG','コピーの分割条件が不正です');
    const scope=copy(store.getScope());let closed=false,flight=null;
    function check(){insist(!closed,'MIGRATION_CLOSED','移行控えの作成を終了しました');
      insist(same(currentScope(),scope),'MIGRATION_SCOPE_CHANGED','処理中に利用者・案件・端末が変わりました。元の記録は保持しています');}
    function progress(row){try{onProgress({id:row.id,status:row.status,copied:row.next,total:row.manifest.length,
      readyForActivation:false,readyForCloudSync:false});}catch{/* a display callback cannot undo a committed copy */}}
    async function prepare(id){
      check();const snapshot=copy(await source.capture(localProjectId));check();
      insist(snapshot?.version===1&&snapshot.kind==='sentlog-legacy-source'&&snapshot.projectId===localProjectId&&
        digest(snapshot.fingerprint)&&Array.isArray(snapshot.rawEntries)&&Array.isArray(snapshot.files)&&
        Array.isArray(snapshot.issues),'MIGRATION_SOURCE','旧版の控えを確認できません');
      const metadata=copy(snapshot);metadata.files=[];
      const keys=new Set(),items=[];
      for(const file of snapshot.files){
        const identity=JSON.stringify([file.kind,file.key]);
        insist(valid(file.key)&&valid(file.kind)&&!keys.has(identity)&&file.blob instanceof root.Blob&&
          file.size===file.blob.size&&digest(file.sha256),'MIGRATION_SOURCE','旧版の写真の識別情報が不正です');
        keys.add(identity);const actual=await hash(file.blob);check();
        insist(actual===file.sha256,'MIGRATION_FILE_CHANGED','コピー前に写真の内容が変わっています');
        const descriptor={...file};delete descriptor.blob;metadata.files.push(descriptor);
        items.push({descriptor:{type:'blob',key:identity,size:file.size,sha256:actual,mimeType:file.blob.type},value:file.blob});
      }
      const text=JSON.stringify(pack(metadata)),first={descriptor:{type:'json',encoding:'sentlog-value-v1',key:'legacy-snapshot',size:new TextEncoder().encode(text).byteLength,
        sha256:await hash(text)},value:text};check();items.unshift(first);
      items.forEach((item,index)=>{item.index=index;item.descriptor.index=index;});
      const manifest=items.map(x=>x.descriptor),bundleHash=await hash(canonical({scope,localProjectId,manifest,sourceFingerprint:snapshot.fingerprint}));check();
      return {snapshot,items,header:{id,scope,localProjectId,manifest,bundleHash,sourceFingerprint:snapshot.fingerprint}};
    }
    async function verify(row){
      insist(row.localProjectId===localProjectId,'MIGRATION_SCOPE','別の旧案件の控えは読み込めません');
      const expectedBundle=await hash(canonical({scope,localProjectId,manifest:row.manifest,sourceFingerprint:row.sourceFingerprint}));check();
      insist(expectedBundle===row.bundleHash,'MIGRATION_VERIFY','控えの構成が一致しません');
      for(let start=0;start<row.manifest.length;start+=batchItems){
        check();const items=await store.readItems(row.id,start,batchItems);check();
        insist(items.length===Math.min(batchItems,row.manifest.length-start),'MIGRATION_ITEM_MISSING','控えの内容が不足しています');
        for(let i=0;i<items.length;i++){
          const item=items[i],expected=row.manifest[start+i];
          insist(item.index===start+i&&canonical(item.descriptor)===canonical(expected),'MIGRATION_VERIFY','控えの並びや識別情報が違います');
          insist((expected.type==='json'?typeof item.value==='string':item.value instanceof root.Blob)&&
            (expected.type==='json'?new TextEncoder().encode(item.value).byteLength:item.value.size)===expected.size&&
            (expected.type!=='blob'||item.value.type===expected.mimeType),'MIGRATION_VERIFY','保存した控えのサイズや種類が違います');
          const actual=await hash(item.value);check();insist(actual===expected.sha256,'MIGRATION_VERIFY','保存した控えの内容が一致しません');
        }
      }
    }
    async function run(id){
      const {snapshot,items,header}=await prepare(id);check();let row=await store.begin(header);check();progress(row);
      while(row.next<items.length){
        check();let bytes=0,end=row.next;
        do{bytes+=items[end].descriptor.size;end++;}
        while(end<items.length&&end-row.next<batchItems&&bytes+items[end].descriptor.size<=batchBytes);
        try{row=await store.append(id,row.next,items.slice(row.next,end));}
        catch(e){
          if(e.code!=='MIGRATION_STALE')throw e;
          const latest=await store.status(id);
          insist(latest?.bundleHash===header.bundleHash,'MIGRATION_SOURCE_CHANGED','別の移行内容が保存されています');row=latest;
        }
        check();progress(row);
      }
      await verify(row);check();const rechecked=await source.recheck(snapshot);check();
      const issues=copy(snapshot.issues);
      const unchanged=rechecked?.unchanged===true&&rechecked.expectedFingerprint===snapshot.fingerprint&&rechecked.actualFingerprint===snapshot.fingerprint;
      if(snapshot.readyForStaging!==true&&!issues.some(x=>x.blocking!==false))
        issues.push({code:'MIGRATION_SOURCE_INCOMPLETE',blocking:true,message:'旧データの点検が完了していません'});
      if(!unchanged)
        issues.push({code:'MIGRATION_SOURCE_CHANGED',blocking:true,message:'コピー中に旧版の内容が変わりました。今回の控えと元データを保持しています'});
      row=await store.finish(id,header.bundleHash,issues);check();progress(row);
      return {...row,verifiedBytes:true,sourceUnchanged:unchanged};
    }
    return {
      stage(id){check();insist(valid(id),'MIGRATION_ID','移行番号が必要です');
        insist(!flight,'MIGRATION_BUSY','この画面では既にコピーを進めています');
        flight=run(id).finally(()=>{flight=null;});return flight;},
      async readCopy(id){
        check();const row=await store.status(id);check();
        insist(row&&row.next===row.manifest.length,'MIGRATION_INCOMPLETE','控えのコピーが完了していません');await verify(row);
        const first=(await store.readItems(id,0,1))[0];check();
        insist(first.descriptor.encoding==='sentlog-value-v1','MIGRATION_FORMAT','控えの復元形式が未対応です');
        const snapshot=unpack(JSON.parse(first.value)),descriptors=snapshot.files;snapshot.files=[];
        for(let start=1;start<row.manifest.length;start+=batchItems){
          const items=await store.readItems(id,start,batchItems);check();
          for(const item of items)snapshot.files.push({...descriptors[item.index-1],blob:item.value});
        }
        return {status:row.status,snapshot,readyForActivation:false,readyForCloudSync:false};
      },
      close(){closed=true;store.close();}
    };
  }
  const api={version:1,createStore,createCoordinator};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaMigration=api;
})(typeof window!=='undefined'?window:globalThis);

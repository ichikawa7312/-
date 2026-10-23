/* SentlogSyncTraffic v1.90. Only successful, content-specific receipts are cached.
 * This separate cache contains no photos, drawings, credentials, or record data.
 * All callers must verify durable local bytes BEFORE requesting an ACK.
 */
(function(root){
 'use strict';
 function durableStore(){
  let opening;
  function open(){
   if(!opening)opening=new Promise((resolve,reject)=>{
    const q=root.indexedDB.open('sentlogSyncTrafficV1',1);
    q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('acks'))q.result.createObjectStore('acks');};
    q.onsuccess=()=>{const db=q.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
    q.onerror=()=>{opening=null;reject(q.error||Error('ACK cache unavailable'));};
    q.onblocked=()=>{opening=null;reject(Error('ACK cache blocked'));};
   });
   return opening;
  }
  async function operation(key,write,value){
   const db=await open();
   return new Promise((resolve,reject)=>{
    const tx=db.transaction('acks',write?'readwrite':'readonly'),s=tx.objectStore('acks');
    const q=write?(value===undefined?s.delete(key):s.put(value,key)):s.get(key);let result;
    q.onsuccess=()=>{result=q.result;};
    tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(tx.error||Error('ACK cache aborted'));
   });
  }
  return {get:key=>operation(key,false),put:(key,value)=>operation(key,true,value),remove:key=>operation(key,true)};
 }
 function create({store,owner,locks,now=()=>Date.now()}={}){
  const successful=new Set(),failed=new Map(),queues=new Map();
  store=store||durableStore();
  owner=owner||(()=>{try{return JSON.parse(root.localStorage.getItem('sentlogCloudSessionV1')||'null')?.user?.id||'';}catch{return '';}});
  locks=locks===undefined?root.navigator?.locks:locks;
  function key(kind,a,id){
   const user=owner(),sha=String(a?.sha256||'').toLowerCase(),size=Number(a?.byte_size);
   if(!user||!id||!a?.id||!['photo','pdf','asset'].includes(kind)||! /^[a-f0-9]{64}$/.test(sha)||!Number.isSafeInteger(size)||size<0)
    throw Error('受取確認に必要な端末・ファイル情報を確認できません。');
   return JSON.stringify(['wiulvaqixphuobdielyy',user,id,kind,a.id,sha,size,String(a.storage_path||'')]);
  }
  function exclusive(name,fn){
   const previous=queues.get(name)||Promise.resolve();
   const next=previous.catch(()=>{}).then(()=>locks?.request?locks.request(name,fn):fn());
   queues.set(name,next);
   const release=()=>{if(queues.get(name)===next)queues.delete(name);};
   next.then(release,release);return next;
  }
  async function forget(kind,a,id){
   const k=key(kind,a,id);
   return exclusive('sentlog-ack:'+k,async()=>{successful.delete(k);failed.delete(k);try{await store.remove(k);}catch{}});
  }
  async function ack(kind,a,id,send,{force=false}={}){
   const k=key(kind,a,id),user=owner();
   return exclusive('sentlog-ack:'+k,async()=>{
    if(owner()!==user)throw Error('ログインが変更されました。同期をやり直してください。');
    if(force){successful.delete(k);try{await store.remove(k);}catch{}}
    if(!force){
     if(successful.has(k))return {received:true,cached:true};
     try{if(await store.get(k)){successful.add(k);return {received:true,cached:true};}}catch{}
    }
    const failure=failed.get(k);
    if(failure&&now()<failure.until)throw failure.error;
    const args={p_asset_id:a.id,p_device_id:id};
    if(kind!=='asset'){args.p_sha256=String(a.sha256).toLowerCase();args.p_byte_size=Number(a.byte_size);}
    try{
     const result=await send(args);
     if(result?.received!==true)throw Error('サーバーの受取確認が完了していません。');
     if(owner()!==user)throw Error('ログインが変更されました。同期をやり直してください。');
     successful.add(k);failed.delete(k);
     if(successful.size>10000)successful.delete(successful.values().next().value);
     try{await store.put(k,now()||1);}catch{} // Never turn a failed cache write into a false remote failure.
     return result;
    }catch(error){failed.set(k,{until:now()+30000,error});throw error;}
   });
  }
  function withFileLock(fileKey,fn){
   const user=owner();
   if(!user)return Promise.reject(Error('ログインを確認してください。'));
   return exclusive('sentlog-file:'+JSON.stringify([user,fileKey]),()=>{
    if(owner()!==user)throw Error('ログインが変更されました。同期をやり直してください。');
    return fn();
   });
  }
  return {ack,forget,withFileLock};
 }
 root.SentlogSyncTraffic={version:'v1.90',create,...create()};
})(typeof window==='object'?window:globalThis);

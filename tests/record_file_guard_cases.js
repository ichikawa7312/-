/* Runs only against the disposable test origin / fake IndexedDB. */
(function(root){
 'use strict';
 async function run(){
  const S=root.SentlogRecords,results=[];let serial=0;
  const assert=(ok,message)=>{if(!ok)throw Error(message||'assertion failed');};
  const equal=(a,b,message)=>assert(a===b,message||String(a)+' !== '+String(b));
  const key=()=>`photo:guard-test:${++serial}`;
  const blob=text=>new Blob([text],{type:'image/jpeg'});
  async function rejected(task,code){let error;try{await task();}catch(e){error=e;}assert(error,'expected failure '+code);
   if(code)assert(error.code===code||error.name===code,'expected '+code+', got '+(error.code||error.name));return error;}
  async function read(k){
   const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('surveyFieldNoteDB');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
   try{return await new Promise((resolve,reject)=>{const tx=db.transaction('files','readonly'),q=tx.objectStore('files').get(k);let value;
    q.onsuccess=()=>{value=q.result;};tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  async function test(name,fn){try{await fn();results.push(name);}catch(cause){throw new Error(name+': '+String(cause?.message||cause),{cause});}}
  function inject(method,k,fn){const original=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){
   const request=original.apply(this,args);if(this.transaction.db.name==='surveyFieldNoteDB'&&args[method==='get'?0:1]===k)fn(this,request);return request;
  };return ()=>{IDBObjectStore.prototype[method]=original;};}
  await S.init();
  await test('legacy two-argument writes keep their return value and durable bytes',async()=>{
   const k=key();equal(await S.writeFile(k,blob('legacy')),undefined);equal(await (await read(k)).text(),'legacy');
  });
  await test('guarded writes advertise and enforce only-if-missing semantics',async()=>{
   assert(S.getFileWriteCapabilities().guarded&&S.getFileWriteCapabilities().onlyIfMissing);
   const k=key(),first=await S.writeFile(k,blob('first'),{onlyIfMissing:true,validate:()=>true});assert(first.written);
   const again=await S.writeFile(k,blob('different'),{onlyIfMissing:true,validate:()=>true});assert(!again.written);
   equal(await again.value.text(),'first');equal(await (await read(k)).text(),'first');
  });
  await test('competing guarded downloads return the single winning file without replacement',async()=>{
   const k=key(),values=await Promise.all(['one','two'].map(v=>S.writeFile(k,blob(v),{onlyIfMissing:true,validate:()=>true})));
   equal(values.filter(x=>x.written).length,1);equal(await values[0].value.text(),await values[1].value.text());
   equal(await (await read(k)).text(),await values[0].value.text());
  });
  await test('an unexpected stored value is preserved for caller verification',async()=>{
   const k=key();await S.writeFile(k,{unexpected:'keep'});const result=await S.writeFile(k,blob('new'),{onlyIfMissing:true,validate:()=>true});
   assert(!result.written);equal(result.value.unexpected,'keep');equal((await read(k)).unexpected,'keep');
  });
  await test('a false guard fails before storage and never enters legacy retry or leaves a pending task',async()=>{
   const k=key();await rejected(()=>S.writeFile(k,blob('private'),{onlyIfMissing:true,validate:()=>false}),'FILE_WRITE_GUARD');
   equal(await read(k),undefined);assert(!S.uncommittedFiles().some(x=>x.key===k));assert(!S.pending,'rejected guard left a pending file task');
   await S.settled();await S.retry();equal(await read(k),undefined);
  });
  await test('guard exceptions keep their exact reason and do not revive after retry',async()=>{
   const k=key(),reason=Object.assign(Error('account changed'),{code:'AUTH_CHANGED'});
   equal(await rejected(()=>S.writeFile(k,blob('private'),{validate:()=>{throw reason;}}),'AUTH_CHANGED'),reason);
   await S.retry();equal(await read(k),undefined);
  });
  await test('an asynchronous guard cannot accidentally authorize an enqueue',async()=>{
   for(const validate of [async()=>true,async()=>{throw Error('async failure');}]){
    const k=key();await rejected(()=>S.writeFile(k,blob('private'),{validate}),'FILE_WRITE_GUARD');equal(await read(k),undefined);
   }
  });
  await test('cancellation before the operation cannot create a local photo',async()=>{
   const k=key(),controller=new AbortController();controller.abort();
   await rejected(()=>S.writeFile(k,blob('new'),{signal:controller.signal,onlyIfMissing:true,validate:()=>true}),'FILE_WRITE_ABORTED');equal(await read(k),undefined);
  });
  await test('a guard lost before the existing-file check prevents the write',async()=>{
   const k=key();let valid=true;const restore=inject('get',k,()=>{valid=false;});
   try{await rejected(()=>S.writeFile(k,blob('new'),{onlyIfMissing:true,validate:()=>valid}),'FILE_WRITE_GUARD');}finally{restore();}
   equal(await read(k),undefined);assert(!S.uncommittedFiles().some(x=>x.key===k));
  });
  await test('a guard lost after enqueue aborts before the transaction commits',async()=>{
   const k=key();let valid=true;const restore=inject('put',k,()=>{valid=false;});
   try{await rejected(()=>S.writeFile(k,blob('new'),{onlyIfMissing:true,validate:()=>valid}),'FILE_WRITE_GUARD');}finally{restore();}
   equal(await read(k),undefined);assert(!S.uncommittedFiles().some(x=>x.key===k));
  });
  await test('an abort signal during enqueue rolls back bytes and avoids automatic legacy replay',async()=>{
   const k=key(),controller=new AbortController(),restore=inject('put',k,()=>controller.abort());
   try{await rejected(()=>S.writeFile(k,blob('new'),{onlyIfMissing:true,validate:()=>true,signal:controller.signal}),'FILE_WRITE_ABORTED');}finally{restore();}
   equal(await read(k),undefined);await S.retry();equal(await read(k),undefined);
  });
  await test('an aborted guarded replacement preserves the prior complete image',async()=>{
   const k=key();await S.writeFile(k,blob('existing'));let valid=true;const restore=inject('put',k,()=>{valid=false;});
   try{await rejected(()=>S.writeFile(k,blob('replacement'),{validate:()=>valid}),'FILE_WRITE_GUARD');}finally{restore();}
   equal(await (await read(k)).text(),'existing');
  });
  await test('quota failure keeps guarded transfers out of the unconditional retry queue',async()=>{
   const k=key(),native=IDBObjectStore.prototype.put;
   IDBObjectStore.prototype.put=function(...args){if(args[1]===k)throw new DOMException('injected quota','QuotaExceededError');return native.apply(this,args);};
   try{await rejected(()=>S.writeFile(k,blob('new'),{onlyIfMissing:true,validate:()=>true}),'QuotaExceededError');}finally{IDBObjectStore.prototype.put=native;}
   equal(await read(k),undefined);assert(!S.uncommittedFiles().some(x=>x.key===k));
   assert((await S.writeFile(k,blob('new'),{onlyIfMissing:true,validate:()=>true})).written);
  });
  await test('a guarded cache hit cannot discard a different pending legacy photo',async()=>{
   const k=key(),pending=blob('legacy pending'),native=IDBObjectStore.prototype.put;
   await S.writeFile(k,blob('already saved'));
   IDBObjectStore.prototype.put=function(...args){if(args[1]===k)throw new DOMException('injected quota','QuotaExceededError');return native.apply(this,args);};
   try{await rejected(()=>S.writeFile(k,pending),'QuotaExceededError');}finally{IDBObjectStore.prototype.put=native;}
   const result=await S.writeFile(k,blob('incoming'),{onlyIfMissing:true,validate:()=>true});assert(!result.written);
   equal(await S.uncommittedFiles().find(x=>x.key===k).value.text(),'legacy pending');
   equal(await (await read(k)).text(),'already saved');await S.retry();equal(await (await read(k)).text(),'legacy pending');
  });
  return results;
 }
 if(typeof module==='object'&&module.exports)module.exports=run;else root.runRecordFileGuardCases=run;
})(typeof window==='undefined'?globalThis:window);

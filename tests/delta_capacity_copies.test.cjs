'use strict';
const assert=require('node:assert/strict'),fake=require('fake-indexeddb');
if(!globalThis.crypto?.subtle)globalThis.crypto=require('node:crypto').webcrypto;
const M=require('../sentlog/delta-sync-migration.js'),A=require('../sentlog/delta-sync-assets.js'),AR=require('../sentlog/delta-sync-asset-runtime.js'),C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const indexedDB=new fake.IDBFactory(),copy=x=>structuredClone(x),scope={ownerId:'owner',projectId:'project',deviceId:'device'},localProjectId='local';
const certificate={schema:1,projectId:scope.projectId,headSeq:42,revision:5,payloadSha256:'a'.repeat(64),checkpointId:'checkpoint'};
let serial=0,checks=0;
async function hash(blob){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function proof(files,more={}){return {localProjectId,certificate:copy(certificate),jobId:'job',operationId:'release',files:copy(files),validate:()=>true,...more};}
async function test(name,run){await run();checks++;console.log('PASS '+name);}
async function raw(name,storeName,key,mutate){
 const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name,1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction(storeName,'readwrite'),store=tx.objectStore(storeName),q=store.get(key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);q.onsuccess=()=>{store.put(mutate(q.result),key);};});}finally{db.close();}
}
async function afterNextHash(action,run){
 const previous=crypto.subtle.digest;let fired=false;crypto.subtle.digest=async function(...args){const value=await previous.apply(this,args);if(!fired){fired=true;await action();}return value;};
 try{return await run();}finally{crypto.subtle.digest=previous;}
}
async function migration(){
 const name='sentlog-delta-test-copy-gc-'+(++serial),files=[];
 for(const [kind,key,text,type]of [['photo','photo:drawing:photo','shared photo','image/jpeg'],['background','background:drawing','drawing bytes','application/pdf'],['original-photo','original:drawing:photo','original bytes','image/jpeg']]){
  const blob=new Blob([text],{type});files.push({kind,key,drawingId:'drawing',photoId:'photo',blob,size:blob.size,sha256:await hash(blob)});
 }
 const snapshot={version:1,kind:'sentlog-legacy-source',projectId:localProjectId,rawEntries:[{key:'workspace',value:'unchanged'}],files,issues:[],fingerprint:'b'.repeat(64),readyForStaging:true};
 const source={capture:async()=>copy(snapshot),recheck:async()=>({unchanged:true,expectedFingerprint:snapshot.fingerprint,actualFingerprint:snapshot.fingerprint,issues:[]})},store=M.createStore({...scope,indexedDB,databaseName:name}),coordinator=M.createCoordinator({source,store,localProjectId,currentScope:()=>scope});
 const session=await coordinator.stage('stage'),catalog=files.slice(0,2).map((file,i)=>({key:file.key,assetId:'asset-'+i,kind:file.kind==='background'?'drawing':'photo',sha256:file.sha256,size:file.size,mimeType:file.blob.type}));
 return {name,store,coordinator,session,catalog,snapshot,itemKey:index=>[JSON.stringify(Object.values(scope)),'stage',index],close:()=>coordinator.close()};
}
async function asset({acknowledged=true,assetId='photo-asset'}={}){
 const name='sentlog-delta-assets-test-copy-gc-'+(++serial),blob=new Blob(['shared photo'],{type:'image/jpeg'}),ref={ownerId:scope.ownerId,projectId:scope.projectId,assetId,drawingId:'drawing',photoId:'photo',variant:'shared',sha256:await hash(blob),size:blob.size,mimeType:blob.type};
 const store=A.createIndexedDBStore({...scope,indexedDB,databaseName:name});await store.ensure(ref);await store.received(ref,blob);
 const receipt={...copy(ref),deviceId:scope.deviceId,durable:true};if(acknowledged)await store.acknowledged(ref,receipt);
 const catalog=[{key:'photo:drawing:photo',assetId:ref.assetId,kind:'photo',sha256:ref.sha256,size:ref.size,mimeType:ref.mimeType}];
 return {name,store,blob,ref,receipt,catalog,key:JSON.stringify([...Object.values(scope),ref.assetId]),close:()=>store.close()};
}
(async()=>{
 await test('sealed migration releases only certified background/shared copies and retains metadata and originals',async()=>{
  const f=await migration();try{const prior=await f.store.readItems('stage',0,4),result=await f.store.releaseArchivedCopies(proof(f.catalog));assert.deepEqual(result,{releasedCopies:2,releasedBytes:f.catalog.reduce((n,x)=>n+x.size,0)});
   const row=await f.store.status('stage'),items=await f.store.readItems('stage',0,4);assert.equal(row.status,'archived-copy');assert.deepEqual(row.manifest,f.session.manifest);assert.equal(items[0].value,prior[0].value);assert.equal(items[1].value,null);assert.equal(items[2].value,null);assert.equal(await items[3].value.text(),'original bytes');assert.deepEqual(items[1].archiveRelease.certificate,certificate);assert.equal(f.snapshot.rawEntries[0].value,'unchanged');
   await assert.rejects(()=>f.coordinator.readCopy('stage'),{code:'MIGRATION_ARCHIVED_COPY'});await assert.rejects(()=>f.coordinator.stage('stage'),{code:'MIGRATION_ARCHIVED_COPY'});
   assert.deepEqual(await f.store.releaseArchivedCopies(proof(f.catalog)),{releasedCopies:0,releasedBytes:0});
  }finally{f.close();}
 });
 await test('migration skips unsealed review state and other local-project copies',async()=>{
  const f=await migration();try{assert.deepEqual(await f.store.releaseArchivedCopies(proof(f.catalog,{localProjectId:'another-local'})),{releasedCopies:0,releasedBytes:0});await f.store.finish('stage',f.session.bundleHash,[{blocking:true,code:'manual-review'}]);assert.deepEqual(await f.store.releaseArchivedCopies(proof(f.catalog)),{releasedCopies:0,releasedBytes:0});assert((await f.store.readItems('stage',1,1))[0].value instanceof Blob);}finally{f.close();}
 });
 await test('migration retains old copies whose hash, size or key differs from the certified catalog',async()=>{
  const f=await migration();try{const files=copy(f.catalog);files[0].sha256='c'.repeat(64);files[1].key='background:other';assert.deepEqual(await f.store.releaseArchivedCopies(proof(files)),{releasedCopies:0,releasedBytes:0});assert((await f.store.readItems('stage',1,2)).every(x=>x.value instanceof Blob));}finally{f.close();}
 });
 await test('migration verifies actual Blob bytes before releasing any selected copy',async()=>{
  const f=await migration();try{await raw(f.name,'items',f.itemKey(2),row=>({...row,value:new Blob(['X'.repeat(row.value.size)],{type:row.value.type})}));await assert.rejects(()=>f.store.releaseArchivedCopies(proof(f.catalog)),{code:'MIGRATION_VERIFY'});assert.equal((await f.store.status('stage')).status,'verified-copy');assert((await f.store.readItems('stage',1,2)).every(x=>x.value instanceof Blob));}finally{f.close();}
 });
 await test('migration sealed-session CAS rejects another tab changing review state after hashing',async()=>{
  const f=await migration();try{await afterNextHash(()=>f.store.finish('stage',f.session.bundleHash,[{blocking:true,code:'late-review'}]),()=>assert.rejects(()=>f.store.releaseArchivedCopies(proof(f.catalog)),{code:'MIGRATION_ARCHIVE_STALE'}));assert((await f.store.readItems('stage',1,2)).every(x=>x.value instanceof Blob));}finally{f.close();}
 });
 await test('migration repeats the synchronous account guard inside the deletion transaction',async()=>{
  const f=await migration(),original=fake.IDBObjectStore.prototype.put;let allowed=true;
  try{fake.IDBObjectStore.prototype.put=function(value,...args){if(this.name==='items'&&value.value===null)allowed=false;return original.call(this,value,...args);};await assert.rejects(()=>f.store.releaseArchivedCopies(proof(f.catalog,{validate:()=>allowed})),{code:'MIGRATION_ARCHIVE_CONTEXT'});fake.IDBObjectStore.prototype.put=original;assert.equal((await f.store.status('stage')).status,'verified-copy');assert((await f.store.readItems('stage',1,2)).every(x=>x.value instanceof Blob));}finally{fake.IDBObjectStore.prototype.put=original;f.close();}
 });
 await test('asset release retains exact receipts and makes archived bytes explicit and retryable',async()=>{
  const f=await asset();try{const prior=await f.store.read(f.ref);assert.deepEqual(await f.store.releaseArchivedCopies(proof(f.catalog)),{releasedCopies:1,releasedBytes:f.blob.size});const row=await f.store.read(f.ref);assert.equal(row.phase,'archived');assert.equal(row.blob,null);assert.deepEqual(row.localReceipt,prior.localReceipt);assert.deepEqual(row.remoteReceipt,prior.remoteReceipt);assert.equal(row.revision,prior.revision+1);assert.deepEqual(row.archiveRelease.certificate,certificate);assert.equal((await f.store.ensure(f.ref)).phase,'archived');assert.deepEqual(await f.store.releaseArchivedCopies(proof(f.catalog)),{releasedCopies:0,releasedBytes:0});await assert.rejects(()=>f.store.acknowledged(f.ref,f.receipt),{code:'ASSET_NOT_DURABLE'});}finally{f.close();}
 });
 await test('archived assets require explicit verified restoration and retain release evidence after rehydration',async()=>{
  const f=await asset();try{await f.store.releaseArchivedCopies(proof(f.catalog));await assert.rejects(()=>f.store.received(f.ref,f.blob),{code:'ASSET_ARCHIVED_COPY'});await assert.rejects(()=>f.store.received(f.ref,new Blob(['bad bytes'],{type:f.blob.type}),{restoreArchived:true}),{code:'ASSET_CONTENT_MISMATCH'});await f.store.received(f.ref,f.blob,{restoreArchived:true});const row=await f.store.read(f.ref);assert.equal(row.phase,'received');assert.equal(await row.blob.text(),await f.blob.text());assert(row.archiveRelease);assert.equal(row.remoteReceipt,null);await f.store.acknowledged(f.ref,f.receipt);assert.equal((await f.store.read(f.ref)).phase,'acknowledged');}finally{f.close();}
 });
 await test('queue leaves archived assets pending until the guarded restore path is enabled',async()=>{
  const f=await asset();let queue,downloads=0;const transport={online:()=>true,download:async()=>{downloads++;return f.blob;},acknowledge:async()=>f.receipt};
  try{await f.store.releaseArchivedCopies(proof(f.catalog));queue=A.createQueue({scope,store:f.store,transport,currentScope:()=>scope});const pending=await queue.ensure([f.ref]);assert.equal(pending.archived,1);assert.equal(pending.pending,1);assert.equal(pending.complete,false);await assert.rejects(()=>queue.sync([f.ref]),{code:'ASSET_ARCHIVED_COPY'});assert.equal(downloads,0);queue.close();queue=A.createQueue({scope,store:f.store,transport,currentScope:()=>scope,allowArchivedRestore:true});const restored=await queue.sync([f.ref]);assert.equal(restored.complete,true);assert.equal(restored.archived,0);assert.equal(downloads,1);}finally{queue?.close();f.close();}
 });
 await test('asset release excludes originals and catalog mismatches without altering their bytes',async()=>{
  const f=await asset();try{const original={...f.ref,assetId:'original-asset',variant:'original'};await f.store.ensure(original);await f.store.received(original,f.blob);const wrong=copy(f.catalog);wrong[0].assetId=original.assetId;assert.deepEqual(await f.store.releaseArchivedCopies(proof(wrong)),{releasedCopies:0,releasedBytes:0});wrong[0].assetId=f.ref.assetId;wrong[0].key='photo:other:photo';assert.deepEqual(await f.store.releaseArchivedCopies(proof(wrong)),{releasedCopies:0,releasedBytes:0});assert((await f.store.read(original)).blob instanceof Blob);assert((await f.store.read(f.ref)).blob instanceof Blob);}finally{f.close();}
 });
 await test('actual asset runtime restores an archived store through the guarded mirror and receipt path',async()=>{
  const f=await asset({assetId:'20000000-0000-4000-8000-000000000001'}),files=new Map(),token=Object.freeze({});let runtime,downloads=0,acks=0;
  const row={id:f.ref.assetId,owner_id:scope.ownerId,project_id:scope.projectId,kind:'photo',client_key:'photo:drawing:photo',status:'uploaded',metadata:{drawing_id:'drawing',photo_id:'photo'},sha256:f.ref.sha256,byte_size:f.ref.size,mime_type:f.ref.mimeType};
  const transport={getScope:()=>scope,online:()=>true,listPhotos:async()=>[row],uploadPhoto:async()=>{throw Error('unexpected upload');},download:async()=>{downloads++;return f.blob;},acknowledge:async()=>{acks++;assert.equal(await files.get('photo:drawing:photo').text(),await f.blob.text());return f.receipt;}};
  const localFiles={getCapabilities:()=>({guarded:true,onlyIfMissing:true}),assertExclusive:()=>true,read:async key=>files.get(key),withLock:async(key,run)=>run(),write:async(key,blob,options)=>{options.validate();assert.equal(options.onlyIfMissing,true);const written=!files.has(key);if(written)files.set(key,blob);return {written,value:files.get(key)};}};
  try{await f.store.releaseArchivedCopies(proof(f.catalog));runtime=AR.createRuntime({scope,transport,store:f.store,localFiles,currentScope:()=>scope,currentSnapshotToken:()=>token,authGeneration:()=>0,subscribeAuth:()=>()=>{},allowArchivedRestore:true});
   const snapshot={version:2,scope:copy(scope),cursor:0,outbox:[],records:{[D.keyOf('drawing','record')]:C.upgrade({id:'record',memo:'',photos:[{id:'photo',sha256:f.ref.sha256,size:f.ref.size,type:f.ref.mimeType}]})}};
   const result=await runtime.sync({snapshot,snapshotToken:token});assert.equal(result.complete,true,JSON.stringify(result.issues));assert.equal(downloads,1);assert.equal(acks,1);assert.equal((await f.store.read(f.ref)).phase,'acknowledged');assert.equal(await files.get('photo:drawing:photo').text(),await f.blob.text());
  }finally{runtime?.close();f.close();}
 });
 await test('asset release hashes stored bytes and preserves corrupt rows for review',async()=>{
  const f=await asset();try{await raw(f.name,'assets',f.key,row=>({...row,blob:new Blob(['X'.repeat(row.blob.size)],{type:row.blob.type})}));await assert.rejects(()=>f.store.releaseArchivedCopies(proof(f.catalog)),{code:'ASSET_CONTENT_MISMATCH'});assert((await f.store.read(f.ref)).blob instanceof Blob);}finally{f.close();}
 });
 await test('asset revision CAS preserves a receipt received by another tab while the blob was hashing',async()=>{
  const f=await asset({acknowledged:false});try{await afterNextHash(()=>f.store.acknowledged(f.ref,f.receipt),()=>assert.rejects(()=>f.store.releaseArchivedCopies(proof(f.catalog)),{code:'ASSET_ARCHIVE_STALE'}));const row=await f.store.read(f.ref);assert.equal(row.phase,'acknowledged');assert(row.blob instanceof Blob);}finally{f.close();}
 });
 await test('asset deletion aborts when the account guard changes before its transaction commits',async()=>{
  const f=await asset(),original=fake.IDBObjectStore.prototype.put;let allowed=true;
  try{fake.IDBObjectStore.prototype.put=function(value,...args){if(this.name==='assets'&&value.phase==='archived')allowed=false;return original.call(this,value,...args);};await assert.rejects(()=>f.store.releaseArchivedCopies(proof(f.catalog,{validate:()=>allowed})),{code:'ASSET_ARCHIVE_CONTEXT'});fake.IDBObjectStore.prototype.put=original;assert.equal((await f.store.read(f.ref)).phase,'acknowledged');assert((await f.store.read(f.ref)).blob instanceof Blob);}finally{fake.IDBObjectStore.prototype.put=original;f.close();}
 });
 await test('both stores reject foreign certificates and asynchronous or missing approval guards',async()=>{
  const m=await migration(),a=await asset();try{for(const [f,prefix]of [[m,'MIGRATION'],[a,'ASSET']]){
    await assert.rejects(()=>f.store.releaseArchivedCopies(proof(f.catalog,{certificate:{...certificate,projectId:'other'}})),{code:prefix+'_ARCHIVE_PROOF'});
    for(const validate of [()=>undefined,()=>false,()=>Promise.reject(Error('async guard'))])await assert.rejects(()=>f.store.releaseArchivedCopies(proof(f.catalog,{validate})),{code:prefix+'_ARCHIVE_CONTEXT'});
   }assert((await m.store.readItems('stage',1,1))[0].value instanceof Blob);assert((await a.store.read(a.ref)).blob instanceof Blob);
  }finally{m.close();a.close();}
 });
 console.log('PASS certified redundant copy release: '+checks+' checks');
})().catch(error=>{console.error(error);process.exitCode=1;});

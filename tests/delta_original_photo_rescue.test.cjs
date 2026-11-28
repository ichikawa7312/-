'use strict';
// A real photo delivery queue, hashed in IndexedDB, with a synthetic server.
// No real account, original photo, or Supabase project is touched.
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const {IDBFactory}=require('fake-indexeddb');
const D=require('../sentlog/delta-sync-core.js');
const C=require('../sentlog/record-collaboration.js');
const A=require('../sentlog/delta-sync-assets.js');
const AR=require('../sentlog/delta-sync-asset-runtime.js');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const scope={ownerId:'11111111-1111-4111-8111-111111111111',
  projectId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const assetId='44444444-4444-4444-8444-444444444444';
const key='photo:drawing:photo';
const bytes=new Blob([new Uint8Array([255,216,255,224,8,21,0,9,88,99])],{type:'image/jpeg'});
const sha=async blob=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer()))]
  .map(x=>x.toString(16).padStart(2,'0')).join('');
let serial=0;
async function fixture({recoverShared=null,localBlob=null}={}){
 const digest=await sha(bytes),snapshotToken={revision:1};
 const record=C.upgrade({id:'record',type:'ひび割れ',memo:'',photos:[{
   id:'photo',name:'証拠写真.jpg',sha256:digest,size:bytes.size,type:bytes.type}]});
 const snapshot={version:2,scope,cursor:0,records:{[D.keyOf('drawing','record')]:record},outbox:[]};
 D.validateState(snapshot,scope,true);
 const asset={id:assetId,owner_id:scope.ownerId,project_id:scope.projectId,client_key:key,
   kind:'photo',file_name:'証拠写真.jpg',sha256:digest,byte_size:bytes.size,
   mime_type:bytes.type,status:'uploaded',storage_path:scope.ownerId+'/'+scope.projectId+'/photos/'+assetId+'.jpg',
   metadata:{drawing_id:'drawing',photo_id:'photo'}};
 const factory=new IDBFactory(),store=A.createIndexedDBStore({...scope,indexedDB:factory,
   databaseName:'sentlog-delta-assets-test-original-rescue-'+(++serial)});
 const files=new Map(localBlob?[ [key,localBlob] ]:[]),calls={reads:0,writes:0,upload:0,ack:0,download:0,recover:0,received:0};
 const localFiles={
   async read(k){calls.reads++;return files.get(k);},
   async write(k,blob,opts){assert.equal(opts.onlyIfMissing,true);assert.equal(files.has(k),false);
     files.set(k,blob);calls.writes++;return {written:true,value:blob};},
   async withLock(k,fn){assert.equal(k,key);return fn();},
   assertExclusive:()=>true,
   getCapabilities:()=>({guarded:true,onlyIfMissing:true})
 };
 const transport={getScope:()=>scope,online:()=>true,
   async listPhotos(){return [];},
   async uploadPhoto(item,blob){calls.upload++;assert.equal(item.photoId,'photo');
     assert.equal(await sha(blob),digest);return {asset,uploaded:true};},
   async download(){calls.download++;return bytes;},
   async acknowledge(ref){calls.ack++;return {...ref,deviceId:scope.deviceId,durable:true};}
 };
 const runtime=AR.createRuntime({scope,transport,store,localFiles,currentScope:()=>scope,
   currentSnapshotToken:()=>snapshotToken,authGeneration:()=>1,subscribeAuth:()=>()=>{},
   onPhotoReceived:()=>{calls.received++;},
   recoverShared:recoverShared?(item,options)=>{calls.recover++;return recoverShared(item,options);}:null});
 return {runtime,store,files,calls,asset,snapshot,snapshotToken,digest,
   async run(){return runtime.sync({snapshot,snapshotToken});},close(){runtime.close();store.close();}};
}
async function test(label,fn){await fn();console.log('PASS '+label);}
(async()=>{
 await test('missing shared bytes can be rebuilt only from a verified original, then journaled before upload',async()=>{
   const f=await fixture({recoverShared:async(item,{scope:owner,validate})=>{
     validate();assert.equal(item.recordId,'record');assert.equal(owner.projectId,scope.projectId);
     return bytes;}});
   try{
     const result=await f.run();
     assert.equal(result.complete,true,JSON.stringify(result.issues));
     assert.equal(result.pending,0);
     assert.equal(f.calls.recover,1);assert.equal(f.calls.writes,1);
     assert.equal(f.calls.upload,1);assert.equal(f.calls.ack,1);
     assert.equal(await sha(f.files.get(key)),f.digest);
     assert.equal(f.calls.received,1);
   }finally{f.close();}
 });
 await test('a reencoded original with a different hash never reaches storage or server',async()=>{
   const f=await fixture({recoverShared:async()=>new Blob(['changed content'],{type:'image/jpeg'})});
   try{
     const result=await f.run();
     assert.equal(result.complete,false);
     assert.equal(result.pending,1);
     assert.equal(f.calls.upload,0);assert.equal(f.calls.writes,0);
     assert.equal(f.files.has(key),false);
     assert(result.issues.some(x=>x.code==='ASSET_CONTENT_MISMATCH'));
   }finally{f.close();}
 });
 await test('missing original remains explicitly pending without inventing receipt or content',async()=>{
   const f=await fixture({recoverShared:async()=>undefined});
   try{
     const result=await f.run();
     assert.equal(result.complete,false);
     assert.equal(result.pending,1);
     assert.equal(f.calls.upload,0);assert.equal(f.calls.ack,0);assert.equal(f.calls.writes,0);
     assert.equal(f.files.size,0);
   }finally{f.close();}
 });
 await test('an already intact shared file is never reconstructed or overwritten',async()=>{
   const f=await fixture({recoverShared:async()=>{throw Error('not needed');},localBlob:bytes});
   try{
     const result=await f.run();assert.equal(result.complete,true);
     assert.equal(f.calls.recover,0);assert.equal(f.calls.writes,0);assert.equal(f.calls.upload,1);
   }finally{f.close();}
 });
 console.log('4 original/shared preservation and delivery scenarios passed');
})().catch(err=>{console.error(err);process.exitCode=1;});

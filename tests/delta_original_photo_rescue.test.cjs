'use strict';
// A real photo delivery queue, hashed in IndexedDB, with a synthetic server.
// No real account, original photo, or Supabase project is touched.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
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
 await test('real recovery helper accepts only the capturing account, project, record and historical SHA',async()=>{
   const source=fs.readFileSync('sentlog/delta-sync-cloud-runtime.txt','utf8');
   const start=source.indexOf('async function sentlogDeltaRecoverSharedOriginal(');
   const end=source.indexOf('const sentlogDeltaApp=',start);
   assert(start>=0&&end>start,'production helper is present');
   const cp={id:scope.projectId,client_key:'local-photo-project',status:'active'};
   const original={projectId:cp.client_key,drawingId:'drawing',photoId:'photo',
     recordId:'record',ownerId:scope.ownerId};
   const meta={projectId:cp.client_key,drawingId:'drawing',photoId:'photo',
     size:bytes.size,type:bytes.type,originalRevision:'preserved-original-revision',
     photoAssociation:{version:1,photoId:'photo',status:'attached',target:original}};
   const item={drawingId:'drawing',photoId:'photo',recordId:'record',mimeType:bytes.type,
     size:bytes.size,sha256:await sha(bytes)};
   let originals=0,reencodes=0,validations=0;
   const api={getOriginalMeta:async()=>meta,getOriginal:async()=>{originals++;return bytes;},
      makeSharedPhoto:async()=>{reencodes++;return bytes;}};
   const context={window:{SentlogOriginalPhotos:api},navigator:{onLine:true},
     session:{user:{id:scope.ownerId}},Blob,sha256Hex:sha,Error,Number};
   vm.createContext(context);
   vm.runInContext(source.slice(start,end)+'\nthis.recover=sentlogDeltaRecoverSharedOriginal;',context);
   const params={scope,validate:()=>{validations++;}};
   assert.equal(await context.recover(cp,item,params),bytes);
   assert.equal(originals,1);assert.equal(reencodes,1);assert(validations>=4);
   assert.equal(await context.recover({...cp,client_key:'other-project'},item,params),undefined);
   assert.equal(await context.recover(cp,{...item,recordId:'another-shape'},params),undefined);
   assert.equal(await context.recover(cp,item,{scope:{...scope,ownerId:'other'},validate:()=>{}}),undefined);
   assert.equal(originals,1,'never read unrelated originals');
   api.makeSharedPhoto=async()=>new Blob(['different-shared-content'],{type:'image/jpeg'});
   await assert.rejects(context.recover(cp,item,params),e=>e.code==='ASSET_ORIGINAL_REENCODE_MISMATCH');
   assert.equal(originals,2,'recovery still cannot alter the original bytes');
 });

 await test('nine missing photos rotate through bounded recovery and do not starve later files',async()=>{
   const digest=await sha(bytes);
   const ids=Array.from({length:9},(_,i)=>'photo-'+i);
   const record=C.upgrade({id:'record',type:'ひび割れ',memo:'',photos:ids.map(id=>({
      id,name:id+'.jpg',sha256:digest,size:bytes.size,type:bytes.type}))});
   const snapshot={version:2,scope,cursor:0,
     records:{[D.keyOf('drawing','record')]:record},outbox:[]};
   const token={version:1};D.validateState(snapshot,scope,true);
   const store=A.createIndexedDBStore({...scope,indexedDB:new IDBFactory(),
     databaseName:'sentlog-delta-assets-test-fair-rescue-'+(++serial)});
   const localFiles=new Map(),cloudAssets=[],attempts=[],uploads=[];
   const transport={getScope:()=>scope,online:()=>true,
     async listPhotos(){return [...cloudAssets];},
     async uploadPhoto(item,blob){
       uploads.push(item.photoId);assert.equal(await sha(blob),digest);
       const n=ids.indexOf(item.photoId);
       const ref={id:'44444444-4444-4444-8444-'+String(n+1).padStart(12,'0'),
         owner_id:scope.ownerId,project_id:scope.projectId,kind:'photo',
         client_key:'photo:drawing:'+item.photoId,
         file_name:item.photoId+'.jpg',sha256:digest,byte_size:bytes.size,
         mime_type:bytes.type,status:'uploaded',
         storage_path:scope.ownerId+'/'+scope.projectId+'/photos/'+item.photoId+'.jpg',
         metadata:{drawing_id:'drawing',photo_id:item.photoId}};
       cloudAssets.push(ref);return {asset:ref,uploaded:true};
     },
     async download(){throw Error('unexpected download');},
     async acknowledge(ref){return {...ref,deviceId:scope.deviceId,durable:true};}
   };
   const io={getCapabilities:()=>({guarded:true,onlyIfMissing:true}),
     read:async key=>localFiles.get(key),
     async write(key,value,options){
       assert.equal(options.onlyIfMissing,true);assert.equal(localFiles.has(key),false);
       localFiles.set(key,value);return {written:true,value};
     },
     withLock:async(key,fn)=>fn(),assertExclusive:()=>true};
   const runtime=AR.createRuntime({scope,transport,store,localFiles:io,
     currentScope:()=>scope,currentSnapshotToken:()=>token,
     authGeneration:()=>1,subscribeAuth:()=>()=>{},
     recoverShared:async item=>{
       attempts.push(item.photoId);return item.photoId==='photo-8'?bytes:undefined;
     }});
   try{
     for(let cycle=0;cycle<3;cycle++){
       const result=await runtime.sync({snapshot,snapshotToken:token});
       assert.equal(result.complete,false,'all unrecovered originals must remain pending');
       assert.equal(attempts.length,3*(cycle+1));
     }
     assert.deepEqual(attempts,ids,'every missing photo must get a turn even when earlier originals are missing');
     assert.deepEqual(uploads,['photo-8']);
     assert(localFiles.has('photo:drawing:photo-8'));
     assert.equal(await sha(localFiles.get('photo:drawing:photo-8')),digest);
   }finally{runtime.close();store.close();}
 });
 console.log('6 original/shared preservation and delivery scenarios passed');
})().catch(err=>{console.error(err);process.exitCode=1;});

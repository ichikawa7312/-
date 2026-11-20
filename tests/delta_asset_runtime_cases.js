/* Synthetic REST + real delta IndexedDB cases, shared by Node and browser CI.
 * No live endpoints, personal photographs or user accounts are involved.
 */
(function(root){
 'use strict';
 async function run({A=root.SentlogDeltaAssets,T=root.SentlogDeltaAssetTransport,R=root.SentlogDeltaAssetRuntime,
  D=root.SentlogDeltaSyncCore,C=root.SentlogRecordCollaboration,indexedDB=root.indexedDB,IDBObjectStore=root.IDBObjectStore,
  suffix='node',onStart=()=>{},onPass=()=>{},pcSupply=null,actualFiles=null}={}){
  const results=[],clone=x=>structuredClone(x),scope={ownerId:'10000000-0000-4000-8000-000000000001',
   projectId:'10000000-0000-4000-8000-000000000002',deviceId:'10000000-0000-4000-8000-000000000003'};
  const assert=(ok,message='assertion failed')=>{if(!ok)throw Error(message);};
  const equal=(a,b)=>assert(JSON.stringify(a)===JSON.stringify(b),JSON.stringify(a)+' != '+JSON.stringify(b));
  const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const bytes=new Blob(['shared-photo-immutable-bytes'],{type:'image/jpeg'}),sha=await hash(bytes);
  const uuid=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const base={id:uuid(1),owner_id:scope.ownerId,project_id:scope.projectId,kind:'photo',client_key:'photo:drawing:photo',
   file_name:'shared.jpg',storage_path:scope.ownerId+'/'+scope.projectId+'/photos/photo.jpg',mime_type:'image/jpeg',
   byte_size:bytes.size,sha256:sha,status:'uploaded',source_device_id:scope.deviceId,metadata:{drawing_id:'drawing',photo_id:'photo',local_project_key:'local-project'}};
  const metadata=row=>({id:row.metadata.photo_id,name:row.file_name,type:row.mime_type,size:row.byte_size,sha256:row.sha256});
  function snapshot(photos=[metadata(base)]){const record=C.upgrade({id:'record',type:'point',memo:'kept',photos});
   return {version:2,scope:clone(scope),cursor:0,records:{[D.keyOf('drawing','record')]:record},outbox:[]};}
  function response(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});}
  async function expect(fn,code){let e;try{await fn();}catch(error){e=error;}assert(e,'expected rejection '+code);
   assert(!code||e.code===code||e.name===code,'expected '+code+', got '+(e.code||e.name)+': '+e.message);return e;}
  let serial=0;
  async function fixture(extra={}){
   const name=extra.name||'sentlog-delta-assets-test-runtime-'+suffix+'-'+(++serial),files=new Map(extra.files||[]),listeners=new Set();
   const context={scope:clone(scope),token:Object.freeze({}),snapshot:extra.snapshot||snapshot(),auth:0,session:{access_token:'synthetic-token',user:{id:scope.ownerId}}};
   const server={rows:clone(extra.rows===undefined?[base]:extra.rows),objects:new Map(),receipts:new Map(),requests:[],pcReceipts:new Map(),
    stats:{downloads:0,uploads:0,acks:0,requests:0,assetInserts:0,assetPages:0},hook:null,active:true,projectStatus:extra.projectStatus||'active',online:true,lostUpload:false,ackTamper:false,
    rotate(event='TOKEN_REFRESHED',next=context.session){context.auth++;context.session=next;for(const listener of [...listeners])listener(event,next);}};
   for(const row of server.rows)if(row.status!=='storage_deleted')server.objects.set(row.storage_path,bytes);
   function filtered(rows,params){
    for(const [field,query]of params){
     if(query.startsWith('eq.')){let value=query.slice(3);if(value[0]==='"')value=JSON.parse(value);rows=rows.filter(r=>String(r[field])===value);}
     if(query.startsWith('gt.'))rows=rows.filter(r=>r[field]>query.slice(3));
    }
    if(params.get('order')==='id.asc')rows.sort((a,b)=>a.id.localeCompare(b.id));
    return rows.slice(0,Number(params.get('limit')||1000));
   }
   async function fetcher(url,options={}){
    const u=new URL(url),path=u.pathname,method=options.method||'GET';
    if(server.hook){const intercepted=await server.hook({url:u,path,method,options,server,context});if(intercepted!==undefined)return intercepted;}
    if(path==='/auth/v1/user')return response({id:scope.ownerId});
    if(path==='/rest/v1/sentlog_projects')return response([{id:scope.projectId,owner_id:scope.ownerId,status:server.projectStatus,client_key:'local-project'}]);
    if(path==='/rest/v1/sentlog_devices')return response([{id:scope.deviceId,owner_id:scope.ownerId,active:server.active,device_type:'browser',last_seen_at:new Date().toISOString()}]);
    if(path==='/rest/v1/sentlog_assets'){
     if(method==='POST'){
      server.stats.assetInserts++;const item=JSON.parse(options.body);
      if(server.rows.some(row=>row.client_key===item.client_key))return response({code:'23505'},409);
      const row={...item,id:uuid(server.rows.length+10)};server.rows.push(row);return response([row],201);
     }
     if(u.searchParams.get('order'))server.stats.assetPages++;
     return response(filtered(clone(server.rows),u.searchParams));
    }
    if(path==='/rest/v1/rpc/sentlog_ack_photo'){
     server.stats.acks++;const b=JSON.parse(options.body);
     server.receipts.set(b.p_asset_id,{asset_id:b.p_asset_id,owner_id:scope.ownerId,device_id:b.p_device_id,
      sha256:server.ackTamper?'0'.repeat(64):b.p_sha256,byte_size:b.p_byte_size,received_at:new Date().toISOString()});
     if(server.afterAck)await server.afterAck();return response({received:true});
    }
    if(path==='/rest/v1/sentlog_asset_device_receipts')return response(filtered([...server.receipts.values()],u.searchParams));
    if(path==='/rest/v1/rpc/sentlog_request_photo'){
     const b=JSON.parse(options.body);server.stats.requests++;const row=server.rows.find(row=>row.id===b.p_asset_id);
     server.requests.push({asset_id:row.id,device_id:b.p_device_id,expected_sha256:row.sha256,requested_at:new Date().toISOString(),received_at:null});
     return response({requested:true,asset_id:row.id});
    }
    if(path==='/rest/v1/sentlog_pdf_requests')return response(server.requests.filter(r=>!r.received_at));
    if(path==='/rest/v1/sentlog_pc_receipts')return response([...server.pcReceipts.values()]);
    if(path==='/rest/v1/rpc/sentlog_claim_photo_redelivery'){
     const b=JSON.parse(options.body),row=server.rows.find(row=>row.id===b.p_asset_id);
     const storage_path=scope.ownerId+'/'+scope.projectId+'/redelivery/'+row.id+'/synthetic-lease.jpg';
     row.nextPath=storage_path;return response({claimed:true,token:'synthetic-lease',storage_path});
    }
    if(path==='/rest/v1/rpc/sentlog_finish_photo_redelivery'){
     const b=JSON.parse(options.body),row=server.rows.find(row=>row.id===b.p_asset_id);
     assert(server.objects.has(row.nextPath),'PC must upload before publishing');row.storage_path=row.nextPath;row.status='uploaded';delete row.nextPath;
     return response({published:true,asset_id:row.id});
    }
    const downloadPrefix='/storage/v1/object/authenticated/sentlog-temp/',uploadPrefix='/storage/v1/object/sentlog-temp/';
    if(path.startsWith(downloadPrefix)){
     server.stats.downloads++;const blob=server.objects.get(path.slice(downloadPrefix.length).split('/').map(decodeURIComponent).join('/'));
     if(!blob)return response({error:'not_found'},404);return new Response(blob,{status:200,headers:{'content-length':String(blob.size)}});
    }
    if(path.startsWith(uploadPrefix)){
     server.stats.uploads++;const key=path.slice(uploadPrefix.length).split('/').map(decodeURIComponent).join('/');
     assert(options.headers['x-upsert']!=='true','existing objects may not be replaced');
     if(server.objects.has(key))return response({error:'Duplicate'},409);server.objects.set(key,options.body);
     if(server.lostUpload){server.lostUpload=false;throw Error('synthetic response lost');}return response({Key:key});
    }
    throw Error('unexpected synthetic request '+method+' '+path);
   }
   server.fetch=fetcher;
   const transport=T.createTransport({url:'https://synthetic.invalid',key:'public-synthetic-key',scope,localProjectId:'local-project',
    session:()=>context.session,ensureSession:async()=>context.session,subscribeAuth:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    authGeneration:()=>context.auth,currentScope:()=>context.scope,fetch:fetcher,online:()=>server.online,timeoutMs:extra.timeoutMs||1000,pageLimit:extra.pageLimit||400});
   const store=A.createIndexedDBStore({...scope,indexedDB,databaseName:name}),locks=new Map();
   const local={getCapabilities:()=>({guarded:true,onlyIfMissing:true}),assertExclusive:()=>true,read:async key=>files.get(key),
    withLock(key,fn){const work=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(fn);locks.set(key,work);return work.finally(()=>{if(locks.get(key)===work)locks.delete(key);});},
    async write(key,blob,options){
     assert(options.onlyIfMissing===true,'unguarded legacy overwrite attempted');options.validate();
     if(local.beforeWrite)await local.beforeWrite(key,blob,options);options.validate();
     if(options.signal?.aborted)throw Object.assign(Error('synthetic abort'),{code:'ASSET_ABORTED'});
     const written=!files.has(key);if(written)files.set(key,blob);
     const value=files.get(key);if(local.afterWrite)await local.afterWrite(key,blob,options);return {written,value};
    }};
   const fileAdapter=extra.localFiles||local,events=[];
   const runtime=R.createRuntime({scope,store,transport,localFiles:fileAdapter,currentScope:()=>context.scope,currentSnapshotToken:()=>context.token,
    authGeneration:()=>context.auth,subscribeAuth:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    onPhotoReceived:e=>events.push(e),timeoutMs:extra.timeoutMs||1000,allowArchivedRestore:extra.allowArchivedRestore===true});
   return {name,files,local:local,context,server,transport,store,runtime,events,scope:clone(scope),bytes,base:clone(base),
    sync:options=>runtime.sync({snapshot:context.snapshot,snapshotToken:context.token,...options}),
    ref:row=>T.referenceFromAsset(row||base,scope),close(){runtime.close();transport.close();store.close();}};
  }
  async function test(name,fn){onStart(name);let timer;try{await Promise.race([fn(),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('test deadline exceeded')),10000);})]);
   results.push(name);onPass(name);}catch(e){throw new Error(name+': '+e.message,{cause:e});}finally{clearTimeout(timer);}}

  await test('actual REST receipt is accepted only after delta and legacy bytes both verify',async()=>{
   const f=await fixture();try{const status=await f.sync();assert(status.complete);equal([status.total,status.pending,status.sharedOnly],[1,0,true]);
    assert(status.snapshotToken===f.context.token);await A.verifyBlob(f.files.get('photo:drawing:photo'),f.ref());
    const row=await f.store.read(f.ref());equal([row.phase,row.remoteReceipt.source],['acknowledged','sentlog_asset_device_receipts']);
    equal(f.server.stats.acks,1);assert(f.events[0].snapshotToken===f.context.token);}finally{f.close();}
  });
  await test('matching legacy photo supplies durable delta bytes without downloading again',async()=>{
   const f=await fixture({files:[['photo:drawing:photo',bytes]]});try{assert((await f.sync()).complete);equal([f.server.stats.downloads,f.server.stats.uploads,f.server.stats.acks],[0,0,1]);}finally{f.close();}
  });
  await test('lost initial upload retries the same immutable object without overwriting',async()=>{
   const f=await fixture({rows:[],files:[['photo:drawing:photo',bytes]]});try{
    f.server.lostUpload=true;const first=await f.sync();assert(!first.complete);equal(f.server.rows.length,0);const paths=[...f.server.objects.keys()];
    assert((await f.sync()).complete);equal([...f.server.objects.keys()],paths);equal(f.server.rows.length,1);equal(f.server.stats.assetInserts,1);
    await A.verifyBlob(f.files.get('photo:drawing:photo'),f.ref(f.server.rows[0]));}finally{f.close();}
  });
  await test('missing bytes and missing asset never become an empty successful photo set',async()=>{
   const f=await fixture({rows:[]});try{const result=await f.sync();equal([result.total,result.references.length,result.complete],[1,0,false]);
    assert(result.pending>0&&result.issues.some(i=>i.code==='ASSET_REFERENCE_MISSING'));equal(result.photoStatus.complete,false);equal(f.server.stats.acks,0);}finally{f.close();}
  });
  await test('one corrupt local photo is preserved while another photo can finish',async()=>{
   const other={...clone(base),id:uuid(2),client_key:'photo:drawing:other',storage_path:base.storage_path+'2',metadata:{...base.metadata,photo_id:'other'}};
   const corrupt=new Blob(['x'.repeat(bytes.size)],{type:'image/jpeg'}),f=await fixture({rows:[base,other],snapshot:snapshot([metadata(base),metadata(other)]),files:[['photo:drawing:photo',corrupt]]});
   try{const result=await f.sync();assert(!result.complete&&result.issues.some(i=>i.code==='ASSET_CONTENT_MISMATCH'));equal(f.server.stats.acks,1);
    equal(await hash(f.files.get('photo:drawing:photo')),await hash(corrupt));equal((await f.store.read(f.ref(other))).phase,'acknowledged');}finally{f.close();}
  });
  await test('legacy mirror quota failure keeps delta bytes and retries without downloading',async()=>{
   const f=await fixture();try{f.local.beforeWrite=()=>{throw new DOMException('synthetic quota','QuotaExceededError');};
    assert(!(await f.sync()).complete);equal((await f.store.read(f.ref())).phase,'received');equal(f.server.stats.acks,0);
    f.local.beforeWrite=null;assert((await f.sync()).complete);equal(f.server.stats.downloads,1);}finally{f.close();}
  });
  await test('RPC success without the matching persisted receipt never marks delivery complete',async()=>{
   const f=await fixture();try{f.server.ackTamper=true;const first=await f.sync();assert(!first.complete&&first.issues.some(i=>i.code==='ASSET_ACK_MISMATCH'));
    equal((await f.store.read(f.ref())).phase,'received');f.server.ackTamper=false;assert((await f.sync()).complete);equal(f.server.stats.downloads,1);}finally{f.close();}
  });
  await test('PC redelivery waits then receives newly published bytes and verifies both receipts',async()=>{
   const f=await fixture({rows:[{...clone(base),status:'storage_deleted'}]});try{
    const waiting=await f.sync();assert(!waiting.complete&&waiting.issues.some(i=>i.code==='ASSET_REDELIVERY_WAIT'));
    equal([f.server.stats.requests,f.server.stats.acks],[1,0]);equal((await f.store.read(f.ref())).phase,'waiting');
    if(pcSupply)await pcSupply(f);else{const row=f.server.rows[0];row.status='uploaded';row.storage_path=scope.ownerId+'/'+scope.projectId+'/redelivery/'+row.id+'/synthetic-lease.jpg';f.server.objects.set(row.storage_path,bytes);}
    assert((await f.sync()).complete);equal((await f.store.read(f.ref())).phase,'acknowledged');equal(f.server.stats.acks,1);
   }finally{f.close();}
  });
  await test('local retained bytes can acknowledge a cloud-deleted asset without an unnecessary PC request',async()=>{
   const f=await fixture({rows:[{...clone(base),status:'storage_deleted'}],files:[['photo:drawing:photo',bytes]]});try{
    assert((await f.sync()).complete);equal([f.server.stats.requests,f.server.stats.downloads,f.server.stats.acks],[0,0,1]);}finally{f.close();}
  });
  await test('archived projects can read shared bytes and acknowledge a verified PC-restored archived copy',async()=>{
   const downloaded=await fixture({projectStatus:'archived'});try{
    equal((await downloaded.transport.listPhotos()).length,1);assert((await downloaded.sync()).complete);
    equal([downloaded.server.stats.downloads,downloaded.server.stats.acks,downloaded.server.stats.requests],[1,1,0]);
    await A.verifyBlob(downloaded.files.get('photo:drawing:photo'),downloaded.ref());
    equal((await downloaded.store.read(downloaded.ref())).phase,'acknowledged');
   }finally{downloaded.close();}
   const restored=await fixture({projectStatus:'archived',allowArchivedRestore:true,rows:[{...clone(base),status:'storage_deleted'}],files:[['photo:drawing:photo',bytes]]});
   try{
    const ref=restored.ref();await restored.store.ensure(ref);await restored.store.received(ref,bytes);
    await restored.store.acknowledged(ref,{...clone(ref),deviceId:scope.deviceId,durable:true});
    await restored.store.releaseArchivedCopies({scope,localProjectId:'local-project',jobId:'archived-job',operationId:'cleanup-operation',
     certificate:{schema:1,projectId:scope.projectId,headSeq:0,revision:1,payloadSha256:'f'.repeat(64)},
     files:[{key:'photo:drawing:photo',assetId:ref.assetId,kind:'photo',sha256:ref.sha256,size:ref.size,mimeType:ref.mimeType}],validate:()=>true});
    equal((await restored.store.read(ref)).phase,'archived');assert((await restored.sync()).complete);
    const row=await restored.store.read(ref);equal([row.phase,row.remoteReceipt.source],['acknowledged','sentlog_asset_device_receipts']);
    assert(row.archiveRelease,'the previous certified release must remain auditable');await A.verifyBlob(row.blob,ref);
    equal([restored.server.stats.downloads,restored.server.stats.uploads,restored.server.stats.requests,restored.server.stats.acks],[0,0,0,1]);
   }finally{restored.close();}
  });
  await test('archived projects cannot upload or register a new shared photo',async()=>{
   const f=await fixture({projectStatus:'archived',rows:[],files:[['photo:drawing:photo',bytes]]});try{
    await expect(()=>f.transport.uploadPhoto({drawingId:'drawing',photoId:'photo',variant:'shared',mimeType:bytes.type},bytes),'ASSET_PROJECT_FORBIDDEN');
    await expect(()=>f.sync(),'ASSET_PROJECT_FORBIDDEN');
    equal([f.server.stats.downloads,f.server.stats.uploads,f.server.stats.assetInserts,f.server.stats.acks,f.server.stats.requests],[0,0,0,0,0]);
    equal(f.server.rows.length,0);await A.verifyBlob(f.files.get('photo:drawing:photo'),f.ref());
   }finally{f.close();}
  });
  await test('archived cloud-deleted bytes direct the user to capacity restore without an ordinary redelivery request',async()=>{
   const f=await fixture({projectStatus:'archived',rows:[{...clone(base),status:'storage_deleted'}]});try{
    const result=await f.sync();assert(!result.complete&&result.pending>0);
    const issue=result.issues.find(item=>item.code==='ASSET_ARCHIVED_RESTORE_REQUIRED');assert(issue&&issue.message.includes('PCからこの端末に復旧'));
    equal([f.server.stats.downloads,f.server.stats.requests,f.server.stats.acks,f.server.stats.uploads],[0,0,0,0]);
    equal(f.server.requests.length,0);equal((await f.store.read(f.ref())).phase,'waiting');
    await expect(()=>f.transport.requestPhoto(f.ref()),'ASSET_PROJECT_FORBIDDEN');equal(f.server.stats.requests,0);
   }finally{f.close();}
  });
  await test('an archived Storage 404 cannot start active-project photo redelivery',async()=>{
   const f=await fixture({projectStatus:'archived'});try{
    f.server.objects.clear();const result=await f.sync();assert(!result.complete&&result.pending>0);
    assert(result.issues.some(item=>item.code==='ASSET_ARCHIVED_RESTORE_REQUIRED'));
    equal([f.server.stats.downloads,f.server.stats.requests,f.server.stats.acks,f.server.stats.uploads],[1,0,0,0]);
    equal(f.server.requests.length,0);equal((await f.store.read(f.ref())).phase,'waiting');
    assert(!f.files.has('photo:drawing:photo'));equal(f.events.length,0);
   }finally{f.close();}
  });
  await test('deleted photo history remains included even when the current record has no visible photo',async()=>{
   const state=snapshot(),key=D.keyOf('drawing','record'),heads=state.records[key].collab.photos.photo.revisions.map(r=>r.id);
   state.records[key]=C.removePhoto(state.records[key],'photo',{expectedHeads:heads,idFactory:()=> 'deleted-photo',at:1});
   equal(state.records[key].photos.length,0);equal(R.collectPhotos(state).length,1);const f=await fixture({snapshot:state});
   try{assert((await f.sync()).complete);equal(f.server.stats.acks,1);}finally{f.close();}
  });
  await test('conflicting photo-history content is rejected before any network mutation',async()=>{
   const state=snapshot(),record=state.records[D.keyOf('drawing','record')];record.photos[0].sha256='0'.repeat(64);
   const f=await fixture({snapshot:state});try{await expect(()=>f.sync(),'ASSET_COLLISION');equal(f.server.stats.acks,0);equal(f.server.stats.uploads,0);}finally{f.close();}
  });
  await test('camera originals cannot be mistaken for successful shared-photo delivery',async()=>{
   const state=snapshot([{...metadata(base),variant:'original'}]),f=await fixture({snapshot:state});
   try{await expect(()=>f.sync(),'ASSET_ORIGINAL_NOT_REQUESTED');equal(f.server.stats.acks,0);equal(f.server.stats.downloads,0);}finally{f.close();}
  });
  await test('snapshot change while bytes download prevents stale byte and receipt promotion',async()=>{
   const f=await fixture();try{f.server.hook=({path})=>{if(path.includes('/authenticated/'))f.context.token=Object.freeze({});};
    await expect(()=>f.sync(),'ASSET_SNAPSHOT_CHANGED');equal((await f.store.read(f.ref())).phase,'waiting');equal(f.server.stats.acks,0);
    f.server.hook=null;assert((await f.sync()).complete);}finally{f.close();}
  });
  await test('logout then same-account login fences an ignored-abort late download',async()=>{
   const f=await fixture();let release,started;const began=new Promise(resolve=>started=resolve);
   try{f.server.hook=({path})=>{if(path.includes('/authenticated/'))return new Promise(resolve=>{release=()=>resolve(new Response(bytes));started();});};
    const running=f.sync();await began;f.server.rotate('SIGNED_OUT',null);f.server.rotate('SIGNED_IN',{access_token:'synthetic-token',user:{id:scope.ownerId}});
    await expect(()=>running,'ASSET_AUTH_CHANGED');release();await Promise.resolve();equal((await f.store.read(f.ref())).phase,'waiting');equal(f.server.stats.acks,0);
    f.server.hook=null;assert((await f.sync()).complete);}finally{release?.();f.close();}
  });
  await test('account or project change during ACK retains bytes without accepting an old completion',async()=>{
   const f=await fixture();try{f.server.afterAck=()=>{f.context.scope={...scope,projectId:uuid(99)};};
    await expect(()=>f.sync(),'ASSET_SCOPE');equal((await f.store.read(f.ref())).phase,'received');equal(f.events.length,0);await A.verifyBlob(f.files.get('photo:drawing:photo'),f.ref());}finally{f.close();}
  });
  await test('snapshot fence lost after received put enqueue aborts the entire Blob transaction',async()=>{
   const f=await fixture(),native=IDBObjectStore.prototype.put;
   try{IDBObjectStore.prototype.put=function(value,...args){const q=native.call(this,value,...args);if(this.transaction.db.name===f.name&&value.phase==='received')f.context.token=Object.freeze({});return q;};
    await expect(()=>f.sync(),'ASSET_SNAPSHOT_CHANGED');equal((await f.store.read(f.ref())).phase,'waiting');equal(f.server.stats.acks,0);
   }finally{IDBObjectStore.prototype.put=native;f.close();}
  });
  await test('auth fence lost after acknowledged put enqueue preserves pending local receipt',async()=>{
   const f=await fixture(),native=IDBObjectStore.prototype.put;
   try{IDBObjectStore.prototype.put=function(value,...args){const q=native.call(this,value,...args);if(this.transaction.db.name===f.name&&value.phase==='acknowledged')f.server.rotate();return q;};
    await expect(()=>f.sync(),'ASSET_AUTH_CHANGED');equal((await f.store.read(f.ref())).phase,'received');equal(f.events.length,0);
   }finally{IDBObjectStore.prototype.put=native;f.close();}
  });
  await test('legacy clear during server ACK never reuses that receipt for the cleared file state',async()=>{
   const f=await fixture();try{f.server.afterAck=()=>f.files.clear();const result=await f.sync();assert(!result.complete);equal((await f.store.read(f.ref())).phase,'received');
    f.server.afterAck=null;assert((await f.sync()).complete);await A.verifyBlob(f.files.get('photo:drawing:photo'),f.ref());equal(f.server.stats.downloads,1);}finally{f.close();}
  });
  await test('restart restores a missing legacy mirror from acknowledged delta bytes before completion',async()=>{
   const f=await fixture();await f.sync();const name=f.name;f.close();const restarted=await fixture({name});
   try{assert((await restarted.sync()).complete);equal([restarted.server.stats.downloads,restarted.server.stats.acks],[0,0]);
    await A.verifyBlob(restarted.files.get('photo:drawing:photo'),restarted.ref());}finally{restarted.close();}
  });
  await test('caller mutation cannot change the captured immutable photo references',async()=>{
   const f=await fixture();try{f.server.hook=({path})=>{if(path==='/auth/v1/user')f.context.snapshot.records[D.keyOf('drawing','record')].photos[0].sha256='0'.repeat(64);};
    assert((await f.sync()).complete);equal((await f.store.read(f.ref())).reference.sha256,sha);}finally{f.close();}
  });
  await test('explicit pagination reads through the final empty page and rejects a repeated page',async()=>{
   const other={...clone(base),id:uuid(2),client_key:'photo:drawing:other',metadata:{...base.metadata,photo_id:'other'}},f=await fixture({rows:[base,other],pageLimit:1});
   try{equal((await f.transport.listPhotos()).length,2);equal(f.server.stats.assetPages,3);
    f.server.hook=({path})=>path==='/rest/v1/sentlog_assets'?response([base]):undefined;
    await expect(()=>f.transport.listPhotos(),'ASSET_PAGING');}finally{f.close();}
  });
  await test('asset identity change after download keeps all received bytes unacknowledged',async()=>{
   const f=await fixture();try{f.server.hook=({path})=>{if(path.includes('/authenticated/'))f.server.rows[0].sha256='0'.repeat(64);};
    const result=await f.sync();assert(!result.complete&&result.issues.some(i=>i.code==='ASSET_COLLISION'));
    equal((await f.store.read(f.ref())).phase,'waiting');equal(f.server.stats.acks,0);}finally{f.close();}
  });
  await test('foreign storage path cannot be followed even with valid photo metadata',async()=>{
   const f=await fixture();try{f.server.rows[0].storage_path=uuid(99)+'/'+scope.projectId+'/photos/photo.jpg';
    const result=await f.sync();assert(!result.complete&&result.issues.some(i=>i.code==='ASSET_PATH'));equal(f.server.stats.downloads,0);}finally{f.close();}
  });
  await test('any existing non-Blob legacy value remains untouched and cannot acquire a receipt',async()=>{
   for(const value of [null,'keep-this-existing-value']){const f=await fixture({files:[['photo:drawing:photo',value]]});try{
    assert(!(await f.sync()).complete);equal(f.files.get('photo:drawing:photo'),value);equal(f.server.stats.acks,0);equal(f.server.stats.downloads,0);}finally{f.close();}}
  });
  await test('unregistered device blocks photo reads and mutations while preserving local bytes',async()=>{
   const f=await fixture({files:[['photo:drawing:photo',bytes]]});try{f.server.active=false;await expect(()=>f.sync(),'ASSET_DEVICE_FORBIDDEN');
    equal([f.server.stats.downloads,f.server.stats.uploads,f.server.stats.acks],[0,0,0]);await A.verifyBlob(f.files.get('photo:drawing:photo'),f.ref());}finally{f.close();}
  });
  await test('offline and ignored-abort timeout preserve pending rows and never report completion',async()=>{
   const f=await fixture({timeoutMs:20});let release;try{
    f.server.online=false;assert(!(await f.sync()).complete);f.server.online=true;
    f.server.hook=({path})=>path.includes('/authenticated/')?new Promise(resolve=>{release=()=>resolve(new Response(bytes));}):undefined;
    const result=await f.sync();assert(!result.complete&&result.issues.some(i=>i.code==='ASSET_TIMEOUT'));release();await Promise.resolve();
    equal((await f.store.read(f.ref())).phase,'waiting');equal(f.server.stats.acks,0);}finally{release?.();f.close();}
  });
  await test('a server ACK cannot be requested without a verified device-specific local receipt',async()=>{
   const f=await fixture();try{await expect(()=>f.transport.acknowledge(f.ref(),{receipt:{...f.ref(),deviceId:uuid(99),verified:true}}),'ASSET_NOT_DURABLE');equal(f.server.stats.acks,0);}finally{f.close();}
  });
  await test('a guarded legacy writer capability is mandatory before a runtime can start',async()=>{
   const f=await fixture();try{await expect(()=>R.createRuntime({scope,store:f.store,transport:f.transport,localFiles:{...f.local,getCapabilities:()=>({})},
    currentScope:()=>scope,currentSnapshotToken:()=>f.context.token,authGeneration:()=>0,subscribeAuth:()=>()=>{}}),'ASSET_RUNTIME_CONFIG');equal(f.server.stats.acks,0);}finally{f.close();}
  });
  await test('pending legacy writers block photo work even when guarded writes are supported',async()=>{
   const f=await fixture();try{f.local.assertExclusive=()=>false;await expect(()=>f.sync(),'ASSET_LEGACY_WRITER_ACTIVE');equal(f.server.stats.acks,0);equal(f.server.stats.assetPages,0);
    f.local.assertExclusive=()=>Promise.resolve(true);await expect(()=>f.sync(),'ASSET_LEGACY_WRITER_ACTIVE');equal(f.server.stats.acks,0);
    f.local.assertExclusive=()=>true;assert((await f.sync()).complete);}finally{f.close();}
  });
  await test('legacy retry appearing during ACK leaves its earlier receipt pending',async()=>{
   const f=await fixture();try{f.server.afterAck=()=>{f.local.assertExclusive=()=>false;};await expect(()=>f.sync(),'ASSET_LEGACY_WRITER_ACTIVE');
    equal((await f.store.read(f.ref())).phase,'received');equal(f.events.length,0);}finally{f.close();}
  });
  await test('an async rejecting writer fence is consumed and refused without an unhandled rejection',async()=>{
   const f=await fixture();try{f.local.assertExclusive=async()=>{throw Error('synthetic late fence rejection');};
    await expect(()=>f.sync(),'ASSET_LEGACY_WRITER_ACTIVE');await new Promise(resolve=>setTimeout(resolve,0));equal(f.server.stats.acks,0);
    f.local.assertExclusive=()=>true;assert((await f.sync()).complete);}finally{f.close();}
  });
  await test('early queue-construction failure releases the active signal listener and allows a retry',async()=>{
   const f=await fixture(),getScope=f.store.getScope;let added=0,removed=0;
   try{f.store.getScope=()=>({...scope,projectId:'different'});const signal={aborted:false,addEventListener(){added++;},removeEventListener(){removed++;}};
    await expect(()=>f.sync({signal}),'ASSET_CONFIG');equal([added,removed],[1,1]);f.store.getScope=getScope;assert((await f.sync()).complete);
   }finally{f.store.getScope=getScope;f.close();}
  });
  await test('completed photo status from a previous record token cannot complete a newer snapshot',async()=>{
   const f=await fixture();try{const result=await f.sync(),newToken=Object.freeze({}),record={scope:clone(scope),snapshotToken:newToken,level:'ok',pending:0,blocked:0,conflicts:0};
    const combined=A.combinedStatus(record,result.photoStatus,{scope,recordSnapshotToken:newToken,references:result.references});assert(!combined.complete);
   }finally{f.close();}
  });
  if(actualFiles)await test('actual SentlogRecords guarded writer participates in full download readback and ACK',async()=>{
   const adapter=await actualFiles(),f=await fixture({localFiles:adapter});try{const result=await f.sync();assert(result.complete,JSON.stringify(result.issues));await A.verifyBlob(await adapter.read('photo:drawing:photo'),f.ref());
    equal((await f.store.read(f.ref())).phase,'acknowledged');}finally{f.close();await adapter.close?.();}
  });
  return results;
 }
 if(typeof module==='object'&&module.exports)module.exports={run};else root.runDeltaAssetRuntimeCases=run;
})(typeof window!=='undefined'?window:globalThis);

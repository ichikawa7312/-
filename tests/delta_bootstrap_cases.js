/* The real legacy reader, migration store, baseline planner and replica store
 * run together in disposable databases. Browser and Node use identical cases.
 * The test fence is an injected fixture; it is not a production writer fence.
 */
(function(root){
 'use strict';
 async function run(engine='node'){
  const B=root.SentlogDeltaBootstrap,M=root.SentlogDeltaMigration,S=root.SentlogDeltaLegacySource;
  const I=root.SentlogDeltaIndexedDB,D=root.SentlogDeltaSyncCore,C=root.SentlogRecordCollaboration;
  const results=[],scope={ownerId:'bootstrap-owner',projectId:'bootstrap-cloud-project',deviceId:'bootstrap-device'};
  const projectId='bootstrap-local-project',drawingId='drawing-one',PREFIX='__sentlog_record__:';
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',META='__sentlog_records_meta_v130__';
  const copy=v=>structuredClone(v),assert=(ok,message='assertion failed')=>{if(!ok)throw Error(message);};
  const equal=(a,b,message)=>assert(C.equal(a,b),message||'values differ');
  const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):await value.arrayBuffer()))]
   .map(v=>v.toString(16).padStart(2,'0')).join('');
  const pg=v=>Array.isArray(v)?'['+v.map(pg).join(', ')+']':v&&typeof v==='object'?'{'+Object.entries(v).reverse().map(([k,x])=>JSON.stringify(k)+': '+pg(x)).join(', ')+'}':JSON.stringify(v);
  const omit=(v,keys)=>Object.fromEntries(Object.entries(v).filter(([key])=>!keys.includes(key)));
  const comment=(r,label)=>C.appendComment(r,'所見 '+label,{commentId:'comment:'+label,revisionId:'revision:'+label,at:10,
   actor:{deviceId:scope.deviceId,deviceName:'fixture'}});
  const rejected=async(fn,code)=>{let error;try{await fn();}catch(e){error=e;}assert(error,'expected rejection');
   if(code)assert((Array.isArray(code)?code:[code]).some(x=>error.code===x||error.name===x),
    'expected '+code+', got '+(error.code||error.name)+': '+error.message);return error;};
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
  let serial=0;
  function open(name,upgrade){return new Promise((resolve,reject)=>{
   const q=indexedDB.open(name,1);q.onupgradeneeded=()=>upgrade?.(q.result);
   q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });}
  function tx(db,stores,mode,fn){return new Promise((resolve,reject)=>{
   const t=db.transaction(stores,mode);t.oncomplete=resolve;t.onabort=()=>reject(t.error);t.onerror=()=>{};fn(t);
  });}
  async function fixture(){
   const name='sentlog-delta-test-bootstrap-'+engine+'-'+(++serial),names={old:name+'-old',original:name+'-original',stage:name+'-stage',normal:name+'-normal'};
   const shared=new Blob(['shared photo bytes 🌧️'],{type:'image/jpeg'}),original=new Blob(['original photo bytes 📷'],{type:'image/jpeg'});
   const photo={id:'photo-one',name:'現場.jpg',size:shared.size,sha256:await hash(shared)};
   const base=C.upgrade({id:'record-one',kind:'point',x:1,y:2,member:'pier',memo:'既存の所見',photos:[photo]});
   const serverOnly=C.upgrade({id:'server-only',kind:'point',x:3,y:4,memo:'別端末だけの記録',photos:[]});
   let tombstone=C.upgrade({id:'deleted-record',kind:'point',x:5,y:6,memo:'削除前の記録',photos:[]});
   tombstone=C.markDeleted(tombstone,{revisionId:'tombstone-revision',expectedToken:C.revisionToken(tombstone),at:1});
   const newRecord=C.upgrade({id:'local-new',kind:'point',x:9,y:10,memo:'未送信の新規記録',photos:[]});
   const metas=[{id:drawingId,name:'図面1',updatedAt:1},{id:'empty-drawing',name:'空の図面',updatedAt:1}];
   const project={id:projectId,name:'引き継ぎ案件',collaborationVersion:1,drawings:metas,updatedAt:1};
   const server={project,drawings:[{meta:metas[0],state:{sourceType:null,fileName:'',pageSettings:{1:{scale:100}},
    shapes:[base,serverOnly],collabDeletedRecords:[tombstone]}},{meta:metas[1],state:{sourceType:null,fileName:'',shapes:[],collabDeletedRecords:[]}}]};
   const local=copy(server);local.drawings[0].state.shapes=[comment(base,'local'),newRecord];
   local.drawings[0].state.shapes[0].photos[0].localBlob=true;local.drawings[0].state.labelSize='small';
   const sourceEntries=new Map([[PREFIX+WS,JSON.stringify({projects:[project]})],
    ...local.drawings.map(d=>[PREFIX+DRAW+d.meta.id,JSON.stringify(d.state)]),
    [PREFIX+'sentlogCloudProjectSyncV2:'+projectId,JSON.stringify({revision:4,base_snapshot:server})],
    [META,{schema:1,revision:7}],['photo:'+drawingId+':'+photo.id,shared]]);
   const old=await open(names.old,db=>db.createObjectStore('files'));
   await tx(old,['files'],'readwrite',t=>{for(const [key,value]of sourceEntries)t.objectStore('files').put(value,key);});old.close();
   const originalMeta={key:drawingId+':'+photo.id,projectId,drawingId,photoId:photo.id,size:original.size,type:original.type,
    sha256:await hash(original),originalName:'原本.jpg',photoAssociation:{version:1,status:'attached',photoId:photo.id,
     operationId:'capture-one',target:{projectId,drawingId,recordId:base.id}}};
   const originals=await open(names.original,db=>{db.createObjectStore('photos');db.createObjectStore('meta',{keyPath:'key'});});
   await tx(originals,['photos','meta'],'readwrite',t=>{t.objectStore('photos').put(original,originalMeta.key);t.objectStore('meta').put(originalMeta);});originals.close();
   const rows=[],metadata=[];
   for(const d of server.drawings)for(const record of [...d.state.shapes,...d.state.collabDeletedRecords]){
    const row={ordinal:rows.length+1,drawingId:d.meta.id,recordId:record.id,recordJson:pg(record),sha256:await hash(pg(record))};
    row.manifestEntryJson=pg(omit(row,['recordJson']));rows.push(row);
   }
   for(const item of [{kind:'header',key:'project',value:{project}},...server.drawings.map(d=>({kind:'drawing',key:d.meta.id,value:{meta:d.meta,state:omit(d.state,['shapes','collabDeletedRecords'])}}))]){
    const row={ordinal:metadata.length+1,kind:item.kind,key:item.key,metadataJson:pg(item.value),sha256:await hash(pg(item.value))};
    row.manifestEntryJson=pg(omit(row,['metadataJson']));metadata.push(row);
   }
   const receipt={schema:1,baselineId:'bootstrap-baseline',ownerId:scope.ownerId,projectId:scope.projectId,clientProjectId:projectId,
    drawingIds:metas.map(d=>d.id),snapshotRevision:4,cursor:0,recordCount:rows.length,importedCount:rows.length,
    metadataCount:metadata.length,snapshotSha256:await hash(pg(server)),manifestSha256:await hash('['+rows.map(r=>r.manifestEntryJson).join(', ')+']'),
    metadataManifestSha256:await hash('['+metadata.map(r=>r.manifestEntryJson).join(', ')+']'),hashFormat:'postgres-jsonb-text-sha256-v1',
    state:'active',deltaEnabled:true,deviceMigrationVerified:false,assetDeliveryVerified:false};
   const controls={scope:copy(scope),page:null,progress:null,recheck:null,blocked:true,atomicGroups:false},progress=[];
   const storage={getItem:()=>null,setItem(){throw Error('unexpected localStorage write');},removeItem(){throw Error('unexpected localStorage removal');}};
   const transport={
    getCapabilities:()=>({atomicGroups:controls.atomicGroups}),
    pushGroup:async()=>{throw Error('bootstrap must not send a pending group');},
    async readBaselinePage(id,after,limit,options){return read('records',rows,id,after,limit,options);},
    async readBaselineMetadataPage(id,after,limit,options){return read('metadata',metadata,id,after,limit,options);}
   };
   async function read(kind,all,id,after,limit,options){
    equal(id,receipt.baselineId);assert(limit>=1&&limit<=100);if(controls.page)await controls.page({kind,after,options});
    const page=all.slice(after,after+Math.min(limit,1)),next=after+page.length;
    return {receipt:copy(receipt),[kind]:copy(page),nextOrdinal:next,hasMore:next<all.length};
   }
   function handles(options={}){
    const source=S.createSource({indexedDB,localStorage:storage,crypto,databaseName:names.old,originalDatabaseName:names.original});
    const wrapped={capture:(...a)=>source.capture(...a),async recheck(...a){if(controls.recheck)await controls.recheck();return source.recheck(...a);}};
    const stageStore=M.createStore({...scope,indexedDB,databaseName:names.stage});
    const migration=M.createCoordinator({source:wrapped,store:stageStore,localProjectId:projectId,currentScope:()=>copy(controls.scope),batchItems:1});
    const replicaStore=I.createStore({...scope,indexedDB,databaseName:names.normal});
    const bootstrap=B.createCoordinator({source:wrapped,migration,replicaStore,transport,localProjectId:projectId,
     currentScope:()=>copy(controls.scope),timeoutMs:options.timeoutMs||5000,onProgress:p=>{progress.push(copy(p));controls.progress?.(p);}});
    const fence=()=>controls.blocked;
    return {source,stageStore,migration,replicaStore,bootstrap,fence,
     prepare:(more={})=>bootstrap.prepare({migrationId:'migration-one',receipt,...more}),
     install:(plan,more={})=>bootstrap.install({migrationId:'migration-one',plan,assertLegacyWritesBlocked:fence,...more}),
     close(){bootstrap.close();migration.close();source.close();replicaStore.close();}};
   }
   async function changeRecord(change){
    const key=PREFIX+DRAW+drawingId,db=await open(names.old);
    try{await tx(db,['files'],'readwrite',t=>{const files=t.objectStore('files'),q=files.get(key);q.onsuccess=()=>{
     const state=JSON.parse(q.result);change(state);files.put(JSON.stringify(state),key);files.put({schema:1,revision:8},META);
    };});}finally{db.close();}
   }
   return {names,shared,original,originalMeta,sourceEntries,receipt,controls,progress,handles,changeRecord};
  }
  async function test(name,fn){try{await fn();results.push(name);}catch(cause){
   const error=new Error(name+': '+(cause?.message||String(cause)));error.cause=cause;throw error;
  }}
  const offline={online:()=>false,push:async()=>{throw Error('offline push');},list:async()=>{throw Error('offline list');}};
  async function preserved(f,h,expected){
   const saved=await h.migration.readCopy('migration-one');equal(saved.status,'verified-copy');equal(saved.snapshot.rawEntries,expected.rawEntries);
   equal(saved.snapshot.fingerprint,expected.fingerprint);equal(saved.snapshot.files.length,2);
   equal(await hash(saved.snapshot.files.find(x=>x.kind==='photo').blob),await hash(f.shared));
   equal(await hash(saved.snapshot.files.find(x=>x.kind==='original-photo').blob),await hash(f.original));
   return saved;
  }
  await test('real readonly source to verified shadow to initial replica keeps exact records and photo bytes',async()=>{
   const f=await fixture(),h=f.handles(),before=await h.source.capture(projectId),native=IDBDatabase.prototype.transaction,modes=[];
   IDBDatabase.prototype.transaction=function(stores,mode,...rest){
    if([f.names.old,f.names.original].includes(this.name)){modes.push(mode);assert(mode==='readonly','bootstrap wrote legacy data');}
    return native.call(this,stores,mode,...rest);
   };
   try{
    const prepared=await h.prepare();equal(prepared.status,'prepared');assert(prepared.readyForInstall);equal(await h.replicaStore.read(),null);
    await preserved(f,h,before);const installed=await h.install(prepared.plan);equal(installed.status,'installed');assert(!installed.idempotent);
    equal(installed.state.outbox.length,2);equal(Object.keys(installed.state.records).length,4);equal(installed.state.cursor,0);
    assert(installed.state.records[D.keyOf(drawingId,'server-only')]);assert(C.isDeleted(installed.state.records[D.keyOf(drawingId,'deleted-record')]));
    const proof=await h.replicaStore.readProvenance();equal(proof.source.fingerprint,before.fingerprint);equal(proof.metadata.drawings.length,2);
    equal(proof.metadata.localView.drawings[drawingId].state.labelSize,'small');equal((await h.source.capture(projectId)).fingerprint,before.fingerprint);
    assert(modes.length>0);assert(f.progress.every(p=>p.readyForActivation===false&&p.readyForCloudSync===false));
    assert(!installed.readyForActivation&&!installed.readyForCloudSync&&!installed.assetDeliveryVerified);
   }finally{IDBDatabase.prototype.transaction=native;h.close();}
  });
  await test('offline edits survive restart and retrying the same seed without resetting the outbox',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare(),initial=await h.install(prepared.plan),proof=await h.replicaStore.readProvenance();
   const replica=D.createReplica({...scope,store:h.replicaStore,transport:offline,reconcileIntervalMs:0});await replica.start();
   const previous=(await replica.snapshot()).records[D.keyOf(drawingId,'record-one')];
   await replica.change({drawingId,before:previous,after:comment(previous,'offline after install'),eventId:'offline-after-seed'});
   const saved=await replica.snapshot();equal(saved.outbox.length,initial.state.outbox.length+1);replica.close();h.close();
   const reopened=f.handles();try{
    const resumed=await reopened.install(prepared.plan);assert(resumed.idempotent);equal(resumed.state,saved);
    equal(await reopened.replicaStore.readProvenance(),proof);
    const again=D.createReplica({...scope,store:reopened.replicaStore,transport:offline,reconcileIntervalMs:0});
    await again.start();equal(await again.snapshot(),saved);again.close();
   }finally{reopened.close();}
  });
  await test('verified atomic transport preserves a pending move as one durable group through seed and reopen',async()=>{
   const f=await fixture();f.controls.atomicGroups=true;
   await f.changeRecord(s=>{
    const source=s.shapes.shift();
    s.collabDeletedRecords.push(C.markDeleted(source,{revisionId:'pending-group-move',expectedToken:C.revisionToken(source),at:20}));
    s.shapes.push(C.upgrade({id:'pending-group-target',kind:'point',page:2,x:2,y:3,memo:'移動先',photos:[],
     transferOrigin:{drawingId,recordId:source.id,operation:'move'}}));
   });
   const h=f.handles();let prepared,saved;
   try{
    prepared=await h.prepare();assert(prepared.readyForInstall);
    equal(prepared.plan.state.outbox.length,1);equal(prepared.plan.state.outbox[0].kind,'atomic-group');
    D.validateGroup(prepared.plan.state.outbox[0]);
    f.controls.atomicGroups=false;
    await rejected(()=>h.install(prepared.plan),'BOOTSTRAP_PLAN_CHANGED');equal(await h.replicaStore.read(),null);
    f.controls.atomicGroups=true;
    const installed=await h.install(prepared.plan);saved=installed.state;
    equal(saved.outbox,prepared.plan.state.outbox);
    assert(C.isDeleted(saved.records[D.keyOf(drawingId,'record-one')]));
    assert(saved.records[D.keyOf(drawingId,'pending-group-target')]);
   }finally{h.close();}
   const reopened=f.handles();try{
    const retry=await reopened.install(prepared.plan);assert(retry.idempotent);equal(retry.state,saved);
   }finally{reopened.close();}
  });
  await test('verified but inactive baseline can be prepared but cannot initialize the normal replica',async()=>{
   const f=await fixture();f.receipt.state='verified';f.receipt.deltaEnabled=false;const h=f.handles();
   try{const prepared=await h.prepare();assert(prepared.readyForInstall);
    await rejected(()=>h.install(prepared.plan),'BOOTSTRAP_BASELINE_INACTIVE');equal(await h.replicaStore.read(),null);
    f.receipt.state='active';f.receipt.deltaEnabled=true;await rejected(()=>h.install(prepared.plan),'BOOTSTRAP_BASELINE_INACTIVE');
    const active=await h.prepare();equal((await h.install(active.plan)).status,'installed');
   }finally{h.close();}
  });
  await test('new legacy edits after preparation stop install and preserve both source and prior protected copy',async()=>{
   const f=await fixture(),h=f.handles(),before=await h.source.capture(projectId),prepared=await h.prepare();
   try{await f.changeRecord(s=>s.shapes[0]=comment(s.shapes[0],'after preparation'));
    await rejected(()=>h.install(prepared.plan),'BOOTSTRAP_SOURCE_CHANGED');equal(await h.replicaStore.read(),null);
    await preserved(f,h,before);const current=await h.source.capture(projectId);assert(current.fingerprint!==before.fingerprint);
    assert(current.rawEntries.find(x=>x.key===DRAW+drawingId).value.includes('after preparation'));
   }finally{h.close();}
  });
  await test('local project mapping mismatch retains the staged bytes without seeding another project',async()=>{
   const f=await fixture(),h=f.handles(),before=await h.source.capture(projectId);f.receipt.clientProjectId='wrong-local-project';
   try{await rejected(()=>h.prepare(),'BOOTSTRAP_BINDING');equal(await h.replicaStore.read(),null);await preserved(f,h,before);}finally{h.close();}
  });
  await test('an edited plan checksum cannot authorize installation',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare();prepared.plan.state.records[D.keyOf(drawingId,'record-one')].memo='rewritten';
   try{await rejected(()=>h.install(prepared.plan),'RECONCILE_PLAN_CHANGED');equal(await h.replicaStore.read(),null);}finally{h.close();}
  });
  await test('an authoritative receipt change between prepare and install is refused',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare();f.receipt.snapshotRevision++;
   try{await rejected(()=>h.install(prepared.plan),'RECONCILE_BASELINE_CHANGED');equal(await h.replicaStore.read(),null);}finally{h.close();}
  });
  await test('an unrecorded local textarea edit remains reviewable in the shadow and prevents installation',async()=>{
   const f=await fixture();await f.changeRecord(s=>s.shapes[0].memo='履歴化前の入力');const h=f.handles();
   try{const prepared=await h.prepare();equal(prepared.status,'needs-review');assert(!prepared.readyForInstall);
    assert(prepared.plan.reviewItems.some(x=>x.code==='RECONCILE_UNRECORDED_EDIT'));
    await rejected(()=>h.install(prepared.plan),'BOOTSTRAP_REVIEW');equal(await h.replicaStore.read(),null);
    assert((await h.migration.readCopy('migration-one')).snapshot.rawEntries.some(x=>x.value?.includes('履歴化前の入力')));
   }finally{h.close();}
  });
  await test('a pending legacy move cannot install an independently sendable source deletion',async()=>{
   const f=await fixture();await f.changeRecord(s=>{
    const original=s.shapes[0];s.shapes=s.shapes.filter(r=>r.id!==original.id);
    s.collabDeletedRecords.push(C.markDeleted(original,{revisionId:'pending-move-delete',expectedToken:C.revisionToken(original),at:20}));
    s.shapes.push(C.upgrade({id:'moved-record',memo:'移動先の記録',photos:[],transferOrigin:{drawingId,recordId:original.id,operation:'move'}}));
   });const h=f.handles();
   try{const prepared=await h.prepare();equal(prepared.status,'needs-review');assert(prepared.plan.reviewItems.some(x=>x.code==='RECONCILE_ATOMIC_GROUP_REQUIRED'));
    assert(prepared.plan.state.outbox.some(e=>e.recordId==='moved-record'));assert(prepared.plan.state.outbox.some(e=>e.patch?.deletion.some(r=>r.deleted)));
    await rejected(()=>h.install(prepared.plan),'BOOTSTRAP_REVIEW');equal(await h.replicaStore.read(),null);
   }finally{h.close();}
  });
  await test('aborted page reads and their delayed replies never initialize normal storage',async()=>{
   const f=await fixture(),h=f.handles(),entered=deferred(),late=deferred(),controller=new AbortController();
   f.controls.page=async()=>{entered.resolve();await late.promise;};
   const pending=h.prepare({signal:controller.signal});
   try{await entered.promise;controller.abort();await rejected(()=>pending,'BOOTSTRAP_ABORTED');late.resolve();
    equal(await h.replicaStore.read(),null);equal((await h.migration.readCopy('migration-one')).status,'verified-copy');
   }finally{late.resolve();h.close();}
  });
  await test('account changes while install waits for metadata preserve the previous normal store',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare(),entered=deferred(),late=deferred();
   f.controls.page=async({kind})=>{if(kind==='metadata'){entered.resolve();await late.promise;}};
   const pending=h.install(prepared.plan);
   try{await entered.promise;f.controls.scope={...scope,ownerId:'other-owner'};late.resolve();
    await rejected(()=>pending,['BOOTSTRAP_SCOPE','RECONCILE_SCOPE']);equal(await h.replicaStore.read(),null);
   }finally{late.resolve();h.close();}
  });
  await test('close cancels a pending install even if the transport ignores cancellation',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare(),entered=deferred(),late=deferred();
   f.controls.page=async()=>{entered.resolve();await late.promise;};const pending=h.install(prepared.plan);
   try{await entered.promise;h.bootstrap.close();await rejected(()=>pending,'BOOTSTRAP_CLOSED');late.resolve();equal(await h.replicaStore.read(),null);}finally{late.resolve();h.close();}
  });
  await test('timeouts retain the protected source and cannot be revived by a late page',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare();h.bootstrap.close();
   const fast=f.handles({timeoutMs:250}),entered=deferred(),late=deferred();f.controls.page=async()=>{entered.resolve();await late.promise;};
   const pending=fast.install(prepared.plan);
   try{await entered.promise;await rejected(()=>pending,'BOOTSTRAP_TIMEOUT');late.resolve();equal(await fast.replicaStore.read(),null);
    equal((await fast.migration.readCopy('migration-one')).status,'verified-copy');
   }finally{late.resolve();fast.close();h.close();}
  });
  await test('overlapping operations are rejected while the first protected preparation can finish',async()=>{
   const f=await fixture(),h=f.handles(),entered=deferred(),late=deferred();let once=true;
   f.controls.page=async()=>{if(once){once=false;entered.resolve();await late.promise;}};const pending=h.prepare();
   try{await entered.promise;await rejected(()=>h.prepare(),'BOOTSTRAP_BUSY');late.resolve();equal((await pending).status,'prepared');equal(await h.replicaStore.read(),null);}finally{late.resolve();h.close();}
  });
  await test('missing false or asynchronous writer-fence assertions cannot initialize a replica',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare();
   try{for(const fence of [undefined,()=>false,async()=>true]){
    await rejected(()=>h.bootstrap.install({migrationId:'migration-one',plan:prepared.plan,assertLegacyWritesBlocked:fence}),'BOOTSTRAP_FENCE');
    equal(await h.replicaStore.read(),null);
   }}finally{h.close();}
  });
  await test('a fence lost immediately before the atomic store call prevents any seed',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare();f.controls.progress=p=>{if(p.status==='installing')f.controls.blocked=false;};
   try{await rejected(()=>h.install(prepared.plan),'BOOTSTRAP_FENCE');equal(await h.replicaStore.read(),null);}finally{h.close();}
  });
  await test('quota failure leaves a verified shadow and permits exact installation retry',async()=>{
   const f=await fixture(),h=f.handles(),before=await h.source.capture(projectId),prepared=await h.prepare(),native=IDBObjectStore.prototype.add;
   IDBObjectStore.prototype.add=function(...a){if(this.transaction.db.name===f.names.normal)throw new DOMException('injected full disk','QuotaExceededError');return native.apply(this,a);};
   try{await rejected(()=>h.install(prepared.plan),'QuotaExceededError');}finally{IDBObjectStore.prototype.add=native;}
   try{equal(await h.replicaStore.read(),null);await preserved(f,h,before);equal((await h.install(prepared.plan)).status,'installed');}finally{h.close();}
  });
  await test('aborting an enqueued seed rolls back records outbox metadata and provenance together',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare(),native=IDBObjectStore.prototype.add;
   IDBObjectStore.prototype.add=function(...a){const q=native.apply(this,a);if(this.transaction.db.name===f.names.normal)this.transaction.abort();return q;};
   try{await rejected(()=>h.install(prepared.plan));}finally{IDBObjectStore.prototype.add=native;}
   try{equal(await h.replicaStore.read(),null);equal(await h.replicaStore.readProvenance(),null);equal((await h.install(prepared.plan)).status,'installed');}finally{h.close();}
  });
  await test('external abort after enqueue cannot leave a committed seed behind a rejected install',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare(),controller=new AbortController(),native=IDBObjectStore.prototype.add;
   IDBObjectStore.prototype.add=function(...a){const q=native.apply(this,a);if(this.transaction.db.name===f.names.normal)controller.abort();return q;};
   try{await rejected(()=>h.install(prepared.plan,{signal:controller.signal}),['BOOTSTRAP_ABORTED','DELTA_STORE_CANCELLED']);}finally{IDBObjectStore.prototype.add=native;}
   try{equal(await h.replicaStore.read(),null);equal(await h.replicaStore.readProvenance(),null);}finally{h.close();}
  });
  await test('scope loss after enqueue is caught before the seed transaction commits',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare(),native=IDBObjectStore.prototype.add;
   IDBObjectStore.prototype.add=function(...a){const q=native.apply(this,a);if(this.transaction.db.name===f.names.normal)f.controls.scope={...scope,ownerId:'other-owner'};return q;};
   try{await rejected(()=>h.install(prepared.plan),'BOOTSTRAP_SCOPE');}finally{IDBObjectStore.prototype.add=native;}
   try{equal(await h.replicaStore.read(),null);equal(await h.replicaStore.readProvenance(),null);}finally{h.close();}
  });
  await test('an existing independently saved replica is never replaced by the prepared seed',async()=>{
   const f=await fixture(),h=f.handles(),prepared=await h.prepare(),existing={version:2,scope:copy(scope),cursor:0,records:{},outbox:[],blockedOutbox:[]};
   existing.records[D.keyOf(drawingId,'unrelated')]=C.upgrade({id:'unrelated',memo:'先に保存した入力',photos:[]});
   try{await h.replicaStore.read();await h.replicaStore.write(existing);
    await rejected(()=>h.install(prepared.plan),'DELTA_BASELINE_EXISTS');equal(await h.replicaStore.read(),existing);
   }finally{h.close();}
  });
  await test('display callback failures cannot undo successful protection or atomic installation',async()=>{
   const f=await fixture(),h=f.handles();f.controls.progress=()=>{throw Error('injected UI failure');};
   try{const prepared=await h.prepare();equal(prepared.status,'prepared');equal((await h.install(prepared.plan)).status,'installed');}finally{h.close();}
  });
  return results;
 }
 if(typeof module==='object'&&module.exports)module.exports=run;
 root.runDeltaBootstrapCases=run;
})(typeof window!=='undefined'?window:globalThis);

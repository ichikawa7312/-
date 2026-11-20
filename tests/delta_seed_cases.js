/* Atomic initial-state installation scenarios, shared by fake and real IDB. */
(function(root){
  'use strict';
  async function run(engine='node'){
    const S=root.SentlogDeltaIndexedDB,D=root.SentlogDeltaSyncCore,C=root.SentlogRecordCollaboration;
    const scope={ownerId:'seed-owner',projectId:'seed-cloud-project',deviceId:'seed-device'},results=[];
    const clone=x=>structuredClone(x),assert=(ok,message)=>{if(!ok)throw Error(message||'assertion failed');};
    const equal=(a,b,message)=>assert(C.equal(a,b),message||'values differ');
    let serial=0;
    const database=()=>`sentlog-delta-test-seed-${engine}-${++serial}`;
    const store=(name,options={})=>S.createStore({...scope,databaseName:name,...options});
    const key=JSON.stringify([scope.ownerId,scope.projectId,scope.deviceId]);
    const record=()=>C.upgrade({id:'record',kind:'point',x:2,y:3,memo:'最初の所見 🌧️',photos:[]});
    function seed(){
      const before=record(),after=C.appendComment(before,'未送信の所見',{commentId:'local-comment',revisionId:'local-revision',
        actor:{deviceId:scope.deviceId,deviceName:'端末'},at:2});
      const event=D.diffRecord(before,after,{eventId:'event-one',projectId:scope.projectId,drawingId:'drawing',deviceId:scope.deviceId});
      return {state:{version:2,scope:clone(scope),cursor:0,records:{[D.keyOf('drawing','record')]:after},outbox:[event],blockedOutbox:[]},
        baseline:{schema:1,baselineId:'baseline-one',ownerId:scope.ownerId,projectId:scope.projectId,clientProjectId:'local-project',
          drawingIds:['drawing'],snapshotRevision:7,cursor:0,recordCount:1,importedCount:1,metadataCount:2,
          snapshotSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),metadataManifestSha256:'c'.repeat(64),
          hashFormat:'postgres-jsonb-text-sha256-v1',state:'active',deltaEnabled:true,deviceMigrationVerified:false,assetDeliveryVerified:false},
        source:{migrationId:'migration-one',localProjectId:'local-project',fingerprint:'d'.repeat(64)},planSha256:'e'.repeat(64),
        metadata:{header:{project:{id:'local-project',name:'引継ぎ案件',drawings:[{id:'drawing'}]}},
          drawings:[{meta:{id:'drawing'},state:{pageSettings:{1:{scale:100}},pageRotations:{1:90}}}],localView:{currentPage:1}},
        validate:()=>true};
    }
    async function rejects(fn,code){
      let e;try{await fn();}catch(error){e=error;}assert(e,'expected rejection '+code);
      if(code){const codes=Array.isArray(code)?code:[code];assert(codes.includes(e.code)||codes.includes(e.name),`expected ${code}, got ${e.code||e.name}: ${e.message}`);}return e;
    }
    async function test(name,fn){try{await fn();results.push(name);}catch(cause){throw new Error(name+': '+String(cause?.message||cause),{cause});}}
    async function within(task,label){let timer;try{return await Promise.race([task,new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error('timed out: '+label)),5000);
    })]);}finally{clearTimeout(timer);}}
    async function raw(name,fn){
      const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name,1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      try{return await new Promise((resolve,reject)=>{const tx=db.transaction('replicas','readwrite');let result;
        tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
        const q=tx.objectStore('replicas').get(key);q.onsuccess=()=>{result=q.result;fn?.(result,tx.objectStore('replicas'));};
      });}finally{db.close();}
    }
    await test('initial records outbox cursor metadata and provenance commit as one row',async()=>{
      const name=database(),s=store(name),input=seed(),saved=await s.installBaseline(input);
      assert(!saved.idempotent);equal(saved.revision,1);equal(saved.state,input.state);equal(await s.read(),input.state);
      const receipt=await s.readProvenance();equal(receipt.baseline,input.baseline);equal(receipt.source,input.source);
      equal(receipt.metadata,input.metadata);assert(/^[a-f0-9]{64}$/.test(receipt.initialStateSha256));
      const row=await raw(name);equal(row.state,input.state);equal(row.provenance,receipt);s.close();
    });
    await test('same seed retry returns current edits cursor and outbox without resetting anything',async()=>{
      const name=database(),s=store(name),input=seed();await s.installBaseline(input);
      const edited=await s.read();edited.cursor=9;edited.outbox=[];
      edited.records[D.keyOf('drawing','record')]=C.appendComment(edited.records[D.keyOf('drawing','record')],'引継ぎ後の編集',
        {commentId:'later-comment',revisionId:'later-revision',at:3});await s.write(edited);
      const retried=await s.installBaseline(input);assert(retried.idempotent);equal(retried.revision,2);equal(retried.state,edited);s.close();
      const reopened=store(name),again=await reopened.installBaseline(input);assert(again.idempotent);equal(again.state,edited);
      equal((await reopened.readProvenance()).metadata,input.metadata);reopened.close();
    });
    await test('normal saves retain seed provenance after close and reopen',async()=>{
      const name=database(),s=store(name),input=seed();await s.installBaseline(input);
      const original=await s.readProvenance(),state=await s.read();state.cursor=1;state.outbox=[];await s.write(state);s.close();
      const next=store(name);equal(await next.readProvenance(),original);equal((await next.read()).cursor,1);
      const output=await next.readProvenance();output.metadata.header.project.name='変更';equal(await next.readProvenance(),original);next.close();
    });
    await test('install captures nested input before asynchronous hashes and transactions',async()=>{
      const name=database(),s=store(name),input=seed(),expected=clone({...input,validate:undefined});delete expected.validate;
      const pending=s.installBaseline(input);input.state.cursor=12;input.state.outbox.length=0;input.baseline.clientProjectId='other';
      input.source.fingerprint='f'.repeat(64);input.metadata.header.project.name='変更';
      const saved=await pending;equal(saved.state,expected.state);equal(saved.provenance.baseline,expected.baseline);
      equal(saved.provenance.source,expected.source);equal(saved.provenance.metadata,expected.metadata);s.close();
    });
    await test('fresh simultaneous identical installs converge on one durable seed',async()=>{
      const name=database(),a=store(name),b=store(name),input=seed();
      const results=await Promise.all([a.installBaseline(input),b.installBaseline(input)]);
      equal(results.filter(x=>x.idempotent).length,1);equal(results.map(x=>x.revision),[1,1]);equal((await raw(name)).revision,1);a.close();b.close();
    });
    await test('competing different seeds never replace the winning installation',async()=>{
      const name=database(),a=store(name),b=store(name),one=seed(),two=seed();two.planSha256='f'.repeat(64);
      const outcomes=await Promise.allSettled([a.installBaseline(one),b.installBaseline(two)]);
      equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
      equal(outcomes.find(x=>x.status==='rejected').reason.code,'DELTA_BASELINE_EXISTS');equal((await raw(name)).revision,1);a.close();b.close();
    });
    await test('a previously read empty store still observes compare-and-swap during install',async()=>{
      const name=database(),a=store(name),b=store(name);await Promise.all([a.read(),b.read()]);await a.installBaseline(seed());
      await rejects(()=>b.installBaseline(seed()),'DELTA_STORE_STALE');equal((await raw(name)).revision,1);a.close();b.close();
    });
    await test('receipt reads cannot refresh a stale writer revision',async()=>{
      const name=database(),a=store(name),b=store(name);await a.installBaseline(seed());const stale=await b.read(),latest=await a.read();
      latest.cursor=1;await a.write(latest);assert(await b.readProvenance());
      await rejects(()=>b.write(stale),'DELTA_STORE_STALE');await rejects(()=>b.installBaseline(seed()),'DELTA_STORE_STALE');
      equal((await a.read()).cursor,1);a.close();b.close();
    });
    await test('an existing replica without provenance is never adopted or overwritten',async()=>{
      const name=database(),s=store(name),input=seed();await s.read();await s.write(input.state);const before=await raw(name);
      await rejects(()=>s.installBaseline(input),'DELTA_BASELINE_EXISTS');equal(await raw(name),before);s.close();
    });
    await test('changed migration source baseline metadata plan or initial records reject retry',async()=>{
      const name=database(),s=store(name);await s.installBaseline(seed());const original=await raw(name);
      for(const mutate of [x=>x.source.migrationId='different',x=>x.source.fingerprint='f'.repeat(64),x=>x.baseline.snapshotRevision++,
        x=>x.metadata.drawings[0].state.pageSettings[1].scale=200,x=>x.planSha256='f'.repeat(64),x=>x.state.outbox=[]]){
        const input=seed();mutate(input);await rejects(()=>s.installBaseline(input),'DELTA_BASELINE_EXISTS');equal(await raw(name),original);
      }s.close();
    });
    await test('foreign scope and inactive or partial baseline cannot create a seed',async()=>{
      for(const mutate of [x=>x.state.scope.ownerId='other',x=>x.baseline.ownerId='other',x=>x.baseline.projectId='other',
        x=>x.source.localProjectId='other',x=>{x.baseline.state='verified';x.baseline.deltaEnabled=false;},x=>x.baseline.importedCount=0]){
        const s=store(database()),input=seed();mutate(input);await rejects(()=>s.installBaseline(input),['DELTA_SCOPE','DELTA_BASELINE_FORMAT']);
        equal(await s.read(),null);s.close();
      }
    });
    await test('invalid initial cursor history queue and record identity fail deep validation',async()=>{
      for(const mutate of [x=>x.state.cursor=1,x=>x.state.outbox[0].deviceId='foreign',x=>x.state.records.bad=record(),
        x=>x.state.outbox.push(clone(x.state.outbox[0])),x=>x.state.blockedOutbox=[{event:clone(x.state.outbox[0]),reason:{message:'blocked'}}]]){
        const s=store(database()),input=seed();mutate(input);await rejects(()=>s.installBaseline(input));equal(await s.read(),null);s.close();
      }
    });
    await test('non-JSON metadata cannot silently lose values or store raw file bytes',async()=>{
      for(const value of [undefined,new Blob(['photo']),Infinity]){
        const s=store(database()),input=seed();input.metadata.extra=value;await rejects(()=>s.installBaseline(input),'DELTA_BASELINE_FORMAT');equal(await s.read(),null);s.close();
      }
      const s=store(database()),input=seed();input.metadata.loop=input.metadata;await rejects(()=>s.installBaseline(input),'DELTA_BASELINE_FORMAT');s.close();
    });
    await test('a missing asynchronous or revoked legacy writer fence prevents installation',async()=>{
      for(const validate of [undefined,()=>false,async()=>true]){
        const s=store(database()),input=seed();input.validate=validate;await rejects(()=>s.installBaseline(input),'DELTA_BASELINE_FENCE');equal(await s.read(),null);s.close();
      }
      const s=store(database()),input=seed();let held=true;input.validate=()=>held;
      const pending=s.installBaseline(input);held=false;await rejects(()=>pending,'DELTA_BASELINE_FENCE');equal(await s.read(),null);s.close();
    });
    await test('a fence revoked before the row read cannot commit even after hashes pass',async()=>{
      const name=database(),s=store(name),input=seed(),native=IDBObjectStore.prototype.get;let held=true;
      input.validate=()=>held;IDBObjectStore.prototype.get=function(...args){const q=native.apply(this,args);
        if(this.transaction.db.name===name)held=false;return q;};
      try{await rejects(()=>s.installBaseline(input),'DELTA_BASELINE_FENCE');}finally{IDBObjectStore.prototype.get=native;}
      equal(await s.read(),null);held=true;await s.installBaseline(input);s.close();
    });
    await test('quota failure leaves no seed receipt cursor or outbox and permits full retry',async()=>{
      const name=database(),s=store(name),native=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(...args){if(this.transaction.db.name===name)throw new DOMException('injected quota','QuotaExceededError');return native.apply(this,args);};
      try{await rejects(()=>s.installBaseline(seed()),'QuotaExceededError');}finally{IDBObjectStore.prototype.add=native;}
      equal(await s.read(),null);equal(await s.readProvenance(),null);assert(!(await s.installBaseline(seed())).idempotent);s.close();
    });
    await test('a writer fence lost after enqueue but before commit aborts the initial row',async()=>{
      const name=database(),s=store(name),input=seed(),native=IDBObjectStore.prototype.add;let held=true;
      input.validate=()=>held;IDBObjectStore.prototype.add=function(...args){const q=native.apply(this,args);
        if(this.transaction.db.name===name)held=false;return q;};
      try{await rejects(()=>s.installBaseline(input),'DELTA_BASELINE_FENCE');}finally{IDBObjectStore.prototype.add=native;}
      equal(await s.read(),null);equal(await s.readProvenance(),null);held=true;await s.installBaseline(input);s.close();
    });
    await test('transaction abort after enqueue rolls back all installation fields',async()=>{
      const name=database(),s=store(name),native=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(...args){const q=native.apply(this,args);if(this.transaction.db.name===name)this.transaction.abort();return q;};
      try{await rejects(()=>s.installBaseline(seed()));}finally{IDBObjectStore.prototype.add=native;}
      equal(await s.read(),null);equal(await s.readProvenance(),null);await s.installBaseline(seed());s.close();
    });
    await test('store close during enqueue settles promptly and retains no half-installed row',async()=>{
      const name=database(),s=store(name),native=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(...args){const q=native.apply(this,args);if(this.transaction.db.name===name)s.close();return q;};
      try{await within(rejects(()=>s.installBaseline(seed()),'DELTA_STORE_CLOSED'),'close during install');}
      finally{IDBObjectStore.prototype.add=native;}
      const next=store(name);equal(await within(next.read(),'reopen after cancelled install'),null);equal(await next.readProvenance(),null);
      await next.installBaseline(seed());next.close();
    });
    await test('lost native abort events cannot hang cancellation or revive a later success',async()=>{
      const name=database(),s=store(name),native=IDBObjectStore.prototype.add;let complete,abort,pending;
      IDBObjectStore.prototype.add=function(...args){const q=native.apply(this,args);if(this.transaction.db.name===name){
        const tx=this.transaction;complete=tx.oncomplete;abort=tx.onabort;tx.oncomplete=null;tx.onabort=null;s.close();
      }return q;};
      try{pending=s.installBaseline(seed());await within(rejects(()=>pending,'DELTA_STORE_CLOSED'),'lost abort event');}
      finally{IDBObjectStore.prototype.add=native;}
      const next=store(name);equal(await within(next.read(),'read after native rollback'),null);complete();abort();
      await rejects(()=>pending,'DELTA_STORE_CLOSED');await next.installBaseline(seed());next.close();
    });
    await test('external cancellation before and during install leaves the seed absent',async()=>{
      const s=store(database()),early=new AbortController();early.abort();await rejects(()=>s.installBaseline({...seed(),signal:early.signal}),'DELTA_STORE_CANCELLED');
      equal(await s.read(),null);s.close();
      const name=database(),next=store(name),controller=new AbortController(),native=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(...args){const q=native.apply(this,args);if(this.transaction.db.name===name)controller.abort();return q;};
      try{await within(rejects(()=>next.installBaseline({...seed(),signal:controller.signal}),'DELTA_STORE_CANCELLED'),'signal during install');}
      finally{IDBObjectStore.prototype.add=native;}
      equal(await next.read(),null);await next.installBaseline(seed());next.close();
    });
    await test('a corrupted metadata receipt fails verification without modifying saved bytes',async()=>{
      const name=database(),s=store(name);await s.installBaseline(seed());
      await raw(name,(row,rawStore)=>{row.provenance.metadata.header.project.name='改変';rawStore.put(row,key);});
      const before=await raw(name);await rejects(()=>s.readProvenance(),'DELTA_BASELINE_VERIFY');equal(await raw(name),before);s.close();
    });
    await test('a damaged first-revision state cannot reuse an otherwise valid seed receipt',async()=>{
      const name=database(),s=store(name);await s.installBaseline(seed());
      await raw(name,(row,rawStore)=>{row.state.records={};row.state.outbox=[];rawStore.put(row,key);});
      const before=await raw(name);
      await rejects(()=>s.installBaseline(seed()),'DELTA_BASELINE_VERIFY');await rejects(()=>s.read(),'DELTA_BASELINE_VERIFY');
      await rejects(()=>s.readProvenance(),'DELTA_BASELINE_VERIFY');equal(await raw(name),before);s.close();
      const reopened=store(name);await rejects(()=>reopened.installBaseline(seed()),'DELTA_BASELINE_VERIFY');reopened.close();
    });
    await test('a disappearing observed seed cannot be silently recreated by the same writer',async()=>{
      const name=database(),s=store(name);await s.installBaseline(seed());await raw(name,(row,rawStore)=>rawStore.delete(key));
      await rejects(()=>s.installBaseline(seed()),'DELTA_STORE_STALE');await rejects(()=>s.read(),'DELTA_STORE_MISSING');s.close();
    });
    return results;
  }
  if(typeof module==='object'&&module.exports)module.exports=run;else root.runDeltaSeedCases=run;
})(typeof window!=='undefined'?window:globalThis);

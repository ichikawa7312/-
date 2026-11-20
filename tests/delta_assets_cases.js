/* Shared Node/fake-IndexedDB and real-browser contract tests. Synthetic bytes only. */
(function(root){
  'use strict';
  function caseError(name,cause){
    // DOMException.message is read-only in WebKit. Preserve the actual
    // browser/storage error instead of throwing a second diagnostic error.
    const error=new Error(name+': '+(cause?.name||'Error')+': '+String(cause?.message??cause));
    error.cause=cause;error.caseName=name;
    error.originalName=cause?.name||'Error';error.originalMessage=String(cause?.message??cause);
    error.originalCode=cause?.code??null;error.originalStack=String(cause?.stack||'');
    return error;
  }
  async function run({API,CORE,indexedDB,IDBObjectStore,suffix='node',onStart=()=>{},onPass=()=>{},onStage=()=>{}}){
    const results=[],scope={ownerId:'owner-a',projectId:'project-a',deviceId:'device-a'};
    const clone=x=>structuredClone(x),assert=(x,m)=>{if(!x)throw Error(m||'assertion failed');};
    const equal=(a,b,m)=>assert(JSON.stringify(a)===JSON.stringify(b),m||JSON.stringify(a)+' != '+JSON.stringify(b));
    let serial=0;
    const dbName=()=>`sentlog-delta-assets-test-${suffix}-${++serial}`;
    const bytes=new Blob(['shared-photo-content'],{type:'image/jpeg'});
    async function hash(blob){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');}
    const base={ownerId:scope.ownerId,projectId:scope.projectId,assetId:'asset-1',drawingId:'drawing-1',photoId:'photo-1',
      variant:'shared',sha256:await hash(bytes),size:bytes.size,mimeType:'image/jpeg'};
    const proof=(ref,ctx=scope)=>({...clone(ref),deviceId:ctx.deviceId,durable:true});
    const makeStore=(name,ctx=scope)=>API.createIndexedDBStore({...ctx,databaseName:name,indexedDB});
    async function expect(fn,code){
      let error;try{await fn();}catch(e){error=e;}
      assert(error,'expected error '+code);
      assert(!code||error.code===code||error.name===code,`expected ${code}, got ${error.code||error.name}: ${error.message}`);
      return error;
    }
    async function fixture(extra={}){
      const name=extra.name||dbName(),store=extra.store||makeStore(name,extra.scope||scope),stats={downloads:0,acks:0};
      const refs=extra.refs||[clone(base)],state={scope:clone(extra.scope||scope),online:true};
      const transport={online:()=>state.online,
        async download(ref,options){stats.downloads++;if(extra.download)return extra.download(ref,options);return bytes;},
        async acknowledge(ref,options){stats.acks++;if(extra.acknowledge)return extra.acknowledge(ref,options);return proof(ref,state.scope);}};
      const queue=API.createQueue({scope:extra.scope||scope,store,transport,currentScope:()=>state.scope,...extra.options});
      return {name,store,queue,refs,state,stats,transport,close(){queue.close();store.close();}};
    }
    async function raw(name,ctx,ref,change){
      const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name,1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      try{return await new Promise((resolve,reject)=>{
        const tx=db.transaction('assets',change?'readwrite':'readonly'),store=tx.objectStore('assets');let value;
        tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);
        const key=JSON.stringify([ctx.ownerId,ctx.projectId,ctx.deviceId,ref.assetId]),q=store.get(key);
        q.onsuccess=()=>{value=q.result;if(change){value=change(value);store.put(value,key);}};
      });}finally{db.close();}
    }
    async function test(name,fn){
      onStart(name);let deadline;
      try{
        await Promise.race([fn(),new Promise((resolve,reject)=>{
          deadline=setTimeout(()=>reject(Error('photo test exceeded its 60-second deadline')),60000);
        })]);
        results.push(name);onPass(name);
      }catch(e){throw caseError(name,e);}finally{clearTimeout(deadline);}
    }
    async function stage(label,fn){
      onStage(label+' started');let deadline;
      try{
        const result=await Promise.race([fn(),new Promise((resolve,reject)=>{
          deadline=setTimeout(()=>reject(Error(label+' exceeded its 5-second deadline')),5000);
        })]);
        onStage(label+' passed');return result;
      }finally{clearTimeout(deadline);}
    }

    await test('read-only browser exceptions retain their original diagnostic details',async()=>{
      const original=Object.freeze(new DOMException('synthetic storage failure','TransactionInactiveError'));
      const wrapped=caseError('test-case',original);
      equal(original.message,'synthetic storage failure');assert(wrapped.cause===original);
      equal(wrapped.originalName,'TransactionInactiveError');equal(wrapped.originalMessage,original.message);
      assert(wrapped.message.includes('test-case: TransactionInactiveError: synthetic storage failure'));
    });
    await test('unregistered photo references never mean sync complete',async()=>{
      const f=await fixture(),status=await f.queue.status(f.refs);
      equal([status.total,status.untracked,status.pending,status.complete],[1,1,1,false]);equal(f.stats,{downloads:0,acks:0});f.close();
    });
    await test('missing current reference list is refused even with an empty queue',async()=>{
      const f=await fixture();await expect(()=>f.queue.status(),'ASSET_REFERENCE_SET');f.close();
    });
    await test('offline queue survives store close and reopen without claiming receipt',async()=>{
      const f=await fixture();f.state.online=false;const status=await f.queue.sync(f.refs);
      equal([status.waiting,status.complete],[1,false]);f.close();
      const s=makeStore(f.name),row=await s.read(base);equal([row.phase,row.blob,row.localReceipt,row.remoteReceipt],['waiting',null,null,null]);s.close();
    });
    await test('acknowledgement only follows durable verified bytes and matching local receipt',async()=>{
      let f;f=await fixture({acknowledge:async(ref)=>{
        const row=await f.store.read(ref);equal(row.phase,'received');await API.verifyBlob(row.blob,ref);
        equal([row.localReceipt.verified,row.remoteReceipt],[true,null]);return proof(ref);
      }});
      const result=await f.queue.sync(f.refs);equal([result.acknowledged,result.complete],[1,true]);
      equal(f.stats,{downloads:1,acks:1});const row=await f.store.read(base);equal([row.phase,row.remoteReceipt.durable],['acknowledged',true]);f.close();
    });
    await test('replayed sync and duplicate references never multiply downloads or receipts',async()=>{
      const f=await fixture();await f.queue.sync([base,clone(base)]);await f.queue.sync([base]);
      equal(f.stats,{downloads:1,acks:1});f.close();
    });
    await test('concurrent sync calls for the same reference set share one transfer',async()=>{
      const f=await fixture();const a=f.queue.sync([base]),b=f.queue.sync([clone(base)]);
      assert(a===b,'same work was not coalesced');await Promise.all([a,b]);equal(f.stats,{downloads:1,acks:1});f.close();
    });
    await test('a caller cannot mutate in-flight photograph metadata',async()=>{
      const f=await fixture(),refs=[clone(base)],pending=f.queue.sync(refs);refs[0].sha256='a'.repeat(64);refs.length=0;
      const result=await pending;assert(result.complete);await API.verifyBlob((await f.store.read(base)).blob,base);f.close();
    });
    await test('same asset ID with changed digest never overwrites existing bytes',async()=>{
      const f=await fixture();await f.queue.sync([base]);const before=await raw(f.name,scope,base);
      await expect(()=>f.queue.ensure([{...base,sha256:'0'.repeat(64)}]),'ASSET_COLLISION');
      const after=await raw(f.name,scope,base);equal(after.revision,before.revision);await API.verifyBlob(after.blob,base);f.close();
    });
    await test('two IDs targeting the same shared photo are refused before saving',async()=>{
      const f=await fixture();await expect(()=>f.queue.ensure([base,{...base,assetId:'other'}]),'ASSET_COLLISION');
      equal(await f.store.read(base),null);f.close();
    });
    await test('uppercase SHA256 normalizes to the same immutable reference',async()=>{
      const f=await fixture();await f.queue.ensure([{...base,sha256:base.sha256.toUpperCase()}]);
      await f.queue.sync([base]);equal(f.stats,{downloads:1,acks:1});f.close();
    });
    await test('shared and original identities remain separate and originals require explicit opt in',async()=>{
      const f=await fixture(),original={...base,assetId:'original-asset',variant:'original'};
      await f.queue.sync([base]);await expect(()=>f.queue.sync([base,original]),'ASSET_ORIGINAL_NOT_REQUESTED');
      equal(f.stats,{downloads:1,acks:1});equal((await f.store.read(original)).phase,'waiting');
      const enabled=API.createQueue({scope,store:f.store,transport:f.transport,currentScope:()=>f.state.scope,allowOriginals:true});
      const result=await enabled.sync([base,original]);equal([result.total,result.acknowledged],[2,2]);
      equal((await f.store.read(base)).reference.variant,'shared');equal((await f.store.read(original)).reference.variant,'original');enabled.close();f.close();
    });
    await test('wrong-sized response remains queued and is never acknowledged',async()=>{
      const f=await fixture({download:async()=>new Blob(['short'],{type:'image/jpeg'})});
      await expect(()=>f.queue.sync(f.refs),'ASSET_CONTENT_MISMATCH');equal((await f.store.read(base)).phase,'waiting');equal(f.stats.acks,0);f.close();
    });
    await test('same-size corrupt photograph remains queued and never receives a receipt',async()=>{
      const f=await fixture({download:async()=>new Blob(['x'.repeat(bytes.size)],{type:'image/jpeg'})});
      await expect(()=>f.queue.sync(f.refs),'ASSET_CONTENT_MISMATCH');const row=await f.store.read(base);
      equal([row.phase,row.blob,row.localReceipt],['waiting',null,null]);equal(f.stats.acks,0);f.close();
    });
    await test('foreign or mismatched acknowledgement preserves bytes and remains pending',async()=>{
      for(const [key,value]of Object.entries({ownerId:'other-owner',projectId:'other-project',deviceId:'other-device',assetId:'other-asset',
        drawingId:'other-drawing',photoId:'other-photo',variant:'original',sha256:'0'.repeat(64),size:bytes.size+1,durable:false})){
        const f=await fixture({acknowledge:async ref=>({...proof(ref),[key]:value})});
        await expect(()=>f.queue.sync(f.refs),'ASSET_ACK_MISMATCH');const row=await f.store.read(base);
        equal([row.phase,row.remoteReceipt],['received',null],key);await API.verifyBlob(row.blob,base);f.close();
      }
    });
    await test('403 and network failures preserve their waiting entry',async()=>{
      for(const status of [403,500]){
        const error=Object.assign(Error('synthetic HTTP '+status),{status}),f=await fixture({download:async()=>{throw error;}});
        const caught=await expect(()=>f.queue.sync(f.refs));equal(caught.status,status);
        equal((await f.store.read(base)).phase,'waiting');equal(f.stats.acks,0);f.close();
      }
    });
    await test('lost acknowledgement resumes from verified local bytes without another download',async()=>{
      let fail=true;const f=await fixture({acknowledge:async ref=>{if(fail)throw Error('server saved receipt but response lost');return proof(ref);}});
      await expect(()=>f.queue.sync(f.refs));equal((await f.store.read(base)).phase,'received');f.queue.close();f.store.close();
      fail=false;const reopened=await fixture({name:f.name});const result=await reopened.queue.sync([base]);
      assert(result.complete);equal(reopened.stats,{downloads:0,acks:1});reopened.close();
    });
    await test('bounded timeout keeps waiting data and late bytes cannot commit',async()=>{
      let release;const f=await fixture({download:async()=>new Promise(resolve=>{release=resolve;}),options:{timeoutMs:10}});
      await expect(()=>f.queue.sync(f.refs),'ASSET_TIMEOUT');release(bytes);await Promise.resolve();
      equal((await f.store.read(base)).phase,'waiting');equal(f.stats.acks,0);f.close();
    });
    await test('account change while downloading prevents receiving and acknowledging late bytes',async()=>{
      let f;f=await fixture({download:async()=>{f.state.scope={...scope,ownerId:'other'};return bytes;}});
      await expect(()=>f.queue.sync(f.refs),'ASSET_SCOPE');equal((await f.store.read(base)).phase,'waiting');equal(f.stats.acks,0);f.close();
    });
    await test('device change during acknowledgement does not mark the old queue complete',async()=>{
      let f;f=await fixture({acknowledge:async ref=>{f.state.scope={...scope,deviceId:'other'};return proof(ref);}});
      await expect(()=>f.queue.sync(f.refs),'ASSET_SCOPE');equal((await f.store.read(base)).phase,'received');f.close();
    });
    await test('owner project and device each isolate stored files and receipts',async()=>{
      const f=await fixture();await f.queue.sync([base]);
      for(const field of ['ownerId','projectId','deviceId']){
        const ctx={...scope,[field]:'other'},s=makeStore(f.name,ctx),ref={...base,ownerId:ctx.ownerId,projectId:ctx.projectId};
        equal(await s.read(ref),null,field+' leaked');s.close();
      }
      await expect(()=>f.store.ensure({...base,projectId:'other'}),'ASSET_SCOPE');f.close();
    });
    await test('reference-set change during download prevents applying the stale response',async()=>{
      let f;const added={...base,assetId:'asset-2',photoId:'photo-2'};
      f=await fixture({download:async()=>{await f.queue.ensure([base,added]);return bytes;}});
      await expect(()=>f.queue.sync([base]),'ASSET_REFERENCES_CHANGED');equal((await f.store.read(base)).phase,'waiting');
      const status=await f.queue.status([base,added]);equal([status.pending,status.complete],[2,false]);equal(f.stats.acks,0);f.close();
    });
    await test('reference-set change during acknowledgement retains pending local receipt',async()=>{
      let f;const added={...base,assetId:'asset-2',photoId:'photo-2'};
      f=await fixture({acknowledge:async ref=>{await f.queue.ensure([base,added]);return proof(ref);}});
      await expect(()=>f.queue.sync([base]),'ASSET_REFERENCES_CHANGED');equal((await f.store.read(base)).phase,'received');f.close();
    });
    await test('injected quota failure commits neither photo bytes nor a receipt',async()=>{
      const f=await fixture();await f.queue.ensure([base]);const native=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value,...args){
        if(this.transaction.db.name===f.name&&value.phase==='received')throw new DOMException('synthetic quota','QuotaExceededError');
        return native.call(this,value,...args);
      };
      try{await expect(()=>f.queue.sync([base]),'QuotaExceededError');}finally{IDBObjectStore.prototype.put=native;}
      const row=await f.store.read(base);equal([row.phase,row.blob,row.localReceipt],['waiting',null,null]);equal(f.stats.acks,0);
      assert((await f.queue.sync([base])).complete);f.close();
    });
    await test('transaction abort rolls back photo bytes queue state and receipt together',async()=>{
      const f=await fixture();await f.queue.ensure([base]);const native=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value,...args){const q=native.call(this,value,...args);
        if(this.transaction.db.name===f.name&&value.phase==='received')this.transaction.abort();return q;};
      try{await expect(()=>f.queue.sync([base]));}finally{IDBObjectStore.prototype.put=native;}
      const row=await f.store.read(base);equal([row.phase,row.blob,row.localReceipt],['waiting',null,null]);equal(f.stats.acks,0);f.close();
    });
    await test('closing during a download rejects the pending request and ignores late success',async()=>{
      let f,release;f=await fixture({download:async()=>new Promise(resolve=>{release=resolve;f.queue.close();})});
      await expect(()=>f.queue.sync([base]),'ASSET_CLOSED');release(bytes);await Promise.resolve();
      equal((await f.store.read(base)).phase,'waiting');equal(f.stats.acks,0);f.store.close();
    });
    await test('store close during received transaction prevents a partial durable row',async()=>{
      const f=await fixture();await f.queue.ensure([base]);const native=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value,...args){const q=native.call(this,value,...args);
        if(this.transaction.db.name===f.name&&value.phase==='received')f.store.close();return q;};
      try{await stage('close transaction: sync rejection',()=>expect(()=>f.queue.sync([base]),'ASSET_CLOSED'));}
      finally{IDBObjectStore.prototype.put=native;}
      const reopened=makeStore(f.name),row=await stage('close transaction: reopened durable read',()=>reopened.read(base));
      equal([row.phase,row.blob,row.localReceipt],['waiting',null,null]);
      equal(f.stats.acks,0);reopened.close();f.queue.close();
    });
    await test('store close rejects even when the browser drops the transaction abort event',async()=>{
      const f=await fixture();await f.queue.ensure([base]);const native=IDBObjectStore.prototype.put;
      let lateComplete=null,reopened=null;
      IDBObjectStore.prototype.put=function(value,...args){const q=native.call(this,value,...args);
        if(this.transaction.db.name===f.name&&value.phase==='received'){
          // Simulate delayed or missing native transaction notifications.
          lateComplete=this.transaction.oncomplete;
          this.transaction.onabort=null;this.transaction.oncomplete=null;f.store.close();
        }return q;};
      try{
        try{await stage('dropped abort event: sync rejection',()=>expect(()=>f.queue.sync([base]),'ASSET_CLOSED'));}
        finally{IDBObjectStore.prototype.put=native;}
        reopened=makeStore(f.name);
        const row=await stage('dropped abort event: reopened durable read',()=>reopened.read(base));
        equal([row.phase,row.blob,row.localReceipt,row.remoteReceipt],['waiting',null,null,null]);
        equal(f.stats.acks,0);assert(typeof lateComplete==='function','missing captured completion handler');
        // A delayed completion cannot reverse the rejection or publish a receipt.
        // It also performs the deferred physical connection cleanup.
        lateComplete();lateComplete=null;
        const after=await stage('dropped abort event: read after delayed completion',()=>reopened.read(base));
        equal([after.phase,after.blob,after.localReceipt,after.remoteReceipt],['waiting',null,null,null]);
        equal(f.stats.acks,0);
      }finally{
        IDBObjectStore.prototype.put=native;if(lateComplete)lateComplete();
        if(reopened)reopened.close();f.close();
      }
    });
    await test('missing persisted Blob prevents completion even with an acknowledged receipt',async()=>{
      const f=await fixture();await f.queue.sync([base]);await raw(f.name,scope,base,row=>({...row,blob:null}));
      await expect(()=>f.queue.status([base]),'ASSET_STORE_INVALID');f.close();
    });
    await test('same-size altered persisted bytes are detected before status says complete',async()=>{
      const f=await fixture();await f.queue.sync([base]);
      await raw(f.name,scope,base,row=>({...row,blob:new Blob(['x'.repeat(bytes.size)],{type:'image/jpeg'})}));
      await expect(()=>f.queue.status([base]),'ASSET_CONTENT_MISMATCH');f.close();
    });
    await test('a server acknowledgement cannot bypass local-byte durability',async()=>{
      const f=await fixture();await f.queue.ensure([base]);
      await expect(()=>f.store.acknowledged(base,proof(base)),'ASSET_NOT_DURABLE');equal((await f.store.read(base)).phase,'waiting');f.close();
    });
    await test('repeated received responses preserve acknowledged state and retain original bytes',async()=>{
      const f=await fixture();await f.queue.sync([base]);const before=await f.store.read(base);
      await f.store.received(base,bytes);const after=await f.store.read(base);
      equal([after.phase,after.revision],['acknowledged',before.revision]);await API.verifyBlob(after.blob,base);f.close();
    });
    await test('commit guard catches a scope change inside the storage transaction',async()=>{
      const f=await fixture();await f.queue.ensure([base]);
      await expect(()=>f.store.received(base,bytes,{validate(){throw Object.assign(Error('changed'),{code:'ASSET_SCOPE'});}}),'ASSET_SCOPE');
      equal((await f.store.read(base)).phase,'waiting');f.close();
    });
    await test('configured byte limit leaves an oversized photo queued without sending it',async()=>{
      const f=await fixture({options:{maxBytes:1}});await expect(()=>f.queue.sync([base]),'ASSET_TOO_LARGE');
      equal((await f.store.read(base)).phase,'waiting');equal(f.stats,{downloads:0,acks:0});f.close();
    });
    await test('only empty pending records and every confirmed photo can show overall complete',async()=>{
      const f=await fixture(),snapshotToken=Object.freeze({}),records={scope,snapshotToken,level:'ok',pending:0,blocked:0,conflicts:0};
      const context={scope,recordSnapshotToken:snapshotToken,references:[base]};
      equal(API.combinedStatus(records,await f.queue.status([base]),context).complete,false);
      const photos=await f.queue.sync([base]);assert(API.combinedStatus(records,photos,context).complete);
      for(const field of ['pending','blocked','conflicts'])equal(API.combinedStatus({...records,[field]:1},photos,context).complete,false);
      equal(API.combinedStatus({...records,level:'offline'},photos,context).complete,false);
      equal(API.combinedStatus(records,{...photos,total:2},context).complete,false);equal(API.combinedStatus(records,null,context).complete,false);f.close();
    });
    await test('old photo status cannot complete a new record snapshot with an extra photograph',async()=>{
      const f=await fixture(),snapshotToken=Object.freeze({}),records={scope,snapshotToken,level:'ok',pending:0,blocked:0,conflicts:0},photos=await f.queue.sync([base]);
      const added={...base,assetId:'added',photoId:'added'};
      equal(API.combinedStatus(records,photos,{scope,recordSnapshotToken:snapshotToken,references:[base,added]}).complete,false);
      equal(API.combinedStatus(records,photos).complete,false);
      equal(API.combinedStatus(records,photos,{scope:{...scope,deviceId:'other'},recordSnapshotToken:snapshotToken,references:[base]}).complete,false);
      for(const field of ['ownerId','projectId','deviceId']){
        equal(API.combinedStatus({...records,scope:{...scope,[field]:'other'}},photos,
          {scope,recordSnapshotToken:snapshotToken,references:[base]}).complete,false);
      }
      equal(API.combinedStatus(records,photos,{scope,recordSnapshotToken:Object.freeze({}),references:[base]}).complete,false);
      f.close();
    });
    await test('real replica statuses identify scope and invalidate completion after a new durable edit',async()=>{
      assert(CORE&&typeof CORE.createReplica==='function','delta core is required for snapshot status test');
      let saved=null,online=true;const statuses=[],f=await fixture();
      const replica=CORE.createReplica({...scope,reconcileIntervalMs:0,
        store:{getScope:()=>clone(scope),read:async()=>clone(saved),write:async value=>{saved=clone(value);}},
        transport:{online:()=>online,list:async()=>[],push:async()=>{throw Error('no live uploads in this test');}},
        onStatus:value=>statuses.push(value)});
      try{
        await replica.start();const completed=statuses.at(-1),current=await replica.snapshotWithStatus(),photos=await f.queue.status([]);
        equal(completed.scope,scope);equal(completed.level,'ok');
        assert(completed.snapshotToken===current.snapshotToken,'status does not identify current snapshot');
        assert(API.combinedStatus(completed,photos,{scope,recordSnapshotToken:current.snapshotToken,references:[]}).complete);
        online=false;
        await replica.change({drawingId:'drawing-1',before:null,after:{id:'new-record',memo:'圏外の追記',photos:[]},eventId:'new-event'});
        const updated=await replica.snapshotWithStatus();assert(updated.snapshotToken!==current.snapshotToken,'new save retained old identity');
        equal(API.combinedStatus(completed,photos,{scope,recordSnapshotToken:updated.snapshotToken,references:[]}).complete,false);
        equal(updated.snapshot.outbox.length,1);
      }finally{replica.close();f.close();}
    });
    await test('large manifest counts every undelivered reference without counting metadata as a file',async()=>{
      const f=await fixture(),refs=Array.from({length:1002},(_,i)=>({...base,assetId:'asset-'+i,photoId:'photo-'+i}));
      f.state.online=false;const status=await f.queue.sync(refs);
      equal([status.total,status.waiting,status.pending,status.complete],[1002,1002,1002,false]);equal(f.stats,{downloads:0,acks:0});f.close();
    });
    await test('legacy database names cannot be opened or upgraded by the asset adapter',async()=>{
      await expect(()=>API.createIndexedDBStore({...scope,indexedDB,databaseName:'surveyFieldNoteDB'}),'ASSET_STORE_CONFIG');
    });
    return results;
  }
  if(typeof module==='object'&&module.exports)module.exports={run};
  else root.SentlogAssetTestCases={run};
})(typeof window!=='undefined'?window:globalThis);

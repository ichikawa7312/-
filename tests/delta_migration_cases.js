/* Shared failure scenarios. Run on fake-indexeddb AND real Chromium/WebKit.
 * All databases use the disposable sentlog-delta-test-* namespace.
 */
(function(root){
  'use strict';
  async function run(engine='node'){
    const API=root.SentlogDeltaMigration,results=[];
    const scope={ownerId:'owner-one',projectId:'cloud-project',deviceId:'device-one'};
    const localProjectId='local-project',copy=x=>structuredClone(x);
    const assert=(ok,message)=>{if(!ok)throw Error(message);};
    const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?
      Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
    const equal=(a,b,message)=>assert(JSON.stringify(stable(a))===JSON.stringify(stable(b)),message||'values differ');
    const reject=async(fn,code)=>{let e;try{await fn();}catch(caught){e=caught;}assert(e,'expected rejection '+code);
      if(code)assert(e.code===code||e.name===code,`expected ${code}, got ${e.code||e.name}: ${e.message}`);return e;};
    const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
    let serial=0;
    const database=()=>`sentlog-delta-test-migration-${engine}-${++serial}`;
    async function fixture(count=3){
      const files=[];
      for(let i=0;i<count;i++){
        const blob=new Blob(['photo-'+i],{type:'image/jpeg'});
        files.push({key:'photo:drawing:'+i,kind:'shared-photo',drawingId:'drawing',photoId:String(i),blob,size:blob.size,sha256:await hash(blob)});
      }
      const snapshot={version:1,kind:'sentlog-legacy-source',projectId:localProjectId,source:{recordRevision:7},
        rawEntries:[{key:'surveyFieldNoteDrawingV1:drawing',value:'{"shapes":[{"id":"r1","memo":"未送信 🌧️"}]}'}],
        originals:[],captureIntentRaw:null,files,manifest:[],issues:[],fingerprint:'a'.repeat(64),
        readyForStaging:true,readyForActivation:false};
      const source={capture:async project=>{equal(project,localProjectId,'local/cloud IDs must not be confused');return copy(snapshot);},
        recheck:async old=>({unchanged:old.fingerprint===snapshot.fingerprint,expectedFingerprint:old.fingerprint,actualFingerprint:snapshot.fingerprint,issues:[]})};
      return {snapshot,source};
    }
    const openStore=(name,more={})=>API.createStore({...scope,indexedDB,databaseName:name,...more});
    const coordinator=(source,store,more={})=>API.createCoordinator({source,store,localProjectId,currentScope:()=>copy(scope),batchItems:1,...more});
    async function raw(name,store,fn){
      const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name,1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);fn(tx.objectStore(store));});}
      finally{db.close();}
    }
    async function test(name,fn){try{await fn();results.push(name);}catch(cause){
      // DOMException.message may be readonly in WebKit. Preserve the original
      // failure instead of hiding it behind another assignment TypeError.
      const failure=new Error(name+': '+(cause?.message||String(cause)));
      failure.cause=cause;failure.originalName=cause?.name;
      if(cause?.code!==undefined)failure.code=cause.code;
      throw failure;
    }}
    async function within(task,label){
      let timer;
      try{return await Promise.race([task,new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(Error('timed out while '+label)),5000);
      })]);}finally{clearTimeout(timer);}
    }
    async function savedItemKeys(name){
      const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name);
        q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      try{return await new Promise((resolve,reject)=>{
        const tx=db.transaction('items','readonly');let keys;
        tx.oncomplete=()=>resolve(keys);tx.onabort=()=>reject(tx.error);
        tx.objectStore('items').getAllKeys().onsuccess=e=>{keys=e.target.result;};
      });}finally{db.close();}
    }
    await test('exact raw records and photo bytes survive staging and reopening',async()=>{
      const f=await fixture(),name=database(),s=openStore(name),m=coordinator(f.source,s);
      const before=copy(f.snapshot),done=await m.stage('one');equal(done.status,'verified-copy');assert(done.verifiedBytes);
      equal(done.readyForActivation,false);equal(done.readyForCloudSync,false);m.close();
      const second=coordinator(f.source,openStore(name)),saved=await second.readCopy('one');
      equal(saved.snapshot.rawEntries,before.rawEntries);equal(saved.snapshot.captureIntentRaw,before.captureIntentRaw);
      for(let i=0;i<before.files.length;i++)equal(await saved.snapshot.files[i].blob.text(),await before.files[i].blob.text());
      equal(f.snapshot.rawEntries,before.rawEntries,'source changed');second.close();
    });
    await test('repeating the same copy never duplicates photos or resets progress',async()=>{
      const f=await fixture(),s=openStore(database()),m=coordinator(f.source,s);
      const a=await m.stage('repeat'),b=await m.stage('repeat');equal(a.next,b.next);equal(a.manifest,b.manifest);
      equal((await m.readCopy('repeat')).snapshot.files.length,f.snapshot.files.length);m.close();
    });
    await test('interrupt after a committed chunk resumes from its durable checkpoint',async()=>{
      const f=await fixture(5),name=database(),s=openStore(name);let m;
      m=coordinator(f.source,s,{onProgress:p=>{if(p.copied===2)m.close();}});
      await reject(()=>m.stage('resume'),'MIGRATION_CLOSED');
      const reopened=openStore(name);equal((await reopened.status('resume')).next,2);
      const retry=coordinator(f.source,reopened);equal((await retry.stage('resume')).next,6);
      equal((await retry.readCopy('resume')).snapshot.files.length,5);retry.close();
    });
    await test('aborted chunk cannot advance its checkpoint or keep half a batch',async()=>{
      const f=await fixture(),name=database(),s=openStore(name),m=coordinator(f.source,s,{batchItems:4});
      const native=IDBObjectStore.prototype.add;let n=0;
      IDBObjectStore.prototype.add=function(...args){const q=native.apply(this,args);
        if(this.transaction.db.name===name&&this.name==='items'&&++n===2)this.transaction.abort();return q;};
      try{await reject(()=>m.stage('abort'));}finally{IDBObjectStore.prototype.add=native;}
      equal((await s.status('abort')).next,0,'checkpoint survived aborted items');
      equal((await m.stage('abort')).status,'verified-copy');m.close();
    });
    for(const target of ['item','checkpoint'])await test('store close during '+target+' enqueue rejects and rolls back the whole chunk',async()=>{
      const f=await fixture(3),name=database(),s=openStore(name),m=coordinator(f.source,s,{batchItems:4});
      const nativeAdd=IDBObjectStore.prototype.add,nativePut=IDBObjectStore.prototype.put;let cancelled=false;
      function wrap(native){return function(value,...args){
        const q=native.call(this,value,...args);
        const matches=target==='item'?this.name==='items':this.name==='sessions'&&value.next===4;
        if(!cancelled&&this.transaction.db.name===name&&matches){cancelled=true;s.close();}
        return q;
      };}
      IDBObjectStore.prototype.add=wrap(nativeAdd);IDBObjectStore.prototype.put=wrap(nativePut);
      try{await within(reject(()=>m.stage('mid-close'),'MIGRATION_CLOSED'),'waiting for '+target+' close rejection');}
      finally{IDBObjectStore.prototype.add=nativeAdd;IDBObjectStore.prototype.put=nativePut;}
      assert(cancelled,'close was never injected');
      const reopened=openStore(name);
      const row=await within(reopened.status('mid-close'),'reopening after '+target+' close');
      equal(row.next,0,'cancelled chunk advanced checkpoint');equal(row.status,'copying');
      equal(await within(savedItemKeys(name),'reading items after '+target+' close'),[],'aborted chunk retained orphan items');
      const resumed=coordinator(f.source,reopened);
      equal((await within(resumed.stage('mid-close'),'resuming after '+target+' close')).status,'verified-copy');
      equal((await resumed.readCopy('mid-close')).snapshot.files.length,3);resumed.close();m.close();
    });
    await test('lost abort event cannot hang cancellation and delayed completion cannot restore success',async()=>{
      const f=await fixture(3),name=database(),s=openStore(name),m=coordinator(f.source,s,{batchItems:4});
      const native=IDBObjectStore.prototype.add;let lateComplete,lateAbort,cancelled=false;
      IDBObjectStore.prototype.add=function(...args){
        const q=native.apply(this,args);
        if(!cancelled&&this.transaction.db.name===name&&this.name==='items'){
          cancelled=true;const tx=this.transaction;lateComplete=tx.oncomplete;lateAbort=tx.onabort;
          tx.oncomplete=null;tx.onabort=null;s.close();
        }
        return q;
      };
      let pending;
      try{pending=m.stage('lost-events');await within(reject(()=>pending,'MIGRATION_CLOSED'),'waiting for cancellation without native events');}
      finally{IDBObjectStore.prototype.add=native;}
      assert(cancelled&&lateComplete&&lateAbort,'event loss was not injected');
      const reopened=openStore(name),row=await within(reopened.status('lost-events'),'reopening after native events were lost');
      equal(row.next,0);equal(await within(savedItemKeys(name),'checking rollback without abort callbacks'),[]);
      // Simulate delayed native notifications only after the rollback is known
      // to be complete; they must never turn the earlier rejection into success.
      lateComplete();lateAbort();
      await within(reject(()=>pending,'MIGRATION_CLOSED'),'checking delayed completion remains cancelled');
      const resumed=coordinator(f.source,reopened);
      equal((await within(resumed.stage('lost-events'),'resuming the cancelled copy')).status,'verified-copy');
      equal((await resumed.readCopy('lost-events')).snapshot.files.length,3);resumed.close();m.close();
    });
    await test('quota failure preserves the old source and permits a complete retry',async()=>{
      const f=await fixture(),before=copy(f.snapshot.rawEntries),name=database(),s=openStore(name),m=coordinator(f.source,s);
      const native=IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add=function(...args){if(this.transaction.db.name===name&&this.name==='items')throw new DOMException('injected disk full','QuotaExceededError');return native.apply(this,args);};
      try{await reject(()=>m.stage('quota'),'QuotaExceededError');}finally{IDBObjectStore.prototype.add=native;}
      equal(f.snapshot.rawEntries,before);equal((await s.status('quota')).next,0);
      equal((await m.stage('quota')).status,'verified-copy');m.close();
    });
    await test('two actual connections to the same staging DB converge without overwrites',async()=>{
      const f=await fixture(7),name=database(),a=coordinator(f.source,openStore(name)),b=coordinator(f.source,openStore(name));
      const results=await Promise.all([a.stage('race'),b.stage('race')]);
      assert(results.every(r=>r.status==='verified-copy'));equal(results[0].next,8);equal(results[0].bundleHash,results[1].bundleHash);
      a.close();b.close();
    });
    await test('a changed source with the same migration ID cannot replace its earlier copy',async()=>{
      const f=await fixture(),s=openStore(database()),m=coordinator(f.source,s);await m.stage('unchanged');
      const old=(await m.readCopy('unchanged')).snapshot.rawEntries;
      f.snapshot.rawEntries[0].value='{"shapes":[]}';f.snapshot.fingerprint='b'.repeat(64);
      await reject(()=>m.stage('unchanged'),'MIGRATION_SOURCE_CHANGED');
      equal((await m.readCopy('unchanged')).snapshot.rawEntries,old);m.close();
    });
    await test('same source fingerprint with different content is also rejected',async()=>{
      const f=await fixture(),s=openStore(database()),m=coordinator(f.source,s);await m.stage('fingerprint');
      f.snapshot.rawEntries[0].value='{"memo":"changed without revision"}';
      await reject(()=>m.stage('fingerprint'),'MIGRATION_SOURCE_CHANGED');m.close();
    });
    await test('edit during copying leaves a complete review copy without activation',async()=>{
      const f=await fixture(),s=openStore(database()),m=coordinator(f.source,s,{onProgress:p=>{if(p.copied===1)f.snapshot.fingerprint='b'.repeat(64);}});
      const result=await m.stage('changed');equal(result.status,'needs-review');equal(result.sourceUnchanged,false);
      assert(result.issues.some(i=>i.code==='MIGRATION_SOURCE_CHANGED'));equal(result.readyForActivation,false);
      equal((await m.readCopy('changed')).snapshot.files.length,3);m.close();
    });
    await test('a pending camera association is preserved and never marked ready',async()=>{
      const f=await fixture();f.snapshot.captureIntentRaw='{"pending":{"photoId":"not-attached"}}';
      f.snapshot.originals=[{key:'drawing:not-attached',meta:{photoAssociation:{status:'pending'}}}];
      f.snapshot.issues=[{code:'LEGACY_PENDING_CAPTURE',blocking:true,message:'未添付の写真'}];
      const m=coordinator(f.source,openStore(database())),r=await m.stage('camera');equal(r.status,'needs-review');
      const saved=await m.readCopy('camera');equal(saved.snapshot.captureIntentRaw,f.snapshot.captureIntentRaw);equal(saved.snapshot.originals,f.snapshot.originals);m.close();
    });
    await test('missing photos remain explicitly unresolved while all available bytes are retained',async()=>{
      const f=await fixture(1);f.snapshot.manifest=[{key:'photo:missing',status:'missing'}];
      f.snapshot.issues=[{code:'LEGACY_FILE_MISSING',blocking:true}];
      const m=coordinator(f.source,openStore(database())),r=await m.stage('missing');equal(r.status,'needs-review');
      equal((await m.readCopy('missing')).snapshot.files.length,1);m.close();
    });
    await test('account switch during capture prevents copying into the wrong account',async()=>{
      const f=await fixture(),name=database(),s=openStore(name);let account=scope.ownerId;
      const capture=f.source.capture;f.source.capture=async p=>{const result=await capture(p);account='other';return result;};
      const m=coordinator(f.source,s,{currentScope:()=>({...scope,ownerId:account})});
      await reject(()=>m.stage('account'),'MIGRATION_SCOPE_CHANGED');equal(await s.status('account'),null);m.close();
    });
    await test('account project and device isolate staging even with identical migration IDs',async()=>{
      const f=await fixture(),name=database(),s=openStore(name),m=coordinator(f.source,s);await m.stage('private');
      for(const field of ['ownerId','projectId','deviceId']){
        const other=openStore(name,{[field]:'someone-else'});equal(await other.status('private'),null);other.close();
      }
      equal((await m.readCopy('private')).snapshot.files.length,3);m.close();
    });
    await test('same-size file corruption is caught before copying',async()=>{
      const f=await fixture();f.snapshot.files[0].blob=new Blob(['changed'],{type:'image/jpeg'});
      const m=coordinator(f.source,openStore(database()));await reject(()=>m.stage('hash'),'MIGRATION_FILE_CHANGED');m.close();
    });
    await test('corrupt bytes in the target cannot be returned as a verified copy',async()=>{
      const f=await fixture(),name=database(),s=openStore(name),m=coordinator(f.source,s);await m.stage('corrupt');
      const prefix=JSON.stringify([scope.ownerId,scope.projectId,scope.deviceId]);
      await raw(name,'items',store=>{const q=store.get([prefix,'corrupt',1]);q.onsuccess=()=>{
        const row=q.result;row.value=new Blob(['changed'],{type:'image/jpeg'});store.put(row,[prefix,'corrupt',1]);};});
      await reject(()=>m.readCopy('corrupt'),'MIGRATION_VERIFY');await reject(()=>m.stage('corrupt'),'MIGRATION_VERIFY');m.close();
    });
    await test('source project mismatch is rejected instead of migrating an empty or foreign project',async()=>{
      const f=await fixture();f.snapshot.projectId='wrong';const s=openStore(database()),m=coordinator(f.source,s);
      await reject(()=>m.stage('foreign'),'MIGRATION_SOURCE');equal(await s.status('foreign'),null);m.close();
    });
    await test('a UI progress callback failure cannot undo a durable copy',async()=>{
      const f=await fixture(),m=coordinator(f.source,openStore(database()),{onProgress:()=>{throw Error('UI failed');}});
      equal((await m.stage('ui')).status,'verified-copy');m.close();
    });
    await test('closing while source read is in flight prevents later writes',async()=>{
      const f=await fixture(),s=openStore(database());let release;
      f.source.capture=()=>new Promise(resolve=>{release=()=>resolve(copy(f.snapshot));});
      const m=coordinator(f.source,s),p=m.stage('closed');m.close();release();await reject(()=>p,'MIGRATION_CLOSED');
    });
    await test('normal delta records and unsent queue remain untouched',async()=>{
      const f=await fixture(),name=database(),replica=root.SentlogDeltaIndexedDB.createStore({...scope,indexedDB,databaseName:name});
      const before={version:2,scope:copy(scope),cursor:4,records:{one:{memo:'keep'}},outbox:[{projectId:scope.projectId,deviceId:scope.deviceId,eventId:'keep'}]};
      await replica.read();await replica.write(before);
      const wrong=API.createStore({...scope,indexedDB,databaseName:name});await reject(()=>wrong.status('one'),'MIGRATION_STORE_SCHEMA');wrong.close();
      const m=coordinator(f.source,openStore(database()));await m.stage('isolated');equal(await replica.read(),before);m.close();replica.close();
    });
    await test('production legacy database names can never be migration destinations',async()=>{
      for(const databaseName of ['surveyFieldNoteDB','sentlog-original-photos-v1','sentlog-delta-v1'])
        await reject(()=>API.createStore({...scope,databaseName}),'MIGRATION_STORE_CONFIG');
    });
    await test('many photos are chunked without changing their order or content',async()=>{
      const f=await fixture(151),progress=[],m=coordinator(f.source,openStore(database()),{batchItems:17,batchBytes:64,onProgress:p=>progress.push(p.copied)});
      const done=await m.stage('many');equal(done.next,152);assert(progress.length>10,'copy not chunked');
      const saved=await m.readCopy('many');equal(saved.snapshot.files.map(f=>f.sha256),f.snapshot.files.map(f=>f.sha256));m.close();
    });
    async function legacyFixture(){
      const legacyName=database(),originalName=database(),local=new Map();
      const shared=new Blob(['shared-photo'],{type:'image/jpeg'}),original=new Blob(['original-image'],{type:'image/jpeg'});
      const photo={id:'p',name:'near.jpg',size:shared.size,sha256:await hash(shared)};
      const workspace=JSON.stringify({projects:[{id:localProjectId,name:'試験橋',drawings:[{id:'d'}]}]});
      const drawing=JSON.stringify({rotation:90,scale:0.01,shapes:[{id:'r',memo:'圏外で追加した所見',photos:[photo]}]});
      const recordRows=[['__sentlog_records_meta_v130__',{schema:1,revision:12}],
        ['__sentlog_record__:surveyFieldNoteWorkspaceV1',workspace],
        ['__sentlog_record__:surveyFieldNoteDrawingV1:d',drawing],
        ['__sentlog_record__:sentlogCloudProjectSyncV2:'+localProjectId,JSON.stringify({revision:2})],['photo:d:p',shared]];
      const originalMeta={key:'d:p',projectId:localProjectId,drawingId:'d',photoId:'p',size:original.size,type:'image/jpeg',
        photoAssociation:{status:'attached',target:{projectId:localProjectId,drawingId:'d',recordId:'r'}}};
      async function seed(name,stores,rows){
        const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(name,1);
          q.onupgradeneeded=()=>stores.forEach(s=>q.result.createObjectStore(s));q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
        try{await new Promise((resolve,reject)=>{const tx=db.transaction(stores,'readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
          for(const [store,key,value]of rows)tx.objectStore(store).put(value,key);});}finally{db.close();}
      }
      await seed(legacyName,['files'],recordRows.map(([key,value])=>['files',key,value]));
      await seed(originalName,['photos','meta'],[['photos','d:p',original],['meta','d:p',originalMeta]]);
      const source=root.SentlogDeltaLegacySource.createSource({indexedDB,localStorage:{getItem:k=>local.get(k)??null},
        databaseName:legacyName,originalDatabaseName:originalName});
      return {source,legacyName,originalName,local,shared,original,drawing};
    }
    await test('real legacy DB capture stages raw unsent metadata shared photo and original together',async()=>{
      const f=await legacyFixture(),before=await f.source.capture(localProjectId),m=coordinator(f.source,openStore(database()));
      const r=await m.stage('legacy-real');equal(r.status,'verified-copy');
      const saved=(await m.readCopy('legacy-real')).snapshot;
      equal(saved.rawEntries,before.rawEntries);equal(saved.originals,before.originals);equal(saved.files.length,2);
      equal(saved.files.map(x=>x.sha256),before.files.map(x=>x.sha256));
      equal((await f.source.capture(localProjectId)).fingerprint,before.fingerprint,'legacy stores were changed');m.close();f.source.close();
    });
    await test('a photo-only source update without a record revision is detected during staging',async()=>{
      const f=await legacyFixture(),recheck=f.source.recheck;
      f.source.recheck=async old=>{
        await raw(f.legacyName,'files',s=>s.put(new Blob(['other--photo'],{type:'image/jpeg'}),'photo:d:p'));
        return recheck(old);
      };
      const m=coordinator(f.source,openStore(database())),r=await m.stage('legacy-photo-race');
      equal(r.status,'needs-review');equal(r.sourceUnchanged,false);
      const saved=(await m.readCopy('legacy-photo-race')).snapshot;
      equal(await saved.files.find(f=>f.key==='photo:d:p').blob.text(),'shared-photo');
      equal(saved.source.recordRevision,12);m.close();f.source.close();
    });
    await test('a saved original awaiting association is preserved in a review copy',async()=>{
      const f=await legacyFixture();f.local.set('sentlogPhotoCaptureIntentV1',JSON.stringify({version:1,
        operations:{},entries:{p:{photoId:'p',storageDrawingId:'d',status:'pending',operationId:'capture-1',
          target:{projectId:localProjectId,drawingId:'d',recordId:'r'}}}}));
      const m=coordinator(f.source,openStore(database())),r=await m.stage('legacy-camera');equal(r.status,'needs-review');
      const saved=(await m.readCopy('legacy-camera')).snapshot;equal(saved.captureIntentRaw,f.local.get('sentlogPhotoCaptureIntentV1'));
      assert(saved.files.some(f=>f.kind==='original-photo'));m.close();f.source.close();
    });
    await test('missing shared bytes keep the original and exact record in the review copy',async()=>{
      const f=await legacyFixture();await raw(f.legacyName,'files',s=>s.delete('photo:d:p'));
      const m=coordinator(f.source,openStore(database())),r=await m.stage('legacy-missing');equal(r.status,'needs-review');
      const saved=(await m.readCopy('legacy-missing')).snapshot;
      equal(saved.rawEntries.find(r=>r.key==='surveyFieldNoteDrawingV1:d').value,f.drawing);
      assert(saved.files.some(f=>f.kind==='original-photo'));assert(saved.manifest.some(f=>f.status==='recovery-required'));m.close();f.source.close();
    });
    await test('optional undefined and negative zero metadata survive a full readback and source recheck',async()=>{
      const f=await legacyFixture();
      await raw(f.legacyName,'files',s=>s.put({schema:1,revision:12,optional:undefined,negativeZero:-0,
        nested:[undefined,-0,null]},'__sentlog_records_meta_v130__'));
      const m=coordinator(f.source,openStore(database()));equal((await m.stage('legacy-values')).status,'verified-copy');
      const saved=(await m.readCopy('legacy-values')).snapshot;
      assert(Object.prototype.hasOwnProperty.call(saved.source.recordMeta,'optional'),'undefined field was lost');
      assert(Object.is(saved.source.recordMeta.negativeZero,-0),'negative zero changed');
      equal((await f.source.recheck(saved)).unchanged,true,'lossy copy cannot be verified against the source');m.close();f.source.close();
    });
    return results;
  }
  if(typeof module==='object'&&module.exports)module.exports=run;else root.runDeltaMigrationCases=run;
})(typeof window!=='undefined'?window:globalThis);

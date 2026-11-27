(function(){
  'use strict';
  const DB='surveyFieldNoteDB',FILES='files',CONTROL='sentlog_delta_control_v1',JOURNAL='sentlog_delta_journal_v1';
  const STORES=[FILES,CONTROL,JOURNAL],PREFIX='__sentlog_record__:',MARKER='sentlogRecordsReadyV130';
  const REPORT='sentlogSyntheticSequenceReportV1',CACHE='sentlog-synthetic-sequence-static-v1';
  const $=id=>document.getElementById(id),M=SentlogSequenceModel,encoder=new TextEncoder(),pageLoadNonce=crypto.randomUUID();
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  const errorInfo=e=>({name:e?.name||'Error',code:e?.code||null,message:String(e?.message||e),errorName:e?.errorName||null});
  let report,manifest,profile,busy=false,phase='idle',serial=0,trace=[],events=[],model=null;
  const txRows=new WeakMap(),seenDB=new WeakSet();
  try{report=JSON.parse(localStorage.getItem(REPORT)||'null');}catch{}
  if(!report)report={format:'sentlog-real-shape-sequence-v1',status:'idle',scope:'Synthetic production-storage sequence; no authentication or full cloud scheduler',physicalDeviceTested:false,quotaOverride:false,snapshots:[],events:[],transactions:[]};
  function render(persist=true){
    report.events=[...events];report.transactions=[...trace];window.__sequenceReport=report;
    $('status').textContent='状態: '+report.status+' / '+(report.phase||phase)+(report.firstFailure?'\n最初の失敗: '+report.firstFailure.phase+' / '+report.firstFailure.error.name+' / '+report.firstFailure.error.message:'');
    $('report').textContent=JSON.stringify(report,null,2);
    $('report').dataset.status=report.status;$('report').dataset.busy=String(busy);
    $('start').disabled=busy||report.status!=='idle';$('variant').disabled=busy||report.status!=='idle';$('baseline').disabled=busy||report.status!=='idle';
    $('verify').disabled=busy||!report.proof||!!report.firstFailure||report.proof.pageLoadNonce===pageLoadNonce;$('observe').disabled=busy;
    if(persist&&report.status!=='idle')try{localStorage.setItem(REPORT,JSON.stringify(report));}catch(e){report.reportPersistenceError=errorInfo(e);}
  }
  events=report.events||[];trace=report.transactions||[];serial=Math.max(0,...trace.map(t=>t.ordinal||0));
  function event(kind,details={}){if(events.length<100)events.push({kind,at:new Date().toISOString(),phase,...details});render();}
  function setPhase(value){phase=value;report.phase=value;render();}
  function category(key){key=String(key);if(key===PREFIX+M.keys.WS)return 'workspace';if(key.startsWith(PREFIX+M.keys.DRAW))return 'drawing';if(key.startsWith(PREFIX+M.keys.SYNC))return 'sync';if(key===MARKER)return 'marker';if(key.startsWith('__sentlog_records_meta'))return 'meta';if(key.startsWith('__sentlog_records_archive'))return 'archive';return 'other';}
  // Instrumentation returns the same native objects and does not replace any
  // error/complete handler. Requests, durability and production code are intact.
  const originalTransaction=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(...args){
    const tx=Reflect.apply(originalTransaction,this,args);
    if(this.name===DB&&tx.mode==='readwrite'){
      const row={ordinal:++serial,phase,at:new Date().toISOString(),stores:[...tx.objectStoreNames],durability:tx.durability||null,requests:[],requestCount:0,succeeded:0,requestErrors:0,status:'pending'};
      txRows.set(tx,row);if(trace.length<400)trace.push(row);else report.transactionTraceTruncated=true;
      tx.addEventListener('complete',()=>{row.status='committed';row.finishedAt=new Date().toISOString();});
      tx.addEventListener('abort',()=>{row.status='aborted';row.error=errorInfo(tx.error||Error('Transaction aborted'));row.finishedAt=new Date().toISOString();event('transaction-abort',{ordinal:row.ordinal,error:row.error});});
    }
    return tx;
  };
  for(const method of ['put','add','delete']){
    const native=IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method]=function(...args){
      const request=Reflect.apply(native,this,args),row=txRows.get(this.transaction);
      if(row){
        const value=method==='delete'?null:args[0],key=method==='delete'?args[0]:args[1];
        const item={operation:method,store:this.name,category:category(key),status:'pending'};
        if(typeof value==='string')Object.assign(item,M.metrics(value));
        else if(value instanceof Blob)Object.assign(item,{blobBytes:value.size,nativeFile:value instanceof File});
        else if(value?.kind){item.kind=String(value.kind);if(value.value instanceof Blob)item.blobReferenceBytes=value.value.size;}
        row.requestCount++;if(row.requests.length<300)row.requests.push(item);else row.requestTraceTruncated=true;
        request.addEventListener('success',()=>{row.succeeded++;item.status='succeeded';});
        request.addEventListener('error',()=>{row.requestErrors++;item.status='error';item.error=errorInfo(request.error);});
      }
      return request;
    };
  }
  const nativeOpen=IDBFactory.prototype.open;
  IDBFactory.prototype.open=function(...args){
    const request=Reflect.apply(nativeOpen,this,args);
    request.addEventListener('success',()=>{
      const db=request.result;if(db.name!==DB||seenDB.has(db))return;seenDB.add(db);
      db.addEventListener('close',()=>event('unexpected-database-close'));
      db.addEventListener('versionchange',e=>event('database-versionchange',{oldVersion:e.oldVersion,newVersion:e.newVersion}));
    });return request;
  };
  addEventListener('error',e=>event('page-error',{error:{name:'Error',message:String(e.message)}}));
  addEventListener('unhandledrejection',e=>event('unhandled-rejection',{error:errorInfo(e.reason)}));
  async function estimate(){
    if(typeof navigator.storage?.estimate!=='function')return {status:'unsupported'};
    let timer;try{return {status:'available',...await Promise.race([navigator.storage.estimate(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('estimate timeout')),2000);})])};}
    catch(e){return {status:'error',error:errorInfo(e)};}finally{clearTimeout(timer);}
  }
  async function inventory(){
    const result={at:new Date().toISOString(),estimate:await estimate()};
    try{result.databases=await indexedDB.databases();}catch(e){result.databaseError=errorInfo(e);}
    try{result.cacheNames=await caches.keys();}catch(e){result.cacheError=errorInfo(e);}
    result.marker=localStorage.getItem(MARKER);return result;
  }
  async function readNative(){
    const listed=await indexedDB.databases();if(!listed.some(x=>x.name===DB))return {missing:true};
    const db=await new Promise((resolve,reject)=>{
      const q=indexedDB.open(DB);let upgrade=false;
      q.onupgradeneeded=()=>{upgrade=true;q.transaction.abort();};
      q.onerror=()=>reject(upgrade?Error('Database disappeared; recreation was aborted'):q.error);
      q.onblocked=()=>reject(Error('Readonly inspection was blocked'));
      q.onsuccess=()=>{if(upgrade){q.result.close();reject(Error('Unexpected database recreation'));}else resolve(q.result);};
    });
    try{
      assert(db.version===2&&JSON.stringify([...db.objectStoreNames].sort())===JSON.stringify([...STORES].sort()),'Native schema changed');
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORES,'readonly'),out={version:db.version,stores:{}};
        for(const name of STORES){const store=tx.objectStore(name),row={keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes:[...store.indexNames].map(k=>{const v=store.index(k);return {name:k,keyPath:v.keyPath,unique:v.unique,multiEntry:v.multiEntry};}),rows:[]};out.stores[name]=row;
          const q=store.openCursor();q.onsuccess=()=>{const c=q.result;if(c){row.rows.push([c.key,c.value]);c.continue();}};
        }
        tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error||Error('Readonly transaction aborted'));
      });
    }finally{db.close();}
  }
  async function blobInfo(key,value){return {key,size:value.size,type:value.type,name:typeof value.name==='string'?value.name:null,lastModified:Number.isFinite(value.lastModified)?value.lastModified:null,sha256:await M.digest(await value.arrayBuffer()),file:value instanceof File};}
  async function normalized(value){
    if(value instanceof Blob){const v=await blobInfo('',value);delete v.key;return {kind:'native-binary',...v};}
    if(typeof value==='string')return {kind:'string',...M.metrics(value),sha256:await M.hash(value)};
    if(Array.isArray(value)){const out=[];for(const x of value)out.push(await normalized(x));return out;}
    if(value&&typeof value==='object'){const out={};for(const k of Object.keys(value).sort())out[k]=await normalized(value[k]);return out;}
    return value===undefined?{kind:'undefined'}:value;
  }
  const sorted=rows=>[...rows].sort((a,b)=>String(a.key??a[0]).localeCompare(String(b.key??b[0]),'en'));
  async function inspectNative(label,expected,expectStaged=false){
    const native=await readNative();assert(!native.missing,'Native database is missing');
    const records=native.stores[FILES].rows.filter(([k])=>String(k).startsWith(PREFIX)).map(([k,v])=>[k.slice(PREFIX.length),v]);
    if(expected){assert(records.length===expected.size,'Managed record count changed');for(const [k,v]of records)assert(expected.get(k)===v,'A native managed record differs from the synthetic expected value');}
    const blobs=[];for(const [k,v]of native.stores[FILES].rows)if(v instanceof Blob)blobs.push(await blobInfo(k,v));
    const controls=native.stores[CONTROL].rows,cutoffs=[];
    for(const [,v]of controls)if(v?.kind==='cutoff-file')cutoffs.push(await blobInfo(v.key,v.value));
    if(model&&expected){assert(JSON.stringify(sorted(blobs))===JSON.stringify(sorted(model.manifest)),'A live File/Blob or its metadata changed');
      if(expectStaged){const keys=new Set(profile.files.filter(f=>f.project===profile.staging.projectOrdinal).map(f=>model.manifest[f.ordinal-1].key));
        assert(cutoffs.length===7&&JSON.stringify(sorted(cutoffs))===JSON.stringify(sorted(model.manifest.filter(f=>keys.has(f.key)))),'A protected cutoff file differs');}
    }
    if(expected){
      assert(native.stores[FILES].rows.length===expected.size+37,'Unexpected record, file, META or ARCHIVE row count');
      assert(native.stores[JOURNAL].rows.length===0,'Unexpected journal rows for a different unbound project');
      assert(controls.filter(([k,v])=>k==='startup-backup-recovery:v1'&&v?.kind==='startup-backup-recovery').length===1,'Restore intent was lost');
      const expectedControls=label==='restored'?1:label==='before-nine'?9+(report.baselinePrefill?1:0):10;
      assert(controls.length===expectedControls,'Unexpected control row count');
      const bindings=controls.filter(([,v])=>v?.kind==='binding');
      assert(expectStaged?bindings.length===1&&bindings[0][1].phase==='staging'&&bindings[0][1].localProjectId==='synthetic-project-'+profile.staging.projectOrdinal:bindings.length===0,'Staging binding changed');
    }
    const stores={};for(const name of STORES){const n=await normalized(native.stores[name]);stores[name]={rows:n.rows.length,sha256:await M.hash(n)};}
    return {label,at:new Date().toISOString(),managedRecords:records.length,managedUTF8:records.reduce((n,[,v])=>n+encoder.encode(v).length,0),recordsSHA256:await M.hash(sorted(records)),liveFiles:sorted(blobs),cutoffFiles:sorted(cutoffs),stores,storage:await inventory()};
  }
  async function inspectCache(){
    const names=await caches.keys(),rows=[];
    for(const asset of manifest.assets){const url=new URL(asset.url,location.href).href,response=await caches.match(url,{cacheName:CACHE});
      const row={url:asset.url,present:!!response,status:response?.status??null};
      if(response){const b=await response.arrayBuffer();row.bytes=b.byteLength;row.sha256=await M.digest(b);}
      rows.push(row);
    }
    const valid=names.includes(CACHE)&&rows.every((r,i)=>r.present&&r.status===200&&r.bytes===manifest.assets[i].bytes&&r.sha256===manifest.assets[i].sha256);
    return {cachePresent:names.includes(CACHE),entries:rows.length,bytes:rows.reduce((n,r)=>n+(r.bytes||0),0),valid,sha256:await M.hash(rows),rows};
  }
  function writerState(){const s=SentlogRecords;return {ready:s.ready,pending:s.pending,failed:s.failed,recordFailureDetails:s.recordFailureDetails,issues:s.issues};}
  async function observe(label='readonly-observation'){
    const out={label,at:new Date().toISOString(),storage:await inventory(),writer:writerState()};
    if(out.storage.databases?.some(x=>x.name===DB))try{out.native=await inspectNative(label,null,false);}catch(e){out.nativeError=errorInfo(e);}
    if(manifest)try{out.cache=await inspectCache();}catch(e){out.cacheError=errorInfo(e);}
    if(!report.observations)report.observations=[];if(report.observations.length<16)report.observations.push(out);render();return out;
  }
  async function seedSchema(){
    const listed=await indexedDB.databases();assert(!listed.some(x=>x.name===DB),'Fixture target DB already exists; no overwrite is allowed');
    assert(localStorage.getItem(MARKER)===null,'An existing migration marker prevents a new fixture run');
    localStorage.setItem(MARKER,'1');
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(DB,2);
      q.onupgradeneeded=()=>{q.result.createObjectStore(FILES);for(const n of [CONTROL,JOURNAL])q.result.createObjectStore(n).createIndex('kind','kind');};
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('Fixture schema creation was blocked'));
    });db.close();
  }
  async function restore(){
    let backup=new Blob([JSON.stringify(model.pack)],{type:'application/json'});
    report.syntheticBackup={bytes:backup.size,sha256:await M.digest(await backup.arrayBuffer())};
    let recovery=SentlogStartupBackupRecovery.create({onProgress:p=>{report.recoveryProgress=p;render();}}),plan=await recovery.prepare(backup);
    assert(plan.summary.projects===6&&plan.summary.drawings===217&&plan.summary.records===1558&&plan.summary.includedFiles===35&&plan.summary.includedBytes===31441939&&plan.summary.missingFiles===0,'Production recovery plan changed');
    assert((await recovery.inspect(plan)).mode==='empty','Production recovery target was not empty');
    report.recovery=await recovery.restore(plan,{confirmedOtherTabsClosed:true});assert(report.recovery.verified&&!report.recovery.resumed,'Production recovery did not verify a new restore');
    model.pack=null;backup=null;plan=null;recovery=null;
    await SentlogRecords.init();SentlogRecords.assertSafe();
    report.snapshots.push(await inspectNative('restored',model.initial,false));
  }
  async function seedCache(){
    assert(!(await caches.keys()).includes(CACHE),'Fixture cache already exists');
    const cache=await caches.open(CACHE);report.staticCache={kind:'Production same-origin static FILES, fetched HTTP Responses; external PDF CDN assets excluded',putCount:0,bytes:0};
    for(const asset of manifest.assets){const url=new URL(asset.url,location.href),response=await fetch(url,{cache:'no-store'});assert(response.status===200,'Static production asset fetch failed');
      const raw=await response.clone().arrayBuffer();assert(raw.byteLength===asset.bytes&&await M.digest(raw)===asset.sha256,'Static production source hash changed');
      await cache.put(url.href,response);report.staticCache.putCount++;report.staticCache.bytes+=raw.byteLength;
    }
    report.staticCache.readback=await inspectCache();assert(report.staticCache.readback.valid,'Static cache readback differs');
  }
  async function start(){
    if(busy||report.status!=='idle')return;busy=true;
    report={...report,status:'running',startedAt:new Date().toISOString(),variant:$('variant').value,baselinePrefill:$('baseline').checked,fullCloudScheduler:false,syntheticContent:true,originalIdentifiersIncluded:false,events:[],transactions:[],snapshots:[],userAgent:navigator.userAgent};trace=[];events=[];
    try{
      setPhase('preflight');report.before=await inventory();
      assert(Array.isArray(report.before.databases),'Database inventory is unavailable');
      assert(report.before.databases.length===0,'Production startup recovery refuses an origin with another database; existing data was left untouched');
      assert(!report.before.cacheNames?.includes(CACHE),'An earlier fixture cache is present');
      report.sourceManifest=manifest;setPhase('generate-synthetic-backup');model=await M.build(profile,report.variant);report.model=model.summary;
      model.final=null;if(!report.baselinePrefill)model.baselineWrites=null;
      setPhase('seed-empty-schema');await seedSchema();setPhase('production-restore');await restore();
      setPhase('production-static-cache');await seedCache();
      const expected=new Map(model.initial);
      if(report.baselinePrefill){setPhase('optional-baseline-prefill');for(const row of model.baselineWrites){SentlogRecords.batch([row],{origin:'remote',operation:'synthetic-baseline-prefill'});await SentlogRecords.settled();SentlogRecords.assertSafe();expected.set(...row);}}
      setPhase('production-staging');const p=profile.staging.projectOrdinal;
      const cutoff=await SentlogRecords.deltaJournal.begin({scope:{ownerId:'synthetic-owner',projectId:'synthetic-cloud-'+p,deviceId:'synthetic-device'},localProjectId:'synthetic-project-'+p,actor:{deviceId:'synthetic-device',deviceName:'Synthetic sequence'},serverRevision:1});
      assert(cutoff.files.length===7,'Expected seven protected staging files');await SentlogRecords.settled();SentlogRecords.assertSafe();
      report.snapshots.push(await inspectNative('before-nine',expected,true));
      setPhase('receive-nine');report.receiveStartedAt=new Date().toISOString();SentlogRecords.batch([...model.incoming],{origin:'remote',operation:'synthetic-legacy-receive'});
      await SentlogRecords.settled();SentlogRecords.assertSafe();assert(!SentlogRecords.pending,'Writer did not settle');
      const receiveTransactions=trace.filter(t=>t.phase==='receive-nine'),receive=receiveTransactions[0];
      report.receiveTransactions=receiveTransactions;
      assert(receiveTransactions.length===1&&receive.status==='committed'&&receive.requestCount===11&&receive.succeeded===11&&receive.requestErrors===0,'The nine-value receive did not commit one transaction with eleven successful write requests');
      const managedRequests=receive.requests.filter(r=>['workspace','drawing','sync'].includes(r.category));
      assert(managedRequests.length===9&&managedRequests.reduce((n,r)=>n+r.utf8,0)===4098583&&receive.requests.every(r=>r.operation==='put'&&!r.blobBytes&&!r.blobReferenceBytes&&r.store!==JOURNAL),'Unexpected managed bytes, Blob rewrite, delete, or journal write during the unbound receive');
      for(const row of model.incoming)expected.set(...row);
      setPhase('verify-nine');const after=await inspectNative('after-nine',expected,true),cache=await inspectCache();assert(cache.valid,'Static cache changed after record receive');
      report.snapshots.push(after);report.afterCache=cache;report.proof={pageLoadNonce,stores:after.stores,recordsSHA256:after.recordsSHA256,liveFiles:after.liveFiles,cutoffFiles:after.cutoffFiles,cacheSHA256:cache.sha256};
      report.writer=writerState();report.status='received';report.finishedAt=new Date().toISOString();setPhase('awaiting-reload-verification');
    }catch(e){
      report.status='failed';if(!report.firstFailure)report.firstFailure={phase,at:new Date().toISOString(),error:errorInfo(e)};report.writer=writerState();render();
      try{await observe('first-failure-readonly');}catch(observerError){report.observerError=errorInfo(observerError);}
    }finally{busy=false;render();}
  }
  async function verify(){
    if(busy||!report.proof||report.firstFailure||report.proof.pageLoadNonce===pageLoadNonce)return;busy=true;
    try{
      setPhase('reload-readonly-verification');const after=await inspectNative('reloaded',null,true),cache=await inspectCache(),proof=report.proof;
      assert(JSON.stringify(after.stores)===JSON.stringify(proof.stores),'A native store changed across reload/restart');
      assert(after.recordsSHA256===proof.recordsSHA256&&JSON.stringify(after.liveFiles)===JSON.stringify(proof.liveFiles)&&JSON.stringify(after.cutoffFiles)===JSON.stringify(proof.cutoffFiles),'Records or File/Blob values changed across reload/restart');
      assert(cache.valid&&cache.sha256===proof.cacheSHA256,'Static cache changed across reload/restart');
      report.reloaded=after;report.reloadedCache=cache;report.status='verified';report.verificationPageLoadNonce=pageLoadNonce;report.verificationMethod='Readonly reopen on a distinct page load; browser process restart requires external driver evidence';setPhase('complete');
    }catch(e){report.status='failed';if(!report.firstFailure)report.firstFailure={phase,at:new Date().toISOString(),error:errorInfo(e)};try{await observe('verification-failure-readonly');}catch(observerError){report.observerError=errorInfo(observerError);}}
    finally{busy=false;render();}
  }
  $('start').addEventListener('click',start);$('observe').addEventListener('click',async()=>{busy=true;try{await observe();}catch(e){event('observation-error',{error:errorInfo(e)});}finally{busy=false;render();}});
  $('reload').addEventListener('click',()=>location.reload());$('verify').addEventListener('click',verify);
  $('download').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='synthetic-restore-sequence-'+(report.variant||'unstarted')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  Promise.all([fetch('profile.json',{cache:'no-store'}).then(r=>{assert(r.ok,'Missing synthetic profile');return r.json();}),fetch('source-manifest.json',{cache:'no-store'}).then(r=>{assert(r.ok,'Missing built source manifest');return r.json();})]).then(([p,m])=>{profile=p;manifest=m;report.loadedSourceManifest=m;window.__sequenceReady=true;$('report').dataset.ready='true';render(false);}).catch(e=>{report.status='failed';report.firstFailure={phase:'fixture-load',at:new Date().toISOString(),error:errorInfo(e)};render();});
  render(false);
})();

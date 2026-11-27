'use strict';
// Production-built PDF receiver and record writer, disposable FakeIndexedDB,
// synthetic transport and virtual PDF timers. No browser or customer data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {File}=require('node:buffer'),{webcrypto,createHash}=require('node:crypto');
const {IDBObjectStore}=require('fake-indexeddb');
const root=path.resolve(process.env.SENTLOG_BUILT_ROOT||path.join(__dirname,'..'));
const {openApplication,digest,WORKSPACE,DRAWING}=require(path.join(root,'tests/helpers/delta_recovery_fixture.cjs'));
const source=fs.readFileSync(path.join(root,'sentlog/pdf-recovery.js'),'utf8');
assert(source.includes('function legacyPdfValidate(')&&source.includes("operation:'legacy-pdf-receive'"),
  'Run this test against the assembled production PDF receiver');
const META='__sentlog_records_meta_v130__',OWNER='synthetic-owner',DEVICE='synthetic-device';
let activeMetrics=null;
const sha=value=>createHash('sha256').update(value).digest('hex');
const delay=fn=>setImmediate(fn);
async function within(task,ms=10000){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(Error('Synthetic fixture deadline exceeded')),ms);
})]);}finally{clearTimeout(timer);}}
async function fingerprint(value){
  if(value instanceof Blob)return {blobBytes:value.size,mime:value.type,sha256:await digest(value)};
  if(value instanceof Map)return Promise.all([...value].sort(([a],[b])=>String(a).localeCompare(String(b))).map(async([k,v])=>[k,await fingerprint(v)]));
  if(Array.isArray(value))return Promise.all(value.map(fingerprint));
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.keys(value).sort().map(async k=>[k,await fingerprint(value[k])])));
  return value;
}
async function fixture({count=1,existing=false,pc=false,deleted=false}={}){
  const projects=[],drawings=[],assets=[],blobs=new Map();
  for(let n=0;n<count;n++){
    const id='drawing-'+String(n).padStart(2,'0'),meta={id,name:'Synthetic drawing',fileName:'synthetic.pdf',sourceType:'pdf',pageCount:1};
    const state={sourceType:'pdf',fileName:'synthetic.pdf',pageCount:1,shapes:[{id:'record-'+n,type:'memo',memo:'Saved synthetic memo',photos:[]}],collabDeletedRecords:[]};
    projects.push({id:'local-'+n,name:'Synthetic project',drawings:[meta]});drawings.push({meta,state});
    const blob=new Blob(['%PDF-1.4 synthetic bytes '+n],{type:'application/pdf'});blobs.set(id,blob);
    assets.push({id:'asset-'+String(n).padStart(2,'0'),project_id:'cloud-'+n,status:deleted?'storage_deleted':'uploaded',file_name:'synthetic.pdf',mime_type:'application/pdf',byte_size:blob.size,sha256:await digest(blob),storage_path:OWNER+'/cloud-'+n+'/'+id,metadata:{drawing_id:id}});
  }
  const local=new Map([[WORKSPACE,JSON.stringify({projects})],...drawings.map(d=>[DRAWING+d.meta.id,JSON.stringify(d.state)])]);
  const app=await openApplication({local});
  await app.records.writeFile('photo:preserved:synthetic',new Blob(['Preserved unrelated synthetic media'],{type:'image/jpeg'}));
  if(existing)for(const a of assets)await app.records.writeFile('background:'+a.metadata.drawing_id,blobs.get(a.metadata.drawing_id));
  let owner=OWNER,device=DEVICE,clock=Date.parse('2026-01-02T03:04:05Z'),timerSequence=0,draftNumber=0;
  const timeoutHandles=new Map(),intervals=[],startup=[],retryDelays=[],hooks={};
  const calls={requests:[],downloads:[],uploads:[],acks:[],writes:[],writeErrors:[],attaches:[],forgets:[],warnings:[],faults:0,pcReads:0};
  const originalWrite=app.records.writeFile;
  app.records.writeFile=async(key,value,options)=>{
    calls.writes.push(key);if(hooks.beforeWrite)await hooks.beforeWrite(key,value,options);
    try{return await originalWrite(key,value,options);}catch(error){calls.writeErrors.push(error);throw error;}
  };
  class ClockDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const environment={window:null,location:{pathname:pc?'/sentlog-pc/':'/sentlog/'},Blob,File,AbortController,Uint8Array,TextEncoder,ArrayBuffer,URL,Response,Date:ClockDate,
    indexedDB:app.factory,crypto:webcrypto,navigator:{onLine:true},
    document:{hidden:false,querySelector:()=>null,getElementById:()=>null,addEventListener(){}},
    console:{log(){},warn:(...args)=>calls.warnings.push(args),error:(...args)=>calls.warnings.push(args)},
    localStorage:{getItem:key=>key==='sentlogCloudSessionV1'?JSON.stringify({user:{id:owner},access_token:'synthetic-token'}):['sentlogCloudDeviceV1','sentlogPcWebDeviceV1'].includes(key)?device:null},
    setTimeout(fn,ms,...args){
      const id=++timerSequence;timeoutHandles.set(id,{fn,ms});
      if(ms===2500&&fn.name==='run'){startup.push({fn,ms});return id;}
      // Advance only the production targeted-recovery sleep, leaving network
      // abort and receipt timers registered until their normal clearTimeout.
      if(ms===2500){retryDelays.push(ms);queueMicrotask(()=>{if(timeoutHandles.delete(id)){clock+=ms;fn(...args);}});}
      return id;
    },
    clearTimeout:id=>timeoutHandles.delete(id),
    setInterval(fn,ms){intervals.push({fn,ms});return ++timerSequence;},
    SentlogRecords:app.records,SentlogArchive:{ready:true,isAuto:()=>true},sentlogAppReady:Promise.resolve(),
    sentlogRestoreDrawingView:async id=>{calls.attaches.push(id);},
    SentlogSyncTraffic:{ack:async(kind,a,id,send)=>{
      if(hooks.beforeAck)await hooks.beforeAck(a);
      return send({p_asset_id:a.id,p_device_id:id,p_sha256:a.sha256,p_byte_size:a.byte_size});
    },forget:async(kind,a)=>{calls.forgets.push(a.id);}},
    fetch:async(url,options={})=>{
      const parsed=new URL(url),p=parsed.pathname;calls.requests.push({path:p,method:options.method||'GET'});
      if(p.includes('/storage/')){
        if(options.method==='POST'){calls.uploads.push({bytes:options.body.size,sha256:await digest(options.body)});return new Response('{}');}
        const id=p.split('/').at(-1);assert(blobs.has(id),'Unexpected synthetic PDF');calls.downloads.push(id);
        if(hooks.onDownload)await hooks.onDownload(id);return new Response(blobs.get(id));
      }
      if(p.endsWith('/sentlog_assets')){if(hooks.onInventory)await hooks.onInventory();return new Response(JSON.stringify(assets));}
      if(p.endsWith('/sentlog_devices')){
        const devices=parsed.searchParams.has('id')?[{id:device,active:true}]:[{id:'synthetic-peer',last_seen_at:new ClockDate().toISOString()}];
        return new Response(JSON.stringify(devices));
      }
      if(p.endsWith('/sentlog_pdf_requests'))return new Response(JSON.stringify(pc?[{asset_id:assets[0].id,device_id:'synthetic-peer',expected_sha256:assets[0].sha256,requested_at:new ClockDate().toISOString()}]:[]));
      if(p.endsWith('/rpc/sentlog_ack_pdf')){calls.acks.push(JSON.parse(options.body));return new Response('{"received":true}');}
      if(p.endsWith('/rpc/sentlog_request_pdf'))return new Response('{}');
      if(p.endsWith('/rpc/sentlog_archive_v1'))return new Response(JSON.stringify([{id:assets[0].project_id,status:'active',checking:false}]));
      if(p.endsWith('/sentlog_pc_receipts'))return new Response(JSON.stringify([{pc_path:'SyntheticArchive/synthetic.pdf',sha256:assets[0].sha256,byte_size:assets[0].byte_size}]));
      if(p.endsWith('/rpc/sentlog_claim_pdf_redelivery'))return new Response(JSON.stringify({claimed:true,storage_path:OWNER+'/synthetic-redelivery',token:'synthetic-claim-token'}));
      if(p.endsWith('/rpc/sentlog_finish_pdf_redelivery'))return new Response('{}');
      throw Error('Unexpected synthetic transport path');
    }};
  if(pc){
    // FakeIndexedDB cannot clone FileSystemDirectoryHandle methods. Model only
    // the readonly PC handle lookup; byte/hash/claim/upload remain real code.
    const archiveRoot={name:'SyntheticArchive',queryPermission:async()=> 'granted',getFileHandle:async name=>{
      assert.equal(name,'synthetic.pdf');calls.pcReads++;return {getFile:async()=>blobs.get(assets[0].metadata.drawing_id)};
    }};
    environment.indexedDB={open(name,version){assert.equal(name,'sentlog-pc-sync');assert.equal(version,1);const request={};
      const database={close(){},transaction(store,mode){assert.equal(store,'kv');assert.equal(mode,'readonly');const tx={};
        tx.objectStore=()=>({get(key){assert.equal(key,'root');const q={};delay(()=>{q.result=archiveRoot;q.onsuccess?.();delay(()=>tx.oncomplete?.());});return q;}});return tx;}};
      delay(()=>{request.result=database;request.onsuccess?.();});return request;}};
    Object.defineProperty(environment,'SentlogRecords',{get(){throw Error('PC sender must not read the main Records namespace');}});
  }
  environment.window=environment;environment.addEventListener=()=>{};
  vm.createContext(environment);vm.runInContext(fs.readFileSync(path.join(root,'sentlog/blob-sha256.js'),'utf8'),environment);
  await vm.runInContext('(async()=>{'+source+'\nwindow.__pdfStatus=()=>signature;})()',environment);
  assert.equal(intervals.length,1);assert.equal(intervals[0].ms,30000);assert.equal(startup.length,1);assert.equal(startup[0].ms,2500);
  const durable=async()=>sha(JSON.stringify(await fingerprint({stores:await app.durable(),local:[...local]})));
  const draft=()=>{const key=DRAWING+drawings[0].meta.id,state=JSON.parse(app.records.getItem(key));state.shapes[0].memo='Unsaved synthetic memo '+(++draftNumber);const raw=JSON.stringify(state);app.records.setItem(key,raw);return {key,raw};};
  const failRecordCommit=async()=>{
    const put=IDBObjectStore.prototype.put;let fired=false;
    IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);
      if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===META){fired=true;calls.faults++;request.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));}
      return request;
    };
    let current;try{current=draft();await assert.rejects(app.records.flush(),error=>error.name==='QuotaExceededError');}
    finally{IDBObjectStore.prototype.put=put;}
    assert(fired);assert.equal(app.records.ready,true);assert.equal(app.records.failed,true);assert.equal(app.records.pending,true);
    assert.equal(app.records.recordFailureDetails.phase,'commit');assert.equal(app.records.getItem(current.key),current.raw);
    return current;
  };
  const noDelivery=()=>{assert.equal(calls.acks.length,0);assert.equal(calls.attaches.length,0);};
  const metrics=()=>({downloads:calls.downloads.length,writerCalls:calls.writes.length,acknowledgements:calls.acks.length,viewAttachments:calls.attaches.length,targetedRetryDelays:retryDelays.length,faults:calls.faults});
  activeMetrics=metrics;
  return {app,assets,blobs,calls,hooks,environment,intervals,retryDelays,durable,draft,failRecordCommit,noDelivery,metrics,
    tick:async()=>{clock+=30000;return intervals[0].fn();},targeted:()=>environment.sentlogRequestDrawingRecovery(drawings[0].meta.id),status:()=>environment.__pdfStatus(),
    setOwner:value=>{owner=value;},setDevice:value=>{device=value;},
    stage:()=>app.records.deltaJournal.begin({scope:{ownerId:OWNER,deviceId:DEVICE,projectId:assets[0].project_id},localProjectId:projects[0].id,actor:{deviceId:DEVICE,deviceName:'Synthetic'},serverRevision:1}),
    async awaitAck(){let stopped=false;try{await within(new Promise(resolve=>{const poll=()=>{if(stopped)return;if(calls.acks.length)resolve();else delay(poll);};poll();}),2000);}finally{stopped=true;}},
    async assertUnchanged(before){assert.equal(await durable(),before,'All three durable stores and localStorage must remain byte-equivalent');}
  };
}
const cases=[];const test=(name,run)=>cases.push({name,run});
test('known commit failure blocks every scheduled PDF cycle without clearing the unsaved draft',async()=>{
  const f=await fixture({count:12}),before=await f.durable(),draft=await f.failRecordCommit();
  for(let i=0;i<3;i++)await f.tick();
  assert.equal(f.calls.downloads.length,0);assert.equal(f.calls.writes.length,0);f.noDelivery();await f.assertUnchanged(before);
  assert.equal(f.app.records.getItem(draft.key),draft.raw);assert.equal(f.app.records.failed,true);assert.equal(f.app.records.pending,true);
  assert.match(f.status(),/保存エラー/);return f.metrics();
});
test('known commit failure ends targeted recovery without a PDF retry loop or a retained target slot',async()=>{
  const f=await fixture(),before=await f.durable();await f.failRecordCommit();
  assert.equal(await f.targeted(),false);assert.equal(await f.targeted(),false);
  assert.equal(f.calls.downloads.length,0);assert.equal(f.calls.writes.length,0);assert.equal(f.retryDelays.length,0);f.noDelivery();await f.assertUnchanged(before);return f.metrics();
});
test('a commit failure during inventory is observed before any PDF download',async()=>{
  const f=await fixture({count:12}),before=await f.durable();let fired=false;
  f.hooks.onInventory=async()=>{if(!fired){fired=true;await f.failRecordCommit();}};
  await f.tick();assert.equal(f.calls.downloads.length,0);assert.equal(f.calls.writes.length,0);f.noDelivery();await f.assertUnchanged(before);return f.metrics();
});
test('failure during the first download prevents its write and stops the remaining eight-file cycle',async()=>{
  const f=await fixture({count:12}),before=await f.durable();let fired=false;
  f.hooks.onDownload=async()=>{if(!fired){fired=true;await f.failRecordCommit();}};
  await f.tick();assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,0);f.noDelivery();await f.assertUnchanged(before);
  assert.equal(f.app.records.failed,true);assert.equal(f.app.records.pending,true);return f.metrics();
});
test('targeted in-flight failure writes nothing and releases the slot for successful retry',async()=>{
  const f=await fixture(),before=await f.durable();let fired=false;
  f.hooks.onDownload=async()=>{if(!fired){fired=true;await f.failRecordCommit();}};
  assert.equal(await f.targeted(),false);assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,0);assert.equal(f.retryDelays.length,0);f.noDelivery();await f.assertUnchanged(before);
  delete f.hooks.onDownload;await f.app.records.retry();assert.equal(f.app.records.failed,false);
  assert.equal(await f.targeted(),true);await f.awaitAck();assert.equal(f.calls.downloads.length,2);assert.equal(f.calls.writes.length,1);assert.equal(f.calls.attaches.length,1);
  assert.equal(await digest((await f.app.disk()).get('background:'+f.assets[0].metadata.drawing_id)),f.assets[0].sha256);return f.metrics();
});
test('normal record retry resumes the original thirty-second scheduler without another latch',async()=>{
  const f=await fixture(),timer=f.intervals[0].fn;const draft=await f.failRecordCommit();await f.tick();assert.equal(f.calls.downloads.length,0);
  await f.app.records.retry();assert.equal(f.app.records.failed,false);assert.equal(f.app.records.pending,false);assert.equal(f.intervals[0].fn,timer);assert.equal(f.intervals.length,1);
  await f.tick();assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,1);assert.equal(f.calls.acks.length,1);assert.equal(f.calls.attaches.length,1);
  assert.equal(f.app.records.getItem(draft.key),draft.raw);return f.metrics();
});
test('ordinary pending records do not block a healthy scheduled recovery',async()=>{
  const f=await fixture();f.draft();assert.equal(f.app.records.pending,true);assert.equal(f.app.records.failed,false);
  await f.tick();assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,1);assert.equal(f.calls.acks.length,1);assert.equal(f.app.records.failed,false);assert.equal(f.app.records.pending,false);return f.metrics();
});
test('a failed guarded PDF transaction does not latch record failure or prevent the next scheduled retry',async()=>{
  const f=await fixture(),before=await f.durable(),key='background:'+f.assets[0].metadata.drawing_id;
  const put=IDBObjectStore.prototype.put;let fired=false;
  IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);
    if(!fired&&this.name==='files'&&this.transaction.db.name==='surveyFieldNoteDB'&&args[1]===key){fired=true;request.addEventListener('success',()=>this.transaction._abort('QuotaExceededError'));}
    return request;
  };
  try{await f.tick();}finally{IDBObjectStore.prototype.put=put;}
  assert(fired);assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writeErrors.length,1);
  assert.equal(f.calls.writeErrors[0].name,'QuotaExceededError');assert.equal(f.app.records.failed,false);assert.equal(f.app.records.pending,false);
  f.noDelivery();await f.assertUnchanged(before);
  await f.tick();assert.equal(f.calls.downloads.length,2);assert.equal(f.calls.writes.length,2);
  assert.equal(f.calls.acks.length,1);assert.equal(f.calls.attaches.length,1);assert.equal(f.app.records.failed,false);
  assert.equal(await digest((await f.app.disk()).get(key)),f.assets[0].sha256);return f.metrics();
});
test('a matching local PDF is neither acknowledged nor attached while records have failed',async()=>{
  const f=await fixture({existing:true}),before=await f.durable();await f.failRecordCommit();await f.tick();assert.equal(await f.targeted(),false);
  assert.equal(f.calls.downloads.length,0);assert.equal(f.calls.writes.length,0);f.noDelivery();await f.assertUnchanged(before);return f.metrics();
});
test('the existing writeFile validation sees a newly reported prerequisite failure',async()=>{
  const f=await fixture(),before=await f.durable();assert.equal(typeof f.app.records.report,'function');
  f.hooks.beforeWrite=async()=>f.app.records.report('synthetic-prerequisite',Error('Synthetic storage prerequisite failure'));
  await f.tick();assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,1);
  assert.equal(f.calls.writeErrors[0]?.code,'PDF_RECOVERY_STORAGE_FAILED');f.noDelivery();await f.assertUnchanged(before);return f.metrics();
});
test('a commit failure in the ACK queue stops the actual receipt and view attachment',async()=>{
  const f=await fixture();let committedFileState,draft;
  f.hooks.beforeAck=async()=>{committedFileState=await f.durable();draft=await f.failRecordCommit();};
  await f.tick();assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,1);f.noDelivery();
  assert.equal(f.app.records.failed,true);assert.equal(f.app.records.getItem(draft.key),draft.raw);await f.assertUnchanged(committedFileState);
  assert.equal(await digest((await f.app.disk()).get('background:'+f.assets[0].metadata.drawing_id)),f.assets[0].sha256);return f.metrics();
});
test('owner and device changes still prevent in-flight targeted persistence',async()=>{
  for(const actor of ['owner','device']){const f=await fixture(),before=await f.durable();f.hooks.onDownload=async()=>actor==='owner'?f.setOwner('synthetic-other-owner'):f.setDevice('synthetic-other-device');
    assert.equal(await f.targeted(),false);assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.writes.length,0);f.noDelivery();await f.assertUnchanged(before);}
  return {actorVariants:2};
});
test('the staging handover guard still blocks both scheduled and targeted recovery',async()=>{
  const f=await fixture();await f.stage();const before=await f.durable();await f.tick();assert.equal(await f.targeted(),false);
  assert.equal(f.calls.downloads.length,0);assert.equal(f.calls.writes.length,0);f.noDelivery();await f.assertUnchanged(before);return f.metrics();
});
test('PC archive redelivery still verifies and uploads bytes without the main Records namespace',async()=>{
  const f=await fixture({pc:true,deleted:true});await f.tick();assert.equal(f.calls.pcReads,1);assert.equal(f.calls.uploads.length,1);
  assert.deepEqual(f.calls.uploads[0],{bytes:f.assets[0].byte_size,sha256:f.assets[0].sha256});
  assert.equal(f.calls.requests.filter(x=>x.path.endsWith('/rpc/sentlog_claim_pdf_redelivery')).length,1);
  assert.equal(f.calls.requests.filter(x=>x.path.endsWith('/rpc/sentlog_finish_pdf_redelivery')).length,1);assert.equal(f.calls.writes.length,0);
  return {pcReads:1,verifiedUploads:1,mainRecordWriterCalls:0};
});
(async()=>{
 const results=[];
 for(const c of cases){activeMetrics=null;try{const measurements=await within(c.run());results.push({name:c.name,status:'passed',measurements});console.log('PASS '+c.name);}
  catch(error){results.push({name:c.name,status:'failed',measurements:activeMetrics?.(),error:{name:error?.name||'Error',message:String(error?.message||error).slice(0,500)}});console.error('FAIL '+c.name+': '+String(error?.message||error).slice(0,500));}}
 const failed=results.filter(r=>r.status==='failed').length,report={scope:'Synthetic Node VM and FakeIndexedDB; controlled PDF timers and PC filesystem handle, no native-browser claim',sourceRoot:root,sourceSHA256:sha(source),recordStoreSHA256:sha(fs.readFileSync(path.join(root,'sentlog/record-store.js'))),passed:results.length-failed,failed,cases:results};
 if(process.env.SENTLOG_PDF_FAILURE_REPORT)fs.writeFileSync(process.env.SENTLOG_PDF_FAILURE_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log('PDF save-failure gate: '+report.passed+' passed, '+failed+' failed');if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

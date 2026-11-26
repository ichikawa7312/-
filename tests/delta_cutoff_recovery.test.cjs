'use strict';
// Disposable IndexedDB. Reproduce a frozen missing-file cutoff using the real
// writer/installer, then recover without replacing any original records/bytes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const Source=require('../sentlog/delta-sync-legacy-source.js'),Installer=require('../sentlog/delta-sync-app-migration.js');
const I=require('../sentlog/delta-sync-indexeddb.js'),Migration=require('../sentlog/delta-sync-migration.js');
const Bridge=require('../sentlog/delta-sync-app-bridge.js'),Journal=require('../sentlog/delta-sync-app-journal.js'),Metadata=require('../sentlog/delta-sync-metadata.js');
const Recovery=require('../sentlog/delta-sync-migration-recovery.js');
const Assets=require('../sentlog/delta-sync-assets.js'),AssetRuntime=require('../sentlog/delta-sync-asset-runtime.js');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const scope={ownerId:'recovery-owner',projectId:'recovery-cloud',deviceId:'recovery-device'},localProjectId='recovery-local';
const actor={deviceId:scope.deviceId,deviceName:'Synthetic recovery'},copy=structuredClone,json=JSON.stringify;
const sha=async blob=>Buffer.from(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer())).toString('hex');
const hash=async text=>sha(new Blob([text]));
async function application(factory,local){
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,
    setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,
    structuredClone,crypto:webcrypto,SentlogDeltaSyncCore:D};context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8'),context);
  const records=context.SentlogRecords;await records.init();
  return {records,localStorage,context,async disk(name='files'){
    const db=await records.openFilesDatabase();try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction(name,'readonly'),s=tx.objectStore(name);let keys,values;
      s.getAllKeys().onsuccess=e=>keys=e.target.result;s.getAll().onsuccess=e=>values=e.target.result;
      tx.oncomplete=()=>resolve(new Map(keys.map((key,i)=>[key,values[i]])));tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
  }};
}
async function fixture(count=1,{legacyPhotoMetadata=false}={}){
  const files=new Map(),photos=[];
  for(let i=0;i<count;i++){const id='photo-'+i,blob=new Blob(['saved-photo-'+i],{type:'image/jpeg'}),digest=await sha(blob);
    photos.push({id,name:id+'.jpg',...(!legacyPhotoMetadata?{size:blob.size,sha256:digest}:{})});files.set('photo:drawing:'+id,{blob,size:blob.size,sha256:digest});}
  const meta={id:'drawing',name:'Drawing',sourceType:null,fileName:'',pageCount:1};
  const state={sourceType:null,fileName:'',pageCount:1,shapes:[C.upgrade({id:'record',kind:'point',memo:'Original note',photos})],collabDeletedRecords:[]};
  const snapshot={version:1,kind:'sentlog-app-project',localProjectId,project:{id:localProjectId,name:'Recovery',drawings:[meta]},drawings:[{meta:copy(meta),state}]};
  const factory=new IDBFactory(),local=new Map([[WS,json({projects:[snapshot.project]})],[DRAW+'drawing',json(state)]]);
  const app=await application(factory,local),begin=()=>app.records.deltaJournal.begin({scope,localProjectId,actor,serverRevision:9});
  const source=()=>Source.createSource({journal:app.records.deltaJournal,indexedDB:factory,localStorage:app.localStorage,crypto:webcrypto});
  const payload=key=>{const file=files.get(key),photoId=key.slice('photo:drawing:'.length);return {key,...file,
    proof:{assetId:'asset-'+photoId,projectId:scope.projectId,clientKey:key,kind:'photo',drawingId:'drawing',photoId,sha256:file.sha256,size:file.size}};};
  const restore=(cutoff,key,extra={})=>app.records.deltaJournal.restoreMissingCutoffFile({...payload(key),scope,localProjectId,
    bindingId:cutoff.bindingId,validate:()=>true,...extra});
  return {...app,factory,local,files,snapshot,begin,source,payload,restore,restart:()=>application(factory,local)};
}
async function drawingReviewFixture({markers,protectedBlob}={}){
  const f=await fixture(0),blob=new Blob(['reviewed-current-pdf'],{type:'application/pdf'}),digest=await sha(blob);
  const ws=JSON.parse(f.records.getItem(WS)),state=JSON.parse(f.records.getItem(DRAW+'drawing'));
  Object.assign(ws.projects[0].drawings[0],{sourceType:'pdf',fileName:'drawing.pdf'});
  Object.assign(state,{sourceType:'pdf',fileName:'drawing.pdf'});if(markers!==undefined)state.pageReplacements=markers;
  f.records.batch([[WS,json(ws)],[DRAW+'drawing',json(state)]]);await f.records.settled();
  if(protectedBlob!==undefined)await f.records.writeFile('background:drawing',protectedBlob);
  const cutoff=await f.begin(),proof={assetId:'current-drawing-asset',ownerId:scope.ownerId,projectId:scope.projectId,
    clientKey:'drawing:drawing',kind:'drawing',drawingId:'drawing',sha256:digest,size:blob.size,
    snapshotRevision:10,fileName:'drawing.pdf',sourceType:'pdf',
    source:{id:'drawing',fileName:'drawing.pdf',sourceType:'pdf',pageCount:1,pageReplacements:markers??{}}};
  const args={scope,localProjectId,bindingId:cutoff.bindingId,key:'background:drawing',blob,size:blob.size,sha256:digest,proof,validate:()=>true};
  return {...f,cutoff,blob,digest,args,prepare:extra=>f.records.deltaJournal.prepareMissingDrawingRecovery({...args,...extra})};
}
async function installerFixture(f,recoverMissingFiles,{currentScope=()=>scope,server=f.snapshot,acceptedEvents=[]}={}){
  const rows=[],metadata=[];
  for(const drawing of server.drawings)for(const record of drawing.state.shapes){
    const row={ordinal:rows.length+1,drawingId:drawing.meta.id,recordId:record.id,recordJson:json(record),sha256:await hash(json(record))};
    row.manifestEntryJson=json({ordinal:row.ordinal,drawingId:row.drawingId,recordId:row.recordId,sha256:row.sha256});rows.push(row);}
  const values=[['header','project',{project:copy(server.project)}],...server.drawings.map(d=>{const state=copy(d.state);delete state.shapes;delete state.collabDeletedRecords;return ['drawing',d.meta.id,{meta:d.meta,state}];})];
  for(const [kind,key,value]of values){const row={ordinal:metadata.length+1,kind,key,metadataJson:json(value),sha256:await hash(json(value))};
    row.manifestEntryJson=json({ordinal:row.ordinal,kind,key,sha256:row.sha256});metadata.push(row);}
  const receipt={schema:1,baselineId:'baseline',ownerId:scope.ownerId,projectId:scope.projectId,clientProjectId:localProjectId,drawingIds:['drawing'],
    snapshotRevision:9,cursor:0,recordCount:rows.length,importedCount:rows.length,metadataCount:metadata.length,
    snapshotSha256:await hash(json({project:server.project,drawings:server.drawings})),manifestSha256:await hash('['+rows.map(r=>r.manifestEntryJson).join(', ')+']'),
    metadataManifestSha256:await hash('['+metadata.map(r=>r.manifestEntryJson).join(', ')+']'),hashFormat:'postgres-jsonb-text-sha256-v1',
    state:acceptedEvents.length?'active':'verified',deltaEnabled:acceptedEvents.length>0,deviceMigrationVerified:false,assetDeliveryVerified:false};
  let baselineReads=0;
  const transport={getCapabilities:()=>({atomicGroups:true,sharedMetadata:true}),pushGroup:async()=>{},
    inspect:async()=>({...scope,enabled:receipt.deltaEnabled,baseline:copy(receipt),headSeq:acceptedEvents.length}),
    list:async(_,after,limit)=>acceptedEvents.slice(after,after+limit).map((event,index)=>({seq:after+index+1,event:copy(event)})),
    prepareBaseline:async revision=>{assert.equal(revision,9);baselineReads++;return copy(receipt);},
    activateBaseline:async()=>{receipt.state='active';receipt.deltaEnabled=true;return copy(receipt);},
    readBaselinePage:async(id,after,limit)=>({receipt:copy(receipt),records:rows.slice(after,after+limit),nextOrdinal:Math.min(after+limit,rows.length),hasMore:after+limit<rows.length}),
    readBaselineMetadataPage:async(id,after,limit)=>({receipt:copy(receipt),metadata:metadata.slice(after,after+limit),nextOrdinal:Math.min(after+limit,metadata.length),hasMore:after+limit<metadata.length})};
  const store=I.createStore({...scope,indexedDB:f.factory});
  const install=Installer.createInstaller({records:f.records,recoverMissingFiles,factories:{
    source:args=>Source.createSource({...args,indexedDB:f.factory,localStorage:f.localStorage,crypto:webcrypto}),
    migrationStore:s=>Migration.createStore({...s,indexedDB:f.factory})}});
  return {store,get baselineReads(){return baselineReads;},run:()=>install({scope,localProjectId,actor,transport,store,
    mode:{enabled:receipt.deltaEnabled,baseline:receipt.deltaEnabled?copy(receipt):null,snapshotRevision:9},revision:9,currentScope})};
}
let passed=0;async function test(name,run){await run();passed++;console.log('PASS',name);}
(async()=>{
  await test('missing frozen file remains blocked after ordinary receipt, then verified recovery unblocks the exact cutoff',async()=>{
    const f=await fixture(),cutoff=await f.begin(),key=[...f.files.keys()][0],source=f.source();
    assert.equal((await source.capture(localProjectId,{recordCutoff:cutoff})).readyForStaging,false);
    await f.records.writeFile(key,f.files.get(key).blob);
    assert.equal((await source.capture(localProjectId)).readyForStaging,true);
    assert.equal((await source.capture(localProjectId,{recordCutoff:await f.begin()})).readyForStaging,false);
    assert.deepEqual(copy(await f.restore(cutoff,key)),{restored:true,idempotent:false,liveWritten:false});
    const result=await source.capture(localProjectId,{recordCutoff:cutoff});assert.equal(result.readyForStaging,true);
    const after=await f.records.deltaJournal.readCutoff({scope,localProjectId});
    assert.equal(after.bindingId,cutoff.bindingId);assert.equal(after.cutoffSeq,cutoff.cutoffSeq);
    assert.deepEqual(after.rawEntries,cutoff.rawEntries);assert.deepEqual(after.snapshot,cutoff.snapshot);source.close();
  });
  await test('recovery commits protected bytes, absent live file and replay journal atomically and survives restart',async()=>{
    const f=await fixture(),cutoff=await f.begin(),key=[...f.files.keys()][0];
    assert.deepEqual(copy(await f.restore(cutoff,key)),{restored:true,idempotent:false,liveWritten:true});
    const rows=[...(await f.disk(LOG)).values()];assert.equal(rows.length,1);assert.equal(rows[0].mutationKind,'cutoff-file-recovery');
    assert.equal(rows[0].files[0].before,null);assert.equal(await sha(rows[0].files[0].after),f.files.get(key).sha256);
    const app=await f.restart(),next=await app.records.deltaJournal.readCutoff({scope,localProjectId});
    assert.deepEqual(copy(await app.records.deltaJournal.missingCutoffFiles({scope,localProjectId})),[]);
    assert.equal(await sha((await app.disk()).get(key)),f.files.get(key).sha256);
    assert.equal(next.cutoffSeq,cutoff.cutoffSeq);assert.deepEqual(next.rawEntries,cutoff.rawEntries);
    assert.deepEqual(copy(await f.restore(cutoff,key)),{restored:false,idempotent:true,liveWritten:false});assert.equal((await f.disk(LOG)).size,1);
  });
  await test('a later local edit and conflicting live photo remain untouched while their original missing reference is recovered',async()=>{
    const f=await fixture(),cutoff=await f.begin(),key=[...f.files.keys()][0],newBlob=new Blob(['newer-conflicting-photo'],{type:'image/jpeg'});
    await f.records.writeFile(key,newBlob);const state=JSON.parse(f.records.getItem(DRAW+'drawing'));state.shapes[0].memo='Unsent later note';
    f.records.setItem(DRAW+'drawing',json(state));await f.records.settled();const journalBefore=await f.disk(LOG),raw=f.records.getItem(DRAW+'drawing');
    assert.equal((await f.restore(cutoff,key)).liveWritten,false);assert.equal(await (await f.disk()).get(key).text(),await newBlob.text());
    assert.equal(f.records.getItem(DRAW+'drawing'),raw);assert.deepEqual(await f.disk(LOG),journalBefore);
    const source=f.source(),snapshot=await source.capture(localProjectId,{recordCutoff:cutoff});assert.equal(snapshot.readyForStaging,true);
    assert.equal(await sha(snapshot.files.find(file=>file.key===key).blob),f.files.get(key).sha256);source.close();
  });
  await test('foreign identities, undeclared keys, altered metadata and wrong byte hashes are rejected without writes',async()=>{
    for(const variant of ['owner','project','client-key','kind','drawing','photo','bytes','declared-size','key']){
      const f=await fixture(),cutoff=await f.begin(),key=[...f.files.keys()][0],payload=f.payload(key),extra={};
      if(variant==='owner')extra.scope={...scope,ownerId:'foreign'};
      if(variant==='key')extra.key='photo:drawing:unreferenced';
      if(variant==='bytes')extra.blob=new Blob(['wrong-photo-0'],{type:'image/jpeg'});
      if(variant==='declared-size'){const blob=new Blob(['different-size'],{type:'image/jpeg'}),digest=await sha(blob);Object.assign(extra,{blob,size:blob.size,sha256:digest,proof:{...payload.proof,sha256:digest,size:blob.size}});}
      if(['project','client-key','kind','drawing','photo'].includes(variant))extra.proof={...payload.proof,[{'project':'projectId','client-key':'clientKey',kind:'kind',drawing:'drawingId',photo:'photoId'}[variant]]:'foreign'};
      await assert.rejects(()=>f.restore(cutoff,key,extra),error=>/^JOURNAL_RECOVERY_/.test(error.code),variant);
      assert.equal((await f.disk()).has(key),false,variant);assert.equal((await f.disk(LOG)).size,0,variant);
      assert.equal((await f.records.deltaJournal.readCutoff({scope,localProjectId})).files.length,0,variant);
    }
  });
  await test('an existing empty protected Blob is never replaced and retains its blocking source issue',async()=>{
    const f=await fixture(),key=[...f.files.keys()][0];await f.records.writeFile(key,new Blob([]));const cutoff=await f.begin();
    assert.deepEqual(copy(await f.records.deltaJournal.missingCutoffFiles({scope,localProjectId})),[]);
    await assert.rejects(()=>f.restore(cutoff,key),error=>error.code==='JOURNAL_RECOVERY_EXISTS');
    const source=f.source(),snapshot=await source.capture(localProjectId,{recordCutoff:cutoff});assert.equal(snapshot.readyForStaging,false);
    assert(snapshot.issues.some(issue=>issue.code==='LEGACY_SOURCE_FILE_MISSING'));assert.equal((await f.disk()).get(key).size,0);source.close();
  });
  await test('background recovery enforces exact replacement hash or the original frozen server source version',async()=>{
    for(const replaced of [false,true]){
      const f=await fixture(),blob=new Blob(['synthetic-pdf'],{type:'application/pdf'}),digest=await sha(blob);
      const ws=JSON.parse(f.records.getItem(WS)),state=JSON.parse(f.records.getItem(DRAW+'drawing'));
      Object.assign(ws.projects[0].drawings[0],{sourceType:'pdf',fileName:'drawing.pdf'});Object.assign(state,{sourceType:'pdf',fileName:'drawing.pdf'});
      if(replaced)state.pageReplacements={1:{updatedAt:100,pdfHash:digest,pdfSize:blob.size}};
      f.records.batch([[WS,json(ws)],[DRAW+'drawing',json(state)]]);await f.records.settled();const cutoff=await f.begin();
      const proof={assetId:'drawing-asset',projectId:scope.projectId,clientKey:'drawing:drawing',kind:'drawing',drawingId:'drawing',
        sha256:digest,size:blob.size,...(replaced?{drawingRevision:state.pageReplacements[1]}:{snapshotRevision:9,sourceType:'pdf',fileName:'drawing.pdf'})};
      const args={scope,localProjectId,bindingId:cutoff.bindingId,key:'background:drawing',blob,size:blob.size,sha256:digest,proof,validate:()=>true};
      const wrong=copy(proof);if(replaced)wrong.drawingRevision.updatedAt=101;else wrong.snapshotRevision=10;
      await assert.rejects(()=>f.records.deltaJournal.restoreMissingCutoffFile({...args,proof:wrong}),error=>error.code==='JOURNAL_RECOVERY_REVISION');
      assert.equal((await f.disk()).has(args.key),false);assert.equal((await f.records.deltaJournal.restoreMissingCutoffFile(args)).restored,true);
      assert.equal(await sha((await f.disk()).get(args.key)),digest);
    }
  });
  await test('drawing review preparation and cancellation never write and forged or consumed tickets cannot confirm',async()=>{
    const f=await drawingReviewFixture(),before=await f.disk(),controls=await f.disk(CONTROL),journal=await f.disk(LOG);
    const ticket=await f.prepare();assert(Object.isFrozen(ticket));assert.deepEqual(Object.keys(ticket),[]);
    assert.deepEqual(await f.disk(),before);assert.deepEqual(await f.disk(CONTROL),controls);assert.deepEqual(await f.disk(LOG),journal);
    assert.equal(f.records.deltaJournal.confirmedDrawingSource(localProjectId,'drawing'),null);
    assert.equal(f.records.deltaJournal.cancelMissingDrawingRecovery(ticket),true);
    assert.equal(f.records.deltaJournal.cancelMissingDrawingRecovery(ticket),false);
    for(const value of [ticket,{},Object.freeze({}),copy(ticket),null])
      await assert.rejects(()=>f.records.deltaJournal.confirmMissingDrawingRecovery(value),error=>error.code==='JOURNAL_RECOVERY_REVIEW_TICKET');
    assert.deepEqual(await f.disk(),before);assert.deepEqual(await f.disk(CONTROL),controls);assert.deepEqual(await f.disk(LOG),journal);
  });
  await test('explicit confirmation appends selected PDF atomically without rewriting the old cutoff or newer local notes',async()=>{
    const f=await drawingReviewFixture(),state=JSON.parse(f.records.getItem(DRAW+'drawing'));
    state.shapes[0].memo='Later unsent local note';f.records.setItem(DRAW+'drawing',json(state));await f.records.settled();
    const raw=f.records.getItem(DRAW+'drawing'),beforeJournal=await f.disk(LOG),ticket=await f.prepare();
    assert.deepEqual(copy(await f.records.deltaJournal.confirmMissingDrawingRecovery(ticket)),
      {restored:true,idempotent:false,liveWritten:true,sourceKind:'user-confirmed-current-drawing'});
    const after=await f.records.deltaJournal.readCutoff({scope,localProjectId});
    assert.deepEqual(after.rawEntries,f.cutoff.rawEntries);assert.deepEqual(after.snapshot,f.cutoff.snapshot);
    assert.equal(after.cutoffSeq,f.cutoff.cutoffSeq);assert.equal(after.serverRevision,9);assert.equal(f.records.getItem(DRAW+'drawing'),raw);
    assert.equal(await sha((await f.disk()).get(f.args.key)),f.digest);assert.equal(after.files.length,1);
    const receipt=after.files[0].recovery;assert.equal(receipt.sourceKind,'user-confirmed-current-drawing');
    assert.equal(receipt.originalSnapshotRevision,9);assert.equal(receipt.selectedSnapshotRevision,10);assert.equal(receipt.exactOriginalVerified,false);
    const journal=await f.disk(LOG);assert.equal(journal.size,beforeJournal.size+1);
    for(const [seq,row]of beforeJournal)assert.deepEqual(journal.get(seq),row);
    const added=[...journal.values()].at(-1);assert.equal(added.mutationKind,'cutoff-drawing-recovery-confirmed');
    assert.equal(added.files[0].before,null);assert.equal(await sha(added.files[0].after),f.digest);
    const expected={sha256:f.digest,size:f.blob.size,assetId:'current-drawing-asset',selectedSnapshotRevision:10};
    assert.deepEqual(copy(f.records.deltaJournal.confirmedDrawingSource(localProjectId,'drawing')),expected);
    const restarted=await f.restart();assert.deepEqual(copy(restarted.records.deltaJournal.confirmedDrawingSource(localProjectId,'drawing')),expected);
    assert.equal(restarted.records.getItem(DRAW+'drawing'),raw);
    await assert.rejects(()=>f.records.deltaJournal.confirmMissingDrawingRecovery(ticket),error=>error.code==='JOURNAL_RECOVERY_REVIEW_TICKET');
  });
  await test('matching live PDF is retained without another live write and a different live PDF is rejected',async()=>{
    const f=await drawingReviewFixture();await f.records.writeFile(f.args.key,f.blob);
    const journal=await f.disk(LOG),ticket=await f.prepare();
    assert.equal((await f.records.deltaJournal.confirmMissingDrawingRecovery(ticket)).liveWritten,false);
    assert.deepEqual(await f.disk(LOG),journal);assert.equal(await sha((await f.disk()).get(f.args.key)),f.digest);
    const conflict=await drawingReviewFixture(),other=new Blob(['different-live-pdf'],{type:'application/pdf'});
    await conflict.records.writeFile(conflict.args.key,other);const before=await conflict.disk(CONTROL);
    await assert.rejects(()=>conflict.prepare(),error=>/^JOURNAL_RECOVERY_REVIEW_/.test(error.code));
    assert.deepEqual(await conflict.disk(CONTROL),before);assert.equal(await sha((await conflict.disk()).get(conflict.args.key)),await sha(other));
  });
  await test('only one concurrent confirmation can consume a drawing ticket and a started confirmation cannot report cancellation',async()=>{
    const f=await drawingReviewFixture(),ticket=await f.prepare(),first=f.records.deltaJournal.confirmMissingDrawingRecovery(ticket);
    assert.equal(f.records.deltaJournal.cancelMissingDrawingRecovery(ticket),false);
    await assert.rejects(()=>f.records.deltaJournal.confirmMissingDrawingRecovery(ticket),error=>error.code==='JOURNAL_RECOVERY_REVIEW_TICKET');
    assert.equal((await first).restored,true);assert.equal((await f.records.deltaJournal.readCutoff({scope,localProjectId})).files.length,1);
    assert.equal((await f.disk(LOG)).size,1);
  });
  await test('drawing review refuses foreign identities, wrong source, stale revisions and unverified bytes',async()=>{
    for(const variant of ['scope','owner','project','binding','key','kind','client-key','drawing','hash','bytes','zero','size','revision',
      'source-missing','source-id','source-file','source-type','source-pages','source-markers','filename','sourcetype','photo']){
      const f=await drawingReviewFixture(),args={...f.args,proof:copy(f.args.proof)},before=await f.disk(CONTROL);
      if(variant==='scope')args.scope={...scope,deviceId:'other-device'};
      if(variant==='owner')args.proof.ownerId='foreign';
      if(variant==='project')args.proof.projectId='foreign';
      if(variant==='binding')args.bindingId='foreign';
      if(variant==='key')args.key='background:unknown';
      if(variant==='kind')args.proof.kind='photo';
      if(variant==='client-key')args.proof.clientKey='drawing:other';
      if(variant==='drawing')args.proof.drawingId='other';
      if(variant==='hash')args.sha256=args.proof.sha256='f'.repeat(64);
      if(variant==='bytes')args.blob=new Blob(['x'.repeat(f.blob.size)],{type:'application/pdf'});
      if(variant==='zero'){args.blob=new Blob([]);args.size=args.proof.size=0;}
      if(variant==='size')args.size=args.proof.size=f.blob.size+1;
      if(variant==='revision')args.proof.snapshotRevision=8;
      if(variant==='source-missing')delete args.proof.source;
      if(variant==='source-id')args.proof.source.id='other';
      if(variant==='source-file')args.proof.source.fileName='other.pdf';
      if(variant==='source-type')args.proof.source.sourceType='image';
      if(variant==='source-pages')args.proof.source.pageCount=2;
      if(variant==='source-markers')args.proof.source.pageReplacements={1:{updatedAt:1}};
      if(variant==='filename')args.proof.fileName='other.pdf';
      if(variant==='sourcetype')args.proof.sourceType='image';
      if(variant==='photo')args.key='photo:drawing:photo-0';
      await assert.rejects(()=>f.records.deltaJournal.prepareMissingDrawingRecovery(args),error=>/^JOURNAL_RECOVERY_REVIEW_/.test(error.code),variant);
      assert.deepEqual(await f.disk(CONTROL),before,variant);assert.equal((await f.disk(LOG)).size,0,variant);assert.equal((await f.disk()).has(f.args.key),false,variant);
    }
  });
  await test('drawing review cannot bypass existing protected bytes, page replacement history or an already changed local source',async()=>{
    for(const options of [{protectedBlob:new Blob([])},{protectedBlob:new Blob(['existing'])},{markers:{1:{updatedAt:1}}}]){
      const f=await drawingReviewFixture(options),before=await f.disk(CONTROL);
      await assert.rejects(()=>f.prepare(),error=>/^JOURNAL_RECOVERY_REVIEW_/.test(error.code));assert.deepEqual(await f.disk(CONTROL),before);
    }
    const f=await drawingReviewFixture(),state=JSON.parse(f.records.getItem(DRAW+'drawing'));
    state.fileName='new-local.pdf';f.records.setItem(DRAW+'drawing',json(state));await f.records.settled();
    await assert.rejects(()=>f.prepare(),error=>error.code==='JOURNAL_RECOVERY_REVIEW_CHANGED');
    assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing')).fileName,'new-local.pdf');
    const automatic=await drawingReviewFixture();
    await assert.rejects(()=>automatic.records.deltaJournal.restoreMissingCutoffFile({...automatic.args,
      confirmed:true,allowNewerRevision:true,proof:{...automatic.args.proof,sourceKind:'user-confirmed-current-drawing',confirmed:true}}),
      error=>error.code==='JOURNAL_RECOVERY_REVISION');
    assert.equal((await automatic.disk()).has(automatic.args.key),false);
  });
  await test('editing, authentication, live-file and binding changes invalidate a prepared drawing ticket without writes',async()=>{
    for(const variant of ['note','other-tab','auth','live-different','live-same','live-removal','binding']){
      const f=await drawingReviewFixture();let valid=true;
      if(variant==='live-removal')await f.records.writeFile(f.args.key,f.blob);
      const ticket=await f.prepare({validate:()=>valid});
      if(variant==='note'){const state=JSON.parse(f.records.getItem(DRAW+'drawing'));state.shapes[0].memo='New note after preview';
        f.records.setItem(DRAW+'drawing',json(state));await f.records.settled();}
      if(variant==='other-tab'){const other=await f.restart(),state=JSON.parse(other.records.getItem(DRAW+'drawing'));state.shapes[0].memo='Note from another tab';
        other.records.setItem(DRAW+'drawing',json(state));await other.records.settled();}
      if(variant==='auth')valid=false;
      if(variant==='live-different')await f.records.writeFile(f.args.key,new Blob(['other PDF'],{type:'application/pdf'}));
      if(variant==='live-same')await f.records.writeFile(f.args.key,f.blob);
      if(variant==='live-removal')await f.records.writeFile(f.args.key,null);
      if(variant==='binding'){
        const db=await f.records.openFilesDatabase();await new Promise((resolve,reject)=>{
          const tx=db.transaction(CONTROL,'readwrite'),s=tx.objectStore(CONTROL);s.get('binding:'+localProjectId).onsuccess=e=>{
            const b=e.target.result;b.cutoff.serverRevision=10;s.put(b,'binding:'+localProjectId);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
        });db.close();
      }
      const before=await f.disk(),controls=await f.disk(CONTROL),journal=await f.disk(LOG);
      await assert.rejects(()=>f.records.deltaJournal.confirmMissingDrawingRecovery(ticket),error=>/^JOURNAL_RECOVERY_/.test(error.code),variant);
      assert.deepEqual(await f.disk(),before,variant);assert.deepEqual(await f.disk(CONTROL),controls,variant);assert.deepEqual(await f.disk(LOG),journal,variant);
      await assert.rejects(()=>f.records.deltaJournal.confirmMissingDrawingRecovery(ticket),error=>error.code==='JOURNAL_RECOVERY_REVIEW_TICKET');
    }
  });
  await test('drawing confirmation rollback is atomic and requires a fresh review after quota failure',async()=>{
    const f=await drawingReviewFixture(),ticket=await f.prepare(),original=IDBObjectStore.prototype.add;
    const before=await f.disk(),controls=await f.disk(CONTROL),journal=await f.disk(LOG);
    IDBObjectStore.prototype.add=function(value,...args){if(this.name===CONTROL&&value?.kind==='cutoff-file')throw Object.assign(Error('review quota'),{name:'QuotaExceededError'});return original.call(this,value,...args);};
    try{await assert.rejects(()=>f.records.deltaJournal.confirmMissingDrawingRecovery(ticket),/review quota/);}finally{IDBObjectStore.prototype.add=original;}
    assert.deepEqual(await f.disk(),before);assert.deepEqual(await f.disk(CONTROL),controls);assert.deepEqual(await f.disk(LOG),journal);
    await assert.rejects(()=>f.records.deltaJournal.confirmMissingDrawingRecovery(ticket),error=>error.code==='JOURNAL_RECOVERY_REVIEW_TICKET');
    assert.equal((await f.records.deltaJournal.confirmMissingDrawingRecovery(await f.prepare())).restored,true);
  });
  await test('quota failure rolls back live file, cutoff append and journal together, then ordinary retry succeeds',async()=>{
    const f=await fixture(),cutoff=await f.begin(),key=[...f.files.keys()][0],original=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(value,...args){if(this.name===CONTROL&&value?.kind==='cutoff-file')throw Object.assign(Error('synthetic quota'),{name:'QuotaExceededError'});return original.call(this,value,...args);};
    try{await assert.rejects(()=>f.restore(cutoff,key),/synthetic quota/);}finally{IDBObjectStore.prototype.add=original;}
    assert.equal((await f.disk()).has(key),false);assert.equal((await f.disk(LOG)).size,0);
    assert.equal((await f.records.deltaJournal.readCutoff({scope,localProjectId})).files.length,0);assert.equal((await f.restore(cutoff,key)).restored,true);
  });
  await test('scope change after content verification stops before saving any recovered copy',async()=>{
    const f=await fixture(),cutoff=await f.begin(),key=[...f.files.keys()][0];let checks=0;
    await assert.rejects(()=>f.restore(cutoff,key,{validate:()=>++checks<3}),error=>error.code==='JOURNAL_RECOVERY_SCOPE');
    assert.equal((await f.disk()).has(key),false);assert.equal((await f.disk(LOG)).size,0);
  });
  await test('actual installer resumes bounded persisted recovery and installs only after all missing files verify',async()=>{
    const f=await fixture(3,{legacyPhotoMetadata:true}),seen=[],initial=await f.begin(),inst=await installerFixture(f,async args=>{
      assert.equal(args.serverRevision,9);assert.equal(args.bindingId,initial.bindingId);
      seen.push(args.missing.map(item=>item.key));await args.restore(f.payload(args.missing[0].key));
    });
    try{
      await assert.rejects(()=>inst.run(),error=>error.code==='DELTA_MIGRATION_RECOVERING'&&error.recovered===1&&error.remaining===2&&
        error.localProjectId===localProjectId&&error.bindingId===initial.bindingId&&json(error.scope)===json(scope));
      assert.equal(inst.baselineReads,0,'incomplete source must not trigger whole baseline copy or publication');assert.equal(await inst.store.read(),null);
      await assert.rejects(()=>inst.run(),error=>error.code==='DELTA_MIGRATION_RECOVERING'&&error.recovered===1&&error.remaining===1);
      assert.equal((await inst.run()).installed,true);assert.equal(seen.length,3);assert.deepEqual(seen.map(keys=>keys.length),[3,2,1]);
      assert.equal(new Set(seen.map(keys=>keys[0])).size,3,'already recovered bytes are not requested again');
      assert.equal((await f.records.deltaJournal.readBindingState(localProjectId)).phase,'active');assert(await inst.store.readProvenance());
      const after=await f.records.deltaJournal.readCutoff({scope,localProjectId});assert.deepEqual(after.rawEntries,initial.rawEntries);assert.equal(after.cutoffSeq,initial.cutoffSeq);
      for(const [key,file]of f.files)assert.equal(await sha((await f.disk()).get(key)),file.sha256);
      const before=await inst.store.read(),transport={online:()=>false,push:async()=>{throw Error('offline');},pushGroup:async()=>{throw Error('offline');},list:async()=>[],getCapabilities:()=>({atomicGroups:true})};
      const replica=D.createReplica({...scope,store:inst.store,transport}),bridge=Bridge.createBridge({replica,scope,localProjectId,currentScope:()=>scope});
      const controller=Journal.createController({records:f.records,scope,localProjectId,replica,replicaStore:inst.store,bridge,metadata:Metadata,currentScope:()=>scope});
      try{await controller.drain();assert.equal((await f.records.deltaJournal.pending({scope,localProjectId})).count,0);
        assert.deepEqual((await inst.store.read()).outbox,before.outbox,'recovered bytes must not invent new photo records or edits');
      }finally{controller.close();bridge.close();replica.close();}
    }finally{inst.store.close();}
  });
  await test('a claimed helper count or a live-only receipt cannot shorten an unverified cutoff retry',async()=>{
    for(const liveOnly of [false,true]){
      const f=await fixture(2,{legacyPhotoMetadata:true}),inst=await installerFixture(f,async args=>{
        if(liveOnly){const file=f.payload(args.missing[0].key);await f.records.writeFile(file.key,file.blob);}
        return {restored:2,remaining:0};
      });
      try{
        await assert.rejects(()=>inst.run(),error=>error.code==='DELTA_MIGRATION_REVIEW'&&
          error.message==='写真または図面ファイルを確認できません（2件）'&&error.issues.length===2);
        assert.equal(inst.baselineReads,0);assert.equal((await f.records.deltaJournal.readBindingState(localProjectId)).phase,'staging');
        assert.equal((await f.records.deltaJournal.missingCutoffFiles({scope,localProjectId})).length,2);
      }finally{inst.store.close();}
    }
  });
  await test('a network, auth, quota or scope error after a receipt remains an error instead of a fast retry',async()=>{
    for(const kind of ['network','auth','quota','scope']){
      const f=await fixture(2);let current=scope;
      const expected=Object.assign(Error('synthetic '+kind),kind==='auth'?{status:401}:kind==='quota'?{name:'QuotaExceededError'}:{code:'RECOVERY_NETWORK'});
      const inst=await installerFixture(f,async args=>{
        await args.restore(f.payload(args.missing[0].key));
        if(kind==='scope'){current={...scope,ownerId:'other-owner'};return;}
        throw expected;
      },{currentScope:()=>current});
      try{
        await assert.rejects(()=>inst.run(),error=>kind==='scope'?error.code==='DELTA_MIGRATION_SCOPE':error===expected);
        assert.equal(inst.baselineReads,0);assert.equal((await f.records.deltaJournal.missingCutoffFiles({scope,localProjectId})).length,1);
      }finally{inst.store.close();}
    }
  });
  await test('authenticated recovery helper passes exact photo and legacy PDF proofs into the real installer and journal',async()=>{
    const f=await fixture(),blob=new Blob(['legacy-drawing-pdf'],{type:'application/pdf'}),digest=await sha(blob);
    Object.assign(f.snapshot.project.drawings[0],{fileName:'drawing.pdf',sourceType:'pdf'});
    Object.assign(f.snapshot.drawings[0].meta,{fileName:'drawing.pdf',sourceType:'pdf'});
    Object.assign(f.snapshot.drawings[0].state,{fileName:'drawing.pdf',sourceType:'pdf'});
    f.records.batch([[WS,json({projects:[f.snapshot.project]})],[DRAW+'drawing',json(f.snapshot.drawings[0].state)]]);await f.records.settled();
    f.files.set('background:drawing',{blob,size:blob.size,sha256:digest});
    const assets=[...f.files].map(([key,file],index)=>({id:'asset-'+index,owner_id:scope.ownerId,project_id:scope.projectId,
      client_key:key.startsWith('background:')?'drawing:drawing':key,kind:key.startsWith('background:')?'drawing':'photo',
      status:'uploaded',storage_path:scope.ownerId+'/'+scope.projectId+'/'+(key.startsWith('background:')?'drawings':'photos')+'/'+index,
      sha256:file.sha256,byte_size:file.size,
      file_name:key.startsWith('background:')?'drawing.pdf':'photo-0.jpg',metadata:{drawing_id:'drawing',local_project_key:localProjectId,
        ...(key.startsWith('background:')?{source_type:'pdf'}:{photo_id:'photo-0'})}}));
    const helper=Recovery.createRecovery({listAssets:async(_,keys)=>assets.filter(asset=>keys.includes(asset.client_key)),
      readAsset:async(_,id)=>assets.find(asset=>asset.id===id),readSnapshot:async()=>({revision:9,payload:copy(f.snapshot)}),
      download:async asset=>f.files.get(asset.kind==='drawing'?'background:drawing':asset.client_key).blob});
    const inst=await installerFixture(f,helper);try{assert.equal((await inst.run()).installed,true);
      for(const [key,file]of f.files)assert.equal(await sha((await f.disk()).get(key)),file.sha256);
    }finally{inst.store.close();}
  });
  await test('69 accepted photo references migrate without bytes and later use the guarded asset receiver before any acknowledgement',async()=>{
    const f=await fixture(69),photos=f.snapshot.drawings[0].state.shapes[0].photos;
    f.snapshot.drawings[0].state.shapes=Array.from({length:5},(_,i)=>C.upgrade({id:'record-'+i,kind:'point',memo:'Retained note '+i,
      photos:photos.slice(i*14,(i+1)*14)}));
    f.records.setItem(DRAW+'drawing',json(f.snapshot.drawings[0].state));await f.records.settled();
    const initial=await f.begin(),server=copy(f.snapshot);server.drawings[0].state.shapes=[];
    const acceptedEvents=f.snapshot.drawings[0].state.shapes.map((record,i)=>D.diffRecord(null,record,
      {eventId:'accepted-photo-record-'+i,projectId:scope.projectId,drawingId:'drawing',deviceId:'peer'}));
    const recovery=Recovery.createRecovery({listAssets:async()=>[],readAsset:async()=>{throw Error('no asset to read');},
      readSnapshot:async()=>{throw Error('no PDF recovery');},download:async()=>{throw Error('no bytes to download');}});
    const inst=await installerFixture(f,recovery,{server,acceptedEvents});
    let assetRuntime,assetStore;
    try{
      assert.equal((await inst.run()).installed,true);const state=await inst.store.read(),provenance=await inst.store.readProvenance();
      assert.equal(state.cursor,5);assert.equal(Object.values(state.records).reduce((n,record)=>n+(record.photos?.length||0),0),69);
      assert.equal(state.outbox.length,0);assert.equal((await f.records.deltaJournal.readBindingState(localProjectId)).phase,'active');
      const cutoff=await f.records.deltaJournal.readCutoff({scope,localProjectId});assert.deepEqual(cutoff.rawEntries,initial.rawEntries);assert.equal(cutoff.files.length,0);
      const migration=Migration.createCoordinator({source:{capture:async()=>{},recheck:async()=>{}},
        store:Migration.createStore({...scope,indexedDB:f.factory}),localProjectId,currentScope:()=>scope});
      try{const saved=await migration.readCopy(provenance.source.migrationId),pending=saved.snapshot.manifest.filter(item=>item.status==='shared-photo-pending');
        assert.equal(pending.length,69);assert(pending.every(item=>item.deliveryVerified===false));assert.equal(saved.snapshot.files.length,0);
      }finally{migration.close();}
      const rows=[],acks=[],owners=new Map(),token=Object.freeze({}),stats={uploads:0,downloads:0};
      let corrupt=false;
      const transport={getScope:()=>copy(scope),online:()=>true,listPhotos:async()=>copy(rows),
        uploadPhoto:async()=>{stats.uploads++;throw Error('receiver has no photo bytes');},
        download:async ref=>{stats.downloads++;return corrupt?new Blob(['corrupt download'],{type:ref.mimeType}):f.files.get('photo:'+ref.drawingId+':'+ref.photoId).blob;},
        acknowledge:async ref=>{assert.equal(await sha((await f.disk()).get('photo:'+ref.drawingId+':'+ref.photoId)),ref.sha256);
          acks.push(ref.assetId);return {...copy(ref),deviceId:scope.deviceId,durable:true};}};
      const localFiles={getCapabilities:()=>f.records.getFileWriteCapabilities(),read:async key=>(await f.disk()).get(key),
        assertExclusive:key=>{const value=f.records.writerState(key,{ownerToken:owners.get(key)});return value.exclusive&&!value.foreignPending&&!value.failed&&value.journaled;},
        withLock:async(key,fn)=>{const owner={};assert(!owners.has(key));owners.set(key,owner);try{return await fn();}finally{owners.delete(key);}},
        write:(key,blob,options)=>f.records.writeFile(key,blob,{...options,ownerToken:owners.get(key)})};
      assetStore=Assets.createIndexedDBStore({...scope,indexedDB:f.factory});
      assetRuntime=AssetRuntime.createRuntime({scope,transport,store:assetStore,localFiles,currentScope:()=>scope,
        currentSnapshotToken:()=>token,authGeneration:()=>0,subscribeAuth:()=>()=>{}});
      const waiting=await assetRuntime.sync({snapshot:state,snapshotToken:token});
      assert.equal(waiting.complete,false);assert.equal(waiting.pending,69);assert.equal(waiting.references.length,0);
      assert(waiting.issues.every(issue=>issue.code==='ASSET_REFERENCE_MISSING'));assert.equal(acks.length,0);assert.equal(stats.uploads,0);assert.equal(stats.downloads,0);
      assert.equal((await f.disk()).has('photo:drawing:photo-0'),false);
      const [key,file]=[...f.files][0],photoId=key.slice('photo:drawing:'.length);
      rows.push({id:'10000000-0000-4000-8000-000000000001',owner_id:scope.ownerId,project_id:scope.projectId,kind:'photo',client_key:key,
        file_name:'received.jpg',mime_type:file.blob.type,byte_size:file.size,sha256:file.sha256,status:'uploaded',metadata:{drawing_id:'drawing',photo_id:photoId}});
      corrupt=true;const bad=await assetRuntime.sync({snapshot:state,snapshotToken:token});
      assert.equal(bad.complete,false);assert.equal(acks.length,0);assert.equal((await f.disk()).has(key),false);
      corrupt=false;const received=await assetRuntime.sync({snapshot:state,snapshotToken:token});
      assert.equal(received.complete,false);assert.equal(received.pending,68);assert.equal(acks.length,1);
      assert.equal(await sha((await f.disk()).get(key)),file.sha256);assert.equal((await f.records.deltaJournal.readCutoff({scope,localProjectId})).files.length,0);
      assert.equal((await inst.store.read()).outbox.length,0,'receiving bytes cannot invent record changes or deletion permissions');
    }finally{assetRuntime?.close();assetStore?.close();inst.store.close();}
  });
  console.log('PASS staged cutoff recovery:',passed,'durability and installer groups');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

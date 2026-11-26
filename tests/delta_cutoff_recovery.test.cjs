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
async function fixture(count=1){
  const files=new Map(),photos=[];
  for(let i=0;i<count;i++){const id='photo-'+i,blob=new Blob(['saved-photo-'+i],{type:'image/jpeg'}),digest=await sha(blob);
    photos.push({id,name:id+'.jpg',size:blob.size,sha256:digest});files.set('photo:drawing:'+id,{blob,size:blob.size,sha256:digest});}
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
async function installerFixture(f,recoverMissingFiles){
  const server=f.snapshot,rows=[],metadata=[];
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
    state:'verified',deltaEnabled:false,deviceMigrationVerified:false,assetDeliveryVerified:false};
  let baselineReads=0;
  const transport={getCapabilities:()=>({atomicGroups:true,sharedMetadata:true}),pushGroup:async()=>{},
    prepareBaseline:async revision=>{assert.equal(revision,9);baselineReads++;return copy(receipt);},
    activateBaseline:async()=>{receipt.state='active';receipt.deltaEnabled=true;return copy(receipt);},
    readBaselinePage:async(id,after,limit)=>({receipt:copy(receipt),records:rows.slice(after,after+limit),nextOrdinal:Math.min(after+limit,rows.length),hasMore:after+limit<rows.length}),
    readBaselineMetadataPage:async(id,after,limit)=>({receipt:copy(receipt),metadata:metadata.slice(after,after+limit),nextOrdinal:Math.min(after+limit,metadata.length),hasMore:after+limit<metadata.length})};
  const store=I.createStore({...scope,indexedDB:f.factory});
  const install=Installer.createInstaller({records:f.records,recoverMissingFiles,factories:{
    source:args=>Source.createSource({...args,indexedDB:f.factory,localStorage:f.localStorage,crypto:webcrypto}),
    migrationStore:s=>Migration.createStore({...s,indexedDB:f.factory})}});
  return {store,get baselineReads(){return baselineReads;},run:()=>install({scope,localProjectId,actor,transport,store,
    mode:{enabled:receipt.deltaEnabled,baseline:receipt.deltaEnabled?copy(receipt):null,snapshotRevision:9},revision:9,currentScope:()=>scope})};
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
    const f=await fixture(3),seen=[],initial=await f.begin(),inst=await installerFixture(f,async args=>{
      assert.equal(args.serverRevision,9);assert.equal(args.bindingId,initial.bindingId);
      seen.push(args.missing.map(item=>item.key));await args.restore(f.payload(args.missing[0].key));
    });
    try{
      await assert.rejects(()=>inst.run(),error=>error.code==='DELTA_MIGRATION_REVIEW'&&error.message==='写真または図面ファイルを確認できません（2件）'&&error.issues.length===2);
      assert.equal(inst.baselineReads,0,'incomplete source must not trigger whole baseline copy or publication');assert.equal(await inst.store.read(),null);
      await assert.rejects(()=>inst.run(),error=>error.code==='DELTA_MIGRATION_REVIEW'&&error.issues.length===1);
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
  console.log('PASS staged cutoff recovery:',passed,'durability and installer groups');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

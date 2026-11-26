'use strict';
// Real installer, source, migration store and writer against disposable IDB.
// No production requests or user files. Count logical Blob copies/reads rather
// than claiming these synthetic measurements are Safari process memory.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{IDBFactory,IDBKeyRange,IDBObjectStore}=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const Source=require('../sentlog/delta-sync-legacy-source.js'),Installer=require('../sentlog/delta-sync-app-migration.js');
const I=require('../sentlog/delta-sync-indexeddb.js'),Migration=require('../sentlog/delta-sync-migration.js');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const scope={ownerId:'retry-owner',projectId:'retry-cloud',deviceId:'retry-device'},localProjectId='retry-local';
const actor={deviceId:scope.deviceId,deviceName:'Synthetic retry'},copy=structuredClone,json=JSON.stringify;
const sha=async blob=>Buffer.from(await webcrypto.subtle.digest('SHA-256',await blob.arrayBuffer())).toString('hex');
const hash=async text=>sha(new Blob([text]));
async function open(factory,name,upgrade){return new Promise((resolve,reject)=>{
  const q=factory.open(name);q.onupgradeneeded=()=>upgrade?.(q.result);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
});}
async function rows(factory,name,store){
  if(!(await factory.databases()).some(db=>db.name===name))return [];
  const db=await open(factory,name);try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(store,'readonly'),q=tx.objectStore(store).getAll();let result;
    q.onsuccess=()=>result=q.result;tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
async function migrationRows(f){
  const sessions=await rows(f.factory,'sentlog-delta-migration-v1','sessions'),items=await rows(f.factory,'sentlog-delta-migration-v1','items');
  return {sessions,items,bytes:items.reduce((n,item)=>n+(item.value instanceof Blob?item.value.size:0),0)};
}
async function fixture(count=1,size=64){
  const factory=new IDBFactory(),files=new Map(),photos=[];
  for(let i=0;i<count;i++){
    const id='photo-'+i,blob=new Blob([new Uint8Array(size).fill(i+1)],{type:'image/jpeg'});
    photos.push({id,name:id+'.jpg',size:blob.size,sha256:await sha(blob)});files.set('photo:drawing:'+id,blob);
  }
  const meta={id:'drawing',name:'Drawing',sourceType:null,fileName:'',pageCount:1};
  const state={sourceType:null,fileName:'',pageCount:1,shapes:[C.upgrade({id:'record',kind:'point',memo:'Original note',photos})],collabDeletedRecords:[]};
  const snapshot={version:1,kind:'sentlog-app-project',localProjectId,project:{id:localProjectId,name:'Retry',drawings:[meta]},drawings:[{meta:copy(meta),state}]};
  const local=new Map([[WS,json({projects:[snapshot.project]})],[DRAW+'drawing',json(state)]]);
  const localStorage={get length(){return local.size;},key:i=>[...local.keys()][i]??null,getItem:k=>local.get(k)??null,
    setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};
  const context={window:null,indexedDB:factory,IDBKeyRange,localStorage,navigator:{},console,Blob,queueMicrotask,
    structuredClone,crypto:webcrypto,SentlogDeltaSyncCore:D};context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../sentlog/record-store.js'),'utf8'),context);
  const records=context.SentlogRecords;await records.init();for(const [key,blob]of files)await records.writeFile(key,blob);
  return {factory,records,local,localStorage,files,snapshot,begin:()=>records.deltaJournal.begin({scope,localProjectId,actor,serverRevision:9})};
}
async function server(f,options={}){
  const snapshot=f.snapshot,records=[],metadata=[];
  for(const drawing of snapshot.drawings)for(const record of drawing.state.shapes){
    const row={ordinal:records.length+1,drawingId:drawing.meta.id,recordId:record.id,recordJson:json(record),sha256:await hash(json(record))};
    row.manifestEntryJson=json({ordinal:row.ordinal,drawingId:row.drawingId,recordId:row.recordId,sha256:row.sha256});records.push(row);
  }
  const values=[['header','project',{project:copy(snapshot.project)}],...snapshot.drawings.map(d=>{
    const state=copy(d.state);delete state.shapes;delete state.collabDeletedRecords;return ['drawing',d.meta.id,{meta:d.meta,state}];})];
  for(const [kind,key,value]of values){
    const row={ordinal:metadata.length+1,kind,key,metadataJson:json(value),sha256:await hash(json(value))};
    row.manifestEntryJson=json({ordinal:row.ordinal,kind,key,sha256:row.sha256});metadata.push(row);
  }
  const receipt={schema:1,baselineId:'baseline',ownerId:scope.ownerId,projectId:scope.projectId,clientProjectId:localProjectId,drawingIds:['drawing'],
    snapshotRevision:9,cursor:0,recordCount:records.length,importedCount:records.length,metadataCount:metadata.length,
    snapshotSha256:await hash(json({project:snapshot.project,drawings:snapshot.drawings})),
    manifestSha256:await hash('['+records.map(r=>r.manifestEntryJson).join(', ')+']'),
    metadataManifestSha256:await hash('['+metadata.map(r=>r.manifestEntryJson).join(', ')+']'),hashFormat:'postgres-jsonb-text-sha256-v1',
    state:'verified',deltaEnabled:false,deviceMigrationVerified:false,assetDeliveryVerified:false};
  const attempts=[];
  const transport={getCapabilities:()=>({atomicGroups:true,sharedMetadata:true}),pushGroup:async()=>{},
    prepareBaseline:async()=>copy(receipt),
    activateBaseline:async(id,proof)=>{attempts.push({id,proof:copy(proof)});throw Object.assign(Error('synthetic activation timeout'),{code:'DELTA_SERVER_TIMEOUT'});},
    readBaselinePage:async(id,after,limit)=>({receipt:copy(receipt),records:records.slice(after,after+limit),nextOrdinal:Math.min(after+limit,records.length),hasMore:after+limit<records.length}),
    readBaselineMetadataPage:async(id,after,limit)=>({receipt:copy(receipt),metadata:metadata.slice(after,after+limit),nextOrdinal:Math.min(after+limit,metadata.length),hasMore:after+limit<metadata.length})};
  const store=I.createStore({...scope,indexedDB:f.factory}),currentScope=options.currentScope||(()=>scope);
  const install=Installer.createInstaller({records:f.records,factories:{
    source:args=>Source.createSource({...args,indexedDB:f.factory,localStorage:f.localStorage,crypto:webcrypto}),
    migrationStore:s=>{const store=Migration.createStore({...s,indexedDB:f.factory});return options.migrationStore?.(store)||store;},...options.factories}});
  return {receipt,store,attempts,run:()=>install({scope,localProjectId,actor,transport,store,
    mode:{enabled:false,snapshotRevision:9},revision:9,currentScope})};
}
async function original(f,bytes){
  const db=await open(f.factory,'sentlog-original-photos-v1',db=>{db.createObjectStore('photos');db.createObjectStore('meta',{keyPath:'key'});});
  const blob=new Blob([bytes],{type:'image/jpeg'}),key='drawing:photo-0';
  try{await new Promise((resolve,reject)=>{
    const tx=db.transaction(['photos','meta'],'readwrite');
    tx.objectStore('photos').put(blob,key);tx.objectStore('meta').put({key,projectId:localProjectId,drawingId:'drawing',photoId:'photo-0',size:blob.size,
      type:blob.type,originalName:'original.jpg',exportedAt:null,photoAssociation:{version:1,status:'attached',photoId:'photo-0',operationId:'capture',
        target:{projectId:localProjectId,drawingId:'drawing',recordId:'record'}}});
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}return blob;
}
const timeout=fn=>assert.rejects(fn,error=>error.code==='DELTA_SERVER_TIMEOUT');
let passed=0;async function test(name,run){await run();passed++;console.log('PASS',name);}
(async()=>{
  await test('16 MiB source survives three activation timeouts with one verified copy and fresh byte checks',async()=>{
    const f=await fixture(8,2*1024*1024),s=await server(f),saved=f.records.getItem(DRAW+'drawing');
    const arrayBuffer=Blob.prototype.arrayBuffer,getAll=IDBObjectStore.prototype.getAll;let photoReads=0,readBytes=0,unboundedFiles=0;
    Blob.prototype.arrayBuffer=function(){if(this.type==='image/jpeg'){photoReads++;readBytes+=this.size;}return arrayBuffer.call(this);};
    IDBObjectStore.prototype.getAll=function(...args){if(this.name==='files'&&args[0]===undefined)unboundedFiles++;return getAll.apply(this,args);};
    try{
      for(let attempt=1;attempt<=3;attempt++){
        photoReads=0;readBytes=0;await timeout(s.run);const retained=await migrationRows(f);
        assert.equal(retained.sessions.length,1);assert.equal(retained.sessions[0].status,'verified-copy');
        assert.equal(retained.items.length,9);assert.equal(retained.bytes,16*1024*1024);
        assert.equal(photoReads,48);assert.equal(readBytes,96*1024*1024);
        assert.equal(f.records.getItem(DRAW+'drawing'),saved);
        console.log('MEASURE',json({attempt,sourceBytes:16*1024*1024,photoReads,readBytes,sessions:retained.sessions.length,retainedBlobBytes:retained.bytes}));
      }
      assert.equal(new Set(s.attempts.map(x=>x.proof.migrationId)).size,1);assert.equal(unboundedFiles,0);
      assert.equal(await s.store.readProvenance(),null);
    }finally{Blob.prototype.arrayBuffer=arrayBuffer;IDBObjectStore.prototype.getAll=getAll;s.store.close();}
  });
  await test('first cutoff reads only its project files and retries avoid the live files store and foreign cutoff rows',async()=>{
    const f=await fixture(),otherScope={...scope,projectId:'other-cloud'},other={id:'other-local',name:'Other',drawings:[{id:'foreign',name:'Foreign'}]};
    f.records.setItem(WS,json({projects:[f.snapshot.project,other]}));f.records.setItem(DRAW+'foreign',json({shapes:[]}));await f.records.settled();
    await f.records.writeFile('photo:foreign:large',new Blob([new Uint8Array(1024*1024)]));await f.records.writeFile('background:foreign',new Blob(['pdf']));
    const foreign=await f.records.deltaJournal.begin({scope:otherScope,localProjectId:other.id,actor,serverRevision:9});
    const get=IDBObjectStore.prototype.get,getAll=IDBObjectStore.prototype.getAll;const fileKeys=[],controlKeys=[];let fullReads=0;
    IDBObjectStore.prototype.get=function(key){if(this.name==='files')fileKeys.push(key);if(this.name===CONTROL)controlKeys.push(key);return get.call(this,key);};
    IDBObjectStore.prototype.getAll=function(...args){if(this.name===CONTROL||this.name==='files'&&args[0]===undefined)fullReads++;return getAll.apply(this,args);};
    try{
      const cutoff=await f.begin();assert.deepEqual(cutoff.files.map(x=>x.key),['photo:drawing:photo-0']);
      assert(!fileKeys.some(key=>String(key).includes('foreign')));assert.equal(fullReads,0);
      fileKeys.length=0;controlKeys.length=0;await f.begin();await f.records.deltaJournal.readCutoff({scope,localProjectId});
      assert.equal(fileKeys.length,0);assert.equal(fullReads,0);assert(!controlKeys.some(key=>String(key).includes(foreign.bindingId)));
    }finally{IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.getAll=getAll;}
  });
  await test('a committed partial copy resumes after interruption without duplicating sessions or overwriting copied bytes',async()=>{
    const f=await fixture(18),seen=[];let stop=true;
    const s=await server(f,{migrationStore:store=>({...store,append:async(...args)=>{
      const result=await store.append(...args);seen.push({id:args[0],start:args[1],length:args[2].length});
      if(stop){stop=false;throw Object.assign(Error('synthetic crash after committed batch'),{code:'SIMULATED_CRASH'});}return result;
    }})});
    await assert.rejects(s.run,error=>error.code==='SIMULATED_CRASH');const partial=await migrationRows(f);
    assert.equal(partial.sessions.length,1);assert.equal(partial.sessions[0].next,16);assert.equal(partial.items.length,16);
    await timeout(s.run);const complete=await migrationRows(f);assert.equal(complete.sessions.length,1);assert.equal(complete.items.length,19);
    assert.equal(complete.bytes,18*64);assert.deepEqual(seen.map(x=>x.start),[0,16]);s.store.close();
  });
  await test('original replacement during copying blocks activation and the changed source gets a separate preserved copy',async()=>{
    const f=await fixture();await original(f,'first-original');let change=true;
    const s=await server(f,{migrationStore:store=>({...store,append:async(...args)=>{
      const result=await store.append(...args);if(change){change=false;await original(f,'other-original');}return result;
    }})});
    await assert.rejects(s.run,error=>error.code==='DELTA_MIGRATION_REVIEW');assert.equal(s.attempts.length,0);
    const before=await migrationRows(f);assert.equal(before.sessions.length,1);assert.equal(before.sessions[0].status,'needs-review');
    assert.equal(await before.items.find(x=>x.descriptor.key==='["original-photo","original:drawing:photo-0"]').value.text(),'first-original');
    await timeout(s.run);const after=await migrationRows(f);assert.equal(after.sessions.length,2);
    assert.equal(new Set(after.sessions.map(x=>x.sourceFingerprint)).size,2);
    const originals=after.items.filter(x=>x.descriptor.key==='["original-photo","original:drawing:photo-0"]');
    assert.deepEqual((await Promise.all(originals.map(x=>x.value.text()))).sort(),['first-original','other-original']);
    for(const item of before.items){const saved=after.items.find(x=>x.index===item.index&&x.descriptor.sha256===item.descriptor.sha256);assert(saved);}
    s.store.close();
  });
  await test('a later local note and replacement live photo remain intact while the same protected copy is retried',async()=>{
    const f=await fixture(),s=await server(f);await timeout(s.run);const before=await migrationRows(f);
    const state=JSON.parse(f.records.getItem(DRAW+'drawing'));state.shapes[0].memo='Unsent later note';f.records.setItem(DRAW+'drawing',json(state));await f.records.settled();
    const replacement=new Blob(['unsent replacement'],{type:'image/jpeg'});await f.records.writeFile('photo:drawing:photo-0',replacement);
    const journal=await rows(f.factory,'surveyFieldNoteDB',LOG);await timeout(s.run);const after=await migrationRows(f);
    assert.equal(after.sessions.length,1);assert.equal(after.sessions[0].id,before.sessions[0].id);
    assert.equal(JSON.parse(f.records.getItem(DRAW+'drawing')).shapes[0].memo,'Unsent later note');
    assert.deepEqual(await rows(f.factory,'surveyFieldNoteDB',LOG),journal);
    const db=await f.records.openFilesDatabase();try{
      const live=await new Promise((resolve,reject)=>{const q=db.transaction('files','readonly').objectStore('files').get('photo:drawing:photo-0');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      assert.equal(await live.text(),await replacement.text());
    }finally{db.close();s.store.close();}
  });
  await test('auth generation invalidation after a durable batch stops activation and safely resumes the same copy',async()=>{
    const f=await fixture();let active=true,invalidate=true;
    const s=await server(f,{currentScope:()=>active?scope:null,migrationStore:store=>({...store,append:async(...args)=>{
      const result=await store.append(...args);if(invalidate){invalidate=false;active=false;}return result;
    }})});
    await assert.rejects(s.run,error=>error.code==='MIGRATION_SCOPE_CHANGED');assert.equal(s.attempts.length,0);
    const before=await migrationRows(f);assert.equal(before.sessions.length,1);
    active=true;await timeout(s.run);const after=await migrationRows(f);assert.equal(after.sessions.length,1);assert.equal(after.sessions[0].id,before.sessions[0].id);
    await assert.rejects(()=>f.records.deltaJournal.begin({scope:{...scope,ownerId:'foreign-owner'},localProjectId,actor}),error=>error.code==='JOURNAL_SCOPE');s.store.close();
  });
  await test('baseline identity separates copies and a colliding stored manifest is rejected without overwrite',async()=>{
    const f=await fixture(),s=await server(f);await timeout(s.run);const first=await migrationRows(f);
    s.receipt.baselineId='different-baseline';await timeout(s.run);const second=await migrationRows(f);
    assert.equal(second.sessions.length,2);assert.notEqual(s.attempts[0].proof.migrationId,s.attempts[1].proof.migrationId);
    const id=s.attempts[1].proof.migrationId,db=await open(f.factory,'sentlog-delta-migration-v1');
    try{await new Promise((resolve,reject)=>{
      const tx=db.transaction('sessions','readwrite'),store=tx.objectStore('sessions'),key=[json([scope.ownerId,scope.projectId,scope.deviceId]),id],q=store.get(key);
      q.onsuccess=()=>{const row=q.result;row.bundleHash='0'.repeat(64);store.put(row,key);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });}finally{db.close();}
    const before=await migrationRows(f);await assert.rejects(s.run,error=>error.code==='MIGRATION_SOURCE_CHANGED');
    assert.deepEqual(await migrationRows(f),before);assert.equal(s.attempts.length,2);assert(second.sessions.some(x=>x.id===first.sessions[0].id));s.store.close();
  });
  console.log('Migration retry cases passed:',passed);
})().catch(error=>{console.error(error);process.exitCode=1;});

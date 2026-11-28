'use strict';
// The actual maintenance writer, disposable IndexedDB, and exact store/Blob
// fingerprints. No application boot, native-storage substitute, or user data.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {IDBFactory,IDBKeyRange,IDBDatabase,IDBObjectStore,IDBIndex,IDBCursor}=require('fake-indexeddb');
const code=fs.readFileSync(process.env.SENTLOG_RECORD_SOURCE||require.resolve('../sentlog/record-store.js'),'utf8');
const DB='surveyFieldNoteDB',FILES='files',LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const PREFIX='__sentlog_record__:',WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:one';
const META='__sentlog_records_meta_v130__',ARCHIVE='__sentlog_records_archive_v130__',MARKER='sentlogRecordsReadyV130';
const workspace=JSON.stringify({projects:[{id:'project',drawings:[{id:'one'}]}]}),drawing=JSON.stringify({shapes:[]});
const meta={schema:1,revision:0,migratedAt:'2020-01-01T00:00:00.000Z'};
const baseFiles=()=>[[META,meta],[PREFIX+WS,workspace],[PREFIX+DRAW,drawing]];
function recordsFor(factory,local=new Map(),navigator={}){
  const context={console,Blob,File,DOMException,structuredClone,queueMicrotask,setTimeout,clearTimeout,TextDecoder,
    indexedDB:factory,IDBKeyRange,navigator,crypto:crypto.webcrypto,localStorage:{get length(){return local.size;},
      key:index=>[...local.keys()][index]??null,getItem:key=>local.get(key)??null,
      setItem:(key,value)=>local.set(key,String(value)),removeItem:key=>local.delete(key)}};
  context.window=context;vm.createContext(context);vm.runInContext(code,context);return context.SentlogRecords;
}
async function seed(factory,{version=2,files=baseFiles(),journal=[],control=[]}={}){
  const db=await new Promise((resolve,reject)=>{const q=factory.open(DB,version);q.onupgradeneeded=()=>{
    q.result.createObjectStore(FILES);if(version===2)for(const name of [LOG,CONTROL])q.result.createObjectStore(name).createIndex('kind','kind');
  };q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{await new Promise((resolve,reject)=>{const tx=db.transaction([...db.objectStoreNames],'readwrite');
    for(const [name,rows]of [[FILES,files],[LOG,journal],[CONTROL,control]])if(db.objectStoreNames.contains(name))for(const [key,value]of rows)tx.objectStore(name).put(value,key);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
async function normalize(value){
  if(value===undefined)return {undefined:true};
  if(value instanceof Blob)return {blob:true,type:value.type,size:value.size,sha256:crypto.createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex')};
  if(Array.isArray(value))return Promise.all(value.map(normalize));
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await normalize(item)])));
  return value;
}
async function snapshot(factory,local){
  const databases=await factory.databases();if(!databases.length)return {databases,local:[...local]};
  const db=await new Promise((resolve,reject)=>{const q=factory.open(DB);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{const stores=await new Promise((resolve,reject)=>{const tx=db.transaction([...db.objectStoreNames],'readonly'),result=[];
    for(const name of db.objectStoreNames){const store=tx.objectStore(name),row={name,indexes:[...store.indexNames],rows:[]};result.push(row);
      const q=store.openCursor();q.onsuccess=()=>{const item=q.result;if(item){row.rows.push([item.key,item.value]);item.continue();}};
    }tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
  });return {version:db.version,stores:await normalize(stores),local:[...local]};}finally{db.close();}
}
async function observe(run){
  const originals=[],events=[];
  for(const [prototype,methods]of [[IDBFactory.prototype,['open']],[IDBDatabase.prototype,['transaction']],
    [IDBObjectStore.prototype,['get','getAll','getAllKeys','openCursor','put','add','delete','clear']],
    [IDBIndex.prototype,['getAll','openCursor']],[IDBCursor.prototype,['update','delete']],[Blob.prototype,['arrayBuffer','text']]]){
    for(const method of methods){const original=prototype[method];originals.push([prototype,method,original]);prototype[method]=function(...args){
      events.push({type:prototype.constructor.name,method,store:this.name||this.objectStore?.name,args:args.slice(0,2)});return original.apply(this,args);
    };}
  }
  try{return {value:await run(),events};}finally{for(const [prototype,method,original]of originals)prototype[method]=original;}
}
const writes=events=>events.filter(event=>['put','add','delete','clear','update'].includes(event.method)||event.method==='transaction'&&event.args[1]==='readwrite');
const tests=[],test=(name,run)=>tests.push({name,run});
test('maintenance startup reads no history, controls, archive or Blob bytes and preserves legacy/embedded cutoffs',async()=>{
  const factory=new IDBFactory(),local=new Map([[MARKER,'1'],[WS,'{unreadable older local copy'],['setting','preserve']]);
  const original=new Blob([new Uint8Array(128*1024).fill(27)],{type:'image/jpeg'});
  await seed(factory,{files:[...baseFiles(),[ARCHIVE,{entries:[[WS,'unique original workspace']]}],['photo:one:original',original]],
    control:[['binding:legacy',{kind:'binding',id:'legacy',cutoff:{files:[{key:'photo:one:original',value:original}],snapshot:{unique:'retained'}}}],
      ['cutoff-file:old',{kind:'cutoff-file',value:original}],['clock',99]],
    journal:[[99,{kind:'sentlog-app-intent',seq:99,files:[{before:original,after:null}],changes:[{unique:'unsent history'}]}]]});
  const records=recordsFor(factory,local),before=await snapshot(factory,local);
  const observed=await observe(()=>records.initForMaintenance());
  assert.equal(observed.value,true);assert.equal(records.ready,true);assert.equal(records.pending,false);records.assertSafe();
  assert.equal(records.maintenanceInitVersion,1);assert.deepEqual(writes(observed.events),[]);
  assert(!observed.events.some(event=>event.type==='Blob'||event.method==='getAll'||event.method==='getAllKeys'));
  assert(!observed.events.some(event=>[LOG,CONTROL].includes(event.store)));
  assert(!observed.events.some(event=>event.method==='get'&&event.args[0]===ARCHIVE));
  assert.deepEqual(await snapshot(factory,local),before);assert.throws(()=>records.getItem(DRAW),error=>error.code==='RECORD_MAINTENANCE_ONLY');
});
test('missing database is never created by maintenance and all local entries remain intact',async()=>{
  const factory=new IDBFactory(),local=new Map([[WS,workspace],[MARKER,'1']]),records=recordsFor(factory,local),before=await snapshot(factory,local);
  await assert.rejects(records.initForMaintenance(),error=>error.code==='RECORD_MAINTENANCE_DATABASE');
  assert.equal(records.ready,false);assert.deepEqual(await snapshot(factory,local),before);
});
test('version-one storage is rejected without adding stores, upgrading or altering original files',async()=>{
  const factory=new IDBFactory(),local=new Map([[WS,workspace]]);await seed(factory,{version:1,files:[['background',new Blob(['original PDF'])]]});
  const records=recordsFor(factory,local),before=await snapshot(factory,local);
  await assert.rejects(records.initForMaintenance(),error=>error.code==='RECORD_MAINTENANCE_DATABASE');assert.deepEqual(await snapshot(factory,local),before);
});
test('invalid existing metadata/workspace/record text fails closed without deleting legacy records',async()=>{
  for(const files of [baseFiles().filter(([key])=>key!==META),baseFiles().filter(([key])=>key!==PREFIX+WS),
    [[META,null],[PREFIX+WS,workspace],[PREFIX+DRAW,drawing]],[[META,meta],[PREFIX+WS,'{"projects":{}}'],[PREFIX+DRAW,drawing]],
    [[META,meta],[PREFIX+WS,workspace],[PREFIX+DRAW,'{unreadable']]]){
    const factory=new IDBFactory(),local=new Map([[WS,workspace],[DRAW,drawing]]);await seed(factory,{files});
    const records=recordsFor(factory,local),before=await snapshot(factory,local);
    await assert.rejects(records.initForMaintenance());assert.equal(records.ready,false);assert.deepEqual(await snapshot(factory,local),before);
  }
});
test('busy editor lock prevents any database open and permits a safe same-page retry after release',async()=>{
  const factory=new IDBFactory(),local=new Map();await seed(factory);let available=false,requests=0;
  const navigator={locks:{request:(_name,options,callback)=>{assert.equal(options.ifAvailable,true);requests++;return Promise.resolve().then(()=>callback(available?{}:null));}}};
  const records=recordsFor(factory,local,navigator),before=await snapshot(factory,local);
  const first=await observe(async()=>{await assert.rejects(records.initForMaintenance(),/入力途中の記録がなければ/);});
  assert(!first.events.some(event=>event.method==='open'));assert.equal(requests,1);assert.equal(records.ready,false);
  available=true;assert.equal(await records.initForMaintenance(),true);assert.equal(requests,2);assert.deepEqual(await snapshot(factory,local),before);
});
test('retry after a transient read failure retains the acquired editor lock and never rewrites storage',async()=>{
  const factory=new IDBFactory(),local=new Map();await seed(factory);let requests=0;
  const records=recordsFor(factory,local,{locks:{request:(_name,_options,callback)=>{requests++;return Promise.resolve().then(()=>callback({}));}}});
  const original=IDBObjectStore.prototype.get;let fail=true;
  IDBObjectStore.prototype.get=function(key){if(fail&&key===META){fail=false;throw Error('synthetic read failure');}return original.call(this,key);};
  try{await assert.rejects(records.initForMaintenance(),/synthetic read failure/);}finally{IDBObjectStore.prototype.get=original;}
  assert.equal(records.ready,false);assert.equal(await records.initForMaintenance(),true);assert.equal(requests,1);
});
test('maintenance mode blocks ordinary edits, file changes, projection, activation, replay and normal boot',async()=>{
  const factory=new IDBFactory(),local=new Map();await seed(factory);const records=recordsFor(factory,local);await records.initForMaintenance();
  const before=await snapshot(factory,local),scope={ownerId:'owner',projectId:'shared',deviceId:'device'};
  const operations=[()=>records.init(),()=>records.setItem(DRAW,'{}'),()=>records.removeItem(DRAW),()=>records.batch([[DRAW,'{}']]),
    ()=>records.writeFile('background:one',new Blob(['replace'])),()=>records.removeFiles(['background:one']),()=>records.clearFiles(),
    ()=>records.replaceAll([],[]),()=>records.retry(),()=>records.flush(),()=>records.openFilesDatabase(),
    ()=>records.deltaJournal.activate({scope,localProjectId:'project',baselineId:'baseline'}),
    ()=>records.deltaJournal.claim({scope,localProjectId:'project'}),()=>records.deltaJournal.applyProjection({scope,localProjectId:'project',writes:[],expectedRecords:[],validate:()=>true}),
    ()=>records.deltaJournal.acknowledge({scope}),()=>records.deltaJournal.verifyReplay({scope})];
  const observed=await observe(async()=>{for(const operation of operations)await assert.rejects(Promise.resolve().then(operation),error=>error.code==='RECORD_MAINTENANCE_ONLY');});
  assert.deepEqual(writes(observed.events),[]);assert.deepEqual(await snapshot(factory,local),before);
});
test('normal initialized editor cannot switch into maintenance-only mode',async()=>{
  const factory=new IDBFactory(),local=new Map();await seed(factory);const records=recordsFor(factory,local);await records.init();
  const before=await snapshot(factory,local);await assert.rejects(records.initForMaintenance(),error=>error.code==='RECORD_MAINTENANCE_ONLY');
  assert.equal(records.getItem(DRAW),drawing);assert.deepEqual(await snapshot(factory,local),before);
});
test('explicit maintenance trims proven redundant text while preserving the complete unacknowledged intent and all originals',async()=>{
  const factory=new IDBFactory(),local=new Map([[WS,'unique older local workspace']]);
  const row={version:1,kind:'sentlog-app-intent',id:'wal:one',seq:1,at:1,sourceRevision:0,mutationKind:'batch',
    projectIds:['project'],drawingIds:['one'],changes:[{key:DRAW,before:drawing,after:'{"shapes":[],"memo":"unsent"}'}],
    contexts:[{origin:'local',operation:'edit'}],files:[],workspaceBefore:workspace,workspaceAfter:workspace};
  const original=new Blob(['unique original photo'],{type:'image/jpeg'});
  await seed(factory,{files:[...baseFiles(),['photo:one:original',original]],journal:[[1,row]],control:[['clock',1]]});
  const records=recordsFor(factory,local);await records.initForMaintenance();const before=await snapshot(factory,local);
  const preview=await records.deltaJournal.compactRedundantRecords({dryRun:true});assert.equal(preview.eligible,1);assert.deepEqual(await snapshot(factory,local),before);
  const result=await records.deltaJournal.compactRedundantRecords({dryRun:false});assert.equal(result.updated,1);
  const after=await snapshot(factory,local),oldLog=before.stores.find(store=>store.name===LOG),newLog=after.stores.find(store=>store.name===LOG);
  delete oldLog.rows[0][1].workspaceBefore;delete oldLog.rows[0][1].workspaceAfter;assert.deepEqual(newLog,oldLog);assert.deepEqual(after,before);
  assert.equal((await records.deltaJournal.compactRedundantFiles({dryRun:false})).updated,0);
  assert.equal((await records.deltaJournal.compactRedundantPageBackups({dryRun:false})).updated,0);
});
test('a newer durable revision after maintenance startup aborts cleanup without touching any row',async()=>{
  const factory=new IDBFactory(),local=new Map();await seed(factory);const records=recordsFor(factory,local);await records.initForMaintenance();
  const db=await new Promise(resolve=>{const q=factory.open(DB);q.onsuccess=()=>resolve(q.result);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(FILES,'readwrite');tx.objectStore(FILES).put({...meta,revision:1},META);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  const before=await snapshot(factory,local);await assert.rejects(records.deltaJournal.compactRedundantRecords({dryRun:false}),error=>error.code==='JOURNAL_STALE');
  assert.deepEqual(await snapshot(factory,local),before);
});
(async()=>{for(const {name,run}of tests){await run();console.log('PASS',name);}console.log(tests.length+' maintenance-only initialization tests passed');})().catch(error=>{console.error(error);process.exitCode=1;});

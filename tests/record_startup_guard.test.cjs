'use strict';
// Synthetic IndexedDB/VM only. Rejected startup must preserve every value,
// Blob byte, schema entry and localStorage key, including undefined values.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {IDBFactory,IDBKeyRange,IDBDatabase,IDBObjectStore}=require('fake-indexeddb');
const code=fs.readFileSync(require.resolve('../sentlog/record-store.js'),'utf8');
const DB='surveyFieldNoteDB',FILES='files',LOG='sentlog_delta_journal_v1',CONTROL='sentlog_delta_control_v1';
const PREFIX='__sentlog_record__:',WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:synthetic-drawing';
const META='__sentlog_records_meta_v130__',ARCHIVE='__sentlog_records_archive_v130__',MARKER='sentlogRecordsReadyV130';
const meta={schema:1,revision:0,migratedAt:'2020-01-01T00:00:00.000Z',legacyCount:0};
const workspace=JSON.stringify({projects:[{id:'synthetic-project',name:'Current synthetic project',drawings:[{id:'synthetic-drawing'}]}]});
const drawing=JSON.stringify({shapes:[{id:'synthetic-record',memo:'Current synthetic memo',photos:[]}]});
const oldWorkspace=workspace.replace('Current','Older'),oldDrawing=drawing.replace('Current','Older');
const legacy=[[WS,oldWorkspace],[DRAW,oldDrawing]];
const archive={migratedAt:meta.migratedAt,entries:legacy};
const attachments=[['background',new Blob(['legacy background'],{type:'application/pdf'})],
  ['background:synthetic-drawing',new Blob(['synthetic drawing'],{type:'application/pdf'})],
  ['photo:synthetic-drawing:synthetic-photo',new Blob(['synthetic photo bytes'],{type:'image/jpeg'})]];
const tests=[];const test=(name,run)=>tests.push({name,run});
async function seed(factory,{files=[],journal=[],control=[],version=2}={}){
  const db=await new Promise((resolve,reject)=>{const q=factory.open(DB,version);q.onupgradeneeded=()=>{
    q.result.createObjectStore(FILES);
    if(version===2)for(const name of [LOG,CONTROL])q.result.createObjectStore(name).createIndex('kind','kind');
  };q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{await new Promise((resolve,reject)=>{const tx=db.transaction([...db.objectStoreNames],'readwrite');
    for(const [name,rows]of [[FILES,files],[LOG,journal],[CONTROL,control]])if(db.objectStoreNames.contains(name))
      for(const [key,value]of rows)tx.objectStore(name).put(value,key);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
async function fixture(options={}){
  const factory=new IDBFactory(),local=new Map(options.local||[['synthetic-unmanaged','keep this setting']]);
  if(!options.absent)await seed(factory,options);
  return {factory,local,records:recordsFor(factory,local)};
}
function recordsFor(factory,local){
  const context={console,Blob,File,DOMException,structuredClone,queueMicrotask,setTimeout,clearTimeout,
    indexedDB:factory,IDBKeyRange,navigator:{},crypto:crypto.webcrypto,
    localStorage:{get length(){return local.size;},key:i=>[...local.keys()][i]??null,
      getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,String(value)),removeItem:key=>local.delete(key)}};
  context.window=context;vm.createContext(context);vm.runInContext(code,context);
  return context.SentlogRecords;
}
async function pack(value){
  if(value===undefined)return ['undefined'];if(value===null)return ['null'];
  if(value instanceof Blob)return ['blob',value.type,value.size,crypto.createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex')];
  if(Array.isArray(value))return ['array',await Promise.all(value.map(pack))];
  if(typeof value==='object')return ['object',await Promise.all(Object.entries(value).map(async([key,item])=>[key,await pack(item)]))];
  return [typeof value,value];
}
async function snapshot(f){
  const local=[...f.local],listed=await f.factory.databases();if(!listed.length)return {database:null,local};
  const db=await new Promise((resolve,reject)=>{const q=f.factory.open(DB);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  try{
    const result=await new Promise((resolve,reject)=>{const tx=db.transaction([...db.objectStoreNames],'readonly'),stores=[];
      for(const name of db.objectStoreNames){const s=tx.objectStore(name),row={name,keyPath:s.keyPath,autoIncrement:s.autoIncrement,
        indexes:[...s.indexNames].map(key=>{const index=s.index(key);return {name:key,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};}),keys:null,values:null};stores.push(row);
        s.getAllKeys().onsuccess=e=>row.keys=e.target.result;s.getAll().onsuccess=e=>row.values=e.target.result;
      }tx.oncomplete=()=>resolve({version:db.version,stores});tx.onabort=()=>reject(tx.error);
    });
    for(const row of result.stores){row.rows=await Promise.all(row.keys.map(async(key,i)=>[await pack(key),await pack(row.values[i])]));delete row.keys;delete row.values;}
    return {database:result,local};
  }finally{db.close();}
}
async function rejectionUnchanged(options,match=/起動を停止/){
  const f=await fixture(options),before=await snapshot(f);
  await assert.rejects(f.records.init(),match);assert.equal(f.records.ready,false);
  assert.deepEqual(await snapshot(f),before,'startup rejection must retain all stores, schema, Blob hashes and localStorage');
  return f;
}

test('existing META with missing WS cannot become a ready empty workspace',async()=>{
  await rejectionUnchanged({files:[[META,meta],[PREFIX+DRAW,drawing],[ARCHIVE,archive],...attachments],
    journal:[[1,{kind:'sentlog-file-retention',files:[]}]],control:[['clock',1]],local:[[MARKER,'1'],...legacy]});
});
for(const [label,value]of [['stored null',null],['stored undefined',undefined],['JSON null','null'],['JSON array','[]'],
  ['object without projects','{}'],['non-array projects','{"projects":{}}'],['malformed JSON','{broken']])
test('existing META rejects WS '+label+' before cleaning archived legacy copies',async()=>{
  await rejectionUnchanged({files:[[META,meta],[PREFIX+WS,value],[PREFIX+DRAW,drawing],[ARCHIVE,archive],...attachments],
    journal:[[1,{kind:'sentlog-file-retention',files:[]}]],control:[['clock',1]],local:[[MARKER,'1'],...legacy]});
});
for(const [label,value]of [['null',null],['undefined',undefined],['false',false]])
test('a present '+label+' META is corruption, not permission to initialize',async()=>{
  await rejectionUnchanged({files:[[META,value],[PREFIX+WS,workspace],[PREFIX+DRAW,drawing],...attachments],local:legacy});
});

for(const item of [
  {name:'workspace',files:[[PREFIX+WS,workspace]]},
  {name:'drawing record',files:[[PREFIX+DRAW,drawing]]},
  {name:'undefined managed record',files:[[PREFIX+DRAW,undefined]]},
  {name:'archive object',files:[[ARCHIVE,archive]]},
  {name:'null archive',files:[[ARCHIVE,null]]},
  {name:'undefined archive',files:[[ARCHIVE,undefined]]},
  {name:'journal row',journal:[[1,{kind:'sentlog-file-retention',files:[]}]]},
  {name:'zero-valued control row',control:[['clock',0]]}
])test('missing META with residual '+item.name+' rejects even without a local marker',async()=>{
  await rejectionUnchanged({...item,files:[...(item.files||[]),...attachments]});
});
test('legacy records and marker cannot overwrite newer durable records when META is missing',async()=>{
  await rejectionUnchanged({files:[[PREFIX+WS,workspace],[PREFIX+DRAW,drawing],[ARCHIVE,archive],...attachments],
    journal:[[1,{kind:'sentlog-file-retention',files:[]}]],control:[['clock',1]],local:[[MARKER,'1'],...legacy]});
});
test('the existing marker-without-legacy stop remains intact',async()=>{
  await rejectionUnchanged({files:[[PREFIX+WS,workspace],...attachments],local:[[MARKER,'1']]},/以前の端末内データを確認できません/);
});
test('a prior completion marker forbids re-migration of old local records into an otherwise empty DB',async()=>{
  await rejectionUnchanged({files:attachments,local:[[MARKER,'1'],...legacy]},/以前の端末内データを確認できません/);
});

const races=[
  {name:'completed migration from another initializer',reloadable:true,rows:[[FILES,META,meta],[FILES,PREFIX+WS,oldWorkspace],
    [FILES,PREFIX+DRAW,oldDrawing],[FILES,ARCHIVE,archive]]},
  {name:'undefined META key',rows:[[FILES,META,undefined]]},
  {name:'workspace',rows:[[FILES,PREFIX+WS,workspace]]},
  {name:'undefined drawing record',rows:[[FILES,PREFIX+DRAW,undefined]]},
  {name:'undefined archive',rows:[[FILES,ARCHIVE,undefined]]},
  {name:'journal row',rows:[[LOG,1,{kind:'sentlog-file-retention',files:[]}]]},
  {name:'control row',rows:[[CONTROL,'clock',0]]}
];
for(const race of races)test('migration transaction rechecks '+race.name+' queued after the readonly snapshot',async()=>{
  const initial={files:attachments,local:legacy},f=await fixture(initial),transaction=IDBDatabase.prototype.transaction,put=IDBObjectStore.prototype.put;
  let inserted=false,migrationAborted=false,applicationPuts=0,raceDone;
  IDBObjectStore.prototype.put=function(){applicationPuts++;return put.apply(this,arguments);};
  IDBDatabase.prototype.transaction=function(names,mode,...rest){
    if(!inserted&&this.name===DB&&mode==='readwrite'){
      inserted=true;
      const earlier=transaction.call(this,[FILES,LOG,CONTROL],'readwrite');
      raceDone=new Promise((resolve,reject)=>{earlier.oncomplete=resolve;earlier.onabort=()=>reject(earlier.error);});
      for(const [store,key,value]of race.rows)put.call(earlier.objectStore(store),value,key);
      // This request is queued after the competing write. Reads issued inside
      // the migration transaction must observe it before permitting any put.
      const migration=transaction.call(this,names,mode,...rest);migration.addEventListener('abort',()=>migrationAborted=true);return migration;
    }
    return transaction.call(this,names,mode,...rest);
  };
  try{await assert.rejects(f.records.init(),/起動を停止/);await raceDone;}
  finally{IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.put=put;}
  assert(inserted);assert(migrationAborted);assert.equal(applicationPuts,0);assert.equal(f.records.ready,false);
  const expected={...initial,files:[...attachments],journal:[],control:[]};
  for(const [store,key,value]of race.rows)expected[store===FILES?'files':store===LOG?'journal':'control'].push([key,value]);
  const after=await snapshot(f);
  assert.deepEqual(after,await snapshot(await fixture(expected)),'only the competing transaction may change stored data');
  if(race.reloadable){
    const stopped=f.records.init();assert.equal(f.records.init(),stopped);
    await assert.rejects(stopped,/起動を停止/);
    assert.deepEqual(await snapshot(f),after,'same-page init keeps its rejected boot promise and makes no changes');
    const reloaded=recordsFor(f.factory,f.local);await reloaded.init();
    assert.equal(reloaded.ready,true);assert.equal(reloaded.getItem(WS),oldWorkspace);assert.equal(reloaded.getItem(DRAW),oldDrawing);
    assert(!f.local.has(WS));assert(!f.local.has(DRAW));assert.equal(f.local.get(MARKER),'1');
    assert.deepEqual((await snapshot(f)).database,after.database,'a fresh page accepts the completed winner without rewriting stored records or Blobs');
  }
});

test('a genuine first start still creates its empty workspace and advertises the protection capability',async()=>{
  const f=await fixture({absent:true});assert.equal(f.records.startupProtectionVersion,1);
  await f.records.init();assert.equal(f.records.ready,true);assert.equal(f.records.failed,false);
  assert.equal(f.records.getItem(WS),'{"projects":[]}');assert.equal(f.local.get(MARKER),'1');
  const saved=await snapshot(f);assert.equal(saved.database.version,2);assert.equal(saved.database.stores.length,3);
});
test('valid existing META accepts an empty workspace with retained orphan records without extra validation',async()=>{
  const f=await fixture({files:[[META,meta],[PREFIX+WS,'{"projects":[]}'],[PREFIX+DRAW,drawing],[ARCHIVE,archive],...attachments],
    journal:[[1,{kind:'sentlog-file-retention',files:[]}]],control:[['clock',1]],local:[[MARKER,'1']]});
  const before=await snapshot(f);await f.records.init();assert.equal(f.records.ready,true);assert.deepEqual(await snapshot(f),before);
});
test('valid existing META still removes exact archived localStorage copies after validation',async()=>{
  const f=await fixture({files:[[META,meta],[PREFIX+WS,workspace],[PREFIX+DRAW,drawing],[ARCHIVE,archive],...attachments],local:[[MARKER,'1'],...legacy,['synthetic-unmanaged','retained']]});
  const before=await snapshot(f);await f.records.init();assert.equal(f.records.getItem(WS),workspace);assert.equal(f.records.getItem(DRAW),drawing);
  assert(!f.local.has(WS));assert(!f.local.has(DRAW));assert.equal(f.local.get('synthetic-unmanaged'),'retained');
  assert.deepEqual((await snapshot(f)).database,before.database);
});
test('pre-v130 workspace migration preserves background/photo Blobs and copies legacy records exactly',async()=>{
  const f=await fixture({version:1,files:attachments,local:[...legacy,['sentlogCloudProjectSyncV2:synthetic-project','{"revision":2}'],['synthetic-unmanaged','retained']]}),before=await snapshot(f);
  await f.records.init();assert.equal(f.records.ready,true);assert.equal(f.records.getItem(WS),oldWorkspace);assert.equal(f.records.getItem(DRAW),oldDrawing);
  assert.equal(f.records.getItem('sentlogCloudProjectSyncV2:synthetic-project'),'{"revision":2}');
  assert.deepEqual([...f.local],[['synthetic-unmanaged','retained'],[MARKER,'1']]);
  const after=await snapshot(f);assert.equal(after.database.version,2);assert.equal(after.database.stores.length,3);
  const rows=after.database.stores.find(row=>row.name===FILES).rows;
  for(const row of before.database.stores[0].rows)assert(rows.some(candidate=>JSON.stringify(candidate)===JSON.stringify(row)),'every original Blob and key must survive migration');
  for(const name of [LOG,CONTROL])assert.equal(after.database.stores.find(row=>row.name===name).rows.length,0);
});
test('pre-v130 single-drawing records and legacy background remain supported',async()=>{
  const raw=JSON.stringify({fileName:'synthetic.pdf',shapes:[{memo:'legacy synthetic memo'}]}),f=await fixture({version:1,files:attachments,local:[['surveyFieldNoteV2',raw]]});
  const before=await snapshot(f);await f.records.init();assert.equal(f.records.getItem('surveyFieldNoteV2'),raw);assert.equal(f.records.getItem(WS),'{"projects":[]}');
  const rows=(await snapshot(f)).database.stores.find(row=>row.name===FILES).rows;
  for(const row of before.database.stores[0].rows)assert(rows.some(candidate=>JSON.stringify(candidate)===JSON.stringify(row)));
});

(async()=>{for(const {name,run}of tests){await run();console.log('PASS '+name);}console.log(tests.length+' startup guard tests passed');})().catch(error=>{console.error(error);process.exitCode=1;});

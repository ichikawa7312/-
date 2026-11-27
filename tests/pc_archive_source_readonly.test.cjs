'use strict';
// Actual archive module and existing PC fixture; disposable FakeIndexedDB,
// synthetic filesystem/transport. This is not native browser evidence.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module'),{IDBFactory}=require('fake-indexeddb');
const fixturePath=path.join(__dirname,'pc.test.cjs'),fixtureText=fs.readFileSync(fixturePath,'utf8'),boundary='const pcHtml=';
assert.equal(fixtureText.split(boundary).length-1,1);
const {fixture,Dir,C}=new Function('require','__dirname',fixtureText.split(boundary)[0]+'\nreturn {fixture,Dir,C};')(createRequire(fixturePath),__dirname);
const DB='surveyFieldNoteDB',original=()=>new Blob(['original exact PDF bytes'],{type:'application/pdf'});
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Synthetic transaction aborted'));});
async function open(factory,version,upgrade){
  return new Promise((resolve,reject)=>{const q=version===undefined?factory.open(DB):factory.open(DB,version);
    q.onupgradeneeded=()=>{if(upgrade)upgrade(q.result);else q.transaction.abort();};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
}
async function seed(factory,{version=2,hasFiles=true,blob=original()}={}){
  const db=await open(factory,version,db=>{if(hasFiles)db.createObjectStore('files');db.createObjectStore('sentinel');});
  try{const tx=db.transaction([...db.objectStoreNames],'readwrite'),done=complete(tx);
    if(hasFiles)tx.objectStore('files').put(blob,'background:d');
    tx.objectStore('sentinel').put({records:['synthetic preserved record'],revision:7},'keep');await done;
  }finally{db.close();}
}
async function snapshot(factory){
  const db=await open(factory);try{
    const stores=[...db.objectStoreNames],tx=db.transaction(stores,'readonly'),done=complete(tx),requests={};
    for(const name of stores)requests[name]=[tx.objectStore(name).getAllKeys(),tx.objectStore(name).getAll()];
    await done;const rows={};
    for(const name of stores){const [keys,values]=requests[name];rows[name]=await Promise.all(values.result.map(async(value,i)=>({key:keys.result[i],value:value instanceof Blob?{bytes:value.size,sha256:await C.hash(value),type:value.type}:value})));}
    return {version:db.version,stores,rows};
  }finally{db.close();}
}
async function setup({factory=new IDBFactory(),cloud=false}={}){
  const f=await fixture({missing:true}),fetches=[];f.context.indexedDB=factory;
  Object.assign(f.job.manifest[0],{status:cloud?'uploaded':'storage_deleted',storage_path:'synthetic-owner/synthetic.pdf'});
  f.context.fetch=async(url,options)=>{fetches.push({url,options});assert(cloud,'storage_deleted must never fetch Storage');
    assert.equal(url,'https://example.invalid/storage/v1/object/authenticated/test/synthetic-owner/synthetic.pdf');
    assert.equal(options.cache,'no-store');return {ok:true,blob:async()=>original()};};
  return {...f,factory,fetches};
}
function failed(f){assert.equal(f.calls.filter(x=>x.p_action==='pc_complete').length,0);assert.equal(f.calls.filter(x=>x.p_action==='pc_error').length,1);}
async function saved(f){
  const completeCalls=f.calls.filter(x=>x.p_action==='pc_complete');assert.equal(completeCalls.length,1);assert.equal(f.calls.filter(x=>x.p_action==='pc_error').length,0);
  const generation=f.root.dirs.get('復旧用').dirs.get(f.job.project_id).dirs.get(f.job.id),blob=await generation.dirs.get('files').files.get('asset-test').getFile();
  assert.equal(await C.hash(blob),f.job.manifest[0].sha256);
  assert.equal(await C.hash(await generation.files.get('manifest.sentlog.json').getFile()),completeCalls[0].p_data.package_sha256);
}
const cases=[],test=(name,fn)=>cases.push([name,fn]);
for(const cloud of [false,true])test('an absent database stays absent; cloud fallback '+cloud,async()=>{
  const f=await setup({cloud});assert.deepEqual(await f.factory.databases(),[]);await f.run();
  assert.deepEqual(await f.factory.databases(),[],'A source lookup must not create an empty v1 database');
  assert.equal(f.fetches.length,cloud?1:0);if(cloud)await saved(f);else failed(f);
});
for(const version of [1,2])test('existing v'+version+' source is read without changing bytes, rows or schema',async()=>{
  const factory=new IDBFactory();await seed(factory,{version});const before=await snapshot(factory),f=await setup({factory});
  await f.run();await saved(f);assert.equal(f.fetches.length,0);assert.deepEqual(await snapshot(factory),before);
});
test('an existing database without files is left unchanged and deleted cloud is not requested',async()=>{
  const factory=new IDBFactory();await seed(factory,{hasFiles:false});const before=await snapshot(factory),f=await setup({factory});
  await f.run();failed(f);assert.equal(f.fetches.length,0);assert.deepEqual(await snapshot(factory),before);
});
test('an unequal local source remains untouched while verified Storage bytes are used',async()=>{
  const factory=new IDBFactory();await seed(factory,{blob:new Blob(['synthetic different local PDF'])});const before=await snapshot(factory),f=await setup({factory,cloud:true});
  await f.run();await saved(f);assert.equal(f.fetches.length,1);assert.deepEqual(await snapshot(factory),before);
});
for(const mode of ['throw','error'])test('database open '+mode+' retains permitted cloud fallback',async()=>{
  const factory={open(){const error=Object.assign(Error('Synthetic read failure'),{name:'UnknownError'});if(mode==='throw')throw error;
    const q={error};queueMicrotask(()=>q.onerror());return q;}};
  const f=await setup({factory,cloud:true});await f.run();await saved(f);assert.equal(f.fetches.length,1);
});
test('a blocked lookup closes a late success without reading rows or duplicating cloud work',async()=>{
  let closed=0,reads=0;const db={close(){closed++;},get objectStoreNames(){reads++;return {contains:()=>false};}};
  const factory={open(){const q={result:db};queueMicrotask(()=>{q.onblocked?.();queueMicrotask(()=>q.onsuccess());});return q;}};
  const f=await setup({factory,cloud:true});await f.run();await saved(f);
  assert.equal(reads,0,'A blocked lookup must not use a late connection');assert.equal(closed,1);assert.equal(f.fetches.length,1);
});
test('changing the selected root during open closes the connection and stops fallback and completion',async()=>{
  const factory=new IDBFactory();await seed(factory);const before=await snapshot(factory),f=await setup({factory,cloud:true}),nextRoot=new Dir('synthetic changed root');
  let closed=0;
  f.context.indexedDB={open(...args){const q=factory.open(...args);q.addEventListener('success',()=>{
    const db=q.result,close=db.close.bind(db);db.close=()=>{closed++;close();};f.context.rootHandle=nextRoot;
  });return q;}};
  await f.run();failed(f);assert.equal(closed,1);assert.equal(f.fetches.length,0);assert.equal(nextRoot.dirs.size,0);assert.equal(nextRoot.files.size,0);
  assert.deepEqual(await snapshot(factory),before);
});
(async()=>{let passed=0,failed=0;for(const [name,fn]of cases){try{await fn();passed++;console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+': '+error.message);}}
  console.log(JSON.stringify({passed,failed,total:cases.length,actualArchiveModule:true,fakeIndexedDB:true,nativeBrowserExecuted:false}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

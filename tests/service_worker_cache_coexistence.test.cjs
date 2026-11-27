'use strict';
// Execute both real activation handlers against synthetic CacheStorage only.
// No browser, connected profile, IndexedDB or production cache is opened.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const origin='https://example.invalid';
const workers=[
  {name:'schedule',file:'sw.js',scope:origin+'/',prefix:'shinwa-yotei-v'},
  {name:'Sentlog',file:'sentlog/sw.js',scope:origin+'/sentlog/',prefix:'sentlog-pwa-v'}
].map(worker=>{
  const code=fs.readFileSync(worker.file,'utf8');
  const cache=code.match(/\bconst CACHE=['"]([^'"]+)['"]/u)?.[1];
  assert.ok(cache?.startsWith(worker.prefix),'The worker must declare its current cache');
  const old=[worker.prefix+'0',worker.prefix+'1'];
  assert.ok(!old.includes(cache),'Synthetic old generations must differ from the current cache');
  return {...worker,code,cache,old};
});
const unrelated=['other-app-cache-v1','shinwa-yotei-vault-v1',workers[0].cache+'-backup',
  'sentlog-pwa-backup-v1','not-sentlog-pwa-v1'];
const initialNames=workers.flatMap(worker=>[worker.cache,...worker.old]).concat(unrelated);

function storageFixture({holdDeletes=false}={}){
  const initial=new Map(initialNames.map(name=>[name,Object.freeze({body:'synthetic content for '+name})]));
  const entries=new Map(initial),calls={deleted:[],claimed:[],events:[]},pending=[];
  const caches={
    async keys(){return [...entries.keys()];},
    async delete(name){
      calls.deleted.push(name);calls.events.push('delete-start:'+name);
      if(holdDeletes)await new Promise(resolve=>pending.push({name,resolve}));
      const deleted=entries.delete(name);calls.events.push('delete-complete:'+name);return deleted;
    }
  };
  return {initial,entries,caches,calls,pending,releaseAll(){for(const item of pending)item.resolve();}};
}

function loadWorker(worker,storage){
  const handlers={};
  const context={URL,location:{origin},caches:storage.caches,
    self:{registration:{scope:worker.scope},addEventListener:(type,handler)=>{handlers[type]=handler;},
      clients:{async claim(){storage.calls.claimed.push(worker.name);storage.calls.events.push('claim:'+worker.name);}}}};
  vm.runInNewContext(worker.code,context,{filename:worker.file});
  assert.equal(typeof handlers.activate,'function','The real activation handler must be registered');
  return ()=>{
    let work;
    handlers.activate({waitUntil(promise){assert.equal(work,undefined);work=promise;}});
    assert.equal(typeof work?.then,'function','Activation must keep its cleanup alive');
    return work;
  };
}

function assertPreserved(storage,names){
  for(const name of names){
    assert.ok(storage.entries.has(name),'Foreign or current cache must survive activation: '+name);
    assert.equal(storage.entries.get(name),storage.initial.get(name),'Preserved cache contents must not be replaced: '+name);
  }
}
function assertCleanup(storage,old){
  const keep=initialNames.filter(name=>!old.includes(name));
  assertPreserved(storage,keep);
  for(const name of old)assert.equal(storage.entries.has(name),false,'The worker must remove its own old cache: '+name);
  assert.deepEqual([...storage.calls.deleted].sort(),[...old].sort(),'Only the selected worker old caches may be deleted');
  assert.deepEqual([...storage.entries.keys()].sort(),[...keep].sort());
}
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const cases=[];
function test(name,run){cases.push([name,run]);}

for(const worker of workers){
  test(worker.name+' activation removes its old caches and preserves current, peer and unrelated caches',async()=>{
    const storage=storageFixture();await loadWorker(worker,storage)();
    assertCleanup(storage,worker.old);
    assert.deepEqual(storage.calls.claimed,[worker.name]);
    assert.equal(storage.calls.events.at(-1),'claim:'+worker.name);
  });
  test(worker.name+' waits for every old cache deletion before claiming clients',async()=>{
    const storage=storageFixture({holdDeletes:true}),work=loadWorker(worker,storage)();
    try{
      await nextTurn();
      assert.deepEqual(storage.calls.claimed,[],'Clients must not be claimed while deletes are pending');
      assert.deepEqual(storage.calls.deleted,[...worker.old]);
      assert.equal(storage.pending.length,2);
      storage.pending[0].resolve();await nextTurn();
      assert.deepEqual(storage.calls.claimed,[],'One remaining delete must still prevent client claim');
      storage.pending[1].resolve();await work;
      assertCleanup(storage,worker.old);
      assert.deepEqual(storage.calls.claimed,[worker.name]);
      assert.equal(storage.calls.events.at(-1),'claim:'+worker.name);
    }finally{storage.releaseAll();await work;}
  });
}

for(const order of [workers,[...workers].reverse()]){
  test(order.map(worker=>worker.name).join(' then ')+' activation retains both applications and unrelated caches',async()=>{
    const storage=storageFixture();
    for(const worker of order)await loadWorker(worker,storage)();
    assertCleanup(storage,workers.flatMap(worker=>worker.old));
    assert.deepEqual(storage.calls.claimed,order.map(worker=>worker.name));
  });
}

(async()=>{
  let failures=0;
  for(const [name,run]of cases){
    try{await run();console.log('PASS '+name);}
    catch(error){failures++;console.error('FAIL '+name+'\n'+error.stack);}
  }
  console.log((cases.length-failures)+' passed, '+failures+' failed; '+cases.length+' service worker cache coexistence cases');
  if(failures)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

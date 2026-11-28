'use strict';
// Foreground photo registration must not wait on an unrelated background file
// transfer. Run the real photo service and adapter with disposable in-memory
// records/files; no live account, storage, network or release is touched.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');

const fixturePath=path.join(__dirname,'collaboration_photos.test.cjs');
const source=fs.readFileSync(fixturePath,'utf8');
const marker='\nlet passed=0;';
assert(source.includes(marker),'Existing photo fixture entry changed');
const prefix=source.split(marker)[0];
const tools=new Function('require','__dirname',prefix+'\nreturn {fixture,file,tick};')
  (createRequire(fixturePath),__dirname);
const {fixture,file,tick}=tools;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,limit=1500){
  const until=Date.now()+limit;
  while(!check()){
    if(Date.now()>until)throw Error('Capture did not reach its expected stage');
    await delay(10);
  }
}
async function testNoUnrelatedWait(){
  const f=fixture();await tick();
  const store=f.context.SentlogRecords;
  let flushCalls=0,settledCalls=0;
  store.flush=async()=>{flushCalls++;};
  const originalSettled=store.settled.bind(store);
  store.settled=async()=>{settledCalls++;return originalSettled();};
  // Reflect an unrelated in-flight PDF/file task, not a restore or editor write.
  Object.defineProperty(store,'pending',{configurable:true,get:()=>true});
  Object.defineProperty(store,'recordPending',{configurable:true,get:()=>false});
  const intent=f.api.prepareInput('continuousCamera');
  const saved=f.api.register([file('foreground.jpg','unique untouched original')],intent);
  const winner=await Promise.race([saved.then(()=>true),delay(900).then(()=>false)]);
  assert.equal(winner,true,'Foreground photo was blocked by unrelated background file I/O');
  const results=await saved;
  assert.equal(results[0]?.status,'attached');
  assert(flushCalls>=1,'The record-only durable flush must run');
  assert.equal(settledCalls,0,'Foreground save must not await all unrelated file writers');
  assert.equal(f.saved().shapes[0].photos.length,1);
  const entry=[...f.data.originals.values()][0];
  assert.equal(await entry.text(),'unique untouched original');
  assert.equal(f.data.meta.size,1);
  assert.equal(f.api.pendingSnapshot().length,0);
  console.log('PASS foreground photo commits while unrelated PDF/file work remains pending; original unchanged');
}
async function testActualRecordWriterStillWaits(){
  const f=fixture();await tick();
  const store=f.context.SentlogRecords;
  let recordsBusy=true,flushCalls=0;
  store.flush=async()=>{flushCalls++;};
  Object.defineProperty(store,'pending',{configurable:true,get:()=>recordsBusy});
  Object.defineProperty(store,'recordPending',{configurable:true,get:()=>recordsBusy});
  const intent=f.api.prepareInput('continuousCamera');
  const saving=f.api.register([file('protected.jpg','record writer fence original')],intent);
  await waitFor(()=>flushCalls>0);
  await delay(30);
  assert.equal(f.saved().shapes[0].photos.length,0,'An active record operation must keep its safety fence');
  recordsBusy=false;
  f.releaseExclusive();
  const result=await saving;
  assert.equal(result[0]?.status,'attached');
  assert.equal(f.saved().shapes[0].photos.length,1);
  assert.equal(await [...f.data.originals.values()][0].text(),'record writer fence original');
  assert.equal(f.api.pendingSnapshot().length,0);
  console.log('PASS photo keeps the record/restore safety fence and preserves its original');
}
(async()=>{await testNoUnrelatedWait();await testActualRecordWriterStillWaits();})()
 .catch(error=>{console.error(error);process.exitCode=1;});

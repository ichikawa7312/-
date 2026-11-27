'use strict';
const assert=require('node:assert/strict');
const {fixture,observe,digest,WS,DRAW,IDBObjectStore}=require('./helpers/record_file_fixture.cjs');
const key='background:synthetic-a',otherKey='page-replace-backup:synthetic-a';
const blob=text=>new Blob([text],{type:'application/pdf'}),cases=[];
const test=(name,fn)=>cases.push([name,fn]);
async function prepared(){const f=await fixture({seed:{[WS]:JSON.stringify({projects:[{id:'synthetic-project',drawings:[{id:'synthetic-a'}]}]}),[DRAW+'synthetic-a']:JSON.stringify({shapes:[]})}});await f.records.writeFile(key,blob('original'));return f;}
test('the capability is tied to the implemented optional same-transaction guard',async()=>{
  const f=await prepared();assert.equal(f.records.getFileWriteCapabilities().expectedFileStatesVersion,1);
  const expected=await f.state(key),value=blob('replacement'),result=await f.records.writeFile(key,value,{expectedFileStates:[expected]});
  assert.equal(result.written,true);assert.equal(result.sequence,(await f.state(key)).sequence);assert.ok(result.sequence>expected.sequence);assert.equal(await digest(await f.read(key)),await digest(value));
});
test('matching bytes return the exact unchanged sequence with no mutation requests',async()=>{
  const f=await prepared(),expected=await f.state(key),before=await f.disk();let result;
  const writes=await observe(async()=>{result=await f.records.writeFile(key,blob('original'),{expectedFileStates:[expected]});});
  assert.equal(result.written,false);assert.equal(result.unchanged,true);assert.equal(result.sequence,expected.sequence);assert.equal(writes.length,0);assert.deepEqual(await f.disk(),before);
});
test('a stale same-key version is rejected before changing any of the three stores',async()=>{
  const f=await prepared(),expected=await f.state(key);await f.records.writeFile(key,blob('other tab'));const before=await f.disk();
  const writes=await observe(()=>assert.rejects(f.records.writeFile(key,blob('replacement'),{expectedFileStates:[expected]}),e=>e.code==='JOURNAL_FILE_CHANGED'));
  assert.equal(writes.length,0);assert.deepEqual(await f.disk(),before);assert.equal(f.records.failed,false);assert.equal(f.records.pending,false);assert.equal(f.records.uncommittedFiles().length,0);
});
test('same bytes do not bypass a stale expected sequence after a real intervening version',async()=>{
  const f=await prepared(),expected=await f.state(key);await f.records.writeFile(key,blob('temporary'));await f.records.writeFile(key,blob('original'));const before=await f.disk();
  const writes=await observe(()=>assert.rejects(f.records.writeFile(key,blob('original'),{expectedFileStates:[expected]}),e=>e.code==='JOURNAL_FILE_CHANGED'));
  assert.equal(writes.length,0);assert.deepEqual(await f.disk(),before);
});
test('source and backup preconditions share the destination transaction',async()=>{
  const f=await prepared(),expected=await f.state(key),empty=await f.state(otherKey);await f.records.writeFile(key,blob('new source'));const before=await f.disk();
  const writes=await observe(()=>assert.rejects(f.records.writeFile(otherKey,blob('old source'),{expectedFileStates:[expected,empty]}),e=>e.code==='JOURNAL_FILE_CHANGED'));
  assert.equal(writes.length,0);assert.deepEqual(await f.disk(),before);assert.equal(await f.read(otherKey),undefined);
});
test('caller mutation cannot replace the captured expected version while the task is queued',async()=>{
  const f=await prepared(),expected=await f.state(key);await f.records.writeFile(key,blob('new source'));const current=await f.state(key),guard=[expected],before=await f.disk();
  const saving=f.records.writeFile(key,blob('replacement'),{expectedFileStates:guard});guard[0].sequence=current.sequence;guard.length=0;
  await assert.rejects(saving,e=>e.code==='JOURNAL_FILE_CHANGED');assert.deepEqual(await f.disk(),before);
});
test('two writers with one expected version cannot both replace the file',async()=>{
  const f=await prepared(),other=await fixture({factory:f.factory,local:f.local}),expected=await f.state(key);
  const results=await Promise.allSettled([f.records.writeFile(key,blob('writer one'),{expectedFileStates:[expected]}),other.records.writeFile(key,blob('writer two'),{expectedFileStates:[expected]})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='JOURNAL_FILE_CHANGED').length,1);
  const winner=results.findIndex(x=>x.status==='fulfilled');assert.equal(await (await f.read(key)).text(),winner===0?'writer one':'writer two');
});
test('the synchronous caller guard still aborts the whole transaction after a put request',async()=>{
  const f=await prepared(),expected=await f.state(key),before=await f.disk(),native=IDBObjectStore.prototype.put;let current=true,injected=false;
  IDBObjectStore.prototype.put=function(...args){const q=native.apply(this,args);if(this.name==='files'&&args[1]===key){injected=true;q.addEventListener('success',()=>{current=false;});}return q;};
  try{await assert.rejects(f.records.writeFile(key,blob('replacement'),{expectedFileStates:[expected],validate:()=>current}),e=>e.code==='FILE_WRITE_GUARD');}
  finally{IDBObjectStore.prototype.put=native;}
  assert.equal(injected,true);assert.deepEqual(await f.disk(),before);assert.equal(f.records.failed,false);
});
test('an aborted signal and malformed expectations cannot start a mutation',async()=>{
  const f=await prepared(),before=await f.disk(),controller=new AbortController();controller.abort();
  const writes=await observe(async()=>{
    await assert.rejects(f.records.writeFile(key,blob('replacement'),{expectedFileStates:[await f.state(key)],signal:controller.signal}),e=>e.code==='FILE_WRITE_ABORTED');
    for(const expectedFileStates of [null,{},[{key,sequence:-1}],[{key,sequence:1.5}],[{key:42,sequence:0}]])
      await assert.rejects(f.records.writeFile(key,blob('replacement'),{expectedFileStates}),e=>e.code==='FILE_WRITE_GUARD');
  });assert.equal(writes.length,0);assert.deepEqual(await f.disk(),before);
});
test('optional replacement guard is not silently ignored in the only-if-missing branch',async()=>{
  const f=await prepared(),before=await f.disk();await assert.rejects(f.records.writeFile(key,blob('replacement'),{expectedFileStates:[await f.state(key)],onlyIfMissing:true}),e=>e.code==='FILE_WRITE_GUARD');assert.deepEqual(await f.disk(),before);
});
test('existing unguarded and only-if-missing return contracts remain unchanged',async()=>{
  const f=await prepared();assert.equal(await f.records.writeFile(key,blob('legacy')),undefined);
  const result=await f.records.writeFile(key,blob('ignored'),{onlyIfMissing:true});assert.equal(result.written,false);assert.equal(await result.value.text(),'legacy');assert.equal('sequence' in result,false);
  const guarded=await f.records.writeFile(otherKey,blob('new'),{validate:()=>true});assert.equal(guarded.written,true);assert.equal('sequence' in guarded,false);
});
(async()=>{let passed=0,failed=0;for(const [name,fn]of cases)try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}console.log(JSON.stringify({passed,failed,total:cases.length,nativeBrowserExecuted:false}));if(failed)process.exitCode=1;})();

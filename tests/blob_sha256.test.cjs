'use strict';
// Synthetic bytes only. Exercise the generated browser/CommonJS artifact,
// including a 100 MiB source that refuses every whole-file read.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto');
const modulePath=require.resolve('../sentlog/blob-sha256.js'),H=require(modulePath),CHUNK=2*1024*1024;
const native=bytes=>createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function pattern(start,length){const bytes=new Uint8Array(length);for(let i=0;i<length;i++)bytes[i]=(start+i)%251;return bytes;}
function expected(size){const hash=createHash('sha256');for(let offset=0;offset<size;offset+=CHUNK)hash.update(pattern(offset,Math.min(CHUNK,size-offset)));return hash.digest('hex');}
function fake(size,{label='file',tracker={active:0,max:0,reads:[]},beforeRead,afterRead,delay=false}={}){
  let reads=0;
  return {size,get reads(){return reads;},arrayBuffer(){throw Error('whole-file read is forbidden');},
    slice(start,end){assert.equal(Number.isSafeInteger(start)&&start>=0,true);assert(end<=size&&end>start);assert(end-start<=CHUNK);
      return {size:end-start,async arrayBuffer(){reads++;tracker.reads.push({label,start,end});tracker.active++;tracker.max=Math.max(tracker.max,tracker.active);
        try{await beforeRead?.(reads);if(delay)await new Promise(resolve=>setTimeout(resolve,0));const bytes=pattern(start,end-start).buffer;await afterRead?.(reads);return bytes;}
        finally{tracker.active--;}}};}};
}
let passed=0;async function test(name,run){await run();passed++;console.log('PASS',name);}
(async()=>{
  assert.equal(H.version,1);assert.equal(H.chunkBytes,CHUNK);
  await test('known SHA-256 vectors preserve Web Crypto for small files',async()=>{
    let nativeCalls=0;const crypto={subtle:{digest(...args){nativeCalls++;return webcrypto.subtle.digest(...args);}}};
    for(const [text,hash]of [['','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc','ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['a'.repeat(1000000),'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0']]){
      assert.equal(await H.digest(new Blob([text]),{crypto}),hash);
    }
    assert.equal(nativeCalls,3);
  });
  await test('SHA block and two-MiB boundaries retain exactly the same digest',async()=>{
    for(const size of [1,55,56,63,64,65,CHUNK-1,CHUNK,CHUNK+1,CHUNK*2,CHUNK*2+17]){
      const bytes=pattern(0,size),blob=new Blob([bytes]);let nativeCalls=0;
      const crypto={subtle:{digest(...args){nativeCalls++;return webcrypto.subtle.digest(...args);}}};
      const actual=await H.digest(blob,{crypto});assert.equal(actual,native(bytes),'size '+size);
      assert.equal(nativeCalls,size<=CHUNK?1:0,'only small Blob uses Web Crypto');
      assert.equal(actual,Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex'));
    }
  });
  await test('100 MiB is verified using at most two MiB per read and no whole-file buffer',async()=>{
    const size=100*1024*1024+17,tracker={active:0,max:0,reads:[]},blob=fake(size,{tracker});
    const actual=await H.digest(blob,{crypto:webcrypto});assert.equal(actual,expected(size));
    assert.equal(blob.reads,51);assert.equal(tracker.max,1);assert(tracker.reads.every(read=>read.end-read.start<=CHUNK));
    assert.equal(tracker.reads.at(-1).end,size);
  });
  await test('independent module loads share one queue and permit event-loop work between chunks',async()=>{
    delete require.cache[modulePath];const again=require(modulePath),tracker={active:0,max:0,reads:[]};
    const a=fake(CHUNK*3+1,{label:'a',tracker}),b=fake(CHUNK*2+7,{label:'b',tracker});
    let readCountAtTask=-1;setTimeout(()=>{readCountAtTask=tracker.reads.length;},0);
    const values=await Promise.all([H.digest(a),again.digest(b)]);
    assert.deepEqual(values,[expected(a.size),expected(b.size)]);assert.equal(tracker.max,1);
    assert(readCountAtTask>0&&readCountAtTask<7,'a UI task must run before all chunks finish');
    assert.deepEqual(tracker.reads.map(read=>read.label),['a','a','a','a','b','b','b']);
  });
  await test('queued and in-flight cancellation reject promptly without overlapping an unfinished read',async()=>{
    const entered=deferred(),finishRead=deferred(),tracker={active:0,max:0,reads:[]},aAbort=new AbortController(),bAbort=new AbortController();
    const a=fake(CHUNK*3,{label:'a',tracker,beforeRead:async()=>{entered.resolve();await finishRead.promise;}});
    const b=fake(CHUNK*2+1,{label:'b',tracker}),c=fake(CHUNK+1,{label:'c',tracker});
    const first=H.digest(a,{signal:aAbort.signal});await entered.promise;
    const second=H.digest(b,{signal:bAbort.signal}),third=H.digest(c);
    bAbort.abort();aAbort.abort();
    await assert.rejects(first,error=>error.name==='AbortError');await assert.rejects(second,error=>error.name==='AbortError');
    assert.equal(a.reads,1);assert.equal(b.reads,0);assert.equal(c.reads,0,'next job waits for the cancelled read to settle');
    finishRead.resolve();assert.equal(await third,expected(c.size));assert.equal(a.reads,1);assert.equal(b.reads,0);assert.equal(tracker.max,1);
  });
  await test('scope invalidation stops between chunks and preserves the exact caller error',async()=>{
    let valid=true;const stopped=Object.assign(Error('scope changed'),{code:'SYNTHETIC_SCOPE'});
    const blob=fake(CHUNK*3,{afterRead:()=>{valid=false;}});
    await assert.rejects(()=>H.digest(blob,{validate:()=>{if(!valid)throw stopped;}}),error=>error===stopped);
    assert.equal(blob.reads,1);
    await assert.rejects(()=>H.digest(new Blob(['a']),{validate:()=>false}),error=>error.code==='BLOB_HASH_CONTEXT');
    await assert.rejects(()=>H.digest(new Blob(['a']),{validate:async()=>true}),error=>error.code==='BLOB_HASH_CONTEXT');
    assert.equal(await H.digest(new Blob(['abc']),{crypto:webcrypto}),native('abc'),'a stopped job never poisons the queue');
  });
  await test('wrong-size chunk reads fail before a digest can be accepted',async()=>{
    const blob={size:CHUNK+1,arrayBuffer(){throw Error('whole read');},slice(start,end){return {size:end-start,arrayBuffer:async()=>new ArrayBuffer(1)};}};
    await assert.rejects(()=>H.digest(blob),error=>error.code==='BLOB_HASH_BYTES');
    assert.equal(await H.digest(new Blob([]),{crypto:webcrypto}),native(''));
  });
  await test('the committed artifact runs offline as a browser global',async()=>{
    const context=vm.createContext({window:{},console,Blob,crypto:webcrypto,setTimeout,clearTimeout});
    vm.runInContext(fs.readFileSync(modulePath,'utf8'),context);
    assert.equal(context.window.SentlogBlobSha256.version,1);
    assert.equal(await context.window.SentlogBlobSha256.digest(new Blob(['browser 🌧️'])),native('browser 🌧️'));
    const blob=fake(CHUNK+3);assert.equal(await context.window.SentlogBlobSha256.digest(blob),expected(blob.size));
  });
  console.log('PASS bounded Blob SHA-256:',passed,'groups; known vectors, boundaries, 100 MiB, serial reads, cancellation, offline browser');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

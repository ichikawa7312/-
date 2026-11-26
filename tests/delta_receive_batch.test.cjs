'use strict';
// Bounded receive pages use the real replica and CAS adapter. These fixtures
// measure the full-state write amplification and preserve failure boundaries.
const assert=require('node:assert/strict'),path=require('node:path'),fake=require('fake-indexeddb');
const C=require('../sentlog/record-collaboration.js');
const D=require(process.env.SENTLOG_RECEIVE_CORE?path.resolve(process.env.SENTLOG_RECEIVE_CORE):'../sentlog/delta-sync-core.js');
const S=require('../sentlog/delta-sync-indexeddb.js');
const copy=x=>structuredClone(x),scope={ownerId:'batch-owner',projectId:'batch-project',deviceId:'local'};
const key=id=>D.keyOf('drawing',id),cases=[],open=[];let serial=0;
const record=id=>C.upgrade({id,kind:'field-record',memo:'original '+id,photos:[]});
function amended(before,text,id,deviceId='peer'){
  let n=0;return C.appendComment(before,text,{actor:{deviceId,deviceName:deviceId},at:100,idFactory:()=>id+':'+(++n)});
}
const event=(before,after,id,deviceId='peer')=>D.diffRecord(before,after,{projectId:scope.projectId,deviceId,drawingId:'drawing',eventId:id});
const row=(seq,id)=>({seq,event:event(null,record(id),'create:'+id)});
function latch(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function fixture(records={},pageLimit=100){
  const indexedDB=new fake.IDBFactory(),databaseName='sentlog-delta-test-receive-'+(++serial);
  const adapter=S.createStore({...scope,indexedDB,databaseName});await adapter.read();
  const initial={version:2,scope:copy(scope),cursor:0,records:copy(records),outbox:[]};await adapter.write(initial);
  const h={indexedDB,databaseName,adapter,initial,rows:[],writes:0,attempts:0,writtenBytes:0,saved:[],beforeWrite:null,beforeList:null,lists:[]};
  const store={...adapter,async write(next){
    h.attempts++;if(h.beforeWrite)await h.beforeWrite(next);await adapter.write(next);
    h.writes++;h.writtenBytes+=Buffer.byteLength(JSON.stringify(next));h.saved.push(copy(next));
  }};
  const transport={online:()=>true,getCapabilities:()=>({atomicGroups:true}),
    push:async()=>{throw Error('unexpected send: the fixture does not start a background worker');},
    pushGroup:async()=>{throw Error('unexpected group send');},
    async list(project,cursor,limit){assert.equal(project,scope.projectId);h.lists.push(cursor);
      if(h.beforeList)await h.beforeList(cursor);
      const rows=copy(h.rows.filter(r=>r.seq>cursor).slice(0,limit));
      rows.hasMore=(rows.at(-1)?.endSeq??rows.at(-1)?.seq??cursor)<(h.rows.at(-1)?.endSeq??h.rows.at(-1)?.seq??0);
      return rows;
    }};
  h.replica=D.createReplica({...scope,store,transport,pageLimit,reconcileIntervalMs:0});
  h.read=()=>adapter.readForVerification();h.close=()=>{h.replica.close();adapter.close();};open.push(h);return h;
}
const test=(name,fn)=>cases.push([name,fn]);

test('121 received edits in 1000 records use two bounded durable writes and survive reopen',async()=>{
  const records=Object.fromEntries(Array.from({length:1000},(_,i)=>[key('r'+i),record('r'+i)]));
  const h=await fixture(records),expected=copy(records);
  for(let i=0;i<121;i++){
    const before=records[key('r'+i)],after=amended(before,'received '+i,'remote-'+i);
    h.rows.push({seq:i+1,event:event(before,after,'event-'+i)});expected[key('r'+i)]=after;
  }
  const result=await h.replica.sync(),saved=await h.read();
  assert.equal(result.received,121);assert.equal(saved.cursor,121);assert.deepEqual(saved.records,expected);
  assert.deepEqual(saved.outbox,[]);assert.deepEqual(h.lists,[0,100]);
  assert.equal(h.writes,2,'one full replica write per bounded page, not per received event');
  const maximumStateBytes=Buffer.byteLength(JSON.stringify(saved));
  assert(h.writtenBytes<=maximumStateBytes*2,'full-state serialization grows with pages rather than rows');
  const reopened=S.createStore({...scope,indexedDB:h.indexedDB,databaseName:h.databaseName});
  try{assert.deepEqual(await reopened.read(),saved);}finally{reopened.close();}
});

test('ordered patches of one record and complete groups share a page without losing history',async()=>{
  const base=record('same'),second=amended(base,'second','second'),third=amended(second,'third','third');
  const h=await fixture();h.rows=[row(1,'same'),{seq:2,endSeq:3,group:{schema:1,kind:'atomic-group',
    groupId:'two-patches',projectId:scope.projectId,deviceId:'peer',
    events:[event(base,second,'second'),event(second,third,'third')]}},row(4,'last')];
  const result=await h.replica.sync(),saved=await h.read();
  assert.equal(result.received,4);assert.equal(saved.cursor,4);assert.deepEqual(saved.records[key('same')],third);
  assert(saved.records[key('last')]);assert.equal(h.writes,1);assert.deepEqual(h.saved.map(s=>s.cursor),[4]);
});

test('an invalid later group preserves the earlier solo prefix and none of the failed group',async()=>{
  const h=await fixture(),missing=record('missing'),changed=amended(missing,'bad patch','missing');
  h.rows=[row(1,'prefix'),{seq:2,endSeq:3,group:{schema:1,kind:'atomic-group',groupId:'group',
    projectId:scope.projectId,deviceId:'peer',events:[event(null,record('partial'),'partial'),event(missing,changed,'missing')]}},row(4,'tail')];
  await assert.rejects(h.replica.sync(),e=>e.code==='DELTA_MISSING_BASE');
  const prefix=await h.read();assert.equal(prefix.cursor,1);assert.deepEqual(Object.keys(prefix.records),[key('prefix')]);
  assert.equal(h.writes,1);assert(!prefix.records[key('partial')]);assert(!prefix.records[key('tail')]);
  h.rows[1].group.events[1]=event(null,missing,'missing');await h.replica.sync();
  const complete=await h.read();assert.equal(complete.cursor,4);assert.equal(Object.keys(complete.records).length,4);
  assert.deepEqual(h.lists,[0,1]);assert.equal(h.writes,2);
});

test('a sequence gap after valid rows keeps only the exact valid prefix',async()=>{
  const h=await fixture();h.rows=[row(1,'one'),row(2,'two'),row(4,'gap'),row(5,'tail')];
  await assert.rejects(h.replica.sync(),e=>e.code==='DELTA_SEQUENCE_GAP');
  const saved=await h.read();assert.equal(saved.cursor,2);assert.deepEqual(Object.keys(saved.records),[key('one'),key('two')]);
  assert.equal(h.writes,1);assert.deepEqual(saved.outbox,[]);
});

test('transaction abort leaves the whole page, cursor, token and prior outbox unchanged',async()=>{
  const h=await fixture();h.rows=[row(1,'one'),row(2,'two'),row(3,'three')];
  const before=await h.replica.snapshotWithStatus(),put=fake.IDBObjectStore.prototype.put;let aborted=false;
  fake.IDBObjectStore.prototype.put=function(value,...args){
    const result=put.call(this,value,...args);
    if(!aborted&&this.name==='replicas'&&value?.state?.cursor>0){aborted=true;queueMicrotask(()=>this.transaction.abort());}
    return result;
  };
  try{await assert.rejects(h.replica.sync());}finally{fake.IDBObjectStore.prototype.put=put;}
  assert(aborted);assert.equal(h.writes,0);assert.deepEqual(await h.read(),h.initial);
  const after=await h.replica.snapshotWithStatus();assert.equal(after.snapshotToken,before.snapshotToken);assert.deepEqual(after.snapshot,before.snapshot);
  await h.replica.sync();assert.equal((await h.read()).cursor,3);assert.equal(h.writes,1);
});

test('a local edit during the network wait is merged and its unsent event is retained',async()=>{
  const base=record('same'),h=await fixture({[key('same')]:base}),entered=latch(),release=latch();
  const remote=amended(base,'remote','remote'),local=amended(base,'local','local','local');
  h.rows=[{seq:1,event:event(base,remote,'remote')}];h.beforeList=async()=>{entered.resolve();await release.promise;};
  const pending=h.replica.sync();await entered.promise;
  await h.replica.change({drawingId:'drawing',before:base,after:local,eventId:'local'});
  assert.equal((await h.read()).outbox.length,1,'network wait does not own the local edit queue');
  release.resolve();await pending;const saved=await h.read();
  assert.equal(saved.cursor,1);assert.equal(saved.outbox.length,1);assert.equal(saved.outbox[0].eventId,'local');
  assert.deepEqual(saved.records[key('same')],D.combine(local,h.rows[0].event));assert.equal(h.writes,2);
});

test('a failed prefix save preserves an edit and its outbox made during the fetch',async()=>{
  const base=record('local-record'),h=await fixture({[key(base.id)]:base}),entered=latch(),release=latch();
  h.rows=[row(1,'valid'),row(3,'gap')];h.beforeList=async()=>{entered.resolve();await release.promise;};
  const receiving=h.replica.sync();await entered.promise;
  await h.replica.change({drawingId:'drawing',before:base,after:amended(base,'unsent','unsent','local'),eventId:'unsent'});
  const before=await h.replica.snapshotWithStatus(),durable=await h.read(),failure=Object.assign(Error('prefix storage failure'),{code:'SYNTHETIC_STORAGE_FAILURE'});
  h.beforeWrite=async()=>{throw failure;};release.resolve();
  await assert.rejects(receiving,e=>e===failure,'storage failure takes precedence because the valid prefix was not committed');
  assert.deepEqual(await h.read(),durable);assert.equal(durable.outbox.length,1);assert.equal(durable.outbox[0].eventId,'unsent');
  const after=await h.replica.snapshotWithStatus();assert.deepEqual(after.snapshot,before.snapshot);assert.equal(after.snapshotToken,before.snapshotToken);
  assert.equal(h.writes,1);assert.equal(durable.cursor,0);assert(!durable.records[key('valid')]);
});

test('an edit queued during a receive commit follows that commit without replacing its rows',async()=>{
  const base=record('local-record'),h=await fixture({[key(base.id)]:base}),entered=latch(),release=latch();
  h.rows=[row(1,'one'),row(2,'two')];h.beforeWrite=async next=>{if(next.cursor===2&&!next.outbox.length){entered.resolve();await release.promise;}};
  const receiving=h.replica.sync();await entered.promise;
  const after=amended(base,'queued edit','queued','local');
  const editing=h.replica.change({drawingId:'drawing',before:base,after,eventId:'queued'});
  release.resolve();await Promise.all([receiving,editing]);const saved=await h.read();
  assert.equal(saved.cursor,2);assert(saved.records[key('one')]&&saved.records[key('two')]);
  assert.deepEqual(saved.records[key(base.id)],after);assert.equal(saved.outbox.length,1);assert.equal(h.writes,2);
  assert.deepEqual(h.saved.map(s=>[s.cursor,s.outbox.length]),[[2,0],[2,1]]);
});

test('a peer adapter write rejects the complete stale receive page without overwriting it',async()=>{
  const base=record('base'),h=await fixture({[key('base')]:base}),entered=latch(),release=latch();
  h.rows=[row(1,'one'),row(2,'two')];h.beforeWrite=async()=>{entered.resolve();await release.promise;};
  const before=await h.replica.snapshotWithStatus(),receiving=h.replica.sync();await entered.promise;
  const peer=S.createStore({...scope,indexedDB:h.indexedDB,databaseName:h.databaseName});
  try{
    const other=await peer.read(),after=amended(base,'peer edit','peer-edit','local');
    other.records[key('base')]=after;other.outbox.push(event(base,after,'peer-edit','local'));await peer.write(other);
    release.resolve();await assert.rejects(receiving,e=>e.code==='DELTA_STORE_STALE');
    assert.deepEqual(await h.read(),other);assert.equal(h.writes,0);
    const snapshot=await h.replica.snapshotWithStatus();assert.equal(snapshot.snapshotToken,before.snapshotToken);assert.deepEqual(snapshot.snapshot,before.snapshot);
  }finally{peer.close();release.resolve();}
});

test('a pre-page UI snapshot remains stale after the batched receive',async()=>{
  const base=record('same'),h=await fixture({[key('same')]:base}),before=await h.replica.snapshotWithStatus();
  h.rows=[{seq:1,event:event(base,amended(base,'remote','remote'),'remote')},row(2,'other')];await h.replica.sync();
  const saved=await h.read();await assert.rejects(h.replica.changeBatch({expectedSnapshotToken:before.snapshotToken,
    changes:[{drawingId:'drawing',before:base,after:amended(base,'stale UI','stale','local'),eventId:'stale'}]}),e=>e.code==='DELTA_STALE');
  assert.deepEqual(await h.read(),saved);assert.equal(h.writes,1);
});

test('closing during a late page leaves storage unchanged',async()=>{
  const h=await fixture(),entered=latch(),release=latch();h.rows=[row(1,'one'),row(2,'two')];
  h.beforeList=async()=>{entered.resolve();await release.promise;};
  const receiving=h.replica.sync(),rejected=assert.rejects(receiving,e=>e.code==='DELTA_CLOSED');await entered.promise;
  h.replica.close();release.resolve();await rejected;await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(await h.read(),h.initial);assert.equal(h.writes,0);
});

(async()=>{
  let passed=0,failed=0;
  for(const [name,fn]of cases){try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error);}
    finally{for(const h of open.splice(0))h.close();}}
  console.log('DELTA RECEIVE BATCH RESULT',passed,'passed,',failed,'failed');if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

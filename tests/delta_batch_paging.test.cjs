'use strict';
// Atomic local batches and bounded remote paging. Pure in-memory adapters only.
const assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const copy=x=>JSON.parse(JSON.stringify(x)),scope={ownerId:'owner',projectId:'project',deviceId:'device'};
const record=(id='r1')=>C.upgrade({id,kind:'field-record',recordKind:'field-record',page:1,point:{x:1,y:2},memo:'既存 '+id,photos:[]});
const opts=id=>{let n=0;return {actor:{deviceId:scope.deviceId,deviceName:'端末'},at:10,idFactory:()=>id+'-'+(++n)};};
const edit=(before,text,id)=>C.appendComment(before,text,opts(id));
const change=(before,after,eventId,drawingId='d1')=>({drawingId,before,after,eventId});
function initial(records=[record('r1'),record('r2')]){
  return {version:2,scope:copy(scope),cursor:0,records:Object.fromEntries(records.map(r=>[D.keyOf('d1',r.id),r])),outbox:[]};
}
function fixture({state=initial(),transport,pageLimit=100}={}){
  let durable=copy(state),writes=0,attempts=0,reads=0,failAt=0,beforeRead=null,beforeWrite=null;const statuses=[];
  const store={async read(){reads++;if(beforeRead)await beforeRead();return copy(durable);},async write(next){attempts++;
    if(beforeWrite)await beforeWrite(next);if(failAt===attempts)throw Error('disk full');durable=copy(next);writes++;}};
  const client=D.createReplica({...scope,store,pageLimit,transport:transport||{online:()=>false,push:async()=>{},list:async()=>[]},onStatus:s=>statuses.push(s)});
  return {client,statuses,current:()=>copy(durable),get writes(){return writes;},get attempts(){return attempts;},get reads(){return reads;},
    failNext(){failAt=attempts+1;},failOnAttempt(n){failAt=n;},onRead(fn){beforeRead=fn;},onWrite(fn){beforeWrite=fn;},close(){client.close();}};
}
function rows(n){return Array.from({length:n},(_,i)=>({seq:i+1,event:D.diffRecord(null,record('remote-'+(i+1)),{
  projectId:scope.projectId,deviceId:'peer',drawingId:'d1',eventId:'remote-event-'+(i+1)})}));}
function page(rows,hasMore){Object.defineProperty(rows,'hasMore',{value:hasMore});return rows;}
const online=list=>({online:()=>true,push:async()=>{throw Error('unexpected push');},list});
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS',name);}
(async()=>{
await test('legacy change returns the same changed, duplicate, and unchanged receipts',async()=>{
  const f=fixture({state:initial([])}),r=record(),request=change(null,r,'create');
  assert.deepEqual(await f.client.change(request),{eventId:'create',pending:1,blocked:0});
  assert.deepEqual(await f.client.change(request),{eventId:'create',duplicate:true,pending:1,blocked:0});
  assert.deepEqual(await f.client.change(change(r,r,'no-op')),{unchanged:true,pending:1});
  assert.equal(f.writes,1);f.close();
});
await test('multiple records and ordered same-record revisions commit in one write with the exact new token',async()=>{
  const a=record('r1'),b=record('r2'),a1=edit(a,'1 回目','a1'),a2=edit(a1,'2 回目','a2'),b1=edit(b,'別記録','b1');
  const f=fixture(),before=await f.client.snapshotWithStatus();
  const r=await f.client.changeBatch({changes:[change(a,a1,'a1'),change(a1,a2,'a2'),change(b,b1,'b1')],expectedSnapshotToken:before.snapshotToken});
  assert.equal(f.writes,1);assert.deepEqual(r.results,[{eventId:'a1'},{eventId:'a2'},{eventId:'b1'}]);assert.equal(r.pending,3);
  const after=await f.client.snapshotWithStatus();assert.equal(r.snapshotToken,after.snapshotToken);assert.notEqual(after.snapshotToken,before.snapshotToken);
  assert(C.equal(after.snapshot.records[D.keyOf('d1','r1')],a2));assert.equal(f.statuses.length,1);f.close();
});
await test('a stale later item cannot commit an earlier valid record or issue a success status',async()=>{
  const f=fixture(),a=record('r1'),b=record('r2'),unseen=edit(b,'未受信の前提','unseen'),before=f.current();
  await assert.rejects(()=>f.client.changeBatch({changes:[change(a,edit(a,'先頭','first'),'first'),change(unseen,edit(unseen,'後半','second'),'second')]}),
    e=>e.code==='DELTA_STALE');
  assert.deepEqual(f.current(),before);assert.equal(f.writes,0);assert.equal(f.statuses.length,0);f.close();
});
await test('later history loss and cross-record event-ID collision roll back the entire candidate',async()=>{
  for(const kind of ['history','collision']){
    const f=fixture(),a=record('r1'),b=record('r2'),before=f.current();
    const invalid=kind==='history'?C.upgrade({id:b.id,memo:'履歴を置換',photos:[]}):edit(b,'後半','second');
    await assert.rejects(()=>f.client.changeBatch({changes:[change(a,edit(a,'先頭','first'),'event'),change(b,invalid,kind==='collision'?'event':'second')]}),
      e=>e.code===(kind==='history'?'DELTA_HISTORY_LOSS':'DELTA_COLLISION'));
    assert.deepEqual(f.current(),before);assert.equal(f.writes,0);f.close();
  }
});
await test('mixed duplicate and new events write once, and a complete retry writes nothing',async()=>{
  const f=fixture(),a=record('r1'),b=record('r2'),aChange=change(a,edit(a,'A','a'),'a'),bChange=change(b,edit(b,'B','b'),'b');
  await f.client.change(aChange);assert.equal(f.writes,1);
  const mixed=await f.client.changeBatch({changes:[aChange,bChange,bChange]});assert.equal(f.writes,2);
  assert.deepEqual(mixed.results,[{eventId:'a',duplicate:true},{eventId:'b'},{eventId:'b',duplicate:true}]);
  const repeat=await f.client.changeBatch({changes:[aChange,bChange]});assert.equal(f.writes,2);
  assert(repeat.results.every(r=>r.duplicate));assert.equal(f.current().outbox.length,2);f.close();
});
await test('snapshot token checks happen inside the local queue and reject another replica token',async()=>{
  const f=fixture(),other=fixture(),old=await f.client.snapshotWithStatus(),foreign=await other.client.snapshotWithStatus();
  const a=record('r1'),b=record('r2');await f.client.change(change(a,edit(a,'先に保存','a'),'a'));
  for(const token of [old.snapshotToken,foreign.snapshotToken])await assert.rejects(()=>f.client.changeBatch({
    changes:[change(b,edit(b,'後から保存','b'),'b')],expectedSnapshotToken:token}),e=>e.code==='DELTA_STALE');
  assert.equal(f.writes,1);assert(C.equal(f.current().records[D.keyOf('d1','r2')],b));f.close();other.close();
});
await test('queued changes capture all submitted bodies before callers continue editing them',async()=>{
  const f=fixture(),a=record('r1'),b=record('r2');let release;f.onRead(()=>new Promise(resolve=>{release=resolve;}));
  const a1=edit(a,'確定した A','a'),b1=edit(b,'確定した B','b'),requests=[change(a,a1,'a'),change(b,b1,'b')];
  const pending=f.client.changeBatch({changes:requests});while(!release)await Promise.resolve();
  requests[0].after=edit(a,'後で変更した A','altered');requests[1].after.collab.comments={};requests.push(change(null,record('late'),'late'));
  release();await pending;assert.equal(f.writes,1);assert.equal(f.current().outbox.length,2);
  assert(f.current().records[D.keyOf('d1','r1')].memo.includes('確定した A'));
  assert(f.current().records[D.keyOf('d1','r2')].memo.includes('確定した B'));f.close();
});
await test('store failure preserves state and token, then retries the complete batch',async()=>{
  const f=fixture(),a=record('r1'),b=record('r2'),old=await f.client.snapshotWithStatus(),requests=[change(a,edit(a,'A','a'),'a'),change(b,edit(b,'B','b'),'b')];
  f.failNext();await assert.rejects(()=>f.client.changeBatch({changes:requests,expectedSnapshotToken:old.snapshotToken}),/disk full/);
  const failed=await f.client.snapshotWithStatus();assert.deepEqual(failed.snapshot,old.snapshot);assert.equal(failed.snapshotToken,old.snapshotToken);assert.equal(f.writes,0);
  await f.client.changeBatch({changes:requests,expectedSnapshotToken:old.snapshotToken});assert.equal(f.writes,1);assert.equal(f.current().outbox.length,2);f.close();
});
await test('batch size, sparse entries and null entries are rejected before opening storage',async()=>{
  for(const changes of [[],new Array(2),[null],[undefined],Array(501).fill(change(null,record(),'oversized'))]){
    const f=fixture();await assert.rejects(()=>f.client.changeBatch({changes}),e=>e.code==='DELTA_BATCH');assert.equal(f.reads,0);assert.equal(f.writes,0);f.close();
  }
});
await test('unchanged batches keep the existing token and never write or notify saved',async()=>{
  const f=fixture(),a=record('r1'),b=record('r2'),old=await f.client.snapshotWithStatus();
  const r=await f.client.changeBatch({changes:[change(a,a,'no-a'),change(b,b,'no-b')],expectedSnapshotToken:old.snapshotToken});
  assert.deepEqual(r.results,[{unchanged:true},{unchanged:true}]);assert.equal(r.snapshotToken,old.snapshotToken);assert.equal(f.writes,0);assert.equal(f.statuses.length,0);f.close();
});
await test('blocked dependencies and unrelated queued edits are saved together without losing blocked evidence',async()=>{
  const a=record('r1'),b=record('r2'),state=initial(),blocked=D.diffRecord(null,a,{...scope,drawingId:'d1',eventId:'blocked-create'});
  state.blockedOutbox=[{event:blocked,reason:{code:'DELTA_PAYLOAD_INVALID',message:'要確認'}}];const f=fixture({state});
  const r=await f.client.changeBatch({changes:[change(a,edit(a,'保留への追記','a'),'a'),change(b,edit(b,'通常の追記','b'),'b')]});
  assert.equal(f.writes,1);assert.equal(r.blocked,2);assert.equal(r.pending,1);assert.equal(f.current().blockedOutbox[1].event.eventId,'a');
  assert.equal(f.current().outbox[0].eventId,'b');assert.equal(f.statuses[0].level,'review');f.close();
});
await test('short pages with non-enumerable hasMore continue until the declared final page',async()=>{
  const remote=rows(5),calls=[],f=fixture({state:initial([]),pageLimit:100,transport:online(async(pid,cursor,limit)=>{
    calls.push({pid,cursor,limit});return page(copy(remote.slice(cursor,cursor+1)),cursor+1<remote.length);})});
  const r=await f.client.sync();assert.equal(r.received,5);assert.equal(r.cursor,5);assert.equal(f.writes,5);
  assert.deepEqual(calls.map(x=>x.cursor),[0,1,2,3,4]);assert(calls.every(x=>x.pid===scope.projectId&&x.limit===100));
  assert.equal(f.statuses.at(-1).level,'ok');assert.equal(f.statuses.at(-1).cursor,5);f.close();
});
await test('a full page with explicit hasMore false ends without an unnecessary extra RPC',async()=>{
  const remote=rows(2);let calls=0;const f=fixture({state:initial([]),pageLimit:2,transport:online(async()=>{
    calls++;assert.equal(calls,1);return page(copy(remote),false);})});
  assert.equal((await f.client.sync()).cursor,2);assert.equal(calls,1);f.close();
});
await test('legacy plain arrays still continue full pages and end on a short page',async()=>{
  const remote=rows(3),calls=[],f=fixture({state:initial([]),pageLimit:2,transport:online(async(pid,cursor,limit)=>{
    calls.push(cursor);return copy(remote.filter(r=>r.seq>cursor).slice(0,limit));})});
  assert.equal((await f.client.sync()).received,3);assert.deepEqual(calls,[0,2]);assert.equal(f.current().cursor,3);f.close();
});
await test('an empty continuation and invalid hasMore values cannot report synchronization complete',async()=>{
  for(const value of [true,'true',1,null]){
    const remote=value===true?[]:rows(1),f=fixture({state:initial([]),transport:online(async()=>page(copy(remote),value))});
    await assert.rejects(()=>f.client.sync(),e=>e.code==='DELTA_SERVER');assert.equal(f.current().cursor,0);assert.equal(f.writes,0);
    assert(!f.statuses.some(s=>s.level==='ok'));assert.equal(f.statuses.at(-1).level,'warning');f.close();
  }
});
await test('a gap after a short page stops at the last durable sequence and a later retry fills it',async()=>{
  const remote=rows(3);let broken=true;const f=fixture({state:initial([]),transport:online(async(pid,cursor)=>{
    if(cursor===0)return page(copy(remote.slice(0,1)),true);
    if(broken)return page(copy(remote.slice(2)),false);
    return page(copy(remote.slice(cursor)),false);})});
  await assert.rejects(()=>f.client.sync(),e=>e.code==='DELTA_SEQUENCE_GAP');assert.equal(f.current().cursor,1);assert.equal(f.writes,1);
  broken=false;assert.equal((await f.client.sync()).cursor,3);assert.equal(f.writes,2);f.close();
});
await test('a disk failure during paged receive resumes from its durable cursor without skipping a row',async()=>{
  const remote=rows(3),calls=[],f=fixture({state:initial([]),transport:online(async(pid,cursor)=>{
    calls.push(cursor);return page(copy(remote.slice(cursor,cursor+1)),cursor+1<remote.length);})});
  f.failOnAttempt(2);await assert.rejects(()=>f.client.sync(),/disk full/);assert.equal(f.current().cursor,1);
  assert.equal((await f.client.sync()).cursor,3);assert.deepEqual(calls,[0,1,1,2]);assert.equal(f.writes,3);f.close();
});
await test('local batch atomicity does not imply server or receiver atomicity for a move',async()=>{
  const source=record('source'),state=initial([source]),tomb=C.markDeleted(source,{...opts('remove'),expectedToken:C.revisionToken(source)}),target=record('target');
  let connected=false;const log=[],serverRecords=copy(state.records),transport={online:()=>connected,
    async push(event){
      if(event.recordId==='target')throw Object.assign(Error('DELTA_UNKNOWN_PARENT'),{code:'DELTA_UNKNOWN_PARENT',status:400});
      const key=D.keyOf(event.drawingId,event.recordId);serverRecords[key]=D.combine(serverRecords[key]||null,event);log.push({seq:log.length+1,event:copy(event)});
      return {seq:log.length,...Object.fromEntries(['projectId','eventId','drawingId','recordId','deviceId'].map(k=>[k,event[k]]))};
    },async list(pid,cursor,limit){return copy(log.filter(r=>r.seq>cursor).slice(0,limit));}};
  const sender=fixture({state,transport});await sender.client.changeBatch({changes:[change(source,tomb,'move-source'),change(null,target,'move-target','d2')]});
  assert.equal(sender.writes,1);assert.equal(sender.current().outbox.length,2);connected=true;
  const sent=await sender.client.sync();assert.equal(sent.pushed,1);assert.equal(sent.blocked,1);assert.equal(log.length,1);
  assert(C.isDeleted(serverRecords[D.keyOf('d1','source')]));assert.equal(serverRecords[D.keyOf('d2','target')],undefined);
  const receiver=fixture({state,transport});await receiver.client.sync();assert(C.isDeleted(receiver.current().records[D.keyOf('d1','source')]));
  assert.equal(receiver.current().records[D.keyOf('d2','target')],undefined);
  // This observed boundary is why the app bridge still reports readyForActivation:false.
  sender.close();receiver.close();
});
console.log(passed+' delta batch and paging scenarios passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// Failure-first regressions for the isolated prototype, not physical-device proof.
const assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js');
const D=require('../sentlog/delta-sync-core.js');
const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ownerId='owner-A',projectId='project-A',drawingId='drawing-A',deviceId='device-A';
const scope={ownerId,projectId,deviceId};
const key=id=>D.keyOf(drawingId,id);
function base(id='record-A'){return C.upgrade({id,memo:'元の記録',crackWidthMm:0.2,photos:[]});}
function edit(record,text,id='edit'){let n=0;return C.appendComment(record,text,{actor:{deviceId,deviceName:'試験端末'},at:1,idFactory:()=>id+':'+(++n)});}
function event(record,id='create'){return D.diffRecord(null,record,{projectId,drawingId,deviceId,eventId:id});}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function memory(initial=null){let data=copy(initial),fail=0;return {writes:0,async read(){return copy(data);},async write(next){if(fail){fail--;throw Error('disk write failed');}this.writes++;data=copy(next);},fail(){fail++;},current(){return copy(data);}};}
function scoped(extra={}){return {version:2,scope:{...scope},cursor:0,records:{},outbox:[],...extra};}
function server(){
  const rows=[],dedupe=new Map(),listeners=new Set();
  const t={connected:true,notices:true,calls:{push:0,list:0},beforePush:null,beforeList:null,
    online(){return this.connected;},
    async push(e){this.calls.push++;if(this.beforePush)await this.beforePush(e);if(!this.connected)throw Object.assign(Error('network unavailable'),{retryable:true});
      const old=dedupe.get(e.eventId);if(old){assert(C.equal(old.event,e),'event collision at fake server');return ack(old);}
      const row={seq:rows.length+1,event:copy(e)};rows.push(row);dedupe.set(e.eventId,row);
      if(this.notices)for(const f of listeners)f({projectId:e.projectId,seq:row.seq});return ack(row);},
    async list(p,cursor,limit){this.calls.list++;if(this.beforeList)await this.beforeList(p,cursor,limit);if(!this.connected)throw Object.assign(Error('network unavailable'),{retryable:true});return copy(rows.filter(r=>r.seq>cursor).slice(0,limit));},
    subscribe(p,f){listeners.add(f);return()=>listeners.delete(f);},rows,notice(){for(const f of listeners)f({projectId});}};
  function ack(row){const e=row.event;return {seq:row.seq,projectId:e.projectId,eventId:e.eventId,deviceId:e.deviceId,drawingId:e.drawingId,recordId:e.recordId};}
  return t;
}
const open=[];
function replica(options={}){const store=options.store||memory(),transport=options.transport||server(),statuses=[];
  const client=D.createReplica({...scope,store,transport,onStatus:s=>statuses.push(s),reconcileIntervalMs:0,...options});
  open.push(client);return {client,store,transport,statuses};}
async function seed(env){await env.client.start();const r=base();await env.client.change({drawingId,before:null,after:r,eventId:'seed'});await env.client.sync();return r;}
async function until(check,message){for(let i=0;i<100;i++){if(check())return;await delay(2);}assert.fail(message);}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('saving a local edit automatically sends without sync()/online()/visibility()',async()=>{
  const e=replica();await e.client.start();await e.client.change({drawingId,before:null,after:base(),eventId:'automatic'});
  await until(()=>e.transport.rows.some(r=>r.event.eventId==='automatic'),'local edit never scheduled a send');
  await until(()=>e.store.current()?.outbox.length===0,'automatic send did not persist its receipt');
});
test('a stalled network request cannot block the next durable local edit',async()=>{
  const e=replica(),r=await seed(e),first=edit(r,'送信待ち','first'),second=edit(first,'通信中にも入力','second'),gate=deferred(),entered=deferred();
  e.transport.beforePush=async()=>{entered.resolve();await gate.promise;};
  await e.client.change({drawingId,before:r,after:first,eventId:'slow'});const sync=e.client.sync();await entered.promise;
  const local=e.client.change({drawingId,before:first,after:second,eventId:'during-network'});
  try{assert.equal(await Promise.race([local.then(()=>true),delay(35).then(()=>false)]),true,'network held the local-save queue');}
  finally{gate.resolve();await sync;await local;}
  assert(e.store.current().records[key(r.id)].memo.includes('通信中にも入力'));
});
test('close fences an in-flight push reply and retains the unconfirmed outbox',async()=>{
  const e=replica(),r=await seed(e),gate=deferred(),entered=deferred();
  e.transport.beforePush=async()=>{entered.resolve();await gate.promise;};
  await e.client.change({drawingId,before:r,after:edit(r,'終了前の保存'),eventId:'closing'});
  const running=e.client.sync();await entered.promise;e.client.close();const statusCount=e.statuses.length;gate.resolve();await running.catch(()=>{});
  assert.equal(e.store.current().outbox.length,1,'late receipt cleared closed-session work');
  assert.equal(e.statuses.length,statusCount,'closed session emitted a status');
});
test('close fences an in-flight receive page before it can write local records',async()=>{
  const t=server();await t.push(event(base()));const gate=deferred(),entered=deferred();t.beforeList=async()=>{entered.resolve();await gate.promise;};
  const e=replica({transport:t});const starting=e.client.start();await entered.promise;e.client.close();gate.resolve();await starting.catch(()=>{});
  assert.equal(e.store.writes,0,'closed session applied a late receive page');
});
test('closed replicas reject new work and ignore queued reconnect/visibility wakes',async()=>{
  const e=replica();await e.client.start();e.client.close();const calls={...e.transport.calls};
  e.client.onOnline();e.client.onVisible();e.transport.notice();await delay(5);
  assert.deepEqual(e.transport.calls,calls);
  await assert.rejects(()=>e.client.change({drawingId,before:null,after:base(),eventId:'after-close'}),x=>x.code==='DELTA_CLOSED');
});
for(const identity of ['eventId','projectId','deviceId','drawingId','recordId'])test('a wrong '+identity+' in ACK cannot clear an outbox item',async()=>{
  const t=server();const push=t.push.bind(t);t.push=async e=>({...await push(e),[identity]:'unrelated'});const e=replica({transport:t});await e.client.start();
  await e.client.change({drawingId,before:null,after:base(),eventId:'ack-identity'});
  await assert.rejects(()=>e.client.sync(),x=>x.code==='DELTA_NOT_DURABLE');assert.equal(e.store.current().outbox.length,1);
});
test('an ACK with only a sequence number does not prove this operation was saved',async()=>{
  const t=server();t.push=async()=>({seq:99});const e=replica({transport:t});await e.client.start();await e.client.change({drawingId,before:null,after:base(),eventId:'ack-short'});
  await assert.rejects(()=>e.client.sync(),x=>x.code==='DELTA_NOT_DURABLE');assert.equal(e.store.current().outbox.length,1);
});
for(const field of ['ownerId','projectId','deviceId'])test('reopening '+field+' from another scope is rejected without a write',async()=>{
  const store=memory(scoped({scope:{...scope,[field]:'other'}})),e=replica({store});
  await assert.rejects(()=>e.client.start(),x=>x.code==='DELTA_SCOPE');assert.equal(store.writes,0);assert.equal(e.transport.calls.push,0);
});
test('unscoped prototype state is not silently adopted as another account',async()=>{
  const store=memory({version:1,cursor:0,records:{},outbox:[]}),e=replica({store});
  await assert.rejects(()=>e.client.start(),x=>x.code==='DELTA_SCOPE');assert.equal(store.writes,0);
});
test('UTF-8 bytes, not JavaScript character count, bound an event',()=>{
  const r=base(),next=edit(r,'写'.repeat(90000),'japanese');
  assert.throws(()=>D.diffRecord(r,next,{projectId,drawingId,deviceId,eventId:'utf8'}),x=>x.code==='DELTA_TOO_LARGE');
});
test('photo bytes hidden in an already-upgraded collaboration record are rejected',()=>{
  const r=C.addPhoto(base(),{id:'photo',sha256:'a'.repeat(64),size:8},{actor:{deviceId,deviceName:'A'},at:1,idFactory:()=> 'photo-rev'});
  const e=event(r);e.record.collab.photos.photo.revisions[0].value.data='data:image/jpeg;base64,AAAA';
  assert.throws(()=>D.validateEvent(e),x=>x.code==='DELTA_FILE_BYTES');
});
test('display-only photo entries also require a valid photo identifier',()=>{
  for(const photo of [{},null,7,'not-an-object']){
    const e=event(base());e.record.photos=[photo];
    assert.throws(()=>D.validateEvent(e),x=>x.code==='DELTA_EVENT');
  }
});
test('special map keys remain actual entries without prototype mutation',()=>{
  const r=base(),next=C.appendComment(r,'特殊IDのコメント',{commentId:'__proto__',revisionId:'special-revision',actor:{deviceId,deviceName:'A'},at:1});
  const delta=D.diffRecord(r,next,{projectId,drawingId,deviceId,eventId:'special'});assert(delta,'special-key edit vanished');
  const merged=D.combine(r,delta);assert(Object.hasOwn(merged.collab.comments,'__proto__'));assert(merged.memo.includes('特殊ID'));assert.equal({}.revisions,undefined);
});
test('a patch cannot be combined with a different record even under a caller mistake',()=>{
  const r=base(),delta=D.diffRecord(r,edit(r,'追加'),{projectId,drawingId,deviceId,eventId:'wrong-record'});
  assert.throws(()=>D.combine(base('record-B'),delta),x=>x.code==='DELTA_RECORD');
});
test('UI callback exceptions do not roll back or misreport a committed local save',async()=>{
  let shouldThrow=false;const e=replica({onStatus:()=>{if(shouldThrow)throw Error('UI render failed');}});await e.client.start();shouldThrow=true;
  await e.client.change({drawingId,before:null,after:base(),eventId:'observer'});assert.equal(e.store.current().outbox.length,1);
});
test('an actual foreign-project response stops before the receive cursor changes',async()=>{
  const e=replica();await e.client.start();const foreign=event(base());foreign.projectId='project-B';e.transport.list=async()=>[{seq:1,event:foreign}];
  await assert.rejects(()=>e.client.sync(),x=>x.code==='DELTA_FOREIGN');assert.equal((await e.client.snapshot()).cursor,0);
});
test('valid first row survives a malformed second row; retry resumes at the first row',async()=>{
  const e=replica({pageLimit:2});await e.client.start();const first=event(base()),second=event(base('record-B'),'create-B');let broken=true;
  e.transport.list=async(p,cursor)=>cursor===0?[{seq:1,event:first},{seq:broken?3:2,event:second}]:cursor===1?[{seq:broken?3:2,event:second}]:[];
  await assert.rejects(()=>e.client.sync(),x=>x.code==='DELTA_SEQUENCE_GAP');assert.equal((await e.client.snapshot()).cursor,1);
  broken=false;await e.client.sync();assert.equal((await e.client.snapshot()).cursor,2);assert.equal(Object.keys(e.store.current().records).length,2);
});
test('a repeated pending operation ID with different contents cannot poison the queue',async()=>{
  const e=replica();e.transport.connected=false;await e.client.start();const r=base();await e.client.change({drawingId,before:null,after:r,eventId:'same'});
  await assert.rejects(()=>e.client.change({drawingId,before:r,after:edit(r,'異なる内容'),eventId:'same'}),x=>x.code==='DELTA_COLLISION');
  assert.equal(e.store.current().outbox.length,1);assert.equal(e.store.current().records[key(r.id)].memo,r.memo);
});
test('a repeated double-tap of the exact pending operation is idempotent',async()=>{
  const e=replica();e.transport.connected=false;await e.client.start();const args={drawingId,before:null,after:base(),eventId:'double'};
  await e.client.change(args);const response=await e.client.change(args);assert.equal(response.duplicate,true);assert.equal(e.store.current().outbox.length,1);
});
test('non-finite values and cyclic values never enter a JSON event',()=>{
  const e=event(base());e.record.extra=NaN;assert.throws(()=>D.validateEvent(e),x=>x.code==='DELTA_EVENT');
  const cyclic=event(base());cyclic.loop=cyclic;assert.throws(()=>D.validateEvent(cyclic),x=>x.code==='DELTA_EVENT');
});

test('mutating a submitted draft cannot alter the queued edit',async()=>{
  const e=replica();e.transport.connected=false;await e.client.start();const draft=base();
  const saving=e.client.change({drawingId,before:null,after:draft,eventId:'immutable-submission'});
  draft.collab.comments[Object.keys(draft.collab.comments)[0]].revisions[0].text='呼出後に書き換え';
  await saving;assert.equal(e.store.current().records[key(draft.id)].memo,'元の記録');
});
test('non-finite values are rejected before record normalization can turn them into null',()=>{
  assert.throws(()=>D.diffRecord(null,{id:'raw-record',crackWidthMm:NaN},{projectId,drawingId,deviceId,eventId:'bad-number'}),x=>x.code==='DELTA_EVENT');
});

test('falsy malformed persisted values are not mistaken for a fresh database',async()=>{
  for(const stored of [false,0,'']){const e=replica({store:memory(stored)});
    await assert.rejects(()=>e.client.start(),x=>x.code==='DELTA_SCOPE');assert.equal(e.store.writes,0);}
});

function clock(){
  let now=0,serial=0;const tasks=new Map();
  const timers={setTimeout(fn,ms){const id=++serial;tasks.set(id,{at:now+ms,fn});return id;},clearTimeout(id){tasks.delete(id);}};
  return {timers,get size(){return tasks.size;},async advance(ms){const target=now+ms;let iterations=0;
    for(;;){for(let i=0;i<500;i++)await Promise.resolve();const due=[...tasks].filter(x=>x[1].at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!due)break;if(++iterations>1000)throw Error('unbounded timer loop');now=due[1].at;tasks.delete(due[0]);due[1].fn();}
    now=target;for(let i=0;i<500;i++)await Promise.resolve();
  }};
}
test('a lost notification is recovered by bounded cursor-only fallback',async()=>{
  const time=clock(),e=replica({timers:time.timers,reconcileIntervalMs:60000});await e.client.start();const calls=e.transport.calls.list;
  e.transport.rows.push({seq:1,event:event(base())});await time.advance(59999);assert.equal(e.transport.calls.list,calls);
  await time.advance(1);assert.equal(e.store.current().cursor,1);assert.equal(e.transport.calls.list,calls+1);
  e.client.close();await time.advance(600000);assert.equal(e.transport.calls.list,calls+1);assert.equal(time.size,0);
});
test('fallback does not send while hidden or offline and visibility resumes it',async()=>{
  const time=clock();let shown=false;const e=replica({timers:time.timers,reconcileIntervalMs:60000,visible:()=>shown});await e.client.start();const calls=e.transport.calls.list;
  await time.advance(120000);assert.equal(e.transport.calls.list,calls);shown=true;e.transport.connected=false;await time.advance(60000);assert.equal(e.transport.calls.list,calls);
  e.transport.connected=true;e.client.onVisible();await time.advance(0);assert.equal(e.transport.calls.list,calls+1);
});
test('a thousand duplicate notices are coalesced into one idle delta read',async()=>{
  const time=clock(),e=replica({timers:time.timers});await e.client.start();const calls=e.transport.calls.list;
  for(let i=0;i<1000;i++)e.transport.notice();await time.advance(0);assert.equal(e.transport.calls.list,calls+1);
});
test('transient server failure retries with a delay, then commits exactly once',async()=>{
  const time=clock(),e=replica({timers:time.timers,retryBaseMs:1000,retryMaxMs:4000});await e.client.start();const push=e.transport.push.bind(e.transport);let attempts=0;
  e.transport.push=async value=>{attempts++;if(attempts<3)throw Object.assign(Error('temporary'),{status:503});return push(value);};
  await e.client.change({drawingId,before:null,after:base(),eventId:'retry'});await time.advance(0);assert.equal(attempts,1);assert.equal(e.store.current().outbox.length,1);
  await time.advance(999);assert.equal(attempts,1);await time.advance(1);assert.equal(attempts,2);await time.advance(1999);assert.equal(attempts,2);await time.advance(1);
  assert.equal(attempts,3);assert.equal(e.transport.rows.length,1);assert.equal(e.store.current().outbox.length,0);
});
for(const status of [401,403])test('authentication error '+status+' does not become an automatic retry storm',async()=>{
  const time=clock(),e=replica({timers:time.timers});await e.client.start();let attempts=0;
  e.transport.push=async()=>{attempts++;throw Object.assign(Error('access denied'),{status,retryable:true});};
  await e.client.change({drawingId,before:null,after:base(),eventId:'denied'});await time.advance(0);await time.advance(1000000);
  assert.equal(attempts,1);assert.equal(e.store.current().outbox.length,1);
});
test('request deadline releases the network worker and late success cannot clear the queue',async()=>{
  const time=clock(),e=replica({timers:time.timers,requestTimeoutMs:1000,retryBaseMs:10000,retryMaxMs:10000});await e.client.start();
  e.transport.notices=false;const gate=deferred(),push=e.transport.push.bind(e.transport);e.transport.push=async(value,options)=>{await gate.promise;return push(value,options);};
  await e.client.change({drawingId,before:null,after:base(),eventId:'timeout'});await time.advance(0);await time.advance(1000);
  assert.equal(e.store.current().outbox.length,1);assert(e.statuses.some(s=>s.level==='warning'&&s.message.includes('時間内')));
  gate.resolve();await time.advance(0);assert.equal(e.store.current().outbox.length,1,'late response bypassed the expired request');
  e.transport.push=push;await e.client.sync();assert.equal(e.transport.rows.length,1);assert.equal(e.store.current().outbox.length,0);
});
test('successful server save plus failed receipt persistence is safely replayed',async()=>{
  const e=replica();await e.client.start();const push=e.transport.push.bind(e.transport);let first=true;
  e.transport.push=async value=>{const ack=await push(value);if(first){first=false;e.store.fail();}return ack;};
  await e.client.change({drawingId,before:null,after:base(),eventId:'receipt-disk-failure'});
  await assert.rejects(()=>e.client.sync(),/disk write failed/);assert.equal(e.store.current().outbox.length,1);
  await e.client.sync();assert.equal(e.transport.rows.length,1);assert.equal(e.store.current().outbox.length,0);
});
test('unresolved conflict has review status while another record still arrives',async()=>{
  const e=replica(),r=await seed(e),heads=C.view(r).fields.crackWidthMm.headIds;
  for(const [actor,value]of [['A',0.3],['B',0.4]]){const changed=C.setField(r,'crackWidthMm',value,{actor:{deviceId:actor,deviceName:actor},at:1,expectedHeads:heads,revisionId:'width-'+actor});
    e.transport.rows.push({seq:e.transport.rows.length+1,event:D.diffRecord(r,changed,{projectId,drawingId,deviceId:actor,eventId:'conflict-'+actor})});}
  e.transport.rows.push({seq:4,event:event(base('unrelated'),'unrelated')});await e.client.sync();
  assert.equal(e.statuses.at(-1).level,'review');assert.equal(e.statuses.at(-1).conflicts,1);assert(e.store.current().records[key('unrelated')]);
});
test('recovered outbox cannot cross the project boundary even with matching storage scope',async()=>{
  const pending=event(base());pending.projectId='another-project';const e=replica({store:memory(scoped({outbox:[pending]}))});
  await assert.rejects(()=>e.client.start(),x=>x.code==='DELTA_SCOPE');assert.equal(e.transport.calls.push,0);assert.equal(e.store.writes,0);
});
test('recovered records with mismatched map identity are not silently normalized',async()=>{
  const e=replica({store:memory(scoped({records:{[key('record-B')]:base()}}))});await assert.rejects(()=>e.client.start(),x=>x.code==='DELTA_LOCAL_STATE');assert.equal(e.store.writes,0);
});
test('stale storage CAS refusal preserves the caller edit and never claims it was saved',async()=>{
  const e=replica();await e.client.start();e.store.write=async()=>{throw Object.assign(Error('another tab wrote first'),{code:'DELTA_STORE_STALE'});};const draft=base();
  await assert.rejects(()=>e.client.change({drawingId,before:null,after:draft,eventId:'stale-store'}),x=>x.code==='DELTA_STORE_STALE');
  assert.equal(e.store.current(),null);assert.equal(draft.memo,'元の記録');assert.equal(e.statuses.filter(s=>s.level==='queued').length,0);
});
test('one rejected project cannot block a separately scoped project replica',async()=>{
  const broken=replica();await broken.client.start();broken.transport.push=async()=>{throw Object.assign(Error('access denied'),{status:403});};
  const healthy=replica({projectId:'healthy-project'});await healthy.client.start();
  await broken.client.change({drawingId,before:null,after:base(),eventId:'bad-project'});
  await healthy.client.change({drawingId,before:null,after:base(),eventId:'good-project'});
  const results=await Promise.allSettled([broken.client.sync(),healthy.client.sync()]);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
  assert.equal(broken.store.current().outbox.length,1);assert.equal(healthy.store.current().outbox.length,0);
});

let completed=false;
process.once('beforeExit',()=>{if(!completed){console.error('FAIL adversarial runner exited before completing all scenarios');process.exitCode=1;}});
(async()=>{let passed=0,failed=0;for(const [name,fn]of tests){try{await fn();console.log('PASS',name);passed++;}catch(error){console.error('FAIL',name,'\n'+(error.stack||error));failed++;}finally{for(const c of open.splice(0))try{c.close();}catch{}}}
  completed=true;console.log(`DELTA ADVERSARIAL RESULT ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// Isolated delta prototype: a rejected record must not poison the whole queue.
// No production server, photo repository or local user data is accessed.
const assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js');
const D=require('../sentlog/delta-sync-core.js');
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const ownerId='owner',projectId='project',deviceId='A',drawingId='drawing';
const record=(id,memo='initial')=>C.upgrade({
  id,kind:'field-record',recordKind:'field-record',recordType:'survey',
  type:'調査',page:1,memo,photos:[{id:'photo-'+id,name:id+'.jpg'}]
});
function store(initial=null){let disk=clone(initial),writes=0;
  return {async read(){return clone(disk);},async write(s){disk=clone(s);writes++;},
    snapshot(){return clone(disk);},get writes(){return writes;}};}
function makeTransport(){
  const rows=[],calls=[],errors=new Map(),online={value:false};
  return {rows,calls,errors,online,
    transport:{
      online:()=>online.value,
      async list(pid,cursor,limit){assert.equal(pid,projectId);return clone(rows.filter(r=>r.seq>cursor).slice(0,limit));},
      async push(event){
        calls.push(event.eventId);
        const bad=errors.get(event.eventId);
        if(bad)throw Object.assign(Error(bad.message),{code:bad.code,status:bad.status});
        const existing=rows.find(r=>r.event.eventId===event.eventId);
        if(existing){assert.deepEqual(existing.event,event);return {seq:existing.seq,
          projectId:event.projectId,eventId:event.eventId,deviceId:event.deviceId,
          drawingId:event.drawingId,recordId:event.recordId};}
        const row={seq:rows.length+1,event:clone(event)};rows.push(row);
        return {seq:row.seq,projectId:event.projectId,eventId:event.eventId,deviceId:event.deviceId,
          drawingId:event.drawingId,recordId:event.recordId};
      }
    }
  };
}
function replica(persistence,transport,statuses=[]){
  return D.createReplica({ownerId,projectId,deviceId,store:persistence,transport,
    reconcileIntervalMs:0,onStatus:s=>statuses.push(s)});
}
async function add(client,id,memo){
  return client.change({drawingId,before:null,after:record(id,memo),eventId:'create-'+id});
}
async function edit(client,id,eventId){
  const before=(await client.snapshot()).records[D.keyOf(drawingId,id)];
  let n=0;
  const after=C.appendComment(before,'追加の所見：'+eventId,{at:1234,
    actor:{deviceId,deviceName:'test-phone'},idFactory:()=>eventId+':'+(++n)});
  return client.change({drawingId,before,after,eventId});
}
let count=0;
async function test(label,fn){await fn();console.log('PASS '+label);count++;}
(async()=>{
await test('one rejected record is kept but unrelated record uploads and downloads',async()=>{
  const persistence=store(),server=makeTransport(),statuses=[],client=replica(persistence,server.transport,statuses);
  await client.start();await add(client,'A','写真Aあり');await add(client,'B','写真Bあり');
  const original=await client.snapshot();
  server.errors.set('create-A',{code:'22023',message:'DELTA_MISSING_BASE: no parent',status:400});
  server.online.value=true;
  const result=await client.sync();
  assert.equal(result.pushed,1);assert.equal(result.blocked,1);
  assert.equal(result.pending,0);assert.equal(result.cursor,1);
  const after=await client.snapshot();
  assert.deepEqual(after.blockedOutbox.map(x=>x.event.eventId),['create-A']);
  assert.equal(after.records[D.keyOf(drawingId,'A')].memo,'写真Aあり');
  assert.deepEqual(after.records[D.keyOf(drawingId,'A')].photos,original.records[D.keyOf(drawingId,'A')].photos);
  assert.equal(server.rows.length,1);assert.equal(server.rows[0].event.eventId,'create-B');
  assert.equal(statuses.at(-1).level,'review','not falsely labelled as all synced');
  assert.equal(statuses.at(-1).blocked,1);
  assert.deepEqual(server.calls,['create-A','create-B']);
  client.close();
  const reopened=replica(persistence,server.transport);
  await reopened.start();
  assert.equal((await reopened.snapshot()).blockedOutbox.length,1);
  await reopened.sync();assert.deepEqual(server.calls,['create-A','create-B'],'restart may not hammer rejected data');
  reopened.close();
});
await test('later edits of the rejected record remain protected; other new records still send',async()=>{
  const persistence=store(),server=makeTransport(),client=replica(persistence,server.transport);
  await client.start();await add(client,'A');await add(client,'B');
  server.errors.set('create-A',{code:'22023',message:'DELTA_RECORD_ALREADY_EXISTS',status:400});
  server.online.value=true;await client.sync();
  const old=(await client.snapshot()).records[D.keyOf(drawingId,'A')];
  await edit(client,'A','amend-A');
  await add(client,'C');
  await client.sync();
  const now=await client.snapshot();
  assert.deepEqual(now.blockedOutbox.map(x=>x.event.eventId),['create-A','amend-A']);
  assert.deepEqual(server.rows.map(x=>x.event.eventId),['create-B','create-C']);
  assert(now.records[D.keyOf(drawingId,'A')].memo.includes('amend-A'));
  assert.equal(now.outbox.length,0);
  assert.equal(server.calls.filter(x=>x==='create-A').length,1);
  client.close();
});
await test('rejecting the first edit also quarantines a later same-record dependency',async()=>{
  const persistence=store(),server=makeTransport(),client=replica(persistence,server.transport);
  await client.start();
  await add(client,'A');await edit(client,'A','A2');await add(client,'B');
  server.errors.set('create-A',{code:'22023',message:'DELTA_UNKNOWN_PARENT',status:400});
  server.online.value=true;const result=await client.sync();
  assert.deepEqual((await client.snapshot()).blockedOutbox.map(x=>x.event.eventId),['create-A','A2']);
  assert.deepEqual(server.rows.map(x=>x.event.eventId),['create-B']);
  assert.equal(result.blocked,2);
  client.close();
});
await test('a transient network failure never quarantines any record',async()=>{
  const persistence=store(),server=makeTransport(),client=replica(persistence,server.transport);
  await client.start();await add(client,'A');await add(client,'B');
  server.errors.set('create-A',{code:'PGRST503',message:'service unavailable',status:503});
  server.online.value=true;
  await assert.rejects(()=>client.sync(),/service unavailable/);
  const now=await client.snapshot();
  assert.equal(now.blockedOutbox?.length||0,0);
  assert.deepEqual(now.outbox.map(x=>x.eventId),['create-A','create-B']);
  assert.equal(server.rows.length,0);
  client.close();
});
await test('permission failure pauses all writes without calling it a record conflict',async()=>{
  const persistence=store(),server=makeTransport(),client=replica(persistence,server.transport);
  await client.start();await add(client,'A');await add(client,'B');
  server.errors.set('create-A',{code:'42501',message:'DELTA_UNKNOWN_PARENT',status:403});
  server.online.value=true;
  await assert.rejects(()=>client.sync(),/DELTA_UNKNOWN_PARENT/);
  const now=await client.snapshot();
  assert.equal(now.blockedOutbox?.length||0,0);
  assert.deepEqual(now.outbox.map(e=>e.eventId),['create-A','create-B']);
  client.close();
});
await test('matching retries of a blocked operation are idempotent and do not erase the reason',async()=>{
  const persistence=store(),server=makeTransport(),client=replica(persistence,server.transport);
  await client.start();const after=record('A'),r={drawingId,before:null,after,eventId:'create-A'};
  await client.change(r);
  server.errors.set('create-A',{code:'22023',message:'DELTA_UNKNOWN_PARENT',status:400});
  server.online.value=true;await client.sync();
  assert.equal((await client.change(r)).duplicate,true);
  assert.equal((await client.snapshot()).blockedOutbox.length,1);
  assert.equal(server.calls.length,1);
  client.close();
});
await test('corrupt or foreign quarantine state is rejected rather than clearing it',async()=>{
  const scope={ownerId,projectId,deviceId};
  const stored={version:2,scope,cursor:0,records:{},outbox:[],blockedOutbox:[
    {event:{schema:1,eventId:'a',projectId:'foreign',drawingId:'d',recordId:'r',
      deviceId,kind:'patch',patch:{comments:{},fields:{},photos:{},deletion:[]}},
    reason:{code:'DELTA_MISSING_BASE',message:'please review'}}]};
  const persistence=store(stored),client=replica(persistence,makeTransport().transport);
  await assert.rejects(()=>client.start(),/変更内容が空です|別案件/);
  assert.deepEqual(persistence.snapshot(),stored);
  client.close();
});
console.log('PASS rejected-event per-record isolation:',count,'cases');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});

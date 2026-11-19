'use strict';
const assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js');
const D=require('../sentlog/delta-sync-core.js');
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
const project='p1',drawing='d1',recordId='survey-1';
const opts=(device,task,time=100000)=>{let n=0;return {
  actor:{deviceId:device,deviceName:device},at:time,idFactory:()=>device+':'+task+':'+(++n)
}};
function initial(id=recordId){
  return C.upgrade({id,recordKind:'field-record',kind:'field-record',recordType:'survey',
    type:'調査',page:1,point:{x:1,y:2},memo:'既存コメント',
    photos:[{id:'original',name:'元写真.jpg',sha256:'a'.repeat(64),size:4}],
    crackWidthMm:0.2});
}
function store(initialState){
  let data=initialState?clone(initialState):null,fail=0,writes=0;
  return {async read(){return clone(data);},
    async write(next){if(fail){fail--;throw Error('端末の保存容量不足');}writes++;data=clone(next);},
    failNext(n=1){fail=n;},get writes(){return writes;},current(){return clone(data);}};
}
function fakeServer(){
  const logs=new Map(),dedupe=new Map(),listeners=new Set(),flags=new Map();
  const stats={push:0,read:0,events:0,notice:0};
  function transport(device){
    const flag={online:true,dropNotice:false,badGap:false,offlineOnce:false,version:1};
    flags.set(device,flag);
    return {
      get flag(){return flag;},
      online(){return flag.online;},
      async push(event){
        if(!flag.online||flag.offlineOnce){flag.offlineOnce=false;throw Error('network unavailable');}
        if(flag.version<1)throw Object.assign(Error('アップデートが必要です'),{code:'UPGRADE_REQUIRED'});
        D.validateEvent(event);
        const id=event.projectId+':'+event.eventId,encoded=JSON.stringify(C.canonical(event));
        stats.push++;
        if(dedupe.has(id)){
          const row=dedupe.get(id);
          if(row.encoded!==encoded)throw Object.assign(Error('Operation ID collision'),{code:'DUPLICATE_DIFFERENT_EVENT'});
          return {seq:row.seq};
        }
        const rows=logs.get(event.projectId)||[],seq=rows.length+1;
        rows.push({seq,event:clone(event)});logs.set(event.projectId,rows);
        dedupe.set(id,{seq,encoded});stats.events++;
        for(const sub of listeners)if(sub.projectId===event.projectId){
          const dest=flags.get(sub.device);
          if(!dest?.online||dest.dropNotice)continue;
          stats.notice++;sub.callback({projectId:event.projectId,seq});
        }
        return {seq};
      },
      async list(projectId,cursor,limit){
        if(!flag.online)throw Error('network unavailable');
        stats.read++;
        const rows=logs.get(projectId)||[];
        let result=rows.filter(row=>row.seq>cursor).slice(0,limit);
        if(flag.badGap&&result.length){flag.badGap=false;result=result.map((row,i)=>({...row,seq:row.seq+1}));}
        return clone(result);
      },
      subscribe(projectId,callback){
        const entry={device,projectId,callback};listeners.add(entry);
        return ()=>listeners.delete(entry);
      }
    };
  }
  return {transport,stats,rows:p=>clone(logs.get(p)||[]),announce(p){
    const seq=(logs.get(p)||[]).length;
    for(const l of listeners)if(l.projectId===p&&flags.get(l.device)?.online)
      l.callback({projectId:p,seq});
  }};
}
function environment(names=['A','B'],config={}){
  const server=fakeServer(),clients={},stores={},transports={},statuses={};
  for(const id of names){
    stores[id]=store();transports[id]=server.transport(id);statuses[id]=[];
    clients[id]=D.createReplica({projectId:project,deviceId:id,store:stores[id],
      transport:transports[id],pageLimit:config.pageLimit||8,onStatus:x=>statuses[id].push(x)});
  }
  return {server,clients,stores,transports,statuses};
}
function get(snapshot,id=recordId){return snapshot.records[D.keyOf(drawing,id)];}
async function bootstrap(env,first='A'){
  for(const client of Object.values(env.clients))await client.start();
  const seeded=initial();await env.clients[first].change({
    drawingId:drawing,before:null,after:seeded,eventId:'seed:'+seeded.id});
  await env.clients[first].sync();
  for(const client of Object.values(env.clients))await client.sync();
  return seeded;
}
async function tick(){for(let i=0;i<80;i++)await Promise.resolve();}
async function recordChange(client,fn,eventId,id=recordId){
  const snapshot=await client.snapshot(),before=get(snapshot,id)||null;
  const after=fn(before);
  return client.change({drawingId:drawing,before,after,eventId});
}
let count=0,failed=0;
async function test(label,fn){
  try{await fn();console.log('PASS',label);count++;}
  catch(e){failed++;console.error('FAIL',label,':',e.stack||e);throw e;}
}
(async()=>{
await test('two clients receive a new record with no periodic polling',async()=>{
  const e=environment();await bootstrap(e);await tick();
  const a=get(await e.clients.A.snapshot()),b=get(await e.clients.B.snapshot());
  assert(C.equal(a,b));assert.equal(e.server.stats.events,1);
  assert.equal(e.clients.B.snapshot instanceof Function,true);
});
await test('simultaneous different comments and photos converge without loss',async()=>{
  const e=environment();await bootstrap(e);
  e.transports.A.flag.online=false;e.transports.B.flag.online=false;
  await recordChange(e.clients.A,r=>C.addPhoto(C.appendComment(r,'Aのコメント',opts('A','comment')),
    {id:'pa',name:'A.jpg',sha256:'b'.repeat(64),size:11},opts('A','photo')),'A1');
  await recordChange(e.clients.B,r=>C.addPhoto(C.appendComment(r,'Bのコメント',opts('B','comment')),
    {id:'pb',name:'B.jpg',sha256:'c'.repeat(64),size:13},opts('B','photo')),'B1');
  e.transports.A.flag.online=true;e.transports.B.flag.online=true;
  await Promise.all([e.clients.A.sync(),e.clients.B.sync()]);await tick();
  await Promise.all([e.clients.A.sync(),e.clients.B.sync()]);
  for(const id of ['A','B']){
    const s=await e.clients[id].snapshot(),r=get(s);
    assert.equal(s.outbox.length,0);assert.equal(s.cursor,3);
    assert(r.memo.includes('Aのコメント')&&r.memo.includes('Bのコメント'));
    assert.deepEqual(new Set(r.photos.map(p=>p.id)),new Set(['original','pa','pb']));
  }
});
await test('simultaneous same field different values become a review conflict',async()=>{
  const e=environment();await bootstrap(e);
  e.transports.A.flag.online=false;e.transports.B.flag.online=false;
  await recordChange(e.clients.A,r=>C.setField(r,'crackWidthMm',0.3,{...opts('A','width',100),expectedHeads:C.view(r).fields.crackWidthMm.headIds}),'A-w');
  await recordChange(e.clients.B,r=>C.setField(r,'crackWidthMm',0.4,{...opts('B','width',100),expectedHeads:C.view(r).fields.crackWidthMm.headIds}),'B-w');
  e.transports.A.flag.online=true;e.transports.B.flag.online=true;
  await Promise.all([e.clients.A.sync(),e.clients.B.sync()]);
  await Promise.all([e.clients.A.sync(),e.clients.B.sync()]);
  for(const c of Object.values(e.clients)){
    const r=get(await c.snapshot());
    assert.equal(r.crackWidthMm,0.2);
    assert(C.view(r).fields.crackWidthMm.conflict);
  }
});
await test('100ms apart still conflicts if a change was unseen',async()=>{
  const e=environment();await bootstrap(e);
  e.transports.A.flag.online=false;e.transports.B.flag.online=false;
  await recordChange(e.clients.A,r=>C.setField(r,'crackWidthMm',0.3,{...opts('A','short',100000),expectedHeads:C.view(r).fields.crackWidthMm.headIds}),'Ashort');
  await recordChange(e.clients.B,r=>C.setField(r,'crackWidthMm',0.4,{...opts('B','short',100100),expectedHeads:C.view(r).fields.crackWidthMm.headIds}),'Bshort');
  e.transports.A.flag.online=true;e.transports.B.flag.online=true;
  await Promise.all([e.clients.A.sync(),e.clients.B.sync()]);
  await e.clients.B.sync();await e.clients.A.sync();
  assert(C.view(get(await e.clients.A.snapshot())).fields.crackWidthMm.conflict);
});
await test('change to already observed value follows normal sequential edit',async()=>{
  const e=environment();await bootstrap(e);
  await recordChange(e.clients.A,r=>C.setField(r,'crackWidthMm',0.3,{...opts('A','w1'),expectedHeads:C.view(r).fields.crackWidthMm.headIds}),'new-1');
  await e.clients.A.sync();await e.clients.B.sync();
  await recordChange(e.clients.B,r=>C.setField(r,'crackWidthMm',0.4,{...opts('B','w2'),expectedHeads:C.view(r).fields.crackWidthMm.headIds}),'new-2');
  await e.clients.B.sync();await e.clients.A.sync();
  assert.equal(get(await e.clients.A.snapshot()).crackWidthMm,0.4);
  assert.equal(C.view(get(await e.clients.B.snapshot())).fields.crackWidthMm.conflict,false);
});
await test('offline queue survives restart and replays automatically after reconnection',async()=>{
  const e=environment();await bootstrap(e);
  e.transports.B.flag.online=false;
  await recordChange(e.clients.B,r=>C.appendComment(r,'圏外で記録した内容',opts('B','offline')),'offline-op');
  assert.equal((await e.clients.B.snapshot()).outbox.length,1);
  e.clients.B.close();
  const restarted=D.createReplica({projectId:project,deviceId:'B',store:e.stores.B,transport:e.transports.B});
  await restarted.start();assert.equal((await restarted.snapshot()).outbox.length,1);
  e.transports.B.flag.online=true;
  restarted.onOnline();await tick();await restarted.sync();await e.clients.A.sync();
  assert.equal((await restarted.snapshot()).outbox.length,0);
  assert(get(await e.clients.A.snapshot()).memo.includes('圏外で記録した内容'));
});
await test('server saves an event but client loses response; retry is idempotent',async()=>{
  const e=environment();await bootstrap(e);
  await recordChange(e.clients.A,r=>C.appendComment(r,'一回だけ',opts('A','once')),'once-op');
  const transport=e.transports.A,push=transport.push.bind(transport);
  let first=true;transport.push=async event=>{
    const out=await push(event);
    if(first){first=false;e.transports.A.flag.online=false;throw Error('reply lost');}return out;
  };
  await assert.rejects(()=>e.clients.A.sync(),/reply lost/);
  assert.equal((await e.clients.A.snapshot()).outbox.length,1,'unacknowledged change remains in the durable queue');
  e.transports.A.flag.online=true;
  await e.clients.A.sync();
  assert.equal((await e.clients.A.snapshot()).outbox.length,0);
  assert.equal(e.server.rows(project).filter(x=>x.event.eventId==='once-op').length,1);
});
await test('a failed local save cannot move the confirmed receive cursor',async()=>{
  const e=environment();await bootstrap(e);
  e.transports.B.flag.dropNotice=true;
  await recordChange(e.clients.A,r=>C.appendComment(r,'Aの到着待ち',opts('A','fail-store')),'op-fail-store');
  await e.clients.A.sync();
  const saved=(await e.clients.B.snapshot()).cursor;
  e.stores.B.failNext();
  await assert.rejects(()=>e.clients.B.sync(),/保存容量不足/);
  assert.equal((await e.clients.B.snapshot()).cursor,saved);
  await e.clients.B.sync();assert.equal((await e.clients.B.snapshot()).cursor,saved+1);
});
await test('a write failure before queueing a change retains the original',async()=>{
  const e=environment();await bootstrap(e);
  const before=await e.clients.A.snapshot();e.stores.A.failNext();
  await assert.rejects(()=>recordChange(e.clients.A,r=>C.appendComment(r,'失敗する下書き',opts('A','fail-change')),'op-fail-change'),/容量不足/);
  assert.equal(C.equal(get(await e.clients.A.snapshot()),get(before)),true);
  assert.equal((await e.clients.A.snapshot()).outbox.length,0);
});
await test('a missing sequence stops safely and resumes only when gap is filled',async()=>{
  const e=environment();await bootstrap(e);
  e.transports.B.flag.dropNotice=true;
  await recordChange(e.clients.A,r=>C.appendComment(r,'最初',opts('A','gap')),'gap-one');
  await e.clients.A.sync();
  const current=(await e.clients.B.snapshot()).cursor;
  e.transports.B.flag.badGap=true;
  await assert.rejects(()=>e.clients.B.sync(),error=>error.code==='DELTA_SEQUENCE_GAP');
  assert.equal((await e.clients.B.snapshot()).cursor,current);
  await e.clients.B.sync();assert.equal((await e.clients.B.snapshot()).cursor,current+1);
});
await test('old versions are refused but their local pending edits remain',async()=>{
  const e=environment();await bootstrap(e);
  await recordChange(e.clients.A,r=>C.appendComment(r,'旧端末の下書き',opts('A','old')),'old-client');
  e.transports.A.flag.version=0;
  await assert.rejects(()=>e.clients.A.sync(),error=>error.code==='UPGRADE_REQUIRED');
  assert.equal((await e.clients.A.snapshot()).outbox.length,1);
  e.transports.A.flag.version=1;await e.clients.A.sync();
  assert.equal((await e.clients.A.snapshot()).outbox.length,0);
});
await test('same operation identifier with different payload is rejected',async()=>{
  const e=environment();await bootstrap(e);
  await recordChange(e.clients.A,r=>C.appendComment(r,'A',opts('A','collision')),'reuse');
  await e.clients.A.sync();
  const row=e.server.rows(project).find(r=>r.event.eventId==='reuse');
  const modified=clone(row.event);modified.patch.comments[Object.keys(modified.patch.comments)[0]].revisions[0].text='B';
  await assert.rejects(()=>e.transports.A.push(modified),error=>error.code==='DUPLICATE_DIFFERENT_EVENT');
});
await test('stale edit from an out-of-date inspector is rejected without a write',async()=>{
  const e=environment();await bootstrap(e);
  const old=get(await e.clients.A.snapshot());
  await recordChange(e.clients.A,r=>C.appendComment(r,'先に編集',opts('A','first')),'first');
  const bad=C.appendComment(old,'古い選択画面',opts('A','stale'));
  await assert.rejects(()=>e.clients.A.change({drawingId:drawing,before:old,after:bad,eventId:'stale'}),
    error=>error.code==='DELTA_STALE');
  assert.equal((await e.clients.A.snapshot()).outbox.length,1);
});
await test('a changed PHOTO ID is never silently overwritten',async()=>{
  const base=initial(),next=C.addPhoto(base,{id:'photo',name:'first.jpg',size:44},opts('A','photo-id'));
  const event=D.diffRecord(base,next,{eventId:'m1',projectId:project,drawingId:drawing,deviceId:'A'});
  const modified=clone(event),id=Object.keys(modified.patch.photos)[0];
  const target=C.combine(base,event);
  modified.patch.photos[id].revisions[0].value.name='different.jpg';
  assert.throws(()=>D.combine(target,modified),error=>error.code==='DELTA_COLLISION');
});
await test('wrong project and missing record payloads cannot advance cursor',async()=>{
  const e=environment();await bootstrap(e);
  const prior=await e.clients.A.snapshot();
  const wrong={schema:1,eventId:'e',projectId:'wrong',drawingId:drawing,recordId:recordId,deviceId:'A',kind:'patch',
    patch:{comments:{},fields:{},photos:{},deletion:[]}};
  const transport=e.transports.A;
  const p=transport.push.bind(transport);
  await p(wrong);
  const cursor=(await e.clients.A.snapshot()).cursor;
  await e.clients.A.sync();
  assert.equal((await e.clients.A.snapshot()).cursor,cursor);
  assert.deepEqual(prior.records,(await e.clients.A.snapshot()).records);
});
await test('unseen notifications require no idle polling but reconnect catches up',async()=>{
  const e=environment();await bootstrap(e);
  const before=e.server.stats.read;
  await tick();await tick();
  assert.equal(e.server.stats.read,before,'idle clients do not poll');
  e.transports.B.flag.online=false;
  await recordChange(e.clients.A,r=>C.appendComment(r,'Bが不在の間の変更',opts('A','notice')),'notice-op');
  await e.clients.A.sync();const earlier=(await e.clients.B.snapshot()).cursor;
  e.transports.B.flag.online=true;e.clients.B.onOnline();
  await tick();await e.clients.B.sync();
  assert.equal((await e.clients.B.snapshot()).cursor,earlier+1);
  assert(get(await e.clients.B.snapshot()).memo.includes('Bが不在の間の変更'));
});
await test('multiple same-client clicks produce unique record changes but repeated transport IDs do not',async()=>{
  const e=environment();await bootstrap(e);
  const base=get(await e.clients.A.snapshot());
  const first=C.appendComment(base,'押した1回目',opts('A','click1'));
  const second=C.appendComment(first,'押した2回目',opts('A','click2'));
  await e.clients.A.change({drawingId:drawing,before:base,after:first,eventId:'click1'});
  await e.clients.A.change({drawingId:drawing,before:first,after:second,eventId:'click2'});
  await e.clients.A.sync();await e.clients.B.sync();
  assert.equal(C.view(get(await e.clients.B.snapshot())).comments.length,3);
  assert.equal(e.server.rows(project).filter(r=>/click/.test(r.event.eventId)).length,2);
});
await test('three devices edit during an outage and converge without duplicate photos',async()=>{
  const e=environment(['A','B','C'],{pageLimit:2});await bootstrap(e);
  for(const name of ['A','B','C'])e.transports[name].flag.online=false;
  for(const name of ['A','B','C']){
    await recordChange(e.clients[name],r=>C.addPhoto(C.appendComment(r,name,opts(name,'3-device')),
      {id:'capture-'+name,name:name+'.jpg',size:10,sha256:name.repeat(64)},opts(name,'3-photo')),'write-'+name);
  }
  for(const name of ['A','B','C'])e.transports[name].flag.online=true;
  await Promise.all(Object.values(e.clients).map(c=>c.sync()));
  await Promise.all(Object.values(e.clients).map(c=>c.sync()));
  for(const name of ['A','B','C']){
    const s=await e.clients[name].snapshot(),r=get(s);
    assert.equal(s.cursor,4);
    assert.equal(new Set(r.photos.map(p=>p.id)).size,4);
    assert(C.view(r).comments.length>=4);
  }
});
await test('burst of 120 events replays in bounded sequential pages without losing one',async()=>{
  const e=environment(['A','B'],{pageLimit:11});await bootstrap(e);
  e.transports.B.flag.online=false;
  for(let i=0;i<120;i++){
    await recordChange(e.clients.A,r=>C.appendComment(r,'entry-'+i,opts('A','burst-'+i)),
      'entry-event-'+i);
  }
  await e.clients.A.sync();e.transports.B.flag.online=true;
  await e.clients.B.sync();
  const r=get(await e.clients.B.snapshot());
  assert.equal((await e.clients.B.snapshot()).cursor,121);
  assert.equal(C.view(r).comments.length,121);
  assert.equal(new Set(C.view(r).comments.map(x=>x.id)).size,121);
  assert.equal((await e.clients.B.snapshot()).outbox.length,0);
});
console.log('DELTA PROTOCOL TEST RESULT '+count+' passed, '+failed+' failed; prototype only, no production data altered.');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

'use strict';
// Real PostgreSQL JSONB serialization in an in-process PGlite instance.
// Auth is synthetic; no URL, real token, or live database is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const D=require('../sentlog/delta-sync-core.js'),T=require('../sentlog/delta-sync-transport.js');
const scope={ownerId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',projectId:'55555555-1111-4111-8111-111111111111',
  deviceId:'aaaaaaaa-0000-4000-8000-000000000001'};
const clone=x=>JSON.parse(JSON.stringify(x)),MiB=1024*1024;
function event(n,length=0){const actor={deviceId:scope.deviceId,deviceName:'契約テスト'};
  return {schema:1,eventId:'byte-event-'+n,projectId:scope.projectId,deviceId:scope.deviceId,drawingId:'図面😀',recordId:'記録-'+n,kind:'create',
    record:{id:'記録-'+n,measurements:[1e21,1e-27,-5e-324,-1.25e35,1.005],
      collab:{version:1,fields:{},photos:{},comments:{c:{order:0,revisions:[{id:'text-'+n,parents:[],actor,at:1,
        text:'測定😀e\u0301\n\t"\\'+'x'.repeat(length),deleted:false}]}},deletion:{revisions:[{id:'alive-'+n,parents:[],actor,at:1,deleted:false,observed:[]}]}}}};
}
function group(id,events){return {schema:1,kind:'atomic-group',groupId:id,projectId:scope.projectId,deviceId:scope.deviceId,events};}
const text=e=>e.record.collab.comments.c.revisions[0];
(async()=>{const db=new PGlite();let transport;try{
  for(const file of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql',
    'docs/sentlog-delta-semantic-validation-prototype.sql','tests/delta_baseline_fixture.sql',
    'docs/sentlog-delta-baseline-prototype.sql','tests/delta_transport_fixture.sql',
    'docs/sentlog-delta-transport-prototype.sql','docs/sentlog-delta-atomic-groups-prototype.sql']){
    await db.exec(fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,''));
  }
  await db.query("INSERT INTO public.sentlog_projects(id,owner_id,status) VALUES($1,$2,'active')",[scope.projectId,scope.ownerId]);
  await db.query("INSERT INTO sentlog_delta_private.heads(project_id,owner_id,enabled,activated_at) VALUES($1,$2,true,now())",[scope.projectId,scope.ownerId]);
  await db.exec('SET ROLE authenticated');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[scope.ownerId]);
  const bytes=async value=>(await db.query('SELECT octet_length($1::jsonb::text) AS bytes',[JSON.stringify(value)])).rows[0].bytes;
  const calls=[];
  const rpc=async(name,args,options)=>{
    calls.push({name,args,options});
    const definitions={
      sentlog_delta_capabilities_v1:['SELECT public.sentlog_delta_capabilities_v1($1,$2) AS data',[args.p_project_id,args.p_device_id]],
      sentlog_delta_append_group_v1:['SELECT public.sentlog_delta_append_group_v1($1,$2,$3::jsonb) AS data',[args.p_project_id,args.p_device_id,JSON.stringify(args.p_group)]],
      sentlog_delta_append_v1:['SELECT public.sentlog_delta_append_v1($1,$2,$3,$4,$5,$6::jsonb) AS data',
        [args.p_project_id,args.p_device_id,args.p_event_id,args.p_drawing_id,args.p_record_id,JSON.stringify(args.p_envelope)]],
      sentlog_delta_list_groups_v1:['SELECT public.sentlog_delta_list_groups_v1($1,$2,$3,$4) AS data',[args.p_project_id,args.p_device_id,args.p_after,args.p_limit]]
    };
    assert(definitions[name],'unexpected RPC '+name);
    try{const [sql,params]=definitions[name];return {data:(await db.query(sql,params)).rows[0].data,error:null};}
    catch(error){return {data:null,error:{code:error.code,message:error.message}};}
  };
  const session={access_token:'synthetic',user:{id:scope.ownerId}};
  transport=T.createTransport({scope,currentScope:()=>scope,requestTimeoutMs:30000,provider:{
    getSession:async()=>session,peekSession:()=>session,getUser:async()=>session.user,rpc}});
  await transport.ready();assert.equal(transport.getCapabilities().atomicGroups,true);

  const g=group('exact-group-limit',Array.from({length:20},(_,i)=>event(i,200000)));
  let padding=4*MiB-await bytes(g);assert(padding>0);
  for(const e of g.events){const add=Math.min(45000,padding);text(e).text+='x'.repeat(add);padding-=add;}
  assert.equal(padding,0);assert.equal(await bytes(g),4*MiB);D.validateGroup(g);
  assert(Buffer.byteLength(JSON.stringify(g),'utf8')<4*MiB,'compact JSON must differ from PostgreSQL expanded numbers and spaces');
  const result=await transport.pushGroup(g);assert.equal(result.startSeq,1);assert.equal(result.endSeq,20);assert.equal(result.events.length,20);
  assert.equal(result.duplicate,false);
  const page=await transport.list(scope.projectId,0,1);assert.equal(page.length,1);assert.equal(page[0].endSeq,20);
  assert.equal(page[0].group.events.length,20);assert.equal(page.hasMore,false);
  assert.equal(await bytes(page[0].group),4*MiB);
  assert.equal(page[0].group.events[0].record.measurements[2],-5e-324);
  console.log('PASS core + transport + SQL accept an exact 4 MiB group with Unicode, escapes and exponent-expanded numbers; one intact page');

  const oversized=clone(g);text(oversized.events.at(-1)).text+='x';assert.equal(await bytes(oversized),4*MiB+1);
  const before=calls.length;assert.throws(()=>transport.pushGroup(oversized),{code:'DELTA_GROUP_TOO_LARGE'});assert.equal(calls.length,before);
  await assert.rejects(db.query('SELECT public.sentlog_delta_append_group_v1($1,$2,$3::jsonb)',
    [scope.projectId,scope.deviceId,JSON.stringify(oversized)]),e=>e.code==='54000'&&/DELTA_GROUP_TOO_LARGE/.test(e.message));
  console.log('PASS 4 MiB + 1 UTF-8 byte is rejected independently by client and SQL');

  const reordered=Object.fromEntries(Object.entries(g).reverse());const retry=await transport.pushGroup(reordered);
  assert.equal(retry.duplicate,true);assert.equal(retry.startSeq,1);assert.equal(retry.endSeq,20);
  await assert.rejects(transport.list(scope.projectId,19,1),e=>e.code==='DELTA_GROUP_CURSOR_INSIDE');
  console.log('PASS exact JSONB content retries preserve the original range; an internal cursor is refused');

  const exactEvent=event(1000);text(exactEvent).text+='x'.repeat(256*1024-await bytes(exactEvent));
  assert.equal(await bytes(exactEvent),256*1024);const one=group('exact-event-limit',[exactEvent]);D.validateGroup(one);
  const accepted=await transport.pushGroup(one);assert.equal(accepted.startSeq,21);assert.equal(accepted.endSeq,21);
  const largeEvent=clone(one);text(largeEvent.events[0]).text+='x';assert.equal(await bytes(largeEvent.events[0]),256*1024+1);
  assert.throws(()=>D.validateGroup(largeEvent),{code:'DELTA_TOO_LARGE'});
  await assert.rejects(db.query('SELECT public.sentlog_delta_append_group_v1($1,$2,$3::jsonb)',
    [scope.projectId,scope.deviceId,JSON.stringify(largeEvent)]),e=>e.code==='22023'&&/DELTA_PAYLOAD_INVALID/.test(e.message));
  console.log('PASS per-event PostgreSQL 256 KiB boundary agrees with client validation');

  const solo=event(1001);const soloAck=await transport.push(solo);assert.equal(soloAck.seq,22);
  const tail=await transport.list(scope.projectId,20,2);assert.equal(tail.length,2);assert.equal(tail[0].endSeq,21);
  assert.equal(tail[1].event.eventId,solo.eventId);assert.equal(tail[1].seq,22);assert.equal(tail.hasMore,false);
  console.log('PASS old solo outbox and grouped units coexist through the real RPC transport');
  console.log('delta group byte and RPC contract: 5 scenarios passed');
}finally{transport?.close();await db.close();}})().catch(error=>{
  console.error({code:error.code,message:String(error.message).slice(0,1500)});process.exitCode=1;
});

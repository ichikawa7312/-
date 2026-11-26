'use strict';
// Native PostgreSQL integration/performance test, NEVER Supabase. The harness
// creates its own disposable database on a loopback server. It reads no real
// project profile, user record, credential file, or hosted API URL.
// PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres node tests/delta_activation_native.cjs --activation-budget-ms=30000
// The 8 s statement deadline is always exercised even with a 30 s request budget.
if(!globalThis.crypto)globalThis.crypto=require('node:crypto').webcrypto;
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {Client}=require('pg');
const {generate}=require('./delta_activation_synthetic.cjs');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const patch='docs/sentlog-delta-activation-scalability.sql';
const owner='11000000-0000-4000-8000-000000000001',other='11000000-0000-4000-8000-000000000002';
const phone='22000000-0000-4000-8000-000000000001',tablet='22000000-0000-4000-8000-000000000002';
const host=process.env.PGHOST||'127.0.0.1',port=Number(process.env.PGPORT||55432);
assert(['127.0.0.1','::1','localhost'].includes(host),'native tests accept loopback hosts only');
assert(!process.env.DATABASE_URL,'DATABASE_URL is not used by this local-only harness');
assert(Number.isSafeInteger(port)&&port>0&&port<65536);
const cfg={host,port,user:process.env.PGUSER||'postgres',database:process.env.PGDATABASE||'postgres'};
const database='sentlog_activation_native_'+process.pid+'_'+Date.now();
const keep=process.env.SENTLOG_NATIVE_KEEP==='1',beforeOnly=process.argv.includes('--before-only');
const budgetArg=process.argv.find(x=>x.startsWith('--activation-budget-ms='));
const budget=budgetArg?Number(budgetArg.split('=')[1]):8000;
assert(Number.isSafeInteger(budget)&&budget>=8000&&budget<=30000);
const selected=process.argv.includes('--compact-only')?['compact']:process.argv.includes('--wide-only')?['wide']:['compact','wide'];
const proof={writerVersion:2,migrationId:'synthetic-native',sourceFingerprint:'a'.repeat(64),planSha256:'b'.repeat(64)};
const report={engine:'native PostgreSQL',database,activationBudgetMs:budget,profiles:[],checks:[]};
let admin,db,created=false;
const createdRoles=[];
const connections=new Set();
const val=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0]?.result;
async function newClient(){
 const c=new Client({...cfg,database});await c.connect();connections.add(c);
 // Match the observed hosted instance's CPU/planner settings. PostgreSQL's
 // packaged default enables JIT, while this deployment explicitly disables it.
 await c.query("SET jit=off;SET max_parallel_workers_per_gather=1;SET work_mem='2184kB'");
 return c;
}
async function asAdmin(c){await c.query('RESET ROLE');await c.query("SET statement_timeout='0'");}
async function asUser(c,uid=owner){await c.query('SET ROLE authenticated');await c.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[uid,JSON.stringify({'x-client-info':'sentlog-collaboration/1'})]);}
async function capture(c,f){
 await asAdmin(c);
 return {
  snapshot:await val(c,'SELECT payload::text AS result FROM public.sentlog_project_snapshots WHERE project_id=$1',[f.pid]),
  revision:await val(c,'SELECT revision::text AS result FROM public.sentlog_project_snapshots WHERE project_id=$1',[f.pid]),
  states:(await c.query('SELECT drawing_id,record_id,collab::text,last_seq::text FROM sentlog_delta_private.record_states WHERE project_id=$1 ORDER BY drawing_id,record_id',[f.pid])).rows,
  head:(await c.query('SELECT enabled,last_seq::text FROM sentlog_delta_private.heads WHERE project_id=$1',[f.pid])).rows,
  baseline:(await c.query('SELECT id,state,record_count::text,imported_count::text,snapshot_sha256,manifest_sha256 FROM sentlog_delta_private.baselines WHERE project_id=$1 ORDER BY id',[f.pid])).rows,
  checkpoints:(await c.query('SELECT head_seq::text,revision::text,payload_sha256 FROM sentlog_delta_private.checkpoints WHERE project_id=$1 ORDER BY head_seq',[f.pid])).rows,
  migrations:(await c.query('SELECT device_id,baseline_id,proof::text FROM sentlog_delta_private.device_migrations WHERE project_id=$1 ORDER BY device_id',[f.pid])).rows
 };
}
const invoke=(c,f,device=phone,body=proof)=>val(c,'SELECT public.sentlog_delta_activate_baseline_v1($1,$2,$3,$4::jsonb) AS result',[f.pid,device,f.receipt.baselineId,JSON.stringify(body)]);
async function timedAttempt(c,f,limit,label){
 await asAdmin(c);await c.query('SELECT pg_stat_force_next_flush()');await c.query('SELECT pg_stat_reset()');await c.query("SET track_functions='all'");
 await asUser(c);await c.query('BEGIN');await c.query("SELECT set_config('statement_timeout',$1,true)",[String(limit)]);
 const started=performance.now();let result,error,accepted,elapsedMs,constraintsMs,totalMs,stage='activation';
 try{
  result=await invoke(c,f);elapsedMs=performance.now()-started;
  // Explicit transactions defer membership checks until COMMIT. Execute them
  // before comparing/rolling back, recording this separate statement's cost.
  stage='deferred constraints';const constraintStart=performance.now();
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');constraintsMs=performance.now()-constraintStart;
  totalMs=performance.now()-started;accepted=await capture(c,f);
 }catch(e){
  totalMs=performance.now()-started;if(elapsedMs===undefined)elapsedMs=totalMs;
  error={code:e.code,message:e.message,where:e.where,stage};
 }
 await c.query('ROLLBACK');await asAdmin(c);await c.query('SELECT pg_stat_force_next_flush()');await c.query('SELECT pg_stat_clear_snapshot()');
 const functions=(await c.query("SELECT funcname,calls,total_time,self_time FROM pg_stat_user_functions WHERE schemaname='sentlog_delta_private' AND calls>0 ORDER BY total_time DESC LIMIT 15")).rows;
 const summary={label,limitMs:limit,elapsedMs:Number(elapsedMs.toFixed(1)),
  ...(constraintsMs===undefined?{}:{constraintsMs:Number(constraintsMs.toFixed(1))}),
  totalMs:Number(totalMs.toFixed(1)),ok:!error,...(error?{error}:{}),functions};
 console.log(JSON.stringify(summary));
 if(error)assert.equal(error.code,'57014',label+' may only fail because of the tested deadline');
 return {summary,result,accepted};
}
async function rejectsWithoutMutation(c,f,action,code,message){
 const before=await capture(c,f);let caught;
 try{await action();}catch(e){caught=e;}
 assert(caught,'expected rejection '+message);assert.equal(caught.code,code);if(message)assert(caught.message.includes(message),caught.message);
 assert.deepEqual(await capture(c,f),before,'rejected activation must not alter state');
}
async function config(c){await asAdmin(c);return {
 roles:(await c.query("SELECT rolname,rolconfig FROM pg_roles WHERE rolname IN ('anon','authenticated') ORDER BY rolname")).rows,
 rpcConfigurations:(await c.query("SELECT proname,pg_get_function_identity_arguments(oid) AS args,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'sentlog_delta_%' ORDER BY proname,args")).rows,
 acls:(await c.query("SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args,p.proacl::text,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='sentlog_delta_private' OR n.nspname='public' AND p.proname LIKE 'sentlog_delta_%') ORDER BY 1,2,3")).rows,
 rollout:(await c.query('SELECT owner_id,enabled FROM sentlog_delta_private.rollouts ORDER BY owner_id')).rows,
 devices:(await c.query('SELECT id,owner_id,device_name,device_type,active FROM public.sentlog_devices ORDER BY id')).rows
};}
async function fixture(name,index){
 const {snapshot,profile}=generate(name),pid='33000000-0000-4000-8000-'+String(index+1).padStart(12,'0');
 console.log(JSON.stringify({preparingFixture:profile}));
 await asAdmin(db);
 await db.query('INSERT INTO public.sentlog_projects(id,owner_id,client_key,name) VALUES($1,$2,$3,$4)',[pid,owner,snapshot.project.id,snapshot.project.name]);
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[owner,JSON.stringify({'x-client-info':'sentlog-collaboration/1'})]);
 await db.query('INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload,updated_by_device) VALUES($1,$2,1,$3::jsonb,$4)',[pid,owner,JSON.stringify(snapshot),phone]);
 await asUser(db);
 let receipt=await val(db,'SELECT public.sentlog_delta_prepare_baseline_v1($1,$2,1) AS result',[pid,phone]);
 while(receipt.state!=='verified'){
  receipt=await val(db,'SELECT public.sentlog_delta_import_baseline_batch_v1($1,$2,$3,100) AS result',[pid,phone,receipt.baselineId]);
  console.log(JSON.stringify({importing:name,done:receipt.importedCount,total:receipt.recordCount}));
 }
 assert.equal(receipt.recordCount,profile.records);
 const f={name,pid,profile,receipt};f.pristine=await capture(db,f);console.log(JSON.stringify({fixture:profile}));return f;
}
async function verifyGuards(f){
 await rejectsWithoutMutation(db,f,async()=>{await asUser(db,other);await invoke(db,f);},'42501','DELTA_PROJECT_FORBIDDEN');
 await rejectsWithoutMutation(db,f,async()=>{await asUser(db);await invoke(db,f,phone,{...proof,writerVersion:1});},'22023','DELTA_MIGRATION_REQUIRED');
 await asAdmin(db);await db.query('UPDATE sentlog_delta_private.rollouts SET enabled=false WHERE owner_id=$1',[owner]);
 try{await rejectsWithoutMutation(db,f,async()=>{await asUser(db);await invoke(db,f);},'55000','DELTA_ROLLOUT_DISABLED');}
 finally{await asAdmin(db);await db.query('UPDATE sentlog_delta_private.rollouts SET enabled=true WHERE owner_id=$1',[owner]);}
 const helperNames=[...read(patch).matchAll(/CREATE OR REPLACE FUNCTION sentlog_delta_private\.([a-z_]+)\(/g)].map(m=>m[1]);
 assert(helperNames.length>0);
 const exposed=await val(db,"SELECT coalesce(bool_or(has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('anon',p.oid,'EXECUTE')),false) AS result FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sentlog_delta_private' AND p.proname=ANY($1::text[])",[helperNames]);
 assert.equal(exposed,false,'private helpers must remain private');
 assert.equal(await val(db,"SELECT coalesce(bool_or(has_function_privilege('anon',p.oid,'EXECUTE') OR p.prosecdef),false) AS result FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'sentlog_delta_%'"),false);
 report.checks.push('foreign owner, malformed proof, disabled rollout, helper/public RPC ACLs');
}
async function forceTimeoutAfterInsert(f){
 await asAdmin(db);
 await db.query("CREATE FUNCTION public.native_test_pause_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(1);RETURN NULL;END$$;CREATE TRIGGER native_test_pause AFTER INSERT ON sentlog_delta_private.record_states FOR EACH STATEMENT EXECUTE FUNCTION public.native_test_pause_insert();");
 try{
  await asUser(db);await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='400ms'");
  let caught;try{await invoke(db,f);}catch(e){caught=e;}
  assert.equal(caught?.code,'57014');assert(caught.where?.includes('native_test_pause_insert'),'timeout occurs after record insertion, not before it');
  await db.query('ROLLBACK');assert.deepEqual(await capture(db,f),f.pristine,'timeout rolls back inserted record states, baseline/head and checkpoint');
 }finally{await db.query('ROLLBACK');await asAdmin(db);await db.query('DROP TRIGGER native_test_pause ON sentlog_delta_private.record_states;DROP FUNCTION public.native_test_pause_insert();');}
 report.checks.push('real native statement timeout after inserts rolls back all activation state');
}
async function simultaneousActivation(f,expected){
 const a=await newClient(),b=await newClient();
 const attempts=[],started=performance.now();
 const attempt=async(c,device,label)=>{
  const start=performance.now();let failure;
  try{return await invoke(c,f,device);}catch(e){failure=e.code;throw e;}
  finally{attempts.push({label,elapsedMs:Number((performance.now()-start).toFixed(1)),ok:!failure,...(failure?{sqlState:failure}:{})});}
 };
 try{
  await Promise.all([asUser(a),asUser(b)]);await Promise.all([a.query("SELECT set_config('statement_timeout',$1,false)",[String(budget)]),b.query("SELECT set_config('statement_timeout',$1,false)",[String(budget)])]);
  // No explicit BEGIN here: these durations include native implicit COMMIT,
  // including deferred constraints and durable completion, on two connections.
  const outcomes=await Promise.allSettled([attempt(a,phone,'phone initial'),attempt(b,tablet,'tablet initial')]);
  assert(outcomes.some(r=>r.status==='fulfilled'),'one concurrent activation must succeed');
  for(let i=0;i<outcomes.length;i++)if(outcomes[i].status==='rejected'){
   assert(['55P03','57014'].includes(outcomes[i].reason.code),'only bounded lock/deadline waits may require retry');
   const r=await attempt(i===0?a:b,i===0?phone:tablet,'bounded retry');assert.equal(r.state,'active');
  }else assert.equal(outcomes[i].value.state,'active');
  const actual=await capture(db,f);
  assert.equal(actual.snapshot,expected.snapshot);assert.deepEqual(actual.states,expected.states);
  assert.equal(actual.revision,'2');assert.equal(actual.checkpoints.length,1);assert.equal(actual.migrations.length,2);
  await asUser(a);const again=await invoke(a,f,phone);assert.equal(again.baselineId,f.receipt.baselineId);
  assert.deepEqual(await capture(db,f),actual,'same-device replay changes no persisted state');
  report.concurrentActivation={profile:f.name,includesImplicitCommit:true,attempts,totalMs:Number((performance.now()-started).toFixed(1))};
  assert(attempts.filter(x=>x.ok).every(x=>x.elapsedMs<45000),'each committed activation returns within the client activation deadline');
  report.checks.push('two native connections / two devices converge to one certified checkpoint; retry is idempotent');
 }finally{await Promise.allSettled([a.end(),b.end()]);connections.delete(a);connections.delete(b);}
}
(async()=>{
 admin=new Client(cfg);await admin.connect();
 const existingRoles=(await admin.query("SELECT rolname,rolconfig FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows;
 for(const [role,limit] of [['anon','3s'],['authenticated','8s']]){
  const existing=existingRoles.find(x=>x.rolname===role);
  // Roles are cluster-wide even though the data is in our private test DB.
  // Never change an existing local project's role configuration for a test.
  if(existing)assert((existing.rolconfig||[]).includes('statement_timeout='+limit),
   'use a disposable cluster: existing '+role+' role timeout differs from the deployment');
  else createdRoles.push(role);
 }
 await admin.query('CREATE DATABASE "'+database+'"');created=true;db=await newClient();
 console.log(JSON.stringify({nativeDatabase:database,phase:'installing disposable protocols'}));
 let base=read('tests/delta_release_legacy_fixture.sql');
 base=base.replace(/CREATE ROLE (anon|authenticated) NOLOGIN;/g,(_,role)=>`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} NOLOGIN;END IF;END$$;`);
 await db.query(base);
 for(const role of createdRoles)await db.query('ALTER ROLE '+role+" SET statement_timeout='"+(role==='anon'?'3s':'8s')+"'");
 for(const file of ['db/archive_v1.sql','db/management_v1.sql','db/device_registration_v1.sql','db/capacity_v1.sql','db/resilience_v2.sql','db/collaboration_v1.sql','db/photo_redelivery_v1.sql','db/device_photo_redelivery_v1.sql'])await db.query(read(file));
 const baselineSQL=execFileSync('python3',['-c',"import importlib.util; s=importlib.util.spec_from_file_location('delta_assemble','scripts/assemble_delta_sync.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.PARTS=[p for p in m.PARTS if p[0]!='docs/sentlog-delta-activation-scalability.sql']; print(m.assemble()[0])"],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
 await db.query(baselineSQL);
 // This cache predates v1.99 and is present in production. Repeated receipt
 // generation without it is not the deployed comparison baseline.
 await db.query(read('docs/sentlog-delta-receipt-cache-prototype.sql'));
 await db.query("SET statement_timeout='0'");
 report.serverVersion=await val(db,'SELECT version() AS result');
 report.settings=(await db.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('jit','max_parallel_workers_per_gather','work_mem') ORDER BY name")).rows;
 await db.query('INSERT INTO auth.users(id) VALUES($1),($2)',[owner,other]);
 await db.query("INSERT INTO public.sentlog_devices(id,owner_id,device_type,device_name) VALUES($1,$3,'iphone','Synthetic phone'),($2,$3,'ipad','Synthetic tablet')",[phone,tablet,owner]);
 await db.query('INSERT INTO sentlog_delta_private.rollouts(owner_id,enabled) VALUES($1,true)',[owner]);
 const fixtures=[];
 for(const [index,name] of selected.entries()){
  const f=await fixture(name,index);fixtures.push(f);
  const under8=await timedAttempt(db,f,8000,'v199 '+name+' native 8s');
  assert.deepEqual(await capture(db,f),f.pristine,'original timed attempt leaves no committed activation');
  const expected=under8.accepted?under8:await timedAttempt(db,f,0,'v199 '+name+' native unlimited comparison');
  assert(expected.accepted,'reference projection must complete');f.expected=expected.accepted;
  f.result={profile:f.profile,before8:under8.summary,beforeReference:expected.summary};report.profiles.push(f.result);
 }
 if(beforeOnly)return;
 const cfgBefore=await config(db),statesBefore=await Promise.all(fixtures.map(f=>capture(db,f)));
 await db.query(read(patch));
 report.rpcSettings=(await db.query("SELECT proname,proconfig FROM pg_proc WHERE oid='public.sentlog_delta_activate_baseline_v1(uuid,uuid,uuid,jsonb)'::regprocedure")).rows;
 const cfgAfter=await config(db),aclKey=x=>x.nspname+'.'+x.proname+'('+x.args+')';
 const activationName='sentlog_delta_activate_baseline_v1';
 const oldRpc=cfgBefore.rpcConfigurations.find(x=>x.proname===activationName);
 const newRpc=cfgAfter.rpcConfigurations.find(x=>x.proname===activationName);
 assert.deepEqual([...(newRpc.proconfig||[])].sort(),[...(oldRpc.proconfig||[]).filter(x=>!x.startsWith('statement_timeout=')),'statement_timeout=30s'].sort(),
  'only the public activation RPC gets its declared 30 s timeout');
 assert(cfgAfter.roles.find(x=>x.rolname==='authenticated').rolconfig.includes('statement_timeout=8s'));
 cfgAfter.rpcConfigurations=cfgAfter.rpcConfigurations.map(x=>x.proname===activationName?{...x,proconfig:oldRpc.proconfig}:x);
 const existingFunctions=new Set(cfgBefore.acls.map(aclKey));
 cfgAfter.acls=cfgAfter.acls.filter(x=>existingFunctions.has(aclKey(x)));
 assert.deepEqual(cfgAfter,cfgBefore,'patch preserves roles, existing ACLs, rollout and devices');
 for(let i=0;i<fixtures.length;i++)assert.deepEqual(await capture(db,fixtures[i]),statesBefore[i],'install does not modify saved data or activation state');
 report.checks.push('patch installation changes only activation RPC timeout to 30 s; authenticated role stays 8 s; other RPC settings, data, ACLs, rollout and devices are unchanged');
 for(const f of fixtures){
  const after8=await timedAttempt(db,f,8000,'scalable '+f.name+' native 8s');f.result.after8=after8.summary;
  let completed=after8;
  if(!completed.accepted)completed=await timedAttempt(db,f,budget===8000?0:budget,'scalable '+f.name+' native comparison');
  assert(completed.accepted,'candidate projection must complete');f.result.afterReference=completed.summary;
  assert.equal(completed.accepted.snapshot,f.expected.snapshot,'entire certified snapshot is byte-equivalent PostgreSQL jsonb text');
  assert.deepEqual(completed.accepted.states,f.expected.states,'every accepted history and metadata document is byte-equivalent');
  assert.deepEqual(completed.accepted.checkpoints,f.expected.checkpoints,'checkpoint hash and revision remain identical');
  const output=JSON.parse(completed.accepted.snapshot),rows=output.drawings.flatMap(d=>[...d.state.shapes,...d.state.collabDeletedRecords]);
  assert.equal(rows.length,f.profile.records);assert.equal(rows.flatMap(r=>r.photos).length,f.profile.photos);assert.equal(output.unknownHeader.preserved,true);
  assert.deepEqual(await capture(db,f),f.pristine,'timing transactions all roll back');
 }
 report.checks.push('full pre/post snapshot, metadata, histories, geometry, photos, deleted records and conflict parity');
 await verifyGuards(fixtures[0]);await forceTimeoutAfterInsert(fixtures[0]);
 await simultaneousActivation(fixtures.at(-1),fixtures.at(-1).expected);
 report.allWithinBudget=report.profiles.every(x=>x.after8.ok||budget>8000&&x.afterReference.ok&&x.afterReference.elapsedMs<budget);
 assert(report.allWithinBudget,'candidate must meet the explicitly selected activation budget');
})().catch(e=>{report.failure={message:e.message,code:e.code,where:e.where,stack:e.stack};process.exitCode=1;}).finally(async()=>{
 report.passed=!report.failure;
 const concise=x=>x&&Object.fromEntries(Object.entries(x).filter(([k])=>k!=='functions'));
 console.log(JSON.stringify({nativeReport:{...report,profiles:report.profiles.map(p=>({...p,
  before8:concise(p.before8),beforeReference:concise(p.beforeReference),after8:concise(p.after8),afterReference:concise(p.afterReference)}))}},null,2));
 const output=process.argv.find(x=>x.startsWith('--report='));if(output)fs.writeFileSync(path.resolve(output.slice('--report='.length)),JSON.stringify(report,null,2)+'\n');
 await Promise.allSettled([...connections].map(c=>c.end()));
 if(admin){
  if(created&&!keep){
   await admin.query('DROP DATABASE "'+database+'"').catch(e=>console.error('Disposable database cleanup failed:',e.message));
   for(const role of createdRoles)await admin.query('DROP ROLE '+role).catch(e=>console.error('Disposable test role cleanup deferred:',e.message));
  }
  await admin.end();
 }
});

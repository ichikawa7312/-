'use strict';
// Isolated PostgreSQL engine in WASM. No Supabase URL or credentials.
const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/^\\set[^\n]*$/mg,'');
const fixture=['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql',
 'docs/sentlog-delta-semantic-validation-prototype.sql','tests/delta_baseline_fixture.sql','docs/sentlog-delta-baseline-prototype.sql'];
const patch='docs/sentlog-delta-receipt-cache-prototype.sql',device='aaaaaaaa-0000-4000-8000-000000000001',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project=n=>'77000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function setup(db){for(const f of fixture)await db.exec(read(f));}
async function asUser(db){await db.exec('SET ROLE authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);}
const value=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0]?.result;
const prepare=(db,p,rev=10)=>value(db,'select public.sentlog_delta_prepare_baseline_v1($1,$2,$3) as result',[p,device,rev]);
const batch=(db,p,bid,n)=>value(db,'select public.sentlog_delta_import_baseline_batch_v1($1,$2,$3,$4) as result',[p,device,bid,n]);
const page=(db,p,bid,metadata=false)=>value(db,'select public.sentlog_delta_read_baseline_'+(metadata?'metadata_':'')+'page_v1($1,$2,$3,0,1) as result',[p,device,bid]);
const image=async db=>({baselines:(await db.query("select (to_jsonb(b)-'receipt_static_v1')::text as row, sentlog_delta_private.baseline_receipt(b)::text as receipt from sentlog_delta_private.baselines b order by id")).rows,
 records:(await db.query('select to_jsonb(r)::text as row from sentlog_delta_private.baseline_records r order by baseline_id,ordinal')).rows});
async function main(){
 const db=new PGlite();
 try{
  await setup(db);
  // A 118-drawing, 708-record synthetic snapshot (no customer information).
  await db.query("update public.sentlog_project_snapshots set payload=jsonb_build_object('project',jsonb_build_object('id','baseline-client-12','name','fixture','collaborationVersion',1,'drawings',(select jsonb_agg(jsonb_build_object('id','drawing:'||i) order by i) from generate_series(1,118)i)),'drawings',(select jsonb_agg(jsonb_build_object('meta',jsonb_build_object('id','drawing:'||i),'state',jsonb_build_object('scale',0.01,'shapes',(select jsonb_agg(public.baseline_test_record('record:'||j) order by j) from generate_series(1,6)j),'collabDeletedRecords','[]'::jsonb)) order by i) from generate_series(1,118)i)) where project_id=$1",[project(12)]);
  await asUser(db);
  const r=await prepare(db,project(1));assert.equal(r.recordCount,3);
  const done=await batch(db,project(1),r.baselineId,100);assert.equal(done.state,'verified');
  const oldRecord=await page(db,project(1),r.baselineId),oldMetadata=await page(db,project(1),r.baselineId,true);
  const large=await prepare(db,project(12));assert.equal(large.recordCount,708);assert.equal(large.metadataCount,119);
  const empty=await prepare(db,project(6));assert.equal(empty.metadataCount,1);
  await db.exec('RESET ROLE');
  const before=await image(db);
  const benchmark=async()=>{const t=performance.now();const total=await value(db,"select sum(length(sentlog_delta_private.baseline_receipt(b)::text))::text as result from sentlog_delta_private.baselines b cross join generate_series(1,20)");return {ms:performance.now()-t,total};};
  const oldTime=await benchmark();
  await db.exec(read(patch));
  const newTime=await benchmark();
  assert.deepEqual(await image(db),before,'all original baseline/record fields and exact receipt strings remain identical');
  assert.equal(newTime.total,oldTime.total);
  console.log('PASS existing receipt and record bytes unchanged; repeated receipt fixture '+oldTime.ms.toFixed(1)+'ms -> '+newTime.ms.toFixed(1)+'ms (synthetic, not production latency)');
  assert.equal(await value(db,"select count(*)::int as result from sentlog_delta_private.baselines where receipt_static_v1 is distinct from sentlog_delta_private.baseline_receipt_static_v1(snapshot)"),0);
  assert.equal(await value(db,"select has_function_privilege('authenticated','sentlog_delta_private.baseline_receipt_static_v1(jsonb)','EXECUTE') or has_table_privilege('authenticated','sentlog_delta_private.baselines','UPDATE') as result"),false);
  await asUser(db);
  assert.deepEqual(await page(db,project(1),r.baselineId),oldRecord);
  assert.deepEqual(await page(db,project(1),r.baselineId,true),oldMetadata);
  assert.deepEqual(await prepare(db,project(12)),large);
  const fresh=await prepare(db,project(2));assert.equal(fresh.state,'prepared');
  const progress=await batch(db,project(2),fresh.baselineId,1);assert.equal(progress.importedCount,1);
  const verified=await batch(db,project(2),fresh.baselineId,100);assert.equal(verified.state,'verified');
  for(const f of ['metadataManifestSha256','metadataCount','snapshotSha256','manifestSha256','drawingIds'])assert.deepEqual(verified[f],fresh[f]);
  await assert.rejects(()=>value(db,'select public.sentlog_delta_read_baseline_page_v1($1,$2,$3) as result',[project(1),'bbbbbbbb-0000-4000-8000-000000000003',r.baselineId]),e=>e.code==='42501');
  console.log('PASS unchanged public record/metadata pages, empty and large projects, resumed import, new baseline, dynamic state and wrong-device rejection');
 }finally{await db.close();}
 // Run every existing baseline scenario on a fresh schema with the patch
 // installed before any baseline preparation.
 const fresh=new PGlite();
 try{await setup(fresh);await fresh.exec(read(patch));const results=await fresh.exec(read('tests/delta_baseline_assertions.sql'));for(const r of results)for(const row of r.rows||[])if(row.result)console.log(row.result);
 console.log('PASS existing baseline safety suite with generated receipt cache installed');}finally{await fresh.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
// Full legacy + delta protocols in disposable PostgreSQL/WASM; synthetic data.
// No Supabase URL, credentials, customer rows or external network calls.
if(!globalThis.crypto)globalThis.crypto=require('node:crypto').webcrypto;
const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const C=require('../sentlog/record-collaboration.js');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const owner='11000000-0000-4000-8000-000000000001',other='11000000-0000-4000-8000-000000000002';
const phone='22000000-0000-4000-8000-000000000001',pid='33000000-0000-4000-8000-000000000001';
const proof={writerVersion:2,migrationId:'activation-perf',sourceFingerprint:'a'.repeat(64),planSha256:'b'.repeat(64)};
const patch='docs/sentlog-delta-activation-performance.sql';
const legacy=['db/archive_v1.sql','db/management_v1.sql','db/device_registration_v1.sql','db/capacity_v1.sql',
 'db/resilience_v2.sql','db/collaboration_v1.sql','db/photo_redelivery_v1.sql','db/device_photo_redelivery_v1.sql'];
const large=process.argv.includes('--larger');
const drawingCount=large?118:64,recordCount=large?587:654,photoCount=large?2090:1765;
const metas=Array.from({length:drawingCount},(_,i)=>({id:'drawing-'+i,name:'Drawing '+i,pdfFileId:'pdf-'+i}));
const snapshot={project:{id:'activation-large',name:'Synthetic large project',collaborationVersion:1,drawings:structuredClone(metas),
 custom:{preserved:true}},drawings:metas.map(meta=>({meta:structuredClone(meta),state:{shapes:[],collabDeletedRecords:[],
 pageSettings:{'1':{scale:100,rotation:0}},unknown:{preserved:['x',1]},currentPage:1}})),unknownHeader:{preserved:true}};
let photoIndex=0;
for(let i=0;i<recordCount;i++){
 const n=Math.floor(photoCount/recordCount)+(i<photoCount%recordCount?1:0);
 const photos=Array.from({length:n},()=>{const j=photoIndex++;return {id:'photo-'+j,name:'evidence-'+j+'.jpg',size:900000,sha256:'c'.repeat(64)};});
 const r=C.upgrade({id:'record-'+i,type:'腐食',kind:'rect',x:i,y:2,w:3,h:4,member:'synthetic pier',memo:'Field observation '+i+' '+'synthetic field observation; '.repeat(large?110:26),
 crackWidth:0.2,damageLevel:'b',page:1,photos});
 snapshot.drawings[i%drawingCount].state.shapes.push(r);
}
assert.equal(photoIndex,photoCount);
const actor={deviceId:phone,deviceName:'Phone'};
// Exercise the full conflict/deletion branch as well as singleton histories.
let sample=snapshot.drawings[0].state.shapes[0];
const left=C.setField(sample,'member','left',{actor,at:1,revisionId:'left',expectedHeads:C.view(sample).fields.member.headIds});
const right=C.setField(sample,'member','right',{actor,at:1,revisionId:'right',expectedHeads:C.view(sample).fields.member.headIds});
sample=C.mergeRecords(left,right).record;snapshot.drawings[0].state.shapes[0]=sample;
const removalSource=snapshot.drawings[1].state.shapes.pop();
const removed=C.markDeleted(removalSource,{actor,at:2,revisionId:'delete',expectedToken:C.revisionToken(removalSource)});
snapshot.drawings[1].state.collabDeletedRecords.push(removed);

(async()=>{const db=new PGlite();try{
 const val=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.result;
 const admin=()=>db.exec('RESET ROLE');
 const user=async(uid=owner)=>{await db.exec('SET ROLE authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[uid,JSON.stringify({'x-client-info':'sentlog-collaboration/1'})]);};
 await db.exec(read('tests/delta_release_legacy_fixture.sql'));
 for(const file of legacy)await db.exec(read(file));
 await db.exec(execFileSync('python3',['scripts/assemble_delta_sync.py'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024}));
 // Reinstall the preserved pre-optimization definitions for the before/after
 // comparison, even once the release assembler includes the new patch.
 for(const [file,names] of [
  ['docs/sentlog-delta-projection-prototype.sql',['revision_heads','project_register','normalize_collab','project_record']],
  ['docs/sentlog-delta-checkpoint-prototype.sql',['project_snapshot']],
  ['docs/sentlog-delta-metadata-prototype.sql',['validate_metadata_snapshot']]]){
   const sql=read(file);
   for(const name of names){const match=sql.match(new RegExp('CREATE OR REPLACE FUNCTION sentlog_delta_private\\.'+name+'\\([\\s\\S]*?AS \\$fn\\$[\\s\\S]*?\\$fn\\$;'));
    assert(match,'original function '+name);await db.exec(match[0]);}
 }
 // Already deployed performance changes are part of the baseline comparison.
 await db.exec(read('docs/sentlog-delta-receipt-cache-prototype.sql'));
 await db.query('INSERT INTO auth.users(id) VALUES($1),($2)',[owner,other]);
 await db.query("INSERT INTO public.sentlog_devices(id,owner_id,device_type,device_name) VALUES($1,$2,'iphone','Synthetic phone')",[phone,owner]);
 await db.query('INSERT INTO public.sentlog_projects(id,owner_id,client_key,name) VALUES($1,$2,$3,$4)',[pid,owner,snapshot.project.id,snapshot.project.name]);
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[owner,JSON.stringify({'x-client-info':'sentlog-collaboration/1'})]);
 await db.query('INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload,updated_by_device) VALUES($1,$2,1,$3::jsonb,$4)',[pid,owner,JSON.stringify(snapshot),phone]);
 await db.query('INSERT INTO sentlog_delta_private.rollouts(owner_id,enabled) VALUES($1,true)',[owner]);
 await user();
 let receipt=await val('SELECT public.sentlog_delta_prepare_baseline_v1($1,$2,1) AS result',[pid,phone]);
 while(receipt.state!=='verified')receipt=await val('SELECT public.sentlog_delta_import_baseline_batch_v1($1,$2,$3,100) AS result',[pid,phone,receipt.baselineId]);
 assert.equal(receipt.recordCount,recordCount);
 const activate=()=>val('SELECT public.sentlog_delta_activate_baseline_v1($1,$2,$3,$4::jsonb) AS result',[pid,phone,receipt.baselineId,JSON.stringify(proof)]);
 console.log('Fixture prepared: '+drawingCount+' drawings, '+recordCount+' records, '+photoCount+' photos, '+Buffer.byteLength(JSON.stringify(snapshot))+' JSON bytes.');
 const timed=async label=>{const start=performance.now();const result=await activate();const ms=performance.now()-start;console.log(label+' '+ms.toFixed(1)+' ms');return {result,ms};};
 await db.exec('BEGIN');
 const before=await timed('Original activation');
 await admin();const oldSnapshot=await val('SELECT payload AS result FROM public.sentlog_project_snapshots WHERE project_id=$1',[pid]);
 const oldStates=(await db.query('SELECT drawing_id,record_id,collab,last_seq FROM sentlog_delta_private.record_states WHERE project_id=$1 ORDER BY drawing_id,record_id',[pid])).rows;
 await db.exec('ROLLBACK');await admin();
 const beforeInstall=await val('SELECT payload AS result FROM public.sentlog_project_snapshots WHERE project_id=$1',[pid]);
 const configuration=async()=>({roles:(await db.query("SELECT rolname,rolconfig FROM pg_roles WHERE rolname IN ('authenticated','anon') ORDER BY rolname")).rows,
  rollouts:(await db.query('SELECT to_jsonb(r) AS row FROM sentlog_delta_private.rollouts r ORDER BY owner_id')).rows,
  heads:(await db.query('SELECT to_jsonb(h) AS row FROM sentlog_delta_private.heads h ORDER BY project_id')).rows,
  devices:(await db.query('SELECT to_jsonb(d) AS row FROM public.sentlog_devices d ORDER BY id')).rows,
  baselines:(await db.query('SELECT id,state,imported_count,snapshot_sha256,manifest_sha256 FROM sentlog_delta_private.baselines ORDER BY id')).rows});
 const configBefore=await configuration();
 await db.exec(read(patch));
 assert.deepEqual(await val('SELECT payload AS result FROM public.sentlog_project_snapshots WHERE project_id=$1',[pid]),beforeInstall);
 assert.deepEqual(await configuration(),configBefore,'install leaves roles, timeouts, rollouts, project modes, device registrations and migration progress unchanged');
 assert.equal(await val("SELECT count(*)::int AS result FROM sentlog_delta_private.record_states WHERE project_id=$1",[pid]),0);
 await user();await db.exec("SET statement_timeout='8s'");
 const after=await timed('Optimized activation with statement_timeout=8s');
 assert.equal(after.result.state,'active');
 assert(after.ms<8000,'synthetic full activation must finish under the deployed 8 s request timeout');
 await admin();
 const newSnapshot=await val('SELECT payload AS result FROM public.sentlog_project_snapshots WHERE project_id=$1',[pid]);
 const newStates=(await db.query('SELECT drawing_id,record_id,collab,last_seq FROM sentlog_delta_private.record_states WHERE project_id=$1 ORDER BY drawing_id,record_id',[pid])).rows;
 assert.deepEqual(newSnapshot,oldSnapshot,'complete certified display, unknown fields, record/photo histories and order are byte-equivalent JSON');
 assert.deepEqual(newStates,oldStates,'accepted histories and head positions are unchanged');
 assert.equal(newSnapshot.drawings.flatMap(d=>[...d.state.shapes,...d.state.collabDeletedRecords]).length,recordCount);
 assert.equal(newSnapshot.drawings.flatMap(d=>[...d.state.shapes,...d.state.collabDeletedRecords]).flatMap(r=>r.photos).length,photoCount);
 assert.equal(newSnapshot.unknownHeader.preserved,true);
 const invalid=structuredClone(newSnapshot);
 invalid.drawings[0].state.shapes[0].collab.fields.member.revisions[0].parents=['missing-parent'];
 await assert.rejects(()=>db.query('SELECT sentlog_delta_private.validate_metadata_snapshot($1::jsonb,$2::jsonb)',
  [JSON.stringify(invalid),JSON.stringify(invalid.project.deltaMetadata.records)]),e=>e.code==='22023',
 'an already-visible drawing still rejects a malformed ordinary record graph');
 invalid.drawings[0].state.shapes[0].id='';
 await assert.rejects(()=>db.query('SELECT sentlog_delta_private.validate_metadata_snapshot($1::jsonb,$2::jsonb)',
  [JSON.stringify(invalid),JSON.stringify(invalid.project.deltaMetadata.records)]),e=>e.code==='22023'&&e.message.includes('DELTA_PROJECTION_RECORD_ID_INVALID'),
 'an already-visible drawing still rejects an invalid record identity');
 assert.equal(await val("SELECT bool_or(has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('anon',p.oid,'EXECUTE')) AS result FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sentlog_delta_private' AND p.proname IN ('revision_heads','project_register','normalize_collab','project_record','project_snapshot','validate_metadata_snapshot')"),false);
 await user(other);await assert.rejects(activate,e=>e.code==='42501');
 await user();const repeat=await activate();assert.equal(repeat.baselineId,receipt.baselineId);
 assert.equal(await val('SELECT revision AS result FROM public.sentlog_project_snapshots WHERE project_id=$1',[pid]),2);
 console.log('PASS exact pre/post state and snapshot parity; deleted records and conflicting fields preserved; foreign owner denied; retry does not duplicate checkpoint; helper ACLs unchanged.');
 console.log(JSON.stringify({drawings:drawingCount,records:recordCount,photos:photoCount,beforeMs:before.ms,afterMs:after.ms,speedup:before.ms/after.ms}));
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

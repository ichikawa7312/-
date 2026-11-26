'use strict';
if(!globalThis.crypto)globalThis.crypto=require('node:crypto').webcrypto;
const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js'),M=require('../sentlog/delta-sync-metadata.js');
const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,'');
const copy=x=>structuredClone(x),actor={deviceId:'metadata-test',deviceName:'test'};
const meta={id:'図面🧪',name:'layout',custom:{nested:1}},input={project:{id:'local-p',name:'project',collaborationVersion:1,drawings:[meta]},drawings:[{meta:copy(meta),state:{shapes:[],currentPage:1,pageSettings:{'1':{scale:100,rotation:0}},['長い設定😀'.repeat(100)]:0}}]};
const merge=(a,b)=>{const out=copy(a);for(const [k,r]of Object.entries(b)){const result=C.mergeRecords(out[k],r);assert(result.ok);out[k]=result.record;}return out;};
async function edited(base,mutate,id,extra={}){const after=copy(input);mutate(after);return M.edit({before:input,after,currentRecords:base,operationId:id,actor,at:1,...extra});}
(async()=>{const db=new PGlite();let checks=0;try{
 for(const file of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql','docs/sentlog-delta-semantic-validation-prototype.sql','tests/delta_baseline_fixture.sql','docs/sentlog-delta-baseline-prototype.sql','docs/sentlog-delta-projection-prototype.sql','docs/sentlog-delta-metadata-prototype.sql'])await db.exec(read(file));
 const optimized=read('docs/sentlog-delta-activation-performance.sql');
 for(const name of ['revision_heads','project_register','normalize_collab','project_record','validate_metadata_snapshot']){
   const match=optimized.match(new RegExp('CREATE OR REPLACE FUNCTION sentlog_delta_private\\.'+name+'\\([\\s\\S]*?END \\$fn\\$;'));
   assert(match,'optimized function '+name);await db.exec(match[0]);
 }
 const scalable=read('docs/sentlog-delta-activation-scalability.sql');
 for(const name of ['metadata_child_index','build_metadata_node_indexed','build_metadata_node','materialize_metadata_document','seed_metadata_document','seed_metadata_baseline']){
   const match=scalable.match(new RegExp('CREATE OR REPLACE FUNCTION sentlog_delta_private\\.'+name+'\\([\\s\\S]*?\\$fn\\$;'));
   assert(match,'scalable metadata function '+name);await db.exec(match[0]);
 }
 await db.exec('REVOKE ALL ON FUNCTION sentlog_delta_private.metadata_child_index(jsonb),sentlog_delta_private.build_metadata_node_indexed(jsonb,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated');
 const baseline=await M.seed(input),cases=[['baseline',baseline]];
 for(const spec of (await M.documentSpecs(input)).values()){
   const metadata=spec.identity.kind==='project'?{project:input.project}:{...input.drawings[0],order:0};
   const sql=(await db.query('SELECT sentlog_delta_private.seed_metadata_document($1,$2,$3,$4::jsonb) AS result',[spec.identity.kind,input.project.id,spec.identity.drawingId||null,JSON.stringify(metadata)])).rows[0].result;
   assert.deepEqual(sql,baseline[D.keyOf(M.namespace,spec.id)]);checks++;console.log('PASS SQL/JS seed '+spec.identity.kind);
 }
 const a=await edited(baseline,s=>s.drawings[0].state.pageSettings['1'].scale=125,'scale-a'),b=await edited(baseline,s=>s.drawings[0].state.pageSettings['1'].scale=150,'scale-b');cases.push(['same-field candidates',merge(a.records,b.records)]);
 const c=await edited(baseline,s=>s.drawings[0].state.pageSettings['1'].rotation=90,'rotation');cases.push(['independent fields',merge(a.records,c.records)]);
 const removed=await edited(baseline,s=>delete s.drawings[0].state.pageSettings['1'],'delete-object');cases.push(['object removal',removed.records],['object removal and unseen child',merge(removed.records,a.records)]);
 const replaced=await edited(baseline,s=>s.drawings[0].state.pageSettings['1']='auto','replace-object');cases.push(['object replacement',replaced.records],['object replacement and unseen child',merge(replaced.records,c.records)]);
 const drawingRemoved=await edited(baseline,s=>{s.project.drawings=[];s.drawings=[];},'delete-drawing',{operation:'delete'});cases.push(['drawing deletion',drawingRemoved.records],['drawing deletion and unseen setting',merge(drawingRemoved.records,a.records)]);
 const addedA=await edited(baseline,s=>s.drawings[0].state.newSetting=[1,2],'new-a'),addedB=await edited(baseline,s=>s.drawings[0].state.newSetting=[3,4],'new-b');cases.push(['conflicting new setting',merge(addedA.records,addedB.records)]);
 const migrated=await edited(baseline,s=>s.drawings[0].state.pageSettings['1'].scale=175,'legacy',{operation:'restore',legacyMerge:true,inferProvenance:true});cases.push(['legacy unknown ancestry',migrated.records]);
 const reordered=copy(input);reordered.project.drawings.push({id:'other',name:'Other'});reordered.drawings.push({meta:copy(reordered.project.drawings[1]),state:{shapes:[]}});const reorderBase=await M.seed(reordered),reorderAfter=copy(reordered);reorderAfter.project.drawings.reverse();reorderAfter.drawings.reverse();
 const oldOrder=await M.edit({before:reordered,after:reorderAfter,currentRecords:reorderBase,operationId:'legacy-order',actor,at:1,operation:'restore',legacyMerge:true,inferProvenance:true});cases.push(['legacy order conflicts have deterministic fallback',oldOrder.records]);
 for(const [label,records]of cases)for(const record of Object.values(records)){
   const sql=(await db.query('SELECT sentlog_delta_private.materialize_metadata_document($1,$2::jsonb) AS result',[record.id,JSON.stringify(record.collab)])).rows[0].result;
   const js=await M.materializeDocument(record);assert.deepEqual(sql,js,label+' '+record.id);checks++;
 }
 const bad=copy(Object.values(baseline)[0]);bad.collab.fields.metaIdentity.revisions[0].value.localProjectId='foreign';
 // Identity cannot change within one immutable document, including a fabricated branch.
 bad.collab.fields.metaIdentity.revisions.push({...copy(bad.collab.fields.metaIdentity.revisions[0]),id:'wrong-identity',parents:[bad.collab.fields.metaIdentity.revisions[0].id],value:{...bad.metaIdentity,localProjectId:'another'}});
 await assert.rejects(db.query('SELECT sentlog_delta_private.materialize_metadata_document($1,$2::jsonb)',[bad.id,JSON.stringify(bad.collab)]),e=>e.code==='22023');checks++;
 const pid='77000000-0000-4000-8000-000000000001',did='aaaaaaaa-0000-4000-8000-000000000001',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 await db.query('UPDATE public.sentlog_projects SET client_key=$2 WHERE id=$1',[pid,input.project.id]);await db.query('UPDATE public.sentlog_project_snapshots SET payload=$2::jsonb WHERE project_id=$1',[pid,JSON.stringify(input)]);
 await db.query("SELECT pg_catalog.set_config('request.jwt.claim.sub',$1,false)",[owner]);
 const receipt=(await db.query('SELECT public.sentlog_delta_prepare_baseline_v1($1,$2,10) AS result',[pid,did])).rows[0].result;assert.equal(receipt.state,'verified');
 await db.exec('CREATE TRIGGER metadata_test_legacy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sentlog_project_snapshots FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.reject_legacy_snapshot()');
 await db.exec('BEGIN');await db.query('SELECT sentlog_delta_private.activate_prepared_baseline($1,$2,$3)',[pid,did,receipt.baselineId]);
 const seeded=(await db.query('SELECT sentlog_delta_private.seed_metadata_baseline($1,$2,$3) AS result',[pid,did,receipt.baselineId])).rows[0].result;assert.deepEqual(seeded,{metadataCount:2,alreadySeeded:false});await db.exec('COMMIT');checks++;
 const seededRows=(await db.query('SELECT record_id,collab FROM sentlog_delta_private.record_states WHERE project_id=$1 AND drawing_id=$2',[pid,M.namespace])).rows;
 for(const row of seededRows)assert.deepEqual(C.upgrade({id:row.record_id,collab:row.collab}),baseline[D.keyOf(M.namespace,row.record_id)]);checks++;
 assert.deepEqual((await db.query('SELECT sentlog_delta_private.seed_metadata_baseline($1,$2,$3) AS result',[pid,did,receipt.baselineId])).rows[0].result,{metadataCount:2,alreadySeeded:true});checks++;
 const wrong=copy(baseline[D.keyOf(M.namespace,'project')]);wrong.collab.fields.metaIdentity.revisions[0].value.localProjectId='foreign';
 await assert.rejects(db.query('UPDATE sentlog_delta_private.record_states SET collab=$3::jsonb WHERE project_id=$1 AND drawing_id=$2 AND record_id=\'project\'',[pid,M.namespace,JSON.stringify(wrong.collab)]),e=>e.code==='22023');checks++;
 const ordinary=C.upgrade({id:'ordinary',memo:'peer',photos:[]});const insert='INSERT INTO sentlog_delta_private.record_states(project_id,owner_id,drawing_id,record_id,collab,last_seq) VALUES($1,$2,$3,$4,$5::jsonb,0)';
 await assert.rejects(db.query(insert,[pid,owner,'missing','ordinary',JSON.stringify(ordinary.collab)]),e=>e.code==='23514');checks++;
 const newDoc=await M.seedDocument((await M.documentSpecs({project:{...input.project,drawings:[{id:'new-drawing',name:'new'}]},drawings:[{meta:{id:'new-drawing',name:'new'},state:{shapes:[]}}]})).get(await M.drawingRecordId('new-drawing')));
 await db.exec('BEGIN');await db.query(insert,[pid,owner,'new-drawing','ordinary',JSON.stringify(ordinary.collab)]);await db.query(insert,[pid,owner,M.namespace,newDoc.id,JSON.stringify(newDoc.collab)]);await db.exec('COMMIT');checks++;
 console.log('PASS metadata baseline seed, identity trigger and deferred atomic drawing membership');
 assert.equal((await db.query("SELECT prosecdef AND proconfig @> ARRAY['search_path=\"\"']::text[] AS guarded FROM pg_catalog.pg_proc WHERE oid='sentlog_delta_private.validate_metadata_membership()'::regprocedure")).rows[0].guarded,true);checks++;
 // Deferred triggers run when the outer authenticated request commits, after
 // the SECURITY DEFINER append call has already returned to its caller.
 const append=(drawingId,id)=>{
   const event=D.diffRecord(null,C.upgrade({id,memo:'outer transaction',photos:[]}),{eventId:id,projectId:pid,deviceId:did,drawingId});
   return db.query('SELECT public.sentlog_delta_append_v1($1,$2,$3,$4,$5,$6::jsonb)',[pid,did,id,drawingId,id,JSON.stringify(event)]);
 };
 await db.exec('BEGIN; SET LOCAL ROLE authenticated');await append(input.drawings[0].meta.id,'authenticated-commit');await db.exec('COMMIT');
 assert.equal((await db.query("SELECT count(*)::int AS count FROM sentlog_delta_private.record_states WHERE project_id=$1 AND record_id='authenticated-commit'",[pid])).rows[0].count,1);checks++;
 const headBefore=(await db.query('SELECT last_seq FROM sentlog_delta_private.heads WHERE project_id=$1',[pid])).rows[0].last_seq;
 await db.exec('BEGIN; SET LOCAL ROLE authenticated');await append('missing-at-commit','authenticated-orphan');
 await assert.rejects(db.exec('COMMIT'),e=>e.code==='23514'&&e.message.includes('DELTA_METADATA_DRAWING_MISSING'));await db.exec('ROLLBACK');
 assert.equal((await db.query('SELECT last_seq FROM sentlog_delta_private.heads WHERE project_id=$1',[pid])).rows[0].last_seq,headBefore);
 assert.equal((await db.query("SELECT count(*)::int AS count FROM sentlog_delta_private.record_states WHERE project_id=$1 AND record_id='authenticated-orphan'",[pid])).rows[0].count,0);checks++;
 console.log('PASS authenticated outer COMMIT validates membership and rolls back orphan writes');
 await db.exec('SET ROLE authenticated');
 await assert.rejects(db.query('SELECT * FROM sentlog_delta_private.record_states'),e=>e.code==='42501');
 await assert.rejects(db.query('SELECT sentlog_delta_private.validate_metadata_membership()'),e=>e.code==='42501');checks++;
 await db.exec('SET ROLE authenticated');await assert.rejects(db.query('SELECT sentlog_delta_private.materialize_metadata_document($1,$2::jsonb)',[Object.values(baseline)[0].id,JSON.stringify(Object.values(baseline)[0].collab)]),e=>e.code==='42501');checks++;
 console.log('PASS metadata SQL/JS parity: '+checks+' checks');
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

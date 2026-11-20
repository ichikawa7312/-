'use strict';
// SQL -> exact-byte reader -> pending local deltas -> real SQL validators.
// --pglite has no external database connection. CI --stdin reads the sole row
// emitted by delta_reconcile_sql_fixture.sql; --sql emits validation SQL.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {webcrypto}=require('node:crypto');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const API=require('../sentlog/delta-sync-reconcile.js');
const quoted=s=>"'"+s.replace(/'/g,"''")+"'";
const clone=v=>structuredClone(v);
const sqlFile=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,'');
const hash=async text=>Buffer.from(await crypto.subtle.digest('SHA-256',Buffer.from(text))).toString('hex');
async function check(contract){
 const scope={ownerId:contract.receipt.ownerId,projectId:contract.receipt.projectId,deviceId:'aaaaaaaa-0000-4000-8000-000000000001'};
 let recordAt=0,metadataAt=0;
 const baseline=await API.readBaseline({scope,receipt:contract.receipt,pageLimit:1,
  readPage:async(after,limit)=>{assert.equal(after,recordAt);assert.equal(limit,1);return clone(contract.recordPages[recordAt++]);},
  readMetadataPage:async(after,limit)=>{assert.equal(after,metadataAt);assert.equal(limit,1);return clone(contract.metadataPages[metadataAt++]);}});
 assert.equal(baseline.records.length,3);assert.equal(baseline.metadata.length,4);
 assert.equal(recordAt,contract.recordPages.length);assert.equal(metadataAt,contract.metadataPages.length);
 assert.equal(baseline.receipt.clientProjectId,'reconcile-client-1');
 const original=contract.sourceSnapshot;
 const rawEntries=[{key:'surveyFieldNoteWorkspaceV1',value:JSON.stringify({projects:[original.project]})},
  ...original.drawings.map(d=>({key:'surveyFieldNoteDrawingV1:'+d.meta.id,value:JSON.stringify(d.state)}))];
 const localSnapshot={version:1,kind:'sentlog-legacy-source',projectId:original.project.id,source:{recordRevision:1},rawEntries,
  originals:[],captureIntentRaw:null,files:[],manifest:[],issues:[],fingerprint:await hash(JSON.stringify(rawEntries)),readyForStaging:true,readyForActivation:false};
 const unchanged=await API.plan({scope,baseline,localSnapshot});
 assert.equal(unchanged.readyForInstall,true,JSON.stringify(unchanged.reviewItems));assert.equal(unchanged.state.outbox.length,0);
 assert.equal(Object.keys(unchanged.state.records).length,3);assert.equal(unchanged.metadata.drawings.length,3);
 assert(C.isDeleted(unchanged.state.records[D.keyOf('drawing:1','deleted:1')]));
 assert.equal(unchanged.readyForActivation,false);assert.equal(unchanged.readyForCloudSync,false);
 const entry=rawEntries[1],state=JSON.parse(entry.value),base=state.shapes[0];
 state.shapes[0]=C.appendComment(base,'端末で追加した所見 🌧️',{commentId:'local-comment',revisionId:'local-comment-revision',at:5,
  actor:{deviceId:scope.deviceId,deviceName:'local fixture'}});
 state.shapes[0]=C.addPhoto(state.shapes[0],{id:'local-photo',name:'追加.jpg',size:5,sha256:'2'.repeat(64)},
  {revisionId:'local-photo-revision',at:5,actor:{deviceId:scope.deviceId,deviceName:'local fixture'}});
 entry.value=JSON.stringify(state);
 const second=JSON.parse(rawEntries[2].value);second.shapes=[];rawEntries[2].value=JSON.stringify(second);
 const third=JSON.parse(rawEntries[3].value);third.shapes.push(C.upgrade({id:'local-record',kind:'point',x:1,y:2,memo:'新しい記録',photos:[]}));
 rawEntries[3].value=JSON.stringify(third);localSnapshot.fingerprint=await hash(JSON.stringify(rawEntries));
 const plan=await API.plan({scope,baseline,localSnapshot});assert.equal(plan.readyForInstall,true,JSON.stringify(plan.reviewItems));
 assert.equal(plan.state.outbox.length,2);assert.equal(Object.keys(plan.state.records).length,4);
 assert(plan.state.records[D.keyOf('drawing:2','record:1')]);assert(await API.verifyPlan(plan,{scope}));
 const repeat=await API.plan({scope,baseline,localSnapshot});assert.deepEqual(repeat.state.outbox,plan.state.outbox);
 // The SQL protocol retains unknown/redundant metadata exactly. If its two
 // metadata copies disagree, it is verified content but not an installable
 // plan; the synthetic tests separately exercise that preservation rule.
 const statements=[];
 for(const e of plan.state.outbox){
  const previous=baseline.records.find(r=>r.drawingId===e.drawingId&&r.recordId===e.recordId)?.record||null;
  const expected=clone(plan.state.records[D.keyOf(e.drawingId,e.recordId)].collab);delete expected.projection;
  assert(C.equal(D.combine(previous,e),plan.state.records[D.keyOf(e.drawingId,e.recordId)]));
  const event=quoted(JSON.stringify(e))+'::jsonb',before=previous?quoted(JSON.stringify(previous.collab))+'::jsonb':'NULL::jsonb';
  statements.push(`DO $test$ DECLARE actual jsonb; expected jsonb:=${quoted(JSON.stringify(expected))}::jsonb; BEGIN
    PERFORM sentlog_delta_private.validate_payload(${event});
    actual:=sentlog_delta_private.merge_record_history(${before},${event})-'projection';
    PERFORM sentlog_delta_private.validate_record_graph(actual);
    IF NOT (actual @> expected AND expected @> actual) THEN RAISE EXCEPTION 'reconcile SQL history differed from JS'; END IF;
  END $test$;`);
 }
 return {sql:statements.join('\n'),summary:'PASS SQL/JS baseline reconciliation: exact record and metadata pages, empty drawing, tombstone, server-only preservation, stable local create/patch and SQL history parity'};
}
(async()=>{
 if(process.argv.includes('--pglite')){
  const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
  try{
   for(const f of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql',
    'docs/sentlog-delta-semantic-validation-prototype.sql','tests/delta_baseline_fixture.sql','docs/sentlog-delta-baseline-prototype.sql'])await db.exec(sqlFile(f));
   const output=await db.exec(sqlFile('tests/delta_reconcile_sql_fixture.sql'));
   const contracts=output.flatMap(r=>r.rows||[]).filter(r=>r.contract);assert.equal(contracts.length,1);
   const result=await check(contracts[0].contract);await db.exec(result.sql);console.log(result.summary);
  }finally{await db.close();}
 }else if(process.argv.includes('--stdin')){
  const result=await check(JSON.parse(fs.readFileSync(0,'utf8')));
  if(process.argv.includes('--sql'))process.stdout.write(result.sql+'\nSELECT '+quoted(result.summary)+' AS result;\n');
  else console.log(result.summary.replace(' and SQL history parity',' (SQL validation statements prepared)'));
 }else throw Error('Use --pglite or pipe the disposable SQL fixture into --stdin --sql');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

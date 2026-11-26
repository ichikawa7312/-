'use strict';
// Actual archive + collaboration SQL, synthetic data, no remote credentials.
if(!globalThis.crypto)globalThis.crypto=require('node:crypto').webcrypto;
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const M=require('../sentlog/delta-sync-metadata.js'),A=require('../sentlog/archive-core.js');
const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,'');
const copy=x=>structuredClone(x),owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pid='55000000-0000-4000-8000-000000000001',phone='aaaaaaaa-0000-4000-8000-000000000001';
const absentPhone='aaaaaaaa-0000-4000-8000-000000000004',pc='aaaaaaaa-0000-4000-8000-000000000099';
const actor={deviceId:phone,deviceName:'Phone'},localId='checkpoint-client';
const migrationProof={writerVersion:2,migrationId:'checkpoint-integration',sourceFingerprint:'1'.repeat(64),planSha256:'2'.repeat(64)};
const record=(id,photoId,hash,size)=>C.upgrade({id,type:'腐食',kind:'rect',x:1,y:2,w:3,h:4,memo:'original '+id,member:'pier',photos:[{id:photoId,name:photoId+'.jpg',size,sha256:hash}]});
const live=record('record-a','photo-live','a'.repeat(64),3);
const old=record('record-deleted','photo-history','b'.repeat(64),4);
const deleted=C.markDeleted(old,{actor,at:1,revisionId:'baseline-record-deleted',expectedToken:C.revisionToken(old)});
const removedDrawingRecord=record('record-b','photo-hidden','c'.repeat(64),5);
const metas=[{id:'drawing-a',name:'Main',pdfFileId:'pdf-a'},{id:'drawing-b',name:'Retained later',pdfFileId:'pdf-b'}];
const original={project:{id:localId,name:'Server checkpoint',collaborationVersion:1,drawings:copy(metas),custom:{nested:['unknown',1]}},
 drawings:[{meta:copy(metas[0]),state:{shapes:[live],collabDeletedRecords:[deleted],pageSettings:{'1':{scale:100,rotation:0}},unknown:{empty:{}}}},
   {meta:copy(metas[1]),state:{shapes:[removedDrawingRecord],collabDeletedRecords:[],pageSettings:{'1':{scale:200}}}}],
 unknownHeader:{preserved:true}};

(async()=>{const db=new PGlite();let checks=0;
 const check=(label,test)=>{assert(test,label);checks++;console.log('PASS '+label);};
 const value=async(sql,args=[])=>{const r=await db.query(sql,args);return r.rows[0]?.result;};
 const asUser=async(uid=owner)=>{await db.exec('SET ROLE authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid]);};
 const asAdmin=()=>db.exec('RESET ROLE');
 const failure=async(label,fn,code,marker)=>{await assert.rejects(fn,e=>(!code||e.code===code)&&(!marker||e.message.includes(marker)),label);checks++;console.log('PASS '+label);};
 const rpc=(action,data={},device=phone)=>value('SELECT public.sentlog_archive_v1($1,$2,$3,$4::jsonb) AS result',[action,pid,device,JSON.stringify(data)]);
 const checkpoint=(head,id='checkpoint:'+head,device=phone)=>value('SELECT public.sentlog_delta_publish_checkpoint_v1($1,$2,$3,$4) AS result',[pid,device,head,id]);
 const append=event=>value('SELECT public.sentlog_delta_append_v1($1,$2,$3,$4,$5,$6::jsonb) AS result',[pid,phone,event.eventId,event.drawingId,event.recordId,JSON.stringify(event)]);
 const currentRecords=async()=>{const out={};for(const row of (await db.query('SELECT drawing_id,record_id,collab FROM sentlog_delta_private.record_states WHERE project_id=$1',[pid])).rows)out[D.keyOf(row.drawing_id,row.record_id)]=C.upgrade({id:row.record_id,collab:row.collab});return out;};
 const event=(before,after,drawingId,id)=>D.diffRecord(before,after,{eventId:id,projectId:pid,deviceId:phone,drawingId});
 try{
  for(const file of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql','docs/sentlog-delta-semantic-validation-prototype.sql',
    'tests/delta_baseline_fixture.sql','docs/sentlog-delta-baseline-prototype.sql','tests/delta_transport_fixture.sql','docs/sentlog-delta-transport-prototype.sql',
    'docs/sentlog-delta-atomic-groups-prototype.sql','tests/delta_archive_fixture.sql','db/archive_v1.sql',
    'db/management_v1.sql','db/device_registration_v1.sql','db/capacity_v1.sql',
    'docs/sentlog-delta-archive-compat-prototype.sql','docs/sentlog-delta-projection-prototype.sql','docs/sentlog-delta-metadata-prototype.sql'])await db.exec(read(file));
  await db.exec('ALTER TABLE public.sentlog_project_snapshots ADD COLUMN updated_by_device uuid; ALTER TABLE public.sentlog_project_snapshots ADD COLUMN updated_at timestamptz DEFAULT now(); GRANT UPDATE,INSERT,DELETE ON public.sentlog_project_snapshots TO authenticated;');
  await db.exec(read('db/collaboration_v1.sql'));
  await db.exec(read('docs/sentlog-delta-checkpoint-prototype.sql'));
  await db.exec(read('docs/sentlog-delta-app-lifecycle.sql'));
  await db.exec(read('docs/sentlog-delta-activation-performance.sql'));
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[owner,JSON.stringify({'x-client-info':'sentlog-collaboration/1'})]);
  await db.query("INSERT INTO public.sentlog_projects(id,owner_id,status,client_key,name) VALUES($1,$2,'active',$3,'Checkpoint fixture')",[pid,owner,localId]);
  await db.query('INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload,updated_by_device) VALUES($1,$2,1,$3::jsonb,$4)',[pid,owner,JSON.stringify(original),phone]);
  await db.query("INSERT INTO public.sentlog_devices(id,owner_id,active,device_name,device_type) VALUES($1,$2,true,'Unused phone','iphone')",[absentPhone,owner]);
  for(const [key,kind,hash,size] of [['drawing:drawing-a','drawing','d'.repeat(64),10],['drawing:drawing-b','drawing','e'.repeat(64),11],
    ['photo:drawing-a:photo-live','photo','a'.repeat(64),3],['photo:drawing-a:photo-history','photo','b'.repeat(64),4],['photo:drawing-b:photo-hidden','photo','c'.repeat(64),5]])
    await db.query("INSERT INTO public.sentlog_assets(project_id,owner_id,client_key,kind,file_name,mime_type,byte_size,sha256,storage_path,status) VALUES($1,$2,$3,$4,$3,$5,$6,$7,$3,'uploaded')",[pid,owner,key,kind,kind==='drawing'?'application/pdf':'image/jpeg',size,hash]);
  await asUser();
  let mode=await value('SELECT public.sentlog_delta_inspect_v1($1,$2) AS result',[pid,phone]);
  check('application rollout defaults to disabled without changing saving mode',mode.enabled===false&&mode.canActivate===false&&mode.headSeq===0&&mode.snapshotRevision===1);
  const baseline=await value('SELECT public.sentlog_delta_prepare_baseline_v1($1,$2,1) AS result',[pid,phone]);
  await value('SELECT public.sentlog_delta_import_baseline_batch_v1($1,$2,$3,100) AS result',[pid,phone,baseline.baselineId]);
  const activate=(target=pid,bid=baseline.baselineId,proof=migrationProof,device=phone)=>value('SELECT public.sentlog_delta_activate_baseline_v1($1,$2,$3,$4::jsonb) AS result',[target,device,bid,JSON.stringify(proof)]);
  await failure('public activation respects disabled owner rollout',()=>activate(),'55000','DELTA_ROLLOUT_DISABLED');
  await failure('authenticated clients cannot grant themselves a rollout',()=>db.query('INSERT INTO sentlog_delta_private.rollouts(owner_id,enabled) VALUES($1,true)',[owner]),'42501');
  await asAdmin();
  await db.query('INSERT INTO sentlog_delta_private.rollouts(owner_id,enabled) VALUES($1,true)',[owner]);
  await asUser();
  mode=await value('SELECT public.sentlog_delta_inspect_v1($1,$2) AS result',[pid,phone]);
  check('reviewed owner rollout makes the scoped project eligible',mode.canActivate===true&&!mode.enabled);
  const missingVersion={...migrationProof};delete missingVersion.writerVersion;
  await failure('a missing writer version cannot pass nullable proof validation',()=>activate(pid,baseline.baselineId,missingVersion),'22023','DELTA_MIGRATION_REQUIRED');
  await failure('revoked device cannot activate the app baseline',()=>activate(pid,baseline.baselineId,migrationProof,'aaaaaaaa-0000-4000-8000-000000000002'),'42501','DELTA_DEVICE_FORBIDDEN');
  await failure('foreign owner cannot activate this app baseline',async()=>{await asUser('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');try{await activate();}finally{await asUser();}},'42501','DELTA_PROJECT_FORBIDDEN');
  const activated=await activate();
  check('actual public activation atomically seeds metadata and the initial checkpoint',activated.baselineId===baseline.baselineId&&activated.state==='active');
  mode=await value('SELECT public.sentlog_delta_inspect_v1($1,$2) AS result',[pid,phone]);
  check('app inspection returns the immutable baseline after checkpoint publication',mode.enabled===true&&mode.baseline.snapshotRevision===1&&mode.baseline.baselineId===baseline.baselineId);
  const first=await checkpoint(0);
  check('certified publisher passes the actual collaboration snapshot guard',first.schema===1&&first.projectId===pid&&first.revision===2&&first.headSeq===0&&/^[a-f0-9]{64}$/.test(first.payloadSha256));
  check('complete baseline including tombstones and unknown settings survives',first.payload.drawings[0].state.collabDeletedRecords[0].id===deleted.id&&first.payload.project.custom.nested[0]==='unknown'&&first.payload.unknownHeader.preserved);
  const repeat=await checkpoint(0),alias=await checkpoint(0,'another-request');
  check('lost-response retry and independent same-head retry share one snapshot revision',repeat.checkpointId===first.checkpointId&&alias.revision===first.revision);
  await failure('request identifiers cannot be reused for another head',()=>checkpoint(1,'checkpoint:0'),'22023','DELTA_CHECKPOINT_REQUEST_COLLISION');
  await asAdmin();check('private checkpoint write authority is consumed',Number(await value('SELECT count(*) AS result FROM sentlog_delta_private.checkpoint_write_authority'))===0);await asUser();
  await db.query("SELECT set_config('sentlog.delta_checkpoint',$1,false)",[JSON.stringify(first)]);
  await failure('forged GUC cannot authorize a legacy snapshot write',()=>db.query('UPDATE public.sentlog_project_snapshots SET revision=revision+1 WHERE project_id=$1',[pid]),'55000','DELTA_SNAPSHOT_CHECKPOINT_REQUIRED');
  await failure('client cannot manufacture private transaction authority',()=>db.query('INSERT INTO sentlog_delta_private.checkpoint_write_authority SELECT * FROM sentlog_delta_private.checkpoint_write_authority'),'42501');
  await failure('foreign owner cannot publish this project',async()=>{await asUser('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');try{await checkpoint(0);}finally{await asUser();}},'42501','DELTA_PROJECT_FORBIDDEN');
  await failure('inactive device cannot publish',()=>checkpoint(0,'inactive','aaaaaaaa-0000-4000-8000-000000000002'),'42501','DELTA_DEVICE_FORBIDDEN');
  const edited=C.appendComment(live,'accepted delta',{actor,at:2,revisionId:'accepted-comment',commentId:'accepted-comment-row'});
  await append(event(live,edited,'drawing-a','accepted-edit'));
  await failure('stale head cannot certify after an accepted delta',()=>checkpoint(0),'40001','DELTA_CHECKPOINT_STALE_HEAD');
  await failure('stale certificate cannot start PC archive',()=>rpc('begin',{revision:first.revision}),'55000','DELTA_ARCHIVE_PROJECTION_REQUIRED');
  const second=await checkpoint(1);
  check('fresh checkpoint includes accepted changes in raw display and exact history',second.payload.drawings[0].state.shapes[0].memo===edited.memo&&C.equal(second.payload.drawings[0].state.shapes[0].collab,edited.collab));
  const activatedAgain=await activate();
  check('retry of active migration survives newer snapshot revisions and delta edits',activatedAgain.baselineId===baseline.baselineId&&activatedAgain.snapshotRevision===1&&activatedAgain.state==='active');
  await asAdmin();const beforeRecords=await currentRecords();await asUser();
  const after=copy(second.payload);after.drawings[0].state.pageSettings['1'].scale=125;after.project.drawings=after.project.drawings.filter(x=>x.id!=='drawing-b');after.drawings=after.drawings.filter(x=>x.meta.id!=='drawing-b');
  const metadataEdit=await M.edit({before:second.payload,after,currentRecords:beforeRecords,operationId:'settings-and-removal',actor,at:3,operation:'delete'});
  const events=[];
  for(const [key,record]of Object.entries(metadataEdit.records)){const prior=beforeRecords[key];const e=event(prior,record,M.namespace,'metadata-'+events.length);if(e)events.push(e);}
  const tomb=C.markDeleted(removedDrawingRecord,{actor,at:3,revisionId:'remove-drawing-record',expectedToken:C.revisionToken(removedDrawingRecord)});
  events.push(event(removedDrawingRecord,tomb,'drawing-b','tombstone-drawing-record'));
  const group={schema:1,kind:'atomic-group',groupId:'settings-and-drawing-removal',projectId:pid,deviceId:phone,events};
  const receipt=await value('SELECT public.sentlog_delta_append_group_v1($1,$2,$3::jsonb) AS result',[pid,phone,JSON.stringify(group)]);
  const latest=await checkpoint(receipt.endSeq);
  check('settings edits and explicit drawing deletion publish together',latest.payload.drawings.length===1&&latest.payload.drawings[0].state.pageSettings['1'].scale===125);
  check('hidden drawing retains its complete metadata and ordinary record histories',latest.payload.project.deltaMetadata.retainedDrawings[0].meta.id==='drawing-b'&&latest.payload.project.deltaMetadata.retainedDrawings[0].state.collabDeletedRecords[0].collab.deletion.revisions.some(r=>r.id==='remove-drawing-record'));
  const job=await rpc('begin',{revision:latest.revision});
  check('actual legacy archive begins against the current certificate',job.state==='checking'&&job.delta_checkpoint.headSeq===latest.headSeq&&job.delta_checkpoint.payloadSha256===latest.payloadSha256);
  check('PC manifest includes live, deleted-record and hidden-drawing files exactly once',job.manifest.length===5&&new Set(job.manifest.map(x=>x.key)).size===5&&job.manifest.some(x=>x.key==='photo:drawing-a:photo-history'));
  const paths=Object.fromEntries(job.manifest.map(f=>[f.key,'files/'+f.id])),pack=A.backupPack(job,paths);
  check('real PC pack preserves the certificate, hidden drawings and unknown header',A.validatePack(pack,job)&&pack.workspace.projects[0].deltaMetadata.retainedDrawings.length===1&&pack.snapshotExtras.unknownHeader.preserved&&pack.delta_checkpoint.headSeq===latest.headSeq);
  const restored={...copy(pack.snapshotExtras),project:copy(pack.workspace.projects[0]),drawings:pack.workspace.projects[0].drawings.map(meta=>({meta:copy(meta),state:copy(pack.drawingStates[meta.id])}))};
  const restoredMetadata=await M.seed(restored);
  check('PC backup can reconstruct the same metadata histories for restoration',C.equal(M.metadataRecords(restoredMetadata),pack.workspace.projects[0].deltaMetadata.records));
  for(const mutate of [p=>delete p.workspace.projects[0].deltaMetadata.records.project,p=>p.workspace.projects[0].deltaMetadata.retainedDrawings=[],p=>p.delta_checkpoint.headSeq++,p=>p.snapshotExtras.unknownHeader.preserved=false,p=>p.drawingStates.injected={shapes:[]}]){const broken=copy(pack);mutate(broken);assert.throws(()=>A.validatePack(broken,job));}
  checks++;console.log('PASS PC verification rejects corrupted history, certificate, extras and injected drawing');
  await asAdmin();
  await failure('archive certificate independently rejects a truncated legacy file catalog',()=>db.query(`INSERT INTO sentlog_archive_private.jobs
    (project_id,owner_id,initiator,revision,payload,manifest,catalog_hash,required_devices)
    SELECT project_id,owner_id,initiator,revision,payload,'[]'::jsonb,catalog_hash,required_devices
    FROM sentlog_archive_private.jobs WHERE id=$1`,[job.id]),'55000','DELTA_ARCHIVE_MANIFEST_MISMATCH');
  await asUser();
  const proof={schema:1,headSeq:latest.headSeq,cursor:latest.headSeq,pending:0,revision:latest.revision,payloadSha256:latest.payloadSha256};
  for(const broken of [undefined,{...proof,cursor:0},{...proof,cursor:undefined},{...proof,pending:1},{...proof,payloadSha256:'0'.repeat(64)},{...proof,absent:true}])
    await failure('clean report requires exact version and a truthful proof shape',()=>rpc('report',{job_id:job.id,catalog_hash:job.catalog_hash,clean:true,...(broken?{delta_proof:broken}:{})}),'55000','DELTA_ARCHIVE_DEVICE_PROOF_REQUIRED');
  await rpc('report',{job_id:job.id,catalog_hash:job.catalog_hash,clean:true,delta_proof:proof});
  await rpc('report',{job_id:job.id,catalog_hash:job.catalog_hash,clean:true,delta_proof:{...proof,absent:true,cursor:null}},absentPhone);
  const frozen=C.appendComment(edited,'must wait',{actor,at:4,revisionId:'frozen-comment',commentId:'frozen-comment-row'});
  await failure('checking archive freezes a new delta atomically',()=>append(event(edited,frozen,'drawing-a','frozen-event')),'55000','DELTA_ARCHIVE_FROZEN');
  await failure('a file manifest count mismatch cannot create a PC receipt',()=>rpc('pc_complete',{job_id:job.id,catalog_hash:job.catalog_hash,file_count:4,package_sha256:'f'.repeat(64),path:'synthetic/backup'},pc));
  await rpc('pc_complete',{job_id:job.id,catalog_hash:job.catalog_hash,file_count:5,package_sha256:'f'.repeat(64),path:'synthetic/backup'},pc);
  const finalized=await rpc('finalize',{job_id:job.id});
  check('actual phone report + actual PC receipt + finalize completes delta archive',finalized.status==='archived'&&finalized.backup_path==='synthetic/backup');
  const archivedMode=await value('SELECT public.sentlog_delta_inspect_v1($1,$2) AS result',[pid,phone]);
  const archivedCapabilities=await value('SELECT public.sentlog_delta_capabilities_v1($1,$2) AS result',[pid,phone]);
  const archivedRecords=await value('SELECT public.sentlog_delta_read_baseline_page_v1($1,$2,$3,0,100) AS result',[pid,phone,baseline.baselineId]);
  const archivedMetadata=await value('SELECT public.sentlog_delta_read_baseline_metadata_page_v1($1,$2,$3,0,100) AS result',[pid,phone,baseline.baselineId]);
  const archivedChanges=await value('SELECT public.sentlog_delta_list_groups_v1($1,$2,0,100) AS result',[pid,phone]);
  check('archived manual recovery can inspect capabilities, baseline records/settings and complete deltas',archivedMode.enabled&&!archivedMode.canActivate&&archivedMode.snapshotRevision===latest.revision&&archivedCapabilities.certifiedArchive===true&&archivedRecords.records.length===3&&archivedMetadata.metadata.length===3&&archivedChanges.headSeq===latest.headSeq);
  await failure('archived read access still rejects a revoked device',()=>value('SELECT public.sentlog_delta_list_groups_v1($1,$2,0,100) AS result',[pid,'aaaaaaaa-0000-4000-8000-000000000002']),'42501','DELTA_DEVICE_FORBIDDEN');
  await failure('archived projects cannot prepare another baseline',()=>value('SELECT public.sentlog_delta_prepare_baseline_v1($1,$2,$3) AS result',[pid,phone,latest.revision]),'42501','DELTA_PROJECT_FORBIDDEN');
  await failure('archived read access does not authorize checkpoint publication',()=>checkpoint(latest.headSeq,'archived-publish'),'42501','DELTA_PROJECT_FORBIDDEN');
  const capacity=(action,data={},device=phone)=>value('SELECT public.sentlog_capacity_v1($1,$2,$3,$4::jsonb) AS result',[action,pid,device,JSON.stringify(data)]);
  for(const action of ['verify','restore']){
    const operation=await capacity('begin',{action,mode:'project'});
    const info=await capacity('inspect',{operation_id:operation.id});
    const pcJobs=await capacity('pc_jobs',{},pc),pcJob=pcJobs.find(x=>x.operation.id===operation.id);
    check('actual capacity '+action+' returns the immutable certificate to phone and PC',C.equal(info.job.delta_checkpoint,job.delta_checkpoint)&&C.equal(pcJob.job.delta_checkpoint,job.delta_checkpoint));
    check('actual capacity '+action+' can verify the existing certified PC bundle',A.validatePack(pack,info.job)&&A.validatePack(pack,pcJob.job)&&info.files.length===job.manifest.length);
    await failure('capacity '+action+' blocks reopening during its active operation',()=>rpc('reopen'));
    await capacity('pc_ready',{operation_id:operation.id,catalog_hash:job.catalog_hash,package_sha256:'f'.repeat(64),file_count:job.manifest.length},pc);
    check('actual capacity '+action+' completes with a verified PC receipt',(await capacity('finish',{operation_id:operation.id})).finished===true);
  }
  await failure('archived project refuses new delta',()=>append(event(edited,frozen,'drawing-a','still-archived')),'42501');
  check('actual legacy reopen returns delta project to active', (await rpc('reopen')).status==='active');
  const resumed=await append(event(edited,frozen,'drawing-a','after-reopen'));
  check('edits resume after reopening without losing certified history',resumed.seq===latest.headSeq+1);
  await failure('reopened edits invalidate the former certificate',()=>rpc('begin',{revision:latest.revision}),'55000','DELTA_ARCHIVE_PROJECTION_REQUIRED');
  const renewed=await checkpoint(resumed.seq);
  check('republication after reopening advances the certified revision once',renewed.revision===latest.revision+1&&renewed.payload.drawings[0].state.shapes[0].memo.includes('must wait'));
  await asAdmin();
  await db.query("UPDATE public.sentlog_assets SET sha256=$1 WHERE project_id=$2 AND client_key='photo:drawing-a:photo-history'",['0'.repeat(64),pid]);await asUser();
  await failure('archive checks retained photo bytes against history metadata',()=>rpc('begin',{revision:renewed.revision}),'55000','DELTA_ARCHIVE_ASSET_MISMATCH');
  await asAdmin();
  check('all failed operations leave no dangling transaction authority',Number(await value('SELECT count(*) AS result FROM sentlog_delta_private.checkpoint_write_authority'))===0);
  check('the frozen operation wrote neither event nor new revision',Number(await value("SELECT count(*) AS result FROM public.sentlog_delta_events WHERE project_id=$1 AND event_id='frozen-event'",[pid]))===0);
  const badPid='55000000-0000-4000-8000-000000000002',badPayload=copy(original);badPayload.project.id='broken-envelope-client';
  badPayload.project.deltaMetadata={version:1,namespace:M.namespace,records:{},retainedDrawings:[]};
  await db.query("INSERT INTO public.sentlog_projects(id,owner_id,status,client_key) VALUES($1,$2,'active',$3)",[badPid,owner,badPayload.project.id]);
  await db.query('INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload,updated_by_device) VALUES($1,$2,1,$3::jsonb,$4)',[badPid,owner,JSON.stringify(badPayload),phone]);
  await asUser();const badBaseline=await value('SELECT public.sentlog_delta_prepare_baseline_v1($1,$2,1) AS result',[badPid,phone]);
  await value('SELECT public.sentlog_delta_import_baseline_batch_v1($1,$2,$3,100) AS result',[badPid,phone,badBaseline.baselineId]);
  await failure('failed metadata/checkpoint activation returns an error',()=>activate(badPid,badBaseline.baselineId),'22023','DELTA_METADATA_BASELINE_INCOMPLETE');
  await asAdmin();
  check('failed public activation rolls back enablement, metadata, snapshot and device receipt',await value(`SELECT
    NOT h.enabled AND b.state='verified' AND s.revision=1 AND
    NOT EXISTS(SELECT 1 FROM sentlog_delta_private.record_states r WHERE r.project_id=h.project_id) AND
    NOT EXISTS(SELECT 1 FROM sentlog_delta_private.checkpoints c WHERE c.project_id=h.project_id) AND
    NOT EXISTS(SELECT 1 FROM sentlog_delta_private.device_migrations d WHERE d.project_id=h.project_id) AS result
    FROM sentlog_delta_private.heads h JOIN sentlog_delta_private.baselines b ON b.project_id=h.project_id
    JOIN public.sentlog_project_snapshots s ON s.project_id=h.project_id WHERE h.project_id=$1`,[badPid]));
  console.log(`PASS ${checks} certified checkpoint/actual archive integration checks`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
// Release rehearsal against the complete installed legacy protocols. PGlite is
// disposable and in-process; this test has no remote database connection.
if(!globalThis.crypto)globalThis.crypto=require('node:crypto').webcrypto;
const {PGlite}=require('@electric-sql/pglite');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assemble=(...args)=>execFileSync('python3',['scripts/assemble_delta_sync.py',...args],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
const legacyFiles=['db/archive_v1.sql','db/management_v1.sql','db/device_registration_v1.sql','db/capacity_v1.sql',
  'db/resilience_v2.sql','db/collaboration_v1.sql','db/photo_redelivery_v1.sql','db/device_photo_redelivery_v1.sql'];
const owner='11000000-0000-4000-8000-000000000001',other='11000000-0000-4000-8000-000000000002';
const phone='22000000-0000-4000-8000-000000000001',pc='22000000-0000-4000-8000-000000000002';
const otherPhone='22000000-0000-4000-8000-000000000003';
const projectIds=[1,2,3,4,5].map(n=>'33000000-0000-4000-8000-00000000000'+n);
const [target,ordinary,oldArchive,retired,otherProject]=projectIds;
const proof={writerVersion:2,migrationId:'release-rehearsal',sourceFingerprint:'a'.repeat(64),planSha256:'b'.repeat(64)};
const actor={deviceId:phone,deviceName:'Release phone'},clone=structuredClone;
const record=C.upgrade({id:'record-one',kind:'rect',type:'corrosion',x:1,y:2,w:3,h:4,memo:'before release',
  photos:[{id:'photo-one',name:'evidence.jpg',size:3,sha256:'c'.repeat(64)}]});
const payload=index=>({project:{id:'release-local-'+index,name:'Release project '+index,collaborationVersion:1,
  drawings:[{id:'drawing-one',name:'Main drawing',pdfFileId:'source-pdf'}],custom:{preserved:true}},
  drawings:[{meta:{id:'drawing-one',name:'Main drawing',pdfFileId:'source-pdf'},
    state:{shapes:[clone(record)],collabDeletedRecords:[],pageSettings:{'1':{scale:100,rotation:0}},unknown:{keep:['x',1]}}}],
  unknownHeader:{preserved:true}});

(async()=>{let checks=0;const db=new PGlite();
  const check=(label,condition)=>{assert(condition,label);checks++;console.log('PASS '+label);};
  const value=async(sql,args=[])=>{const result=await db.query(sql,args);return result.rows[0]?.result;};
  const fail=async(label,fn,code,marker)=>{await assert.rejects(fn,e=>(!code||e.code===code)&&(!marker||e.message.includes(marker)),label);checks++;console.log('PASS '+label);};
  const asUser=async(uid=owner)=>{await db.exec('SET ROLE authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[uid,JSON.stringify({'x-client-info':'sentlog-collaboration/1'})]);};
  const asAdmin=()=>db.exec('RESET ROLE');
  const archive=(action,pid,data={},device=phone)=>value('SELECT public.sentlog_archive_v1($1,$2,$3,$4::jsonb) AS result',[action,pid,device,JSON.stringify(data)]);
  const inspect=(pid,device=phone)=>value('SELECT public.sentlog_delta_inspect_v1($1,$2) AS result',[pid,device]);
  const image=async(tables,omitNew=false)=>{const result={};for(const table of tables){
    assert(/^[a-z_]+\.[a-z_0-9]+$/.test(table));
    const row=omitNew?"to_jsonb(t)-'delta_checkpoint'":'to_jsonb(t)';
    result[table]=await value(`SELECT coalesce(jsonb_agg(${row} ORDER BY (${row})::text),'[]'::jsonb) AS result FROM ${table} t`);
  }return result;};
  const businessTables=['public.sentlog_projects','public.sentlog_devices','public.sentlog_project_snapshots','public.sentlog_assets',
    'public.sentlog_pc_receipts','public.sentlog_asset_device_receipts','public.sentlog_pdf_requests','public.sentlog_pdf_leases',
    'sentlog_archive_private.jobs','sentlog_archive_private.capacity_ops','sentlog_archive_private.retired_projects',
    'sentlog_archive_private.removed_device_registrations','sentlog_archive_private.management_events','sentlog_archive_private.audit_v2','storage.objects'];
  const legacyDefinitions=async()=>{
    const functions=(await db.query(`SELECT p.oid::text,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args,
      pg_get_functiondef(p.oid) AS definition,p.proacl::text AS grants FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE (n.nspname='public' AND p.proname LIKE 'sentlog_%' AND p.proname NOT LIKE 'sentlog_delta_%') OR
        (n.nspname IN ('sentlog_archive_private','sentlog_collaboration_private') AND
         p.proname NOT IN ('gateway','guard_snapshot','capacity_gateway','catalog','catalog_legacy_v1'))
      ORDER BY n.nspname,p.proname,args`)).rows;
    const triggers=(await db.query(`SELECT t.oid::text,t.tgrelid::regclass::text AS relation,t.tgname,
      pg_get_triggerdef(t.oid) AS definition,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
      AND n.nspname IN ('public','sentlog_archive_private') AND t.tgname NOT LIKE 'sentlog_delta_%'
      ORDER BY relation,t.tgname`)).rows;
    const policy=await value("SELECT pg_get_expr(polqual,polrelid) AS result FROM pg_policy WHERE polrelid='realtime.messages'::regclass AND polname='sentlog_collaboration_receive'");
    return {functions,triggers,policy};
  };
  try{
    const sql=assemble(),manifest=JSON.parse(assemble('--manifest'));
    check('release SQL and manifest are deterministic',sql===assemble()&&JSON.stringify(manifest)===JSON.stringify(JSON.parse(assemble('--manifest'))));
    check('manifest binds all 13 reviewed sources to the exact SQL',manifest.components.length===13&&manifest.transactional===true&&manifest.activatesProjects===false&&manifest.enablesRollout===false&&manifest.sha256===createHash('sha256').update(sql).digest('hex'));
    const replacements=manifest.components.filter(x=>x.selection!=='transaction body');
    check('legacy upgrades select only the three required private functions',C.equal(replacements.map(x=>x.selection),[
      'sentlog_archive_private.gateway','sentlog_collaboration_private.guard_snapshot','sentlog_archive_private.capacity_gateway']));
    check('release does not ALTER the platform-owned Realtime table',! /\bALTER\s+TABLE\s+(?:ONLY\s+)?realtime\.messages\b/i.test(sql));
    await db.exec(read('tests/delta_release_legacy_fixture.sql'));
    for(const file of legacyFiles)await db.exec(read(file));
    const schemaReloads=[];await db.listen('pgrst',payload=>schemaReloads.push(payload));
    check('all eight actual legacy protocol files install before delta exists',await value("SELECT to_regnamespace('sentlog_delta_private') IS NULL AS result"));
    await db.query('INSERT INTO auth.users(id) VALUES($1),($2)',[owner,other]);
    for(const [id,uid,type,name] of [[phone,owner,'iphone','Release phone'],[pc,owner,'pc','Release PC'],[otherPhone,other,'iphone','Other phone']])
      await db.query('INSERT INTO public.sentlog_devices(id,owner_id,device_type,device_name) VALUES($1,$2,$3,$4)',[id,uid,type,name]);
    for(let index=0;index<projectIds.length;index++){
      const uid=index===4?other:owner,device=index===4?otherPhone:phone,pid=projectIds[index],snapshot=payload(index);
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[uid,JSON.stringify({'x-client-info':'sentlog-collaboration/1'})]);
      await db.query('INSERT INTO public.sentlog_projects(id,owner_id,client_key,name) VALUES($1,$2,$3,$4)',[pid,uid,snapshot.project.id,snapshot.project.name]);
      await db.query('INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload,updated_by_device) VALUES($1,$2,1,$3::jsonb,$4)',[pid,uid,JSON.stringify(snapshot),device]);
      for(const [key,kind,hash,size] of [['drawing:drawing-one','drawing','d'.repeat(64),10],['photo:drawing-one:photo-one','photo','c'.repeat(64),3]])
        await db.query("INSERT INTO public.sentlog_assets(project_id,owner_id,client_key,kind,file_name,mime_type,byte_size,sha256,storage_path,status) VALUES($1,$2,$3,$4,$3,$5,$6,$7,$8,'uploaded')",[pid,uid,key,kind,kind==='drawing'?'application/pdf':'image/jpeg',size,hash,pid+'/'+key]);
    }
    await asUser();
    const legacyJob=await archive('begin',oldArchive,{revision:1});
    await archive('report',oldArchive,{job_id:legacyJob.id,catalog_hash:legacyJob.catalog_hash,clean:true});
    await archive('pc_complete',oldArchive,{job_id:legacyJob.id,catalog_hash:legacyJob.catalog_hash,file_count:2,package_sha256:'e'.repeat(64),path:'fixture/old-backup'},pc);
    await archive('finalize',oldArchive,{job_id:legacyJob.id});
    await value('SELECT public.sentlog_management_v1($1,$2,$3,$4::jsonb) AS result',['project_retire',retired,phone,JSON.stringify({confirmed:true,confirm_name:payload(3).project.name})]);
    check('legacy management list distinguishes a retired project before deployment',(await archive('list',null)).some(x=>x.id===retired&&x.retired===true));
    await asAdmin();
    const before=await image(businessTables,true),legacyBefore=await legacyDefinitions();
    await db.exec('ALTER TABLE realtime.messages DISABLE ROW LEVEL SECURITY');
    await fail('preflight refuses a managed Realtime table with RLS disabled',()=>db.exec(sql),'55000','DELTA_RELEASE_REALTIME_RLS_REQUIRED');
    await db.exec('ROLLBACK');
    check('failed Realtime preflight neither enables RLS nor installs any delta object',await value("SELECT NOT relrowsecurity AND to_regnamespace('sentlog_delta_private') IS NULL AS result FROM pg_class WHERE oid='realtime.messages'::regclass"));
    await db.exec('ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY');
    await db.exec('ALTER TABLE public.sentlog_project_snapshots DISABLE TRIGGER sentlog_collaboration_snapshot_guard');
    await fail('preflight refuses an installed but disabled collaboration guard',()=>db.exec(sql),'55000','DELTA_RELEASE_COLLABORATION_GUARD_REQUIRED');
    await db.exec('ROLLBACK');
    check('failed preflight creates no partial delta schema',await value("SELECT to_regnamespace('sentlog_delta_private') IS NULL AS result"));
    await db.exec('ALTER TABLE public.sentlog_project_snapshots ENABLE TRIGGER sentlog_collaboration_snapshot_guard');
    const broken=sql.replace(/\nCOMMIT;\s*$/, "\nDO $release_failure$ BEGIN RAISE EXCEPTION 'RELEASE_REHEARSAL_ROLLBACK'; END $release_failure$;\nCOMMIT;\n");
    assert.notEqual(broken,sql);
    await fail('a failure after all components aborts the entire release',()=>db.exec(broken),'P0001','RELEASE_REHEARSAL_ROLLBACK');
    await db.exec('ROLLBACK');
    check('late failure rolls back delta schema and the archive certificate column',await value("SELECT to_regnamespace('sentlog_delta_private') IS NULL AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='sentlog_archive_private' AND table_name='jobs' AND column_name='delta_checkpoint') AS result"));
    check('an aborted release never announces a PostgREST schema change',schemaReloads.length===0);
    check('late failure preserves all business rows, wrappers, guards, grants and realtime policy',C.equal(before,await image(businessTables,true))&&C.equal(legacyBefore,await legacyDefinitions()));
    await db.exec(sql);
    check('successful commit notifies PostgREST of the new RPC signatures',C.equal(schemaReloads,['reload schema']));
    check('successful install preserves every existing business row byte-for-byte',C.equal(before,await image(businessTables,true)));
    check('successful install preserves legacy wrappers, guards, grants and realtime policy',C.equal(legacyBefore,await legacyDefinitions()));
    check('successful release retains platform RLS and installs both restrictive topic guards',await value(`SELECT
      (SELECT relrowsecurity FROM pg_class WHERE oid='realtime.messages'::regclass) AND
      (SELECT count(*)=3 AND count(*) FILTER(WHERE polpermissive)=1 AND
        bool_and(CASE polname WHEN 'sentlog_delta_receive_own' THEN polpermissive AND polcmd='r'
          WHEN 'sentlog_delta_topic_guard' THEN NOT polpermissive AND polcmd='r'
          WHEN 'sentlog_delta_no_client_send' THEN NOT polpermissive AND polcmd='a' ELSE false END)
       FROM pg_policy WHERE polrelid='realtime.messages'::regclass AND polname LIKE 'sentlog_delta_%') AS result`));
    check('install creates no active heads, rollout grants, baselines or migration receipts',await value(`SELECT
      NOT EXISTS(SELECT 1 FROM sentlog_delta_private.heads) AND NOT EXISTS(SELECT 1 FROM sentlog_delta_private.rollouts)
      AND NOT EXISTS(SELECT 1 FROM sentlog_delta_private.baselines) AND NOT EXISTS(SELECT 1 FROM sentlog_delta_private.device_migrations) AS result`));
    await asUser();
    const modes=[];for(const pid of projectIds.slice(0,4))modes.push(await inspect(pid));
    await asUser(other);modes.push(await inspect(otherProject,otherPhone));await asUser();
    check('every existing active, archived and retired project remains on legacy saving by default',modes.every(x=>x.enabled===false&&x.canActivate===false&&x.snapshotRevision===1));
    const list=await archive('list',null);
    check('management decoration and the previously completed PC backup survive release',list.some(x=>x.id===retired&&x.retired===true)&&list.some(x=>x.id===oldArchive&&x.status==='archived'&&!x.retired));
    const legacySaved=payload(0);legacySaved.drawings[0].state.shapes[0]=C.appendComment(record,'legacy save after installation',{actor,at:2,revisionId:'release-legacy-comment',commentId:'release-legacy-comment-row'});
    await db.query('UPDATE public.sentlog_project_snapshots SET revision=revision+1,payload=$2::jsonb WHERE project_id=$1 AND revision=1',[target,JSON.stringify(legacySaved)]);
    check('actual collaboration and archive guards still accept a legacy CAS save',await value('SELECT revision=2 AND payload=$2::jsonb AS result FROM public.sentlog_project_snapshots WHERE project_id=$1',[target,JSON.stringify(legacySaved)]));
    await fail('existing legacy CAS protection still rejects a revision skip',()=>db.query('UPDATE public.sentlog_project_snapshots SET revision=revision+2 WHERE project_id=$1',[ordinary]),'P0001','別端末の変更');
    const baseline=await value('SELECT public.sentlog_delta_prepare_baseline_v1($1,$2,2) AS result',[target,phone]);
    await value('SELECT public.sentlog_delta_import_baseline_batch_v1($1,$2,$3,100) AS result',[target,phone,baseline.baselineId]);
    const activate=()=>value('SELECT public.sentlog_delta_activate_baseline_v1($1,$2,$3,$4::jsonb) AS result',[target,phone,baseline.baselineId,JSON.stringify(proof)]);
    await fail('a fully prepared baseline still cannot activate while rollout is disabled',activate,'55000','DELTA_ROLLOUT_DISABLED');
    await fail('owners cannot grant themselves a rollout from the application',()=>db.query('INSERT INTO sentlog_delta_private.rollouts(owner_id,enabled) VALUES($1,true)',[owner]),'42501');
    await fail('authenticated clients cannot read the private event log directly',()=>db.query('SELECT * FROM public.sentlog_delta_events'),'42501');
    await fail('authenticated clients cannot manufacture checkpoint authority',()=>db.query('INSERT INTO sentlog_delta_private.checkpoint_write_authority SELECT * FROM sentlog_delta_private.checkpoint_write_authority'),'42501');
    await db.exec('SET ROLE anon');
    await fail('anonymous clients cannot call inspection RPCs',()=>inspect(target),'42501');
    await asAdmin();
    await db.query('INSERT INTO sentlog_delta_private.rollouts(owner_id,enabled) VALUES($1,true)',[owner]);
    await asUser();
    check('explicit test rollout makes eligible projects available without activating any',!(await inspect(target)).enabled&&(await inspect(target)).canActivate&&!(await inspect(ordinary)).enabled);
    const activated=await activate();
    const cert=await value('SELECT public.sentlog_delta_publish_checkpoint_v1($1,$2,0,$3) AS result',[target,phone,'release-checkpoint-0']);
    check('app activation atomically seeds metadata and a certified legacy-readable snapshot',activated.state==='active'&&cert.revision===3&&cert.headSeq===0&&cert.payload.project.deltaMetadata.records.project&&cert.payload.unknownHeader.preserved&&cert.payload.drawings[0].state.shapes[0].memo.includes('legacy save after installation'));
    await fail('only the activated project rejects old snapshot writes',()=>db.query('UPDATE public.sentlog_project_snapshots SET revision=revision+1 WHERE project_id=$1',[target]),'55000','DELTA_SNAPSHOT_CHECKPOINT_REQUIRED');
    await db.query('UPDATE public.sentlog_project_snapshots SET revision=revision+1 WHERE project_id=$1 AND revision=1',[ordinary]);
    check('unactivated project keeps saving after another project switches',!(await inspect(ordinary)).enabled&&(await inspect(ordinary)).snapshotRevision===2);
    const current=legacySaved.drawings[0].state.shapes[0];
    const edited=C.appendComment(current,'accepted after activation',{actor,at:3,revisionId:'release-delta-comment',commentId:'release-delta-comment-row'});
    const event=D.diffRecord(current,edited,{eventId:'release-delta-event',projectId:target,deviceId:phone,drawingId:'drawing-one'});
    const receipt=await value('SELECT public.sentlog_delta_append_v1($1,$2,$3,$4,$5,$6::jsonb) AS result',[target,phone,event.eventId,event.drawingId,event.recordId,JSON.stringify(event)]);
    const finalCert=await value('SELECT public.sentlog_delta_publish_checkpoint_v1($1,$2,$3,$4) AS result',[target,phone,receipt.seq,'release-checkpoint-1']);
    check('the assembled delta protocol publishes accepted record history and settings',finalCert.headSeq===1&&finalCert.revision===4&&C.equal(finalCert.payload.drawings[0].state.shapes[0].collab,edited.collab)&&finalCert.payload.drawings[0].state.pageSettings['1'].scale===100);
    const job=await archive('begin',target,{revision:finalCert.revision});
    const deltaProof={schema:1,headSeq:finalCert.headSeq,cursor:finalCert.headSeq,pending:0,revision:finalCert.revision,payloadSha256:finalCert.payloadSha256};
    await archive('report',target,{job_id:job.id,catalog_hash:job.catalog_hash,clean:true,delta_proof:deltaProof});
    const reported=await archive('inspect',target,{job_id:job.id});
    check('the extracted legacy gateway persists the exact certified phone report',C.equal(reported.reports[phone].delta_proof,deltaProof)&&job.delta_checkpoint.payloadSha256===finalCert.payloadSha256);
    await archive('pc_complete',target,{job_id:job.id,catalog_hash:job.catalog_hash,file_count:2,package_sha256:'f'.repeat(64),path:'fixture/delta-backup'},pc);
    check('actual PC verification and legacy finalization archive the activated project',(await archive('finalize',target,{job_id:job.id})).status==='archived');
    const capacity=(action,data={},device=phone)=>value('SELECT public.sentlog_capacity_v1($1,$2,$3,$4::jsonb) AS result',[action,target,device,JSON.stringify(data)]);
    const op=await capacity('begin',{action:'verify',mode:'project'}),info=await capacity('inspect',{operation_id:op.id});
    const pcInfo=(await capacity('pc_jobs',{},pc)).find(x=>x.operation.id===op.id);
    check('the extracted capacity gateway supplies the same certificate to phone and PC',C.equal(info.job.delta_checkpoint,job.delta_checkpoint)&&C.equal(pcInfo.job.delta_checkpoint,job.delta_checkpoint));
    await capacity('pc_ready',{operation_id:op.id,catalog_hash:job.catalog_hash,package_sha256:'f'.repeat(64),file_count:2},pc);
    check('capacity verification completes through the real management and audit guards',(await capacity('finish',{operation_id:op.id})).finished===true);
    await asAdmin();
    check('the existing audit trigger records the new archive and capacity operations',Number(await value("SELECT count(*) AS result FROM sentlog_archive_private.audit_v2 WHERE project_id=$1",[target]))>=3);
    const deltaTables=(await db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname='sentlog_delta_private' OR (schemaname='public' AND tablename='sentlog_delta_events') ORDER BY 1")).rows.map(x=>x.name);
    const beforeReapply=await image([...businessTables,...deltaTables]),definitionsBeforeReapply=await legacyDefinitions();
    await db.exec(sql);
    check('reapplying the release preserves active histories, certificates, receipts and all business rows',C.equal(beforeReapply,await image([...businessTables,...deltaTables])));
    check('reapplying the release never replaces the installed legacy wrappers or guards',C.equal(definitionsBeforeReapply,await legacyDefinitions()));
    await asUser();
    const resumed=await inspect(target);
    check('reapply preserves the activated archived project while leaving other projects unactivated',resumed.enabled&&!resumed.canActivate&&resumed.headSeq===1&&!(await inspect(ordinary)).enabled&&!(await inspect(oldArchive)).enabled&&!(await inspect(retired)).enabled);
    check('management list still distinguishes retirement after reapplication',(await archive('list',null)).some(x=>x.id===retired&&x.retired===true));
    console.log(`PASS ${checks} atomic release/full legacy integration checks; sha256=${manifest.sha256}`);
  }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

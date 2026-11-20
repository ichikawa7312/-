-- Certified compatibility snapshots for the delta protocol.
-- Load after projection + metadata + archive compatibility supplements and the
-- real archive/collaboration protocols. No production activation is performed.
BEGIN;
ALTER TABLE sentlog_archive_private.jobs ADD COLUMN IF NOT EXISTS delta_checkpoint jsonb;
CREATE TABLE IF NOT EXISTS sentlog_delta_private.checkpoints(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES public.sentlog_projects(id),owner_id uuid NOT NULL REFERENCES auth.users(id),
 head_seq bigint NOT NULL CHECK(head_seq BETWEEN 0 AND 9007199254740991),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 payload jsonb NOT NULL,payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL REFERENCES public.sentlog_devices(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,head_seq),UNIQUE(project_id,revision)
);
CREATE TABLE IF NOT EXISTS sentlog_delta_private.checkpoint_requests(
 project_id uuid NOT NULL REFERENCES public.sentlog_projects(id),device_id uuid NOT NULL REFERENCES public.sentlog_devices(id),
 request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 512),expected_head bigint NOT NULL,
 checkpoint_id uuid NOT NULL REFERENCES sentlog_delta_private.checkpoints(id),
 PRIMARY KEY(project_id,device_id,request_id)
);
-- Only the publisher can populate this table. The exact transaction, owner,
-- device, revision, head and generated payload must all match the trigger row.
-- Unlike a custom GUC, the invoking client cannot manufacture this authority.
CREATE TABLE IF NOT EXISTS sentlog_delta_private.checkpoint_write_authority(
 transaction_id bigint NOT NULL,project_id uuid NOT NULL,owner_id uuid NOT NULL,device_id uuid NOT NULL,
 head_seq bigint NOT NULL,revision bigint NOT NULL,payload jsonb NOT NULL,payload_sha256 text NOT NULL,
 PRIMARY KEY(transaction_id,project_id)
);
CREATE TABLE IF NOT EXISTS sentlog_delta_private.archive_checkpoints(
 job_id uuid PRIMARY KEY REFERENCES sentlog_archive_private.jobs(id) DEFERRABLE INITIALLY DEFERRED,
 project_id uuid NOT NULL REFERENCES public.sentlog_projects(id),checkpoint_id uuid NOT NULL REFERENCES sentlog_delta_private.checkpoints(id),
 head_seq bigint NOT NULL,revision bigint NOT NULL,payload_sha256 text NOT NULL,catalog_hash text NOT NULL
);
ALTER TABLE sentlog_delta_private.checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentlog_delta_private.checkpoint_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentlog_delta_private.checkpoint_write_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentlog_delta_private.archive_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sentlog_delta_private.checkpoints,sentlog_delta_private.checkpoint_requests,
 sentlog_delta_private.checkpoint_write_authority,sentlog_delta_private.archive_checkpoints FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.checkpoint_authorizes_snapshot(
 pid uuid,owner uuid,revision bigint,payload jsonb,device uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $fn$
 SELECT auth.uid()=$2 AND EXISTS(
   SELECT 1 FROM sentlog_delta_private.checkpoint_write_authority a
   JOIN sentlog_delta_private.heads h ON h.project_id=a.project_id AND h.owner_id=a.owner_id
   WHERE a.transaction_id=pg_catalog.txid_current() AND a.project_id=$1 AND a.owner_id=$2 AND a.device_id=$5
     AND a.revision=$3 AND a.payload=$4 AND a.payload_sha256=sentlog_delta_private.json_digest($4)
     AND h.enabled AND h.last_seq=a.head_seq)
$fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.checkpoint_authorizes_snapshot(uuid,uuid,bigint,jsonb,uuid) FROM PUBLIC,anon;
-- Read-only transaction predicate used by the existing invoker snapshot guard.
-- It grants no write authority, and can only be true inside the publisher call.
GRANT EXECUTE ON FUNCTION sentlog_delta_private.checkpoint_authorizes_snapshot(uuid,uuid,bigint,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.guard_certified_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE enabled AND
   ((TG_OP<>'INSERT' AND project_id=OLD.project_id) OR (TG_OP<>'DELETE' AND project_id=NEW.project_id))) THEN
   IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id)) OR
     NOT sentlog_delta_private.checkpoint_authorizes_snapshot(
     NEW.project_id,NEW.owner_id,NEW.revision,NEW.payload,NEW.updated_by_device) THEN
     RAISE EXCEPTION 'DELTA_SNAPSHOT_CHECKPOINT_REQUIRED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.guard_certified_snapshot() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_delta_certified_snapshot_guard ON public.sentlog_project_snapshots;
CREATE TRIGGER sentlog_delta_certified_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sentlog_project_snapshots
 FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.guard_certified_snapshot();
-- Supersede only the previous delta guard, in the same transaction that
-- installs the full replacement. Archive/collaboration guards stay installed.
DO $replace_guard$
DECLARE old_guard record;
BEGIN
 FOR old_guard IN SELECT tgname FROM pg_catalog.pg_trigger
   WHERE tgrelid='public.sentlog_project_snapshots'::regclass AND NOT tgisinternal
     AND tgfoid=pg_catalog.to_regprocedure('sentlog_delta_private.reject_legacy_snapshot()') LOOP
   EXECUTE pg_catalog.format('DROP TRIGGER %I ON public.sentlog_project_snapshots',old_guard.tgname);
 END LOOP;
END $replace_guard$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.project_snapshot(pid uuid,local_project_id text,template jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE row_state record; drawing record; old_record jsonb; metadata jsonb; projected jsonb;
 project_data jsonb; documents jsonb:='{}'::jsonb; drawing_docs jsonb:='{}'::jsonb;
 visible_drawings jsonb:='[]'::jsonb; retained_drawings jsonb:='[]'::jsonb; drawing_metas jsonb:='[]'::jsonb;
 meta jsonb; state jsonb; shapes jsonb; tombstones jsonb; counters jsonb; record_value jsonb;
 n bigint; type_count bigint; type_name text; photo_count bigint; any_live boolean; prior_drawings jsonb;
BEGIN
 IF pg_catalog.to_regprocedure('sentlog_delta_private.materialize_metadata_document(text,jsonb)') IS NULL THEN
   RAISE EXCEPTION 'DELTA_METADATA_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
 prior_drawings:=coalesce(template->'drawings','[]'::jsonb)||coalesce(template#>'{project,deltaMetadata,retainedDrawings}','[]'::jsonb);
 FOR row_state IN SELECT record_id,collab FROM sentlog_delta_private.record_states
   WHERE project_id=pid AND drawing_id='@sentlog:metadata:v1' ORDER BY record_id COLLATE "C" LOOP
   metadata:=sentlog_delta_private.materialize_metadata_document(row_state.record_id,row_state.collab);
   IF metadata#>>'{identity,localProjectId}' IS DISTINCT FROM local_project_id THEN
     RAISE EXCEPTION 'DELTA_METADATA_PROJECT_MISMATCH' USING ERRCODE='22023'; END IF;
   projected:=sentlog_delta_private.project_record(row_state.record_id,row_state.collab);
   documents:=documents||pg_catalog.jsonb_build_object(row_state.record_id,projected->'record');
   IF metadata->>'kind'='project' THEN
     IF project_data IS NOT NULL OR row_state.record_id<>'project' OR metadata->'deleted'='true'::jsonb THEN
       RAISE EXCEPTION 'DELTA_METADATA_PROJECT_INVALID' USING ERRCODE='22023'; END IF;
     project_data:=metadata->'project';
   ELSIF metadata->>'kind'='drawing' THEN
     IF drawing_docs ? (metadata#>>'{identity,drawingId}') THEN
       RAISE EXCEPTION 'DELTA_METADATA_DRAWING_DUPLICATE' USING ERRCODE='22023'; END IF;
     drawing_docs:=drawing_docs||pg_catalog.jsonb_build_object(metadata#>>'{identity,drawingId}',metadata);
   ELSE RAISE EXCEPTION 'DELTA_METADATA_IDENTITY_INVALID' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF project_data IS NULL OR jsonb_typeof(project_data) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'DELTA_METADATA_BASELINE_REQUIRED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM sentlog_delta_private.record_states
   WHERE project_id=pid AND drawing_id<>'@sentlog:metadata:v1' AND NOT (drawing_docs ? drawing_id)) THEN
   RAISE EXCEPTION 'DELTA_CHECKPOINT_DRAWING_METADATA_MISSING' USING ERRCODE='55000'; END IF;
 FOR drawing IN SELECT key,value FROM pg_catalog.jsonb_each(drawing_docs)
   ORDER BY (value->>'order')::numeric NULLS LAST,key COLLATE "C" LOOP
   meta:=coalesce(drawing.value->'meta','{}'::jsonb)||pg_catalog.jsonb_build_object('id',drawing.key);
   state:=coalesce(drawing.value->'state','{}'::jsonb); shapes:='[]'::jsonb; tombstones:='[]'::jsonb;
   counters:='{}'::jsonb;n:=0;photo_count:=0;any_live:=false;
   FOR row_state IN
     SELECT r.record_id,r.collab,prior.value AS prior_record FROM sentlog_delta_private.record_states r
     LEFT JOIN LATERAL (
       SELECT old.value,old.pos FROM pg_catalog.jsonb_array_elements(prior_drawings) d(value)
       CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(coalesce(d.value#>'{state,shapes}','[]'::jsonb)||
         coalesce(d.value#>'{state,collabDeletedRecords}','[]'::jsonb)) WITH ORDINALITY old(value,pos)
       WHERE d.value#>>'{meta,id}'=r.drawing_id AND old.value->>'id'=r.record_id LIMIT 1
     ) prior ON true
     WHERE r.project_id=pid AND r.drawing_id=drawing.key
     ORDER BY prior.pos NULLS LAST,r.record_id COLLATE "C"
   LOOP
     projected:=sentlog_delta_private.project_record(row_state.record_id,row_state.collab);record_value:=projected->'record';
     IF row_state.prior_record ? 'labelPosEditedAt' THEN
       record_value:=record_value||pg_catalog.jsonb_build_object('labelPosEditedAt',row_state.prior_record->'labelPosEditedAt'); END IF;
     IF projected->'deleted'='true'::jsonb THEN tombstones:=tombstones||pg_catalog.jsonb_build_array(record_value);
     ELSE
       any_live:=true;
       IF coalesce(record_value->>'recordKind','') NOT IN ('drawing-memo','dimension-line') AND
          coalesce(record_value->>'kind','')<>'dimension' THEN
         type_name:=coalesce(nullif(record_value->>'type',''),'腐食');
         type_count:=coalesce((counters->>type_name)::bigint,0)+1;n:=n+1;
         counters:=counters||pg_catalog.jsonb_build_object(type_name,type_count);
         record_value:=record_value||pg_catalog.jsonb_build_object('globalNo',n,'typeNo',type_count,'autoLabel',type_name||'-'||type_count);
         IF record_value->>'recordKind'='field-record' THEN record_value:=record_value||pg_catalog.jsonb_build_object('recordNo',type_count); END IF;
       END IF;
       photo_count:=photo_count+pg_catalog.jsonb_array_length(record_value->'photos');
       shapes:=shapes||pg_catalog.jsonb_build_array(record_value);
     END IF;
   END LOOP;
   state:=state||pg_catalog.jsonb_build_object('shapes',shapes,'collabDeletedRecords',tombstones,'nextGlobalNo',n+1,'typeCounters',counters);
   meta:=meta||pg_catalog.jsonb_build_object('shapeCount',n,'photoCount',photo_count);
   IF drawing.value->'deleted'='true'::jsonb AND NOT any_live THEN
     retained_drawings:=retained_drawings||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('meta',meta,'state',state));
   ELSE
     drawing_metas:=drawing_metas||pg_catalog.jsonb_build_array(meta);
     visible_drawings:=visible_drawings||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('meta',meta,'state',state));
   END IF;
 END LOOP;
 project_data:=project_data||pg_catalog.jsonb_build_object('id',local_project_id,'collaborationVersion',1,'drawings',drawing_metas,
   'deltaMetadata',pg_catalog.jsonb_build_object('version',1,'namespace','@sentlog:metadata:v1','records',documents,'retainedDrawings',retained_drawings));
 RETURN (coalesce(template,'{}'::jsonb)-'rawEntries')||pg_catalog.jsonb_build_object('project',project_data,'drawings',visible_drawings);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.project_snapshot(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.checkpoint_response(
 cp sentlog_delta_private.checkpoints,device uuid,request text
) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_build_object('schema',1,'projectId',cp.project_id,'deviceId',device,'requestId',request,
   'checkpointId',cp.id,'headSeq',cp.head_seq,'revision',cp.revision,'payloadSha256',cp.payload_sha256,'payload',cp.payload)
$fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.publish_checkpoint(
 p_project_id uuid,p_device_id uuid,p_expected_head bigint,p_request_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE u uuid:=auth.uid();p public.sentlog_projects%ROWTYPE;h sentlog_delta_private.heads%ROWTYPE;
 s public.sentlog_project_snapshots%ROWTYPE;cp sentlog_delta_private.checkpoints%ROWTYPE;
 request sentlog_delta_private.checkpoint_requests%ROWTYPE;generated jsonb;digest text;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'DELTA_AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_expected_head IS NULL OR p_expected_head NOT BETWEEN 0 AND 9007199254740991 OR
   NOT sentlog_delta_private.valid_id(pg_catalog.to_jsonb(p_request_id)) THEN
   RAISE EXCEPTION 'DELTA_CHECKPOINT_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
 -- Take the legacy table gate before project/row locks. An old direct UPDATE
 -- otherwise locks its snapshot row before its archive trigger locks project,
 -- which would invert the publisher's lock order. This checkpoint-only gate is
 -- short lived; it does not serialize ordinary delta editing.
 LOCK TABLE public.sentlog_project_snapshots IN SHARE ROW EXCLUSIVE MODE;
 -- Same lock order as archive: project, then delta head. Appends hold SHARE on
 -- project first, so an in-flight event either finishes before this exact head
 -- check or waits until the certificate and snapshot commit together.
 SELECT * INTO p FROM public.sentlog_projects WHERE id=p_project_id AND owner_id=u AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_PROJECT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.sentlog_devices WHERE id=p_device_id AND owner_id=u AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_DEVICE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO h FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND owner_id=u AND enabled FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_NOT_ENABLED' USING ERRCODE='55000'; END IF;
 SELECT * INTO request FROM sentlog_delta_private.checkpoint_requests
   WHERE project_id=p_project_id AND device_id=p_device_id AND request_id=p_request_id;
 IF FOUND AND request.expected_head IS DISTINCT FROM p_expected_head THEN
   RAISE EXCEPTION 'DELTA_CHECKPOINT_REQUEST_COLLISION' USING ERRCODE='22023'; END IF;
 IF h.last_seq<>p_expected_head THEN RAISE EXCEPTION 'DELTA_CHECKPOINT_STALE_HEAD' USING ERRCODE='40001'; END IF;
 SELECT * INTO s FROM public.sentlog_project_snapshots WHERE project_id=p_project_id AND owner_id=u FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_CHECKPOINT_SNAPSHOT_MISSING' USING ERRCODE='55000'; END IF;
 SELECT * INTO cp FROM sentlog_delta_private.checkpoints WHERE project_id=p_project_id AND head_seq=p_expected_head;
 IF FOUND THEN
   IF s.revision<>cp.revision OR s.payload IS DISTINCT FROM cp.payload OR
     sentlog_delta_private.json_digest(s.payload)<>cp.payload_sha256 THEN
     RAISE EXCEPTION 'DELTA_CHECKPOINT_SNAPSHOT_MISMATCH' USING ERRCODE='55000'; END IF;
 ELSE
   PERFORM sentlog_delta_private.assert_archive_writable(p_project_id);
   IF s.revision>=9007199254740991 THEN RAISE EXCEPTION 'DELTA_CHECKPOINT_REVISION_EXHAUSTED' USING ERRCODE='55000'; END IF;
   generated:=sentlog_delta_private.project_snapshot(p_project_id,p.client_key,s.payload);
   digest:=sentlog_delta_private.json_digest(generated);
   INSERT INTO sentlog_delta_private.checkpoint_write_authority
     VALUES(pg_catalog.txid_current(),p_project_id,u,p_device_id,h.last_seq,s.revision+1,generated,digest);
   UPDATE public.sentlog_project_snapshots SET revision=s.revision+1,payload=generated,
     updated_by_device=p_device_id,updated_at=pg_catalog.now() WHERE project_id=p_project_id;
   INSERT INTO sentlog_delta_private.checkpoints(project_id,owner_id,head_seq,revision,payload,payload_sha256,created_by)
     VALUES(p_project_id,u,h.last_seq,s.revision+1,generated,digest,p_device_id) RETURNING * INTO cp;
   DELETE FROM sentlog_delta_private.checkpoint_write_authority WHERE transaction_id=pg_catalog.txid_current() AND project_id=p_project_id;
 END IF;
 INSERT INTO sentlog_delta_private.checkpoint_requests(project_id,device_id,request_id,expected_head,checkpoint_id)
   VALUES(p_project_id,p_device_id,p_request_id,p_expected_head,cp.id) ON CONFLICT DO NOTHING;
 RETURN sentlog_delta_private.checkpoint_response(cp,p_device_id,p_request_id);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.checkpoint_response(sentlog_delta_private.checkpoints,uuid,text),
 sentlog_delta_private.publish_checkpoint(uuid,uuid,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.publish_checkpoint(uuid,uuid,bigint,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.sentlog_delta_publish_checkpoint_v1(
 p_project_id uuid,p_device_id uuid,p_expected_head bigint,p_request_id text
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.publish_checkpoint(p_project_id,p_device_id,p_expected_head,p_request_id) $fn$;
REVOKE ALL ON FUNCTION public.sentlog_delta_publish_checkpoint_v1(uuid,uuid,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_delta_publish_checkpoint_v1(uuid,uuid,bigint,text) TO authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.current_checkpoint(pid uuid)
RETURNS sentlog_delta_private.checkpoints LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE cp sentlog_delta_private.checkpoints%ROWTYPE;
BEGIN
 SELECT c.* INTO cp FROM sentlog_delta_private.checkpoints c
 JOIN sentlog_delta_private.heads h ON h.project_id=c.project_id AND h.owner_id=c.owner_id AND h.enabled AND h.last_seq=c.head_seq
 JOIN public.sentlog_project_snapshots s ON s.project_id=c.project_id AND s.owner_id=c.owner_id AND s.revision=c.revision AND s.payload=c.payload
 WHERE c.project_id=pid AND c.payload_sha256=sentlog_delta_private.json_digest(s.payload);
 IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_ARCHIVE_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
 RETURN cp;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.current_checkpoint(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.guard_legacy_archive_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE cp sentlog_delta_private.checkpoints%ROWTYPE;proof sentlog_delta_private.archive_checkpoints%ROWTYPE;report record;manifest jsonb;
BEGIN
 IF NEW.state NOT IN ('checking','archived') THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.sentlog_projects WHERE id=NEW.project_id FOR UPDATE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id=NEW.project_id AND enabled) THEN RETURN NEW; END IF;
 cp:=sentlog_delta_private.current_checkpoint(NEW.project_id);
 IF NEW.owner_id<>cp.owner_id OR NEW.revision<>cp.revision OR NEW.payload IS DISTINCT FROM cp.payload THEN
   RAISE EXCEPTION 'DELTA_ARCHIVE_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'checking' THEN RAISE EXCEPTION 'DELTA_ARCHIVE_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
   manifest:=sentlog_delta_private.checkpoint_catalog(NEW.project_id);
   IF NEW.manifest IS DISTINCT FROM manifest OR NEW.catalog_hash IS DISTINCT FROM
     pg_catalog.encode(extensions.digest(cp.payload::text||manifest::text,'sha256'),'hex') THEN
     RAISE EXCEPTION 'DELTA_ARCHIVE_MANIFEST_MISMATCH' USING ERRCODE='55000'; END IF;
   INSERT INTO sentlog_delta_private.archive_checkpoints(job_id,project_id,checkpoint_id,head_seq,revision,payload_sha256,catalog_hash)
     VALUES(NEW.id,NEW.project_id,cp.id,cp.head_seq,cp.revision,cp.payload_sha256,NEW.catalog_hash);
   NEW.delta_checkpoint:=pg_catalog.jsonb_build_object('schema',1,'projectId',NEW.project_id,'checkpointId',cp.id,
     'headSeq',cp.head_seq,'revision',cp.revision,'payloadSha256',cp.payload_sha256);
 ELSE
   SELECT * INTO proof FROM sentlog_delta_private.archive_checkpoints WHERE job_id=NEW.id;
   IF NOT FOUND OR proof.project_id<>NEW.project_id OR proof.checkpoint_id<>cp.id OR proof.head_seq<>cp.head_seq OR
     proof.revision<>NEW.revision OR proof.payload_sha256<>cp.payload_sha256 OR proof.catalog_hash<>NEW.catalog_hash OR
     OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id OR
     OLD.payload IS DISTINCT FROM NEW.payload OR OLD.manifest IS DISTINCT FROM NEW.manifest OR OLD.revision IS DISTINCT FROM NEW.revision OR
     OLD.delta_checkpoint IS DISTINCT FROM NEW.delta_checkpoint THEN
     RAISE EXCEPTION 'DELTA_ARCHIVE_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
 END IF;
 FOR report IN SELECT key,value FROM pg_catalog.jsonb_each(NEW.reports) LOOP
   IF report.value->'clean'='true'::jsonb AND (
     report.value#>'{delta_proof,schema}' IS DISTINCT FROM '1'::jsonb OR
     report.value#>'{delta_proof,headSeq}' IS DISTINCT FROM pg_catalog.to_jsonb(cp.head_seq) OR
     ((report.value#>'{delta_proof,cursor}'=pg_catalog.to_jsonb(cp.head_seq) AND
             report.value#>'{delta_proof,absent}' IS DISTINCT FROM 'true'::jsonb) OR
          (report.value#>'{delta_proof,absent}'='true'::jsonb AND report.value#>'{delta_proof,cursor}'='null'::jsonb)) IS DISTINCT FROM true OR
     report.value#>'{delta_proof,pending}' IS DISTINCT FROM '0'::jsonb OR
     report.value#>'{delta_proof,revision}' IS DISTINCT FROM pg_catalog.to_jsonb(cp.revision) OR
     report.value#>>'{delta_proof,payloadSha256}' IS DISTINCT FROM cp.payload_sha256) THEN
     RAISE EXCEPTION 'DELTA_ARCHIVE_DEVICE_PROOF_REQUIRED' USING ERRCODE='55000'; END IF;
 END LOOP;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.guard_legacy_archive_job() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.guard_legacy_archive_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE cp sentlog_delta_private.checkpoints%ROWTYPE;
BEGIN
 IF NEW.status='archived' AND OLD.status IS DISTINCT FROM NEW.status AND
   EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id=NEW.id AND enabled) THEN
   cp:=sentlog_delta_private.current_checkpoint(NEW.id);
   IF NOT EXISTS(SELECT 1 FROM sentlog_archive_private.jobs j
     JOIN sentlog_delta_private.archive_checkpoints a ON a.job_id=j.id AND a.project_id=j.project_id
     WHERE j.project_id=NEW.id AND j.state='checking' AND j.expires_at>pg_catalog.now() AND a.checkpoint_id=cp.id
       AND a.head_seq=cp.head_seq AND a.revision=cp.revision AND a.payload_sha256=cp.payload_sha256
       AND j.revision=cp.revision AND j.payload=cp.payload AND j.catalog_hash=a.catalog_hash) THEN
     RAISE EXCEPTION 'DELTA_ARCHIVE_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.guard_legacy_archive_status() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.checkpoint_asset(pid uuid,asset_key text,asset_kind text,manifest_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE files jsonb;result jsonb;
BEGIN
 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',a.id,'kind',a.kind,'key',manifest_key,
   'file_name',a.file_name,'mime_type',a.mime_type,'byte_size',a.byte_size,'sha256',pg_catalog.lower(a.sha256),
   'storage_path',a.storage_path,'status',a.status,'pc_path',r.pc_path)) INTO files
 FROM public.sentlog_assets a LEFT JOIN public.sentlog_pc_receipts r ON r.asset_id=a.id
 JOIN public.sentlog_projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
 WHERE a.project_id=pid AND a.client_key=asset_key AND a.kind=asset_kind
   AND a.status IN ('uploaded','pc_verified','storage_deleted');
 IF files IS NULL OR pg_catalog.jsonb_array_length(files)<>1 THEN
   RAISE EXCEPTION 'DELTA_ARCHIVE_ASSET_REQUIRED: %',asset_key USING ERRCODE='55000'; END IF;
 result:=files->0;
 IF (result->>'sha256') !~ '^[0-9a-f]{64}$' OR (result->>'byte_size')::bigint<=0 THEN
   RAISE EXCEPTION 'DELTA_ARCHIVE_ASSET_INVALID: %',asset_key USING ERRCODE='55000'; END IF;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.checkpoint_asset(uuid,text,text,text) FROM PUBLIC,anon,authenticated;

-- A restorable checkpoint includes photos retained by deleted records and
-- deleted drawings. The old visible-photo catalog omitted those bytes even
-- though their immutable histories remained in the archive JSON.
CREATE OR REPLACE FUNCTION sentlog_delta_private.checkpoint_catalog(pid uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE cp sentlog_delta_private.checkpoints%ROWTYPE;drawing jsonb;rec jsonb;photo jsonb;
 files jsonb:='[]'::jsonb;seen jsonb:='{}'::jsonb;identities jsonb:='{}'::jsonb;file jsonb;k text;did text;identity jsonb;
BEGIN
 cp:=sentlog_delta_private.current_checkpoint(pid);
 FOR drawing IN SELECT value FROM pg_catalog.jsonb_array_elements(cp.payload->'drawings'||
   coalesce(cp.payload#>'{project,deltaMetadata,retainedDrawings}','[]'::jsonb)) LOOP
   did:=drawing#>>'{meta,id}';k:='background:'||did;
   IF seen ? k THEN RAISE EXCEPTION 'DELTA_ARCHIVE_FILE_KEY_COLLISION' USING ERRCODE='22023'; END IF;
   file:=sentlog_delta_private.checkpoint_asset(pid,'drawing:'||did,'drawing',k);
   seen:=seen||pg_catalog.jsonb_build_object(k,file);files:=files||pg_catalog.jsonb_build_array(file);
   FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(drawing#>'{state,shapes}'||
     coalesce(drawing#>'{state,collabDeletedRecords}','[]'::jsonb)) LOOP
     FOR photo IN
       SELECT value FROM pg_catalog.jsonb_array_elements(coalesce(rec->'photos','[]'::jsonb))
       UNION ALL
       SELECT revision.value->'value' FROM pg_catalog.jsonb_each(coalesce(rec#>'{collab,photos}','{}'::jsonb)) entry
       CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(entry.value->'revisions') revision(value)
     LOOP
       k:='photo:'||did||':'||(photo->>'id');identity:=pg_catalog.jsonb_build_array(did,photo->>'id');
       IF identities ? k AND identities->k IS DISTINCT FROM identity THEN
         RAISE EXCEPTION 'DELTA_ARCHIVE_FILE_KEY_COLLISION' USING ERRCODE='22023'; END IF;
       identities:=identities||pg_catalog.jsonb_build_object(k,identity);
       IF seen ? k THEN file:=seen->k;
       ELSE
         file:=sentlog_delta_private.checkpoint_asset(pid,k,'photo',k);
         seen:=seen||pg_catalog.jsonb_build_object(k,file);files:=files||pg_catalog.jsonb_build_array(file);
       END IF;
       IF (photo ? 'sha256' AND pg_catalog.lower(photo->>'sha256') IS DISTINCT FROM file->>'sha256') OR
          (photo ? 'size' AND (photo->>'size')::numeric IS DISTINCT FROM (file->>'byte_size')::numeric) OR
          (photo ? 'byte_size' AND (photo->>'byte_size')::numeric IS DISTINCT FROM (file->>'byte_size')::numeric) THEN
         RAISE EXCEPTION 'DELTA_ARCHIVE_ASSET_MISMATCH: %',k USING ERRCODE='55000'; END IF;
     END LOOP;
   END LOOP;
 END LOOP;
 RETURN files;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.checkpoint_catalog(uuid) FROM PUBLIC,anon,authenticated;

DO $catalog$
BEGIN
 IF pg_catalog.to_regprocedure('sentlog_archive_private.catalog_legacy_v1(uuid)') IS NULL THEN
   ALTER FUNCTION sentlog_archive_private.catalog(uuid) RENAME TO catalog_legacy_v1;
 END IF;
END $catalog$;
CREATE OR REPLACE FUNCTION sentlog_archive_private.catalog(pid uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id=pid AND enabled) THEN
   RETURN sentlog_delta_private.checkpoint_catalog(pid);
 END IF;
 RETURN sentlog_archive_private.catalog_legacy_v1(pid);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_archive_private.catalog(uuid),sentlog_archive_private.catalog_legacy_v1(uuid) FROM PUBLIC,anon,authenticated;
COMMIT;

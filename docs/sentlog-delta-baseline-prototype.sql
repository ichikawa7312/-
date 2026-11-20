-- ISOLATED PROTOTYPE ONLY. Do not apply to the production Supabase project.
-- Load after delta-v1-schema and delta-semantic-validation. This module does
-- not install the legacy-write trigger or enable any project on installation.
-- It copies only a server-owned, already collaboration-enabled snapshot;
-- device-local unsent work must be staged and reconciled separately.
-- prepare -> bounded validation batches -> privileged test-only activation.
BEGIN;

CREATE TABLE IF NOT EXISTS sentlog_delta_private.baselines (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.sentlog_projects(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  prepared_by uuid NOT NULL REFERENCES public.sentlog_devices(id) ON DELETE RESTRICT,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision BETWEEN 1 AND 9007199254740991),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  record_count bigint NOT NULL CHECK (record_count BETWEEN 0 AND 9007199254740991),
  imported_count bigint NOT NULL DEFAULT 0 CHECK (imported_count>=0 AND imported_count<=record_count),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','importing','verified','active')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  activated_at timestamptz,
  UNIQUE(project_id,snapshot_revision),
  CHECK (state NOT IN ('verified','active') OR imported_count=record_count),
  CHECK ((state='active')=(activated_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sentlog_delta_one_active_baseline
  ON sentlog_delta_private.baselines(project_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS sentlog_delta_private.baseline_records (
  baseline_id uuid NOT NULL REFERENCES sentlog_delta_private.baselines(id) ON DELETE RESTRICT,
  ordinal bigint NOT NULL CHECK (ordinal>0),
  drawing_id text NOT NULL,
  record_id text NOT NULL,
  record jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  verified boolean NOT NULL DEFAULT false,
  PRIMARY KEY(baseline_id,ordinal),
  UNIQUE(baseline_id,drawing_id,record_id)
);
ALTER TABLE sentlog_delta_private.baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentlog_delta_private.baseline_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sentlog_delta_private.baselines,sentlog_delta_private.baseline_records
  FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.json_digest(v jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v::text,'UTF8')),'hex')
$fn$;

-- Preserve the non-record part of the server snapshot as independently
-- verifiable, bounded pages. Empty drawings and settings must not disappear
-- merely because the record manifest has no entry for them.
CREATE OR REPLACE FUNCTION sentlog_delta_private.baseline_metadata(v jsonb)
RETURNS TABLE(ordinal bigint,kind text,key text,metadata jsonb)
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
  SELECT 1::bigint,'header'::text,'project'::text,v-'drawings'
  UNION ALL
  SELECT d.pos+1,'drawing'::text,d.value#>>'{meta,id}',
    pg_catalog.jsonb_set(d.value,'{state}',(d.value->'state')-'shapes'-'collabDeletedRecords')
  FROM pg_catalog.jsonb_array_elements(v->'drawings') WITH ORDINALITY d(value,pos)
$fn$;

-- Called within the narrowly scoped SECURITY DEFINER functions below. Hold
-- authorization rows until commit so archive/owner/device changes cannot race.
CREATE OR REPLACE FUNCTION sentlog_delta_private.baseline_authorize(pid uuid,did uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE u uuid:=(SELECT auth.uid());
BEGIN
  IF u IS NULL THEN RAISE EXCEPTION 'DELTA_LOGIN_REQUIRED' USING ERRCODE='28000'; END IF;
  PERFORM 1 FROM public.sentlog_projects WHERE id=pid AND owner_id=u AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_PROJECT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.sentlog_devices WHERE id=did AND owner_id=u AND active=true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_DEVICE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN u;
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.baseline_receipt(b sentlog_delta_private.baselines)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_build_object(
  'schema',1,'baselineId',b.id,'ownerId',b.owner_id,'projectId',b.project_id,
  'clientProjectId',b.snapshot#>>'{project,id}',
  'drawingIds',(SELECT coalesce(pg_catalog.jsonb_agg(d.value->'id' ORDER BY d.pos),'[]'::jsonb)
    FROM pg_catalog.jsonb_array_elements(b.snapshot#>'{project,drawings}') WITH ORDINALITY d(value,pos)),
  'snapshotRevision',b.snapshot_revision,'cursor',0,'recordCount',b.record_count,
  'importedCount',b.imported_count,'snapshotSha256',b.snapshot_sha256,
  'manifestSha256',b.manifest_sha256,'hashFormat','postgres-jsonb-text-sha256-v1',
  'metadataCount',pg_catalog.jsonb_array_length(b.snapshot->'drawings')+1,
  'metadataManifestSha256',sentlog_delta_private.json_digest(
    (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('ordinal',m.ordinal,
      'kind',m.kind,'key',m.key,'sha256',sentlog_delta_private.json_digest(m.metadata)) ORDER BY m.ordinal)
     FROM sentlog_delta_private.baseline_metadata(b.snapshot) m)),
  'state',b.state,'deltaEnabled',coalesce((SELECT h.enabled
    FROM sentlog_delta_private.heads h WHERE h.project_id=b.project_id AND h.owner_id=b.owner_id),false),
  'deviceMigrationVerified',false,'assetDeliveryVerified',false)
$fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.prepare_baseline(
  p_project_id uuid,p_device_id uuid,p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
  u uuid; s public.sentlog_project_snapshots%ROWTYPE;
  h sentlog_delta_private.heads%ROWTYPE; b sentlog_delta_private.baselines%ROWTYPE;
  item jsonb; entry jsonb; n bigint; manifest jsonb;
BEGIN
  u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
  IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION 'DELTA_BASELINE_REVISION_INVALID' USING ERRCODE='22023';
  END IF;
  -- Lock the existing snapshot first. No caller-supplied record can become the
  -- server baseline, and a concurrent old save must either precede or follow it.
  SELECT * INTO s FROM public.sentlog_project_snapshots
    WHERE project_id=p_project_id AND owner_id=u FOR SHARE;
  IF NOT FOUND OR s.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'DELTA_BASELINE_STALE' USING ERRCODE='40001';
  END IF;
  INSERT INTO sentlog_delta_private.heads(project_id,owner_id)
    VALUES(p_project_id,u) ON CONFLICT(project_id) DO NOTHING;
  SELECT * INTO h FROM sentlog_delta_private.heads WHERE project_id=p_project_id FOR UPDATE;
  IF h.owner_id IS DISTINCT FROM u THEN
    RAISE EXCEPTION 'DELTA_BASELINE_SCOPE' USING ERRCODE='42501'; END IF;
  SELECT * INTO b FROM sentlog_delta_private.baselines
    WHERE project_id=p_project_id AND snapshot_revision=p_expected_revision FOR UPDATE;
  IF FOUND THEN
    IF b.owner_id IS DISTINCT FROM u OR b.snapshot IS DISTINCT FROM s.payload THEN
      RAISE EXCEPTION 'DELTA_BASELINE_REVISION_REUSED' USING ERRCODE='22023'; END IF;
    IF h.enabled IS DISTINCT FROM (b.state='active') THEN
      RAISE EXCEPTION 'DELTA_BASELINE_STATE' USING ERRCODE='55000'; END IF;
    RETURN sentlog_delta_private.baseline_receipt(b);
  END IF;
  IF h.enabled OR h.last_seq<>0 OR EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id=p_project_id)
     OR EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id=p_project_id) THEN
    RAISE EXCEPTION 'DELTA_BASELINE_NONEMPTY' USING ERRCODE='55000'; END IF;
  IF jsonb_typeof(s.payload) IS DISTINCT FROM 'object' OR
    s.payload#>'{project,collaborationVersion}' IS DISTINCT FROM '1'::jsonb OR
    NOT EXISTS(SELECT 1 FROM public.sentlog_projects p WHERE p.id=p_project_id
      AND p.client_key=s.payload#>>'{project,id}') OR
    jsonb_typeof(s.payload#>'{project,drawings}') IS DISTINCT FROM 'array' OR
    jsonb_typeof(s.payload->'drawings') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'DELTA_BASELINE_COLLAB_SNAPSHOT_REQUIRED' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(s.payload#>'{project,drawings}') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT sentlog_delta_private.valid_id(item->'id') THEN
      RAISE EXCEPTION 'DELTA_BASELINE_DRAWING_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(s.payload->'drawings') LOOP
    IF NOT sentlog_delta_private.valid_id(item#>'{meta,id}') OR
      jsonb_typeof(item->'state') IS DISTINCT FROM 'object' OR
      jsonb_typeof(item#>'{state,shapes}') IS DISTINCT FROM 'array' OR
      ((item->'state') ? 'collabDeletedRecords' AND
        jsonb_typeof(item#>'{state,collabDeletedRecords}') IS DISTINCT FROM 'array') THEN
      RAISE EXCEPTION 'DELTA_BASELINE_DRAWING_STATE_REQUIRED' USING ERRCODE='22023'; END IF;
    FOR entry IN SELECT value FROM pg_catalog.jsonb_array_elements(item#>'{state,shapes}' ||
      coalesce(item#>'{state,collabDeletedRecords}','[]'::jsonb)) LOOP
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR NOT sentlog_delta_private.valid_id(entry->'id') THEN
        RAISE EXCEPTION 'DELTA_BASELINE_RECORD_INVALID' USING ERRCODE='22023'; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(s.payload->'drawings') d
       GROUP BY d.value#>>'{meta,id}' HAVING count(*)>1) OR
     EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(s.payload#>'{project,drawings}') d
       GROUP BY d.value->>'id' HAVING count(*)>1) OR
     (SELECT coalesce(pg_catalog.jsonb_agg(d.value->'id' ORDER BY d.value->>'id'),'[]'::jsonb)
       FROM pg_catalog.jsonb_array_elements(s.payload#>'{project,drawings}') d) IS DISTINCT FROM
     (SELECT coalesce(pg_catalog.jsonb_agg(d.value#>'{meta,id}' ORDER BY d.value#>>'{meta,id}'),'[]'::jsonb)
       FROM pg_catalog.jsonb_array_elements(s.payload->'drawings') d) THEN
    RAISE EXCEPTION 'DELTA_BASELINE_DRAWINGS_MISMATCH' USING ERRCODE='22023'; END IF;
  INSERT INTO sentlog_delta_private.baselines
    (project_id,owner_id,prepared_by,snapshot_revision,snapshot,snapshot_sha256,manifest_sha256,record_count)
    VALUES(p_project_id,u,p_device_id,s.revision,s.payload,
      sentlog_delta_private.json_digest(s.payload),sentlog_delta_private.json_digest('[]'::jsonb),0)
    RETURNING * INTO b;
  -- Preserve ordinary AND deleted records. The composite unique key rejects
  -- duplicates even across those two arrays. A collision rolls back preparation.
  INSERT INTO sentlog_delta_private.baseline_records(baseline_id,ordinal,drawing_id,record_id,record,sha256)
    SELECT b.id,row_number() OVER(ORDER BY d.pos,r.pos),d.value#>>'{meta,id}',r.value->>'id',r.value,
      sentlog_delta_private.json_digest(r.value)
    FROM pg_catalog.jsonb_array_elements(s.payload->'drawings') WITH ORDINALITY d(value,pos)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(d.value#>'{state,shapes}' ||
      coalesce(d.value#>'{state,collabDeletedRecords}','[]'::jsonb)) WITH ORDINALITY r(value,pos);
  SELECT count(*),coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'ordinal',ordinal,'drawingId',drawing_id,'recordId',record_id,'sha256',sha256) ORDER BY ordinal),'[]'::jsonb)
    INTO n,manifest FROM sentlog_delta_private.baseline_records WHERE baseline_id=b.id;
  UPDATE sentlog_delta_private.baselines SET record_count=n,
    manifest_sha256=sentlog_delta_private.json_digest(manifest),state=CASE WHEN n=0 THEN 'verified' ELSE 'prepared' END
    WHERE id=b.id RETURNING * INTO b;
  RETURN sentlog_delta_private.baseline_receipt(b);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.import_baseline_batch(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
  u uuid; s public.sentlog_project_snapshots%ROWTYPE;
  h sentlog_delta_private.heads%ROWTYPE; b sentlog_delta_private.baselines%ROWTYPE;
  r sentlog_delta_private.baseline_records%ROWTYPE; e jsonb; n integer:=0;
BEGIN
  u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'DELTA_BASELINE_BATCH_LIMIT' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM public.sentlog_project_snapshots
    WHERE project_id=p_project_id AND owner_id=u FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_BASELINE_STALE' USING ERRCODE='40001'; END IF;
  SELECT * INTO h FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND owner_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_BASELINE_MISSING' USING ERRCODE='55000'; END IF;
  SELECT * INTO b FROM sentlog_delta_private.baselines
    WHERE id=p_baseline_id AND project_id=p_project_id AND owner_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_BASELINE_MISSING' USING ERRCODE='55000'; END IF;
  IF s.revision IS DISTINCT FROM b.snapshot_revision OR s.payload IS DISTINCT FROM b.snapshot THEN
    RAISE EXCEPTION 'DELTA_BASELINE_STALE' USING ERRCODE='40001'; END IF;
  IF h.enabled OR b.state='active' OR h.last_seq<>0 THEN
    RAISE EXCEPTION 'DELTA_BASELINE_ALREADY_ACTIVE' USING ERRCODE='55000'; END IF;
  FOR r IN SELECT * FROM sentlog_delta_private.baseline_records
    WHERE baseline_id=b.id AND ordinal>b.imported_count ORDER BY ordinal LIMIT p_limit LOOP
    IF r.ordinal<>b.imported_count+n+1 OR r.verified THEN
      RAISE EXCEPTION 'DELTA_BASELINE_PROGRESS_INVALID' USING ERRCODE='55000'; END IF;
    e:=pg_catalog.jsonb_build_object('schema',1,'eventId','baseline:'||b.id||':'||r.ordinal,
      'projectId',p_project_id,'deviceId',p_device_id,'drawingId',r.drawing_id,
      'recordId',r.record_id,'kind','create','record',r.record);
    PERFORM sentlog_delta_private.validate_payload(e);
    PERFORM sentlog_delta_private.validate_record_graph(r.record->'collab');
    UPDATE sentlog_delta_private.baseline_records SET verified=true WHERE baseline_id=b.id AND ordinal=r.ordinal;
    n:=n+1;
  END LOOP;
  IF n=0 AND b.imported_count<>b.record_count THEN
    RAISE EXCEPTION 'DELTA_BASELINE_RECORDS_MISSING' USING ERRCODE='55000'; END IF;
  -- Each batch is atomic. A malformed last record rolls back the whole batch,
  -- while earlier committed batches remain resumable and cannot enable delta.
  UPDATE sentlog_delta_private.baselines SET imported_count=imported_count+n,
    state=CASE WHEN imported_count+n=record_count THEN 'verified' ELSE 'importing' END
    WHERE id=b.id RETURNING * INTO b;
  RETURN sentlog_delta_private.baseline_receipt(b);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.read_baseline_page(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
  u uuid; b sentlog_delta_private.baselines%ROWTYPE;
  r sentlog_delta_private.baseline_records%ROWTYPE;
  page jsonb:='[]'::jsonb; item jsonb; used_bytes bigint:=0; next_ordinal bigint;
BEGIN
  u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
  SELECT * INTO b FROM sentlog_delta_private.baselines
    WHERE id=p_baseline_id AND project_id=p_project_id AND owner_id=u;
  IF NOT FOUND OR b.state NOT IN ('verified','active') THEN
    RAISE EXCEPTION 'DELTA_BASELINE_NOT_VERIFIED' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.sentlog_projects WHERE id=p_project_id AND owner_id=u
      AND client_key=b.snapshot#>>'{project,id}') THEN
    RAISE EXCEPTION 'DELTA_BASELINE_BINDING_CHANGED' USING ERRCODE='55000'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_after IS NULL OR p_after NOT BETWEEN 0 AND b.record_count THEN
    RAISE EXCEPTION 'DELTA_BASELINE_PAGE_INVALID' USING ERRCODE='22023'; END IF;
  next_ordinal:=p_after;
  FOR r IN SELECT * FROM sentlog_delta_private.baseline_records
    WHERE baseline_id=b.id AND ordinal>p_after ORDER BY ordinal LIMIT p_limit LOOP
    IF NOT r.verified THEN RAISE EXCEPTION 'DELTA_BASELINE_NOT_VERIFIED' USING ERRCODE='55000'; END IF;
    -- recordJson is the EXACT UTF-8 string covered by sha256. Do not hash a
    -- JavaScript reserialization: jsonb's key order/spacing is a named format.
    item:=pg_catalog.jsonb_build_object('ordinal',r.ordinal,'drawingId',r.drawing_id,
      'recordId',r.record_id,'recordJson',r.record::text,'sha256',r.sha256,
      'manifestEntryJson',pg_catalog.jsonb_build_object('ordinal',r.ordinal,
        'drawingId',r.drawing_id,'recordId',r.record_id,'sha256',r.sha256)::text);
    IF used_bytes+pg_catalog.octet_length(item::text)>900000 THEN EXIT; END IF;
    page:=page||pg_catalog.jsonb_build_array(item);
    used_bytes:=used_bytes+pg_catalog.octet_length(item::text)+2;
    next_ordinal:=r.ordinal;
  END LOOP;
  IF next_ordinal=p_after AND p_after<b.record_count THEN
    RAISE EXCEPTION 'DELTA_BASELINE_PAGE_TOO_LARGE' USING ERRCODE='54000'; END IF;
  RETURN pg_catalog.jsonb_build_object('receipt',sentlog_delta_private.baseline_receipt(b),
    'records',page,'nextOrdinal',next_ordinal,'hasMore',next_ordinal<b.record_count);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.read_baseline_metadata_page(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
  u uuid; b sentlog_delta_private.baselines%ROWTYPE; r record;
  page jsonb:='[]'::jsonb; item jsonb; used_bytes bigint:=0; next_ordinal bigint; n bigint;
BEGIN
  u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
  SELECT * INTO b FROM sentlog_delta_private.baselines
    WHERE id=p_baseline_id AND project_id=p_project_id AND owner_id=u;
  IF NOT FOUND OR b.state NOT IN ('verified','active') THEN
    RAISE EXCEPTION 'DELTA_BASELINE_NOT_VERIFIED' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.sentlog_projects WHERE id=p_project_id AND owner_id=u
      AND client_key=b.snapshot#>>'{project,id}') THEN
    RAISE EXCEPTION 'DELTA_BASELINE_BINDING_CHANGED' USING ERRCODE='55000'; END IF;
  n:=pg_catalog.jsonb_array_length(b.snapshot->'drawings')+1;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_after IS NULL OR p_after NOT BETWEEN 0 AND n THEN
    RAISE EXCEPTION 'DELTA_BASELINE_PAGE_INVALID' USING ERRCODE='22023'; END IF;
  next_ordinal:=p_after;
  FOR r IN SELECT m.*,sentlog_delta_private.json_digest(m.metadata) AS sha256
      FROM sentlog_delta_private.baseline_metadata(b.snapshot) m
      WHERE m.ordinal>p_after ORDER BY m.ordinal LIMIT p_limit LOOP
    item:=pg_catalog.jsonb_build_object('ordinal',r.ordinal,'kind',r.kind,'key',r.key,
      'metadataJson',r.metadata::text,'sha256',r.sha256,
      'manifestEntryJson',pg_catalog.jsonb_build_object('ordinal',r.ordinal,
        'kind',r.kind,'key',r.key,'sha256',r.sha256)::text);
    IF used_bytes+pg_catalog.octet_length(item::text)>900000 THEN EXIT; END IF;
    page:=page||pg_catalog.jsonb_build_array(item);
    used_bytes:=used_bytes+pg_catalog.octet_length(item::text)+2;
    next_ordinal:=r.ordinal;
  END LOOP;
  IF next_ordinal=p_after AND p_after<n THEN
    RAISE EXCEPTION 'DELTA_BASELINE_PAGE_TOO_LARGE' USING ERRCODE='54000'; END IF;
  RETURN pg_catalog.jsonb_build_object('receipt',sentlog_delta_private.baseline_receipt(b),
    'metadata',page,'nextOrdinal',next_ordinal,'hasMore',next_ordinal<n);
END $fn$;

-- This operation intentionally has NO authenticated grant and NO public RPC.
-- Test operators can exercise atomic activation only after installing a guard
-- in the disposable database. Real device/asset/cutover gates remain external.
CREATE OR REPLACE FUNCTION sentlog_delta_private.activate_prepared_baseline(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE
  u uuid; s public.sentlog_project_snapshots%ROWTYPE;
  h sentlog_delta_private.heads%ROWTYPE; b sentlog_delta_private.baselines%ROWTYPE;
BEGIN
  -- A row trigger cannot safely lock after an UPDATE has already locked its
  -- snapshot row. Acquire the TABLE gate first: an old save either commits
  -- before this lock (then our exact comparison fails), or runs after activation
  -- (then reject_legacy_snapshot rejects it). This prototype's table-wide gate
  -- is deliberate; production lock contention remains a release gate.
  LOCK TABLE public.sentlog_project_snapshots IN SHARE ROW EXCLUSIVE MODE;
  u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
  SELECT * INTO s FROM public.sentlog_project_snapshots
    WHERE project_id=p_project_id AND owner_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_BASELINE_STALE' USING ERRCODE='40001'; END IF;
  SELECT * INTO h FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND owner_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_BASELINE_MISSING' USING ERRCODE='55000'; END IF;
  SELECT * INTO b FROM sentlog_delta_private.baselines
    WHERE id=p_baseline_id AND project_id=p_project_id AND owner_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_BASELINE_MISSING' USING ERRCODE='55000'; END IF;
  IF s.revision IS DISTINCT FROM b.snapshot_revision OR s.payload IS DISTINCT FROM b.snapshot THEN
    RAISE EXCEPTION 'DELTA_BASELINE_STALE' USING ERRCODE='40001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid='public.sentlog_project_snapshots'::regclass
      AND t.tgfoid='sentlog_delta_private.reject_legacy_snapshot()'::regprocedure
      AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL AND (t.tgtype::integer & 31)=31) THEN
    RAISE EXCEPTION 'DELTA_BASELINE_LEGACY_GUARD_REQUIRED' USING ERRCODE='55000'; END IF;
  IF h.enabled AND b.state='active' THEN RETURN sentlog_delta_private.baseline_receipt(b); END IF;
  IF h.enabled OR b.state<>'verified' OR h.last_seq<>0 OR
     EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id=p_project_id) OR
     EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id=p_project_id) THEN
    RAISE EXCEPTION 'DELTA_BASELINE_ACTIVATION_UNSAFE' USING ERRCODE='55000'; END IF;
  IF (SELECT count(*) FROM sentlog_delta_private.baseline_records WHERE baseline_id=b.id AND verified)<>b.record_count OR
     (SELECT count(*) FROM sentlog_delta_private.baseline_records WHERE baseline_id=b.id)<>b.record_count THEN
    RAISE EXCEPTION 'DELTA_BASELINE_INCOMPLETE' USING ERRCODE='55000'; END IF;
  INSERT INTO sentlog_delta_private.record_states(project_id,owner_id,drawing_id,record_id,collab,last_seq)
    SELECT p_project_id,u,drawing_id,record_id,record->'collab',0
    FROM sentlog_delta_private.baseline_records WHERE baseline_id=b.id ORDER BY ordinal;
  UPDATE sentlog_delta_private.baselines SET state='active',activated_at=pg_catalog.now()
    WHERE id=b.id RETURNING * INTO b;
  UPDATE sentlog_delta_private.heads SET enabled=true,activated_at=pg_catalog.now() WHERE project_id=p_project_id;
  RETURN sentlog_delta_private.baseline_receipt(b);
END $fn$;

REVOKE ALL ON FUNCTION sentlog_delta_private.json_digest(jsonb),
  sentlog_delta_private.baseline_metadata(jsonb),
  sentlog_delta_private.baseline_authorize(uuid,uuid),
  sentlog_delta_private.baseline_receipt(sentlog_delta_private.baselines),
  sentlog_delta_private.prepare_baseline(uuid,uuid,bigint),
  sentlog_delta_private.import_baseline_batch(uuid,uuid,uuid,integer),
  sentlog_delta_private.read_baseline_page(uuid,uuid,uuid,bigint,integer),
  sentlog_delta_private.read_baseline_metadata_page(uuid,uuid,uuid,bigint,integer),
  sentlog_delta_private.activate_prepared_baseline(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.prepare_baseline(uuid,uuid,bigint),
  sentlog_delta_private.import_baseline_batch(uuid,uuid,uuid,integer),
  sentlog_delta_private.read_baseline_page(uuid,uuid,uuid,bigint,integer),
  sentlog_delta_private.read_baseline_metadata_page(uuid,uuid,uuid,bigint,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.sentlog_delta_prepare_baseline_v1(
  p_project_id uuid,p_device_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.prepare_baseline($1,$2,$3) $fn$;
CREATE OR REPLACE FUNCTION public.sentlog_delta_import_baseline_batch_v1(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.import_baseline_batch($1,$2,$3,$4) $fn$;
CREATE OR REPLACE FUNCTION public.sentlog_delta_read_baseline_page_v1(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.read_baseline_page($1,$2,$3,$4,$5) $fn$;
CREATE OR REPLACE FUNCTION public.sentlog_delta_read_baseline_metadata_page_v1(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.read_baseline_metadata_page($1,$2,$3,$4,$5) $fn$;
REVOKE ALL ON FUNCTION public.sentlog_delta_prepare_baseline_v1(uuid,uuid,bigint),
  public.sentlog_delta_import_baseline_batch_v1(uuid,uuid,uuid,integer),
  public.sentlog_delta_read_baseline_page_v1(uuid,uuid,uuid,bigint,integer),
  public.sentlog_delta_read_baseline_metadata_page_v1(uuid,uuid,uuid,bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_delta_prepare_baseline_v1(uuid,uuid,bigint),
  public.sentlog_delta_import_baseline_batch_v1(uuid,uuid,uuid,integer),
  public.sentlog_delta_read_baseline_page_v1(uuid,uuid,uuid,bigint,integer),
  public.sentlog_delta_read_baseline_metadata_page_v1(uuid,uuid,uuid,bigint,integer) TO authenticated;

COMMIT;

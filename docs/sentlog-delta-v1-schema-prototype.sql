-- EXPERIMENTAL DRAFT ONLY. NOT DEPLOYED, NOT EXECUTED IN PRODUCTION.
-- Requires an isolated PostgreSQL/Supabase branch and RLS/security review.
-- Retains every event; no automatic event pruning or record deletion.
-- IMPORTANT: BEFORE enabling a project, import/verify its snapshot baseline and
-- prevent old snapshot clients from writing. The trigger below must be tested
-- with the existing archive guard and all installed client versions.
BEGIN;

CREATE SCHEMA IF NOT EXISTS sentlog_delta_private;
REVOKE ALL ON SCHEMA sentlog_delta_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS sentlog_delta_private.heads (
  project_id uuid PRIMARY KEY REFERENCES public.sentlog_projects(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq BETWEEN 0 AND 9007199254740991),
  enabled boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  CONSTRAINT delta_head_consistency CHECK (NOT enabled OR activated_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.sentlog_delta_events (
  project_id uuid NOT NULL REFERENCES public.sentlog_projects(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  seq bigint NOT NULL CHECK (seq BETWEEN 1 AND 9007199254740991),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 512),
  device_id uuid NOT NULL REFERENCES public.sentlog_devices(id) ON DELETE RESTRICT,
  drawing_id text NOT NULL CHECK (length(drawing_id) BETWEEN 1 AND 512),
  record_id text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 512),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq),
  UNIQUE (owner_id, event_id)
);
CREATE INDEX IF NOT EXISTS sentlog_delta_events_by_owner
  ON public.sentlog_delta_events(owner_id, project_id, seq);
ALTER TABLE public.sentlog_delta_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sentlog_delta_events FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.sentlog_delta_events FROM authenticated;
GRANT SELECT ON public.sentlog_delta_events TO authenticated;
DROP POLICY IF EXISTS delta_read_own ON public.sentlog_delta_events;
CREATE POLICY delta_read_own ON public.sentlog_delta_events
  FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));

-- Match JavaScript's string ID limit (UTF-16 code units, including emoji).
CREATE OR REPLACE FUNCTION sentlog_delta_private.valid_id(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
  SELECT coalesce(jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN 1 AND 512
    AND length(v#>>'{}') + (SELECT count(*) FROM pg_catalog.regexp_split_to_table(v#>>'{}','') AS ch
      WHERE pg_catalog.ascii(ch)>65535) <= 512, false)
$fn$;
CREATE OR REPLACE FUNCTION sentlog_delta_private.safe_unsigned(v jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE n numeric;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  n:=(v#>>'{}')::numeric;
  RETURN n>=0 AND n<=9007199254740991 AND trunc(n)=n;
END $fn$;

-- Photo projections and history entries share exactly the same metadata gate.
CREATE OR REPLACE FUNCTION sentlog_delta_private.validate_photo(photo jsonb, expected_id text)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
BEGIN
  IF jsonb_typeof(photo) IS DISTINCT FROM 'object' OR
    NOT sentlog_delta_private.valid_id(photo->'id') OR
    photo->'id' IS DISTINCT FROM to_jsonb(expected_id) THEN
    RAISE EXCEPTION 'DELTA_PHOTO_INVALID' USING ERRCODE='22023';
  END IF;
  IF (photo ? 'sha256' AND (jsonb_typeof(photo->'sha256') IS DISTINCT FROM 'string' OR
    NOT (photo->>'sha256' ~ '^[0-9a-fA-F]{64}$'))) OR
    (photo ? 'size' AND NOT sentlog_delta_private.safe_unsigned(photo->'size')) THEN
    RAISE EXCEPTION 'DELTA_PHOTO_METADATA_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS(
    WITH RECURSIVE nodes(v,k) AS (
      SELECT photo,''::text UNION ALL
      SELECT child.v,child.k FROM nodes n CROSS JOIN LATERAL (
        SELECT value AS v,key AS k FROM pg_catalog.jsonb_each(CASE WHEN jsonb_typeof(n.v)='object' THEN n.v ELSE '{}'::jsonb END)
        UNION ALL
        SELECT value AS v,''::text AS k FROM pg_catalog.jsonb_array_elements(CASE WHEN jsonb_typeof(n.v)='array' THEN n.v ELSE '[]'::jsonb END)
      ) child
    ) SELECT 1 FROM nodes WHERE k=ANY(ARRAY['data','localBlob','blob','bytes']) OR
      (jsonb_typeof(v)='string' AND lower(left(v#>>'{}',5))='data:')
  ) THEN RAISE EXCEPTION 'DELTA_EMBEDDED_FILE_FORBIDDEN' USING ERRCODE='22023'; END IF;
END $fn$;

-- Structural validation is a minimum boundary, not a replacement for the
-- remaining server-side record/parent/revision semantic-validation gate.
-- This prototype must NOT be activated until accepted events are also checked
-- against a verified baseline and previously committed immutable revisions.
CREATE OR REPLACE FUNCTION sentlog_delta_private.validate_payload(e jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE
  c jsonb; bucket jsonb; ent record; rev jsonb; revs jsonb;
  group_name text; is_create boolean; key_name text; ids text[]:=ARRAY[]::text[];
  changes bigint:=0; photo jsonb; parents jsonb;
BEGIN
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR e->'schema' IS DISTINCT FROM '1'::jsonb OR
    jsonb_typeof(e->'kind') IS DISTINCT FROM 'string' OR
    coalesce(e->>'kind','') NOT IN ('create','patch') OR
    pg_catalog.octet_length(e::text)>262144 THEN
    RAISE EXCEPTION 'DELTA_PAYLOAD_INVALID' USING ERRCODE='22023';
  END IF;
  FOREACH key_name IN ARRAY ARRAY['eventId','projectId','deviceId','drawingId','recordId'] LOOP
    IF NOT sentlog_delta_private.valid_id(e->key_name) THEN
      RAISE EXCEPTION 'DELTA_PAYLOAD_INVALID' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF EXISTS(
    WITH RECURSIVE nodes(v,depth) AS (
      SELECT e,0 UNION ALL
      SELECT child.v,n.depth+1 FROM nodes n CROSS JOIN LATERAL (
        SELECT value AS v FROM pg_catalog.jsonb_each(CASE WHEN jsonb_typeof(n.v)='object' THEN n.v ELSE '{}'::jsonb END)
        UNION ALL
        SELECT value AS v FROM pg_catalog.jsonb_array_elements(CASE WHEN jsonb_typeof(n.v)='array' THEN n.v ELSE '[]'::jsonb END)
      ) child WHERE n.depth<=64
    ) SELECT 1 FROM nodes WHERE depth>64 OR
      CASE WHEN jsonb_typeof(v)='number' THEN abs((v#>>'{}')::numeric)>1.7976931348623157e308::numeric ELSE false END
  ) THEN RAISE EXCEPTION 'DELTA_JSON_BOUNDARY_INVALID' USING ERRCODE='22023'; END IF;

  is_create:=e->>'kind'='create';
  IF is_create THEN
    IF jsonb_typeof(e->'record') IS DISTINCT FROM 'object' OR
      e#>'{record,id}' IS DISTINCT FROM e->'recordId' OR
      jsonb_typeof(e#>'{record,collab}') IS DISTINCT FROM 'object' OR
      e#>'{record,collab,version}' IS DISTINCT FROM '1'::jsonb OR
      jsonb_typeof(e#>'{record,collab,deletion}') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'DELTA_CREATE_INVALID' USING ERRCODE='22023';
    END IF;
    IF (e->'record') ? 'photos' THEN
      IF jsonb_typeof(e#>'{record,photos}') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'DELTA_PHOTO_LIST_INVALID' USING ERRCODE='22023';
      END IF;
      FOR photo IN SELECT value FROM pg_catalog.jsonb_array_elements(e#>'{record,photos}') LOOP
        PERFORM sentlog_delta_private.validate_photo(photo,photo->>'id');
      END LOOP;
    END IF;
    c:=e#>'{record,collab}';
    revs:=c#>'{deletion,revisions}';
  ELSE
    c:=e->'patch';
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'DELTA_PATCH_INVALID' USING ERRCODE='22023';
    END IF;
    revs:=c->'deletion';
  END IF;
  IF jsonb_typeof(revs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'DELTA_DELETION_INVALID' USING ERRCODE='22023';
  END IF;
  IF is_create AND jsonb_array_length(revs)=0 THEN
    RAISE EXCEPTION 'DELTA_DELETION_INVALID' USING ERRCODE='22023';
  END IF;

  FOREACH group_name IN ARRAY ARRAY['comments','fields','photos','deletion'] LOOP
    IF group_name='deletion' THEN
      bucket:=jsonb_build_object('record',jsonb_build_object('revisions',revs));
    ELSE
      bucket:=c->group_name;
      IF jsonb_typeof(bucket) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'DELTA_GROUP_INVALID' USING ERRCODE='22023';
      END IF;
    END IF;
    FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(bucket) LOOP
      IF NOT sentlog_delta_private.valid_id(to_jsonb(ent.key)) OR
        jsonb_typeof(ent.value) IS DISTINCT FROM 'object' OR
        jsonb_typeof(ent.value->'revisions') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'DELTA_ENTRY_INVALID' USING ERRCODE='22023';
      END IF;
      IF group_name<>'deletion' AND jsonb_array_length(ent.value->'revisions')=0 THEN
        RAISE EXCEPTION 'DELTA_ENTRY_EMPTY' USING ERRCODE='22023';
      END IF;
      IF group_name='comments' AND NOT sentlog_delta_private.safe_unsigned(ent.value->'order') THEN
        RAISE EXCEPTION 'DELTA_COMMENT_ORDER_INVALID' USING ERRCODE='22023';
      END IF;
      IF group_name='fields' AND ent.key=ANY(ARRAY['id','memo','photos','collab','globalNo','typeNo','autoLabel','recordNo','labelPosEditedAt',
        'kind','recordKind','recordType','memoType','page','point','points','x','y','w','h','width','height','angle','rotation','radius','rx','ry','unit']) THEN
        RAISE EXCEPTION 'DELTA_FIELD_RESERVED' USING ERRCODE='22023';
      END IF;
      FOR rev IN SELECT value FROM pg_catalog.jsonb_array_elements(ent.value->'revisions') LOOP
        IF jsonb_typeof(rev) IS DISTINCT FROM 'object' OR NOT sentlog_delta_private.valid_id(rev->'id') OR
          rev->>'id'=ANY(ids) OR jsonb_typeof(rev->'parents') IS DISTINCT FROM 'array' OR
          jsonb_typeof(rev->'actor') IS DISTINCT FROM 'object' OR
          coalesce(jsonb_typeof(rev#>'{actor,deviceId}'),'missing') NOT IN ('string','null') OR
          jsonb_typeof(rev#>'{actor,deviceName}') IS DISTINCT FROM 'string' OR
          jsonb_typeof(rev->'at') IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'DELTA_REVISION_INVALID' USING ERRCODE='22023';
        END IF;
        IF (rev->>'at')::numeric<0 OR (rev->>'at')::numeric>1.7976931348623157e308::numeric THEN
          RAISE EXCEPTION 'DELTA_REVISION_TIME_INVALID' USING ERRCODE='22023';
        END IF;
        parents:=rev->'parents';
        IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(parents) p WHERE NOT sentlog_delta_private.valid_id(p)) OR
          (SELECT count(*) FROM pg_catalog.jsonb_array_elements(parents)) <>
          (SELECT count(DISTINCT p) FROM pg_catalog.jsonb_array_elements(parents) p) OR
          parents @> jsonb_build_array(rev->'id') THEN
          RAISE EXCEPTION 'DELTA_PARENTS_INVALID' USING ERRCODE='22023';
        END IF;
        ids:=array_append(ids,rev->>'id'); changes:=changes+1;
        IF group_name='comments' AND (jsonb_typeof(rev->'text') IS DISTINCT FROM 'string' OR
          jsonb_typeof(rev->'deleted') IS DISTINCT FROM 'boolean') THEN
          RAISE EXCEPTION 'DELTA_COMMENT_INVALID' USING ERRCODE='22023';
        ELSIF group_name='fields' THEN
          IF (rev ? 'unset' AND jsonb_typeof(rev->'unset') IS DISTINCT FROM 'boolean') OR
            (rev->'unset' IS DISTINCT FROM 'true'::jsonb AND NOT rev ? 'value') THEN
            RAISE EXCEPTION 'DELTA_FIELD_INVALID' USING ERRCODE='22023';
          END IF;
          IF ent.key='geometry' AND rev->'unset' IS DISTINCT FROM 'true'::jsonb THEN
            IF jsonb_typeof(rev->'value') IS DISTINCT FROM 'object' THEN
              RAISE EXCEPTION 'DELTA_GEOMETRY_INVALID' USING ERRCODE='22023';
            END IF;
            IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(rev->'value') k
              WHERE NOT k=ANY(ARRAY['kind','recordKind','recordType','memoType','page','point','points','x','y','w','h','width','height','angle','rotation','radius','rx','ry','unit'])) THEN
              RAISE EXCEPTION 'DELTA_GEOMETRY_INVALID' USING ERRCODE='22023';
            END IF;
          END IF;
        ELSIF group_name='photos' THEN
          IF jsonb_typeof(rev->'deleted') IS DISTINCT FROM 'boolean' THEN
            RAISE EXCEPTION 'DELTA_PHOTO_INVALID' USING ERRCODE='22023';
          END IF;
          PERFORM sentlog_delta_private.validate_photo(rev->'value',ent.key);
        ELSIF group_name='deletion' THEN
          IF jsonb_typeof(rev->'deleted') IS DISTINCT FROM 'boolean' OR
            jsonb_typeof(rev->'observed') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'DELTA_DELETION_INVALID' USING ERRCODE='22023';
          END IF;
          IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(rev->'observed') p
            WHERE NOT sentlog_delta_private.valid_id(p)) THEN
            RAISE EXCEPTION 'DELTA_OBSERVED_INVALID' USING ERRCODE='22023';
          END IF;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF changes=0 THEN RAISE EXCEPTION 'DELTA_EMPTY_PATCH' USING ERRCODE='22023'; END IF;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.valid_id(jsonb),
  sentlog_delta_private.safe_unsigned(jsonb),sentlog_delta_private.validate_photo(jsonb,text),
  sentlog_delta_private.validate_payload(jsonb)
  FROM PUBLIC, anon, authenticated;

-- The private function is deliberately SECURITY DEFINER so clients never
-- obtain direct INSERT/UPDATE rights on the ordering ledger. Every ownership,
-- device and payload boundary is explicitly re-checked, including duplicates.
CREATE OR REPLACE FUNCTION sentlog_delta_private.append(
  p_project_id uuid, p_device_id uuid, p_event_id text,
  p_drawing_id text, p_record_id text, p_envelope jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  u uuid := (SELECT auth.uid());
  h sentlog_delta_private.heads%ROWTYPE;
  previous public.sentlog_delta_events%ROWTYPE;
  next_number bigint;
BEGIN
  IF u IS NULL THEN RAISE EXCEPTION 'DELTA_LOGIN_REQUIRED' USING ERRCODE='28000'; END IF;
  -- Hold compatible read locks until commit: archive/owner changes and device
  -- deactivation must not race between authorization and event insertion.
  PERFORM 1 FROM public.sentlog_projects p
    WHERE p.id=p_project_id AND p.owner_id=u AND p.status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_PROJECT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.sentlog_devices d
    WHERE d.id=p_device_id AND d.owner_id=u AND d.active=true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_DEVICE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT sentlog_delta_private.valid_id(to_jsonb(p_event_id)) OR
     NOT sentlog_delta_private.valid_id(to_jsonb(p_drawing_id)) OR
     NOT sentlog_delta_private.valid_id(to_jsonb(p_record_id)) THEN
     RAISE EXCEPTION 'DELTA_ID_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM sentlog_delta_private.validate_payload(p_envelope);
  IF p_envelope->>'eventId' IS DISTINCT FROM p_event_id OR
     p_envelope->>'projectId' IS DISTINCT FROM p_project_id::text OR
     p_envelope->>'deviceId' IS DISTINCT FROM p_device_id::text OR
     p_envelope->>'drawingId' IS DISTINCT FROM p_drawing_id OR
     p_envelope->>'recordId' IS DISTINCT FROM p_record_id THEN
    RAISE EXCEPTION 'DELTA_PAYLOAD_INVALID' USING ERRCODE='22023';
  END IF;
  -- This row lock serializes commits within one project. Sequence numbers
  -- are transactional, not IDENTITY numbers; aborted writes cannot make gaps.
  SELECT * INTO h FROM sentlog_delta_private.heads
    WHERE project_id=p_project_id AND owner_id=u FOR UPDATE;
  IF NOT FOUND OR NOT h.enabled THEN
    RAISE EXCEPTION 'DELTA_NOT_ACTIVATED' USING ERRCODE='55000';
  END IF;
  SELECT * INTO previous FROM public.sentlog_delta_events
    WHERE owner_id=u AND event_id=p_event_id;
  IF FOUND THEN
    IF previous.project_id IS DISTINCT FROM p_project_id OR
       previous.device_id IS DISTINCT FROM p_device_id OR
       previous.drawing_id IS DISTINCT FROM p_drawing_id OR
       previous.record_id IS DISTINCT FROM p_record_id OR
       previous.envelope IS DISTINCT FROM p_envelope THEN
      RAISE EXCEPTION 'DELTA_EVENT_ID_COLLISION' USING ERRCODE='23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object('seq',previous.seq,'duplicate',true,
      'projectId',p_project_id,'eventId',p_event_id,'deviceId',p_device_id,
      'drawingId',p_drawing_id,'recordId',p_record_id);
  END IF;
  IF h.last_seq>=9007199254740991 THEN
    RAISE EXCEPTION 'DELTA_SEQUENCE_LIMIT' USING ERRCODE='22003';
  END IF;
  next_number:=h.last_seq+1;
  -- Under the project lock: validate and atomically materialize the accepted
  -- record history before the event/sequence can become visible to peers.
  -- If the semantic supplement is absent, this call fails closed.
  PERFORM sentlog_delta_private.accept_record_event(
    p_project_id,u,p_drawing_id,p_record_id,p_envelope,next_number);
  INSERT INTO public.sentlog_delta_events
    (project_id,owner_id,seq,event_id,device_id,drawing_id,record_id,envelope)
    VALUES(p_project_id,u,next_number,p_event_id,p_device_id,p_drawing_id,p_record_id,p_envelope);
  UPDATE sentlog_delta_private.heads SET last_seq=next_number WHERE project_id=p_project_id;
  RETURN pg_catalog.jsonb_build_object('seq',next_number,'duplicate',false,
    'projectId',p_project_id,'eventId',p_event_id,'deviceId',p_device_id,
    'drawingId',p_drawing_id,'recordId',p_record_id);
END $fn$;

-- Public RPC is only a narrow authenticated entry point.
CREATE OR REPLACE FUNCTION public.sentlog_delta_append_v1(
  p_project_id uuid, p_device_id uuid, p_event_id text,
  p_drawing_id text, p_record_id text, p_envelope jsonb
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$
  SELECT sentlog_delta_private.append(
    p_project_id, p_device_id, p_event_id, p_drawing_id, p_record_id, p_envelope
  );
$fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.append(uuid,uuid,text,text,text,jsonb)
  FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA sentlog_delta_private TO authenticated;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.append(uuid,uuid,text,text,text,jsonb)
  TO authenticated;
REVOKE ALL ON FUNCTION public.sentlog_delta_append_v1(uuid,uuid,text,text,text,jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sentlog_delta_append_v1(uuid,uuid,text,text,text,jsonb)
  TO authenticated;

-- Realtime signals the presence of a committed change. Clients use a bounded
-- GET for seq > lastDurablyAppliedSeq; Broadcast is never the only source.
-- A privacy policy for topic realtime:sentlog-delta:<owner_id> is required.
CREATE OR REPLACE FUNCTION sentlog_delta_private.announce()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
BEGIN
  IF (SELECT auth.uid()) IS DISTINCT FROM NEW.owner_id THEN
    RETURN NEW;
  END IF;
  PERFORM realtime.send(
    pg_catalog.jsonb_build_object('project_id',NEW.project_id,'seq',NEW.seq),
    'delta',
    'sentlog-delta:'||NEW.owner_id::text,
    true
  );
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.announce() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_delta_event_announce ON public.sentlog_delta_events;
CREATE TRIGGER sentlog_delta_event_announce AFTER INSERT ON public.sentlog_delta_events
  FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.announce();

-- IMPORTANT GATE: once delta mode is active, pre-upgrade snapshot writers must
-- not silently overwrite the new event stream. OLD DEVICES MUST BE UPGRADED
-- FIRST and have their offline drafts rescued. This trigger is *not* enabled
-- until the migration/legacy-device tests pass.
CREATE OR REPLACE FUNCTION sentlog_delta_private.reject_legacy_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
BEGIN
  -- On UPDATE inspect both IDs: moving an enabled snapshot to another project
  -- is also a legacy overwrite. INSERT and DELETE must be guarded at activation.
  IF EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE enabled AND
    ((TG_OP<>'INSERT' AND project_id=OLD.project_id) OR
     (TG_OP<>'DELETE' AND project_id=NEW.project_id))) THEN
    RAISE EXCEPTION 'DELTA_UPGRADE_REQUIRED: この案件は新しい同期方式です。端末内の記録を保持し、セントログを更新してください。'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.reject_legacy_snapshot()
  FROM PUBLIC, anon, authenticated;
-- DO NOT CREATE THE reject_legacy_snapshot TRIGGER UNTIL THE CLIENT MIGRATION
-- IS VERIFIED; the function by itself does not change snapshot writes.

COMMIT;

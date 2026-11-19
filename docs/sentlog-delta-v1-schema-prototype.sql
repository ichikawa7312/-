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
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  enabled boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  CONSTRAINT delta_head_consistency CHECK (NOT enabled OR activated_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.sentlog_delta_events (
  project_id uuid NOT NULL REFERENCES public.sentlog_projects(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  seq bigint NOT NULL CHECK (seq > 0),
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
  IF NOT EXISTS(
    SELECT 1 FROM public.sentlog_projects p
     WHERE p.id=p_project_id AND p.owner_id=u AND p.status='active'
  ) THEN RAISE EXCEPTION 'DELTA_PROJECT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.sentlog_devices d
     WHERE d.id=p_device_id AND d.owner_id=u AND d.active=true
  ) THEN RAISE EXCEPTION 'DELTA_DEVICE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 512 OR
     p_drawing_id IS NULL OR length(p_drawing_id) NOT BETWEEN 1 AND 512 OR
     p_record_id IS NULL OR length(p_record_id) NOT BETWEEN 1 AND 512 THEN
     RAISE EXCEPTION 'DELTA_ID_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object' OR
     coalesce((p_envelope->>'schema')::integer,0) <> 1 OR
     p_envelope->>'eventId' IS DISTINCT FROM p_event_id OR
     p_envelope->>'projectId' IS DISTINCT FROM p_project_id::text OR
     p_envelope->>'deviceId' IS DISTINCT FROM p_device_id::text OR
     p_envelope->>'drawingId' IS DISTINCT FROM p_drawing_id OR
     p_envelope->>'recordId' IS DISTINCT FROM p_record_id OR
     p_envelope->>'kind' NOT IN ('create','patch') OR
     pg_catalog.octet_length(p_envelope::text) > 262144 THEN
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
    RETURN pg_catalog.jsonb_build_object('seq',previous.seq,'duplicate',true);
  END IF;
  next_number:=h.last_seq+1;
  INSERT INTO public.sentlog_delta_events
    (project_id,owner_id,seq,event_id,device_id,drawing_id,record_id,envelope)
    VALUES(p_project_id,u,next_number,p_event_id,p_device_id,p_drawing_id,p_record_id,p_envelope);
  UPDATE sentlog_delta_private.heads SET last_seq=next_number WHERE project_id=p_project_id;
  RETURN pg_catalog.jsonb_build_object('seq',next_number,'duplicate',false);
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
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE pid uuid:=coalesce(NEW.project_id,OLD.project_id);
BEGIN
  IF EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id=pid AND enabled) THEN
    RAISE EXCEPTION 'DELTA_UPGRADE_REQUIRED: この案件は新しい同期方式です。端末内の記録を保持し、セントログを更新してください。'
      USING ERRCODE='55000';
  END IF;
  RETURN coalesce(NEW,OLD);
END $fn$;
-- DO NOT CREATE THE reject_legacy_snapshot TRIGGER UNTIL THE CLIENT MIGRATION
-- IS VERIFIED; the function by itself does not change snapshot writes.

COMMIT;

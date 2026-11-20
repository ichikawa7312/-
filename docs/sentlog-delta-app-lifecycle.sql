-- Application cutover is explicitly disabled until its deployed build passes
-- verification. This migration alone changes no project's saving mode.
BEGIN;
DO $dependencies$
BEGIN
  IF pg_catalog.to_regprocedure('sentlog_delta_private.publish_checkpoint(uuid,uuid,bigint,text)') IS NULL OR
     pg_catalog.to_regprocedure('sentlog_delta_private.seed_metadata_baseline(uuid,uuid,uuid)') IS NULL OR
     NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.sentlog_project_snapshots'::regclass
       AND tgfoid=pg_catalog.to_regprocedure('sentlog_delta_private.guard_certified_snapshot()')
       AND tgenabled IN ('O','A') AND NOT tgisinternal AND tgqual IS NULL AND (tgtype::integer & 31)=31) THEN
    RAISE EXCEPTION 'DELTA_APPLICATION_DEPENDENCIES_REQUIRED' USING ERRCODE='55000'; END IF;
END $dependencies$;
CREATE TABLE IF NOT EXISTS sentlog_delta_private.rollouts (
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sentlog_delta_private.device_migrations (
  project_id uuid NOT NULL REFERENCES public.sentlog_projects(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.sentlog_devices(id),
  baseline_id uuid NOT NULL REFERENCES sentlog_delta_private.baselines(id),
  owner_id uuid NOT NULL,
  proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,device_id,baseline_id)
);
ALTER TABLE sentlog_delta_private.rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentlog_delta_private.device_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sentlog_delta_private.rollouts,sentlog_delta_private.device_migrations FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.capabilities(p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE u uuid;
BEGIN
  u:=sentlog_delta_private.read_authorize(p_project_id,p_device_id);
  RETURN pg_catalog.jsonb_build_object('schema',2,'ownerId',u,'projectId',p_project_id,'deviceId',p_device_id,
    'atomicGroups',true,'groupMaxEvents',500,'groupMaxBytes',4194304,'pageTargetBytes',900000,
    'sharedMetadata',true,'certifiedArchive',true,'writerJournal',2);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.capabilities(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.capabilities(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.inspect_project(p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE u uuid; h sentlog_delta_private.heads%ROWTYPE; b sentlog_delta_private.baselines%ROWTYPE;
  checking boolean; can_activate boolean; receipt jsonb:=NULL;current_revision bigint;
BEGIN
  u:=sentlog_delta_private.read_authorize(p_project_id,p_device_id);
  SELECT revision INTO current_revision FROM public.sentlog_project_snapshots WHERE project_id=p_project_id AND owner_id=u;
  SELECT * INTO h FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND owner_id=u;
  SELECT EXISTS(SELECT 1 FROM sentlog_archive_private.jobs WHERE project_id=p_project_id AND state='checking' AND expires_at>pg_catalog.now()) INTO checking;
  IF coalesce(h.enabled,false) THEN
    SELECT * INTO b FROM sentlog_delta_private.baselines WHERE project_id=p_project_id AND owner_id=u AND state='active';
    IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_BASELINE_MISSING' USING ERRCODE='55000'; END IF;
    receipt:=sentlog_delta_private.baseline_receipt(b);
  END IF;
  SELECT coalesce((SELECT enabled FROM sentlog_delta_private.rollouts WHERE owner_id=u),false)
    AND EXISTS(SELECT 1 FROM public.sentlog_projects WHERE id=p_project_id AND owner_id=u AND status='active')
    AND NOT checking INTO can_activate;
  RETURN pg_catalog.jsonb_build_object('schema',1,'ownerId',u,'projectId',p_project_id,'deviceId',p_device_id,
    'enabled',coalesce(h.enabled,false),'canActivate',can_activate,'headSeq',coalesce(h.last_seq,0),
    'checking',checking,'baseline',receipt,'snapshotRevision',current_revision);
END $fn$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.activate_app_baseline(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid,p_proof jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='5s'
AS $fn$
DECLARE u uuid; b sentlog_delta_private.baselines%ROWTYPE; result jsonb; active boolean;
BEGIN
  -- The lock order matches the established baseline/legacy writer gate.
  LOCK TABLE public.sentlog_project_snapshots IN SHARE ROW EXCLUSIVE MODE;
  PERFORM 1 FROM public.sentlog_projects WHERE id=p_project_id AND owner_id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_PROJECT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
  PERFORM sentlog_delta_private.assert_archive_writable(p_project_id);
  IF jsonb_typeof(p_proof) IS DISTINCT FROM 'object' OR p_proof->>'writerVersion' IS DISTINCT FROM '2' OR
    length(coalesce(p_proof->>'migrationId','')) NOT BETWEEN 1 AND 512 OR
    coalesce(p_proof->>'sourceFingerprint','') !~ '^[a-f0-9]{64}$' OR
    coalesce(p_proof->>'planSha256','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'DELTA_MIGRATION_REQUIRED' USING ERRCODE='22023'; END IF;
  SELECT enabled INTO active FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND owner_id=u FOR UPDATE;
  IF coalesce(active,false) THEN
    SELECT * INTO b FROM sentlog_delta_private.baselines WHERE id=p_baseline_id AND project_id=p_project_id AND owner_id=u AND state='active';
    IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_BASELINE_CHANGED' USING ERRCODE='40001'; END IF;
    result:=sentlog_delta_private.baseline_receipt(b);
  ELSE
    IF NOT coalesce((SELECT enabled FROM sentlog_delta_private.rollouts WHERE owner_id=u),false) THEN
      RAISE EXCEPTION 'DELTA_ROLLOUT_DISABLED' USING ERRCODE='55000'; END IF;
    -- These are server-derived checks and data. The client proof is an audit
    -- record; it never substitutes for record/history/metadata validation.
    result:=sentlog_delta_private.activate_prepared_baseline(p_project_id,p_device_id,p_baseline_id);
    PERFORM sentlog_delta_private.seed_metadata_baseline(p_project_id,p_device_id,p_baseline_id);
    PERFORM public.sentlog_delta_publish_checkpoint_v1(p_project_id,p_device_id,0,'activation:'||p_baseline_id::text);
  END IF;
  INSERT INTO sentlog_delta_private.device_migrations(project_id,device_id,baseline_id,owner_id,proof)
    VALUES(p_project_id,p_device_id,p_baseline_id,u,p_proof)
    ON CONFLICT(project_id,device_id,baseline_id) DO NOTHING;
  RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.inspect_project(uuid,uuid),
  sentlog_delta_private.activate_app_baseline(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.inspect_project(uuid,uuid),
  sentlog_delta_private.activate_app_baseline(uuid,uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.sentlog_delta_inspect_v1(p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.inspect_project($1,$2) $fn$;
CREATE OR REPLACE FUNCTION public.sentlog_delta_activate_baseline_v1(
  p_project_id uuid,p_device_id uuid,p_baseline_id uuid,p_proof jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.activate_app_baseline($1,$2,$3,$4) $fn$;
REVOKE ALL ON FUNCTION public.sentlog_delta_inspect_v1(uuid,uuid),public.sentlog_delta_activate_baseline_v1(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_delta_inspect_v1(uuid,uuid),public.sentlog_delta_activate_baseline_v1(uuid,uuid,uuid,jsonb) TO authenticated;

COMMIT;

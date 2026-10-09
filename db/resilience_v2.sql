-- Sentlog v1.39: durable server-side audit and read-only backup dashboard.
-- Backward-compatible. Never change existing project states or stored files.
CREATE TABLE IF NOT EXISTS sentlog_archive_private.audit_v2 (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES public.sentlog_projects(id) ON DELETE RESTRICT,
  device_id uuid REFERENCES public.sentlog_devices(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  happened_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sentlog_audit_v2_project_at
 ON sentlog_archive_private.audit_v2(owner_id,project_id,happened_at DESC);
ALTER TABLE sentlog_archive_private.audit_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sentlog_archive_private.audit_v2 FROM public,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_archive_private.audit_project_status_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF old.status IS DISTINCT FROM new.status THEN
   INSERT INTO sentlog_archive_private.audit_v2(owner_id,project_id,event_type,detail)
   VALUES(new.owner_id,new.id,'project_'||new.status,
     jsonb_build_object('from',old.status,'to',new.status,'source','server'));
 END IF;
 RETURN new;
END $$;
REVOKE ALL ON FUNCTION sentlog_archive_private.audit_project_status_v2() FROM public,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_audit_project_v2 ON public.sentlog_projects;
CREATE TRIGGER sentlog_audit_project_v2 AFTER UPDATE OF status ON public.sentlog_projects
 FOR EACH ROW EXECUTE FUNCTION sentlog_archive_private.audit_project_status_v2();

CREATE OR REPLACE FUNCTION sentlog_archive_private.audit_archive_job_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF new.state IS DISTINCT FROM old.state AND new.state IN ('archived','cancelled') THEN
   INSERT INTO sentlog_archive_private.audit_v2(owner_id,project_id,device_id,event_type,detail)
   VALUES(new.owner_id,new.project_id,new.initiator,'archive_'||new.state,
     jsonb_build_object('job_id',new.id,'revision',new.revision,
       'file_count',jsonb_array_length(new.manifest),'pc_verified',new.pc_receipt IS NOT NULL));
 END IF;
 RETURN new;
END $$;
REVOKE ALL ON FUNCTION sentlog_archive_private.audit_archive_job_v2() FROM public,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_audit_job_v2 ON sentlog_archive_private.jobs;
CREATE TRIGGER sentlog_audit_job_v2 AFTER UPDATE OF state ON sentlog_archive_private.jobs
 FOR EACH ROW EXECUTE FUNCTION sentlog_archive_private.audit_archive_job_v2();

CREATE OR REPLACE FUNCTION sentlog_archive_private.audit_capacity_v2()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF tg_op='INSERT' THEN
   INSERT INTO sentlog_archive_private.audit_v2(owner_id,project_id,device_id,event_type,detail)
   VALUES(new.owner_id,new.project_id,new.device_id,'capacity_requested',
     jsonb_build_object('operation_id',new.id,'action',new.action,'mode',new.mode));
 ELSIF new.state IS DISTINCT FROM old.state AND new.state IN ('ready','finished','cancelled') THEN
   INSERT INTO sentlog_archive_private.audit_v2(owner_id,project_id,device_id,event_type,detail)
   VALUES(new.owner_id,new.project_id,new.device_id,'capacity_'||new.state,
     jsonb_build_object('operation_id',new.id,'action',new.action,'mode',new.mode,
       'pc_device_id',new.pc_device_id,'error',new.last_error));
 END IF;
 RETURN new;
END $$;
REVOKE ALL ON FUNCTION sentlog_archive_private.audit_capacity_v2() FROM public,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_audit_capacity_v2 ON sentlog_archive_private.capacity_ops;
CREATE TRIGGER sentlog_audit_capacity_v2 AFTER INSERT OR UPDATE OF state ON sentlog_archive_private.capacity_ops
 FOR EACH ROW EXECUTE FUNCTION sentlog_archive_private.audit_capacity_v2();

-- Readable, device-authorized summary. DB receipt is evidence of previous PC
-- verification, NOT a guarantee that the physical PC copy still exists.
CREATE OR REPLACE FUNCTION sentlog_archive_private.backup_status_v2(
 p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 uid uuid:=auth.uid(); p public.sentlog_projects%rowtype;
 j sentlog_archive_private.jobs%rowtype; rec jsonb; events jsonb;
 v_current boolean;
BEGIN
 IF uid IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.sentlog_devices d
   WHERE d.id=p_device_id AND d.owner_id=uid AND d.active
     AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations r
        WHERE r.device_id=d.id)) THEN
  RAISE EXCEPTION '有効な端末でログインしてください。';
 END IF;
 SELECT * INTO p FROM public.sentlog_projects WHERE id=p_project_id AND owner_id=uid;
 IF NOT FOUND THEN RAISE EXCEPTION '案件が見つかりません。';END IF;
 SELECT * INTO j FROM sentlog_archive_private.jobs
  WHERE owner_id=uid AND project_id=p.id AND state='archived' AND pc_receipt IS NOT NULL
  ORDER BY archived_at DESC LIMIT 1;
 v_current:=found AND EXISTS(
  SELECT 1 FROM public.sentlog_project_snapshots s
   WHERE s.project_id=p.id AND s.revision=j.revision AND s.payload=j.payload);
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'type',e.event_type,'at',e.happened_at,'device',d.device_name,'detail',e.detail)
  ORDER BY e.happened_at DESC),'[]'::jsonb) INTO events
 FROM (
  SELECT * FROM sentlog_archive_private.audit_v2
  WHERE owner_id=uid AND project_id=p.id ORDER BY happened_at DESC LIMIT 30
 ) e LEFT JOIN public.sentlog_devices d ON d.id=e.device_id;
 IF j.id IS NOT NULL THEN
  SELECT jsonb_build_object(
   'job_id',j.id,'archived_at',j.archived_at,
   'last_verified_at',j.pc_receipt->>'verified_at',
   'file_count',jsonb_array_length(j.manifest),
   'pdf_count',(SELECT count(*) FROM jsonb_array_elements(j.manifest) v WHERE v->>'kind'='drawing'),
   'photo_count',(SELECT count(*) FROM jsonb_array_elements(j.manifest) v WHERE v->>'kind'='photo'),
   'total_bytes',(SELECT coalesce(sum((v->>'byte_size')::bigint),0) FROM jsonb_array_elements(j.manifest) v),
   'is_current_revision',v_current,'revision',j.revision
  ) INTO rec;
 ELSE rec:=null;END IF;
 RETURN jsonb_build_object('name',p.name,'status',p.status,
  'retired',EXISTS(SELECT 1 FROM sentlog_archive_private.retired_projects r
      WHERE r.project_id=p.id AND r.restored_at IS NULL),
  'backup',rec,'events',events);
END $$;
REVOKE ALL ON FUNCTION sentlog_archive_private.backup_status_v2(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION sentlog_archive_private.backup_status_v2(uuid,uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.sentlog_backup_status_v2(p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT sentlog_archive_private.backup_status_v2(p_project_id,p_device_id);
$$;
REVOKE ALL ON FUNCTION public.sentlog_backup_status_v2(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_backup_status_v2(uuid,uuid) TO authenticated;

-- Reopen via the existing authorized archive RPC, then record the actual
-- requesting registered device (older clients keep working without this RPC).
CREATE OR REPLACE FUNCTION sentlog_archive_private.reopen_v2(p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE uid uuid:=auth.uid(); answer jsonb;
BEGIN
 IF uid IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.sentlog_devices d WHERE d.id=p_device_id AND d.owner_id=uid AND d.active
    AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations r WHERE r.device_id=d.id))
 THEN RAISE EXCEPTION '有効な端末登録が必要です。';END IF;
 answer:=public.sentlog_archive_v1('reopen',p_project_id,p_device_id,'{}'::jsonb);
 INSERT INTO sentlog_archive_private.audit_v2(owner_id,project_id,device_id,event_type)
 VALUES(uid,p_project_id,p_device_id,'reopened_by_device');
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION sentlog_archive_private.reopen_v2(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION sentlog_archive_private.reopen_v2(uuid,uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.sentlog_reopen_v2(p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT sentlog_archive_private.reopen_v2(p_project_id,p_device_id);
$$;
REVOKE ALL ON FUNCTION public.sentlog_reopen_v2(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_reopen_v2(uuid,uuid) TO authenticated;

-- Prevent a different device (or an old client) from reopening an archive
-- while any active registered device may still have released its original bytes.
-- A 'ready' verification can have been locally committed even if the final
-- acknowledgement failed; require a later successful restoration.
CREATE OR REPLACE FUNCTION sentlog_archive_private.capacity_project_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $guard_v2$
BEGIN
 IF new.status IS DISTINCT FROM old.status AND EXISTS(
    SELECT 1 FROM sentlog_archive_private.capacity_ops x
    WHERE x.project_id=old.id AND x.state IN ('requested','ready') AND x.expires_at>now()
 ) THEN
   RAISE EXCEPTION '端末の容量整理または復旧が進行中です。終了後に変更してください。';
 END IF;
 IF old.status='archived' AND new.status='active' AND EXISTS(
    SELECT 1 FROM sentlog_archive_private.capacity_ops v
      JOIN public.sentlog_devices d ON d.id=v.device_id AND d.owner_id=v.owner_id AND d.active
    WHERE v.project_id=old.id AND v.action='verify' AND v.state IN ('ready','finished')
      AND NOT EXISTS(SELECT 1 FROM sentlog_archive_private.removed_device_registrations removed
         WHERE removed.device_id=v.device_id)
      AND NOT EXISTS(
        SELECT 1 FROM sentlog_archive_private.capacity_ops r
          WHERE r.owner_id=v.owner_id AND r.project_id=v.project_id
            AND r.device_id=v.device_id AND r.action='restore' AND r.state='finished'
            AND r.finished_at>=coalesce(v.finished_at,v.pc_ready_at)
      )
 ) THEN
   RAISE EXCEPTION '別の端末に容量整理済み・復旧未確認の案件があります。先にその端末でPCから復旧してください。';
 END IF;
 RETURN new;
END $guard_v2$;
REVOKE ALL ON FUNCTION sentlog_archive_private.capacity_project_guard() FROM public,anon,authenticated;

-- Preserve historical successful events for projects already tested.
INSERT INTO sentlog_archive_private.audit_v2(owner_id,project_id,device_id,event_type,detail,happened_at)
SELECT o.owner_id,o.project_id,o.device_id,'capacity_finished',
 jsonb_build_object('operation_id',o.id,'action',o.action,'mode',o.mode,'migrated',true),
 o.finished_at
FROM sentlog_archive_private.capacity_ops o WHERE o.state='finished' AND o.finished_at IS NOT NULL;
INSERT INTO sentlog_archive_private.audit_v2(owner_id,project_id,device_id,event_type,detail,happened_at)
SELECT j.owner_id,j.project_id,j.initiator,'archive_archived',
 jsonb_build_object('job_id',j.id,'revision',j.revision,
  'file_count',jsonb_array_length(j.manifest),'migrated',true),
 j.archived_at
FROM sentlog_archive_private.jobs j WHERE j.state='archived' AND j.archived_at IS NOT NULL;

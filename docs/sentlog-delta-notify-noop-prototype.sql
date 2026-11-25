-- DRAFT: suppress notifications only when an asset update changes no business field.
-- No asset data, receipt, authorization, storage policy or snapshot guard is changed.
BEGIN;
CREATE OR REPLACE FUNCTION sentlog_collaboration_private.notify_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE event_name text; value jsonb;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM new.owner_id THEN RETURN new; END IF;
  IF tg_table_schema <> 'public' THEN RETURN new; END IF;
  IF tg_table_name = 'sentlog_project_snapshots' THEN
    event_name := 'records';
    value := jsonb_build_object('project_id',new.project_id,'revision',new.revision);
  ELSIF tg_table_name = 'sentlog_assets' THEN
    IF new.status = 'storage_deleted' THEN RETURN new; END IF;
    IF tg_op = 'UPDATE' THEN
      -- Keep any real change, including hash, path, size, metadata, receipt
      -- verification time, and status. Only the generic touch timestamp is ignored.
      IF (to_jsonb(new)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(old)-'updated_at') THEN
        RETURN new;
      END IF;
    END IF;
    event_name := 'asset'; value := jsonb_build_object('project_id',new.project_id);
  ELSE RETURN new;
  END IF;
  PERFORM realtime.send(value,event_name,'sentlog-records:'||new.owner_id::text,true);
  RETURN new;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_collaboration_private.notify_change() FROM PUBLIC,anon,authenticated;
COMMIT;

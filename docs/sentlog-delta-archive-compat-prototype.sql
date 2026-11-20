-- Required before activating delta on a database with the legacy archive API.
-- No projection certificate exists yet: enabled delta projects cannot be
-- archived by a snapshot-only PC workflow. Legacy projects remain supported.
BEGIN;
DO $guard$
BEGIN
  IF pg_catalog.to_regclass('sentlog_archive_private.jobs') IS NULL THEN
    RAISE EXCEPTION 'DELTA_ARCHIVE_PROTOCOL_REQUIRED' USING ERRCODE='55000';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION sentlog_delta_private.assert_archive_writable(pid uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE mode text; frozen boolean;
BEGIN
  -- append/group already hold project FOR SHARE before their head lock.
  -- Reuse it, without upgrading to FOR UPDATE. NOWAIT also prevents an
  -- operator's reverse-order direct write from introducing a lock cycle.
  SELECT status INTO mode FROM public.sentlog_projects WHERE id=pid FOR SHARE NOWAIT;
  IF NOT FOUND OR mode<>'active' THEN RAISE EXCEPTION 'DELTA_PROJECT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF pg_catalog.to_regclass('sentlog_archive_private.jobs') IS NULL THEN
    RAISE EXCEPTION 'DELTA_ARCHIVE_PROTOCOL_REQUIRED' USING ERRCODE='55000'; END IF;
  SELECT EXISTS(SELECT 1 FROM sentlog_archive_private.jobs
    WHERE project_id=pid AND state='checking' AND expires_at>pg_catalog.now()) INTO frozen;
  IF frozen THEN RAISE EXCEPTION 'DELTA_ARCHIVE_FROZEN' USING ERRCODE='55000'; END IF;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.assert_archive_writable(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.guard_archive_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
BEGIN
  PERFORM sentlog_delta_private.assert_archive_writable(NEW.project_id);
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.guard_archive_write() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_delta_archive_write_guard ON public.sentlog_delta_events;
CREATE TRIGGER sentlog_delta_archive_write_guard BEFORE INSERT ON public.sentlog_delta_events
  FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.guard_archive_write();

CREATE OR REPLACE FUNCTION sentlog_delta_private.guard_archive_activation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
BEGIN
  IF NEW.enabled AND (TG_OP='INSERT' OR NOT OLD.enabled OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    PERFORM sentlog_delta_private.assert_archive_writable(NEW.project_id);
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.guard_archive_activation() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_delta_archive_activation_guard ON sentlog_delta_private.heads;
CREATE TRIGGER sentlog_delta_archive_activation_guard BEFORE INSERT OR UPDATE ON sentlog_delta_private.heads
  FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.guard_archive_activation();

CREATE OR REPLACE FUNCTION sentlog_delta_private.guard_legacy_archive_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
BEGIN
  IF NEW.state NOT IN ('checking','archived') THEN RETURN NEW; END IF;
  -- The real archive gateway already holds this lock before capturing its
  -- snapshot. Use the same order; do not lock a delta head after it.
  PERFORM 1 FROM public.sentlog_projects WHERE id=NEW.project_id FOR UPDATE NOWAIT;
  IF EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id=NEW.project_id AND enabled) THEN
    RAISE EXCEPTION 'DELTA_ARCHIVE_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.guard_legacy_archive_job() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_delta_legacy_archive_job_guard ON sentlog_archive_private.jobs;
CREATE TRIGGER sentlog_delta_legacy_archive_job_guard BEFORE INSERT OR UPDATE ON sentlog_archive_private.jobs
  FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.guard_legacy_archive_job();

CREATE OR REPLACE FUNCTION sentlog_delta_private.guard_legacy_archive_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
BEGIN
  IF NEW.status='archived' AND OLD.status IS DISTINCT FROM NEW.status AND
     EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id=NEW.id AND enabled) THEN
    RAISE EXCEPTION 'DELTA_ARCHIVE_PROJECTION_REQUIRED' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.guard_legacy_archive_status() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS sentlog_delta_legacy_archive_status_guard ON public.sentlog_projects;
CREATE TRIGGER sentlog_delta_legacy_archive_status_guard BEFORE UPDATE ON public.sentlog_projects
  FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.guard_legacy_archive_status();
COMMIT;

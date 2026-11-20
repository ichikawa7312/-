-- EXPERIMENTAL: install only in the isolated verification database.
-- Requires v1 schema, semantic validation, baseline preparation, and Realtime.
-- Does not activate projects or alter existing snapshots/files.
BEGIN;

-- An owner-only table SELECT cannot check which registered device is reading,
-- or whether the project was archived. All client reads now use the RPC below.
REVOKE SELECT ON public.sentlog_delta_events FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.list_events(
  p_project_id uuid,p_device_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
  u uuid; h sentlog_delta_private.heads%ROWTYPE;
  r public.sentlog_delta_events%ROWTYPE;
  rows jsonb:='[]'::jsonb; item jsonb; bytes bigint:=0; last_number bigint;
BEGIN
  -- The shared row locks live through the read: archive/device-stop races
  -- cannot authorize against an older lifecycle state midway through the RPC.
  u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
  IF p_after IS NULL OR p_after NOT BETWEEN 0 AND 9007199254740991 OR
     p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'DELTA_PAGE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO h FROM sentlog_delta_private.heads
    WHERE project_id=p_project_id AND owner_id=u FOR SHARE;
  IF NOT FOUND OR NOT h.enabled THEN
    RAISE EXCEPTION 'DELTA_NOT_ACTIVATED' USING ERRCODE='55000'; END IF;
  IF p_after>h.last_seq THEN RAISE EXCEPTION 'DELTA_CURSOR_AHEAD' USING ERRCODE='22023'; END IF;
  last_number:=p_after;
  FOR r IN SELECT * FROM public.sentlog_delta_events
    WHERE project_id=p_project_id AND owner_id=u AND seq>p_after
    ORDER BY seq LIMIT p_limit LOOP
    IF r.seq<>last_number+1 OR r.seq>h.last_seq THEN RAISE EXCEPTION 'DELTA_SEQUENCE_GAP' USING ERRCODE='55000'; END IF;
    item:=pg_catalog.jsonb_build_object('seq',r.seq,'event',r.envelope);
    IF bytes+pg_catalog.octet_length(item::text)>900000 THEN EXIT; END IF;
    rows:=rows||pg_catalog.jsonb_build_array(item);
    bytes:=bytes+pg_catalog.octet_length(item::text)+2;last_number:=r.seq;
  END LOOP;
  IF last_number=p_after AND p_after<h.last_seq THEN
    RAISE EXCEPTION 'DELTA_EVENTS_UNAVAILABLE' USING ERRCODE='55000'; END IF;
  RETURN pg_catalog.jsonb_build_object('schema',1,'ownerId',u,'projectId',p_project_id,
    'deviceId',p_device_id,'after',p_after,'headSeq',h.last_seq,'events',rows,
    'hasMore',last_number<h.last_seq);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.list_events(uuid,uuid,bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.list_events(uuid,uuid,bigint,integer) TO authenticated;
CREATE OR REPLACE FUNCTION public.sentlog_delta_list_v1(
  p_project_id uuid,p_device_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.list_events($1,$2,$3,$4) $fn$;
REVOKE ALL ON FUNCTION public.sentlog_delta_list_v1(uuid,uuid,bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_delta_list_v1(uuid,uuid,bigint,integer) TO authenticated;

-- Only a wake-up hint (project_id and committed seq) travels on this topic.
-- The data RPC above still rechecks active project and registered device.
-- Keep existing records/asset channel policies intact. A restrictive policy
-- prevents an unrelated broad permissive policy from opening delta topics.
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sentlog_delta_receive_own ON realtime.messages;
CREATE POLICY sentlog_delta_receive_own ON realtime.messages
  FOR SELECT TO authenticated USING (
    (SELECT realtime.topic())='sentlog-delta:'||(SELECT auth.uid())::text
    AND extension='broadcast'
  );
DROP POLICY IF EXISTS sentlog_delta_topic_guard ON realtime.messages;
CREATE POLICY sentlog_delta_topic_guard ON realtime.messages AS RESTRICTIVE
  FOR SELECT TO public USING (
    coalesce((SELECT realtime.topic()),'') NOT LIKE 'sentlog-delta:%'
    OR ((SELECT realtime.topic())='sentlog-delta:'||(SELECT auth.uid())::text AND extension='broadcast')
  );
-- Clients never publish delta notifications. An existing broad INSERT policy
-- must not let a client impersonate the database trigger on this namespace.
DROP POLICY IF EXISTS sentlog_delta_no_client_send ON realtime.messages;
CREATE POLICY sentlog_delta_no_client_send ON realtime.messages AS RESTRICTIVE
  FOR INSERT TO public WITH CHECK (
    coalesce((SELECT realtime.topic()),'') NOT LIKE 'sentlog-delta:%'
  );

COMMIT;

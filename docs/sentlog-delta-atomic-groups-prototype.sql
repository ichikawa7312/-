-- Atomic multi-record delta operations. Requires schema, semantic, baseline
-- and transport supplements. This migration does not activate any project.
BEGIN;

-- The group-safe RPC is the only client read path. In particular a table
-- reader with limit=1 must not expose a single member of an atomic move.
REVOKE SELECT ON public.sentlog_delta_events FROM PUBLIC,anon,authenticated;

CREATE TABLE IF NOT EXISTS sentlog_delta_private.event_groups (
  project_id uuid NOT NULL REFERENCES public.sentlog_projects(id),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  device_id uuid NOT NULL REFERENCES public.sentlog_devices(id),
  group_id text NOT NULL CHECK (length(group_id) BETWEEN 1 AND 512),
  start_seq bigint NOT NULL CHECK (start_seq BETWEEN 1 AND 9007199254740991),
  end_seq bigint NOT NULL CHECK (end_seq BETWEEN start_seq AND 9007199254740991),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,group_id),
  UNIQUE(owner_id,group_id),
  UNIQUE(project_id,start_seq),
  UNIQUE(project_id,end_seq),
  CHECK (end_seq-start_seq+1 BETWEEN 1 AND 500),
  CHECK (octet_length(envelope::text)<=4194304)
);
ALTER TABLE sentlog_delta_private.event_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sentlog_delta_private.event_groups FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.group_ack(g sentlog_delta_private.event_groups,duplicate boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $fn$
  SELECT pg_catalog.jsonb_build_object('schema',1,'groupId',g.group_id,'projectId',g.project_id,
    'deviceId',g.device_id,'startSeq',g.start_seq,'endSeq',g.end_seq,'duplicate',duplicate,
    'events',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('seq',g.start_seq+e.ordinality-1,
      'projectId',g.project_id,'eventId',e.value->>'eventId','deviceId',g.device_id,
      'drawingId',e.value->>'drawingId','recordId',e.value->>'recordId') ORDER BY e.ordinality)
      FROM pg_catalog.jsonb_array_elements(g.envelope->'events') WITH ORDINALITY e))
$fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.group_ack(sentlog_delta_private.event_groups,boolean) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.append_group(p_project_id uuid,p_device_id uuid,p_group jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
  u uuid; h sentlog_delta_private.heads%ROWTYPE; previous sentlog_delta_private.event_groups%ROWTYPE;
  saved sentlog_delta_private.event_groups%ROWTYPE; e jsonb; result jsonb; n integer; ids text[]:=ARRAY[]::text[];
BEGIN
  u:=sentlog_delta_private.baseline_authorize(p_project_id,p_device_id);
  IF p_group IS NULL OR pg_catalog.jsonb_typeof(p_group) IS DISTINCT FROM 'object' OR
     p_group->'schema' IS DISTINCT FROM '1'::jsonb OR p_group->>'kind' IS DISTINCT FROM 'atomic-group' OR
     NOT sentlog_delta_private.valid_id(p_group->'groupId') OR
     p_group->>'projectId' IS DISTINCT FROM p_project_id::text OR p_group->>'deviceId' IS DISTINCT FROM p_device_id::text OR
     pg_catalog.jsonb_typeof(p_group->'events') IS DISTINCT FROM 'array' OR
     p_group-ARRAY['schema','kind','groupId','projectId','deviceId','events']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'DELTA_GROUP_INVALID' USING ERRCODE='22023'; END IF;
  n:=pg_catalog.jsonb_array_length(p_group->'events');
  IF n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'DELTA_GROUP_INVALID' USING ERRCODE='22023'; END IF;
  IF pg_catalog.octet_length(p_group::text)>4194304 THEN RAISE EXCEPTION 'DELTA_GROUP_TOO_LARGE' USING ERRCODE='54000'; END IF;
  -- Validate every envelope before allocating a sequence. Per-record semantic
  -- validation below still runs against the evolving transaction-local state.
  FOR e IN SELECT value FROM pg_catalog.jsonb_array_elements(p_group->'events') LOOP
    PERFORM sentlog_delta_private.validate_payload(e);
    IF e->>'projectId' IS DISTINCT FROM p_project_id::text OR e->>'deviceId' IS DISTINCT FROM p_device_id::text THEN
      RAISE EXCEPTION 'DELTA_GROUP_SCOPE' USING ERRCODE='22023'; END IF;
    IF e->>'eventId'=ANY(ids) THEN RAISE EXCEPTION 'DELTA_GROUP_EVENT_DUPLICATE' USING ERRCODE='22023'; END IF;
    ids:=pg_catalog.array_append(ids,e->>'eventId');
  END LOOP;
  SELECT * INTO h FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND owner_id=u FOR UPDATE;
  IF NOT FOUND OR NOT h.enabled THEN RAISE EXCEPTION 'DELTA_NOT_ACTIVATED' USING ERRCODE='55000'; END IF;
  SELECT * INTO previous FROM sentlog_delta_private.event_groups WHERE owner_id=u AND group_id=p_group->>'groupId';
  IF FOUND THEN
    IF previous.project_id IS DISTINCT FROM p_project_id OR previous.device_id IS DISTINCT FROM p_device_id OR
       previous.envelope IS DISTINCT FROM p_group THEN
      RAISE EXCEPTION 'DELTA_GROUP_ID_COLLISION' USING ERRCODE='23505'; END IF;
    RETURN sentlog_delta_private.group_ack(previous,true);
  END IF;
  -- A previously accepted solo event cannot be retroactively made atomic with
  -- a new event. Refuse the whole group, including identical old events.
  IF EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE owner_id=u AND event_id=ANY(ids)) THEN
    RAISE EXCEPTION 'DELTA_GROUP_EVENT_ALREADY_ACCEPTED' USING ERRCODE='23505'; END IF;
  IF h.last_seq>9007199254740991-n THEN RAISE EXCEPTION 'DELTA_SEQUENCE_LIMIT' USING ERRCODE='22003'; END IF;
  FOR e IN SELECT value FROM pg_catalog.jsonb_array_elements(p_group->'events') LOOP
    result:=sentlog_delta_private.append(p_project_id,p_device_id,e->>'eventId',e->>'drawingId',e->>'recordId',e);
    IF result->'duplicate' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'DELTA_GROUP_EVENT_ALREADY_ACCEPTED' USING ERRCODE='23505'; END IF;
  END LOOP;
  INSERT INTO sentlog_delta_private.event_groups(project_id,owner_id,device_id,group_id,start_seq,end_seq,envelope)
    VALUES(p_project_id,u,p_device_id,p_group->>'groupId',h.last_seq+1,h.last_seq+n,p_group) RETURNING * INTO saved;
  RETURN sentlog_delta_private.group_ack(saved,false);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.append_group(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.append_group(uuid,uuid,jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.sentlog_delta_append_group_v1(p_project_id uuid,p_device_id uuid,p_group jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.append_group($1,$2,$3) $fn$;
REVOKE ALL ON FUNCTION public.sentlog_delta_append_group_v1(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_delta_append_group_v1(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.list_groups(
  p_project_id uuid,p_device_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
  u uuid; h sentlog_delta_private.heads%ROWTYPE; g sentlog_delta_private.event_groups%ROWTYPE;
  e public.sentlog_delta_events%ROWTYPE; actual jsonb;
  rows jsonb:='[]'::jsonb; item jsonb; bytes bigint:=0; last_number bigint; item_end bigint; units integer:=0;
BEGIN
  u:=sentlog_delta_private.read_authorize(p_project_id,p_device_id);
  IF p_after IS NULL OR p_after NOT BETWEEN 0 AND 9007199254740991 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'DELTA_PAGE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO h FROM sentlog_delta_private.heads WHERE project_id=p_project_id AND owner_id=u FOR SHARE;
  IF NOT FOUND OR NOT h.enabled THEN RAISE EXCEPTION 'DELTA_NOT_ACTIVATED' USING ERRCODE='55000'; END IF;
  IF p_after>h.last_seq THEN RAISE EXCEPTION 'DELTA_CURSOR_AHEAD' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM sentlog_delta_private.event_groups WHERE project_id=p_project_id AND start_seq<=p_after AND end_seq>p_after) THEN
    RAISE EXCEPTION 'DELTA_GROUP_CURSOR_INSIDE' USING ERRCODE='22023'; END IF;
  last_number:=p_after;
  WHILE last_number<h.last_seq AND units<p_limit LOOP
    SELECT * INTO g FROM sentlog_delta_private.event_groups WHERE project_id=p_project_id AND start_seq=last_number+1;
    IF FOUND THEN
      IF g.owner_id IS DISTINCT FROM u OR g.end_seq>h.last_seq OR
         pg_catalog.jsonb_array_length(g.envelope->'events')<>g.end_seq-g.start_seq+1 THEN
        RAISE EXCEPTION 'DELTA_GROUP_CORRUPT' USING ERRCODE='55000'; END IF;
      SELECT pg_catalog.jsonb_agg(envelope ORDER BY seq) INTO actual FROM public.sentlog_delta_events
        WHERE project_id=p_project_id AND owner_id=u AND seq BETWEEN g.start_seq AND g.end_seq;
      IF actual IS DISTINCT FROM g.envelope->'events' THEN RAISE EXCEPTION 'DELTA_GROUP_CORRUPT' USING ERRCODE='55000'; END IF;
      item:=pg_catalog.jsonb_build_object('seq',g.start_seq,'endSeq',g.end_seq,'group',g.envelope);item_end:=g.end_seq;
    ELSE
      SELECT * INTO e FROM public.sentlog_delta_events WHERE project_id=p_project_id AND owner_id=u AND seq=last_number+1;
      IF NOT FOUND THEN RAISE EXCEPTION 'DELTA_SEQUENCE_GAP' USING ERRCODE='55000'; END IF;
      item:=pg_catalog.jsonb_build_object('seq',e.seq,'event',e.envelope);item_end:=e.seq;
    END IF;
    -- limit counts complete units. One large first group may exceed the usual
    -- 900 KB target, but is returned intact (bounded by its 4 MiB admission).
    IF units>0 AND bytes+pg_catalog.octet_length(item::text)>900000 THEN EXIT; END IF;
    rows:=rows||pg_catalog.jsonb_build_array(item);bytes:=bytes+pg_catalog.octet_length(item::text)+2;
    last_number:=item_end;units:=units+1;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('schema',2,'ownerId',u,'projectId',p_project_id,'deviceId',p_device_id,
    'after',p_after,'headSeq',h.last_seq,'events',rows,'hasMore',last_number<h.last_seq);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.list_groups(uuid,uuid,bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.list_groups(uuid,uuid,bigint,integer) TO authenticated;
CREATE OR REPLACE FUNCTION public.sentlog_delta_list_groups_v1(
  p_project_id uuid,p_device_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.list_groups($1,$2,$3,$4) $fn$;
REVOKE ALL ON FUNCTION public.sentlog_delta_list_groups_v1(uuid,uuid,bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_delta_list_groups_v1(uuid,uuid,bigint,integer) TO authenticated;

CREATE OR REPLACE FUNCTION sentlog_delta_private.capabilities(p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE u uuid;
BEGIN
  u:=sentlog_delta_private.read_authorize(p_project_id,p_device_id);
  RETURN pg_catalog.jsonb_build_object('schema',2,'ownerId',u,'projectId',p_project_id,'deviceId',p_device_id,
    'atomicGroups',true,'groupMaxEvents',500,'groupMaxBytes',4194304,'pageTargetBytes',900000);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.capabilities(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.capabilities(uuid,uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.sentlog_delta_capabilities_v1(p_project_id uuid,p_device_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT sentlog_delta_private.capabilities($1,$2) $fn$;
REVOKE ALL ON FUNCTION public.sentlog_delta_capabilities_v1(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sentlog_delta_capabilities_v1(uuid,uuid) TO authenticated;

-- Legacy receivers may continue reading old solo history. Once an unread
-- group exists, a flattened response would permit partial visibility, so the
-- old RPC explicitly requires an upgrade instead of returning either half.
CREATE OR REPLACE FUNCTION sentlog_delta_private.list_events(
  p_project_id uuid,p_device_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE response jsonb;
BEGIN
  response:=sentlog_delta_private.list_groups(p_project_id,p_device_id,p_after,p_limit);
  IF EXISTS(SELECT 1 FROM sentlog_delta_private.event_groups WHERE project_id=p_project_id AND end_seq>p_after) THEN
    RAISE EXCEPTION 'DELTA_UPGRADE_REQUIRED' USING ERRCODE='55000'; END IF;
  RETURN pg_catalog.jsonb_set(response,'{schema}','1'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.list_events(uuid,uuid,bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION sentlog_delta_private.list_events(uuid,uuid,bigint,integer) TO authenticated;

COMMIT;

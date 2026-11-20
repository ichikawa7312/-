-- Isolated prototype supplement: do NOT apply to a production project.
-- Load AFTER sentlog-delta-v1-schema-prototype.sql and BEFORE enabling any
-- project. A missing supplement causes the append RPC to FAIL CLOSED.
-- Existing records require a verified, complete baseline before activation.
BEGIN;

CREATE TABLE IF NOT EXISTS sentlog_delta_private.record_states (
  project_id uuid NOT NULL REFERENCES public.sentlog_projects(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  drawing_id text NOT NULL CHECK (length(drawing_id) BETWEEN 1 AND 512),
  record_id text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 512),
  collab jsonb NOT NULL CHECK (jsonb_typeof(collab)='object'),
  last_seq bigint NOT NULL CHECK (last_seq BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(project_id,drawing_id,record_id)
);
REVOKE ALL ON sentlog_delta_private.record_states FROM PUBLIC, anon, authenticated;

-- Check the WHOLE accepted revision graph after applying an event to the
-- server-owned record state. Structural validation alone is insufficient:
-- a syntactically valid patch can point at a missing record or missing parent.
CREATE OR REPLACE FUNCTION sentlog_delta_private.validate_record_graph(c jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE
  grp text; bucket jsonb; ent record; item jsonb; rows jsonb;
  local_ids text[]; global_ids text[]:=ARRAY[]::text[];
  parent jsonb; loop_found boolean;
BEGIN
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'version' IS DISTINCT FROM '1'::jsonb OR
     jsonb_typeof(c->'comments') IS DISTINCT FROM 'object' OR
     jsonb_typeof(c->'fields') IS DISTINCT FROM 'object' OR
     jsonb_typeof(c->'photos') IS DISTINCT FROM 'object' OR
     jsonb_typeof(c#>'{deletion,revisions}') IS DISTINCT FROM 'array' OR
     jsonb_array_length(c#>'{deletion,revisions}')=0 THEN
    RAISE EXCEPTION 'DELTA_RECORD_GRAPH_INVALID' USING ERRCODE='22023';
  END IF;
  FOREACH grp IN ARRAY ARRAY['comments','fields','photos','deletion'] LOOP
    IF grp='deletion' THEN bucket:=pg_catalog.jsonb_build_object('record',c->'deletion');
    ELSE bucket:=c->grp; END IF;
    FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(bucket) LOOP
      rows:=ent.value->'revisions';
      IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(rows)=0 THEN
        RAISE EXCEPTION 'DELTA_RECORD_HISTORY_MISSING: %/%',grp,ent.key USING ERRCODE='22023';
      END IF;
      IF grp='comments' AND NOT sentlog_delta_private.safe_unsigned(ent.value->'order') THEN
        RAISE EXCEPTION 'DELTA_COMMENT_ORDER_INVALID' USING ERRCODE='22023';
      END IF;
      SELECT pg_catalog.array_agg(item->>'id') INTO local_ids
        FROM pg_catalog.jsonb_array_elements(rows) AS r(item);
      FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(rows) LOOP
        IF NOT sentlog_delta_private.valid_id(item->'id') OR
           item->>'id'=ANY(global_ids) OR
           jsonb_typeof(item->'parents') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'DELTA_REVISION_COLLISION_OR_INVALID' USING ERRCODE='22023';
        END IF;
        global_ids:=pg_catalog.array_append(global_ids,item->>'id');
        IF EXISTS(
          SELECT 1 FROM pg_catalog.jsonb_array_elements(item->'parents') AS p(v)
            WHERE NOT sentlog_delta_private.valid_id(p.v) OR
                  NOT (p.v#>>'{}'=ANY(local_ids))
        ) THEN
          RAISE EXCEPTION 'DELTA_UNKNOWN_PARENT: %/%',grp,ent.key USING ERRCODE='22023';
        END IF;
        IF grp='deletion' AND EXISTS(
          SELECT 1 FROM pg_catalog.jsonb_array_elements(item->'observed') AS o(v)
            WHERE NOT sentlog_delta_private.valid_id(o.v)
        ) THEN RAISE EXCEPTION 'DELTA_UNKNOWN_OBSERVED' USING ERRCODE='22023'; END IF;
      END LOOP;
      IF pg_catalog.cardinality(local_ids)<>pg_catalog.cardinality(ARRAY(
           SELECT DISTINCT unnest(local_ids))) THEN
        RAISE EXCEPTION 'DELTA_DUPLICATE_REVISION_ID' USING ERRCODE='22023';
      END IF;
      -- Every parent belongs to the same entry. Detect multi-node cycles,
      -- including a cycle created across multiple simultaneous revisions.
      WITH RECURSIVE edges(child,parent) AS (
        SELECT r.item->>'id', p.v#>>'{}'
        FROM pg_catalog.jsonb_array_elements(rows) AS r(item)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(r.item->'parents') AS p(v)
      ), walk(start_id,current_id,visited,cyclic) AS (
        SELECT child,parent,ARRAY[child,parent],child=parent FROM edges
        UNION ALL
        SELECT w.start_id,e.parent,w.visited||e.parent,e.parent=ANY(w.visited)
        FROM walk w JOIN edges e ON e.child=w.current_id WHERE NOT w.cyclic
      )
      SELECT EXISTS(SELECT 1 FROM walk WHERE cyclic) INTO loop_found;
      IF loop_found THEN RAISE EXCEPTION 'DELTA_HISTORY_CYCLE: %/%',grp,ent.key USING ERRCODE='22023'; END IF;
    END LOOP;
  END LOOP;
  -- A deletion decision may only refer to revisions actually known to the
  -- accepting server. Unknown IDs would otherwise produce wrong deletion
  -- semantics even though every JSON field is well-formed.
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(c#>'{deletion,revisions}') LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(item->'observed') AS o(v)
      WHERE NOT (o.v#>>'{}'=ANY(global_ids))) THEN
      RAISE EXCEPTION 'DELTA_UNKNOWN_OBSERVED' USING ERRCODE='22023';
    END IF;
  END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.validate_record_graph(jsonb)
  FROM PUBLIC,anon,authenticated;

-- Append revisions only. No existing revision, comment order, photo ID, or
-- deletion history can be overwritten by an incoming delta.
CREATE OR REPLACE FUNCTION sentlog_delta_private.merge_record_history(current_state jsonb, event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE
  out_state jsonb:=current_state; grp text; ent record;
  old_entry jsonb; incoming jsonb; rows jsonb; revision jsonb; known jsonb;
  new_entry jsonb;
BEGIN
  IF event->>'kind'='create' THEN
    IF current_state IS NOT NULL THEN
      RAISE EXCEPTION 'DELTA_RECORD_ALREADY_EXISTS' USING ERRCODE='22023';
    END IF;
    out_state:=event#>'{record,collab}';
  ELSE
    IF current_state IS NULL THEN
      RAISE EXCEPTION 'DELTA_MISSING_BASE' USING ERRCODE='22023';
    END IF;
    FOREACH grp IN ARRAY ARRAY['comments','fields','photos'] LOOP
      FOR ent IN SELECT key,value FROM pg_catalog.jsonb_each(event->'patch'->grp) LOOP
        old_entry:=out_state->grp->ent.key;incoming:=ent.value;
        IF old_entry IS NOT NULL AND grp='comments' AND
          old_entry->'order' IS DISTINCT FROM incoming->'order' THEN
          RAISE EXCEPTION 'DELTA_COMMENT_ORDER_CHANGED' USING ERRCODE='22023';
        END IF;
        rows:=CASE WHEN old_entry IS NULL THEN '[]'::jsonb ELSE old_entry->'revisions' END;
        FOR revision IN SELECT value FROM pg_catalog.jsonb_array_elements(incoming->'revisions') LOOP
          SELECT r.value INTO known FROM pg_catalog.jsonb_array_elements(rows) AS r(value)
            WHERE r.value->>'id'=revision->>'id';
          IF known IS NOT NULL THEN
            IF known IS DISTINCT FROM revision THEN
              RAISE EXCEPTION 'DELTA_REVISION_REWRITE' USING ERRCODE='22023';
            END IF;
          ELSE rows:=rows||pg_catalog.jsonb_build_array(revision); END IF;
          known:=NULL;
        END LOOP;
        new_entry:=pg_catalog.jsonb_build_object('revisions',rows);
        IF grp='comments' THEN
          new_entry:=new_entry||pg_catalog.jsonb_build_object(
            'order', CASE WHEN old_entry IS NULL THEN incoming->'order' ELSE old_entry->'order' END);
        END IF;
        out_state:=pg_catalog.jsonb_set(out_state,ARRAY[grp,ent.key],new_entry,true);
      END LOOP;
    END LOOP;
    rows:=out_state#>'{deletion,revisions}';
    FOR revision IN SELECT value FROM pg_catalog.jsonb_array_elements(event#>'{patch,deletion}') LOOP
      SELECT r.value INTO known FROM pg_catalog.jsonb_array_elements(rows) AS r(value)
        WHERE r.value->>'id'=revision->>'id';
      IF known IS NOT NULL THEN
        IF known IS DISTINCT FROM revision THEN
          RAISE EXCEPTION 'DELTA_DELETION_REWRITE' USING ERRCODE='22023';
        END IF;
      ELSE rows:=rows||pg_catalog.jsonb_build_array(revision); END IF;
      known:=NULL;
    END LOOP;
    out_state:=pg_catalog.jsonb_set(out_state,'{deletion,revisions}',rows,true);
  END IF;
  PERFORM sentlog_delta_private.validate_record_graph(out_state);
  RETURN out_state;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.merge_record_history(jsonb,jsonb)
  FROM PUBLIC,anon,authenticated;

-- Called while append() holds the per-project row lock, and BEFORE the event
-- INSERT. If validation fails, neither the head seq nor record state advances.
-- The entire event INSERT/broadcast remains in the same PostgreSQL transaction.
CREATE OR REPLACE FUNCTION sentlog_delta_private.accept_record_event(
  p_project uuid, p_owner uuid, p_drawing text, p_record text, e jsonb, p_seq bigint
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE previous sentlog_delta_private.record_states%ROWTYPE; resulting jsonb;
BEGIN
  SELECT * INTO previous FROM sentlog_delta_private.record_states
    WHERE project_id=p_project AND owner_id=p_owner
      AND drawing_id=p_drawing AND record_id=p_record FOR UPDATE;
  resulting:=sentlog_delta_private.merge_record_history(
    CASE WHEN FOUND THEN previous.collab ELSE NULL END,e);
  IF FOUND THEN
    UPDATE sentlog_delta_private.record_states SET collab=resulting,last_seq=p_seq
      WHERE project_id=p_project AND drawing_id=p_drawing AND record_id=p_record;
  ELSE
    INSERT INTO sentlog_delta_private.record_states
      (project_id,owner_id,drawing_id,record_id,collab,last_seq)
    VALUES(p_project,p_owner,p_drawing,p_record,resulting,p_seq);
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION sentlog_delta_private.accept_record_event(uuid,uuid,text,text,jsonb,bigint)
  FROM PUBLIC,anon,authenticated;

COMMIT;
